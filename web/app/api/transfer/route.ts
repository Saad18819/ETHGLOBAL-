import { isHex } from "viem";

import { IRIS } from "@/lib/network";

type IrisMessage = {
  message: string;
  attestation: string;
  status: string;
  eventNonce: string;
  decodedMessage?: {
    destinationDomain: string;
    destinationCaller: string;
    decodedMessageBody?: { mintRecipient: string; amount: string; feeExecuted: string; expirationBlock: string };
  };
};

/// A CCTP transfer as Circle's attestation service sees it: whether it is attested yet, and the message and
/// attestation that mint it on the destination chain.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const domain = Number(params.get("domain"));
  const tx = params.get("tx") ?? "";
  if (!Number.isInteger(domain) || domain < 0 || !isHex(tx) || tx.length !== 66) {
    return Response.json({ error: "domain and a transaction hash are required" }, { status: 400 });
  }

  const response = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${tx}`, { cache: "no-store" });
  if (response.status === 404) return Response.json({ state: "not found" });
  if (!response.ok) return Response.json({ state: "unavailable" }, { status: 502 });

  const { messages } = (await response.json()) as { messages?: IrisMessage[] };
  const found = messages?.[0];
  if (!found) return Response.json({ state: "not found" });
  const body = found.decodedMessage?.decodedMessageBody;
  return Response.json({
    state: found.status === "complete" ? "attested" : "pending",
    message: found.message,
    attestation: found.attestation,
    nonce: found.eventNonce,
    destinationDomain: Number(found.decodedMessage?.destinationDomain),
    openToAnyCaller: /^0x0+$/.test(found.decodedMessage?.destinationCaller ?? ""),
    mintRecipient: body?.mintRecipient,
    amount: body?.amount,
    fee: body?.feeExecuted,
    expirationBlock: body?.expirationBlock,
  });
}
