"use client";

import { useState, type ReactNode } from "react";

import styles from "./Details.module.css";
import type { CctpFees } from "@/lib/flows";
import { arrival, sources } from "@/lib/chains";
import type { SourceQuote } from "@/lib/uniswap";
import { feeApr, percent, usd, type Markets } from "@/lib/markets";
import { isTestnet } from "@/lib/network";
import type { PoolState } from "@/lib/pools";
import { liquidationDrop, loopRounds, MAX_LEVERAGE } from "@/lib/loop";
import { bridgedAsset, ranges, routeOf, type Plan } from "@/lib/plan";

export type PoolStats = { rate: number; usdcDepth: number; eurcDepth: number };


type Row = [label: string, value: ReactNode];

/// Rows that answer "what do I get" or warn; everything else waits behind the toggle.
const summary = new Set([
  "Arrives",
  "They get",
  "Stays with you",
  "Lands as",
  "You get about",
  "Price impact",
  "Pool price",
  "On Arc mainnet",
  "Earns about there",
  "Deposits into",
  "Pool",
  "New pool",
  "Same pair elsewhere",
  "Exposure",
  "Risk",
]);

/// Where the transaction itself runs, next to the mainnet numbers shown for reference.
const where = isTestnet ? " on testnet" : "";

/// Numbers behind the sentence, so the user knows what they get before they sign.
export function Details({
  plan,
  markets,
  pool,
  fees,
  sourceQuote,
  chosenPool,
  leftover,
}: {
  plan: Plan;
  markets?: Markets;
  pool?: PoolStats;
  chosenPool?: PoolState;
  /// What stays in the wallet on Arc after an exact payment, in the pay token.
  leftover?: number;
  fees?: CctpFees;
  sourceQuote?: SourceQuote;
}) {
  // After a Uniswap source swap, everything downstream works with the USDC it produced.
  const usdcOut = sourceQuote ? Number(sourceQuote.amountOut) / 1e6 : undefined;
  const amount = usdcOut ?? (Number(plan.amount) || 0);
  const fast = plan.speed === "fast";
  const price = usdcOut !== undefined ? 1 : (markets?.prices[plan.asset] ?? NaN);
  // What the amount is worth in USDC, which is what the pool and vault receive. Zero until prices load.
  const valueUsd = Number.isFinite(price) ? amount * price : 0;
  const rows: Row[] = [];

  if (sourceQuote && usdcOut !== undefined) {
    const via = sourceQuote.pools ? ` through ${sourceQuote.pools} pools` : "";
    rows.push([`Uniswap on ${sources[plan.from].label}`, `${plan.amount} ${plan.asset} to about ${usdcOut.toFixed(2)} USDC${via}`]);
    const impact = sourceQuote.priceImpact;
    if (impact !== undefined && impact > 1) {
      rows.push([
        "Price impact",
        <span key="impact" className={styles.caution}>
          {impact.toFixed(2)}%, try a smaller amount
        </span>,
      ]);
    }
    if (sourceQuote.deviation !== undefined && Math.abs(sourceQuote.deviation) > 0.1) {
      rows.push([
        "Pool price",
        <span key="deviation" className={styles.caution}>
          This testnet pool prices {plan.asset} {(sourceQuote.deviation + 1).toFixed(1)}x the market. On mainnet the same
          route meets real liquidity.
        </span>,
      ]);
    }
    if (sourceQuote.gasUsd !== undefined) rows.push(["Swap gas", usd(sourceQuote.gasUsd)]);
  }
  rows.push(["Arrives", arrival(fast)]);
  if ((plan.asset === "USDC" || usdcOut !== undefined) && fees) {
    const bps = fast ? fees.fast : fees.standard;
    const parts = bps ? [`${((amount * bps) / 10_000).toFixed(4)} USDC (${bps} bps)`] : [];
    // Circle's forwarder mints on Arc for the wallet route, so no gas is needed there.
    if (routeOf(plan) === "wallet" && fees.forward) parts.push(`${fees.forward.toFixed(4)} USDC for minting on ${sources[plan.to].label}`);
    rows.push(["Transfer fee", parts.length ? parts.join(" plus ") : "none"]);
  }

  switch (plan.next) {
    case "pay":
      rows.push(...payRows(plan, pool));
      if (leftover !== undefined && leftover >= 0.01) {
        rows.push(["Stays with you", `at least ${leftover.toFixed(2)} ${plan.payToken} in your wallet on Arc`]);
      }
      break;
    case "hold":
      rows.push(...holdRows(plan, amount * price, markets, pool));
      break;
    case "pool":
      rows.push(...(plan.pool === "USDC/EURC" ? poolRows(plan, valueUsd, pool, markets) : pairRows(plan, valueUsd, chosenPool, markets)));
      break;
    case "lend":
      rows.push(...lendRows(plan, valueUsd, markets));
      break;
    case "loop":
      rows.push(...loopRows(plan, amount * price, markets));
      break;
  }

  return <Rows rows={rows} />;
}

function Rows({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.filter(([label]) => summary.has(label) || label.startsWith("Uniswap on"));
  const hidden = rows.length - shown.length;
  return (
    <div className={styles.wrap}>
      <dl className={styles.details}>
        {shown.map(([label, value]) => (
          <div key={label} className={styles.row}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {(hidden > 0 || open) && (
        <button type="button" className={styles.toggle} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Fewer details" : `${hidden} more ${hidden === 1 ? "detail" : "details"}`}
        </button>
      )}
    </div>
  );
}

function payRows(plan: Plan, pool?: PoolStats): Row[] {
  // Elsewhere the payment is minted straight to them; the fee comes out of what is bridged, rounded up.
  if (plan.to !== "arc") {
    return [["They get", `at least ${plan.payAmount || 0} ${plan.payToken} on ${sources[plan.to].label}`]];
  }
  if (routeOf(plan) !== "router" || plan.payToken === "USDC") {
    return [["They get", `exactly ${plan.payAmount || 0} ${plan.payToken}`]];
  }
  if (!pool) return [];
  const needed = Number(plan.payAmount) / pool.rate;
  return [
    ["They get", `exactly ${plan.payAmount || 0} EURC`],
    ["Rate", `1 USDC = ${pool.rate.toFixed(4)} EURC on Uniswap`],
    ["Costs about", `${needed.toFixed(2)} USDC, the rest comes back to you`],
  ];
}

function holdRows(plan: Plan, valueUsd: number, markets?: Markets, pool?: PoolStats): Row[] {
  if (plan.hold === bridgedAsset(plan)) {
    return [["Lands as", `${plan.hold} in your wallet on ${sources[plan.to].label}, no swap`]];
  }
  if (plan.hold === "EURC" && bridgedAsset(plan) === "USDC" && pool) {
    return [
      ["Swaps through", "Uniswap v4 USDC/EURC pool, 0.05% fee"],
      ["You get about", `${(Number(plan.amount) * pool.rate).toFixed(2)} EURC`],
    ];
  }
  const target = markets?.prices[plan.hold];
  if (!target || !Number.isFinite(valueUsd)) return [["Swaps through", "Circle Swap"]];
  return [
    ["Swaps through", "Circle Swap"],
    ["You get about", `${(valueUsd / target).toFixed(plan.hold === "cirBTC" ? 6 : 2)} ${plan.hold}`],
    ["Max slippage", `${plan.slippage}%`],
  ];
}

function poolRows(plan: Plan, amount: number, pool?: PoolStats, markets?: Markets): Row[] {
  if (!pool) return [];
  const depth = pool.usdcDepth + pool.eurcDepth / pool.rate;
  const volume = markets?.pool.volume7d ?? 0;
  const apr = feeApr(volume, 0.0005, depth + amount);
  const main = markets?.mainnet.pools.find((p) => p.pair === "USDC/EURC");
  return [
    ["Pool", "Uniswap v4 USDC/EURC, 0.05% fee tier"],
    ...(main
      ? ([
          [
            "On Arc mainnet",
            `${percent(main.apr)} fee APR, ${usd(main.volume24hUsd)} traded in 24 hours, ${usd(main.tvlUsd)} within 1% of the price` +
              (main.coverage < 1 ? `, from ${percent(main.coverage, 0)} of the day` : ""),
          ],
        ] as Row[])
      : []),
    [`Fee APR${where}`, `${percent(apr)}, from ${usd(volume)} of volume in the last 7 days`],
    ["You earn about", `${(amount * apr).toFixed(2)} USDC a year in fees, more while a narrow range stays in range`],
    [`Price${where}`, `1 USDC = ${pool.rate.toFixed(4)} EURC`],
    ["In range now", `about ${usd(depth)}`],
    ["Your share", depth > 0 ? `about ${percent(amount / (depth + amount), 1)} of in-range liquidity` : "all of it"],
    ["Range", ranges[plan.range]],
    ...(plan.range === "full" ? [] : ([["Note", "Earns fees only while the price stays inside the range"]] as Row[])),
  ];
}

/// Any other pair on Arc. Arc mainnet has no such pool yet, so there are no mainnet numbers to show.
function pairRows(plan: Plan, valueUsd: number, state?: PoolState, markets?: Markets): Row[] {
  if (!state) return [];
  const { pair } = state;
  const rows: Row[] = [["Pool", `Uniswap v4 ${pair.id}, ${pair.fee / 10_000}% fee tier${isTestnet ? ", Arc Testnet" : ""}`]];
  const reference = markets?.mainnet.references.find((ref) => ref.pair === pair.id);
  if (reference) {
    rows.push([
      "Same pair elsewhere",
      `${percent(reference.apr)} fee APR over 7 days in ${reference.source}, ${usd(reference.tvl)} of liquidity`,
    ]);
  }
  if (!state.exists) {
    rows.push([
      "New pool",
      `There is no ${pair.id} pool on Arc yet. Your deposit creates it at today's market price, and you earn every fee until others join.`,
    ]);
  } else {
    rows.push([`Price${where}`, `1 ${pair.a} = ${state.price.toPrecision(5)} ${pair.b}`]);
    rows.push(["In range now", `about ${usd(state.depthUsd)}`]);
    rows.push([
      "Your share",
      state.depthUsd > 0 ? `about ${percent(valueUsd / (state.depthUsd + valueUsd), 1)} of in-range liquidity` : "all of it",
    ]);
  }
  rows.push(["Split", `about ${usd(valueUsd / 2)} in each of ${pair.a} and ${pair.b}, swapped with Circle Swap`]);
  rows.push(["Range", ranges[plan.range]]);
  return rows;
}

function lendRows(plan: Plan, amount: number, markets?: Markets): Row[] {
  const vault = markets?.vaults.find((v) => v.address === plan.vault) ?? markets?.vaults[0];
  if (!vault) return [];
  const best = markets?.mainnet.vaults ?? [];
  return [
    ...(best.length
      ? ([
          [
            "On Arc mainnet",
            best
              .slice(0, 3)
              .map((v) => `${v.name} ${percent(v.apy)} (${usd(v.liquidity)})`)
              .join(", "),
          ],
          ["Earns about there", `${(amount * best[0].apy).toFixed(2)} USDC a year`],
        ] as Row[])
      : []),
    [`Deposits into`, `${vault.name} on ${vault.protocol === "MORPHO" ? "Morpho" : vault.protocol}${isTestnet ? ", Arc Testnet" : ""}`],
    [`APY${where}`, percent(vault.apy)],
    ["Earns about", `${(amount * vault.apy).toFixed(2)} USDC a year`],
    ["Available liquidity", usd(vault.liquidity)],
    ["Vault fee", percent(vault.fee, 0)],
  ];
}

function loopRows(plan: Plan, valueUsd: number, markets?: Markets): Row[] {
  const market = markets?.markets.find((m) => m.collateral === "cirBTC");
  const leverage = Number(plan.leverage);
  const btc = markets?.prices.cirBTC ?? NaN;
  if (!market || !Number.isFinite(valueUsd)) return [];
  if (!(leverage > 1 && leverage <= MAX_LEVERAGE)) return [];

  const ltv = (leverage - 1) / leverage;
  const drop = liquidationDrop(leverage, market.lltv);
  const liquidation = btc * (1 - drop);
  const rounds = loopRounds(leverage, market.lltv);
  const main = markets?.mainnet.markets.find((m) => m.pair === "cirBTC/USDC");
  return [
    ["Market", `Morpho cirBTC/USDC${isTestnet ? " on Arc Testnet" : ""}, LLTV ${percent(market.lltv, 0)}`],
    ...(main
      ? ([
          [
            "On Arc mainnet",
            `borrow at ${percent(main.borrowApy)}, ${usd(main.liquidity)} available; the loop costs about ${(valueUsd * (leverage - 1) * main.borrowApy).toFixed(2)} USDC a year there`,
          ],
        ] as Row[])
      : []),
    ["BTC price", usd(btc)],
    ["Exposure", `${usd(valueUsd * leverage)} of BTC for ${usd(valueUsd)}`],
    ["Borrows", `about ${(valueUsd * (leverage - 1)).toFixed(2)} USDC at ${percent(market.borrowApy, 3)}${where}`],
    [
      "Risk",
      <Risk key="risk" ltv={ltv} lltv={market.lltv} drop={drop} liquidation={usd(liquidation)} />,
    ],
    ["Rounds", `${rounds}, each one borrow, swap and add collateral`],
    ["Borrow liquidity", usd(market.liquidity)],
  ];
}

/// Loan to value against the liquidation line, with how far BTC can fall before it is crossed.
function Risk({ ltv, lltv, drop, liquidation }: { ltv: number; lltv: number; drop: number; liquidation: string }) {
  const level = drop > 0.4 ? "low" : drop > 0.2 ? "medium" : "high";
  return (
    <div className={styles.risk} data-level={level}>
      <div className={styles.meter}>
        <span className={styles.fill} style={{ width: `${(ltv / lltv) * 100}%` }} />
      </div>
      <div className={styles.meterLegend}>
        <span>Loan to value {percent(ltv, 0)}</span>
        <span>Liquidation at {percent(lltv, 0)}</span>
      </div>
      <p className={styles.riskText}>
        BTC can fall {percent(drop, 0)}, to about {liquidation}, before the position is liquidated.
      </p>
    </div>
  );
}
