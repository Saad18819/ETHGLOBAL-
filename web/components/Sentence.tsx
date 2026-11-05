"use client";

import { Field, Fixed, Select } from "./Pill";
import styles from "./Sentence.module.css";
import {
  assets,
  nextSteps,
  routeOf,
  sources,
  stepOf,
  type AssetId,
  type NextId,
  type Plan,
  type SourceId,
} from "@/lib/plan";

/// Keeps a plan valid after one field changes.
export function normalizePlan(plan: Plan): Plan {
  const from = assets[plan.asset].sources.includes(plan.from) ? plan.from : assets[plan.asset].sources[0];
  const step = stepOf(plan.next);
  const next = step.fits(plan) && !step.unavailable ? plan.next : "pay";
  const payToken = routeOf(plan) === "router" ? plan.payToken : "USDC";
  return { ...plan, from, next, payToken };
}

export function Sentence({
  plan,
  onChange,
  locked = false,
}: {
  plan: Plan;
  onChange: (plan: Plan) => void;
  locked?: boolean;
}) {
  const set = (patch: Partial<Plan>) => onChange(normalizePlan({ ...plan, ...patch }));
  const viaRouter = routeOf(plan) === "router";

  return (
    <div className={styles.sentence}>
      Move <Field label="Amount" numeric value={plan.amount} onChange={(amount) => set({ amount })} />{" "}
      <Select<AssetId>
        label="Asset"
        value={plan.asset}
        options={(Object.keys(assets) as AssetId[]).map((id) => ({ value: id, label: id }))}
        onChange={(asset) => set({ asset, amount: assets[asset].example, payAmount: assets[asset].example })}
      />{" "}
      from{" "}
      <Select<SourceId>
        label="From"
        value={plan.from}
        options={assets[plan.asset].sources.map((id) => ({ value: id, label: sources[id].label }))}
        onChange={(from) => set({ from })}
      />{" "}
      to Arc, <span className={styles.andthen}>and then</span>{" "}
      {locked ? (
        <Fixed tone="green">{stepOf(plan.next).verb}</Fixed>
      ) : (
        <Select<NextId>
          label="And then"
          tone="green"
          value={plan.next}
          options={nextSteps
            .filter((step) => step.fits(plan))
            .map((step) => ({
              value: step.id,
              label: step.verb,
              hint: step.unavailable,
              disabled: Boolean(step.unavailable),
            }))}
          onChange={(next) => set({ next })}
        />
      )}
      {plan.next === "pay" && (
        <>
          {" "}
          {locked ? (
            <Fixed tone="sand">{short(plan.recipient)}</Fixed>
          ) : (
            <Field
              label="Recipient"
              tone="sand"
              placeholder="name.eth"
              value={plan.recipient}
              onChange={(recipient) => set({ recipient })}
            />
          )}{" "}
          {locked ? (
            <Fixed tone="green">
              {plan.payAmount} {plan.payToken}
            </Fixed>
          ) : (
            <>
              <Field label="Pay amount" numeric value={plan.payAmount} onChange={(payAmount) => set({ payAmount })} />{" "}
              {viaRouter ? (
                <Select
                  label="Pay in"
                  tone="green"
                  value={plan.payToken}
                  options={[
                    { value: "USDC", label: "USDC" },
                    { value: "EURC", label: "EURC" },
                  ]}
                  onChange={(payToken) => set({ payToken })}
                />
              ) : (
                <Fixed tone="green">{plan.asset}</Fixed>
              )}
            </>
          )}
        </>
      )}
      .
    </div>
  );
}

function short(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
