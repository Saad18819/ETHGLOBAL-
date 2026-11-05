"use client";

import styles from "./Options.module.css";
import { normalizePlan, type Plan } from "@/lib/plan";

/// Secondary settings that do not belong in the sentence.
export function Options({
  plan,
  onChange,
  swaps,
  forwards,
}: {
  plan: Plan;
  onChange: (plan: Plan) => void;
  swaps: boolean;
  forwards: boolean;
}) {
  const set = (patch: Partial<Plan>) => onChange(normalizePlan({ ...plan, ...patch }));

  return (
    <div className={styles.options}>
      <label className={styles.option}>
        <span>Transfer</span>
        <select value={plan.speed} onChange={(event) => set({ speed: event.target.value as Plan["speed"] })}>
          <option value="fast">Fast</option>
          <option value="standard">Standard, no CCTP fee</option>
        </select>
      </label>
      {swaps && (
        <label className={styles.option}>
          <span>Slippage</span>
          <select value={plan.slippage} onChange={(event) => set({ slippage: event.target.value })}>
            <option value="0.5">0.5%</option>
            <option value="1">1%</option>
            <option value="3">3%</option>
          </select>
        </label>
      )}
      {forwards && (
        <label className={styles.option}>
          <span>Send result to</span>
          <input
            value={plan.to}
            placeholder="my wallet"
            spellCheck={false}
            onChange={(event) => set({ to: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}
