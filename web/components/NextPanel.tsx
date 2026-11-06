"use client";

import styles from "./NextPanel.module.css";
import { feeApr, percent, usd, type Markets } from "@/lib/markets";
import { protocolOf, protocols, swatchStyle } from "@/lib/brand";
import { nextSteps, type NextId, type Plan } from "@/lib/plan";

/// One headline number per option, from Arc mainnet where there is real activity, so the choice is not made blind.
function headline(id: NextId, markets: Markets | undefined, poolDepth: number | undefined): string | undefined {
  if (!markets) return undefined;
  const main = markets.mainnet;
  switch (id) {
    case "lend": {
      const best = main.vaults[0];
      if (best) return `${percent(best.apy)} APY on mainnet, ${usd(best.liquidity)} deposited`;
      return `Up to ${percent(Math.max(...markets.vaults.map((vault) => vault.apy)))} APY`;
    }
    case "loop": {
      const market = main.markets.find((m) => m.pair === "cirBTC/USDC");
      if (market) return `Borrow at ${percent(market.borrowApy)} on mainnet, LLTV ${percent(market.lltv, 0)}`;
      return undefined;
    }
    case "pool": {
      const pool = main.pools.find((p) => p.pair === "USDC/EURC");
      if (pool) return `${percent(pool.apr)} fee APR on mainnet, ${usd(pool.volume24hUsd)} a day`;
      return poolDepth === undefined ? undefined : `${percent(feeApr(markets.pool.volume7d, 0.0005, poolDepth))} fee APR`;
    }
    case "hold":
      return `EURC ${usd(markets.prices.EURC)}, BTC ${usd(markets.prices.cirBTC)}`;
    default:
      return undefined;
  }
}

export function NextPanel({
  plan,
  onPick,
  markets,
  poolDepth,
}: {
  plan: Plan;
  onPick: (id: NextId) => void;
  markets?: Markets;
  poolDepth?: number;
}) {
  return (
    <aside className={styles.panel}>
      <h2 className={styles.title}>What&apos;s next</h2>
      <ul className={styles.list}>
        {nextSteps.map((step) => {
          const stat = headline(step.id, markets, poolDepth);
          const protocol = protocols[protocolOf[step.id]];
          return (
            <li key={step.id}>
              <button
                type="button"
                className={styles.card}
                data-active={plan.next === step.id}
                style={swatchStyle(protocol)}
                onClick={() => onPick(step.id)}
              >
                <span className={styles.cardHead}>
                  <span className={styles.cardTitle}>{step.title}</span>
                  <span className={styles.tag}>{protocol.name}</span>
                </span>
                <span className={styles.cardBody}>{step.body}</span>
                {stat && <span className={styles.stat}>{stat}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
