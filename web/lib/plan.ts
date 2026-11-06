import { offArc, sourceIds, sources, type SourceId } from "./chains";
import { MAX_LEVERAGE } from "./loop";
import { destinationHolds, pools } from "./pairs";
import { arcSwappable, tokenBySymbol, tokens, type Token } from "./tokens";

export type { SourceId } from "./chains";

/// A token symbol from the registry in lib/tokens.ts.
export type AssetId = string;
export type NextId = "pay" | "hold" | "pool" | "lend" | "loop";
export { arcSwappable };
export type PayToken = string;
export type HoldToken = string;
export type Range = "full" | "20" | "5" | "1";
export type Speed = "fast" | "standard";

export type Plan = {
  amount: string;
  asset: AssetId;
  from: SourceId;
  next: NextId;
  recipient: string;
  payAmount: string;
  payToken: PayToken;
  hold: HoldToken;
  range: Range;
  /// Pool id from lib/pools.ts, such as "USDC/EURC".
  pool: string;
  vault: string;
  leverage: string;
  speed: Speed;
  slippage: string;
  /// Where the money ends up. Arc unless a payment or a hold goes elsewhere.
  to: SourceId;
};

export const defaultPlan: Plan = {
  amount: "10",
  asset: "USDC",
  from: "base",
  next: "pay",
  recipient: "",
  payAmount: "9",
  payToken: "EURC",
  hold: "USDC",
  range: "full",
  pool: "USDC/EURC",
  vault: "",
  leverage: "1.5",
  speed: "fast",
  slippage: "0.1",
  to: "arc",
};

const examples: Record<Token["kind"], string> = {
  stable: "10",
  eth: "0.005",
  btc: "0.0002",
  gold: "0.005",
  defi: "1",
  l2: "20",
};

/// Every registry token with the chains it can leave from, in the order the chain picker shows them.
export const assets: Record<AssetId, { decimals: number; sources: SourceId[]; example: string; token: Token }> =
  Object.fromEntries(
    tokens.map((token) => [
      token.symbol,
      {
        decimals: token.decimals,
        sources: sourceIds.filter((id) => token.sources[id]),
        example: examples[token.kind],
        token,
      },
    ]),
  );

/// Whether Circle bridges this asset from this chain to Arc as itself.
export const bridgesNatively = (asset: AssetId, from: SourceId) =>
  Boolean(tokenBySymbol[asset]?.bridge.includes(from));

/// Native ETH on a chain WETH bridges from can be wrapped and moved as WETH.
export const wrapsIntoWeth = (asset: AssetId, from: SourceId) => asset === "ETH" && bridgesNatively("WETH", from);

export const ranges: Record<Range, string> = {
  full: "full range",
  "20": "within 20% of the price",
  "5": "within 5%",
  "1": "within 1%",
};

/// Pay and hold can end on any chain; everything else happens on Arc.
export const anywhere = (next: NextId) => next === "pay" || next === "hold";

/// What a payment or a hold can be on a chain other than Arc: USDC, or EURC when EURC is what is moved and
/// Circle bridges it between the two chains. Circle Swap only runs on Arc, so nothing else is on offer.
export function offArcTokens(asset: AssetId, from: SourceId, to: SourceId): string[] {
  const eurc = asset === "EURC" && bridgesNatively("EURC", from) && bridgesNatively("EURC", to);
  return eurc ? ["USDC", "EURC"] : ["USDC"];
}

/// What can be paid in: on Arc anything Circle Swap fills (the settlement contract pays USDC or EURC),
/// elsewhere what arrives there as is.
export function payOptions(plan: Pick<Plan, "asset" | "from" | "to">, viaContracts: boolean): PayToken[] {
  if (plan.to !== "arc") return offArcTokens(plan.asset, plan.from, plan.to);
  return viaContracts ? ["USDC", "EURC"] : ["USDC", "EURC", "cirBTC"];
}

/// A hold elsewhere in a token that does not arrive as is: USDC arrives and Uniswap there swaps it.
export const swapsAtDestination = (plan: Pick<Plan, "asset" | "from" | "to" | "next" | "hold">) =>
  plan.to !== "arc" && plan.next === "hold" && !offArcTokens(plan.asset, plan.from, plan.to).includes(plan.hold);

/// Where a move can end: any chain but the one it starts on, and only Arc unless it pays or holds.
export function destinations(plan: Pick<Plan, "from" | "next">): SourceId[] {
  if (!anywhere(plan.next)) return ["arc"];
  return ["arc" as SourceId, ...offArc].filter((id) => id !== plan.from);
}

/// Where the swap happens follows the liquidity. An asset Circle bridges natively goes to Arc as itself when
/// it is held as is or when Arc can swap it; anything else is swapped into USDC on the source chain with
/// Uniswap first, where its liquidity is. Off Arc only USDC and sometimes EURC are on offer, so anything
/// else is swapped into USDC before it leaves.
export function viaUniswap(plan: Pick<Plan, "asset" | "from" | "next" | "hold" | "payToken" | "to">): boolean {
  if (plan.asset === "USDC") return false;
  if (plan.to !== "arc") {
    const wanted = plan.next === "pay" ? plan.payToken : plan.hold;
    return !(wanted === plan.asset && offArcTokens(plan.asset, plan.from, plan.to).includes(plan.asset));
  }
  if (wrapsIntoWeth(plan.asset, plan.from) && plan.next === "hold" && plan.hold === "WETH") return false;
  if (!bridgesNatively(plan.asset, plan.from)) return true;
  const holdsItself = plan.next === "hold" && plan.hold === plan.asset;
  return !(holdsItself || tokenBySymbol[plan.asset].arcSwap);
}

/// The asset that leaves the source chain.
export const bridgedAsset = (plan: Plan): AssetId =>
  viaUniswap(plan) ? "USDC" : wrapsIntoWeth(plan.asset, plan.from) ? "WETH" : plan.asset;

/// Router: USDC from a chain with our router, finished by the settlement contract as it arrives.
/// Wallet: bridged with Bridge Kit, finished from the user's wallet on Arc with Circle kits.
export type Route = "router" | "wallet";

const routerActions: NextId[] = ["pay", "hold", "pool", "lend"];
const walletActions: NextId[] = ["pay", "hold", "pool", "lend", "loop"];

export function routeOf(plan: Plan): Route | undefined {
  // Our contracts live on Arc; anything that ends elsewhere goes straight there with Bridge Kit.
  if (plan.to !== "arc") return anywhere(plan.next) ? "wallet" : undefined;
  const routerFits =
    bridgedAsset(plan) === "USDC" &&
    // Until the router is deployed on a chain, that chain uses the Bridge Kit route.
    Boolean(sources[plan.from].router?.address) &&
    routerActions.includes(plan.next) &&
    !(plan.next === "hold" && plan.hold !== "EURC" && plan.hold !== "USDC") &&
    !(plan.next === "pay" && plan.payToken !== "USDC" && plan.payToken !== "EURC") &&
    // The settlement contract provides only to the USDC/EURC pool it is configured with.
    !(plan.next === "pool" && plan.pool !== "USDC/EURC");
  if (routerFits) return "router";
  return walletActions.includes(plan.next) ? "wallet" : undefined;
}

export type NextStep = {
  id: NextId;
  title: string;
  body: string;
  verb: string;
};

export const nextSteps: NextStep[] = [
  {
    id: "pay",
    title: "Pay someone",
    body: "Send an exact amount to anyone, on Arc or any other chain.",
    verb: "pay",
  },
  {
    id: "hold",
    title: "Hold",
    body: "Keep it on Arc or any other chain, in the currency you choose.",
    verb: "hold",
  },
  {
    id: "pool",
    title: "Uniswap pool on Arc",
    body: "Earn a share of trading fees on Uniswap. Withdraw any time.",
    verb: "add liquidity to the",
  },
  {
    id: "lend",
    title: "Lend on Morpho",
    body: "Earn interest in a Morpho vault on Arc.",
    verb: "lend it on",
  },
  {
    id: "loop",
    title: "Leverage BTC",
    body: `Get up to ${MAX_LEVERAGE}x BTC exposure, using a loan on Morpho.`,
    verb: "leverage cirBTC to",
  },
];

export const stepOf = (id: NextId) => nextSteps.find((s) => s.id === id)!;

/// Keeps a plan valid after one field changes.
export function normalizePlan(plan: Plan): Plan {
  const asset = assets[plan.asset] ? plan.asset : "USDC";
  const sourcesOf = assets[asset].sources;
  let from = sourcesOf.includes(plan.from) ? plan.from : sourcesOf[0];
  // Starting on Arc only makes sense to pay or hold somewhere else.
  if (from === "arc" && !anywhere(plan.next)) from = sourcesOf.find((id) => id !== "arc") ?? from;
  const allowed = destinations({ from, next: plan.next });
  const to = allowed.includes(plan.to ?? "arc") ? (plan.to ?? "arc") : allowed[0];
  const hold = holdOptions(asset, from, to).includes(plan.hold) ? plan.hold : "USDC";
  const payToken = to !== "arc" && !offArcTokens(asset, from, to).includes(plan.payToken) ? "USDC" : plan.payToken;
  const pool = pools.some((p) => p.id === plan.pool) ? plan.pool : pools[0].id;
  return { ...plan, asset, from, to, hold, payToken, pool };
}

/// What the funds can be held as on Arc: whatever Circle Swap can swap into there, plus the moved asset
/// itself when Circle bridges it natively. Elsewhere, what arrives there as is.
export function holdOptions(asset: AssetId, from: SourceId, to: SourceId = "arc"): HoldToken[] {
  if (to !== "arc") return [...new Set([...offArcTokens(asset, from, to), ...destinationHolds(to)])];
  const own = bridgesNatively(asset, from) && !arcSwappable.includes(asset) ? [asset] : [];
  if (wrapsIntoWeth(asset, from) && !arcSwappable.includes("WETH")) own.push("WETH");
  return [...arcSwappable, ...own];
}
