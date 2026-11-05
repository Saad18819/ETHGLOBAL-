"use client";

import styles from "./NextPanel.module.css";
import { percent, usd, type Markets } from "@/lib/markets";
import { nextSteps, type NextId, type Plan } from "@/lib/plan";

/// One headline number per option, so the choice is not made blind.
function headline(id: NextId, markets: Markets | undefined, poolDepth: number | undefined): string | undefined {
  if (!markets) return undefined;
  switch (id) {
    case "lend": {
      const best = Math.max(...markets.vaults.map((vault) => vault.apy));
      return Number.isFinite(best) ? `Up to ${percent(best)} APY` : undefined;
    }
    case "loop": {
      const market = markets.markets.find((m) => m.collateral === "cirBTC");
      return market && `Borrow at ${percent(market.borrowApy, 3)}, LLTV ${percent(market.lltv, 0)}`;
    }
    case "pool":
      return poolDepth === undefined ? undefined : `0.05% fee tier, ${usd(poolDepth)} in range`;
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
          const blocked = step.blocked(plan);
          const stat = headline(step.id, markets, poolDepth);
          return (
            <li key={step.id}>
              <button
                type="button"
                className={styles.card}
                data-active={plan.next === step.id}
                disabled={Boolean(blocked)}
                onClick={() => onPick(step.id)}
              >
                <span className={styles.cardHead}>
                  <span className={styles.cardTitle}>{step.title}</span>
                  {stat && !blocked && <span className={styles.stat}>{stat}</span>}
                </span>
                <span className={styles.cardBody}>{step.body}</span>
                {blocked && <span className={styles.note}>{blocked}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
