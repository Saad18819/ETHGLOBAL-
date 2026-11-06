"use client";

import styles from "./Options.module.css";
import { Segmented } from "./Segmented";
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
      <Segmented
        label="Transfer speed"
        value={plan.speed}
        options={[
          { value: "fast", label: "Fast" },
          { value: "standard", label: "Standard, no fee" },
        ]}
        onChange={(speed) => set({ speed: speed as Plan["speed"] })}
      />
      {swaps && (
        <Segmented
          label="Max slippage"
          value={plan.slippage}
          options={["0.1", "0.3", "0.5"].map((value) => ({ value, label: `${value}%` }))}
          onChange={(slippage) => set({ slippage })}
          custom={{ min: 0.01, max: 20, suffix: "%" }}
        />
      )}
      {forwards && (
        <label className={styles.field}>
          <span className={styles.caption}>Send result to</span>
          <input
            className={styles.input}
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
