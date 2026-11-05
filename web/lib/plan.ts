export type AssetId = "USDC" | "EURC" | "WETH" | "cirBTC";
export type SourceId = "base" | "ethereum";
export type NextId = "pay" | "eurc" | "keep" | "pool" | "usyc" | "lend" | "loop";
export type PayToken = "USDC" | "EURC";

export type Plan = {
  amount: string;
  asset: AssetId;
  from: SourceId;
  next: NextId;
  recipient: string;
  payAmount: string;
  payToken: PayToken;
};

export const defaultPlan: Plan = {
  amount: "10",
  asset: "USDC",
  from: "base",
  next: "pay",
  recipient: "",
  payAmount: "9",
  payToken: "EURC",
};

export const assets: Record<AssetId, { decimals: number; sources: SourceId[]; example: string }> = {
  USDC: { decimals: 6, sources: ["base"], example: "10" },
  EURC: { decimals: 6, sources: ["base", "ethereum"], example: "10" },
  WETH: { decimals: 18, sources: ["ethereum"], example: "0.01" },
  cirBTC: { decimals: 8, sources: ["ethereum"], example: "0.001" },
};

export const sources: Record<SourceId, { label: string; kitChain: string }> = {
  base: { label: "Base", kitChain: "Base_Sepolia" },
  ethereum: { label: "Ethereum", kitChain: "Ethereum_Sepolia" },
};

/// USDC goes through our router (CCTP for the money, CCIP for the instruction).
/// Everything else is bridged natively with Bridge Kit and finished from the wallet on Arc.
export function routeOf(plan: Pick<Plan, "asset">): "router" | "bridgekit" {
  return plan.asset === "USDC" ? "router" : "bridgekit";
}

export type NextStep = {
  id: NextId;
  title: string;
  body: string;
  verb: string;
  unavailable?: string;
  fits: (plan: Plan) => boolean;
};

export const nextSteps: NextStep[] = [
  {
    id: "pay",
    title: "Pay someone",
    body: "They get the exact amount on Arc, tagged with your invoice id.",
    verb: "pay",
    fits: () => true,
  },
  {
    id: "eurc",
    title: "Hold EURC",
    body: "Swap into euros through the Uniswap pool on Arc.",
    verb: "hold it as EURC",
    fits: (plan) => plan.asset === "USDC",
  },
  {
    id: "keep",
    title: "Keep it on Arc",
    body: "Land it in your wallet and decide later.",
    verb: "keep it",
    fits: () => true,
  },
  {
    id: "pool",
    title: "Uniswap pool on Arc",
    body: "Provide liquidity to the USDC and EURC pool.",
    verb: "add it to the USDC/EURC pool",
    unavailable: "Next up",
    fits: (plan) => plan.asset === "USDC" || plan.asset === "EURC",
  },
  {
    id: "usyc",
    title: "Earn in USYC",
    body: "Tokenized treasury yield, minted from USDC.",
    verb: "earn in USYC",
    unavailable: "Needs Circle allowlisting, 24 to 48 hours",
    fits: (plan) => plan.asset === "USDC",
  },
  {
    id: "lend",
    title: "Aave or Morpho",
    body: "Supply it and earn the lending rate.",
    verb: "lend it",
    unavailable: "Not on Arc testnet yet",
    fits: () => true,
  },
  {
    id: "loop",
    title: "Loop it",
    body: "Borrow against it and buy more, with a set leverage.",
    verb: "loop it",
    unavailable: "Not on Arc testnet yet",
    fits: (plan) => plan.asset === "cirBTC" || plan.asset === "WETH",
  },
];

export const stepOf = (id: NextId) => nextSteps.find((s) => s.id === id)!;
