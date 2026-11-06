import { createPublicClient, http, isAddress, isHex, type Chain } from "viem";

import { sources, type SourceId } from "@/lib/chains";
import { arcChain, ARC_RPC } from "@/lib/config";
import { arc } from "@/lib/contracts";
import { addIntent, aggregate, readIntents, type Intent } from "@/lib/intents";
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

/// Aggregated stats over every recorded move.
export async function GET() {
  return Response.json(aggregate(await readIntents()));
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
