import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NextId } from "./plan";
import type { SourceId } from "./chains";

/// One move by any user, as recorded by the app and checked against its transaction on chain.
export type Intent = {
  tx: string;
  at: number;
  account: string;
  purpose: NextId | "back";
  summary: string;
  /// Where the move started: a source chain, or Arc for a bridge back.
  chain: SourceId | "arc";
  asset: string;
  amount: number;
  usd: number;
  status: "done" | "sent" | "stuck";
  href: string;
};

/// Intents live in a JSON file next to the app. It is enough for one server; a deployment on serverless
/// functions would swap this for a key-value store behind the same two functions.
const FILE = path.join(process.cwd(), ".data", "intents.json");

let queue: Promise<unknown> = Promise.resolve();

export async function readIntents(): Promise<Intent[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Intent[];
  } catch {
    return [];
  }
}

/// Adds an intent once per transaction. Writes are serialized and atomic, so concurrent requests cannot
/// lose each other's records.
export function addIntent(intent: Intent): Promise<boolean> {
  const write = queue.then(async () => {
    const intents = await readIntents();
    if (intents.some((existing) => existing.tx.toLowerCase() === intent.tx.toLowerCase())) return false;
    await mkdir(path.dirname(FILE), { recursive: true });
    const temp = `${FILE}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify([intent, ...intents]));
    await rename(temp, FILE);
    return true;
  });
  queue = write.catch(() => undefined);
  return write;
}

export type Slice = { key: string; volume: number; count: number };

export type Stats = {
  totals: { volume: number; count: number; wallets: number };
  byPurpose: Slice[];
  byChain: Slice[];
  byToken: Slice[];
  recent: Intent[];
};

function slices(intents: Intent[], keyOf: (intent: Intent) => string): Slice[] {
  const map = new Map<string, Slice>();
  for (const intent of intents) {
    const key = keyOf(intent);
    const slice = map.get(key) ?? { key, volume: 0, count: 0 };
    slice.volume += intent.usd;
    slice.count += 1;
    map.set(key, slice);
  }
  return [...map.values()].sort((a, b) => b.volume - a.volume || b.count - a.count);
}

export function aggregate(intents: Intent[]): Stats {
  return {
    totals: {
      volume: intents.reduce((sum, intent) => sum + intent.usd, 0),
      count: intents.length,
      wallets: new Set(intents.map((intent) => intent.account.toLowerCase())).size,
    },
    byPurpose: slices(intents, (intent) => intent.purpose),
    byChain: slices(intents, (intent) => intent.chain),
    byToken: slices(intents, (intent) => intent.asset),
    recent: [...intents].sort((a, b) => b.at - a.at).slice(0, 50),
  };
}
