const IRIS = "https://iris-api-sandbox.circle.com";
const ARC_DOMAIN = 26;

/// CCTP fee from a source domain to Arc, in basis points, for fast and standard transfers.
export async function GET(request: Request) {
  const from = Number(new URL(request.url).searchParams.get("from") ?? 6);
  if (!Number.isInteger(from) || from < 0) return Response.json({ error: "bad domain" }, { status: 400 });

  const response = await fetch(`${IRIS}/v2/burn/USDC/fees/${from}/${ARC_DOMAIN}`, { next: { revalidate: 60 } });
  if (!response.ok) return Response.json({ error: "iris" }, { status: 502 });

  const fees: { finalityThreshold: number; minimumFee: number }[] = await response.json();
  const bps = (threshold: number) => fees.find((fee) => fee.finalityThreshold === threshold)?.minimumFee ?? 0;
  return Response.json({ fast: bps(1000), standard: bps(2000) });
}
