// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {ITokenMessengerV2} from "./interfaces/ICCTP.sol";
import {UniswapV4Swapper} from "./UniswapV4Swapper.sol";
import {Intent, IntentLib} from "./libraries/Intent.sol";

/// Lives on the source chain. Turns the input into USDC and burns it over CCTP towards the settlement
/// contract on Arc, with the instruction as the burn's hook data, so both arrive in one message.
contract AndThenRouter is UniswapV4Swapper, Ownable2Step {
    using SafeERC20 for IERC20;
    using IntentLib for Intent;

    /// Keeps the hook data small enough to always settle on Arc.
    uint256 public constant MAX_DATA = 64;

    uint32 public constant ARC_DOMAIN = 26;

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;

    address public settlement;
    uint256 public nonce;

    event Sent(bytes32 indexed id, address indexed payer, bytes32 indexed invoiceId, uint256 usdcAmount);

    error NotUsdcPool();
    error DataTooLong();

    constructor(
        IERC20 _usdc,
        ITokenMessengerV2 _tokenMessenger,
        IPoolManager _poolManager,
        address _settlement,
        address initialOwner
    ) UniswapV4Swapper(_poolManager) Ownable(initialOwner) {
        usdc = _usdc;
        tokenMessenger = _tokenMessenger;
        settlement = _settlement;
    }

    /// Pay with USDC already on this chain. `cctpFinality` is 1000 for a fast transfer (fee up to `maxFee`)
    /// or 2000 for a standard one.
    function send(Intent memory intent, uint256 amount, uint256 maxFee, uint32 cctpFinality)
        external
        returns (bytes32)
    {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        return _bridge(intent, amount, maxFee, cctpFinality);
    }

    /// Pay with any token that has a v4 pool against USDC here.
    function swapAndSend(
        PoolKey calldata key,
        address tokenIn,
        uint256 amountIn,
        uint256 minUsdc,
        Intent memory intent,
        uint256 maxFee,
        uint32 cctpFinality
    ) external returns (bytes32) {
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        bool fromZero = currency0 == tokenIn;
        if ((!fromZero && currency1 != tokenIn) || (fromZero ? currency1 : currency0) != address(usdc)) {
            revert NotUsdcPool();
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amount = _swapExactIn(key, tokenIn, amountIn, minUsdc);
        return _bridge(intent, amount, maxFee, cctpFinality);
    }

    function _bridge(Intent memory intent, uint256 amount, uint256 maxFee, uint32 cctpFinality)
        internal
        returns (bytes32 id)
    {
        if (intent.data.length > MAX_DATA) revert DataTooLong();
        id = keccak256(abi.encode(block.chainid, address(this), nonce++));
        intent.id = id;
        intent.payer = msg.sender;

        // Only our settlement contract may relay the burn, and the sender is checked there against this
        // router, so the intent in the hook data is the one this call made.
        bytes32 target = bytes32(uint256(uint160(settlement)));
        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurnWithHook(
            amount, ARC_DOMAIN, target, address(usdc), target, maxFee, cctpFinality, abi.encode(intent)
        );

        emit Sent(id, msg.sender, intent.invoiceId, amount);
    }

    function setSettlement(address _settlement) external onlyOwner {
        settlement = _settlement;
    }
}
