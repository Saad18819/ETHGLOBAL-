"use client";

import styles from "./NextPanel.module.css";
import { nextSteps, type NextId, type Plan } from "@/lib/plan";

export function NextPanel({ plan, onPick }: { plan: Plan; onPick: (id: NextId) => void }) {
  return (
    <aside className={styles.panel}>
      <h2 className={styles.title}>What&apos;s next</h2>
      <ul className={styles.list}>
        {nextSteps.map((step) => {
          const fits = step.fits(plan);
          const usable = fits && !step.unavailable;
          return (
            <li key={step.id}>
              <button
                type="button"
                className={styles.card}
                data-active={plan.next === step.id}
                disabled={!usable}
                onClick={() => onPick(step.id)}
              >
                <span className={styles.cardTitle}>{step.title}</span>
                <span className={styles.cardBody}>{step.body}</span>
                {!usable && (
                  <span className={styles.note}>{step.unavailable ?? `Not for ${plan.asset}`}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
