"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Hex } from "viem";

import styles from "./Tracker.module.css";
import { config } from "@/lib/config";
import { arc, base, deployed, invoiceAbi, settlementAbi } from "@/lib/contracts";

type State = "done" | "active" | "waiting" | "failed";

const OPEN = 0;
const SETTLED = 1;

export function RouterTracker({
  orderKey,
  txHash,
  explorer,
  source,
  domain,
  outcome,
  invoiceId,
}: {
  orderKey: Hex;
  txHash: Hex;
  explorer: string;
  source: string;
  domain: number;
  outcome: string;
  invoiceId?: Hex;
}) {
  const order = useQuery({
    queryKey: ["order", orderKey],
    queryFn: () =>
      readContract(config, {
        chainId: arc.chainId,
        address: deployed.settlement!,
        abi: settlementAbi,
        functionName: "getOrder",
        args: [orderKey],
      }),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== OPEN ? false : 3000),
  });

  const funded = (order.data?.funded ?? 0n) > 0n;
  const relay = useQuery({
    queryKey: ["relay", txHash],
    queryFn: async () => {
      const response = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash, key: orderKey, domain }),
      });
      return (await response.json()) as { state?: string; hash?: Hex; error?: string };
    },
    enabled: !funded,
    refetchInterval: (query) => (["done", "no-relayer"].includes(query.state.data?.state ?? "") ? false : 5000),
  });

  // No relayer configured: once Circle attests the burn, the wallet delivers it into the settlement.
  const selfDeliver = relay.data?.state === "no-relayer" && !funded;
  const attestation = useQuery({
    queryKey: ["attestation", domain, txHash],
    enabled: selfDeliver,
    refetchInterval: (query) => (query.state.data?.state === "attested" ? false : 5000),
    queryFn: async () =>
      (await (await fetch(`/api/transfer?domain=${domain}&tx=${txHash}`)).json()) as {
        state: string;
        message?: Hex;
        attestation?: Hex;
      },
  });
  const [delivering, setDelivering] = useState(false);
  const [delivered, setDelivered] = useState<Hex>();
  const [deliverError, setDeliverError] = useState<string>();

  async function deliver() {
    const ready = attestation.data;
    if (!ready?.message || !ready.attestation) return;
    setDelivering(true);
    setDeliverError(undefined);
    try {
      await switchChain(config, { chainId: arc.chainId });
      const hash = await writeContract(config, {
        chainId: arc.chainId,
        address: deployed.settlement!,
        abi: settlementAbi,
        functionName: "receiveFunds",
        args: [ready.message, ready.attestation],
      });
      await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
      setDelivered(hash);
      await order.refetch();
    } catch (cause) {
      setDeliverError(cause instanceof Error ? cause.message.split("\n")[0] : "Delivery did not go through");
    } finally {
      setDelivering(false);
    }
  }

  const settled = order.data?.status === SETTLED;
  const failed = order.data !== undefined && order.data.status > SETTLED;

  const paid = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () =>
      readContract(config, {
        chainId: base.chainId,
        address: deployed.invoices!,
        abi: invoiceAbi,
        functionName: "isPaid",
        args: [invoiceId!],
      }),
    enabled: Boolean(invoiceId && deployed.invoices && settled),
    refetchInterval: (query) => (query.state.data ? false : 5000),
  });

  const intentArrived = Boolean(order.data?.hasIntent);
  const steps: { label: string; detail?: string; state: State; href?: string }[] = [
    {
      label: `Sent from ${source}`,
      detail: "USDC burned over CCTP, instruction sent over CCIP",
      state: "done",
      href: `${explorer}/tx/${txHash}`,
    },
    {
      label: "Instruction reached Arc",
      detail: "Delivered by Chainlink CCIP",
      state: intentArrived ? "done" : "active",
      href: `https://ccip.chain.link/tx/${txHash}`,
    },
    {
      label: "USDC arrived on Arc",
      detail:
        relay.data?.error ??
        (selfDeliver
          ? attestation.data?.state === "attested"
            ? "Attested by Circle, ready for your wallet to deliver"
            : "Waiting for Circle to attest the burn"
          : "Minted by Circle CCTP"),
      state: funded ? "done" : "active",
      href: (relay.data?.hash ?? delivered) ? `${arc.explorer}/tx/${relay.data?.hash ?? delivered}` : undefined,
    },
    {
      label: failed ? "Could not finish, refunded on Arc" : outcome,
      state: failed ? "failed" : settled ? "done" : intentArrived && funded ? "active" : "waiting",
      href: `${arc.explorer}/address/${deployed.settlement}`,
    },
  ];
  if (invoiceId) {
    steps.push({
      label: "Invoice unlocked on Base",
      detail: "Receipt sent back over CCIP",
      state: paid.data ? "done" : settled ? "active" : "waiting",
      href: `https://ccip.chain.link/address/${deployed.settlement}`,
    });
  }

  return (
    <>
      <Steps steps={steps} />
      {selfDeliver && attestation.data?.state === "attested" && !delivered && (
        <button className={styles.deliver} disabled={delivering} onClick={deliver}>
          {delivering ? "Delivering" : "Deliver on Arc"}
        </button>
      )}
      {deliverError && <p className={styles.error}>{deliverError}</p>}
    </>
  );
}

export function Steps({ steps }: { steps: { label: string; detail?: string; state: State; href?: string }[] }) {
  return (
    <ol className={styles.steps}>
      {steps.map((step) => (
        <li key={step.label} className={styles.step} data-state={step.state}>
          <span className={styles.marker} />
          <span className={styles.text}>
            {step.href ? (
              <a href={step.href} target="_blank" rel="noreferrer">
                {step.label}
              </a>
            ) : (
              step.label
            )}
            {step.detail && <span className={styles.detail}>{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
