import { isAddress } from "viem";

import { arc } from "@/lib/contracts";

type Transfer = {
  timestamp: string;
  method?: string;
  transaction_hash: string;
  token?: { symbol?: string };
  total?: { value?: string; decimals?: string };
  from?: { hash?: string };
};

/// Tokens minted to a wallet on Arc by CCTP (receiveMessage), newest first, from the Arc explorer. These
/// are every bridge that reached the wallet, whichever app or relayer sent it.
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address") ?? "";
  if (!isAddress(address)) return Response.json({ error: "address required" }, { status: 400 });

  const response = await fetch(`${arc.explorer}/api/v2/addresses/${address}/token-transfers`, {
    next: { revalidate: 30 },
  });
  if (!response.ok) return Response.json({ arrivals: [] });
  const { items = [] } = (await response.json()) as { items?: Transfer[] };

  const arrivals = items
    .filter((item) => item.method === "receiveMessage" && /^0x0+$/.test(item.from?.hash ?? ""))
    .map((item) => ({
      at: Date.parse(item.timestamp),
      symbol: item.token?.symbol ?? "",
      amount: Number(item.total?.value ?? 0) / 10 ** Number(item.total?.decimals ?? 0),
      href: `${arc.explorer}/tx/${item.transaction_hash}`,
    }));
  return Response.json({ arrivals });
}
