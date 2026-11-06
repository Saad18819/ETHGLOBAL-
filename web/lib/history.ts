import { useCallback, useSyncExternalStore } from "react";
import type { Address } from "viem";

import { sources, type SourceId } from "./chains";
import { stepOf, type NextId, type Plan } from "./plan";

/// Past moves from this browser, per wallet: what was moved, what it was for, and how it went. Kept in
/// localStorage, so it is a convenience for the person using the app and never the source of truth; the
/// explorer links are.
export type Entry = {
  id: string;
  at: number;
  /// What the move was for, or "back" for a bridge from Arc to another chain.
  purpose: NextId | "back";
  summary: string;
  status: "done" | "sent" | "failed" | "stuck";
  steps: { name: string; href?: string }[];
  error?: string;
  /// A transfer burned but not minted, to finish on the finish page.
  stuck?: { from: SourceId; tx: string };
};

const LIMIT = 50;
const keyOf = (account: Address) => `andthen:history:${account.toLowerCase()}`;
const listeners = new Set<() => void>();
const empty: Entry[] = [];
const cache = new Map<string, { raw: string | null; entries: Entry[] }>();

function read(account: Address): Entry[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyOf(account));
  } catch {
    return empty;
  }
  const cached = cache.get(account);
  if (cached && cached.raw === raw) return cached.entries;
  let entries = empty;
  try {
    entries = raw ? (JSON.parse(raw) as Entry[]) : empty;
  } catch {
    entries = empty;
  }
  cache.set(account, { raw, entries });
  return entries;
}

export function record(account: Address, entry: Omit<Entry, "id" | "at">) {
  const next = [{ ...entry, id: crypto.randomUUID(), at: Date.now() }, ...read(account)].slice(0, LIMIT);
  try {
    window.localStorage.setItem(keyOf(account), JSON.stringify(next));
  } catch {
    // Private windows and blocked storage simply keep no history.
  }
  listeners.forEach((listener) => listener());
}

export function useHistory(account: Address | undefined): Entry[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    window.addEventListener("storage", listener);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", listener);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => (account ? read(account) : empty),
    () => empty,
  );
}

const shortAddress = (value: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

/// The sentence for a move, in the past tense.
export function describe(plan: Plan): string {
  const moved = `Moved ${plan.amount} ${plan.asset} from ${sources[plan.from].label}`;
  const purpose: Record<NextId, string> = {
    pay: `paid ${shortAddress(plan.recipient) || "someone"} ${plan.payAmount} ${plan.payToken}`,
    hold: `held it on Arc as ${plan.hold}`,
    pool: `added it to the ${plan.pool} pool on Uniswap`,
    lend: "lent it on Morpho",
    loop: `looped cirBTC to ${plan.leverage}x on Morpho`,
  };
  return `${moved}, and then ${purpose[plan.next]}`;
}

export const purposeTitle = (purpose: Entry["purpose"]) => (purpose === "back" ? "Bridge back" : stepOf(purpose).title);

/// Shares a finished move with the app's stats. The server keeps it only after finding the transaction on
/// chain, sent by this wallet; failing to share never affects the move itself.
export function publish(intent: {
  tx?: string;
  account: Address;
  purpose: Entry["purpose"];
  summary: string;
  chain: SourceId | "arc";
  asset: string;
  amount: string;
  status: "done" | "sent" | "stuck";
}) {
  if (!intent.tx) return;
  void fetch("/api/intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intent),
  }).catch(() => undefined);
}
