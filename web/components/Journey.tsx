"use client";

import styles from "./Journey.module.css";
import { protocolOf, protocols, swatchStyle, type Swatch } from "@/lib/brand";
import { sources } from "@/lib/chains";
import { bridgedAsset, stepOf, viaUniswap, wrapsIntoWeth, type Plan } from "@/lib/plan";

export type Phase = "source" | "bridge" | "arc" | "action" | "done";

type Stage = { id: Phase; title: string; detail: string; swatch: Swatch };

const order: Phase[] = ["source", "bridge", "arc", "action", "done"];

/// The later of two phases, so progress never steps back.
export const later = (a: Phase, b: Phase) => (order.indexOf(b) > order.indexOf(a) ? b : a);

/// Which stage a status line from the flows belongs to.
export function phaseOf(status: string): Phase {
  if (/Circle Swap|Round \d/.test(status)) return /Round \d/.test(status) ? "action" : "arc";
  if (/Bridging|Retrying the mint|Approve USDC|Confirm in your wallet|Waiting for|Switching to/.test(status)) return "bridge";
  if (/Wrapping|Unwrapping|Uniswap|Permit2|Quoting|Approving the token/.test(status) && !/liquidity|pool tokens/.test(status)) {
    return "source";
  }
  return "action";
}

/// The route a move takes, one stage per hop, lit up as the flow reaches it.
export function Journey({ plan, phase, failed }: { plan: Plan; phase: Phase; failed?: boolean }) {
  const from = sources[plan.from].label;
  const moved = bridgedAsset(plan);
  const action = protocols[protocolOf[plan.next]];
  const dest = sources[plan.to].label;
  // Off Arc there is no swap at the destination: what is moved is what arrives.
  const arcSwap = plan.to === "arc" && {
    pay: plan.payToken !== moved,
    hold: plan.hold !== moved,
    lend: moved !== "USDC",
    pool: true,
    loop: true,
  }[plan.next];

  const stages: Stage[] = [
    viaUniswap(plan)
      ? { id: "source", title: `Uniswap on ${from}`, detail: `${plan.asset} to USDC`, swatch: protocols.uniswap }
      : wrapsIntoWeth(plan.asset, plan.from)
        ? { id: "source", title: from, detail: "ETH wrapped to WETH", swatch: protocols.arc }
        : { id: "source", title: from, detail: `${plan.amount} ${plan.asset}`, swatch: protocols.arc },
    { id: "bridge", title: "Circle CCTP", detail: `${moved} to ${dest}`, swatch: protocols.arc },
    ...(arcSwap ? [{ id: "arc" as const, title: "Arc", detail: "Circle Swap", swatch: protocols.arc }] : []),
    plan.to === "arc"
      ? { id: "action", title: action.name, detail: stepOf(plan.next).title, swatch: action }
      : { id: "action", title: dest, detail: plan.next === "pay" ? "Paid" : "In your wallet", swatch: action },
  ];
  const reached = order.indexOf(phase);

  return (
    <ol className={styles.journey} aria-label="Progress">
      {stages.map((stage, i) => {
        const at = order.indexOf(stage.id);
        const state = at < reached ? "done" : at === reached ? (failed ? "failed" : "active") : "waiting";
        return (
          <li key={stage.id} className={styles.stage} data-state={state} style={swatchStyle(stage.swatch)}>
            {i > 0 && (
              <span className={styles.track} aria-hidden>
                <span className={styles.dot} />
              </span>
            )}
            <span className={styles.node} aria-hidden>
              {state === "done" ? (
                <svg viewBox="0 0 16 16" className={styles.check}>
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </span>
            <span className={styles.title}>{stage.title}</span>
            <span className={styles.detail}>{stage.detail}</span>
          </li>
        );
      })}
    </ol>
  );
}
