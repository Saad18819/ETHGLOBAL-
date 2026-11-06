import { isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";
import { readContract, sendTransaction, signTypedData, switchChain, waitForTransactionReceipt } from "wagmi/actions";

import { sources, type SourceId } from "./chains";
import { config, type ChainId } from "./config";
import { erc20Abi } from "./contracts";
import { tokenBySymbol } from "./tokens";

/// Swaps on the source chain go through the Uniswap Trading API (via /api/uniswap), routed CLASSIC so the
/// output lands in the wallet in the same transaction and can be bridged right after.

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
  raw: Classic;
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

/// The best CLASSIC route from the asset into USDC on its own chain.
export async function quoteToUsdc(
  asset: string,
  from: SourceId,
  amountIn: bigint,
  slippage: number,
  swapper?: Address,
): Promise<SourceQuote> {
  const raw = await call<Classic>("quote", {
    swapper: swapper ?? QUOTE_SWAPPER,
    tokenIn: tokenAddress(asset, from),
    tokenOut: usdcOn(from),
    tokenInChainId: String(sources[from].chain.id),
    tokenOutChainId: String(sources[from].chain.id),
    amount: amountIn.toString(),
    type: "EXACT_INPUT",
    slippageTolerance: slippage,
    routingPreference: "CLASSIC",
  });
  const versions = new Set((raw.quote.route ?? []).flat().map((pool) => pool.type.replace("-pool", "")));
  return {
    amountIn,
    amountOut: BigInt(raw.quote.output.amount),
    gasUsd: raw.quote.gasFeeUSD ? Number(raw.quote.gasFeeUSD) : undefined,
    priceImpact: raw.quote.priceImpact,
    pools: [...versions].join(" and "),
    raw,
  };
}

/// Approves if needed, quotes again with the real swapper, signs the Permit2 data when asked and sends the
/// swap. Returns the USDC that reached the wallet.
export async function swapToUsdc(
  params: { account: Address; asset: string; from: SourceId; amountIn: bigint; slippage: number },
  onStatus: (status: string) => void,
): Promise<{ usdc: bigint; hash: Hex }> {
  const { account, asset, from, amountIn, slippage } = params;
  const chainId = sources[from].chain.id as ChainId;
  await switchChain(config, { chainId });

  const tokenIn = tokenAddress(asset, from);
  if (tokenIn !== zeroAddress) {
    const { approval } = await call<{ approval: { to: Address; data: Hex; value?: string } | null }>("check_approval", {
      walletAddress: account,
      token: tokenIn,
      amount: amountIn.toString(),
      chainId,
    });
    if (approval) {
      onStatus(`Approving ${asset} for Permit2`);
      const hash = await sendTransaction(config, {
        chainId,
        to: approval.to,
        data: approval.data,
        value: BigInt(approval.value ?? "0"),
      });
      await waitForTransactionReceipt(config, { chainId, hash });
    }
  }

  onStatus(`Quoting ${asset} to USDC on Uniswap`);
  const { raw } = await quoteToUsdc(asset, from, amountIn, slippage, account);
  const { permitData, permitTransaction: _, ...quote } = raw;
  const body: Record<string, unknown> = { ...quote };
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

  onStatus(`Swapping ${asset} to USDC on ${sources[from].label}`);
  const before = await usdcBalance(account, from);
  const hash = await sendTransaction(config, { chainId, to: swap.to, data: swap.data, value: BigInt(swap.value ?? "0") });
  const receipt = await waitForTransactionReceipt(config, { chainId, hash });
  if (receipt.status !== "success") throw new Error("The Uniswap swap reverted");
  return { usdc: (await usdcBalance(account, from)) - before, hash };
}

const usdcBalance = (account: Address, from: SourceId) => readContract(config, {
    chainId: sources[from].chain.id as ChainId,
    address: usdcOn(from),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });

export const feeLabel = (fee: number) => `${fee / 10_000}%`;
