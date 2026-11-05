import {
  encodeAbiParameters,
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
  invoiceId?: Hex;
  replyTo?: Address;
};

/// What the settlement contract on Arc does once the USDC is there.
export function settlementAction({ plan, recipient, minOut = 0n, poolTick = 0 }: Context) {
  switch (plan.next) {
    case "pay":
      return {
        action: Action.Pay,
        recipient,
        token: plan.payToken === "EURC" ? arc.eurc : arc.usdc,
        amount: parseUnits(plan.payAmount, 6),
        data: "0x" as Hex,
      };
    case "hold":
      return { action: Action.Deposit, recipient, token: arc.eurc, amount: minOut, data: "0x" as Hex };
    case "pool": {
      const data =
        plan.range === "full"
          ? ("0x" as Hex)
          : encodeAbiParameters([{ type: "int24" }, { type: "int24" }], rangeTicks(poolTick, Number(plan.range)));
      return { action: Action.Provide, recipient, token: arc.eurc, amount: 1n, data };
    }
    case "lend":
      return { action: Action.Earn, recipient, token: (plan.vault || arc.morphoVault) as Address, amount: 0n, data: "0x" as Hex };
    default:
      return { action: Action.Deposit, recipient, token: arc.usdc, amount: 0n, data: "0x" as Hex };
  }
}

export function buildIntent(context: Context) {
  return {
    id: zeroHash,
    payer: zeroAddress,
    ...settlementAction(context),
    invoiceId: context.invoiceId ?? zeroHash,
    replyTo: context.replyTo ?? zeroAddress,
  } as const;
}

export type RouterResult = { id: Hex; txHash: Hex; sourceChainId: number; explorer: string };

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
  return { id: sent.args.id, txHash, sourceChainId: chainId, explorer: router.explorer };
}

const arcTokens: Record<AssetId, Address> = { EURC: arc.eurc, WETH: arc.weth, cirBTC: arc.cirbtc, USDC: arc.usdc };
const kitTokens: Record<AssetId, string> = { EURC: "EURC", WETH: "wETH", cirBTC: "cirBTC", USDC: "USDC" };

type Step = { name: string; explorerUrl?: string };
export type WalletResult = { steps: Step[] };

type Kit = InstanceType<typeof import("@circle-fin/app-kit").AppKit>;
type Adapter = Awaited<ReturnType<typeof import("@circle-fin/adapter-viem-v2").createViemAdapterFromProvider>>;

async function arcBalance(token: Address, account: Address) {
  return readContract(config, { chainId: arc.chainId, address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

const tx = (hash?: string) => (hash ? `${arc.explorer}/tx/${hash}` : undefined);

/// Bridges with Bridge Kit, then finishes on Arc from the user's wallet with Circle kits.
export async function sendThroughWallet(
  context: Context & { cirbtcPrice?: number },
  onStep: (label: string) => void,
): Promise<WalletResult> {
  const { plan, account } = context;
  const provider = (window as { ethereum?: unknown }).ethereum;
  if (!provider) throw new Error("No browser wallet found");

  const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all([
    import("@circle-fin/app-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const adapter = await createViemAdapterFromProvider({ provider: provider as never });
  const kit = new AppKit();
  const steps: Step[] = [];

  const token = arcTokens[plan.asset];
  const before = await arcBalance(token, account);

  onStep(`Bridging ${plan.asset} from ${sources[plan.from].label} with Bridge Kit`);
  let bridged = await kit.bridge({
    from: { adapter, chain: sources[plan.from].kitChain as never },
    to: { adapter, chain: "Arc_Testnet" as never },
    amount: plan.amount,
    token: kitTokens[plan.asset] as never,
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

  const arrived = (await arcBalance(token, account)) - before;
  const arrivedText = formatUnits(arrived, assets[plan.asset].decimals);
  const from = { adapter, chain: "Arc_Testnet" as const };
  const slippageBps = Math.round(Number(plan.slippage) * 100);

  await switchChain(config, { chainId: arc.chainId });

  if (plan.next === "pay") {
    onStep("Paying on Arc");
    const hash = await writeContract(config, {
      chainId: arc.chainId,
      address: arc.memo,
      abi: memoAbi,
      functionName: "memo",
      args: [
        token,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [context.recipient, parseUnits(plan.payAmount, assets[plan.asset].decimals)],
        }),
        context.invoiceId ?? keccak256(toHex(`${account}${Date.now()}`)),
        stringToHex("andthen"),
      ],
    });
    await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
    steps.push({ name: `Paid ${plan.recipient}`, explorerUrl: tx(hash) });
  }

  if (plan.next === "hold") {
    onStep(`Swapping into ${plan.hold} with Circle Swap`);
    const swapped = await kit.swap({
      from,
      tokenIn: kitTokens[plan.asset] as never,
      tokenOut: plan.hold as never,
      amountIn: arrivedText,
      config: { slippageBps },
    });
    steps.push({ name: `Swapped into ${plan.hold}`, explorerUrl: tx(swapped.txHash) });
    await sendOn(plan.hold === "EURC" ? arc.eurc : arc.cirbtc, account, context.recipient, steps);
  }

  if (plan.next === "keep") await sendOn(token, account, context.recipient, steps);

  if (plan.next === "lend") {
    onStep("Depositing into Morpho with Circle Earn");
    const deposit = await kit.earn.deposit({
      from,
      vaultAddress: plan.vault || arc.morphoVault,
      amount: arrivedText,
    });
    steps.push({ name: "Lending on Morpho", explorerUrl: tx("txHash" in deposit ? String(deposit.txHash) : undefined) });
  }

  if (plan.next === "loop") {
    let collateral = arrivedText;
    if (plan.asset !== "cirBTC") {
      onStep("Buying cirBTC with Circle Swap");
      const btcBefore = await arcBalance(arc.cirbtc, account);
      const swapped = await kit.swap({
        from,
        tokenIn: kitTokens[plan.asset] as never,
        tokenOut: "cirBTC" as never,
        amountIn: arrivedText,
        config: { slippageBps },
      });
      collateral = formatUnits((await arcBalance(arc.cirbtc, account)) - btcBefore, 8);
      steps.push({ name: `Bought ${collateral} cirBTC`, explorerUrl: tx(swapped.txHash) });
    }
    steps.push(...(await loop(kit, adapter, account, plan, collateral, slippageBps, onStep)));
  }

  return { steps };
}

/// Moves what arrived to someone else when the user asked for it.
async function sendOn(token: Address, account: Address, recipient: Address, steps: Step[]) {
  if (recipient.toLowerCase() === account.toLowerCase()) return;
  const balance = await arcBalance(token, account);
  const hash = await writeContract(config, {
    chainId: arc.chainId,
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, balance],
  });
  await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  steps.push({ name: "Sent on", explorerUrl: tx(hash) });
}

const MAX_ROUNDS = 5;
/// Each round borrows at most this share of what the collateral still allows, to stay clear of liquidation.
const ROUND_SHARE = 0.8;

/// Loops on the Morpho cirBTC/USDC market through Circle Borrow: borrow USDC, buy cirBTC with Circle Swap,
/// add it to the loan, until the position reaches the target leverage.
async function loop(
  kit: Kit,
  adapter: Adapter,
  account: Address,
  plan: Plan,
  collateral: string,
  slippageBps: number,
  onStep: (label: string) => void,
): Promise<Step[]> {
  const from = { adapter, chain: "Arc_Testnet" as const };
  const steps: Step[] = [];
  const quote = await kit.borrow.getMaxBorrow({ chain: "Arc_Testnet", marketId: arc.cirbtcMarket, collateralAmount: collateral });
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
