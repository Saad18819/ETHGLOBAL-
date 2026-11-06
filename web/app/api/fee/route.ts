import { IRIS } from "@/lib/network";

const ARC_DOMAIN = 26;

/// CCTP fee between two domains (Arc unless `to` says otherwise), in basis points, for fast and standard
/// transfers, plus the flat fee Circle's forwarder takes for minting at the destination, in USDC.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = Number(params.get("from") ?? 6);
  const to = Number(params.get("to") ?? ARC_DOMAIN);
  if (![from, to].every((domain) => Number.isInteger(domain) && domain >= 0) || from === to) {
    return Response.json({ error: "bad domain" }, { status: 400 });
  }

  const response = await fetch(`${IRIS}/v2/burn/USDC/fees/${from}/${to}?forward=true`, { next: { revalidate: 60 } });
  if (!response.ok) return Response.json({ error: "iris" }, { status: 502 });

  const fees: { finalityThreshold: number; minimumFee: number; forwardFee?: { high: number } }[] =
    await response.json();
  const bps = (threshold: number) => fees.find((fee) => fee.finalityThreshold === threshold)?.minimumFee ?? 0;
  // The high estimate, in USDC base units, so the amount moved always covers it.
  const forward = Math.max(...fees.map((fee) => fee.forwardFee?.high ?? 0)) / 1e6;
  return Response.json({ fast: bps(1000), standard: bps(2000), forward });
}
