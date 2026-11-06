import { useQuery } from "@tanstack/react-query";
import { parseAbi, type Address, type Hex } from "viem";
import {
  getBalance,
  getBlockNumber,
  readContract,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";

import { config } from "./config";
import { arc } from "./contracts";
import { isTestnet } from "./network";

/// CCTP v2 MessageTransmitter on Arc, from Circle's Bridge Kit chain definitions.
const MESSAGE_TRANSMITTER: Address = isTestnet
  ? "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"
  : "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const ARC_DOMAIN = 26;

const transmitterAbi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

export type Transfer = {
  state: "attested" | "pending" | "not found" | "unavailable";
  message?: Hex;
  attestation?: Hex;
  nonce?: Hex;
  destinationDomain?: number;
  openToAnyCaller?: boolean;
  mintRecipient?: Address;
  amount?: string;
  fee?: string;
  expirationBlock?: string;
};

export type TransferStatus = Transfer & { minted: boolean; toArc: boolean; blocksLeft?: bigint };

/// A burned transfer and whether it has been minted on Arc yet.
export function useTransfer(domain: number | undefined, tx: string) {
  return useQuery({
    queryKey: ["transfer", domain, tx],
    enabled: domain !== undefined && /^0x[0-9a-fA-F]{64}$/.test(tx),
    refetchInterval: (query) => (query.state.data?.minted ? false : 5000),
    queryFn: async (): Promise<TransferStatus> => {
      const response = await fetch(`/api/transfer?domain=${domain}&tx=${tx}`);
      const transfer = (await response.json()) as Transfer;
      const toArc = transfer.destinationDomain === ARC_DOMAIN;
      if (!toArc || !transfer.nonce) return { ...transfer, minted: false, toArc };
      const [used, block] = await Promise.all([
        readContract(config, {
          chainId: arc.chainId,
          address: MESSAGE_TRANSMITTER,
          abi: transmitterAbi,
          functionName: "usedNonces",
          args: [transfer.nonce],
        }),
        getBlockNumber(config, { chainId: arc.chainId }),
      ]);
      const blocksLeft = transfer.expirationBlock ? BigInt(transfer.expirationBlock) - block : undefined;
      return { ...transfer, minted: used > 0n, toArc, blocksLeft };
    },
  });
}

/// Native USDC the wallet has on Arc to pay gas with.
export const arcGas = (account: Address) => getBalance(config, { address: account, chainId: arc.chainId });

/// Delivers an attested message on Arc. Anyone may submit it when its destination caller is open; the
/// USDC still goes to the mint recipient in the message.
export async function mintOnArc(message: Hex, attestation: Hex): Promise<Hex> {
  await switchChain(config, { chainId: arc.chainId });
  const hash = await writeContract(config, {
    chainId: arc.chainId,
    address: MESSAGE_TRANSMITTER,
    abi: transmitterAbi,
    functionName: "receiveMessage",
    args: [message, attestation],
  });
  await waitForTransactionReceipt(config, { chainId: arc.chainId, hash });
  return hash;
}
