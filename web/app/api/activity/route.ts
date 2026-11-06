import { isAddress } from "viem";

import { arc } from "@/lib/contracts";

type Transfer = {
  timestamp: string;
  method?: string;
  transaction_hash: string;
  token?: { symbol?: string };
  total?: { value?: string; decimals?: string };
  from?: { hash?: string };
  to?: { hash?: string };
};

type Transaction = {
  hash: string;
  from?: { hash?: string } | null;
  timestamp: string;
  method?: string | null;
  status?: string;
  to?: { hash?: string } | null;
};

export type Purpose = "pay" | "hold" | "pool" | "lend" | "loop" | "back";

export type Activity = {
  at: number;
  kind: "arrival" | "departure";
  amount: number;
  symbol: string;
  href: string;
  purpose: Purpose;
  /// What the wallet did on Arc with the arrival, in order.
  actions: { name: string; href: string }[];
};

/// Uniswap v4 PositionManager on Arc (same address on testnet and mainnet).
const POSITION_MANAGER = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
/// Contracts a bridge out of Arc sends tokens to: Bridge Kit's bridge contract and Circle's CCTP v2
/// TokenMessengers, testnet and mainnet, from Circle's Bridge Kit chain definitions.
const CCTP_SENDERS = new Set(
  [
    "0xC5567a5E3370d4DBfB0540025078e283e36A363d",
    "0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0",
    "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A",
    "0x71f54F818671cD0D7ea140Da213e5C8b5C92a408",
  ].map((address) => address.toLowerCase()),
);
/// A move's actions on Arc follow its arrival within this window.
const WINDOW = 30 * 60_000;
const TTL = 20_000;
const cache = new Map<string, { at: number; items: unknown[] }>();

/// Reads a wallet's own transactions on Arc as the purpose of a move: a Memo call is a payment, a
/// PositionManager call is liquidity, a vault deposit is lending, a borrow is a loop, and nothing beyond
/// swaps means the funds are held.
function purposeOf(transactions: Transaction[]): Purpose {
  const call = (tx: Transaction) => ({ to: tx.to?.hash?.toLowerCase() ?? "", method: tx.method ?? "" });
  const calls = transactions.map(call);
  if (calls.some((c) => c.to === arc.memo.toLowerCase() || c.method === "memo")) return "pay";
  if (calls.some((c) => c.to === POSITION_MANAGER)) return "pool";
  if (calls.some((c) => /borrow|supplyCollateral|addCollateral/i.test(c.method))) return "loop";
  if (calls.some((c) => /^deposit$/i.test(c.method))) return "lend";
  return "hold";
}

const label = (method?: string | null) =>
  (method ?? "call").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/// Every bridge into and out of a wallet on Arc, newest first, with what the wallet did with it. Read from
/// the Arc explorer, so it covers moves from any app or device.
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address") ?? "";
  if (!isAddress(address)) return Response.json({ error: "address required" }, { status: 400 });
  const wallet = address.toLowerCase();

  const get = async <T,>(path: string): Promise<T[]> => {
    const url = `${arc.explorer}/api/v2/addresses/${address}/${path}`;
    const cached = cache.get(url);
    if (cached && Date.now() - cached.at < TTL) return cached.items as T[];
    // The public explorer rate limits; back off and retry rather than report an empty history.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        const items = ((await response.json()) as { items?: T[] }).items ?? [];
        cache.set(url, { at: Date.now(), items });
        return items;
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
    }
    throw new Error("explorer unavailable");
  };
  let transfers: Transfer[];
  let transactions: Transaction[];
  try {
    [transfers, transactions] = await Promise.all([get<Transfer>("token-transfers"), get<Transaction>("transactions")]);
  } catch {
    return Response.json({ error: "The Arc explorer is not answering right now" }, { status: 503 });
  }
  // The explorer reports a method by name or by selector, so moves are told apart by where tokens went.
  const departures = transfers.filter(
    (t) => t.from?.hash?.toLowerCase() === wallet && CCTP_SENDERS.has(t.to?.hash?.toLowerCase() ?? ""),
  );
  const departed = new Set(departures.map((t) => t.transaction_hash));
  const departedAt = departures.map((t) => Date.parse(t.timestamp));
  const minted = new Set(transfers.filter((t) => /^0x0+$/.test(t.from?.hash ?? "")).map((t) => t.transaction_hash));
  const own = transactions
    .map((tx) => ({ ...tx, at: Date.parse(tx.timestamp) }))
    // Not the bridges themselves, a mint the wallet submitted, or the approval just before a bridge out.
    .filter(
      (tx) =>
        tx.status === "ok" &&
        tx.from?.hash?.toLowerCase() === wallet &&
        !departed.has(tx.hash) &&
        !minted.has(tx.hash) &&
        !departedAt.some((at) => at >= tx.at && at - tx.at < 2 * 60_000),
    )
    .sort((a, b) => a.at - b.at);
  const amountOf = (transfer: Transfer) => Number(transfer.total?.value ?? 0) / 10 ** Number(transfer.total?.decimals ?? 0);

  // A CCTP mint arrives from the zero address.
  const arrivals = transfers
    .filter((t) => /^0x0+$/.test(t.from?.hash ?? "") && t.to?.hash?.toLowerCase() === wallet)
    .map((t) => ({ at: Date.parse(t.timestamp), transfer: t }))
    .sort((a, b) => a.at - b.at);

  const activity: Activity[] = arrivals.map(({ at, transfer }, i) => {
    const until = Math.min(arrivals[i + 1]?.at ?? Infinity, at + WINDOW);
    const after = own.filter((tx) => tx.at >= at && tx.at < until);
    return {
      at,
      kind: "arrival",
      amount: amountOf(transfer),
      symbol: transfer.token?.symbol ?? "",
      href: `${arc.explorer}/tx/${transfer.transaction_hash}`,
      purpose: purposeOf(after),
      actions: after.map((tx) => ({ name: label(tx.method), href: `${arc.explorer}/tx/${tx.hash}` })),
    };
  });

  for (const sent of departures) {
    activity.push({
      at: Date.parse(sent.timestamp),
      kind: "departure",
      amount: amountOf(sent),
      symbol: sent.token?.symbol ?? "USDC",
      href: `${arc.explorer}/tx/${sent.transaction_hash}`,
      purpose: "back",
      actions: [],
    });
  }

  return Response.json({ activity: activity.sort((a, b) => b.at - a.at) });
}
