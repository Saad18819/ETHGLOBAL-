import { arc } from "@/lib/contracts";
import { tokenBySymbol } from "@/lib/tokens";

/// A placeholder wallet for the quote: Circle's quote API needs addresses, and the route does not depend on
/// whose they are.
const QUOTER = "0x000000000000000000000000000000000000dEaD";

/// Whether Circle Swap can swap `amount` (whole tokens) of `from` into `to` on Arc right now. Its testnet
/// liquidity is shallow and runs dry at times, and a move should not bridge funds it then can not swap.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = tokenBySymbol[params.get("from") ?? ""];
  const to = tokenBySymbol[params.get("to") ?? ""];
  if (!from?.arc || !to?.arc) return Response.json({ error: "unknown token" }, { status: 400 });

  const whole = Number(params.get("amount"));
  if (!(whole > 0)) return Response.json({ error: "amount must be positive" }, { status: 400 });
  const amount = BigInt(Math.floor(whole * 10 ** from.decimals)).toString();
  const query = new URLSearchParams({
    tokenInAddress: from.arc,
    tokenInChain: arc.kitChain,
    tokenOutAddress: to.arc,
    tokenOutChain: arc.kitChain,
    fromAddress: QUOTER,
    toAddress: QUOTER,
    amount,
    slippageBps: "100",
  });
  const response = await fetch(`https://api.circle.com/v1/stablecoinKits/quote?${query}`, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as { quote?: unknown; message?: string };
  return Response.json({ available: Boolean(body.quote), reason: body.quote ? undefined : body.message });
}
