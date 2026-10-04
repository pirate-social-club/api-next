// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IControlledWinUsdc {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool);
}

contract ControlledMegapotTicket {
    address public immutable jackpot;
    mapping(uint256 => address) private owners;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    error NotJackpot();
    error TicketMissing();

    constructor(address jackpot_) {
        require(jackpot_ != address(0), "invalid jackpot");
        jackpot = jackpot_;
    }

    function ownerOf(uint256 ticketId) external view returns (address) {
        address owner = owners[ticketId];
        if (owner == address(0)) revert TicketMissing();
        return owner;
    }

    function mint(address recipient, uint256 ticketId) external {
        if (msg.sender != jackpot) revert NotJackpot();
        require(recipient != address(0) && owners[ticketId] == address(0), "invalid mint");
        owners[ticketId] = recipient;
        emit Transfer(address(0), recipient, ticketId);
    }

    function burn(address owner, uint256 ticketId) external {
        if (msg.sender != jackpot) revert NotJackpot();
        require(owners[ticketId] == owner, "invalid burn");
        delete owners[ticketId];
        emit Transfer(owner, address(0), ticketId);
    }
}

/// @notice Isolated Base Sepolia acceptance fixture with an outcome fixed before purchase.
/// @dev This contract cannot replace a production Megapot deployment or prove its randomness.
contract ControlledMegapot {
    struct TicketNumbers {
        uint8[] normals;
        uint8 bonusball;
    }

    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint256 drawingTime;
        uint256 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }

    struct TicketState {
        uint256 drawingId;
        address referrer;
        bool claimed;
    }

    IControlledWinUsdc public immutable usdc;
    ControlledMegapotTicket public immutable jackpotNFT;
    address public immutable operator;
    uint256 public immutable ticketPrice;
    uint256 public currentDrawingId = 1;
    uint256 public nextTicketId = 1;
    uint256 public reservedPayout;
    bool private entered;

    mapping(uint256 => DrawingState) private drawings;
    mapping(uint256 => uint256[12]) private payouts;
    mapping(uint256 => TicketState) private tickets;
    mapping(uint256 => bool) public forcedLoss;
    mapping(address => uint256) public referralFees;
    bool private armed;

    event TicketPurchased(
        address indexed recipient,
        uint256 indexed currentDrawingId,
        bytes32 indexed source,
        uint256 userTicketId,
        uint8[] normals,
        uint8 bonusball,
        bytes32 referralScheme
    );
    event TicketOrderProcessed(
        address indexed buyer,
        address indexed recipient,
        uint256 indexed currentDrawingId,
        uint256 numberOfTickets,
        uint256 lpEarnings,
        uint256 referralFees
    );
    event TicketWinningsClaimed(
        address indexed userAddress,
        uint256 indexed drawingId,
        uint256 userTicketId,
        uint256 matchedNormals,
        bool bonusballMatch,
        uint256 winningsAmount
    );
    event ReferralFeeCollected(address indexed referrer, uint256 amount);
    event EmptyDrawingRescheduled(uint256 indexed drawingId, uint256 oldTime, uint256 newTime);
    event OutcomeFixed(uint256 indexed drawingId, bool forceLoss);
    event TicketedDrawingSettledEarly(uint256 indexed drawingId, uint256 indexed ticketId);

    error NotOperator();
    error NotTicketOwner();
    error NoTicketsToClaim();
    error ReentrantCall();

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    constructor(address usdc_, address operator_, uint256 ticketPrice_) {
        require(block.chainid == 84_532, "Base Sepolia only");
        require(usdc_ != address(0) && operator_ != address(0) && ticketPrice_ > 0, "invalid setup");
        usdc = IControlledWinUsdc(usdc_);
        operator = operator_;
        ticketPrice = ticketPrice_;
        jackpotNFT = new ControlledMegapotTicket(address(this));
    }

    function armDrawing(uint256 drawingTime, uint256 payoutAtomic) external nonReentrant {
        _armDrawing(drawingTime, payoutAtomic, false);
    }

    function armDrawingWithOutcome(uint256 drawingTime, uint256 payoutAtomic, bool forceLoss) external nonReentrant {
        _armDrawing(drawingTime, payoutAtomic, forceLoss);
    }

    function _armDrawing(uint256 drawingTime, uint256 payoutAtomic, bool forceLoss) private {
        if (msg.sender != operator) revert NotOperator();
        require(!armed && drawingTime > block.timestamp + 120 && payoutAtomic > 0, "invalid drawing");
        require(usdc.balanceOf(address(this)) >= reservedPayout + payoutAtomic, "unfunded payout");
        DrawingState storage state = drawings[currentDrawingId];
        state.prizePool = payoutAtomic;
        state.ticketPrice = ticketPrice;
        state.drawingTime = drawingTime;
        state.ballMax = 50;
        state.bonusballMax = 10;
        state.payoutCalculator = address(this);
        forcedLoss[currentDrawingId] = forceLoss;
        payouts[currentDrawingId][1] = forceLoss ? 0 : payoutAtomic;
        reservedPayout += payoutAtomic;
        armed = true;
        emit OutcomeFixed(currentDrawingId, forceLoss);
    }

    /// @notice Bring a long placeholder forward so a fresh test cycle can run.
    /// @dev A purchased ticket fixes the drawing time; it cannot be shortened.
    function rescheduleEmptyDrawing(uint256 drawingTime) external {
        if (msg.sender != operator) revert NotOperator();
        DrawingState storage state = drawings[currentDrawingId];
        require(
            armed && state.globalTicketsBought == 0 && drawingTime > block.timestamp + 120
                && drawingTime < state.drawingTime,
            "invalid empty drawing reschedule"
        );
        uint256 oldTime = state.drawingTime;
        state.drawingTime = drawingTime;
        emit EmptyDrawingRescheduled(currentDrawingId, oldTime, drawingTime);
    }

    function allowTicketPurchases() external view returns (bool) {
        return armed && block.timestamp < drawings[currentDrawingId].drawingTime
            && drawings[currentDrawingId].globalTicketsBought == 0;
    }

    function getDrawingState(uint256 drawingId) external view returns (DrawingState memory) {
        return drawings[drawingId];
    }

    function getDrawingTierPayouts(uint256 drawingId) external view returns (uint256[12] memory) {
        return payouts[drawingId];
    }

    function getTicketTierIds(uint256[] calldata ticketIds) external view returns (uint256[] memory tierIds) {
        tierIds = new uint256[](ticketIds.length);
        for (uint256 i; i < ticketIds.length; ++i) {
            TicketState memory ticket = tickets[ticketIds[i]];
            require(ticket.drawingId != 0 && ticket.drawingId < currentDrawingId, "drawing open");
            tierIds[i] = forcedLoss[ticket.drawingId] ? 0 : 1;
        }
    }

    function buyTickets(
        TicketNumbers[] calldata numbers,
        address recipient,
        address[] calldata referrers,
        uint256[] calldata referralSplit,
        bytes32 source
    ) external nonReentrant returns (uint256[] memory ticketIds) {
        require(armed && block.timestamp < drawings[currentDrawingId].drawingTime, "drawing closed");
        require(drawings[currentDrawingId].globalTicketsBought == 0, "one ticket only");
        require(numbers.length == 1 && numbers[0].normals.length == 5, "one valid ticket");
        require(
            recipient != address(0) && referrers.length == 1 && referralSplit.length == 1 && referrers[0] != address(0)
                && referralSplit[0] == 1e18,
            "invalid recipient or referral"
        );
        require(numbers[0].bonusball >= 1 && numbers[0].bonusball <= 10, "invalid bonusball");
        for (uint256 i; i < 5; ++i) {
            uint8 normal = numbers[0].normals[i];
            require(normal >= 1 && normal <= 50, "invalid normal");
            for (uint256 j; j < i; ++j) {
                require(normal != numbers[0].normals[j], "duplicate normal");
            }
        }
        require(usdc.transferFrom(msg.sender, address(this), ticketPrice), "ticket payment failed");
        uint256 ticketId = nextTicketId++;
        ticketIds = new uint256[](1);
        ticketIds[0] = ticketId;
        tickets[ticketId] = TicketState(currentDrawingId, referrers[0], false);
        drawings[currentDrawingId].globalTicketsBought = 1;
        jackpotNFT.mint(recipient, ticketId);
        emit TicketPurchased(
            recipient, currentDrawingId, source, ticketId, numbers[0].normals, numbers[0].bonusball, bytes32(0)
        );
        emit TicketOrderProcessed(msg.sender, recipient, currentDrawingId, 1, 0, 0);
    }

    function settleDrawing() external {
        require(armed && block.timestamp >= drawings[currentDrawingId].drawingTime, "not due");
        _settleDrawing();
    }

    /// @notice Test control only. The runner first verifies the jobs receipt read.
    function settlePurchasedDrawing(uint256 expectedDrawingId, uint256 expectedTicketId) external {
        if (msg.sender != operator) revert NotOperator();
        require(
            armed && currentDrawingId == expectedDrawingId && drawings[currentDrawingId].globalTicketsBought == 1
                && expectedTicketId == nextTicketId - 1 && tickets[expectedTicketId].drawingId == currentDrawingId,
            "unexpected purchased drawing"
        );
        emit TicketedDrawingSettledEarly(currentDrawingId, expectedTicketId);
        _settleDrawing();
    }

    function _settleDrawing() private {
        DrawingState storage state = drawings[currentDrawingId];
        if (state.globalTicketsBought == 0 || forcedLoss[currentDrawingId]) {
            reservedPayout -= state.prizePool;
        }
        if (state.globalTicketsBought > 0) {
            // The production sweep uses this nonzero draw result as its settled signal.
            // The purchased ticket's tier, rather than this reference, decides winnings.
            state.winningTicket = nextTicketId - 1;
        }
        state.jackpotLock = true;
        armed = false;
        ++currentDrawingId;
    }

    function claimWinnings(uint256[] calldata ticketIds) external nonReentrant {
        if (ticketIds.length != 1) revert NoTicketsToClaim();
        uint256 ticketId = ticketIds[0];
        TicketState storage ticket = tickets[ticketId];
        if (ticket.drawingId == 0 || ticket.drawingId >= currentDrawingId || ticket.claimed) {
            revert NoTicketsToClaim();
        }
        if (jackpotNFT.ownerOf(ticketId) != msg.sender) revert NotTicketOwner();
        uint256 amount = payouts[ticket.drawingId][1];
        if (amount == 0) revert NoTicketsToClaim();
        ticket.claimed = true;
        reservedPayout -= amount;
        jackpotNFT.burn(msg.sender, ticketId);
        emit TicketWinningsClaimed(msg.sender, ticket.drawingId, ticketId, 5, true, amount);
        emit ReferralFeeCollected(ticket.referrer, 0);
        require(usdc.transfer(msg.sender, amount), "payout failed");
    }
}
