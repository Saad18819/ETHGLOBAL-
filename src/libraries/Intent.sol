// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// What happens on Arc once the USDC arrives.
enum Action {
    // Deliver exactly `amount` of `token` to `recipient`. Swapping into it may spend at most `limit` USDC.
    Pay,
    // Convert everything that arrived into `token` and send it to `recipient`. `amount` is the minimum out.
    Deposit,
    // Deposit everything into the ERC-4626 vault at `token`; `recipient` gets the shares. `amount` is the minimum.
    Earn,
    // Swap about half into `token` (at least `limit` out) and add both sides as a position in the USDC/`token`
    // pool. The position NFT goes to `recipient`, `amount` is the minimum liquidity, `data` may set the range.
    Provide
}

/// The instruction that travels over CCIP next to a CCTP transfer. Orders are keyed by the hash of the
/// whole intent, and the CCTP burn carries that hash, so funds only ever settle the intent they were sent for.
struct Intent {
    bytes32 id;
    address payer;
    Action action;
    address recipient;
    address token;
    uint256 amount;
    // Price bound, see Action.
    uint256 limit;
    // After this time the order is refunded instead of run. Zero means no deadline.
    uint64 deadline;
    // Where leftovers and refunds go on Arc. Zero means the payer.
    address refundTo;
    bytes32 invoiceId;
    // Contract on the source chain that wants a receipt, or zero for none.
    address replyTo;
    // Action specific. Provide: abi.encode(int24 tickLower, int24 tickUpper), empty for full range.
    bytes data;
}

/// The receipt sent back over CCIP after settlement.
struct Receipt {
    bytes32 intentId;
    bytes32 invoiceId;
    address payer;
    address recipient;
    Action action;
    address token;
    uint256 amount;
    bool success;
}

library IntentLib {
    function key(Intent memory intent) internal pure returns (bytes32) {
        return keccak256(abi.encode(intent));
    }

    function refundAddress(Intent memory intent) internal pure returns (address) {
        return intent.refundTo == address(0) ? intent.payer : intent.refundTo;
    }
}
