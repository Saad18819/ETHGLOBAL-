// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Tiny test receiver for Phase 1 Part B.
/// Deploy this on Arc Testnet in Arc Studio, passing YOUR wallet as `_owner`
/// (Studio deploys from its own platform wallet, so msg.sender is not you).
/// Arc's CrossChainTokenService mints EURC to this contract, then calls
/// executeWithCrossChainToken with the hookData you sent from Sepolia.
contract HookReceiver {
    /// Circle's example return value; anything else is treated as a failure.
    bytes32 public constant EXECUTE_SUCCESS = keccak256("circle-cctpx-execute-success");

    /// CrossChainTokenService (same address on Sepolia and Arc).
    address public constant CCTS = 0x63753E722bd2C2A5DF6EE19C5106662208B81077;

    address public immutable owner;

    error ZeroAddress();
    error OnlyCCTS();
    error OnlyOwner();
    error BalanceCallFailed();
    error TransferFailed();

    event HookReceived(
        uint32 sourceDomain,
        bytes sourceAddress,
        bytes32 tokenId,
        address indexed token,
        uint256 amount,
        uint32 finalityThresholdExecuted,
        string note,
        uint256 orderId
    );

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    function executeWithCrossChainToken(
        uint32 sourceDomain,
        bytes calldata sourceAddress,
        bytes32 tokenId,
        address token,
        uint256 amount,
        uint32 finalityThresholdExecuted,
        bytes calldata hookData
    ) external returns (bytes32) {
        if (msg.sender != CCTS) revert OnlyCCTS();

        // The script sends hookData = abi.encode(string note, uint256 orderId).
        // Any other shape reverts here and rolls back the whole delivery.
        (string memory note, uint256 orderId) = abi.decode(hookData, (string, uint256));

        emit HookReceived(
            sourceDomain, sourceAddress, tokenId, token, amount,
            finalityThresholdExecuted, note, orderId
        );
        return EXECUTE_SUCCESS;
    }

    /// Get the test EURC back out.
    function sweep(address token, address to) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, _balance(token))
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) revert BalanceCallFailed();
        return abi.decode(ret, (uint256));
    }
}

