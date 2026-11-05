"use client";

import { useState } from "react";
import { parseUnits, type Address, type Hex } from "viem";
import { useConnect, useConnection } from "wagmi";
import { injected } from "wagmi/connectors";

import styles from "./Composer.module.css";
import { NextPanel } from "./NextPanel";
import { Sentence, normalizePlan } from "./Sentence";
import { RouterTracker, Steps } from "./Tracker";
import { resolveRecipient, sendThroughRouter, sendWithBridgeKit, type BridgeKitResult } from "@/lib/flows";
import { routeOf, defaultPlan, type Plan } from "@/lib/plan";
import { useEurcRate } from "@/lib/quote";
import { arc } from "@/lib/contracts";

type Run =
  | { kind: "router"; id: Hex; txHash: Hex; outcome: string }
  | { kind: "bridgekit"; result: BridgeKitResult; outcome: string };

const SLIPPAGE = 0.98;

const outcomes: Record<Plan["next"], string> = {
  pay: "Paid {recipient}",
  eurc: "Swapped into EURC",
  keep: "In your wallet on Arc",
  pool: "Position minted in the USDC/EURC pool",
  lend: "Lending on Morpho",
  loop: "Looped",
};

export function Composer({
  initialPlan = defaultPlan,
  locked = false,
  invoiceId,
  replyTo,
}: {
  initialPlan?: Plan;
  locked?: boolean;
  invoiceId?: Hex;
  replyTo?: Address;
}) {
  const [plan, setPlan] = useState(initialPlan);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run>();

  const { address, isConnected } = useConnection();
  const connect = useConnect();
  const rate = useEurcRate();

  const viaRouter = routeOf(plan) === "router";
  const amount = Number(plan.amount) || 0;
  const payAmount = Number(plan.payAmount) || 0;
  const eurcOut = rate.data ? amount * rate.data : undefined;
  const usdcNeeded =
    plan.next === "pay" ? (plan.payToken === "EURC" && rate.data ? payAmount / rate.data / SLIPPAGE : payAmount) : 0;

  const notes: string[] = [];
  let blocker: string | undefined;
  if (viaRouter) {
    notes.push("USDC moves over Circle CCTP, the instruction over Chainlink CCIP");
    if (plan.next === "pay") {
      notes.push(`They get exactly ${plan.payAmount || 0} ${plan.payToken}, leftover comes back to you on Arc`);
      if (usdcNeeded > amount) blocker = `Move at least ${Math.ceil(usdcNeeded * 100) / 100} USDC`;
    }
    if (plan.next === "eurc" && eurcOut) notes.push(`About ${eurcOut.toFixed(2)} EURC at the Uniswap pool price`);
    if (plan.next === "pool") notes.push("Full-range position in the USDC/EURC v4 pool, minted to you as an NFT");
    if (plan.next === "lend") notes.push("Deposited into a Morpho USDC vault on Arc, the shares go to you");
    if (invoiceId) notes.push("A receipt goes back to Base and unlocks the invoice");
  } else {
    notes.push(`${plan.asset} is bridged natively with Circle Bridge Kit`);
    if (plan.next === "loop") {
      notes.push("Then Circle Borrow on Morpho: borrow USDC, buy cirBTC, add it as collateral");
      notes.push(`Loan to value after the loop is about ${Math.round(((Number(plan.leverage) - 1) / Number(plan.leverage)) * 100)}%, liquidation at 86%`);
    }
    if (plan.next === "pay") {
      notes.push("Then paid from your wallet on Arc, tagged with a memo");
      if (payAmount > amount) blocker = `You can pay at most ${plan.amount} ${plan.asset}`;
    }
  }
  if (!amount) blocker = "Enter an amount";
  if (plan.next === "pay" && !plan.recipient) blocker = "Who should get paid?";

  async function go() {
    if (!address) return;
    setBusy(true);
    setError(undefined);
    setRun(undefined);
    try {
      const recipient = plan.next === "pay" ? await resolveRecipient(plan.recipient) : address;
      const outcome = outcomes[plan.next].replace("{recipient}", plan.recipient);

      if (viaRouter) {
        const minOut =
          plan.next === "eurc" && eurcOut ? parseUnits((eurcOut * SLIPPAGE).toFixed(6), 6) : 0n;
        const result = await sendThroughRouter(
          { plan, account: address, recipient, minOut, invoiceId, replyTo },
          setStatus,
        );
        setRun({ kind: "router", ...result, outcome });
      } else {
        const result = await sendWithBridgeKit({ plan, account: address, recipient, invoiceId }, setStatus);
        setRun({ kind: "bridgekit", result, outcome });
      }
      setStatus(undefined);
    } catch (cause) {
      setStatus(undefined);
      setError(readable(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.layout}>
      <section className={styles.main}>
        <Sentence plan={plan} onChange={setPlan} locked={locked} />

        <ul className={styles.notes}>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>

        <div className={styles.actions}>
          {isConnected ? (
            <button className={styles.primary} disabled={busy || Boolean(blocker)} onClick={go}>
              {busy ? "Working" : "Move it"}
            </button>
          ) : (
            <button className={styles.primary} onClick={() => connect.mutate({ connector: injected() })}>
              Connect wallet
            </button>
          )}
          <span className={styles.status}>{status ?? (isConnected ? blocker : undefined)}</span>
        </div>
        {error && <p className={styles.error}>{error}</p>}

        {run?.kind === "router" && (
          <div className={styles.tracker}>
            <RouterTracker id={run.id} txHash={run.txHash} outcome={run.outcome} invoiceId={invoiceId} />
          </div>
        )}
        {run?.kind === "bridgekit" && (
          <div className={styles.tracker}>
            <Steps
              steps={[
                ...[...run.result.bridgeSteps, ...(run.result.loopSteps ?? [])].map((step) => ({
                  label: step.name,
                  state: "done" as const,
                  href: step.explorerUrl,
                })),
                ...(run.result.payHash
                  ? [{ label: run.outcome, state: "done" as const, href: `${arc.explorer}/tx/${run.result.payHash}` }]
                  : []),
              ]}
            />
          </div>
        )}
      </section>

      {!locked && <NextPanel plan={plan} onPick={(next) => setPlan(normalizePlan({ ...plan, next }))} />}
    </div>
  );
}

function readable(cause: unknown): string {
  if (cause && typeof cause === "object" && "shortMessage" in cause) return String(cause.shortMessage);
  if (cause instanceof Error) return cause.message.split("\n")[0];
  return "Something went wrong";
}
