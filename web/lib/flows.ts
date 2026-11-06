import {
  encodeAbiParameters,
  getAbiItem,
  encodeFunctionData,
  formatUnits,
  isAddress,
  keccak256,
  parseEventLogs,
  parseUnits,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { normalize } from "viem/ens";
import {
  getEnsAddress,
  readContract,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { mainnet } from "wagmi/chains";

import { sources } from "./chains";
import { config, type ChainId } from "./config";
import { arc, erc20Abi, memoAbi, routerAbi } from "./contracts";
import { assets, type AssetId, type Plan } from "./plan";
import { tokenBySymbol } from "./tokens";
import { MAX_ROUNDS, ROUND_SHARE } from "./loop";
import { fullRange, mintPosition } from "./positions";
import { rangeTicks } from "./quote";

export const Action = { Pay: 0, Deposit: 1, Earn: 2, Provide: 3 } as const;

const FAST = 1000;
const STANDARD = 2000;

export async function resolveRecipient(input: string): Promise<Address> {
  const value = input.trim();
  if (isAddress(value)) return value;
  if (value.includes(".")) {
    const address = await getEnsAddress(config, { name: normalize(value), chainId: mainnet.id });
    if (address) return address;
  }
  throw new Error(`Could not find ${value || "a recipient"}`);
}

export type CctpFees = { fast: number; standard: number };

/// CCTP fee from a source chain to Arc in basis points, via our API route.
export async function cctpFees(domain: number): Promise<CctpFees> {
  const response = await fetch(`/api/fee?from=${domain}`);
  if (!response.ok) throw new Error("Could not load the CCTP fee");
  return response.json();
}

export type Context = {
  plan: Plan;
  account: Address;
  /// Payee for "pay", or where the result goes otherwise.
  recipient: Address;
  minOut?: bigint;
  /// Current tick of the USDC/EURC pool, for LP ranges.
  poolTick?: number;
  /// EURC per USDC on the pool, for price limits.
  rate?: number;
  invoiceId?: Hex;
  replyTo?: Address;
  /// USDC/EURC pool state on Arc, for wallet-side liquidity.
  pool?: { tick: number; sqrtPrice: number };
};

const none = { limit: 0n, data: "0x" as Hex };
const units = (value: number) => BigInt(Math.floor(value * 1e6));

/// What the settlement contract on Arc does once the USDC is there, with the price bounds it enforces.
export function settlementAction({ plan, recipient, minOut = 0n, poolTick = 0, rate }: Context) {
  const keep = 1 - Number(plan.slippage) / 100;
  switch (plan.next) {
    case "pay": {
      const amount = Number(plan.payAmount);
      if (plan.payToken !== "EURC") {
        return { ...none, action: Action.Pay, recipient, token: arc.usdc, amount: units(amount) };
      }
      if (!rate) throw new Error("Pool price is not loaded yet");
      // The most USDC the exact EURC payment may cost.
      return { ...none, action: Action.Pay, recipient, token: arc.eurc, amount: units(amount), limit: units(amount / rate / keep) + 1n };
    }
    case "hold":
      // USDC lands as it is; EURC is bought on the Uniswap pool with a minimum out.
      return plan.hold === "EURC"
        ? { ...none, action: Action.Deposit, recipient, token: arc.eurc, amount: minOut }
        : { ...none, action: Action.Deposit, recipient, token: arc.usdc, amount: 0n };
    case "pool": {
      if (!rate) throw new Error("Pool price is not loaded yet");
      const data =
        plan.range === "full"
          ? ("0x" as Hex)
          : encodeAbiParameters([{ type: "int24" }, { type: "int24" }], rangeTicks(poolTick, Number(plan.range)));
      // The least EURC the half that is swapped must return.
      return { action: Action.Provide, recipient, token: arc.eurc, amount: 1n, limit: units((Number(plan.amount) / 2) * rate * keep), data };
    }
    case "lend":
      return { ...none, action: Action.Earn, recipient, token: (plan.vault || arc.morphoVault) as Address, amount: 0n };
    default:
      return { ...none, action: Action.Deposit, recipient, token: arc.usdc, amount: 0n };
  }
}

export function buildIntent(context: Context) {
  // A fast transfer lands in about a minute, a standard one in about 20; past this the order refunds.
  const window = context.plan.speed === "fast" ? 3600 : 3 * 3600;
  return {
    id: zeroHash,
    payer: zeroAddress,
    ...settlementAction(context),
    deadline: BigInt(Math.floor(Date.now() / 1000) + window),
    refundTo: zeroAddress,
    invoiceId: context.invoiceId ?? zeroHash,
    replyTo: context.replyTo ?? zeroAddress,
  } as const;
}

type IntentValue = ReturnType<typeof buildIntent>;

/// Orders on Arc are keyed by the hash of the whole intent, as the router fills it in.
export function orderKey(intent: IntentValue, id: Hex, payer: Address): Hex {
  const send = getAbiItem({ abi: routerAbi, name: "send" });
  return keccak256(encodeAbiParameters([send.inputs[0]], [{ ...intent, id, payer }]));
}

export type RouterResult = { key: Hex; txHash: Hex; sourceChainId: number; explorer: string };

/// USDC from a chain with a CCIP lane: CCTP carries the money, CCIP carries the instruction.
export async function sendThroughRouter(context: Context, onStep: (label: string) => void): Promise<RouterResult> {
  const source = sources[context.plan.from];
  const router = source.router;
  if (!router?.address) throw new Error(`andthen is not deployed on ${source.label} yet`);

  const chainId = source.chain.id as ChainId;
  const amount = parseUnits(context.plan.amount, 6);
  const fast = context.plan.speed === "fast";
  const intent = buildIntent(context);

  onStep(`Switching to ${source.label}`);
  await switchChain(config, { chainId });

  const fees = await cctpFees(source.cctpDomain);
  const bps = fast ? fees.fast : fees.standard;
  const maxFee = (amount * BigInt(Math.ceil(bps * 100))) / 1_000_000n + (bps > 0 ? 1n : 0n);

  const allowance = await readContract(config, {
    chainId,
    address: router.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [context.account, router.address],
  });
  if (allowance < amount) {
    onStep("Approve USDC");
    const hash = await writeContract(config, {
      chainId,
      address: router.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [router.address, amount],
    });
    await waitForTransactionReceipt(config, { chainId, hash });
  }

  const ccipFee = await readContract(config, {
    chainId,
    address: router.address,
    abi: routerAbi,
    functionName: "quote",
    args: [intent],
  });

  onStep("Confirm in your wallet");
  const txHash = await writeContract(config, {
    chainId,
    address: router.address,
    abi: routerAbi,
    functionName: "send",
    args: [intent, amount, maxFee, fast ? FAST : STANDARD],
    value: (ccipFee * 12n) / 10n,
  });

  onStep(`Waiting for ${source.label}`);
  const receipt = await waitForTransactionReceipt(config, { chainId, hash: txHash });
  const [sent] = parseEventLogs({ abi: routerAbi, eventName: "Sent", logs: receipt.logs });
  return { key: orderKey(intent, sent.args.id, context.account), txHash, sourceChainId: chainId, explorer: source.explorer };
}

const arcToken = (asset: AssetId): Address => {
  const address = tokenBySymbol[asset]?.arc;
  if (!address) throw new Error(`${asset} does not bridge to Arc`);
  return address;
};
/// Circle's kits name wrapped ether wETH; every other asset goes by its symbol.
const kitToken = (asset: AssetId) => (asset === "WETH" || asset === "ETH" ? "wETH" : asset);

type Step = { name: string; explorerUrl?: string };
export type WalletResult = { steps: Step[] };

type Kit = InstanceType<typeof import("@circle-fin/app-kit").AppKit>;
type Adapter = Awaited<ReturnType<typeof import("@circle-fin/adapter-viem-v2").createViemAdapterFromProvider>>;

async function arcBalance(token: Address, account: Address) {
  return readContract(config, { chainId: arc.chainId, address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

const tx = (hash?: string) => (hash ? `${arc.explorer}/tx/${hash}` : undefined);

/// Bridges with Bridge Kit, then finishes on Arc from the user's wallet. Whatever arrived is converted
/// into what the action needs with Circle Swap; liquidity goes into the Uniswap pool from the wallet.
export async function sendThroughWallet(context: Context, onStep: (label: string) => void): Promise<WalletResult> {
  const { plan, account, recipient } = context;
  const provider = (window as { ethereum?: unknown }).ethereum;
  if (!provider) throw new Error("No browser wallet found");

  const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all([
    import("@circle-fin/app-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const adapter = await createViemAdapterFromProvider({ provider: provider as never });
  const kit = new AppKit();
  const steps: Step[] = [];

  const asset = plan.asset;
  const before = await arcBalance(arcToken(asset), account);

  onStep(`Bridging ${asset} from ${sources[plan.from].label} with Bridge Kit`);
  let bridged = await kit.bridge({
    from: { adapter, chain: sources[plan.from].kitChain as never },
    to: { adapter, chain: arc.kitChain as never },
    amount: plan.amount,
    token: kitToken(asset) as never,
    config: { transferSpeed: plan.speed === "fast" ? "FAST" : "SLOW" },
  });
  if (bridged.state === "error") {
    onStep("Retrying the mint on Arc");
    bridged = await kit.retryBridge(bridged, { from: adapter, to: adapter });
  }
  if (bridged.state === "error") throw new Error("Bridge Kit could not finish the transfer");
  for (const step of bridged.steps) {
    steps.push({ name: step.name, explorerUrl: "explorerUrl" in step ? (step.explorerUrl as string) : undefined });
  }

  const arrived = (await arcBalance(arcToken(asset), account)) - before;
  await switchChain(config, { chainId: arc.chainId });

  const swap = async (from: AssetId, to: AssetId, amount: bigint): Promise<bigint> => {
    if (from === to || amount === 0n) return amount;
    onStep(`Swapping ${from} into ${to} with Circle Swap`);
    const toBefore = await arcBalance(arcToken(to), account);
    const result = await kit.swap({
      from: { adapter, chain: arc.kitChain as never },
      tokenIn: kitToken(from) as never,
      tokenOut: kitToken(to) as never,
      amountIn: formatUnits(amount, assets[from].decimals),
      config: { slippageBps: Math.round(Number(plan.slippage) * 100) },
    });
    const received = (await arcBalance(arcToken(to), account)) - toBefore;
    steps.push({ name: `Swapped ${from} into ${formatUnits(received, assets[to].decimals)} ${to}`, explorerUrl: tx(result.txHash) });
    return received;
  };

  switch (plan.next) {
    case "pay": {
      const token = plan.payToken;
      await swap(asset, token, arrived);
      onStep("Paying on Arc");
      const hash = await writeContract(config, {
        chainId: arc.chainId,
        address: arc.memo,
        abi: memoAbi,
        functionName: "memo",
        args: [
          arcToken(token),
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipient, parseUnits(plan.payAmount, assets[token].decimals)],
          }),
          context.invoiceId ?? keccak256(toHex(`${account}${Date.now()}`)),
          stringToHex("andthen"),
        ],
      });
      await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
      steps.push({ name: `Paid ${plan.recipient} ${plan.payAmount} ${token}`, explorerUrl: tx(hash) });
      break;
    }
    case "hold": {
      const held = await swap(asset, plan.hold, arrived);
      await sendOn(arcToken(plan.hold), held, account, recipient, steps);
      break;
    }
    case "lend": {
      const usdc = await swap(asset, "USDC", arrived);
      onStep("Depositing into Morpho with Circle Earn");
      const deposit = await kit.earn.deposit({
        from: { adapter, chain: arc.kitChain as never },
        vaultAddress: plan.vault || arc.morphoVault!,
        amount: formatUnits(usdc, 6),
      });
      steps.push({ name: "Lending on Morpho", explorerUrl: tx("txHash" in deposit ? String(deposit.txHash) : undefined) });
      break;
    }
    case "pool": {
      // Half of the value on each side of the USDC/EURC pool.
      const half = arrived / 2n;
      const usdc = asset === "EURC" ? await swap("EURC", "USDC", half) : await swap(asset, "USDC", asset === "USDC" ? arrived - half : half);
      const eurc = asset === "USDC" ? await swap("USDC", "EURC", half) : await swap(asset, "EURC", arrived - half);
      const pool = context.pool;
      if (!pool) throw new Error("Pool price is not loaded yet");
      const range = plan.range === "full" ? fullRange() : rangeTicks(pool.tick, Number(plan.range));
      const minted = await mintPosition(
        { account, owner: recipient, usdc, eurc, sqrtPrice: pool.sqrtPrice, range },
        onStep,
      );
      steps.push({ name: `Uniswap position #${minted.tokenId} minted`, explorerUrl: tx(minted.hash) });
      break;
    }
    case "loop": {
      const btc = await swap(asset, "cirBTC", arrived);
      steps.push(...(await loop(kit, adapter, account, plan, formatUnits(btc, 8), onStep)));
      break;
    }
  }

  return { steps };
}

/// Moves what this run produced to someone else, when the user asked for it.
async function sendOn(token: Address, amount: bigint, account: Address, recipient: Address, steps: Step[]) {
  if (recipient.toLowerCase() === account.toLowerCase() || amount === 0n) return;
  const hash = await writeContract(config, {
    chainId: arc.chainId,
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amount],
  });
  await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  steps.push({ name: "Sent on", explorerUrl: tx(hash) });
}

/// Loops on the Morpho cirBTC/USDC market through Circle Borrow: borrow USDC, buy cirBTC with Circle Swap,
/// add it to the loan, until the position reaches the target leverage.
async function loop(
  kit: Kit,
  adapter: Adapter,
  account: Address,
  plan: Plan,
  collateral: string,
  onStep: (label: string) => void,
): Promise<Step[]> {
  const slippageBps = Math.round(Number(plan.slippage) * 100);
  const from = { adapter, chain: arc.kitChain as never };
  const steps: Step[] = [];
  const quote = await kit.borrow.getMaxBorrow({ chain: arc.kitChain as never, marketId: arc.cirbtcMarket, collateralAmount: collateral });
  const lltv = 0.86;
  const collateralValue = Number(quote.maxBorrowAmount.amount) / lltv;
  let remaining = collateralValue * (Number(plan.leverage) - 1);
  let loanId: string | undefined;
  let totalCollateral = Number(collateral);
  let debt = 0;

  for (let round = 1; round <= MAX_ROUNDS && remaining > 0.01; round++) {
    const capacity = (totalCollateral / Number(collateral)) * Number(quote.maxBorrowAmount.amount) - debt;
    const borrowAmount = Math.min(remaining, capacity * ROUND_SHARE).toFixed(6);

    onStep(`Round ${round}: borrowing ${borrowAmount} USDC on Morpho`);
    const borrowed = loanId
      ? await kit.borrow.borrow({ from, loanId, borrowAmount })
      : await kit.borrow.borrow({ from, marketId: arc.cirbtcMarket, borrowAmount });
    if (borrowed.status === "submitted") throw new Error("The borrow is still pending in your wallet");
    loanId = borrowed.loanId;
    debt += Number(borrowAmount);
    remaining -= Number(borrowAmount);
    steps.push({ name: `Round ${round}: borrowed ${borrowAmount} USDC`, explorerUrl: tx(borrowed.txHash) });

    onStep(`Round ${round}: buying cirBTC`);
    const btcBefore = await arcBalance(arc.cirbtc, account);
    await kit.swap({ from, tokenIn: "USDC" as never, tokenOut: "cirBTC" as never, amountIn: borrowAmount, config: { slippageBps } });
    const btcAfter = await arcBalance(arc.cirbtc, account);
    totalCollateral += Number(formatUnits(btcAfter - btcBefore, 8));

    // The first borrow posts only the collateral it needs, so this also adds whatever is left in the wallet.
    const balance = formatUnits(btcAfter, 8);
    onStep(`Round ${round}: adding ${balance} cirBTC as collateral`);
    const added = await kit.borrow.addCollateral({ from, loanId, collateralAmount: balance });
    steps.push({ name: `Round ${round}: added ${balance} cirBTC`, explorerUrl: tx("txHash" in added ? added.txHash : undefined) });
  }

  return steps;
}
