// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {Receipt} from "./libraries/Intent.sol";

/// Merchant side on the source chain. An invoice is unlocked only by a receipt from the
/// settlement contract on Arc, delivered over CCIP.
contract InvoiceBook is CCIPReceiver {
    struct Invoice {
        address merchant;
        address payee;
        address token;
        uint256 amount;
        bytes32 intentId;
        uint64 paidAt;
        string memo;
    }

    uint64 public immutable arcSelector;
    address public immutable settlement;

    mapping(bytes32 => Invoice) internal invoices;
    uint256 public count;

    event Created(
        bytes32 indexed id, address indexed merchant, address payee, address token, uint256 amount, string memo
    );
    event Paid(bytes32 indexed id, bytes32 indexed intentId, address indexed payer, uint256 amount);
    event Rejected(bytes32 indexed id, bytes32 indexed intentId);

    error UnknownSource();

    constructor(address ccipRouter, uint64 _arcSelector, address _settlement) CCIPReceiver(ccipRouter) {
        arcSelector = _arcSelector;
        settlement = _settlement;
    }

    /// `payee` and `token` are on Arc.
    function create(address payee, address token, uint256 amount, string calldata memo) external returns (bytes32 id) {
        id = keccak256(abi.encode(block.chainid, address(this), count++));
        invoices[id] = Invoice({
            merchant: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            intentId: bytes32(0),
            paidAt: 0,
            memo: memo
        });
        emit Created(id, msg.sender, payee, token, amount, memo);
    }

    function get(bytes32 id) external view returns (Invoice memory) {
        return invoices[id];
    }

    function isPaid(bytes32 id) external view returns (bool) {
        return invoices[id].paidAt != 0;
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        if (message.sourceChainSelector != arcSelector || abi.decode(message.sender, (address)) != settlement) {
            revert UnknownSource();
        }

        Receipt memory receipt = abi.decode(message.data, (Receipt));
        Invoice storage invoice = invoices[receipt.invoiceId];

        bool matches = receipt.success && invoice.amount != 0 && invoice.paidAt == 0 && receipt.token == invoice.token
            && receipt.recipient == invoice.payee && receipt.amount >= invoice.amount;

        if (!matches) {
            emit Rejected(receipt.invoiceId, receipt.intentId);
            return;
        }

        invoice.paidAt = uint64(block.timestamp);
        invoice.intentId = receipt.intentId;
        emit Paid(receipt.invoiceId, receipt.intentId, receipt.payer, receipt.amount);
    }
}
