// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenSwap} from "./ComputeMarket.sol";

interface IUniV3SwapPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @title UniV3Swap
/// @notice Swaps USDG for the protocol token through one or two Uniswap V3 pools, for example
/// token/USDG, or USDG/WETH then WETH/token. It holds nothing between calls and has no owner.
contract UniV3Swap is ITokenSwap {
    using SafeERC20 for IERC20;

    uint160 private constant MIN_SQRT_RATIO_PLUS = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS = 1461446703485210103287273052203988822378723970341;

    IERC20 public immutable usdg;
    IERC20 public immutable token;
    IUniV3SwapPool public immutable firstPool;
    IUniV3SwapPool public immutable secondPool; // zero for a direct route

    /// @dev Set only during a swap. A callback from anywhere else pays nothing.
    address private activePool;
    IERC20 private activeInput;

    error BadRoute();
    error NotThePool();
    error Slippage();
    error SecondHopShort();

    constructor(IERC20 usdg_, IERC20 token_, IUniV3SwapPool first, IUniV3SwapPool second) {
        usdg = usdg_;
        token = token_;
        firstPool = first;
        secondPool = second;
        address out = _other(first, address(usdg_));
        if (address(second) == address(0)) {
            if (out != address(token_)) revert BadRoute();
        } else if (_other(second, out) != address(token_)) {
            revert BadRoute();
        }
    }

    function _other(IUniV3SwapPool pool, address input) private view returns (address) {
        address t0 = pool.token0();
        address t1 = pool.token1();
        if (t0 == input) return t1;
        if (t1 == input) return t0;
        revert BadRoute();
    }

    function swapUsdgForToken(uint256 usdgIn, uint256 minTokensOut) external returns (uint256 tokensOut) {
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        uint256 amount = _hop(firstPool, usdg, usdgIn);
        if (address(secondPool) != address(0)) {
            IERC20 middle = IERC20(_other(firstPool, address(usdg)));
            uint256 middleBefore = middle.balanceOf(address(this)) - amount;
            _hop(secondPool, middle, amount);
            // A second pool that ran out would leave the middle token here, lost to the buyer.
            if (middle.balanceOf(address(this)) > middleBefore) revert SecondHopShort();
        }
        tokensOut = token.balanceOf(address(this));
        if (tokensOut < minTokensOut) revert Slippage();
        token.safeTransfer(msg.sender, tokensOut);
        // A pool may have used less than offered when liquidity ran out. It goes back, nothing stays here.
        uint256 leftover = usdg.balanceOf(address(this));
        if (leftover > 0) usdg.safeTransfer(msg.sender, leftover);
    }

    function _hop(IUniV3SwapPool pool, IERC20 input, uint256 amountIn) private returns (uint256 received) {
        bool zeroForOne = pool.token0() == address(input);
        activePool = address(pool);
        activeInput = input;
        (int256 amount0, int256 amount1) = pool.swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO_PLUS : MAX_SQRT_RATIO_MINUS, ""
        );
        activePool = address(0);
        received = uint256(-(zeroForOne ? amount1 : amount0));
    }

    /// @dev Called by the pool during a swap, to collect what it is owed.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != activePool) revert NotThePool();
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        activeInput.safeTransfer(msg.sender, owed);
    }
}
