// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// Single-pool swaps straight against the v4 PoolManager, ERC20 currencies only.
abstract contract UniswapV4Swapper is IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;
    using SafeCast for int256;

    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error Slippage(uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// Spend exactly `amountIn` of `tokenIn`, revert unless at least `minOut` comes back.
    function _swapExactIn(PoolKey memory key, address tokenIn, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 amountOut)
    {
        (, amountOut) = _swap(key, tokenIn, -amountIn.toInt256(), amountIn, minOut);
    }

    /// Receive exactly `amountOut`, revert if it costs more than `maxIn` of `tokenIn`.
    function _swapExactOut(PoolKey memory key, address tokenIn, uint256 amountOut, uint256 maxIn)
        internal
        returns (uint256 amountIn)
    {
        (amountIn,) = _swap(key, tokenIn, amountOut.toInt256(), maxIn, amountOut);
    }

    function _swap(PoolKey memory key, address tokenIn, int256 amountSpecified, uint256 maxIn, uint256 minOut)
        private
        returns (uint256 amountIn, uint256 amountOut)
    {
        bool zeroForOne = Currency.unwrap(key.currency0) == tokenIn;
        bytes memory result = poolManager.unlock(abi.encode(key, zeroForOne, amountSpecified));
        (amountIn, amountOut) = abi.decode(result, (uint256, uint256));
        if (amountIn > maxIn || amountOut < minOut) revert Slippage(amountIn, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        (Currency currencyIn, Currency currencyOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (int128 deltaIn, int128 deltaOut) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());

        uint256 amountIn = (-int256(deltaIn)).toUint256();
        uint256 amountOut = int256(deltaOut).toUint256();

        poolManager.sync(currencyIn);
        IERC20(Currency.unwrap(currencyIn)).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(currencyOut, address(this), amountOut);

        return abi.encode(amountIn, amountOut);
    }
}
