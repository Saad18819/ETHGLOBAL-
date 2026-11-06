"use client";

import { Field, Fixed, Select } from "./Pill";
import styles from "./Sentence.module.css";
import { sources } from "@/lib/chains";
import { liquidationDrop, MAX_LEVERAGE } from "@/lib/loop";
import { holdingOf, short, spendable, type Holding } from "@/lib/balances";
import { pools } from "@/lib/pools";
import { protocolOf, protocols, tokenColor } from "@/lib/brand";
import { percent, usd, type Vault } from "@/lib/markets";
import {
  assets,
  bridgedAsset,
  holdOptions,
  nextSteps,
  normalizePlan,
  ranges,
  routeOf,
  stepOf,
  type AssetId,
  type HoldToken,
  type NextId,
  type PayToken,
  type Plan,
  type Range,
  type SourceId,
} from "@/lib/plan";

export function Sentence({
  plan,
  onChange,
  vaults = [],
  lltv,
  holdings,
  locked = false,
  poolAprs,
}: {
  plan: Plan;
  onChange: (plan: Plan) => void;
  vaults?: Vault[];
  lltv?: number;
  holdings?: Holding[];
  locked?: boolean;
  /// Fee APR of each pool by id, where there is real activity to measure it from.
  poolAprs?: Record<string, number>;
}) {
  const totalOf = (asset: AssetId) =>
    holdings?.filter((h) => h.asset === asset).reduce((sum, h) => sum + Number(h.amount), 0) ?? 0;
  const held = holdingOf(holdings, plan.asset, plan.from);
  const token = tokenColor(plan.asset);
  const brand = protocols[protocolOf[plan.next]];
  const set = (patch: Partial<Plan>) => onChange(normalizePlan({ ...plan, ...patch }));
  const viaRouter = routeOf(plan) === "router";

  return (
    <div className={styles.sentence}>
      Move{" "}
      <Field
        label="Amount"
        numeric
        value={plan.amount}
        onChange={(amount) => set({ amount })}
        hint={held ? `of ${short(held.amount)}` : undefined}
        presets={
          held
            ? [
                { label: "50%", value: spendable(plan.asset, plan.from, held.amount, 0.5) },
                { label: "max", value: spendable(plan.asset, plan.from, held.amount) },
              ]
            : undefined
        }
        swatch={token}
      />{" "}
      <Select<AssetId>
        label="Asset"
        swatch={token}
        value={plan.asset}
        options={(Object.keys(assets) as AssetId[]).map((id) => ({
          value: id,
          label: id,
          hint: totalOf(id) > 0 ? short(String(totalOf(id))) : undefined,
        }))}
        onChange={(asset) =>
          set({ asset, amount: assets[asset].example, payAmount: assets[asset].token.kind === "stable" ? "9" : "8" })
        }
      />{" "}
      from{" "}
      <Select<SourceId>
        label="From"
        tone="stone"
        value={plan.from}
        options={assets[plan.asset].sources.map((id) => {
          const holding = holdingOf(holdings, plan.asset, id);
          return { value: id, label: sources[id].label, hint: holding ? `${short(holding.amount)} ${plan.asset}` : undefined };
        })}
        onChange={(from) => set({ from })}
      />{" "}
      to Arc, <span className={styles.andthen}>and then</span>{" "}
      {locked ? (
        <Fixed swatch={brand}>{stepOf(plan.next).verb}</Fixed>
      ) : (
        <Select<NextId>
          label="And then"
          swatch={brand}
          value={plan.next}
          options={nextSteps.map((step) => ({ value: step.id, label: step.verb.replace(/ (as|on|to|to the)$/, "") }))}
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
            swatch={tokenColor(plan.hold)}
            value={plan.hold}
            options={holdOptions(plan.asset, plan.from).map((token) => ({
              value: token,
              label: token,
              hint: token === bridgedAsset(plan) ? "no swap" : undefined,
            }))}
            onChange={(hold) => set({ hold })}
          />
        </>
      )}
      {plan.next === "pool" && (
        <>
          {" "}
          <Select<string>
            label="Pool"
            swatch={brand}
            value={plan.pool}
            options={pools.map((pool) => ({
              value: pool.id,
              label: pool.id,
              hint:
                poolAprs?.[pool.id] !== undefined
                  ? `${percent(poolAprs[pool.id])} APR, ${pool.fee / 10_000}% fee`
                  : `not opened yet, ${pool.fee / 10_000}% fee`,
            }))}
            onChange={(pool) => set({ pool })}
          />{" "}
          {/* Only the pool is a choice; its rate is a fact about it, so it reads as plain text. */}
          pool
          {poolAprs?.[plan.pool] !== undefined ? ` at ${percent(poolAprs[plan.pool], 1)} APR` : ""},{" "}
          <Select<Range>
            label="Range"
            swatch={brand}
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
            swatch={brand}
            value={plan.vault || vaults[0].address}
            options={vaults.map((vault) => ({
              value: vault.address,
              label: vault.name,
              hint: `${percent(vault.apy)} APY, ${usd(vault.liquidity)} liquidity`,
            }))}
            onChange={(vault) => set({ vault })}
          >
            {(() => {
              const vault = vaults.find((v) => v.address === plan.vault) ?? vaults[0];
              return `${vault.name} at ${percent(vault.apy)}`;
            })()}
          </Select>
        </>
      )}
      {plan.next === "loop" && (
        <>
          {" "}
          <Select<string>
            label="Leverage"
            swatch={brand}
            value={plan.leverage}
            options={["1.5", "2", "2.5", "3", "3.5", "4"].map((value) => ({
              value,
              label: `${value}x`,
              hint: lltv ? `liquidated ${Math.round(liquidationDrop(Number(value), lltv) * 100)}% down` : undefined,
            }))}
            onChange={(leverage) => set({ leverage })}
            custom={{ min: 1.1, max: MAX_LEVERAGE, suffix: "x", placeholder: `1.1 to ${MAX_LEVERAGE}` }}
          >
            {plan.leverage}x
          </Select>
        </>
      )}
      {plan.next === "pay" && (
        <>
          {" "}
          {locked ? (
            <Fixed tone="sand">{shortAddress(plan.recipient)}</Fixed>
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
            <Fixed swatch={tokenColor(plan.payToken)}>
              {plan.payAmount} {plan.payToken}
            </Fixed>
          ) : (
            <>
              <Field
                label="Pay amount"
                numeric
                value={plan.payAmount}
                onChange={(payAmount) => set({ payAmount })}
                swatch={tokenColor(plan.payToken)}
              />{" "}
              <Select<PayToken>
                label="Pay in"
                swatch={tokenColor(plan.payToken)}
                value={plan.payToken}
                options={(viaRouter ? (["USDC", "EURC"] as const) : (["USDC", "EURC", "cirBTC"] as const)).map(
                  (token) => ({ value: token, label: token }),
                )}
                onChange={(payToken) => set({ payToken })}
              />
            </>
          )}
        </>
      )}
      .
    </div>
  );
}

function shortAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

