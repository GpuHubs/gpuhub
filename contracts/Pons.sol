// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenSwap} from "./ComputeMarket.sol";
import {IExtsload, SampledTickFeed, TickPrice} from "./UniV3TwapFeed.sol";
import {IUniV3SwapPool} from "./UniV3Swap.sol";

/// @notice A Pons V2 bonding curve, as read from mainnet.
interface IPonsCurve {
    function graduated() external view returns (bool);
    function quoteReserve() external view returns (uint256);
    function tokenReserve() external view returns (uint256);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
}

/// @title PonsCurveFeed
/// @notice Average price of a Pons V2 token through its whole life. It samples the bonding curve
/// until graduation, then the Uniswap V4 pool the curve graduates into, with no action needed. At
/// graduation the curve's last price and the pool's first price are the same.
/// @dev After the curve ends and before the pool exists there is nothing to sample, poke() reverts
/// and the price goes stale. Creating the pool is open to anyone, the coordinator does it.
contract PonsCurveFeed is SampledTickFeed {
    enum Source {
        Curve,
        Pool,
        Waiting
    }

    /// @dev The slot of the pools mapping in Uniswap V4's PoolManager.
    uint256 private constant POOLS_SLOT = 6;

    IPonsCurve public immutable curve;
    IExtsload public immutable manager;
    bytes32 public immutable poolId;

    error PoolNotReady();

    constructor(
        IPonsCurve curve_,
        IExtsload manager_,
        bytes32 poolId_,
        bool tokenIsToken0_,
        uint8 tokenDecimals,
        uint8 quoteDecimals,
        uint32 window_,
        uint32 minInterval_,
        int24 maxTickStep_,
        address keeper_
    ) SampledTickFeed(tokenIsToken0_, tokenDecimals, quoteDecimals, window_, minInterval_, maxTickStep_, keeper_) {
        curve = curve_;
        manager = manager_;
        poolId = poolId_;
        _start(_spotTick());
    }

    function _poolSlot0() private view returns (uint256) {
        return uint256(manager.extsload(keccak256(abi.encode(poolId, POOLS_SLOT))));
    }

    function source() external view returns (Source) {
        if (!curve.graduated()) return Source.Curve;
        return uint160(_poolSlot0()) == 0 ? Source.Waiting : Source.Pool;
    }

    function _spotTick() internal view override returns (int24) {
        if (!curve.graduated()) {
            uint256 quoteAmount = curve.quoteReserve();
            uint256 tokens = curve.tokenReserve();
            if (tokens == 0) revert PoolNotReady();
            int256 tick = TickPrice.tickOfRatio(quoteAmount, tokens);
            return int24(tokenIsToken0 ? tick : -tick);
        }
        uint256 slot0 = _poolSlot0();
        if (uint160(slot0) == 0) revert PoolNotReady();
        return int24(int256(slot0 >> 160));
    }
}

interface IPoolManagerLike {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IWeth {
    function withdraw(uint256 amount) external;
}

/// @title PonsSwap
/// @notice Buys a Pons V2 token with USDG for a market deposit: on the bonding curve while it runs,
/// in the Uniswap V4 pool afterwards. A token quoted in ETH goes through a USDG/WETH V3 pool first.
/// It holds nothing between calls and has no owner.
contract PonsSwap is ITokenSwap {
    using SafeERC20 for IERC20;

    uint160 private constant MIN_SQRT_RATIO_PLUS = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS = 1461446703485210103287273052203988822378723970341;

    IERC20 public immutable usdg;
    IERC20 public immutable token;
    IPonsCurve public immutable curve;
    IPoolManagerLike public immutable manager;
    address public immutable hook;
    int24 public immutable tickSpacing;
    /// @dev Zero when the token is quoted in USDG.
    IUniV3SwapPool public immutable wethUsdgPool;
    IERC20 public immutable weth;

    bool private inV3Swap;

    error NotExpected();
    error Slippage();
    /// @dev The buy would end the curve and the rest could not be spent. Try again in a moment.
    error CurveEnding();
    error NoEthReceived();

    constructor(
        IERC20 usdg_,
        IERC20 token_,
        IPonsCurve curve_,
        IPoolManagerLike manager_,
        address hook_,
        int24 tickSpacing_,
        IUniV3SwapPool wethUsdgPool_,
        IERC20 weth_
    ) {
        usdg = usdg_;
        token = token_;
        curve = curve_;
        manager = manager_;
        hook = hook_;
        tickSpacing = tickSpacing_;
        wethUsdgPool = wethUsdgPool_;
        weth = weth_;
    }

    /// @dev Only from those who pay out during a swap. Ether can still be forced in, so nothing
    /// below may depend on the balance being zero.
    receive() external payable {
        if (msg.sender != address(weth) && msg.sender != address(curve) && msg.sender != address(manager)) revert NotExpected();
    }

    function _native() private view returns (bool) {
        return address(wethUsdgPool) != address(0);
    }

    function swapUsdgForToken(uint256 usdgIn, uint256 minTokensOut) external returns (uint256 tokensOut) {
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        uint256 ethBefore = address(this).balance;
        uint256 quoteIn = _native() ? _usdgToEth(usdgIn) : usdgIn;

        if (!curve.graduated()) {
            if (_native()) {
                curve.buy{value: quoteIn}(quoteIn, 0, address(this));
                // A last buy ends the curve and gets the rest back. It could not be spent now.
                if (address(this).balance > ethBefore) revert CurveEnding();
            } else {
                // Compared with the balance before, so USDG someone sent here cannot block buying.
                uint256 usdgBefore = usdg.balanceOf(address(this));
                usdg.forceApprove(address(curve), quoteIn);
                curve.buy(quoteIn, 0, address(this));
                usdg.forceApprove(address(curve), 0);
                if (usdg.balanceOf(address(this)) + quoteIn > usdgBefore) revert CurveEnding();
            }
        } else {
            manager.unlock(abi.encode(quoteIn));
            // A pool out of liquidity uses less than offered. Keeping the rest here would lose it.
            if (address(this).balance > ethBefore) revert CurveEnding();
        }

        tokensOut = token.balanceOf(address(this));
        if (tokensOut < minTokensOut) revert Slippage();
        token.safeTransfer(msg.sender, tokensOut);
        uint256 leftover = usdg.balanceOf(address(this));
        if (leftover > 0) usdg.safeTransfer(msg.sender, leftover);
    }

    function _usdgToEth(uint256 usdgIn) private returns (uint256 ethOut) {
        bool zeroForOne = wethUsdgPool.token0() == address(usdg);
        inV3Swap = true;
        (int256 amount0, int256 amount1) = wethUsdgPool.swap(
            address(this), zeroForOne, int256(usdgIn), zeroForOne ? MIN_SQRT_RATIO_PLUS : MAX_SQRT_RATIO_MINUS, ""
        );
        inV3Swap = false;
        ethOut = uint256(-(zeroForOne ? amount1 : amount0));
        uint256 balanceBefore = address(this).balance;
        IWeth(address(weth)).withdraw(ethOut);
        if (ethOut == 0 || address(this).balance - balanceBefore != ethOut) revert NoEthReceived();
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (!inV3Swap || msg.sender != address(wethUsdgPool)) revert NotExpected();
        usdg.safeTransfer(msg.sender, uint256(amount0Delta > 0 ? amount0Delta : amount1Delta));
    }

    /// @dev The pool manager calls back here while it is unlocked, to do the V4 swap.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotExpected();
        uint256 amountIn = abi.decode(data, (uint256));

        address quote = _native() ? address(0) : address(usdg);
        address t = address(token);
        bool quoteIsZero = uint160(quote) < uint160(t);
        IPoolManagerLike.PoolKey memory key = IPoolManagerLike.PoolKey({
            currency0: quoteIsZero ? quote : t,
            currency1: quoteIsZero ? t : quote,
            fee: 0,
            tickSpacing: tickSpacing,
            hooks: hook
        });
        // Quote in, token out, a negative amount means exact input.
        int256 delta = manager.swap(
            key,
            IPoolManagerLike.SwapParams({
                zeroForOne: quoteIsZero,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: quoteIsZero ? MIN_SQRT_RATIO_PLUS : MAX_SQRT_RATIO_MINUS
            }),
            ""
        );
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        uint256 owed = uint256(uint128(-(quoteIsZero ? amount0 : amount1)));
        uint256 received = uint256(uint128(quoteIsZero ? amount1 : amount0));

        if (_native()) {
            manager.settle{value: owed}();
        } else {
            manager.sync(quote);
            usdg.safeTransfer(address(manager), owed);
            manager.settle();
        }
        manager.take(t, address(this), received);
        return "";
    }
}
