// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {ITokenMessengerV2} from "./interfaces/ICCTP.sol";
import {UniswapV4Swapper} from "./UniswapV4Swapper.sol";
import {Intent} from "./libraries/Intent.sol";

/// Lives on the source chain. Turns the input into USDC, burns it over CCTP towards the
/// settlement contract on Arc, and sends the instruction there over CCIP.
contract AndThenRouter is UniswapV4Swapper, Ownable {
    using SafeERC20 for IERC20;

    uint32 public constant ARC_DOMAIN = 26;

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    IRouterClient public immutable ccipRouter;
    uint64 public immutable arcSelector;

    address public settlement;
    uint32 public gasLimit = 600_000;
    bytes4 public ccipFinality;
    uint256 public nonce;

    event Sent(
        bytes32 indexed id, address indexed payer, bytes32 indexed invoiceId, uint256 usdcAmount, bytes32 ccipMessageId
    );

    error NotUsdcPool();
    error FeeTooLow(uint256 fee);
    error RefundFailed();

    constructor(
        IERC20 _usdc,
        ITokenMessengerV2 _tokenMessenger,
        IRouterClient _ccipRouter,
        IPoolManager _poolManager,
        uint64 _arcSelector,
        address _settlement,
        address owner
    ) UniswapV4Swapper(_poolManager) Ownable(owner) {
        usdc = _usdc;
        tokenMessenger = _tokenMessenger;
        ccipRouter = _ccipRouter;
        arcSelector = _arcSelector;
        settlement = _settlement;
    }

    /// Pay with USDC already on this chain. `msg.value` covers the CCIP fee, the rest is refunded.
    /// `cctpFinality` is 1000 for a fast transfer (fee up to `maxFee`) or 2000 for a standard one.
    function send(Intent memory intent, uint256 amount, uint256 maxFee, uint32 cctpFinality)
        external
        payable
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
    ) external payable returns (bytes32) {
        address tokenOut = Currency.unwrap(key.currency0) == tokenIn
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
        if (tokenOut != address(usdc)) revert NotUsdcPool();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amount = _swapExactIn(key, tokenIn, amountIn, minUsdc);
        return _bridge(intent, amount, maxFee, cctpFinality);
    }

    /// CCIP fee in native gas for sending `intent`.
    function quote(Intent memory intent) external view returns (uint256) {
        return ccipRouter.getFee(arcSelector, _message(intent));
    }

    function _bridge(Intent memory intent, uint256 amount, uint256 maxFee, uint32 cctpFinality)
        internal
        returns (bytes32 id)
    {
        id = keccak256(abi.encode(block.chainid, address(this), nonce++));
        intent.id = id;
        intent.payer = msg.sender;

        bytes32 target = bytes32(uint256(uint160(settlement)));
        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurnWithHook(
            amount, ARC_DOMAIN, target, address(usdc), target, maxFee, cctpFinality, abi.encode(id)
        );

        Client.EVM2AnyMessage memory message = _message(intent);
        uint256 fee = ccipRouter.getFee(arcSelector, message);
        if (msg.value < fee) revert FeeTooLow(fee);
        bytes32 messageId = ccipRouter.ccipSend{value: fee}(arcSelector, message);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }

        emit Sent(id, msg.sender, intent.invoiceId, amount, messageId);
    }

    function _message(Intent memory intent) internal view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(settlement),
            data: abi.encode(intent),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: ExtraArgsCodec._getBasicEncodedExtraArgsV3(gasLimit, ccipFinality)
        });
    }

    function setSettlement(address _settlement) external onlyOwner {
        settlement = _settlement;
    }

    function setConfig(uint32 _gasLimit, bytes4 _ccipFinality) external onlyOwner {
        gasLimit = _gasLimit;
        ccipFinality = _ccipFinality;
    }
}
