import {
  encodeFunctionData,
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

export const Action = { Pay: 0, Deposit: 1 } as const;

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

  const pays = plan.next === "pay";
  const intent = {
    id: zeroHash,
    payer: zeroAddress,
    action: pays ? Action.Pay : Action.Deposit,
    recipient: pays ? recipient : account,
    token: (pays ? plan.payToken === "EURC" : plan.next === "eurc") ? arc.eurc : arc.usdc,
    amount: pays ? parseUnits(plan.payAmount, 6) : minOut,
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

const arcTokens = { EURC: arc.eurc, WETH: arc.weth, cirBTC: arc.cirbtc, USDC: arc.usdc } as const;
const kitTokens = { EURC: "EURC", WETH: "wETH", cirBTC: "cirBTC", USDC: "USDC" } as const;

export type BridgeKitResult = { bridgeSteps: { name: string; explorerUrl?: string }[]; payHash?: Hex };

/// Bridges a non-USDC asset natively with Bridge Kit, then finishes on Arc from the user's wallet.
export async function sendWithBridgeKit(
  { plan, recipient, invoiceId }: { plan: Plan; recipient?: Address; invoiceId?: Hex },
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
