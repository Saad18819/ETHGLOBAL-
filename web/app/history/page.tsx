"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";

import styles from "./history.module.css";
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

type Arrival = { at: number; symbol: string; amount: number; href: string };

export default function History() {
  const { address } = useConnection();
  const entries = useHistory(address);
  const arrivals = useQuery({
    queryKey: ["arrivals", address],
    enabled: Boolean(address),
    queryFn: async (): Promise<Arrival[]> => {
      const response = await fetch(`/api/arrivals?address=${address}`);
      return ((await response.json()) as { arrivals?: Arrival[] }).arrivals ?? [];
    },
  });

  if (!address) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>History</h1>
        <p className={styles.muted}>Connect a wallet to see what it moved and what for.</p>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>History</h1>

      <section>
        <h2 className={styles.heading}>Your moves</h2>
        {entries.length === 0 && <p className={styles.muted}>Moves made from this browser show up here.</p>}
        <ul className={styles.list}>
          {entries.map((entry) => {
            const brand = protocols[protocolOf[entry.purpose]];
            return (
              <li key={entry.id} className={styles.entry}>
                <div className={styles.row}>
                  <span className={styles.tag} style={swatchStyle(brand)}>
                    {purposeTitle(entry.purpose)}
                  </span>
                  <span className={styles.when}>{when(entry.at)}</span>
                </div>
                <p className={styles.summary}>{entry.summary}.</p>
                <p className={styles.status} data-status={entry.status}>
                  {statusText[entry.status]}
                  {entry.error && entry.status === "failed" ? `: ${entry.error}` : ""}
                  {entry.stuck && (
                    <>
                      {". "}
                      <Link href={`/finish?from=${entry.stuck.from}&tx=${entry.stuck.tx}`}>Finish it on Arc</Link>
                    </>
                  )}
                </p>
                {entry.steps.some((step) => step.href) && (
                  <p className={styles.links}>
                    {entry.steps
                      .filter((step) => step.href)
                      .map((step) => (
                        <a key={step.href} href={step.href} target="_blank" rel="noreferrer">
                          {step.name}
                        </a>
                      ))}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className={styles.heading}>Arrived on Arc</h2>
        <p className={styles.muted}>Every bridge that minted to this wallet on Arc, read from the explorer.</p>
        <ul className={styles.list}>
          {(arrivals.data ?? []).map((arrival) => (
            <li key={arrival.href} className={styles.arrival}>
              <span>
                {arrival.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} {arrival.symbol}
              </span>
              <span className={styles.when}>{when(arrival.at)}</span>
              <a href={arrival.href} target="_blank" rel="noreferrer">
                View
              </a>
            </li>
          ))}
          {arrivals.isFetched && arrivals.data?.length === 0 && <p className={styles.muted}>Nothing yet.</p>}
        </ul>
      </section>
    </main>
  );
}
