// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Subset of CCTP V2, see developers.circle.com/cctp/references/contract-interfaces
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}
