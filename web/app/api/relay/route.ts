import { createPublicClient, createWalletClient, http, isHex, parseGwei, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { ARC_RPC } from "@/lib/config";
import { base, deployed, settlementAbi } from "@/lib/contracts";

const IRIS = "https://iris-api-sandbox.circle.com";

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
const inFlight = new Map<Hex, Promise<Response>>();

/// Finishes the CCTP leg: waits for Circle's attestation of the burn on Base, then mints on Arc
/// through the settlement contract. Safe to call repeatedly; the client polls it.
export async function POST(request: Request) {
  const { txHash, id } = (await request.json()) as { txHash?: string; id?: string };
  if (!isHex(txHash) || !isHex(id)) return Response.json({ error: "txHash and id required" }, { status: 400 });
  if (!deployed.settlement || !process.env.RELAYER_PRIVATE_KEY) {
    return Response.json({ error: "relayer not configured" }, { status: 500 });
  }

  const running = inFlight.get(txHash);
  if (running) return (await running).clone();

  const task = relay(txHash, id);
  inFlight.set(txHash, task);
  try {
    return (await task).clone();
  } finally {
    inFlight.delete(txHash);
  }
}

async function relay(txHash: Hex, id: Hex): Promise<Response> {
  const settlement = deployed.settlement!;

  const order = await publicClient.readContract({
    address: settlement,
    abi: settlementAbi,
    functionName: "getOrder",
    args: [id],
  });
  if (order.funded > 0n) return Response.json({ state: "done" });

  const response = await fetch(`${IRIS}/v2/messages/${base.cctpDomain}?transactionHash=${txHash}`, {
    cache: "no-store",
  });
  if (response.status === 404) return Response.json({ state: "waiting" });
  if (!response.ok) return Response.json({ state: "waiting", detail: `iris ${response.status}` });

  const { messages } = (await response.json()) as {
    messages: { message: Hex; attestation: Hex; status: string }[];
  };
  const ready = messages?.find((m) => m.status === "complete");
  if (!ready) return Response.json({ state: "waiting" });

  const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_RPC) });
  // Arc's mempool rejects a maxFeePerGas under 20 gwei.
  const hash = await wallet.writeContract({
    address: settlement,
    abi: settlementAbi,
    functionName: "receiveFunds",
    args: [ready.message, ready.attestation],
    maxFeePerGas: parseGwei("40"),
    maxPriorityFeePerGas: parseGwei("1"),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return Response.json({ state: "done", hash });
}
