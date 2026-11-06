import type { Address } from "viem";

import type { SourceId } from "./chains";
import { isTestnet } from "./network";

/// Mainnet tokens the app can move. Generated from three official sources:
/// tokens.uniswap.org (addresses and decimals on each source chain), Circle's CCTP token list
/// (iris-api.circle.com/v2/cctpx/tokens: which assets bridge natively to Arc, and their Arc address)
/// and Circle Swap's rates on Arc (which of those can be swapped once they are there).
export type TokenKind = "stable" | "eth" | "btc" | "gold" | "defi" | "l2";

export type Token = {
  symbol: string;
  name: string;
  kind: TokenKind;
  decimals: number;
  /// Address on each source chain, or "native" for the gas token.
  sources: Partial<Record<SourceId, Address | "native">>;
  /// Address on Arc when Circle bridges the token there natively.
  arc?: Address;
  /// Whether Circle Swap can swap it on Arc.
  arcSwap: boolean;
  /// Source chains it bridges from natively (CCTP for USDC, CCTP for non-USDC otherwise).
  bridge: SourceId[];
};

export const mainnetTokens: Token[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    kind: "stable",
    decimals: 6,
    sources: {
      ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      unichain: "0x078D782b760474a361dDA0AF3839290b0EF57AD6"
    },
    arc: "0x3600000000000000000000000000000000000000",
    arcSwap: true,
    bridge: [
      "ethereum",
      "base",
      "arbitrum",
      "optimism",
      "polygon",
      "avalanche",
      "unichain"
    ]
  },
  {
    symbol: "EURC",
    name: "Euro Coin",
    kind: "stable",
    decimals: 6,
    sources: {
      ethereum: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
      base: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
      arbitrum: "0x863708032B5c328e11aBcbC0DF9D79C71Fc52a48",
      polygon: "0x8a037dbcA8134FFc72C362e394e35E0Cad618F85",
      avalanche: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD",
      unichain: "0x72f34BC403a005A9Be390762EAa46ED42813B0a8"
    },
    arc: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1",
    arcSwap: true,
    bridge: [
      "ethereum",
      "avalanche",
      "base"
    ]
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    kind: "stable",
    decimals: 6,
    sources: {
      ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      optimism: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      avalanche: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
      unichain: "0x588CE4F028D8e7B53B687865d6A67b3A54C75518"
    },
    arc: "0x431881d09f35eb46c1bd30909a040cdee08b53b1",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "DAI",
    name: "Dai",
    kind: "stable",
    decimals: 18,
    sources: {
      ethereum: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      base: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      arbitrum: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      optimism: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      polygon: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      unichain: "0x20CAb320A855b39F724131C69424240519573f81"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "PYUSD",
    name: "PayPal USD",
    kind: "stable",
    decimals: 6,
    sources: {
      ethereum: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
      arbitrum: "0x327006c8712FE0AbdbbD55B7999DB39b0967342E",
      unichain: "0x0D2f98904D88909072eA6e61105CBBf78e6207c5"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "ETH",
    name: "Ether",
    kind: "eth",
    decimals: 18,
    sources: {
      ethereum: "native",
      base: "native",
      arbitrum: "native",
      optimism: "native",
      unichain: "native"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    kind: "eth",
    decimals: 18,
    sources: {
      ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      base: "0x4200000000000000000000000000000000000006",
      arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      optimism: "0x4200000000000000000000000000000000000006",
      polygon: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      avalanche: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
      unichain: "0x4200000000000000000000000000000000000006"
    },
    arc: "0x128cc466b61f542da60c70e3aa11c10e19b84edb",
    arcSwap: true,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    kind: "btc",
    decimals: 8,
    sources: {
      ethereum: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      base: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      arbitrum: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      unichain: "0xb6A3E8e5715fd4c99EcEDaaAe121bDe4Ab6a1Ef1"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "WBTC",
    name: "Wrapped BTC",
    kind: "btc",
    decimals: 8,
    sources: {
      ethereum: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      arbitrum: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      optimism: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
      polygon: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
      avalanche: "0x50b7545627a5162F82A992c33b87aDc75187B218",
      unichain: "0x927B51f251480a681271180DA4de28D44EC4AfB8"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "cirBTC",
    name: "Circle Wrapped Bitcoin",
    kind: "btc",
    decimals: 8,
    sources: {
      ethereum: "0x72dfb2e44f59c5ad2bafe84314e5b99a7cd5075e"
    },
    arc: "0x171a4217b86a807a64eb94757db6849fb4bdbaa0",
    arcSwap: true,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "PAXG",
    name: "Paxos Gold",
    kind: "gold",
    decimals: 18,
    sources: {
      ethereum: "0x45804880De22913dAFE09f4980848ECE6EcbAf78"
    },
    arc: "0xa3e0fa586126ae154712faff3c3573e708e901cf",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "XAUt",
    name: "Tether Gold",
    kind: "gold",
    decimals: 6,
    sources: { ethereum: "0x68749665FF8D2d112Fa859AA293F07A622782F38" },
    arc: "0xb8777ad70c0116b21810bc938b1b28a130319e89",
    arcSwap: false,
    bridge: ["ethereum"],
  },
  {
    symbol: "AAVE",
    name: "Aave",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
      base: "0x63706e401c06ac8513145b7687A14804d17f814b",
      arbitrum: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
      optimism: "0x76FB31fb4af56892A25e32cFC43De717950c9278",
      polygon: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
      avalanche: "0x63a72806098Bd3D9520cC43356dD78afe5D386D9",
      unichain: "0x02a24C380dA560E4032Dc6671d8164cfbEEAAE1e"
    },
    arc: "0xb2dceeb933a87ba45875f5587c4455849771810d",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "LINK",
    name: "Chainlink",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      arbitrum: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
      optimism: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6",
      polygon: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
      avalanche: "0x5947BB275c521040051D82396192181b413227A3",
      unichain: "0x5a53B6D19D8EDCb7923F0D840EeBB3f09BBeEfB7"
    },
    arc: "0x6dbfc59e951034e858a152a0eb107f355084ed8a",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "UNI",
    name: "Uniswap",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      base: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83",
      arbitrum: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
      optimism: "0x6fd9d7AD17242c41f7131d257212c54A0e816691",
      polygon: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
      unichain: "0x8f187aA05619a017077f5308904739877ce9eA21"
    },
    arc: "0xdb88be9e557cd02efae5c84194dbab54fb38438c",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "LDO",
    name: "Lido DAO",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
      arbitrum: "0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60",
      optimism: "0xFdb794692724153d1488CcdBE0C56c252596735F",
      polygon: "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756",
      unichain: "0x68A6dbc7214a0F2b0d875963663F1613814E8829"
    },
    arc: "0x24be0c52927404685bb712e1f3856a47e583ca0b",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "ENA",
    name: "Ethena",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x57e114B691Db790C35207b2e685D4A43181e6061",
      arbitrum: "0xdf8F0c63D9335A0AbD89F9F752d293A98EA977d8",
      unichain: "0x9116E70d613860D349495d9Ef8e2AE1cA6cBD2dd"
    },
    arc: "0x039495ae4600721dde131e6bbd9caaeedc2f8b0b",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "ONDO",
    name: "Ondo",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3",
      arbitrum: "0xA2d52A05B8Bead5d824DF54Dd1AA63188B37A5E7",
      unichain: "0xaD0bae21db0b471dFfC6f8F9EEacFe9A85321557"
    },
    arc: "0x5a1dfb15d0e2edf47618702cee0dbb256fe5d058",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "PENDLE",
    name: "Pendle",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x808507121B80c02388fAd14726482e061B8da827",
      base: "0xA99F6e6785Da0F5d6fB42495Fe424BCE029Eeb3E",
      arbitrum: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",
      optimism: "0xBC7B1Ff1c6989f006a1185318eD4E7b5796e66E1",
      polygon: "0x1D47e931F82bb9F8D967F0Cc3288268449835806",
      avalanche: "0xfB98B335551a418cD0737375a2ea0ded62Ea213b"
    },
    arc: "0xa7a02ab57ff4f49f060da6da0faad1f28ea94d25",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "MORPHO",
    name: "Morpho",
    kind: "defi",
    decimals: 18,
    sources: {
      ethereum: "0x58D97B57BB95320F9a05dC918Aef65434969c2B2",
      base: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
      arbitrum: "0xE390C0B46bd723995BE02640E6F1e1c802F620AC"
    },
    arc: "0xccb689378588a247f186a0500830d1c8c4c4e52e",
    arcSwap: false,
    bridge: [
      "ethereum"
    ]
  },
  {
    symbol: "ARB",
    name: "Arbitrum",
    kind: "l2",
    decimals: 18,
    sources: {
      ethereum: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
      arbitrum: "0x912CE59144191C1204E64559FE8253a0e49E6548",
      unichain: "0x5cC70a9DF8E293aFFb14DFCa1e7F851418a4b40d"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "OP",
    name: "Optimism",
    kind: "l2",
    decimals: 18,
    sources: {
      optimism: "0x4200000000000000000000000000000000000042"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "POL",
    name: "Polygon",
    kind: "l2",
    decimals: 18,
    sources: {
      polygon: "native",
      ethereum: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6",
      arbitrum: "0x044d8e7F3A17751D521efEa8CCf9282268fE08CC",
      unichain: "0xF6A49aEdbD7861DeD0DA2BE1f21C6954E5682E95"
    },
    arcSwap: false,
    bridge: []
  },
  {
    symbol: "AVAX",
    name: "Avalanche",
    kind: "l2",
    decimals: 18,
    sources: {
      avalanche: "native"
    },
    arcSwap: false,
    bridge: []
  }
];

/// What runs end to end on testnet: Circle's testnet USDC and EURC everywhere they exist, ETH through Uniswap
/// on the testnets that have a pool for it, and WETH and cirBTC from Sepolia over CCTP for non-USDC.
/// Addresses from developers.circle.com/stablecoins and docs.arc.io.
const testnetTokens: Token[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    kind: "stable",
    decimals: 6,
    sources: {
      base: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      ethereum: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      polygon: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      arbitrum: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      optimism: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
      avalanche: "0x5425890298aed601595a70AB815c96711a31Bc65",
      unichain: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    },
    arc: "0x3600000000000000000000000000000000000000",
    arcSwap: true,
    bridge: ["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "unichain"],
  },
  {
    symbol: "EURC",
    name: "Euro Coin",
    kind: "stable",
    decimals: 6,
    sources: {
      base: "0x808456652fdb597867f38412077A9182bf77359F",
      ethereum: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4",
      avalanche: "0x5E44db7996c682E92a960b65AC713a54AD815c6B",
    },
    arc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    arcSwap: true,
    bridge: ["base", "ethereum", "avalanche"],
  },
  {
    symbol: "ETH",
    name: "Ether",
    kind: "eth",
    decimals: 18,
    // Testnets where Uniswap v4 has a native ETH/USDC pool that quotes (see lib/uniswapTestnet.ts).
    sources: { ethereum: "native", base: "native", unichain: "native" },
    arcSwap: false,
    bridge: [],
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    kind: "eth",
    decimals: 18,
    sources: { ethereum: "0xfFf9976782d46CC05630D1f6eBAB18b2324d6B14" },
    arc: "0x2c4047028a72803939b6fb674D01bC059B5C4961",
    // Circle Swap has no WETH route on Arc testnet.
    arcSwap: false,
    bridge: ["ethereum"],
  },
  {
    symbol: "cirBTC",
    name: "Circle Wrapped Bitcoin",
    kind: "btc",
    decimals: 8,
    sources: { ethereum: "0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3" },
    arc: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
    arcSwap: true,
    bridge: ["ethereum"],
  },
  // Sepolia tokens with a Uniswap v4 pool against Circle's USDC that quotes. LINK from docs.chain.link,
  // available from faucets.chain.link.
  {
    symbol: "LINK",
    name: "Chainlink",
    kind: "defi",
    decimals: 18,
    sources: { ethereum: "0x779877A7B0D9E8603169DdbD7836e478b4624789" },
    arcSwap: false,
    bridge: [],
  },
  {
    symbol: "UNI",
    name: "Uniswap",
    kind: "defi",
    decimals: 18,
    sources: { ethereum: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
    arcSwap: false,
    bridge: [],
  },
];

export const tokens = isTestnet ? testnetTokens : mainnetTokens;

export const tokenBySymbol = Object.fromEntries(tokens.map((token) => [token.symbol, token])) as Record<string, Token>;

/// Assets Circle Swap can swap into on Arc, so they can be paid or held whatever was moved.
export const arcSwappable = tokens.filter((token) => token.arcSwap).map((token) => token.symbol);
