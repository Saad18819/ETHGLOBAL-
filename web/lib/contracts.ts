import { parseAbi, type Address } from "viem";
import { arcTestnet, baseSepolia, sepolia } from "wagmi/chains";

export const deployed = {
  settlement: process.env.NEXT_PUBLIC_SETTLEMENT as Address | undefined,
  router: process.env.NEXT_PUBLIC_ROUTER as Address | undefined,
  invoices: process.env.NEXT_PUBLIC_INVOICES as Address | undefined,
};

export const arc = {
  chainId: arcTestnet.id,
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  weth: "0x2c4047028a72803939b6fb674D01bC059B5C4961",
  cirbtc: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  // Morpho USDC vault listed by Circle Earn, allowlisted in the settlement contract
  morphoVault: "0x8f2D33B5D4B9B5F02DF635AE308F7B4C9dA8D2DC",
  // Morpho cirBTC/USDC market listed by Circle Borrow
  cirbtcMarket: "0xf8a71f6df9dc7725d1c2fd848e4635d1e9ddca11da4e2dc2f9801005bd2b5d58",
  explorer: "https://explorer.testnet.arc.io",
} as const;

export const base = {
  chainId: baseSepolia.id,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  eurc: "0x808456652fdb597867f38412077A9182bf77359F",
  cctpDomain: 6,
  explorer: "https://sepolia.basescan.org",
} as const;

export const ethereum = {
  chainId: sepolia.id,
  weth: "0xfFf9976782d46CC05630D1f6eBAB18b2324d6B14",
  cirbtc: "0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3",
  explorer: "https://sepolia.etherscan.io",
} as const;

const intent =
  "(bytes32 id, address payer, uint8 action, address recipient, address token, uint256 amount, bytes32 invoiceId, address replyTo)";

export const routerAbi = parseAbi([
  `function send(${intent} intent, uint256 amount, uint256 maxFee) payable returns (bytes32)`,
  `function quote(${intent} intent) view returns (uint256)`,
  "event Sent(bytes32 indexed id, address indexed payer, bytes32 indexed invoiceId, uint256 usdcAmount, bytes32 ccipMessageId)",
]);

export const settlementAbi = parseAbi([
  `function getOrder(bytes32 id) view returns ((${intent} intent, uint64 sourceChain, uint256 funded, uint8 status))`,
  "function receiveFunds(bytes message, bytes attestation)",
  "event Settled(bytes32 indexed id, bytes32 indexed invoiceId, address payer, address indexed recipient, address token, uint256 amount)",
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
