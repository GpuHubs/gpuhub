// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice USD price of the protocol token, from a TWAP, never a pool spot price.
interface IPriceFeed {
    /// @return priceE18 USD per 1 whole token, 18 decimals. updatedAt unix seconds.
    function latest() external view returns (uint256 priceE18, uint256 updatedAt);
}

/// @notice Swaps USDG for the protocol token, so a buyer can fund a balance in one step.
/// @notice A token that can destroy its own balance. Most can; the market checks that it really did.
interface IBurnable {
    function burn(uint256 amount) external;
}

interface ITokenSwap {
    /// @dev Pulls usdgIn from the caller and sends at least minTokensOut to the caller.
    function swapUsdgForToken(uint256 usdgIn, uint256 minTokensOut) external returns (uint256 tokensOut);
}

/// @title ComputeMarket
/// @notice Settles rented GPU and CPU time. Everything is paid in the protocol token.
///
/// Rent is priced in USD (6 decimals) and paid in tokens at the feed price, so a higher token
/// price means fewer tokens per hour. A pool of tokens also pays part of the rent. Each epoch
/// `epochBudgetTokens` may be spent, worth `budget * price` in USD, so a higher price buys a
/// deeper discount for the same token budget:
///
///     discount = min(maxDiscount, budget * price / max(lastEpochVolume, minVolume))
///
/// Providers always earn tokens worth the full rent (less fee) at the settlement price. With no
/// usable price nothing can be converted, so settlement waits and no value moves.
contract ComputeMarket is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("SpendVoucher(address buyer,uint256 cumulativeCap,uint256 expiry)");

    uint256 private constant BPS = 10_000;
    /// @dev USD amounts have 6 decimals, the token and the price have 18.
    uint256 private constant USD_TO_E18 = 1e12;
    /// @dev A withdrawal must be taken within this time after it is ready, or asked for again.
    /// An open-ended request would let a buyer leave at any moment, just ahead of a settlement.
    uint256 public constant WITHDRAW_WINDOW = 1 days;
    /// @dev A contract wallet gets this much gas to check a signature. More could stall a batch.
    uint256 private constant ERC1271_GAS = 100_000;

    // Why a charge was left out of a batch.
    uint8 public constant SKIP_EXPIRED = 1;
    uint8 public constant SKIP_SIGNATURE = 2;
    uint8 public constant SKIP_OVER_CAP = 3;
    uint8 public constant SKIP_DEPOSIT = 4;

    struct Charge {
        address buyer;
        uint256 rentUsd; // rent at list price for this buyer in the batch, 6 decimals
        uint256 cumulativeCap; // buyer-signed lifetime limit, in tokens
        uint256 expiry;
        bytes signature;
    }

    struct Payout {
        address provider;
        uint256 rentUsd; // list value of the time this provider sold
    }

    struct Params {
        uint64 epochLength;
        uint64 maxPriceAge;
        uint32 feeBps; // share of the tokens paid by buyers that is burned
        uint32 maxDiscountBps;
        uint32 maxDiscountStepBps; // max rise of the discount per epoch, damps price pumps
        uint256 minVolume; // USD, floor for the denominator
        uint256 epochBudgetTokens;
        uint256 minStake;
        uint64 unstakeDelay;
        uint64 withdrawDelay; // gives the settler time to settle before a buyer leaves
    }

    IERC20 public immutable usdg;
    IERC20 public immutable token;
    IPriceFeed public priceFeed;
    ITokenSwap public swap;
    /// @dev Where the fee goes when the token has no burn(): an address nobody holds the key to.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @notice All the fee ever taken out of circulation, in tokens.
    uint256 public totalBurned;
    Params public params;

    // Epoch state
    uint256 public currentEpoch;
    uint256 public epochVolume; // USD list value settled this epoch
    uint256 public epochBudgetLeft; // tokens
    uint256 public discountBps;
    uint256 public poolBalance; // tokens funding discounts, excludes deposits, stakes and earnings

    // Buyers, in tokens
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public spent; // lifetime tokens charged, compared to vouchers
    mapping(address => uint256) public withdrawAmount;
    mapping(address => uint256) public withdrawReadyAt;

    // Providers, in tokens
    mapping(address => uint256) public stakes;
    mapping(address => uint256) public unstakeAmount;
    mapping(address => uint256) public unstakeReadyAt;
    mapping(address => uint256) public earned;

    event Deposited(address indexed buyer, uint256 tokens);
    event DepositedWithUsdg(address indexed buyer, uint256 usdgIn, uint256 tokensOut);
    event WithdrawRequested(address indexed buyer, uint256 amount, uint256 readyAt);
    event Withdrawn(address indexed buyer, uint256 amount);
    event PoolFunded(address indexed from, uint256 amount);
    event PoolWithdrawn(address indexed to, uint256 amount);
    event EpochRolled(uint256 indexed epoch, uint256 discountBps, uint256 priceE18, uint256 lastVolume);
    event BatchSettled(uint256 indexed epoch, uint256 priceE18, uint256 rentUsd, uint256 paidTokens, uint256 subsidyTokens, uint256 feeTokens);
    event Staked(address indexed provider, uint256 amount);
    event UnstakeRequested(address indexed provider, uint256 amount, uint256 readyAt);
    event Unstaked(address indexed provider, uint256 amount);
    event Slashed(address indexed provider, uint256 amount, bytes32 reason);
    event Claimed(address indexed provider, uint256 amount);
    event ParamsUpdated();
    event ChargeSkipped(address indexed buyer, uint256 rentUsd, uint8 reason);
    event PriceFeedSet(address feed);
    event SwapSet(address swap);
    /// @dev destroyed is true when the token's own burn() ran, false when the tokens went to BURN_ADDRESS.
    event FeeBurned(uint256 amount, bool destroyed);

    error LengthOrSumMismatch();
    error BadSignature(address buyer);
    error VoucherExpired(address buyer);
    error OverCap(address buyer);
    error InsufficientDeposit(address buyer);
    error NotReady();
    error RequestLapsed();
    error ZeroAmount();
    error BadParams();
    error StakeLocked();
    error PriceUnavailable();
    error SwapUnavailable();
    error Slippage();

    constructor(IERC20 usdg_, IERC20 token_, IPriceFeed feed_, address admin, Params memory p)
        EIP712("ComputeMarket", "1")
    {
        if (admin == address(0)) revert BadParams();
        usdg = usdg_;
        token = token_;
        priceFeed = feed_;
        _validate(p);
        params = p;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- pricing

    /// @notice Price feed value, or 0 when the feed reverts or is stale.
    function safePrice() public view returns (uint256) {
        try priceFeed.latest() returns (uint256 priceE18, uint256 updatedAt) {
            if (priceE18 == 0 || updatedAt > block.timestamp) return 0;
            if (block.timestamp - updatedAt > params.maxPriceAge) return 0;
            return priceE18;
        } catch {
            return 0;
        }
    }

    function _usdToTokens(uint256 usd, uint256 priceE18) internal pure returns (uint256) {
        return (usd * USD_TO_E18 * 1e18) / priceE18;
    }

    function _tokensToUsd(uint256 tokens, uint256 priceE18) internal pure returns (uint256) {
        return (tokens * priceE18) / 1e18 / USD_TO_E18;
    }

    function _targetDiscount(uint256 priceE18, uint256 budgetTokens, uint256 volume, uint256 previous)
        internal
        view
        returns (uint256)
    {
        if (priceE18 == 0 || budgetTokens == 0) return 0;
        uint256 denominator = volume > params.minVolume ? volume : params.minVolume;
        uint256 target = (_tokensToUsd(budgetTokens, priceE18) * BPS) / denominator;
        if (target > params.maxDiscountBps) target = params.maxDiscountBps;
        uint256 stepCap = previous + params.maxDiscountStepBps;
        return target > stepCap ? stepCap : target;
    }

    function epochOf(uint256 ts) public view returns (uint256) {
        return ts / params.epochLength;
    }

    /// @notice Rolls the epoch if due. Anyone may call.
    function rollEpoch() public {
        uint256 e = epochOf(block.timestamp);
        if (e == currentEpoch) return;
        uint256 price = safePrice();
        uint256 budget = params.epochBudgetTokens < poolBalance ? params.epochBudgetTokens : poolBalance;
        uint256 lastVolume = epochVolume;
        discountBps = _targetDiscount(price, budget, lastVolume, discountBps);
        epochBudgetLeft = budget;
        epochVolume = 0;
        currentEpoch = e;
        emit EpochRolled(e, discountBps, price, lastVolume);
    }

    /// @notice Tokens a buyer would pay now for some rent. For quotes, the batch may differ.
    /// @return tokens 0 when there is no usable price. discount in bps.
    function quote(uint256 rentUsd) external view returns (uint256 tokens, uint256 discount) {
        uint256 price = safePrice();
        if (price == 0) return (0, 0);
        discount = discountBps;
        if (epochOf(block.timestamp) != currentEpoch) {
            uint256 budget = params.epochBudgetTokens < poolBalance ? params.epochBudgetTokens : poolBalance;
            discount = _targetDiscount(price, budget, epochVolume, discountBps);
        }
        tokens = _usdToTokens(rentUsd - (rentUsd * discount) / BPS, price);
    }

    // ---------------------------------------------------------------- buyers

    /// @dev Credits what really arrived. A token with a fee on transfer would otherwise leave the
    /// market owing more than it holds.
    function _pullToken(uint256 amount) internal returns (uint256 received) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 received = _pullToken(amount);
        deposits[msg.sender] += received;
        emit Deposited(msg.sender, received);
    }

    /// @notice Funds a balance from USDG in one step.
    /// @param minTokensOut protects the buyer from a bad swap price, the buyer's wallet computes it.
    function depositWithUsdg(uint256 usdgIn, uint256 minTokensOut) external nonReentrant {
        if (usdgIn == 0) revert ZeroAmount();
        ITokenSwap s = swap;
        if (address(s) == address(0)) revert SwapUnavailable();
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        usdg.forceApprove(address(s), usdgIn);
        uint256 before = token.balanceOf(address(this));
        s.swapUsdgForToken(usdgIn, minTokensOut);
        usdg.forceApprove(address(s), 0);
        // What actually arrived counts, not what the swap contract says.
        uint256 received = token.balanceOf(address(this)) - before;
        if (received < minTokensOut) revert Slippage();
        deposits[msg.sender] += received;
        // A pool out of liquidity uses less than offered. The rest goes back to the buyer.
        uint256 unspent = usdg.balanceOf(address(this));
        if (unspent > 0) usdg.safeTransfer(msg.sender, unspent);
        emit DepositedWithUsdg(msg.sender, usdgIn - unspent, received);
    }

    /// @notice Starts the delay. A new request replaces the old one and restarts the delay.
    function requestWithdraw(uint256 amount) external {
        if (amount == 0 || amount > deposits[msg.sender]) revert InsufficientDeposit(msg.sender);
        uint256 readyAt = block.timestamp + params.withdrawDelay;
        withdrawAmount[msg.sender] = amount;
        withdrawReadyAt[msg.sender] = readyAt;
        emit WithdrawRequested(msg.sender, amount, readyAt);
    }

    function withdraw() external nonReentrant {
        uint256 amount = withdrawAmount[msg.sender];
        if (amount == 0 || block.timestamp < withdrawReadyAt[msg.sender]) revert NotReady();
        if (block.timestamp > withdrawReadyAt[msg.sender] + WITHDRAW_WINDOW) revert RequestLapsed();
        // Settlement may have used the funds meanwhile.
        if (amount > deposits[msg.sender]) amount = deposits[msg.sender];
        withdrawAmount[msg.sender] = 0;
        deposits[msg.sender] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function voucherDigest(address buyer, uint256 cumulativeCap, uint256 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, buyer, cumulativeCap, expiry)));
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Charges buyers within their signed caps and credits providers.
    /// @dev Trust: the settler reports the rent. It can only move funds up to a buyer's cap.
    function settleBatch(Charge[] calldata charges, Payout[] calldata payouts)
        external
        onlyRole(SETTLER_ROLE)
        nonReentrant
    {
        uint256 price = safePrice();
        if (price == 0) revert PriceUnavailable();
        rollEpoch();

        uint256 rentTotal;
        for (uint256 i; i < charges.length; ++i) rentTotal += charges[i].rentUsd;
        uint256 payoutTotal;
        for (uint256 i; i < payouts.length; ++i) payoutTotal += payouts[i].rentUsd;
        if (rentTotal == 0 || rentTotal != payoutTotal) revert LengthOrSumMismatch();

        // Subsidy is limited by what is left of the epoch budget.
        uint256 subsidyUsd = (rentTotal * discountBps) / BPS;
        uint256 subsidyTokens;
        if (subsidyUsd > 0) {
            subsidyTokens = _usdToTokens(subsidyUsd, price);
            if (subsidyTokens > epochBudgetLeft) {
                subsidyTokens = epochBudgetLeft;
                subsidyUsd = _tokensToUsd(subsidyTokens, price);
            }
        }

        // A buyer who cannot pay is left out and reported. Reverting instead would let any one buyer
        // stop every provider's payout, for example by withdrawing just ahead of the batch.
        uint256 paidTokens;
        uint256 collectedRent;
        uint256 usedSubsidyUsd;
        uint256 remainingSubsidy = subsidyUsd;
        for (uint256 i; i < charges.length; ++i) {
            Charge calldata c = charges[i];
            uint256 share = i == charges.length - 1 ? remainingSubsidy : (subsidyUsd * c.rentUsd) / rentTotal;
            if (share > c.rentUsd) share = c.rentUsd;
            remainingSubsidy -= share;
            uint256 owed = _usdToTokens(c.rentUsd - share, price);
            uint8 skip = _charge(c, owed);
            if (skip != 0) {
                emit ChargeSkipped(c.buyer, c.rentUsd, skip);
                continue;
            }
            paidTokens += owed;
            collectedRent += c.rentUsd;
            usedSubsidyUsd += share;
        }
        // The pool pays only for the rent that was actually collected.
        if (usedSubsidyUsd < subsidyUsd) subsidyTokens = _usdToTokens(usedSubsidyUsd, price);

        uint256 fee = (paidTokens * params.feeBps) / BPS;
        uint256 toProviders = paidTokens - fee + subsidyTokens;

        epochBudgetLeft -= subsidyTokens;
        poolBalance -= subsidyTokens;
        epochVolume += collectedRent;

        uint256 left = toProviders;
        for (uint256 i; i < payouts.length; ++i) {
            Payout calldata p = payouts[i];
            uint256 amount = i == payouts.length - 1 ? left : (toProviders * p.rentUsd) / rentTotal;
            left -= amount;
            earned[p.provider] += amount;
        }

        if (fee > 0) _burnFee(fee);
        emit BatchSettled(currentEpoch, price, collectedRent, paidTokens, subsidyTokens, fee);
    }

    /// @dev The fee is destroyed. The token's own burn() is tried first, which lowers its total supply. A token
    /// without one, or one whose burn() does nothing, gets the fee sent to BURN_ADDRESS instead, so it is out
    /// of circulation either way. The balance is read before and after, so a burn() that only pretends is caught.
    function _burnFee(uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        try IBurnable(address(token)).burn(amount) {} catch {}
        bool destroyed = before - token.balanceOf(address(this)) >= amount;
        if (!destroyed) token.safeTransfer(BURN_ADDRESS, amount);
        totalBurned += amount;
        emit FeeBurned(amount, destroyed);
    }

    /// @return skip 0 when charged, otherwise why not. Nothing moves when it is not 0.
    function _charge(Charge calldata c, uint256 owed) internal returns (uint8 skip) {
        if (block.timestamp > c.expiry) return SKIP_EXPIRED;
        if (!_validSignature(c.buyer, voucherDigest(c.buyer, c.cumulativeCap, c.expiry), c.signature)) return SKIP_SIGNATURE;
        uint256 newSpent = spent[c.buyer] + owed;
        if (newSpent > c.cumulativeCap) return SKIP_OVER_CAP;
        if (owed > deposits[c.buyer]) return SKIP_DEPOSIT;
        spent[c.buyer] = newSpent;
        deposits[c.buyer] -= owed;
        return 0;
    }

    /// @dev Like OpenZeppelin's SignatureChecker, but a contract wallet gets limited gas and any
    /// failure in it counts as a bad signature, so it cannot break a batch for everyone else.
    function _validSignature(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }
        (bool ok, bytes memory ret) = signer.staticcall{gas: ERC1271_GAS}(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
    }

    // ---------------------------------------------------------------- providers

    function claim() external nonReentrant {
        uint256 amount = earned[msg.sender];
        if (amount == 0) revert ZeroAmount();
        earned[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 received = _pullToken(amount);
        stakes[msg.sender] += received;
        emit Staked(msg.sender, received);
    }

    function isStaked(address provider) external view returns (bool) {
        uint256 s = stakes[provider];
        uint256 leaving = unstakeAmount[provider];
        if (leaving >= s) return false; // a slash can leave less than the pending unstake
        return s - leaving >= params.minStake;
    }

    function requestUnstake(uint256 amount) external {
        if (amount == 0 || amount > stakes[msg.sender]) revert ZeroAmount();
        uint256 readyAt = block.timestamp + params.unstakeDelay;
        unstakeAmount[msg.sender] = amount;
        unstakeReadyAt[msg.sender] = readyAt;
        emit UnstakeRequested(msg.sender, amount, readyAt);
    }

    function unstake() external nonReentrant {
        uint256 amount = unstakeAmount[msg.sender];
        if (amount == 0 || block.timestamp < unstakeReadyAt[msg.sender]) revert StakeLocked();
        if (amount > stakes[msg.sender]) amount = stakes[msg.sender]; // slashed meanwhile
        unstakeAmount[msg.sender] = 0;
        stakes[msg.sender] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Slashed tokens go back to the discount pool.
    function slash(address provider, uint256 amount, bytes32 reason) external onlyRole(SLASHER_ROLE) {
        if (amount > stakes[provider]) amount = stakes[provider];
        stakes[provider] -= amount;
        poolBalance += amount;
        emit Slashed(provider, amount, reason);
    }

    // ---------------------------------------------------------------- pool and admin

    function fundPool(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 received = _pullToken(amount);
        poolBalance += received;
        emit PoolFunded(msg.sender, received);
    }

    /// @notice The admin takes tokens back out of the discount pool. Only the pool: deposits, stakes and earnings are not part of it.
    function withdrawPool(uint256 amount, address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > poolBalance) amount = poolBalance;
        poolBalance -= amount;
        token.safeTransfer(to, amount);
        emit PoolWithdrawn(to, amount);
    }

    function setParams(Params calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validate(p);
        rollEpoch(); // epochOf uses epochLength, close the epoch under the old one
        params = p;
        currentEpoch = epochOf(block.timestamp);
        emit ParamsUpdated();
        emit EpochRolled(currentEpoch, discountBps, safePrice(), epochVolume);
    }

    function setPriceFeed(IPriceFeed feed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        priceFeed = feed;
        emit PriceFeedSet(address(feed));
    }

    function setSwap(ITokenSwap s) external onlyRole(DEFAULT_ADMIN_ROLE) {
        swap = s;
        emit SwapSet(address(s));
    }


    function _validate(Params memory p) internal pure {
        if (p.epochLength == 0 || p.minVolume == 0 || p.maxPriceAge == 0) revert BadParams();
        if (p.feeBps > 2_000 || p.maxDiscountBps > 9_000) revert BadParams();
    }
}
