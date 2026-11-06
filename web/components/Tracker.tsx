"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Hex } from "viem";

import styles from "./Tracker.module.css";
import type { Phase } from "./Journey";
import { config } from "@/lib/config";
import { arc, base, deployed, invoiceAbi, settlementAbi } from "@/lib/contracts";

const OPEN = 0;
const SETTLED = 1;

export function RouterTracker({
  orderKey,
  txHash,
  explorer,
  source,
  domain,
  invoiceId,
  onProgress,
}: {
  orderKey: Hex;
  txHash: Hex;
  explorer: string;
  source: string;
  domain: number;
  invoiceId?: Hex;
  onProgress: (phase: Phase, failed: boolean) => void;
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

  // Without a relayer the wallet delivers as soon as Circle attests, with no extra click.
  const ready = selfDeliver && attestation.data?.state === "attested";
  const tried = useRef(false);
  useEffect(() => {
    if (!ready || tried.current) return;
    tried.current = true;
    void deliver();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

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
  // Where the move is, for the progress row above: the bridge until both the USDC and the instruction are
  // on Arc, then the action, then the receipt back to the invoice.
  const phase: Phase = !(intentArrived && funded)
    ? "bridge"
    : !settled
      ? "action"
      : invoiceId && !paid.data
        ? "receipt"
        : "done";
  const report = useEffectEvent(onProgress);
  useEffect(() => report(phase, failed), [phase, failed]);

  // A failure already shows on the progress row and next to the button.
  const note = failed
    ? undefined
    : (relay.data?.error ??
      (delivering
        ? "Confirm the delivery on Arc in your wallet"
        : !intentArrived
          ? "Waiting for the instruction over Chainlink CCIP"
          : !funded
            ? "Waiting for Circle to attest the USDC"
            : phase === "receipt"
              ? "Paid on Arc, sending the receipt to Base over Chainlink CCIP"
              : undefined));

  return (
    <div className={styles.tracker}>
      {note && <p className={styles.note}>{note}</p>}
      <p className={styles.links}>
        <a href={`${explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
          {source} transaction
        </a>
        <a href={`https://ccip.chain.link/tx/${txHash}`} target="_blank" rel="noreferrer">
          CCIP message
        </a>
        {(relay.data?.hash ?? delivered) && (
          <a href={`${arc.explorer}/tx/${relay.data?.hash ?? delivered}`} target="_blank" rel="noreferrer">
            Arc delivery
          </a>
        )}
      </p>
      {/* Only shown when the automatic delivery did not go through, to try it again. */}
      {deliverError && !delivered && (
        <button className={styles.deliver} disabled={delivering} onClick={deliver}>
          {delivering ? "Delivering" : "Try delivering again"}
        </button>
      )}
      {deliverError && <p className={styles.error}>{deliverError}</p>}
    </div>
  );
}
