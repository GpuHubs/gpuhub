// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceFeed} from "./ComputeMarket.sol";

interface IUniV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Price from a Uniswap tick. Pool ticks are powers of 1.0001.
library TickPrice {
    /// @dev 1.0001 in 18 decimals, the base of Uniswap ticks.
    uint256 private constant TICK_BASE = 1.0001e18;
    int256 internal constant MAX_ABS_TICK = 887_272;

    error TickOutOfRange();

    /// @notice Quote asset per whole token, 18 decimals.
    /// @param tick the pool's tick, token1 per token0 in raw units
    /// @param decimalsFactor 10^(tokenDecimals - quoteDecimals)
    function quotePerToken(int256 tick, bool tokenIsToken0, uint256 decimalsFactor) internal pure returns (uint256) {
        if (tick > MAX_ABS_TICK || tick < -MAX_ABS_TICK) revert TickOutOfRange();
        int256 signed = tokenIsToken0 ? tick : -tick;
        uint256 power = _pow(uint256(signed < 0 ? -signed : signed));
        // Multiply before dividing: a cheap token would otherwise lose most of its digits.
        return signed < 0 ? (1e36 * decimalsFactor) / power : power * decimalsFactor;
    }

    /// @notice The tick nearest below numerator/denominator, found by bisection.
    function tickOfRatio(uint256 numerator, uint256 denominator) internal pure returns (int256) {
        bool above = numerator >= denominator;
        uint256 ratioE18 = above ? (numerator * 1e18) / denominator : (denominator * 1e18) / numerator;
        uint256 low;
        uint256 high = uint256(MAX_ABS_TICK);
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (_pow(mid) <= ratioE18) low = mid;
            else high = mid - 1;
        }
        return above ? int256(low) : -int256(low);
    }

    /// @dev 1.0001^n by repeated squaring, keeps 18 decimals. Fits in 256 bits for n up to MAX_ABS_TICK.
    function _pow(uint256 n) private pure returns (uint256 result) {
        result = 1e18;
        uint256 base = TICK_BASE;
        while (n > 0) {
            if (n & 1 == 1) result = (result * base) / 1e18;
            n >>= 1;
            if (n > 0) base = (base * base) / 1e18;
        }
    }
}

/// @title UniV3TwapFeed
/// @notice Price of a token in a quote asset from the time-weighted average tick of a Uniswap V3
/// pool. A single trade can move a spot price but barely moves an average over a long window.
/// Reverts if the pool has too little history, and the market then treats the price as unavailable.
/// @dev Treats 1 USDG as $1. Pool depth is not checked here: pick a deep pool, a thin one can
/// still be pushed over a whole window at a modest cost.
contract UniV3TwapFeed is IPriceFeed {
    IUniV3Pool public immutable pool;
    uint32 public immutable window;
    bool public immutable tokenIsToken0;
    uint256 public immutable decimalsFactor;

    error BadConfig();

    constructor(IUniV3Pool pool_, address token, address quote, uint8 tokenDecimals, uint8 quoteDecimals, uint32 window_) {
        if (window_ < 600 || tokenDecimals < quoteDecimals) revert BadConfig();
        address t0 = pool_.token0();
        address t1 = pool_.token1();
        if (!((t0 == token && t1 == quote) || (t0 == quote && t1 == token))) revert BadConfig();
        pool = pool_;
        window = window_;
        tokenIsToken0 = t0 == token;
        decimalsFactor = 10 ** (tokenDecimals - quoteDecimals);
    }

    function latest() external view returns (uint256 priceE18, uint256 updatedAt) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        ago[1] = 0;
        (int56[] memory cumulatives,) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 span = int56(uint56(window));
        int56 tick = delta / span;
        if (delta < 0 && delta % span != 0) tick--; // round towards negative infinity, as Uniswap does
        return (TickPrice.quotePerToken(tick, tokenIsToken0, decimalsFactor), block.timestamp);
    }
}

/// @title ChainedFeed
/// @notice Token in USD through a middle asset: token in ETH times ETH in USD.
contract ChainedFeed is IPriceFeed {
    IPriceFeed public immutable tokenInMiddle;
    IPriceFeed public immutable middleInUsd;

    constructor(IPriceFeed tokenInMiddle_, IPriceFeed middleInUsd_) {
        tokenInMiddle = tokenInMiddle_;
        middleInUsd = middleInUsd_;
    }

    function latest() external view returns (uint256 priceE18, uint256 updatedAt) {
        (uint256 a, uint256 atA) = tokenInMiddle.latest();
        (uint256 b, uint256 atB) = middleInUsd.latest();
        return ((a * b) / 1e18, atA < atB ? atA : atB);
    }
}

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title SampledTickFeed
/// @notice An average price built from samples, the same way a Uniswap V3 pool keeps its own. For
/// sources with no price history. Only the keeper, the coordinator's key, takes samples.
/// @dev A sample reads the spot price at that moment. If anyone could take one, they could move the
/// pool, sample and move it back in one transaction, and own every sample. So sampling is the
/// keeper's alone. On top of that a sample counts only until the next one, none is taken sooner than
/// minInterval after the last, and the recorded tick moves by at most maxTickStep per sample.
/// Without recent samples latest() is stale and the market stops converting.
abstract contract SampledTickFeed is IPriceFeed {
    struct Sample {
        uint32 time;
        int56 cumulative;
    }

    bool public immutable tokenIsToken0;
    uint256 public immutable decimalsFactor;
    uint32 public immutable window;
    uint32 public immutable minInterval;
    int24 public immutable maxTickStep;
    address public immutable keeper;

    Sample[] private ring;
    uint256 public head;
    uint256 public count;
    int24 public lastTick;
    uint32 public lastPoke;
    int56 public cumulative;

    event Poked(int24 spotTick, int24 recordedTick);

    error BadConfig();
    error TooSoon();
    error NotEnoughHistory();
    error NotKeeper();

    constructor(bool tokenIsToken0_, uint8 tokenDecimals, uint8 quoteDecimals, uint32 window_, uint32 minInterval_, int24 maxTickStep_, address keeper_) {
        // A step above the whole tick range would overflow int24 when added to the last tick.
        if (
            window_ < 600 || minInterval_ == 0 || minInterval_ > window_ / 4 || maxTickStep_ <= 0 || maxTickStep_ > 887272
                || tokenDecimals < quoteDecimals || keeper_ == address(0)
        ) {
            revert BadConfig();
        }
        keeper = keeper_;
        tokenIsToken0 = tokenIsToken0_;
        decimalsFactor = 10 ** (tokenDecimals - quoteDecimals);
        window = window_;
        minInterval = minInterval_;
        maxTickStep = maxTickStep_;
        uint256 slots = window_ / minInterval_ + 2;
        for (uint256 i; i < slots; ++i) ring.push(Sample(0, 0));
    }

    /// @dev Called at the end of the constructor of the contract that knows the source.
    function _start(int24 tick) internal {
        lastTick = tick;
        lastPoke = uint32(block.timestamp);
        ring[0] = Sample(lastPoke, 0);
        count = 1;
    }

    /// @dev The source's current tick, as token1 per token0 in raw units. A spot price.
    function _spotTick() internal view virtual returns (int24);

    function spotTick() external view returns (int24) {
        return _spotTick();
    }

    /// @notice Records a sample. Only the keeper may.
    function poke() external {
        if (msg.sender != keeper) revert NotKeeper();
        uint32 nowTime = uint32(block.timestamp);
        uint32 elapsed = nowTime - lastPoke;
        if (elapsed < minInterval) revert TooSoon();
        // The time since the last sample counts at the tick recorded back then.
        cumulative += int56(lastTick) * int56(uint56(elapsed));
        int24 spot = _spotTick();
        int24 recorded = spot;
        if (spot > lastTick + maxTickStep) recorded = lastTick + maxTickStep;
        else if (spot < lastTick - maxTickStep) recorded = lastTick - maxTickStep;
        lastTick = recorded;
        lastPoke = nowTime;
        head = (head + 1) % ring.length;
        ring[head] = Sample(nowTime, cumulative);
        if (count < ring.length) count++;
        emit Poked(spot, recorded);
    }

    /// @notice Whether history covers a whole window yet.
    function ready() public view returns (bool) {
        return block.timestamp - ring[_oldest()].time >= window;
    }

    function _oldest() private view returns (uint256) {
        return count < ring.length ? 0 : (head + 1) % ring.length;
    }

    function latest() external view returns (uint256 priceE18, uint256 updatedAt) {
        if (!ready()) revert NotEnoughHistory();
        uint32 target = uint32(block.timestamp) - window;
        // Newest sample that is at least a window old. The ring is short, a loop is fine in a view.
        uint256 i = head;
        for (uint256 n; n < count; ++n) {
            if (ring[i].time <= target) break;
            i = i == 0 ? ring.length - 1 : i - 1;
        }
        Sample memory from_ = ring[i];
        int56 total = cumulative + int56(lastTick) * int56(uint56(uint32(block.timestamp) - lastPoke));
        int56 span = int56(uint56(uint32(block.timestamp) - from_.time));
        int56 delta = total - from_.cumulative;
        int56 tick = delta / span;
        if (delta < 0 && delta % span != 0) tick--;
        return (TickPrice.quotePerToken(tick, tokenIsToken0, decimalsFactor), lastPoke);
    }
}

/// @title V4SampledFeed
/// @notice Average price of a Uniswap V4 pool. V4 keeps no price history of its own.
contract V4SampledFeed is SampledTickFeed {
    /// @dev The slot of the pools mapping in Uniswap V4's PoolManager.
    uint256 private constant POOLS_SLOT = 6;

    IExtsload public immutable manager;
    bytes32 public immutable poolId;

    error PoolNotInitialized();

    constructor(
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
        manager = manager_;
        poolId = poolId_;
        _start(_spotTick());
    }

    function _spotTick() internal view override returns (int24) {
        uint256 slot0 = uint256(manager.extsload(keccak256(abi.encode(poolId, POOLS_SLOT))));
        if (uint160(slot0) == 0) revert PoolNotInitialized();
        return int24(int256(slot0 >> 160));
    }
}
