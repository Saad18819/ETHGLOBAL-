"use client";

import styles from "./Details.module.css";
import { arrival, sources } from "@/lib/chains";
import type { CctpFees } from "@/lib/flows";
import { percent, usd, type Markets } from "@/lib/markets";
import { ranges, routeOf, type Plan } from "@/lib/plan";

export type PoolStats = { rate: number; usdcDepth: number; eurcDepth: number };

export const MAX_LEVERAGE = 3;

type Row = [label: string, value: string];

/// Numbers behind the sentence, so the user knows what they get before they sign.
export function Details({
  plan,
  markets,
  pool,
  fees,
}: {
  plan: Plan;
  markets?: Markets;
  pool?: PoolStats;
  fees?: CctpFees;
}) {
  const route = routeOf(plan);
  const amount = Number(plan.amount) || 0;
  const fast = plan.speed === "fast";
  const price = markets?.prices[plan.asset] ?? NaN;
  const rows: Row[] = [];

  rows.push([
    "Route",
    route === "router"
      ? "Circle CCTP moves the USDC, Chainlink CCIP the instruction, our contract settles on Arc"
      : `Circle Bridge Kit from ${sources[plan.from].label}, then your wallet on Arc`,
  ]);
  rows.push(["Arrives", arrival(fast)]);
  if (plan.asset === "USDC" && fees) {
    const bps = fast ? fees.fast : fees.standard;
    rows.push(["Transfer fee", bps ? `${((amount * bps) / 10_000).toFixed(4)} USDC (${bps} bps)` : "none"]);
  }

  switch (plan.next) {
    case "pay":
      rows.push(...payRows(plan, pool));
      break;
    case "hold":
      rows.push(...holdRows(plan, amount * price, markets, pool));
      break;
    case "pool":
      rows.push(...poolRows(plan, amount, pool));
      break;
    case "lend":
      rows.push(...lendRows(plan, amount, markets));
      break;
    case "loop":
      rows.push(...loopRows(plan, amount * price, markets));
      break;
  }

  return (
    <dl className={styles.details}>
      {rows.map(([label, value]) => (
        <div key={label} className={styles.row}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function payRows(plan: Plan, pool?: PoolStats): Row[] {
  if (routeOf(plan) !== "router" || plan.payToken === "USDC") return [["They get", `exactly ${plan.payAmount || 0} ${routeOf(plan) === "router" ? plan.payToken : plan.asset}`]];
  if (!pool) return [];
  const needed = Number(plan.payAmount) / pool.rate;
  return [
    ["They get", `exactly ${plan.payAmount || 0} EURC`],
    ["Rate", `1 USDC = ${pool.rate.toFixed(4)} EURC on Uniswap`],
    ["Costs about", `${needed.toFixed(2)} USDC, the rest comes back to you`],
  ];
}

function holdRows(plan: Plan, valueUsd: number, markets?: Markets, pool?: PoolStats): Row[] {
  if (plan.hold === "EURC" && plan.asset === "USDC" && pool) {
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

function poolRows(plan: Plan, amount: number, pool?: PoolStats): Row[] {
  if (!pool) return [];
  const depth = pool.usdcDepth + pool.eurcDepth / pool.rate;
  return [
    ["Pool", "Uniswap v4 USDC/EURC, 0.05% fee tier"],
    ["Price", `1 USDC = ${pool.rate.toFixed(4)} EURC`],
    ["In range now", `about ${usd(depth)}`],
    ["Your share", depth > 0 ? `about ${percent(amount / (depth + amount), 1)} of in-range liquidity` : "all of it"],
    ["Range", ranges[plan.range]],
    ...(plan.range === "full" ? [] : ([["Note", "Earns fees only while the price stays inside the range"]] as Row[])),
  ];
}

function lendRows(plan: Plan, amount: number, markets?: Markets): Row[] {
  const vault = markets?.vaults.find((v) => v.address === plan.vault) ?? markets?.vaults[0];
  if (!vault) return [];
  return [
    ["Vault", `${vault.name} on ${vault.protocol === "MORPHO" ? "Morpho" : vault.protocol}`],
    ["APY", percent(vault.apy)],
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
  if (!(leverage > 1 && leverage <= MAX_LEVERAGE)) return [["Leverage", `Pick between 1.1x and ${MAX_LEVERAGE}x`]];

  const ltv = (leverage - 1) / leverage;
  const liquidation = (btc * ltv) / market.lltv;
  return [
    ["Market", `Morpho cirBTC/USDC, LLTV ${percent(market.lltv, 0)}`],
    ["BTC price", usd(btc)],
    ["Exposure", `${usd(valueUsd * leverage)} of BTC for ${usd(valueUsd)}`],
    ["Borrows", `about ${(valueUsd * (leverage - 1)).toFixed(2)} USDC at ${percent(market.borrowApy, 3)}`],
    ["Loan to value", percent(ltv, 0)],
    ["Liquidated if BTC falls to", `about ${usd(liquidation)} (${percent(1 - liquidation / btc, 0)} below now)`],
    ["Borrow liquidity", usd(market.liquidity)],
  ];
}
