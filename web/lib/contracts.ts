import { parseAbi, type Address } from "viem";
import { arc as arcChain, base as baseChain } from "wagmi/chains";

export const deployed = {
  settlement: process.env.NEXT_PUBLIC_SETTLEMENT as Address | undefined,
  // Invoices live on Base
  invoices: process.env.NEXT_PUBLIC_INVOICES as Address | undefined,
};

/// Arc mainnet, from docs.arc.io/arc/references/contract-addresses.
export const arc = {
  chainId: arcChain.id,
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  weth: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB",
  cirbtc: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  explorer: "https://explorer.arc.io",
} as const;

export const base = {
  chainId: baseChain.id,
  cctpDomain: 6,
  explorer: "https://basescan.org",
} as const;

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
