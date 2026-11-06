"use client";

import { Field, Fixed, Select } from "./Pill";
import styles from "./Sentence.module.css";
import { sources } from "@/lib/chains";
import { liquidationDrop, MAX_LEVERAGE } from "@/lib/loop";
import { percent, type Vault } from "@/lib/markets";
import {
  assets,
  nextSteps,
  normalizePlan,
  ranges,
  routeOf,
  stepOf,
  type AssetId,
  type HoldToken,
  type NextId,
  type Plan,
  type Range,
  type SourceId,
} from "@/lib/plan";

export function Sentence({
  plan,
  onChange,
  vaults = [],
  lltv,
  locked = false,
}: {
  plan: Plan;
  onChange: (plan: Plan) => void;
  vaults?: Vault[];
  lltv?: number;
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
        options={assets[plan.asset].sources.map((id) => ({
          value: id,
          label: sources[id].label,
          hint: sources[id].router ? "CCIP" : undefined,
        }))}
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
          options={nextSteps.map((step) => ({
            value: step.id,
            label: step.verb.replace(/ (as|on|to)$/, ""),
            hint: step.blocked(plan),
            disabled: Boolean(step.blocked(plan)),
          }))}
          onChange={(next) => set({ next })}
        >
          {stepOf(plan.next).verb}
        </Select>
      )}
      {plan.next === "hold" && (
        <>
          {" "}
          <Select<HoldToken>
            label="Hold as"
            tone="green"
            value={plan.hold}
            options={(["EURC", "cirBTC"] as const)
              .filter((token) => token !== plan.asset)
              .map((token) => ({ value: token, label: token }))}
            onChange={(hold) => set({ hold })}
          />
        </>
      )}
      {plan.next === "pool" && (
        <>
          {" "}
          <Select<Range>
            label="Range"
            tone="sand"
            value={plan.range}
            options={(Object.keys(ranges) as Range[]).map((range) => ({ value: range, label: ranges[range] }))}
            onChange={(range) => set({ range })}
          />
        </>
      )}
      {plan.next === "lend" && vaults.length > 0 && (
        <>
          {" "}
          <Select<string>
            label="Vault"
            tone="sand"
            value={plan.vault || vaults[0].address}
            options={vaults.map((vault) => ({
              value: vault.address,
              label: vault.name,
              hint: `${percent(vault.apy)} APY`,
            }))}
            onChange={(vault) => set({ vault })}
          >
            Morpho at {percent((vaults.find((v) => v.address === plan.vault) ?? vaults[0]).apy)}
          </Select>
        </>
      )}
      {plan.next === "loop" && (
        <>
          {" "}
          <Field
            label="Leverage"
            numeric
            value={plan.leverage}
            onChange={(leverage) => set({ leverage })}
            {...leverageHint(Number(plan.leverage), lltv)}
          />
          x
        </>
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

function leverageHint(leverage: number, lltv?: number): { hint?: string; warn?: boolean } {
  if (!(leverage > 1 && leverage <= MAX_LEVERAGE)) return { hint: `1.1x to ${MAX_LEVERAGE}x`, warn: true };
  if (!lltv) return {};
  const drop = liquidationDrop(leverage, lltv);
  return { hint: `liquidated at ${Math.round(drop * 100)}% down`, warn: drop < 0.25 };
}

function short(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
