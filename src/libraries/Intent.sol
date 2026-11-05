// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// What happens on Arc once the USDC arrives.
enum Action {
    // Deliver exactly `amount` of `token` to `recipient`. Leftover USDC goes back to the payer.
    Pay,
    // Convert everything that arrived into `token` and send it to `recipient`. `amount` is the minimum out.
    Deposit,
    // Deposit everything into the ERC-4626 vault at `token`; `recipient` gets the shares. `amount` is the minimum.
    Earn,
    // Swap about half into `token` and add both sides as a full-range position in the USDC/`token` pool.
    // The position NFT goes to `recipient`, `amount` is the minimum liquidity.
    Provide
}

/// The instruction that travels over CCIP next to a CCTP transfer.
struct Intent {
    bytes32 id;
    address payer;
    Action action;
    address recipient;
    address token;
    uint256 amount;
    bytes32 invoiceId;
    // Contract on the source chain that wants a receipt, or zero for none.
    address replyTo;
}

/// The receipt sent back over CCIP after settlement.
struct Receipt {
    bytes32 intentId;
    bytes32 invoiceId;
    address payer;
    address recipient;
    address token;
    uint256 amount;
    bool success;
}
