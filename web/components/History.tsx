"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";

import styles from "./History.module.css";
import type { Activity, Purpose } from "@/app/api/activity/route";
import { protocolOf, protocols, swatchStyle } from "@/lib/brand";
import { purposeTitle, useHistory, type Entry } from "@/lib/history";

const when = (at: number) =>
  new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const statusText: Record<Entry["status"], string> = {
  done: "Done",
  sent: "Sent, settling on Arc",
  failed: "Did not finish",
  stuck: "Burned, not minted yet",
};

/// What a move read from the chain did, for arrivals no move in this browser explains.
const inferred: Record<Purpose, string> = {
  pay: "paid someone on Arc",
  hold: "held it on Arc",
  pool: "added it to a Uniswap pool on Arc",
  lend: "lent it on Morpho",
  loop: "looped it on Morpho",
  back: "sent it back from Arc",
};

/// Moves per page, and how many of the latest are kept at all.
const PAGE = 10;
const LIMIT = 100;

/// A local move explains an arrival when it started up to this long before the mint.
const MATCH = 30 * 60_000;

type Row = {
  key: string;
  at: number;
  purpose: Purpose;
  summary: string;
  status?: Entry["status"];
  error?: string;
  stuck?: Entry["stuck"];
  links: { name: string; href: string }[];
};

/// Every move for the connected wallet: what was moved, what for, and how it went. Moves made in this
/// browser carry their own description; anything else that reached Arc is read from the explorer, with its
/// purpose taken from what the wallet did next.
export function History() {
  const { address } = useConnection();
  // Failed moves moved nothing, so they are not shown (including ones saved before this rule).
  const entries = useHistory(address).filter((entry) => entry.status !== "failed");
  const activity = useQuery({
    queryKey: ["activity", address],
    enabled: Boolean(address),
    refetchInterval: 30_000,
    queryFn: async (): Promise<Activity[]> => {
      const response = await fetch(`/api/activity?address=${address}`);
      if (!response.ok) throw new Error("The Arc explorer is not answering right now");
      return ((await response.json()) as { activity?: Activity[] }).activity ?? [];
    },
  });
  const [page, setPage] = useState(0);

  if (!address) return null;

  const used = new Set<string>();
  const rows: Row[] = (activity.data ?? []).map((item) => {
    const match = entries.find(
      (entry) =>
        !used.has(entry.id) &&
        (item.kind === "departure"
          ? entry.purpose === "back" && Math.abs(item.at - entry.at) < MATCH
          : entry.purpose !== "back" && entry.at <= item.at && item.at - entry.at < MATCH),
    );
    if (match) used.add(match.id);
    const amount = `${item.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${item.symbol}`;
    return {
      key: item.href,
      at: item.at,
      purpose: match?.purpose ?? item.purpose,
      summary:
        match?.summary ??
        (item.kind === "departure"
          ? `Sent ${amount} from Arc to another chain`
          : `${amount} arrived on Arc, and then ${inferred[item.purpose]}`),
      status: match?.status,
      error: match?.error,
      stuck: match?.stuck,
      links: [
        { name: item.kind === "departure" ? "Sent from Arc" : "Arrived on Arc", href: item.href },
        ...(match?.steps.filter((step): step is { name: string; href: string } => Boolean(step.href)) ?? []),
        ...item.actions,
      ],
    };
  });
  // Moves that never reached Arc, such as a failed or still settling one, from this browser.
  for (const entry of entries.filter((entry) => !used.has(entry.id))) {
    rows.push({
      key: entry.id,
      at: entry.at,
      purpose: entry.purpose,
      summary: entry.summary,
      status: entry.status,
      error: entry.error,
      stuck: entry.stuck,
      links: entry.steps.filter((step): step is { name: string; href: string } => Boolean(step.href)),
    });
  }
  rows.sort((a, b) => b.at - a.at);
  // The latest moves only, a page at a time, so the list under the move never grows without end.
  const kept = rows.slice(0, LIMIT);
  const pages = Math.max(1, Math.ceil(kept.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = kept.slice(current * PAGE, current * PAGE + PAGE);

  return (
    <section className={styles.history}>
      <h2 className={styles.heading}>History</h2>
      {activity.isError && <p className={styles.muted}>{activity.error.message}.</p>}
      {activity.isFetched && rows.length === 0 && <p className={styles.muted}>Nothing moved yet.</p>}
      <ul className={styles.list}>
        {visible.map((row) => {
          const brand = protocols[row.purpose === "back" ? "arc" : protocolOf[row.purpose]];
          return (
            <li key={row.key} className={styles.entry}>
              <div className={styles.row}>
                <span className={styles.tag} style={swatchStyle(brand)}>
                  {purposeTitle(row.purpose)}
                </span>
                <span className={styles.when}>{when(row.at)}</span>
              </div>
              <p className={styles.summary}>{row.summary}.</p>
              {row.status && row.status !== "done" && (
                <p className={styles.status} data-status={row.status}>
                  {statusText[row.status]}
                  {row.error && row.status === "failed" ? `: ${row.error}` : ""}
                  {row.stuck && (
                    <>
                      {". "}
                      <Link href={`/finish?from=${row.stuck.from}&tx=${row.stuck.tx}`}>Finish it on Arc</Link>
                    </>
                  )}
                </p>
              )}
              {row.links.length > 0 && (
                <p className={styles.links}>
                  {row.links.map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
                      {link.name}
                    </a>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {pages > 1 && (
        <div className={styles.pager}>
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Newer
          </button>
          <span>
            Page {current + 1} of {pages}
          </span>
          <button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>
            Older
          </button>
        </div>
      )}
    </section>
  );
}
