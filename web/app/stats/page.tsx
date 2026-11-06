"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import styles from "./stats.module.css";
import { protocols, tokenColor } from "@/lib/brand";
import { sources, type SourceId } from "@/lib/chains";
import { purposeTitle } from "@/lib/history";
import type { Intent, Slice, Stats } from "@/lib/intents";
import { usd } from "@/lib/markets";

const PAGE = 10;

type Measure = "volume" | "count";

/// Colours in the app's own language: use cases in their protocol's colour (two shades where a protocol
/// does two things), chains and tokens in their own brand colours. Each category keeps its colour on
/// every chart and every refresh.
const purposeColors: Record<string, string> = {
  pay: protocols.arc.accent,
  hold: "#5a6a9c",
  pool: protocols.uniswap.accent,
  lend: protocols.morpho.accent,
  loop: "#8fb2ff",
  back: "#a9b3cf",
};
const chainColors: Record<string, string> = {
  base: "#0052ff",
  ethereum: "#627eea",
  polygon: "#8247e5",
  arbitrum: "#28a0f0",
  optimism: "#ff0420",
  avalanche: "#e84142",
  unichain: "#f50db4",
  arc: protocols.arc.accent,
};
const OTHER = "#c9c6cf";
/// Short names, so a legend row fits beside a small donut.
const purposeNames: Record<string, string> = {
  pay: "Pay",
  hold: "Hold",
  pool: "Uniswap pool",
  lend: "Lend",
  loop: "Loop",
  back: "Bridge back",
};

type Category = Slice & { color: string; label: string };

function categories(slices: Slice[], label: (key: string) => string, color: (key: string) => string): Category[] {
  return slices.map((slice) => ({ ...slice, label: label(slice.key), color: color(slice.key) }));
}

const formatOf = (measure: Measure) => (value: number) => (measure === "volume" ? usd(value) : value.toLocaleString("en-US"));

/// SVG path of a donut slice between two angles, measured clockwise from the top.
function arc(start: number, end: number, outer: number, inner: number) {
  const point = (angle: number, radius: number) =>
    `${(radius * Math.sin(angle)).toFixed(3)} ${(-radius * Math.cos(angle)).toFixed(3)}`;
  const large = end - start > Math.PI ? 1 : 0;
  return [
    `M ${point(start, outer)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(end, outer)}`,
    `L ${point(end, inner)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)}`,
    "Z",
  ].join(" ");
}

/// One dimension as a card: a small donut of the chosen measure, and a legend naming every colour with
/// its value and share. Hovering either highlights the category in both.
function Breakdown({ title, items, measure }: { title: string; items: Category[]; measure: Measure }) {
  const [active, setActive] = useState<string>();
  const format = formatOf(measure);
  const rows = [...items].sort((a, b) => b[measure] - a[measure]);
  const total = rows.reduce((sum, item) => sum + item[measure], 0);
  const shown = rows.filter((item) => item[measure] > 0);
  const focus = shown.find((item) => item.key === active);
  let angle = 0;
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {shown.length === 0 ? (
        <p className={styles.muted}>Nothing yet.</p>
      ) : (
        <div className={styles.cardBody}>
          <svg viewBox="-60 -60 120 120" className={styles.ring} role="img" aria-label={`${title}: ${format(total)}`}>
            {shown.length === 1 ? (
              <circle r="44" fill="none" stroke={shown[0].color} strokeWidth="16">
                <title>{`${shown[0].label}: ${format(shown[0][measure])}, 100%`}</title>
              </circle>
            ) : (
              shown.map((item) => {
                const sweep = (item[measure] / total) * Math.PI * 2;
                const path = arc(angle, angle + sweep, active === item.key ? 55 : 52, 36);
                angle += sweep;
                return (
                  <path
                    key={item.key}
                    d={path}
                    fill={item.color}
                    className={styles.slice}
                    data-dim={active !== undefined && active !== item.key ? "" : undefined}
                    onMouseEnter={() => setActive(item.key)}
                    onMouseLeave={() => setActive(undefined)}
                  >
                    <title>{`${item.label}: ${format(item[measure])}, ${((item[measure] / total) * 100).toFixed(1)}%`}</title>
                  </path>
                );
              })
            )}
            <text className={styles.centerValue} y="3" textAnchor="middle">
              {format(focus ? focus[measure] : total)}
            </text>
            <text className={styles.centerLabel} y="16" textAnchor="middle">
              {focus ? `${((focus[measure] / total) * 100).toFixed(0)}%` : "total"}
            </text>
          </svg>
          <ul className={styles.legend}>
            {rows.map((item) => (
              <li
                key={item.key}
                title={`${item.label}: ${format(item[measure])}, ${total > 0 ? ((item[measure] / total) * 100).toFixed(1) : 0}%`}
                data-active={active === item.key ? "" : undefined}
                onMouseEnter={() => setActive(item.key)}
                onMouseLeave={() => setActive(undefined)}
              >
                <span className={styles.swatch} style={{ background: item.color }} />
                <span className={styles.legendLabel}>{item.label}</span>
                <span className={styles.legendValue}>{format(item[measure])}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const chainLabel = (key: string) => (key === "arc" ? "Arc" : (sources[key as SourceId]?.label ?? key));
const when = (at: number) =>
  new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

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

  return (
    <main className={styles.page}>
      <div className={styles.top}>
        <div>
          <h1 className={styles.title}>Stats</h1>
          <p className={styles.muted}>Every move made with andthen, counted once its transaction is found on chain.</p>
        </div>
        <dl className={styles.totals}>
          <div>
            <dt>Volume</dt>
            <dd>{data ? usd(data.totals.volume) : "…"}</dd>
          </div>
          <div>
            <dt>Moves</dt>
            <dd>{data ? data.totals.count.toLocaleString("en-US") : "…"}</dd>
          </div>
          <div>
            <dt>Wallets</dt>
            <dd>{data ? data.totals.wallets.toLocaleString("en-US") : "…"}</dd>
          </div>
        </dl>
      </div>

      {data && (
        <>
          <div className={styles.cards}>
            {[
              {
                name: "Use cases",
                items: categories(data.byPurpose, (key) => purposeNames[key] ?? key, (key) => purposeColors[key] ?? OTHER),
              },
              { name: "Source chains", items: categories(data.byChain, chainLabel, (key) => chainColors[key] ?? OTHER) },
              {
                name: "Source tokens",
                items: categories(data.byToken, (key) => key, (key) => tokenColor(key).accent),
              },
            ].flatMap(({ name, items }) => [
              <Breakdown key={`${name}-volume`} title={`${name} by volume`} items={items} measure="volume" />,
              <Breakdown key={`${name}-count`} title={`${name} by number of moves`} items={items} measure="count" />,
            ])}
          </div>
          <Recent intents={data.recent} />
        </>
      )}
    </main>
  );
}
