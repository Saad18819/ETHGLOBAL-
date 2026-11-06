import { NextResponse } from "next/server";

/// Server side proxy for the Uniswap Trading API, so the key stays on the server and the browser avoids CORS.
const API = "https://trade-api.gateway.uniswap.org/v1";
const actions = new Set(["check_approval", "quote", "swap"]);

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!actions.has(action)) return NextResponse.json({ detail: "unknown action" }, { status: 404 });
  const key = process.env.UNISWAP_API_KEY;
  if (!key) return NextResponse.json({ detail: "UNISWAP_API_KEY is not set" }, { status: 503 });

  const response = await fetch(`${API}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "x-universal-router-version": "2.0",
      // Every swap is reviewed and signed by the user in their wallet.
      "x-agent-info": JSON.stringify({ integration_name: "swap-integration", decision_origin: "human_mediated", version: "1.6.0" }),
    },
    body: await request.text(),
  });
  return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
}
