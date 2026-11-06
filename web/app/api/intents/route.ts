import { createPublicClient, decodeFunctionData, http, isAddress, isHex, parseEventLogs, type Chain, type Hex } from "viem";

import { sources, type SourceId } from "@/lib/chains";
import { arcChain, ARC_RPC } from "@/lib/config";
import { arc, deployed, routerAbi, settlementAbi } from "@/lib/contracts";
import { orderKey } from "@/lib/order";
import { addIntent, aggregate, readIntents, updateStatuses, type Intent } from "@/lib/intents";
import { tokenBySymbol } from "@/lib/tokens";

const purposes = new Set(["pay", "hold", "pool", "lend", "loop", "back"]);
const statuses = new Set(["done", "sent", "stuck"]);

/// The same RPCs the app reads from, where a chain's default public RPC is unreliable.
const rpcs: Partial<Record<number, string>> = {
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  80002: "https://polygon-amoy-bor-rpc.publicnode.com",
  1: "https://ethereum-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
};

const clientFor = (chain: SourceId | "arc") => {
  if (chain === "arc") return createPublicClient({ chain: arcChain, transport: http(ARC_RPC) });
  const definition = sources[chain].chain as Chain;
  return createPublicClient({ chain: definition, transport: http(rpcs[definition.id]) });
};

/// USD prices from the app's own market data.
async function prices(origin: string): Promise<Record<string, number>> {
  try {
    const response = await fetch(`${origin}/api/markets`, { next: { revalidate: 60 } });
    return ((await response.json()) as { prices?: Record<string, number> }).prices ?? {};
  } catch {
    return {};
  }
}

const OPEN = 0;
const SETTLED = 1;

/// Where a move sent through our contracts stands on Arc: the order key is rebuilt from the router call
/// in the source transaction (the same hash the order tracker uses), then read from the settlement.
async function settlementStatus(intent: Intent): Promise<Intent["status"] | undefined> {
  if (intent.chain === "arc" || !deployed.settlement) return undefined;
  const client = clientFor(intent.chain);
  const tx = await client.getTransaction({ hash: intent.tx as Hex });
  const call = decodeFunctionData({ abi: routerAbi, data: tx.input });
  if (call.functionName !== "send") return undefined;
  const receipt = await client.getTransactionReceipt({ hash: intent.tx as Hex });
  const [sent] = parseEventLogs({ abi: routerAbi, eventName: "Sent", logs: receipt.logs });
  if (!sent) return undefined;
  const key = orderKey(call.args[0], sent.args.id, tx.from);
  const order = await clientFor("arc").readContract({
    address: deployed.settlement,
    abi: settlementAbi,
    functionName: "getOrder",
    args: [key],
  });
  if (order.status === OPEN) return undefined;
  return order.status === SETTLED ? "done" : "refunded";
}

/// Aggregated stats over every recorded move. Moves still settling are checked against the settlement
/// contract first, and their outcome is saved.
export async function GET() {
  const intents = await readIntents();
  const settling = intents.filter((intent) => intent.status === "sent");
  const outcomes = await Promise.all(settling.map((intent) => settlementStatus(intent).catch(() => undefined)));
  const updates = new Map<string, Intent["status"]>();
  settling.forEach((intent, i) => {
    const outcome = outcomes[i];
    if (outcome) updates.set(intent.tx.toLowerCase(), outcome);
  });
  await updateStatuses(updates);
  return Response.json(
    aggregate(intents.map((intent) => ({ ...intent, status: updates.get(intent.tx.toLowerCase()) ?? intent.status }))),
  );
}

/// Records a move. It is kept only when its transaction exists on the chain it names and was sent by the
/// wallet it names, so the stats count real moves.
export async function POST(request: Request) {
  const body = (await request.json()) as Partial<Intent>;
  const { tx, account, purpose, summary, chain, asset, amount, status } = body;
  const known = chain === "arc" || (chain !== undefined && chain in sources);
  if (
    !isHex(tx) ||
    tx.length !== 66 ||
    !isAddress(account ?? "") ||
    !purposes.has(purpose ?? "") ||
    !statuses.has(status ?? "") ||
    !known ||
    !asset ||
    !tokenBySymbol[asset] ||
    !(Number(amount) > 0) ||
    typeof summary !== "string"
  ) {
    return Response.json({ error: "invalid intent" }, { status: 400 });
  }

  const client = clientFor(chain!);
  const found = await client.getTransaction({ hash: tx }).catch(() => undefined);
  if (!found || found.from.toLowerCase() !== account!.toLowerCase() || found.blockNumber === null) {
    return Response.json({ error: "transaction not found for this wallet" }, { status: 422 });
  }
  // When the move happened, from its block rather than from when it was recorded.
  const block = await client.getBlock({ blockNumber: found.blockNumber }).catch(() => undefined);

  const price = (await prices(new URL(request.url).origin))[asset] ?? 0;
  const explorer = chain === "arc" ? arc.explorer : sources[chain as SourceId].explorer;
  const added = await addIntent({
    tx,
    at: block ? Number(block.timestamp) * 1000 : Date.now(),
    account: account!,
    purpose: purpose as Intent["purpose"],
    summary: summary.slice(0, 200),
    chain: chain!,
    asset,
    amount: Number(amount),
    usd: Number(amount) * price,
    status: status as Intent["status"],
    href: `${explorer}/tx/${tx}`,
  });
  return Response.json({ added });
}
