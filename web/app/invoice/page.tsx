"use client";

import { useState } from "react";
import Link from "next/link";
import { parseEventLogs, parseUnits, type Hex } from "viem";
import { useConnection } from "wagmi";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";

import styles from "./invoice.module.css";
import { Field, Select } from "@/components/Pill";
import { config } from "@/lib/config";
import { arc, base, deployed, invoiceAbi } from "@/lib/contracts";
import { resolveRecipient } from "@/lib/flows";

type Token = "USDC" | "EURC";

export default function RequestPayment() {
  const { address } = useConnection();
  const [amount, setAmount] = useState("25");
  const [token, setToken] = useState<Token>("EURC");
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [id, setId] = useState<Hex>();

  async function create() {
    if (!deployed.invoices) return setError("Invoice book address is not configured");
    setBusy(true);
    setError(undefined);
    try {
      const to = payee ? await resolveRecipient(payee) : address!;
      await switchChain(config, { chainId: base.chainId });
      const hash = await writeContract(config, {
        chainId: base.chainId,
        address: deployed.invoices,
        abi: invoiceAbi,
        functionName: "create",
        args: [to, token === "EURC" ? arc.eurc : arc.usdc, parseUnits(amount, 6), memo],
      });
      const receipt = await waitForTransactionReceipt(config, { chainId: base.chainId, hash });
      const [created] = parseEventLogs({ abi: invoiceAbi, eventName: "Created", logs: receipt.logs });
      setId(created.args.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.split("\n")[0] : "Could not create the invoice");
    } finally {
      setBusy(false);
    }
  }

  const link = id ? `/pay/${id}` : undefined;

  return (
    <main className={styles.page}>
      <div className={styles.sentence}>
        Request <Field label="Amount" numeric value={amount} onChange={setAmount} />{" "}
        <Select<Token>
          label="Token"
          tone="green"
          value={token}
          options={[
            { value: "EURC", label: "EURC" },
            { value: "USDC", label: "USDC" },
          ]}
          onChange={setToken}
        />{" "}
        on Arc, paid to{" "}
        <Field label="Payee" tone="sand" placeholder="my wallet" value={payee} onChange={setPayee} />, for{" "}
        <Field label="Memo" tone="violet" placeholder="order 42" value={memo} onChange={setMemo} />.
      </div>
      <p className={styles.hint}>
        The payer can use any supported token from Base. You get the exact amount on Arc, and the invoice on Base
        only unlocks when the receipt from Arc arrives over CCIP.
      </p>
      <div className={styles.actions}>
        <button className={styles.primary} disabled={busy || !address || !amount} onClick={create}>
          {busy ? "Creating" : "Create pay link"}
        </button>
        {!address && <span className={styles.muted}>Connect a wallet first</span>}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {link && (
        <p className={styles.link}>
          <Link href={link}>{typeof window === "undefined" ? link : `${window.location.origin}${link}`}</Link>
        </p>
      )}
    </main>
  );
}
