"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import styles from "./stats.module.css";
import { sourceIds, sources, type SourceId } from "@/lib/chains";
import { purposeTitle } from "@/lib/history";
import type { Intent, Slice, Stats } from "@/lib/intents";
import { usd } from "@/lib/markets";
import { nextSteps } from "@/lib/plan";
import { tokens } from "@/lib/tokens";

const PAGE = 10;

/// The fixed order each dimension's colours are assigned in: the app's own order of use cases, chains and
/// tokens.
const purposeOrder = [...nextSteps.map((step) => step.id as string), "back"];
const chainOrder = [...sourceIds, "arc"];
const tokenOrder = tokens.map((token) => token.symbol);

const chainLabel = (key: string) => (key === "arc" ? "Arc" : (sources[key as SourceId]?.label ?? key));
const when = (at: number) =>
  new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

/// The reference categorical palette from the dataviz guidelines, in its validated order: neighbouring
/// slices stay distinct for colour-blind readers. A category's colour comes from its fixed place in the
/// dimension, never from its rank, so it is the same on both charts and does not change as data moves.
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = "#b9b6bf";
const OTHER_KEY = "other";

type Category = Slice & { color: string; label: string };

/// Assigns colours by `order`, folding anything past the palette into one grey "Other".
function categories(slices: Slice[], order: string[], label: (key: string) => string): Category[] {
  const rank = (key: string) => {
    const at = order.indexOf(key);
    return at === -1 ? order.length : at;
  };
  const sorted = [...slices].sort((a, b) => rank(a.key) - rank(b.key));
  const kept = sorted.filter((slice) => rank(slice.key) < PALETTE.length);
  const rest = sorted.filter((slice) => rank(slice.key) >= PALETTE.length);
  const result: Category[] = kept.map((slice) => ({ ...slice, color: PALETTE[rank(slice.key)], label: label(slice.key) }));
  if (rest.length) {
    result.push({
      key: OTHER_KEY,
      label: "Other",
      color: OTHER,
      volume: rest.reduce((sum, slice) => sum + slice.volume, 0),
      count: rest.reduce((sum, slice) => sum + slice.count, 0),
    });
  }
  return result;
}

const formatOf = (measure: "volume" | "count") => (value: number) =>
  measure === "volume" ? usd(value) : value.toLocaleString("en-US");

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

/// One measure as a donut: the total in the middle, each category's exact value and share on hover.
function Donut({
  title,
  items,
  measure,
  active,
  onActive,
}: {
  title: string;
  items: Category[];
  measure: "volume" | "count";
  active?: string;
  onActive: (key?: string) => void;
}) {
  const format = formatOf(measure);
  const total = items.reduce((sum, item) => sum + item[measure], 0);
  const shown = items.filter((item) => item[measure] > 0);
  const focus = shown.find((item) => item.key === active);
  let angle = 0;
  return (
    <figure className={styles.donut}>
      <figcaption className={styles.caption}>{title}</figcaption>
      <svg viewBox="-60 -60 120 120" className={styles.ring} role="img" aria-label={`${title}: ${format(total)}`}>
        {shown.length === 1 ? (
          <circle r="42" fill="none" stroke={shown[0].color} strokeWidth="20" onMouseEnter={() => onActive(shown[0].key)} onMouseLeave={() => onActive()}>
            <title>{`${shown[0].label}: ${format(shown[0][measure])}, 100%`}</title>
          </circle>
        ) : (
          shown.map((item) => {
            const sweep = (item[measure] / total) * Math.PI * 2;
            const path = arc(angle, angle + sweep, active === item.key ? 55 : 52, 32);
            angle += sweep;
            return (
              <path
                key={item.key}
                d={path}
                fill={item.color}
                className={styles.slice}
                data-dim={active !== undefined && active !== item.key ? "" : undefined}
                onMouseEnter={() => onActive(item.key)}
                onMouseLeave={() => onActive()}
              >
                <title>{`${item.label}: ${format(item[measure])}, ${((item[measure] / total) * 100).toFixed(1)}%`}</title>
              </path>
            );
          })
        )}
        <text className={styles.centerValue} y="2" textAnchor="middle">
          {format(focus ? focus[measure] : total)}
        </text>
        <text className={styles.centerLabel} y="15" textAnchor="middle">
          {focus ? `${((focus[measure] / total) * 100).toFixed(0)}% ${focus.label}` : "total"}
        </text>
      </svg>
    </figure>
  );
}

/// Volume and number of moves for one dimension: two donuts, never two scales on one chart, and one
/// legend that names every colour with its exact numbers.
function Breakdown({
  title,
  slices,
  order,
  label,
}: {
  title: string;
  slices: Slice[];
  order: string[];
  label: (key: string) => string;
}) {
  const [active, setActive] = useState<string>();
  const items = categories(slices, order, label);
  const totals = { volume: items.reduce((s, i) => s + i.volume, 0), count: items.reduce((s, i) => s + i.count, 0) };
  const share = (value: number, total: number) => (total > 0 ? `${((value / total) * 100).toFixed(0)}%` : "");
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{title}</h2>
      {items.length === 0 ? (
        <p className={styles.muted}>Nothing yet.</p>
      ) : (
        <div className={styles.breakdown}>
          <Donut title="By volume" items={items} measure="volume" active={active} onActive={setActive} />
          <Donut title="By number of moves" items={items} measure="count" active={active} onActive={setActive} />
          <table className={styles.legend}>
            <thead>
              <tr>
                <th />
                <th className={styles.number}>Volume</th>
                <th className={styles.number}>Moves</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.key}
                  data-active={active === item.key ? "" : undefined}
                  onMouseEnter={() => setActive(item.key)}
                  onMouseLeave={() => setActive(undefined)}
                >
                  <td>
                    <span className={styles.swatch} style={{ background: item.color }} />
                    {item.label}
                  </td>
                  <td className={styles.number}>
                    {usd(item.volume)} <span className={styles.share}>{share(item.volume, totals.volume)}</span>
                  </td>
                  <td className={styles.number}>
                    {item.count} <span className={styles.share}>{share(item.count, totals.count)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
          <Breakdown
            title="Use cases"
            slices={data.byPurpose}
            order={purposeOrder}
            label={(key) => purposeTitle(key as Intent["purpose"])}
          />
          <Breakdown title="Source chains" slices={data.byChain} order={chainOrder} label={chainLabel} />
          <Breakdown title="Source tokens" slices={data.byToken} order={tokenOrder} label={(key) => key} />
          <Recent intents={data.recent} />
        </>
      )}
    </main>
  );
}
