// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Phase 2 test receiver on Ethereum Sepolia.
/// The CCIP router on Sepolia calls ccipReceive with the message sent from Arc.
/// (Test-only, Sepolia side; the Arc contracts are built in Arc Studio.)

struct EVMTokenAmount {
    address token;
    uint256 amount;
}

struct Any2EVMMessage {
    bytes32 messageId;
    uint64 sourceChainSelector;
    bytes sender;
    bytes data;
    EVMTokenAmount[] destTokenAmounts;
}

interface IAny2EVMMessageReceiver {
    function ccipReceive(Any2EVMMessage calldata message) external;
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

contract HelloReceiver is IAny2EVMMessageReceiver, IERC165 {
    address public immutable router;

    error OnlyRouter();

    event HelloReceived(
        bytes32 indexed messageId,
        uint64 sourceChainSelector,
        address sender,
        string text,
        uint256 sentAt
    );

    constructor(address _router) {
        router = _router;
    }

    function ccipReceive(Any2EVMMessage calldata message) external override {
        if (msg.sender != router) revert OnlyRouter();
        (string memory text, uint256 sentAt) = abi.decode(message.data, (string, uint256));
        emit HelloReceived(
            message.messageId,
            message.sourceChainSelector,
            abi.decode(message.sender, (address)),
            text,
            sentAt
        );
    }

    /// CCIP only calls ccipReceive on receivers that report this interface.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
