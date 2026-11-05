import { base } from "@/lib/contracts";

const IRIS = "https://iris-api-sandbox.circle.com";
const ARC_DOMAIN = 26;
const FAST = 1000;

export async function GET() {
  const response = await fetch(`${IRIS}/v2/burn/USDC/fees/${base.cctpDomain}/${ARC_DOMAIN}`, {
    next: { revalidate: 60 },
  });
  if (!response.ok) return Response.json({ error: "iris" }, { status: 502 });

  const fees: { finalityThreshold: number; minimumFee: number }[] = await response.json();
  const fast = fees.find((fee) => fee.finalityThreshold === FAST);
  return Response.json({ bps: fast?.minimumFee ?? 0 });
}
