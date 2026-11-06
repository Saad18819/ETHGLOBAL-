import { encodeAbiParameters, encodePacked, maxUint256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { baseSepolia, sepolia, unichainSepolia } from "wagmi/chains";

import type { SourceId } from "./chains";
import { config, type ChainId } from "./config";
import { erc20Abi } from "./contracts";

/// The testnet source swap. The Trading API quotes mainnet liquidity, so on testnets the app calls the v4
/// Quoter and UniversalRouter 2.1.2 itself. Addresses from docs.uniswap.org/contracts/v4/deployments; these
/// are the testnets with native ETH/USDC pools that quote (Arbitrum Sepolia has none).
type Deployment = { chainId: ChainId; quoter: Address; universalRouter: Address; usdc: Address; weth?: Address };

export const testnetSwaps: Partial<Record<SourceId, Deployment>> = {
  ethereum: {
    chainId: sepolia.id,
    quoter: "0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244",
    universalRouter: "0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  },
  base: {
    chainId: baseSepolia.id,
    quoter: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",
    universalRouter: "0x8702463e73f74d0b6765aBceb314Ef07aCb92650",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  unichain: {
    chainId: unichainSepolia.id,
    quoter: "0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472",
    universalRouter: "0xDf38F24fE153761634Be942F9d859f3DBA857E95",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
  },
};

const deploymentOf = (from: SourceId) => {
  const deployment = testnetSwaps[from];
  if (!deployment) throw new Error(`No Uniswap testnet deployment on ${from}`);
  return deployment;
};

/// Token/USDC pools without hooks, one per fee tier.
const TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;

const keyType = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const quoterAbi = parseAbi([
  // Not a view in Solidity, but safe to eth_call: the quote is computed and returned without a wallet.
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) view returns (uint256 amountOut, uint256 gasEstimate)",
]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const wethAbi = parseAbi(["function withdraw(uint256 amount)"]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/// What goes into the pool: native ETH (the zero address) or an ERC20.
export type TokenIn = { address: Address; decimals: number };

export type TestnetQuote = {
  amountOut: bigint;
  fee: number;
  tickSpacing: number;
  /// Price this pool implies, in USD, and how far it is from the market. Testnet pools drift a lot.
  impliedPrice: number;
  deviation?: number;
};

/// v4 orders a pool's currencies by address; native ETH is the zero address, so it is always currency0.
const poolKey = (tokenIn: Address, usdc: Address, tier: { fee: number; tickSpacing: number }) => {
  const inFirst = tokenIn.toLowerCase() < usdc.toLowerCase();
  return {
    key: {
      currency0: inFirst ? tokenIn : usdc,
      currency1: inFirst ? usdc : tokenIn,
      fee: tier.fee,
      tickSpacing: tier.tickSpacing,
      hooks: zeroAddress,
    },
    zeroForOne: inFirst,
  };
};

/// Best USDC out for `amountIn` across the token/USDC fee tiers. `marketPrice` is the token's USD price,
/// used to report how far the pool is from it.
export async function quoteTestnet(
  from: SourceId,
  tokenIn: TokenIn,
  amountIn: bigint,
  marketPrice?: number,
): Promise<TestnetQuote | undefined> {
  if (amountIn === 0n) return undefined;
  const chain = deploymentOf(from);
  const quotes = await Promise.all(
    TIERS.map(async (tier): Promise<TestnetQuote | undefined> => {
      try {
        const { key, zeroForOne } = poolKey(tokenIn.address, chain.usdc, tier);
        const result = await readContract(config, {
          chainId: chain.chainId,
          address: chain.quoter,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
        });
        const impliedPrice = Number(result[0]) / 1e6 / (Number(amountIn) / 10 ** tokenIn.decimals);
        return {
          amountOut: result[0],
          fee: tier.fee,
          tickSpacing: tier.tickSpacing,
          impliedPrice,
          deviation: marketPrice ? impliedPrice / marketPrice - 1 : undefined,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return quotes
    .filter((quote): quote is TestnetQuote => quote !== undefined)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
}

/// Swaps native ETH (unwrapping WETH first if needed) or an ERC20 into USDC through the UniversalRouter.
/// ERC20s are paid through Permit2. Returns the USDC received.
export async function swapTestnet(
  { from, account, tokenIn, amountIn, quote, slippage, fromWeth }: {
    from: SourceId;
    account: Address;
    tokenIn: TokenIn;
    amountIn: bigint;
    quote: TestnetQuote;
    slippage: number;
    fromWeth: boolean;
  },
  onStep: (label: string) => void,
): Promise<{ usdc: bigint; hash: Hex }> {
  const chain = deploymentOf(from);
  if (fromWeth) {
    if (!chain.weth) throw new Error("No WETH on this chain");
    onStep("Unwrapping WETH");
    const hash = await writeContract(config, {
      chainId: chain.chainId,
      address: chain.weth,
      abi: wethAbi,
      functionName: "withdraw",
      args: [amountIn],
    });
    await waitForTransactionReceipt(config, { chainId: chain.chainId, hash });
  }

  const native = tokenIn.address === zeroAddress;
  if (!native) {
    onStep("Approving the token for Uniswap");
    await approveThroughPermit2(chain, account, tokenIn.address, amountIn);
  }

  const minOut = (quote.amountOut * BigInt(Math.floor((1 - slippage) * 10_000))) / 10_000n;
  const { key, zeroForOne } = poolKey(tokenIn.address, chain.usdc, quote);

  // V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL and TAKE_ALL (v4-periphery Actions). minHopPriceX36 is 0;
  // TAKE_ALL enforces the minimum out.
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", ...keyType },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "minHopPriceX36", type: "uint256" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn.address, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [chain.usdc, minOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]);
  const v4Swap = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);

  const before = await usdcBalance(chain, account);
  onStep("Swapping on Uniswap");
  const hash = await writeContract(config, {
    chainId: chain.chainId,
    address: chain.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: ["0x10", [v4Swap], BigInt(Math.floor(Date.now() / 1000) + 600)],
    value: native ? amountIn : 0n,
  });
  await waitForTransactionReceipt(config, { chainId: chain.chainId, hash });
  return { usdc: (await usdcBalance(chain, account)) - before, hash };
}

/// The UniversalRouter pulls ERC20s through Permit2: the token approves Permit2 once, then Permit2 lets the
/// router take it.
async function approveThroughPermit2(chain: Deployment, account: Address, token: Address, amount: bigint) {
  const allowance = await readContract(config, {
    chainId: chain.chainId,
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, PERMIT2],
  });
  if (allowance < amount) {
    const hash = await writeContract(config, {
      chainId: chain.chainId,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, maxUint256],
    });
    await waitForTransactionReceipt(config, { chainId: chain.chainId, hash });
  }
  const [permitted, expiration] = await readContract(config, {
    chainId: chain.chainId,
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [account, token, chain.universalRouter],
  });
  if (permitted < amount || expiration < Date.now() / 1000 + 600) {
    const hash = await writeContract(config, {
      chainId: chain.chainId,
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      // The full amount for 30 days, as Uniswap's own app grants, so repeat swaps skip this step. Permit2
      // only lets the router pull in a transaction the wallet itself sends.
      args: [token, chain.universalRouter, 2n ** 160n - 1n, Math.floor(Date.now() / 1000) + 30 * 86_400],
    });
    await waitForTransactionReceipt(config, { chainId: chain.chainId, hash });
  }
}

async function usdcBalance(chain: Deployment, account: Address) {
  return readContract(config, {
    chainId: chain.chainId,
    address: chain.usdc,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [account],
  });
}
