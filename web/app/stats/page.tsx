"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import styles from "./stats.module.css";
import { protocolOf, protocols, swatchStyle } from "@/lib/brand";
import { sources, type SourceId } from "@/lib/chains";
import { purposeTitle } from "@/lib/history";
import type { Intent, Slice, Stats } from "@/lib/intents";
import { usd } from "@/lib/markets";

const PAGE = 10;

const chainLabel = (key: string) => (key === "arc" ? "Arc" : (sources[key as SourceId]?.label ?? key));
const when = (at: number) =>
  new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

/// One measure across categories: a labelled bar per row, its value and share beside it, the exact
/// numbers on hover. Volume and number of moves are separate charts, never two scales on one axis.
function Bars({
  title,
  slices,
  measure,
  label,
  tag,
}: {
  title: string;
  slices: Slice[];
  measure: "volume" | "count";
  label: (key: string) => string;
  tag?: (key: string) => React.ReactNode;
}) {
  const rows = [...slices].sort((a, b) => b[measure] - a[measure]);
  const total = rows.reduce((sum, slice) => sum + slice[measure], 0);
  const max = Math.max(...rows.map((slice) => slice[measure]), 0);
  const format = (value: number) => (measure === "volume" ? usd(value) : value.toLocaleString("en-US"));
  return (
    <figure className={styles.chart}>
      <figcaption className={styles.caption}>{title}</figcaption>
      {rows.length === 0 && <p className={styles.muted}>Nothing yet.</p>}
      <ul className={styles.bars}>
        {rows.map((slice) => {
          const share = total > 0 ? slice[measure] / total : 0;
          const tip = `${label(slice.key)}: ${format(slice[measure])}, ${(share * 100).toFixed(1)}% of ${measure === "volume" ? "volume" : "moves"}`;
          return (
            <li key={slice.key} className={styles.bar} tabIndex={0} aria-label={tip}>
              <span className={styles.label}>
                {tag?.(slice.key)}
                {label(slice.key)}
              </span>
              <span className={styles.track}>
                <span className={styles.fill} style={{ width: `${max > 0 ? (slice[measure] / max) * 100 : 0}%` }} />
              </span>
              <span className={styles.value}>
                {format(slice[measure])}
                <span className={styles.share}>{(share * 100).toFixed(0)}%</span>
              </span>
              <span className={styles.tip} role="tooltip">
                {tip}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function Pair({ title, slices, label, tag }: { title: string; slices: Slice[]; label: (key: string) => string; tag?: (key: string) => React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{title}</h2>
      <div className={styles.pair}>
        <Bars title="By volume" slices={slices} measure="volume" label={label} tag={tag} />
        <Bars title="By number of moves" slices={slices} measure="count" label={label} tag={tag} />
      </div>
    </section>
  );
}

function Recent({ intents }: { intents: Intent[] }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(intents.length / PAGE));
  const current = Math.min(page, pages - 1);
  const rows = intents.slice(current * PAGE, current * PAGE + PAGE);
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Recent moves</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Wallet</th>
              <th>Use case</th>
              <th>From</th>
              <th className={styles.number}>Amount</th>
              <th className={styles.number}>Value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((intent) => (
              <tr key={intent.tx} title={intent.summary}>
                <td>
                  <a href={intent.href} target="_blank" rel="noreferrer">
                    {when(intent.at)}
                  </a>
                </td>
                <td className="mono">{short(intent.account)}</td>
                <td>{purposeTitle(intent.purpose)}</td>
                <td>{chainLabel(intent.chain)}</td>
                <td className={styles.number}>
                  {amount(intent.amount)} {intent.asset}
                </td>
                <td className={styles.number}>{usd(intent.usd)}</td>
                <td>{intent.status === "done" ? "Done" : intent.status === "sent" ? "Settling" : "Not minted yet"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.muted}>
                  No moves yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

/// Every move made with the app, by any wallet. Each one was checked against its transaction on chain
/// before it was counted.
export default function StatsPage() {
  const stats = useQuery({
    queryKey: ["stats"],
    refetchInterval: 30_000,
    queryFn: async (): Promise<Stats> => (await fetch("/api/intents")).json(),
  });
  const data = stats.data;
  const purposeTag = (key: string) => {
    const brand = protocols[key === "back" ? "arc" : protocolOf[key as keyof typeof protocolOf]];
    return brand ? (
      <span className={styles.tag} style={swatchStyle(brand)}>
        {brand.name}
      </span>
    ) : null;
  };

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Stats</h1>
      <p className={styles.muted}>Every move made with andthen, by any wallet, counted once its transaction is found on chain.</p>

      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{data ? usd(data.totals.volume) : "…"}</span>
          <span className={styles.tileLabel}>Volume moved</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{data ? data.totals.count.toLocaleString("en-US") : "…"}</span>
          <span className={styles.tileLabel}>Moves</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{data ? data.totals.wallets.toLocaleString("en-US") : "…"}</span>
          <span className={styles.tileLabel}>Wallets</span>
        </div>
      </div>

      {data && (
        <>
          <Pair title="Use cases" slices={data.byPurpose} label={(key) => purposeTitle(key as Intent["purpose"])} tag={purposeTag} />
          <Pair title="Source chains" slices={data.byChain} label={chainLabel} />
          <Pair title="Source tokens" slices={data.byToken} label={(key) => key} />
          <Recent intents={data.recent} />
        </>
      )}
    </main>
  );
}
