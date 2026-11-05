// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";

contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol, uint8 decimals_) ERC20(symbol, symbol) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockVault is ERC4626 {
    constructor(IERC20 asset) ERC20("Vault", "vUSDC") ERC4626(asset) {}
}

/// Mints what a CCTP burn message describes, minus the executed fee.
contract MockMessageTransmitter {
    MockToken public immutable usdc;
    mapping(bytes32 => bool) public used;

    constructor(MockToken _usdc) {
        usdc = _usdc;
    }

    function receiveMessage(bytes calldata message, bytes calldata) external returns (bool) {
        bytes32 nonce = bytes32(message[12:44]);
        require(!used[nonce], "nonce used");
        used[nonce] = true;

        address destinationCaller = address(uint160(uint256(bytes32(message[108:140]))));
        require(destinationCaller == address(0) || destinationCaller == msg.sender, "caller");

        bytes calldata body = message[148:];
        address recipient = address(uint160(uint256(bytes32(body[36:68]))));
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 fee = uint256(bytes32(body[164:196]));
        usdc.mint(recipient, amount - fee);
        return true;
    }
}

/// Records burns instead of emitting a real CCTP message.
contract MockTokenMessenger {
    struct Burn {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    Burn public last;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        MockToken(burnToken).burn(msg.sender, amount);
        last = Burn(amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold, hookData);
    }
}

/// Charges a flat fee and records the last message. `deliver` plays the destination side.
contract MockCCIPRouter {
    uint256 public fee;
    uint256 public sent;
    uint64 public lastDestination;
    Client.EVM2AnyMessage internal lastMessage;

    constructor(uint256 _fee) {
        fee = _fee;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return fee;
    }

    function ccipSend(uint64 destination, Client.EVM2AnyMessage calldata message) external payable returns (bytes32) {
        if (message.feeToken == address(0)) {
            require(msg.value >= fee, "value");
        } else {
            IERC20(message.feeToken).transferFrom(msg.sender, address(this), fee);
        }
        lastDestination = destination;
        lastMessage = message;
        return bytes32(++sent);
    }

    function lastData() external view returns (bytes memory) {
        return lastMessage.data;
    }

    function lastReceiver() external view returns (address) {
        return abi.decode(lastMessage.receiver, (address));
    }

    function lastExtraArgs() external view returns (bytes memory) {
        return lastMessage.extraArgs;
    }

    function deliver(address receiver, uint64 sourceChain, address sender, bytes memory data) external {
        IAny2EVMMessageReceiver(receiver)
            .ccipReceive(
                Client.Any2EVMMessage({
                    messageId: keccak256(data),
                    sourceChainSelector: sourceChain,
                    sender: abi.encode(sender),
                    data: data,
                    destTokenAmounts: new Client.EVMTokenAmount[](0)
                })
            );
    }
}
