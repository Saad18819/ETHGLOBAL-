import { parseAbi, type Address } from "viem";
import { arc as arcMainnet, arcTestnet, base as baseMainnet, baseSepolia } from "wagmi/chains";

import type { ChainId } from "./config";
import { isTestnet } from "./network";

export const deployed = {
  settlement: process.env.NEXT_PUBLIC_SETTLEMENT as Address | undefined,
  // Invoices live on Base
  invoices: process.env.NEXT_PUBLIC_INVOICES as Address | undefined,
};

type ArcContracts = {
  chainId: ChainId;
  /// Chain identifier in Circle App Kit.
  kitChain: string;
  usdc: Address;
  eurc: Address;
  weth: Address;
  cirbtc: Address;
  memo: Address;
  /// Morpho USDC vault the settlement contract allowlists.
  morphoVault?: Address;
  /// Morpho cirBTC/USDC market listed by Circle Borrow.
  cirbtcMarket: Address;
  explorer: string;
};

/// Arc addresses from docs.arc.io/arc/references/contract-addresses.
const arcContracts: Record<"testnet" | "mainnet", ArcContracts> = {
  testnet: {
    chainId: arcTestnet.id,
    kitChain: "Arc_Testnet",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    weth: "0x2c4047028a72803939b6fb674D01bC059B5C4961",
    cirbtc: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
    memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    morphoVault: "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC",
    cirbtcMarket: "0xf8a71f6df9dc7725d1c2fd848e4635d1e9ddca11da4e2dc2f9801005bd2b5d58",
    explorer: "https://explorer.testnet.arc.io",
  },
  mainnet: {
    chainId: arcMainnet.id,
    kitChain: "Arc",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    weth: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB",
    cirbtc: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
    memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
    morphoVault: process.env.NEXT_PUBLIC_SETTLEMENT_VAULT as Address | undefined,
    cirbtcMarket: "0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d",
    explorer: "https://explorer.arc.io",
  },
};

export const arc = arcContracts[isTestnet ? "testnet" : "mainnet"];

export const base: { chainId: ChainId; cctpDomain: number; explorer: string } = isTestnet
  ? { chainId: baseSepolia.id, cctpDomain: 6, explorer: "https://sepolia.basescan.org" }
  : { chainId: baseMainnet.id, cctpDomain: 6, explorer: "https://basescan.org" };

const intent =
  "(bytes32 id, address payer, uint8 action, address recipient, address token, uint256 amount, uint256 limit, uint64 deadline, address refundTo, bytes32 invoiceId, address replyTo, bytes data)";

export const routerAbi = parseAbi([
  `function send(${intent} intent, uint256 amount, uint256 maxFee, uint32 cctpFinality) payable returns (bytes32)`,
  `function quote(${intent} intent) view returns (uint256)`,
  "event Sent(bytes32 indexed id, address indexed payer, bytes32 indexed invoiceId, uint256 usdcAmount, bytes32 ccipMessageId)",
]);

export const settlementAbi = parseAbi([
  `function getOrder(bytes32 key) view returns ((${intent} intent, bool hasIntent, bool receiptSent, uint8 status, uint64 sourceChain, uint64 fundedAt, uint256 funded, uint256 delivered))`,
  "function receiveFunds(bytes message, bytes attestation)",
  "event Settled(bytes32 indexed key, bytes32 indexed invoiceId, address payer, address indexed recipient, address token, uint256 amount)",
]);

export const invoiceAbi = parseAbi([
  "function create(address payee, address token, uint256 amount, string memo) returns (bytes32)",
  "function get(bytes32 id) view returns ((address merchant, address payee, address token, uint256 amount, bytes32 intentId, uint64 paidAt, string memo))",
  "function isPaid(bytes32 id) view returns (bool)",
  "event Created(bytes32 indexed id, address indexed merchant, address payee, address token, uint256 amount, string memo)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
]);
