// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";
import {FinalityCodec} from "@chainlink/contracts-ccip/contracts/libraries/FinalityCodec.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {IMessageTransmitterV2} from "./interfaces/ICCTP.sol";
import {UniswapV4Swapper} from "./UniswapV4Swapper.sol";
import {Action, Intent, IntentLib, Receipt} from "./libraries/Intent.sol";

/// Lives on Arc. USDC arrives over CCTP, the instruction arrives over CCIP, in either order. Orders are keyed
/// by the hash of the whole intent and the CCTP burn carries that hash, so funds only settle the intent they
/// were sent for. Once both are here the instruction runs and a receipt goes back to the source chain.
contract AndThenSettlement is CCIPReceiver, UniswapV4Swapper, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using IntentLib for Intent;

    enum Status {
        Open,
        Settled,
        Failed
    }

    struct Order {
        Intent intent;
        bool hasIntent;
        bool receiptSent;
        Status status;
        uint64 sourceChain;
        uint64 fundedAt;
        uint256 funded;
        uint256 delivered;
    }

    /// A chain that may send orders: our router there, and the CCTP TokenMessenger and USDC it burns with.
    struct Source {
        address router;
        bytes32 tokenMessenger;
        bytes32 usdc;
    }

    /// On Arc the native balance is USDC with 18 decimals, the ERC20 view of it has 6.
    uint256 public constant NATIVE_SCALE = 1e12;
    /// Funds whose intent never arrived can be rescued by the owner after this long.
    uint256 public constant RESCUE_DELAY = 1 days;

    IERC20 public immutable usdc;
    IMessageTransmitterV2 public immutable transmitter;
    /// The local TokenMessengerV2, the only valid recipient of a CCTP burn message.
    bytes32 public immutable tokenMessenger;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;

    /// CCIP chain selector => that chain's router and CCTP contracts.
    mapping(uint64 => Source) public sources;
    /// CCTP domain => CCIP chain selector of the same chain.
    mapping(uint32 => uint64) public domainSelectors;
    /// Output token => USDC pool used to reach it.
    mapping(address => PoolKey) public pools;
    /// ERC-4626 vaults with a USDC asset that Earn may deposit into.
    mapping(address => bool) public vaults;
    mapping(bytes32 => Order) internal orders;
    /// Refunds that could not be pushed, for the owner of the address to pull.
    mapping(address => uint256) public claimable;

    uint32 public receiptGasLimit = 200_000;
    bytes4 public allowedFinality = FinalityCodec._encodeBlockDepthAndSafeFlag(1);

    event IntentReceived(bytes32 indexed key, bytes32 indexed id, uint64 indexed sourceChain, address payer);
    event Funded(bytes32 indexed key, uint256 amount);
    event Settled(
        bytes32 indexed key,
        bytes32 indexed invoiceId,
        address payer,
        address indexed recipient,
        address token,
        uint256 amount
    );
    event PositionMinted(bytes32 indexed id, uint256 indexed tokenId, uint128 liquidity);
    event SettlementFailed(bytes32 indexed key, bytes reason);
    event ReceiptSent(bytes32 indexed key, bytes32 messageId, uint256 fee);
    event ReceiptSkipped(bytes32 indexed key, bytes reason);
    event Claimable(address indexed account, uint256 amount);
    event Rescued(bytes32 indexed key, address to, uint256 amount);

    error UnknownSource();
    error NotABurn();
    error DuplicateIntent();
    error WrongRecipient();
    error NothingMinted();
    error NoPool(address token);
    error OnlySelf();
    error Underfunded(uint256 funded, uint256 needed);
    error UnknownVault(address vault);
    error BelowMinimum(uint256 got, uint256 minimum);
    error NoLimit();
    error BadRange(int24 lower, int24 upper);
    error ReceiptUnpaid(uint256 cost);
    error NoReceiptDue();
    error FeeTooLow(uint256 fee);
    error NotRescuable();

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    constructor(
        address ccipRouter,
        IPoolManager _poolManager,
        IERC20 _usdc,
        IMessageTransmitterV2 _transmitter,
        address _tokenMessenger,
        IPositionManager _positionManager,
        IAllowanceTransfer _permit2,
        address initialOwner
    ) CCIPReceiver(ccipRouter) UniswapV4Swapper(_poolManager) Ownable(initialOwner) {
        usdc = _usdc;
        transmitter = _transmitter;
        tokenMessenger = bytes32(uint256(uint160(_tokenMessenger)));
        positionManager = _positionManager;
        permit2 = _permit2;
    }

    // Inbound

    function ccipReceive(Client.Any2EVMMessage calldata message) external override onlyRouter nonReentrant {
        _ccipReceive(message);
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sender = abi.decode(message.sender, (address));
        if (sender == address(0) || sources[message.sourceChainSelector].router != sender) revert UnknownSource();

        Intent memory intent = abi.decode(message.data, (Intent));
        bytes32 key = intent.key();
        Order storage order = orders[key];
        if (order.hasIntent) revert DuplicateIntent();

        order.intent = intent;
        order.hasIntent = true;
        order.sourceChain = message.sourceChainSelector;
        emit IntentReceived(key, intent.id, message.sourceChainSelector, intent.payer);

        _trySettle(key);
    }

    /// Relays a CCTP burn from one of our routers and mints the USDC here. Anyone can call it.
    function receiveFunds(bytes calldata message, bytes calldata attestation) external nonReentrant {
        // Header and burn message offsets: developers.circle.com/cctp/references/technical-guide#message-format
        Source memory source = sources[domainSelectors[uint32(bytes4(message[4:8]))]];
        if (source.router == address(0)) revert UnknownSource();
        // Only a TokenMessenger burn from that chain, addressed to ours and relayable only by us.
        if (
            bytes32(message[44:76]) != source.tokenMessenger || bytes32(message[76:108]) != tokenMessenger
                || bytes32(message[108:140]) != bytes32(uint256(uint160(address(this))))
        ) revert NotABurn();

        bytes calldata body = message[148:];
        if (bytes32(body[4:36]) != source.usdc) revert NotABurn();
        if (address(uint160(uint256(bytes32(body[100:132])))) != source.router) revert UnknownSource();
        if (address(uint160(uint256(bytes32(body[36:68])))) != address(this)) revert WrongRecipient();
        bytes32 key = bytes32(body[228:260]);

        uint256 before = usdc.balanceOf(address(this));
        transmitter.receiveMessage(message, attestation);
        uint256 minted = usdc.balanceOf(address(this)) - before;
        if (minted == 0) revert NothingMinted();

        Order storage order = orders[key];
        if (order.hasIntent && order.status != Status.Open) {
            // A burn for an order that already finished goes back to its payer.
            _refund(order.intent.refundAddress(), minted);
            return;
        }
        order.funded += minted;
        if (order.fundedAt == 0) order.fundedAt = uint64(block.timestamp);
        emit Funded(key, minted);

        _trySettle(key);
    }

    // Settlement

    function _trySettle(bytes32 key) internal {
        Order storage order = orders[key];
        if (!order.hasIntent || order.funded == 0 || order.status != Status.Open) return;

        Intent memory intent = order.intent;
        uint256 funded = order.funded;

        if (intent.deadline != 0 && block.timestamp > intent.deadline) {
            _fail(key, "expired");
            return;
        }

        try this.execute(intent, funded) returns (uint256 delivered, uint256 surplus) {
            order.status = Status.Settled;
            order.delivered = delivered;
            emit Settled(key, intent.invoiceId, intent.payer, intent.recipient, intent.token, delivered);
            _refund(intent.refundAddress(), surplus - _receipt(key, surplus));
        } catch (bytes memory reason) {
            _fail(key, reason);
        }
    }

    function _fail(bytes32 key, bytes memory reason) internal {
        Order storage order = orders[key];
        order.status = Status.Failed;
        emit SettlementFailed(key, reason);
        _refund(order.intent.refundAddress(), order.funded - _receipt(key, order.funded));
    }

    /// Runs the action. External so a failure can be caught and rolled back as a whole.
    function execute(Intent calldata intent, uint256 funded)
        external
        onlySelf
        returns (uint256 delivered, uint256 surplus)
    {
        if (intent.action == Action.Earn) return (_earn(intent, funded), 0);
        if (intent.action == Action.Provide) return _provide(intent, funded);

        bool direct = intent.token == address(usdc);
        uint256 spent;

        if (intent.action == Action.Pay) {
            delivered = intent.amount;
            if (direct) {
                if (funded < delivered) revert Underfunded(funded, delivered);
                spent = delivered;
            } else {
                if (intent.limit == 0) revert NoLimit();
                spent = _swapExactOut(_pool(intent.token), address(usdc), delivered, Math.min(intent.limit, funded));
            }
        } else {
            spent = funded;
            if (direct) {
                delivered = funded;
            } else {
                if (intent.amount == 0) revert NoLimit();
                delivered = _swapExactIn(_pool(intent.token), address(usdc), funded, intent.amount);
            }
            if (delivered < intent.amount) revert BelowMinimum(delivered, intent.amount);
        }

        IERC20(intent.token).safeTransfer(intent.recipient, delivered);
        surplus = funded - spent;
    }

    /// Deposits everything into a Morpho (ERC-4626) vault; the recipient gets the shares.
    function _earn(Intent calldata intent, uint256 funded) internal returns (uint256 shares) {
        if (!vaults[intent.token]) revert UnknownVault(intent.token);
        usdc.forceApprove(intent.token, funded);
        shares = IERC4626(intent.token).deposit(funded, intent.recipient);
        if (shares < intent.amount) revert BelowMinimum(shares, intent.amount);
    }

    /// Swaps half into the pool's other token and mints a position to the recipient.
    /// Returns the liquidity minted and the USDC left over; leftover of the other token goes to the recipient.
    function _provide(Intent calldata intent, uint256 funded) internal returns (uint256, uint256) {
        if (intent.limit == 0) revert NoLimit();
        PoolKey memory key = _pool(intent.token);
        IERC20 other = IERC20(intent.token);

        uint256 otherBefore = other.balanceOf(address(this));
        uint256 half = funded / 2;
        uint256 otherAmount = _swapExactIn(key, address(usdc), half, intent.limit);
        uint256 usdcAmount = funded - half;

        (int24 lower, int24 upper) = _range(intent.data, key.tickSpacing);
        bool usdcIsZero = Currency.unwrap(key.currency0) == address(usdc);
        (uint256 amount0, uint256 amount1) = usdcIsZero ? (usdcAmount, otherAmount) : (otherAmount, usdcAmount);

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        if (liquidity == 0) revert BelowMinimum(0, intent.amount);
        // Leave room for the rounding up PositionManager does when it prices the liquidity.
        liquidity -= liquidity / 10_000 + 1;
        if (liquidity < intent.amount) revert BelowMinimum(liquidity, intent.amount);

        _approvePositions(address(usdc), usdcAmount);
        _approvePositions(address(other), otherAmount);

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, lower, upper, uint256(liquidity), uint128(amount0), uint128(amount1), intent.recipient, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        uint256 tokenId = positionManager.nextTokenId();
        uint256 usdcBefore = usdc.balanceOf(address(this));
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR)), params),
            block.timestamp
        );
        emit PositionMinted(intent.id, tokenId, liquidity);

        usdc.forceApprove(address(permit2), 0);
        other.forceApprove(address(permit2), 0);

        uint256 otherLeft = other.balanceOf(address(this)) - otherBefore;
        if (otherLeft > 0) other.safeTransfer(intent.recipient, otherLeft);
        return (liquidity, usdcAmount - (usdcBefore - usdc.balanceOf(address(this))));
    }

    function _range(bytes calldata data, int24 spacing) internal pure returns (int24 lower, int24 upper) {
        if (data.length == 0) return (TickMath.minUsableTick(spacing), TickMath.maxUsableTick(spacing));
        (lower, upper) = abi.decode(data, (int24, int24));
        if (lower >= upper || lower % spacing != 0 || upper % spacing != 0) revert BadRange(lower, upper);
    }

    function _approvePositions(address token, uint256 amount) internal {
        IERC20(token).forceApprove(address(permit2), amount);
        permit2.approve(token, address(positionManager), uint160(amount), uint48(block.timestamp));
    }

    function _pool(address token) internal view returns (PoolKey memory key) {
        key = pools[token];
        if (key.tickSpacing == 0) revert NoPool(token);
    }

    // Money out

    /// Pushes a refund, or leaves it claimable when the push fails (a blocklisted address, for example).
    function _refund(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!usdc.trySafeTransfer(to, amount)) {
            claimable[to] += amount;
            emit Claimable(to, amount);
        }
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        claimable[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
    }

    /// Owner rescue for funds whose intent never arrived, once the delay has passed.
    function rescue(bytes32 key, address to) external onlyOwner nonReentrant {
        Order storage order = orders[key];
        if (order.hasIntent || order.funded == 0 || block.timestamp < order.fundedAt + RESCUE_DELAY) {
            revert NotRescuable();
        }
        uint256 amount = order.funded;
        order.funded = 0;
        order.status = Status.Failed;
        usdc.safeTransfer(to, amount);
        emit Rescued(key, to, amount);
    }

    // Receipts

    /// Sends the receipt if one is due, paid from `budget` of the order's own USDC. A receipt that cannot be
    /// quoted, paid or sent never blocks settlement; anyone can send it later with retryReceipt.
    function _receipt(bytes32 key, uint256 budget) internal returns (uint256 used) {
        if (orders[key].intent.replyTo == address(0)) return 0;
        try this.sendReceipt(key, budget) returns (uint256 cost) {
            orders[key].receiptSent = true;
            return cost;
        } catch (bytes memory reason) {
            emit ReceiptSkipped(key, reason);
            return 0;
        }
    }

    function sendReceipt(bytes32 key, uint256 budget) external onlySelf returns (uint256 cost) {
        Client.EVM2AnyMessage memory message = _receiptMessage(orders[key]);
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(orders[key].sourceChain, message);
        cost = Math.ceilDiv(fee, NATIVE_SCALE);
        if (cost > budget) revert ReceiptUnpaid(cost);
        bytes32 messageId = router.ccipSend{value: fee}(orders[key].sourceChain, message);
        emit ReceiptSent(key, messageId, fee);
    }

    /// Sends a receipt that was skipped, with the CCIP fee paid by the caller in native USDC.
    function retryReceipt(bytes32 key) external payable nonReentrant {
        Order storage order = orders[key];
        if (order.status == Status.Open || order.intent.replyTo == address(0) || order.receiptSent) {
            revert NoReceiptDue();
        }
        Client.EVM2AnyMessage memory message = _receiptMessage(order);
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(order.sourceChain, message);
        if (msg.value < fee) revert FeeTooLow(fee);
        order.receiptSent = true;
        bytes32 messageId = router.ccipSend{value: fee}(order.sourceChain, message);
        emit ReceiptSent(key, messageId, fee);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert FeeTooLow(fee);
        }
    }

    function _receiptMessage(Order storage order) internal view returns (Client.EVM2AnyMessage memory) {
        Intent memory intent = order.intent;
        return Client.EVM2AnyMessage({
            receiver: abi.encode(intent.replyTo),
            data: abi.encode(
                Receipt({
                    intentId: intent.id,
                    invoiceId: intent.invoiceId,
                    payer: intent.payer,
                    recipient: intent.recipient,
                    action: intent.action,
                    token: intent.token,
                    amount: order.delivered,
                    success: order.status == Status.Settled
                })
            ),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: ExtraArgsCodec._getBasicEncodedExtraArgsV3(receiptGasLimit, FinalityCodec.WAIT_FOR_FINALITY_FLAG)
        });
    }

    // Views

    function getOrder(bytes32 key) external view returns (Order memory) {
        return orders[key];
    }

    /// Lets the source chain use faster-than-finality for the instruction. Safe because funds only ever
    /// settle the exact intent their burn committed to.
    function getCCVsAndFinalityConfig(uint64, bytes calldata)
        external
        view
        override
        returns (address[] memory, address[] memory, uint8, bytes4)
    {
        return (new address[](0), new address[](0), 0, allowedFinality);
    }

    // Admin

    function setSource(uint64 selector, uint32 domain, address router, address remoteMessenger, address remoteUsdc)
        external
        onlyOwner
    {
        sources[selector] = Source({
            router: router,
            tokenMessenger: bytes32(uint256(uint160(remoteMessenger))),
            usdc: bytes32(uint256(uint160(remoteUsdc)))
        });
        domainSelectors[domain] = selector;
    }

    function setPool(address token, PoolKey calldata key) external onlyOwner {
        address other = Currency.unwrap(key.currency0) == address(usdc)
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
        if (other != token || address(key.hooks) != address(0)) revert NoPool(token);
        pools[token] = key;
    }

    function setVault(address vault, bool allowed) external onlyOwner {
        if (allowed && IERC4626(vault).asset() != address(usdc)) revert UnknownVault(vault);
        vaults[vault] = allowed;
    }

    function setReceiptGasLimit(uint32 gasLimit) external onlyOwner {
        receiptGasLimit = gasLimit;
    }

    function setAllowedFinality(bytes4 finality) external onlyOwner {
        allowedFinality = finality;
    }
}
