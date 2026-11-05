import {
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

import { config } from "./config";
import { arc, base, deployed, erc20Abi, memoAbi, routerAbi } from "./contracts";
import { assets, sources, type Plan } from "./plan";

export const Action = { Pay: 0, Deposit: 1, Earn: 2, Provide: 3 } as const;

export async function resolveRecipient(input: string): Promise<Address> {
  const value = input.trim();
  if (isAddress(value)) return value;
  if (value.includes(".")) {
    const address = await getEnsAddress(config, { name: normalize(value), chainId: mainnet.id });
    if (address) return address;
  }
  throw new Error(`Could not find ${value || "a recipient"}`);
}

/// CCTP fast transfer fee from Base to Arc, in basis points, via our API route.
async function fastFeeBps(): Promise<number> {
  const response = await fetch("/api/fee");
  if (!response.ok) throw new Error("Could not load the CCTP fee");
  return (await response.json()).bps as number;
}

export type RouterParams = {
  plan: Plan;
  account: Address;
  recipient: Address;
  minOut?: bigint;
  invoiceId?: Hex;
  replyTo?: Address;
};

export type RouterResult = { id: Hex; txHash: Hex };

export async function sendThroughRouter(
  { plan, account, recipient, minOut = 0n, invoiceId, replyTo }: RouterParams,
  onStep: (label: string) => void,
): Promise<RouterResult> {
  if (!deployed.router) throw new Error("Router address is not configured");
  const router = deployed.router;
  const amount = parseUnits(plan.amount, 6);

  const intent = {
    id: zeroHash,
    payer: zeroAddress,
    ...settlementAction(plan, account, recipient, minOut),
    invoiceId: invoiceId ?? zeroHash,
    replyTo: replyTo ?? zeroAddress,
  } as const;

  onStep("Switching to Base");
  await switchChain(config, { chainId: base.chainId });

  const bps = await fastFeeBps();
  const maxFee = (amount * BigInt(Math.ceil(bps * 100))) / 1_000_000n + 1n;

  const allowance = await readContract(config, {
    chainId: base.chainId,
    address: base.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, router],
  });
  if (allowance < amount) {
    onStep("Approve USDC");
    const hash = await writeContract(config, {
      chainId: base.chainId,
      address: base.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [router, amount],
    });
    await waitForTransactionReceipt(config, { chainId: base.chainId, hash });
  }

  const ccipFee = await readContract(config, {
    chainId: base.chainId,
    address: router,
    abi: routerAbi,
    functionName: "quote",
    args: [intent],
  });

  onStep("Confirm in your wallet");
  const txHash = await writeContract(config, {
    chainId: base.chainId,
    address: router,
    abi: routerAbi,
    functionName: "send",
    args: [intent, amount, maxFee],
    value: (ccipFee * 12n) / 10n,
  });

  onStep("Waiting for Base");
  const receipt = await waitForTransactionReceipt(config, { chainId: base.chainId, hash: txHash });
  const [sent] = parseEventLogs({ abi: routerAbi, eventName: "Sent", logs: receipt.logs });
  return { id: sent.args.id, txHash };
}

/// What the settlement contract on Arc does once the USDC is there.
function settlementAction(plan: Plan, account: Address, recipient: Address, minOut: bigint) {
  switch (plan.next) {
    case "pay":
      return {
        action: Action.Pay,
        recipient,
        token: plan.payToken === "EURC" ? arc.eurc : arc.usdc,
        amount: parseUnits(plan.payAmount, 6),
      };
    case "eurc":
      return { action: Action.Deposit, recipient: account, token: arc.eurc, amount: minOut };
    case "pool":
      return { action: Action.Provide, recipient: account, token: arc.eurc, amount: 1n };
    case "lend":
      return { action: Action.Earn, recipient: account, token: arc.morphoVault, amount: 0n };
    default:
      return { action: Action.Deposit, recipient: account, token: arc.usdc, amount: 0n };
  }
}

const arcTokens = { EURC: arc.eurc, WETH: arc.weth, cirBTC: arc.cirbtc, USDC: arc.usdc } as const;
const kitTokens = { EURC: "EURC", WETH: "wETH", cirBTC: "cirBTC", USDC: "USDC" } as const;

type Step = { name: string; explorerUrl?: string };
export type BridgeKitResult = { bridgeSteps: Step[]; loopSteps?: Step[]; payHash?: Hex };

/// Bridges a non-USDC asset natively with Bridge Kit, then finishes on Arc from the user's wallet.
export async function sendWithBridgeKit(
  { plan, account, recipient, invoiceId }: { plan: Plan; account: Address; recipient?: Address; invoiceId?: Hex },
  onStep: (label: string) => void,
): Promise<BridgeKitResult> {
  const provider = (window as { ethereum?: unknown }).ethereum;
  if (!provider) throw new Error("No browser wallet found");

  const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all([
    import("@circle-fin/app-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const adapter = await createViemAdapterFromProvider({ provider: provider as never });
  const kit = new AppKit();

  onStep(`Bridging ${plan.asset} with Bridge Kit`);
  let result = await kit.bridge({
    from: { adapter, chain: sources[plan.from].kitChain as never },
    to: { adapter, chain: "Arc_Testnet" as never },
    amount: plan.amount,
    token: kitTokens[plan.asset] as never,
  });
  if (result.state === "error") {
    onStep("Retrying the mint on Arc");
    result = await kit.retryBridge(result, { from: adapter, to: adapter });
  }
  if (result.state === "error") throw new Error("Bridge Kit could not finish the transfer");

  const bridgeSteps = result.steps.map((step) => ({
    name: step.name,
    explorerUrl: "explorerUrl" in step ? (step.explorerUrl as string | undefined) : undefined,
  }));
  if (plan.next === "loop") {
    return { bridgeSteps, loopSteps: await loop(kit, adapter, account, plan, onStep) };
  }
  if (plan.next !== "pay" || !recipient) return { bridgeSteps };

  onStep("Paying on Arc");
  await switchChain(config, { chainId: arc.chainId });
  const token = arcTokens[plan.asset];
  const amount = parseUnits(plan.payAmount, assets[plan.asset].decimals);
  const payHash = await writeContract(config, {
    chainId: arc.chainId,
    address: arc.memo,
    abi: memoAbi,
    functionName: "memo",
    args: [
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] }),
      invoiceId ?? keccak256(toHex(`${Date.now()}`)),
      stringToHex("andthen"),
    ],
  });
  await waitForTransactionReceipt(config, { chainId: arc.chainId, hash: payHash });
  return { bridgeSteps, payHash };
}

type Kit = InstanceType<typeof import("@circle-fin/app-kit").AppKit>;
type Adapter = Awaited<ReturnType<typeof import("@circle-fin/adapter-viem-v2").createViemAdapterFromProvider>>;

/// One loop on Morpho through Circle Borrow: borrow USDC against the cirBTC, buy more cirBTC on Arc,
/// and add it to the same loan. Leverage L needs a borrow worth (L - 1) times the collateral.
async function loop(
  kit: Kit,
  adapter: Adapter,
  account: Address,
  plan: Plan,
  onStep: (label: string) => void,
): Promise<Step[]> {
  const from = { adapter, chain: "Arc_Testnet" as const };
  const leverage = Number(plan.leverage);

  const { maxBorrowAmount } = await kit.borrow.getMaxBorrow({
    chain: "Arc_Testnet",
    marketId: arc.cirbtcMarket,
    collateralAmount: plan.amount,
  });
  const lltv = 0.86;
  const borrowAmount = ((Number(maxBorrowAmount.amount) * (leverage - 1)) / lltv).toFixed(6);

  onStep(`Borrowing ${borrowAmount} USDC on Morpho`);
  const borrowed = await kit.borrow.borrow({ from, marketId: arc.cirbtcMarket, borrowAmount });
  if (borrowed.status === "submitted") throw new Error("The borrow is still pending in your wallet");

  onStep("Buying cirBTC with it on Arc");
  const received = await kit.swap({ from, tokenIn: "USDC", tokenOut: "cirBTC", amountIn: borrowAmount });

  onStep("Adding it as collateral");
  const balance = await readContract(config, {
    chainId: arc.chainId,
    address: arc.cirbtc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
  const added = await kit.borrow.addCollateral({
    from,
    loanId: borrowed.loanId,
    collateralAmount: formatUnits(balance, assets.cirBTC.decimals),
  });

  const bought = received.amountOut ? formatUnits(BigInt(received.amountOut), assets.cirBTC.decimals) : undefined;
  return [
    { name: `Borrowed ${borrowAmount} USDC`, explorerUrl: `${arc.explorer}/tx/${borrowed.txHash}` },
    { name: bought ? `Bought ${bought} cirBTC` : "Bought cirBTC" },
    {
      name: `Collateral added, about ${plan.leverage}x`,
      explorerUrl: "txHash" in added ? `${arc.explorer}/tx/${added.txHash}` : undefined,
    },
  ];
}
