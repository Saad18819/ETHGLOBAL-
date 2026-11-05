import { useQuery } from "@tanstack/react-query";
import { encodeAbiParameters, keccak256, parseAbi, zeroAddress } from "viem";
import { readContract } from "wagmi/actions";

import { config } from "./config";
import { arc } from "./contracts";

const stateView = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160, int24, uint24, uint24)"]);

/// The USDC/EURC pool the settlement contract swaps through: 0.05% fee, tick spacing 10, no hooks.
export const eurcPool = { fee: 500, tickSpacing: 10 } as const;

const poolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [arc.usdc, arc.eurc, eurcPool.fee, eurcPool.tickSpacing, zeroAddress],
  ),
);

/// EURC per USDC from the pool's spot price. Both tokens have 6 decimals.
export function useEurcRate() {
  return useQuery({
    queryKey: ["eurc-rate"],
    queryFn: async () => {
      const [sqrtPriceX96] = await readContract(config, {
        chainId: arc.chainId,
        address: stateView,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
      });
      const ratio = Number(sqrtPriceX96) / 2 ** 96;
      return ratio * ratio;
    },
    refetchInterval: 30_000,
  });
}
