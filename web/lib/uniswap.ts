import { encodeAbiParameters, encodePacked, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { sepolia } from "wagmi/chains";

import { config } from "./config";

/// Uniswap v4 on Ethereum Sepolia: docs.uniswap.org/contracts/v4/deployments
const SEPOLIA = {
  chainId: sepolia.id,
  quoter: "0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244",
  universalRouter: "0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  weth: "0xfFf9976782d46CC05630D1f6eBAB18b2324d6B14",
} as const;

/// Native ETH/USDC pools without hooks, one per fee tier. ETH is currency0.
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

export type EthQuote = {
  amountOut: bigint;
  fee: number;
  tickSpacing: number;
  /// ETH price this pool implies, in USD, and how far it is from the market. Testnet pools drift a lot.
  impliedPrice: number;
  deviation?: number;
};

const poolKey = (tier: { fee: number; tickSpacing: number }) => ({
  currency0: zeroAddress,
  currency1: SEPOLIA.usdc,
  fee: tier.fee,
  tickSpacing: tier.tickSpacing,
  hooks: zeroAddress,
});

/// Best USDC out for `amountIn` wei across the ETH/USDC fee tiers. `ethUsd` is the market price,
/// used to report how far the pool is from it.
export async function quoteEthToUsdc(amountIn: bigint, ethUsd?: number): Promise<EthQuote | undefined> {
  if (amountIn === 0n) return undefined;
  const quotes = await Promise.all(
    TIERS.map(async (tier): Promise<EthQuote | undefined> => {
      try {
        const result = await readContract(config, {
          chainId: SEPOLIA.chainId,
          address: SEPOLIA.quoter,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey: poolKey(tier), zeroForOne: true, exactAmount: amountIn, hookData: "0x" }],
        });
        const impliedPrice = Number(result[0]) / 1e6 / (Number(amountIn) / 1e18);
        return {
          amountOut: result[0],
          fee: tier.fee,
          tickSpacing: tier.tickSpacing,
          impliedPrice,
          deviation: ethUsd ? impliedPrice / ethUsd - 1 : undefined,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return quotes
    .filter((quote): quote is EthQuote => quote !== undefined)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
}

/// Swaps ETH (unwrapping WETH first if needed) into USDC on Sepolia through the UniversalRouter.
/// Returns the USDC received.
export async function swapEthToUsdc(
  { account, amountIn, quote, slippage, fromWeth }: {
    account: Address;
    amountIn: bigint;
    quote: EthQuote;
    slippage: number;
    fromWeth: boolean;
  },
  onStep: (label: string) => void,
): Promise<{ usdc: bigint; hash: Hex }> {
  if (fromWeth) {
    onStep("Unwrapping WETH");
    const hash = await writeContract(config, {
      chainId: SEPOLIA.chainId,
      address: SEPOLIA.weth,
      abi: wethAbi,
      functionName: "withdraw",
      args: [amountIn],
    });
    await waitForTransactionReceipt(config, { chainId: SEPOLIA.chainId, hash });
  }

  const minOut = (quote.amountOut * BigInt(Math.floor((1 - slippage) * 10_000))) / 10_000n;
  const key = poolKey(quote);

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
    [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [zeroAddress, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [SEPOLIA.usdc, minOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]);
  const v4Swap = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);

  const before = await usdcBalance(account);
  onStep("Swapping on Uniswap");
  const hash = await writeContract(config, {
    chainId: SEPOLIA.chainId,
    address: SEPOLIA.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: ["0x10", [v4Swap], BigInt(Math.floor(Date.now() / 1000) + 600)],
    value: amountIn,
  });
  await waitForTransactionReceipt(config, { chainId: SEPOLIA.chainId, hash });
  return { usdc: (await usdcBalance(account)) - before, hash };
}

async function usdcBalance(account: Address) {
  return readContract(config, {
    chainId: SEPOLIA.chainId,
    address: SEPOLIA.usdc,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [account],
  });
}

export const feeLabel = (fee: number) => `${fee / 10_000}%`;
