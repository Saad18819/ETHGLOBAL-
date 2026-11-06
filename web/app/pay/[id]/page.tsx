"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, isHex, type Hex } from "viem";
import { readContract } from "wagmi/actions";

import styles from "../pay.module.css";
import { InvoiceCard } from "../invoice-card";
import { Composer } from "@/components/Composer";
import { config } from "@/lib/config";
import { arc, base, deployed, invoiceAbi } from "@/lib/contracts";
import { defaultPlan } from "@/lib/plan";
import { useEurcRate } from "@/lib/quote";

export default function PayLink({ params }: PageProps<"/pay/[id]">) {
  const { id } = use(params);
  const rate = useEurcRate();

  const invoice = useQuery({
    queryKey: ["invoice-data", id],
    queryFn: () =>
      readContract(config, {
        chainId: base.chainId,
        address: deployed.invoices!,
        abi: invoiceAbi,
        functionName: "get",
        args: [id as Hex],
      }),
    enabled: isHex(id) && Boolean(deployed.invoices),
  });

  if (!invoice.data || !rate.data) return <main className={styles.page}>Loading invoice</main>;
  if (invoice.data.amount === 0n) return <main className={styles.page}>This pay link does not exist.</main>;

  const { payee, token, amount, memo, paidAt } = invoice.data;
  const payToken = token.toLowerCase() === arc.eurc.toLowerCase() ? "EURC" : "USDC";
  const owed = Number(formatUnits(amount, 6));
  // Enough USDC to cover the swap, CCTP fee and the receipt; the rest comes back on Arc.
  const suggested = (payToken === "EURC" ? owed / rate.data : owed) * 1.03 + 0.2;

  return (
    <main>
      <Composer
        locked
        invoiceId={id as Hex}
        replyTo={deployed.invoices}
        aside={
          <InvoiceCard
            id={id as Hex}
            memo={memo}
            amount={formatUnits(amount, 6)}
            token={payToken}
            payee={payee}
            paid={paidAt > 0n}
            book={deployed.invoices}
          />
        }
        initialPlan={{
          ...defaultPlan,
          amount: suggested.toFixed(2),
          asset: "USDC",
          from: "base",
          next: "pay",
          recipient: payee,
          payAmount: formatUnits(amount, 6),
          payToken,
        }}
      />
    </main>
  );
}
