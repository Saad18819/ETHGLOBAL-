import { isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";
import { getBalance, readContract, sendTransaction, signTypedData, switchChain, waitForTransactionReceipt } from "wagmi/actions";

import { sources, type SourceId } from "./chains";
import { config, type ChainId } from "./config";
import { erc20Abi } from "./contracts";
import { isTestnet } from "./network";
import { tokenBySymbol } from "./tokens";
import { quoteFromUsdc, quoteTestnet, swapFromUsdc, swapTestnet } from "./uniswapTestnet";

/// Swaps on the source chain go through the Uniswap Trading API (via /api/uniswap), routed CLASSIC so the
/// output lands in the wallet in the same transaction and can be bridged right after. On testnet they go
/// straight to the v4 contracts on Sepolia instead.

/// Quotes only need a plausible swapper before a wallet is connected.
const QUOTE_SWAPPER = "0x000000000000000000000000000000000000dEaD";

type Classic = {
  routing: "CLASSIC" | "WRAP" | "UNWRAP";
  quote: {
    input: { token: Address; amount: string };
    output: { token: Address; amount: string };
    gasFeeUSD?: string;
    priceImpact?: number;
    route?: { type: string; fee?: string }[][];
  };
  permitData?: { domain: Record<string, unknown>; types: Record<string, unknown>; values: Record<string, unknown> } | null;
  permitTransaction?: unknown;
};

export type SourceQuote = {
  amountIn: bigint;
  amountOut: bigint;
  gasUsd?: number;
  priceImpact?: number;
  pools: string;
  /// How far a testnet pool's price is from the market (testnet pools drift a lot).
  deviation?: number;
  raw?: Classic;
};

async function call<T>(action: "check_approval" | "quote" | "swap", body: unknown): Promise<T> {
  const response = await fetch(`/api/uniswap/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? data.errorCode ?? `Uniswap ${action} failed`);
  return data as T;
}

const tokenAddress = (asset: string, from: SourceId): Address => {
  const address = tokenBySymbol[asset]?.sources[from];
  if (!address) throw new Error(`${asset} is not on ${sources[from].label}`);
  return address === "native" ? zeroAddress : address;
};

const usdcOn = (from: SourceId) => tokenAddress("USDC", from);

const testnetTokenIn = (asset: string, from: SourceId) =>
  asset === "WETH"
    ? { address: zeroAddress, decimals: 18 }
    : { address: tokenAddress(asset, from), decimals: tokenBySymbol[asset].decimals };

/// The best CLASSIC route between two tokens on one chain, from the Trading API.
async function tradingQuote(
  chain: SourceId,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippage: number,
  swapper?: Address,
): Promise<Classic> {
  return call<Classic>("quote", {
    swapper: swapper ?? QUOTE_SWAPPER,
    tokenIn,
    tokenOut,
    tokenInChainId: String(sources[chain].chain.id),
    tokenOutChainId: String(sources[chain].chain.id),
    amount: amountIn.toString(),
    type: "EXACT_INPUT",
    slippageTolerance: slippage,
    routingPreference: "CLASSIC",
  });
}

const summary = (amountIn: bigint, raw: Classic): SourceQuote => {
  const versions = new Set((raw.quote.route ?? []).flat().map((pool) => pool.type.replace("-pool", "")));
  return {
    amountIn,
    amountOut: BigInt(raw.quote.output.amount),
    gasUsd: raw.quote.gasFeeUSD ? Number(raw.quote.gasFeeUSD) : undefined,
    priceImpact: raw.quote.priceImpact,
    pools: [...versions].join(" and "),
    raw,
  };
};

/// Approves if needed, quotes again with the real swapper, signs the Permit2 data when asked and sends the
/// swap through the Trading API. Returns the transaction hash; callers measure what arrived.
async function tradingSwap(
  { account, chain, tokenIn, tokenOut, amountIn, slippage, label }: {
    account: Address;
    chain: SourceId;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    slippage: number;
    label: string;
  },
  onStatus: (status: string) => void,
): Promise<Hex> {
  const chainId = sources[chain].chain.id as ChainId;
  if (tokenIn !== zeroAddress) {
    const { approval } = await call<{ approval: { to: Address; data: Hex; value?: string } | null }>("check_approval", {
      walletAddress: account,
      token: tokenIn,
      amount: amountIn.toString(),
      chainId,
    });
    if (approval) {
      onStatus("Approving the token for Permit2");
      const hash = await sendTransaction(config, {
        chainId,
        to: approval.to,
        data: approval.data,
        value: BigInt(approval.value ?? "0"),
      });
      await waitForTransactionReceipt(config, { chainId, hash });
    }
  }

  onStatus(`Quoting ${label} on Uniswap`);
  const raw = await tradingQuote(chain, tokenIn, tokenOut, amountIn, slippage, account);
  // permitData goes back only together with its signature; permitTransaction is never sent.
  const body: Record<string, unknown> = { ...raw };
  delete body.permitData;
  delete body.permitTransaction;
  const { permitData } = raw;
  if (permitData) {
    onStatus("Signing the Permit2 allowance");
    body.signature = await signTypedData(config, {
      account,
      domain: permitData.domain,
      types: permitData.types,
      // The typed data names one struct besides the domain: the Permit2 permit to sign.
      primaryType: Object.keys(permitData.types).find((name) => name !== "EIP712Domain"),
      message: permitData.values,
    } as Parameters<typeof signTypedData>[1]);
    body.permitData = permitData;
  }

  const { swap } = await call<{ swap: { to: Address; from: Address; data: Hex; value?: string } }>("swap", body);
  if (!swap?.data || swap.data === "0x" || !isHex(swap.data) || !isAddress(swap.to) || !isAddress(swap.from)) {
    throw new Error("Uniswap returned an empty swap, the quote may have expired");
  }

  onStatus(`Swapping ${label} on ${sources[chain].label}`);
  const hash = await sendTransaction(config, { chainId, to: swap.to, data: swap.data, value: BigInt(swap.value ?? "0") });
  const receipt = await waitForTransactionReceipt(config, { chainId, hash });
  if (receipt.status !== "success") throw new Error("The Uniswap swap reverted");
  return hash;
}

/// The best CLASSIC route from the asset into USDC on its own chain.
export async function quoteToUsdc(
  asset: string,
  from: SourceId,
  amountIn: bigint,
  slippage: number,
  swapper?: Address,
  marketPrice?: number,
): Promise<SourceQuote> {
  if (isTestnet) {
    const quote = await quoteTestnet(from, testnetTokenIn(asset, from), amountIn, marketPrice);
    if (!quote) throw new Error("no pool has a quote right now");
    return { amountIn, amountOut: quote.amountOut, pools: "v4", deviation: quote.deviation };
  }
  return summary(amountIn, await tradingQuote(from, tokenAddress(asset, from), usdcOn(from), amountIn, slippage, swapper));
}

/// Swaps the asset into USDC on its own chain. Returns the USDC that reached the wallet.
export async function swapToUsdc(
  params: { account: Address; asset: string; from: SourceId; amountIn: bigint; slippage: number },
  onStatus: (status: string) => void,
): Promise<{ usdc: bigint; hash: Hex }> {
  const { account, asset, from, amountIn, slippage } = params;
  await switchChain(config, { chainId: sources[from].chain.id as ChainId });

  if (isTestnet) {
    // WETH is unwrapped and swapped as ETH, where the pools are.
    const tokenIn = testnetTokenIn(asset, from);
    const quote = await quoteTestnet(from, tokenIn, amountIn);
    if (!quote) throw new Error("No Uniswap pool has a quote right now");
    return swapTestnet({ from, account, tokenIn, amountIn, quote, slippage: slippage / 100, fromWeth: asset === "WETH" }, onStatus);
  }

  const before = await usdcBalance(account, from);
  const hash = await tradingSwap(
    { account, chain: from, tokenIn: tokenAddress(asset, from), tokenOut: usdcOn(from), amountIn, slippage, label: `${asset} to USDC` },
    onStatus,
  );
  return { usdc: (await usdcBalance(account, from)) - before, hash };
}

/// What `usdcIn` USDC buys of the asset on a chain, for holding it there.
export async function quoteUsdcInto(
  asset: string,
  chain: SourceId,
  usdcIn: bigint,
  slippage: number,
  swapper?: Address,
): Promise<SourceQuote> {
  const token = { address: tokenAddress(asset, chain), decimals: tokenBySymbol[asset].decimals };
  if (isTestnet) {
    const quote = await quoteFromUsdc(chain, token, usdcIn);
    if (!quote) throw new Error("no pool has a quote right now");
    return { amountIn: usdcIn, amountOut: quote.amountOut, pools: "v4" };
  }
  return summary(usdcIn, await tradingQuote(chain, usdcOn(chain), token.address, usdcIn, slippage, swapper));
}

/// Swaps USDC into the asset on a chain. Returns how much of the asset arrived.
export async function swapUsdcInto(
  params: { account: Address; asset: string; chain: SourceId; usdcIn: bigint; slippage: number },
  onStatus: (status: string) => void,
): Promise<{ received: bigint; hash: Hex }> {
  const { account, asset, chain, usdcIn, slippage } = params;
  const chainId = sources[chain].chain.id as ChainId;
  await switchChain(config, { chainId });
  const token = { address: tokenAddress(asset, chain), decimals: tokenBySymbol[asset].decimals };

  if (isTestnet) {
    const quote = await quoteFromUsdc(chain, token, usdcIn);
    if (!quote) throw new Error(`No Uniswap pool for USDC to ${asset} on ${sources[chain].label} right now`);
    return swapFromUsdc({ chain, account, tokenOut: token, usdcIn, quote, slippage: slippage / 100 }, onStatus);
  }

  const balance = () =>
    token.address === zeroAddress
      ? getBalance(config, { chainId, address: account }).then((b) => b.value)
      : readContract(config, { chainId, address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const before = await balance();
  const hash = await tradingSwap(
    { account, chain, tokenIn: usdcOn(chain), tokenOut: token.address, amountIn: usdcIn, slippage, label: `USDC to ${asset}` },
    onStatus,
  );
  return { received: (await balance()) - before, hash };
}

const usdcBalance = (account: Address, from: SourceId) => readContract(config, {
    chainId: sources[from].chain.id as ChainId,
    address: usdcOn(from),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
