// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ControlledMegapot, ControlledMegapotTicket, IControlledWinUsdc} from "../src/ControlledMegapot.sol";
import {ControlledUsdc} from "../src/ControlledUsdc.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function chainId(uint256 chainId) external;
    function warp(uint256 timestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ControlledMegapotTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CUSTODY = address(0xBEEF);
    address private constant REFERRER = address(0xCAFE);
    uint256 private constant PRICE = 10_000;
    uint256 private constant PRIZE = 1_000_000;

    ControlledUsdc private token;
    ControlledMegapot private jackpot;
    ControlledMegapotTicket private nft;

    function setUp() public {
        vm.chainId(84_532);
        token = new ControlledUsdc(2 * PRIZE + PRICE);
        jackpot = new ControlledMegapot(address(token), address(this), PRICE);
        nft = jackpot.jackpotNFT();
        token.transfer(address(jackpot), PRIZE);
        token.transfer(CUSTODY, PRICE);
        jackpot.armDrawing(block.timestamp + 3_600, PRIZE);
        vm.prank(CUSTODY);
        token.approve(address(jackpot), PRICE);
    }

    function _buy() private returns (uint256) {
        ControlledMegapot.TicketNumbers[] memory numbers = new ControlledMegapot.TicketNumbers[](1);
        numbers[0].normals = new uint8[](5);
        for (uint8 i; i < 5; ++i) {
            numbers[0].normals[i] = i + 1;
        }
        numbers[0].bonusball = 1;
        address[] memory referrers = new address[](1);
        referrers[0] = REFERRER;
        uint256[] memory split = new uint256[](1);
        split[0] = 1e18;
        vm.prank(CUSTODY);
        return jackpot.buyTickets(numbers, CUSTODY, referrers, split, bytes32(uint256(7)))[0];
    }

    function _hasTopic(Vm.Log[] memory logs, address emitter, bytes32 topic) private pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                return true;
            }
        }
        return false;
    }

    function testRealPurchaseAndWinningEventShapes() public {
        vm.recordLogs();
        uint256 ticketId = _buy();
        Vm.Log[] memory purchase = vm.getRecordedLogs();
        require(ticketId == 1 && nft.ownerOf(ticketId) == CUSTODY, "ticket not custodied");
        require(
            _hasTopic(
                purchase,
                address(jackpot),
                keccak256("TicketPurchased(address,uint256,bytes32,uint256,uint8[],uint8,bytes32)")
            ),
            "purchase event absent"
        );
        require(
            _hasTopic(
                purchase,
                address(jackpot),
                keccak256("TicketOrderProcessed(address,address,uint256,uint256,uint256,uint256)")
            ),
            "order event absent"
        );
        require(_hasTopic(purchase, address(nft), keccak256("Transfer(address,address,uint256)")), "mint event absent");

        vm.warp(block.timestamp + 3_601);
        jackpot.settleDrawing();
        require(jackpot.currentDrawingId() == 2, "drawing did not advance");
        ControlledMegapot.DrawingState memory state = jackpot.getDrawingState(1);
        require(state.winningTicket == ticketId && state.jackpotLock, "win not settled");
        uint256[] memory ids = new uint256[](1);
        ids[0] = ticketId;
        require(jackpot.getTicketTierIds(ids)[0] == 1, "wrong tier");
        require(jackpot.getDrawingTierPayouts(1)[1] == PRIZE, "wrong prize");

        uint256 beforeBalance = token.balanceOf(CUSTODY);
        vm.recordLogs();
        vm.prank(CUSTODY);
        jackpot.claimWinnings(ids);
        Vm.Log[] memory claim = vm.getRecordedLogs();
        require(token.balanceOf(CUSTODY) == beforeBalance + PRIZE, "custody not paid");
        require(jackpot.reservedPayout() == 0, "payout remains reserved");
        require(
            _hasTopic(
                claim,
                address(jackpot),
                keccak256("TicketWinningsClaimed(address,uint256,uint256,uint256,bool,uint256)")
            ),
            "claim event absent"
        );
        require(
            _hasTopic(claim, address(jackpot), keccak256("ReferralFeeCollected(address,uint256)")),
            "referral event absent"
        );
        require(_hasTopic(claim, address(nft), keccak256("Transfer(address,address,uint256)")), "burn event absent");
        require(
            _hasTopic(claim, address(token), keccak256("Transfer(address,address,uint256)")), "USDC transfer absent"
        );

        vm.prank(CUSTODY);
        (bool duplicate,) = address(jackpot).call(abi.encodeCall(ControlledMegapot.claimWinnings, (ids)));
        require(!duplicate, "duplicate payout accepted");
    }

    function testOnlyOneTicketAndNoMidDrawingRearm() public {
        _buy();
        (bool repeat,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.armDrawing, (block.timestamp + 7_200, PRIZE)));
        require(!repeat, "mid-drawing rearm accepted");
        ControlledMegapot.TicketNumbers[] memory numbers = new ControlledMegapot.TicketNumbers[](1);
        numbers[0].normals = new uint8[](5);
        address[] memory referrers = new address[](1);
        referrers[0] = REFERRER;
        uint256[] memory split = new uint256[](1);
        split[0] = 1e18;
        vm.prank(CUSTODY);
        (bool second,) = address(jackpot)
            .call(abi.encodeCall(ControlledMegapot.buyTickets, (numbers, CUSTODY, referrers, split, bytes32(0))));
        require(!second, "second ticket accepted");
    }

    function testUnfundedDrawCannotOpen() public {
        ControlledMegapot unfunded = new ControlledMegapot(address(token), address(this), PRICE);
        (bool accepted,) =
            address(unfunded).call(abi.encodeCall(ControlledMegapot.armDrawing, (block.timestamp + 3_600, PRIZE)));
        require(!accepted, "unfunded draw accepted");
    }

    function testEmptyPlaceholderCanMoveForwardButTicketedDrawingCannot() public {
        uint256 oldTime = jackpot.getDrawingState(1).drawingTime;
        vm.prank(CUSTODY);
        (bool notOperator,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.rescheduleEmptyDrawing, (block.timestamp + 600)));
        require(!notOperator, "non-operator rescheduled draw");
        (bool tooSoon,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.rescheduleEmptyDrawing, (block.timestamp + 120)));
        require(!tooSoon, "unsafe deadline accepted");
        uint256 earlyTime = block.timestamp + 600;
        jackpot.rescheduleEmptyDrawing(earlyTime);
        require(jackpot.getDrawingState(1).drawingTime == earlyTime, "deadline not moved");
        require(jackpot.reservedPayout() == PRIZE, "prize reservation changed");
        (bool later,) = address(jackpot).call(abi.encodeCall(ControlledMegapot.rescheduleEmptyDrawing, (oldTime)));
        require(!later, "deadline extended");
        _buy();
        (bool afterTicket,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.rescheduleEmptyDrawing, (block.timestamp + 300)));
        require(!afterTicket, "ticketed deadline changed");
        vm.warp(earlyTime + 1);
        jackpot.settleDrawing();
        require(jackpot.currentDrawingId() == 2, "short cycle did not settle");
        require(jackpot.getDrawingState(1).winningTicket == 1, "short cycle did not win");
    }

    function testEmptyPlaceholderReleasesPrizeForNextShortCycle() public {
        uint256 shortTime = block.timestamp + 600;
        vm.recordLogs();
        jackpot.rescheduleEmptyDrawing(shortTime);
        require(
            _hasTopic(
                vm.getRecordedLogs(), address(jackpot), keccak256("EmptyDrawingRescheduled(uint256,uint256,uint256)")
            ),
            "reschedule evidence absent"
        );
        vm.warp(shortTime + 1);
        jackpot.settleDrawing();
        require(jackpot.currentDrawingId() == 2, "empty drawing did not advance");
        require(jackpot.reservedPayout() == 0, "empty prize still reserved");
        jackpot.armDrawing(shortTime + 600, PRIZE);
        require(jackpot.allowTicketPurchases(), "next drawing not open");
        require(jackpot.reservedPayout() == PRIZE, "next prize not reserved");
    }

    function testFixedSupplyAndOutstandingPayoutReservation() public {
        require(token.totalSupply() == 2 * PRIZE + PRICE, "supply changed");
        uint256 ticketId = _buy();
        vm.warp(block.timestamp + 3_601);
        jackpot.settleDrawing();
        token.transfer(address(jackpot), PRIZE);
        jackpot.armDrawing(block.timestamp + 3_600, PRIZE);
        require(jackpot.reservedPayout() == 2 * PRIZE, "old win not reserved");
        uint256[] memory ids = new uint256[](1);
        ids[0] = ticketId;
        vm.prank(CUSTODY);
        jackpot.claimWinnings(ids);
        require(jackpot.reservedPayout() == PRIZE, "new prize not reserved");
        vm.warp(jackpot.getDrawingState(2).drawingTime + 1);
        jackpot.settleDrawing();
        require(jackpot.reservedPayout() == 0, "empty draw remains reserved");
    }

    function testSupplyCap() public {
        (bool accepted,) =
            address(new ControlledUsdc(1)).call(abi.encodeWithSignature("mint(address,uint256)", CUSTODY, 1));
        require(!accepted, "unexpected mint method");
        try new ControlledUsdc(10_000_001) {
            revert("oversized supply accepted");
        } catch {}
    }

    function testEarlySettlementRequiresOperatorAndExactPurchasedTicket() public {
        (bool empty,) = address(jackpot).call(abi.encodeCall(ControlledMegapot.settlePurchasedDrawing, (1, 1)));
        require(!empty, "empty drawing settled early");
        uint256 ticketId = _buy();
        vm.prank(CUSTODY);
        (bool outsider,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.settlePurchasedDrawing, (1, ticketId)));
        require(!outsider, "non-operator settled early");
        (bool wrongDrawing,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.settlePurchasedDrawing, (2, ticketId)));
        require(!wrongDrawing, "wrong drawing accepted");
        (bool wrongTicket,) =
            address(jackpot).call(abi.encodeCall(ControlledMegapot.settlePurchasedDrawing, (1, ticketId + 1)));
        require(!wrongTicket, "wrong ticket accepted");
        vm.recordLogs();
        jackpot.settlePurchasedDrawing(1, ticketId);
        require(
            _hasTopic(
                vm.getRecordedLogs(), address(jackpot), keccak256("TicketedDrawingSettledEarly(uint256,uint256)")
            ),
            "early settlement evidence absent"
        );
        require(jackpot.currentDrawingId() == 2, "purchased drawing did not advance");
        require(jackpot.reservedPayout() == PRIZE, "winning obligation lost");
        (bool replay,) = address(jackpot).call(abi.encodeCall(ControlledMegapot.settlePurchasedDrawing, (1, ticketId)));
        require(!replay, "early settlement replay accepted");
    }

    function testLossHasNoWinningTierAndReleasesPrizeWithoutPayingCustody() public {
        vm.warp(jackpot.getDrawingState(1).drawingTime + 1);
        jackpot.settleDrawing();
        jackpot.armDrawingWithOutcome(block.timestamp + 600, PRIZE, true);
        require(jackpot.forcedLoss(2), "losing outcome not fixed");
        uint256 ticketId = _buy();
        uint256 beforeBalance = token.balanceOf(CUSTODY);
        jackpot.settlePurchasedDrawing(2, ticketId);
        uint256[] memory ids = new uint256[](1);
        ids[0] = ticketId;
        require(jackpot.getTicketTierIds(ids)[0] == 0, "loss reported winning tier");
        require(jackpot.getDrawingTierPayouts(2)[1] == 0, "loss retained winning payout");
        require(jackpot.getDrawingState(2).winningTicket > 0, "production sweep sees pending draw");
        require(jackpot.reservedPayout() == 0, "losing prize still reserved");
        vm.prank(CUSTODY);
        (bool paid,) = address(jackpot).call(abi.encodeCall(ControlledMegapot.claimWinnings, (ids)));
        require(!paid && token.balanceOf(CUSTODY) == beforeBalance, "losing ticket paid");
        jackpot.armDrawing(block.timestamp + 600, PRIZE);
        require(jackpot.reservedPayout() == PRIZE, "released loss prize unavailable");
    }

    function testOutcomeCannotChangeAfterArmingOrPurchase() public {
        (bool beforeTicket,) = address(jackpot)
            .call(abi.encodeCall(ControlledMegapot.armDrawingWithOutcome, (block.timestamp + 600, PRIZE, true)));
        require(!beforeTicket, "armed outcome changed");
        _buy();
        (bool afterTicket,) = address(jackpot)
            .call(abi.encodeCall(ControlledMegapot.armDrawingWithOutcome, (block.timestamp + 600, PRIZE, true)));
        require(!afterTicket && !jackpot.forcedLoss(1), "purchased outcome changed");
    }

    function testLossDoesNotReleaseAnEarlierUnclaimedWin() public {
        uint256 oldTicketId = _buy();
        jackpot.settlePurchasedDrawing(1, oldTicketId);
        token.transfer(address(jackpot), PRIZE - PRICE);
        token.transfer(CUSTODY, PRICE);
        vm.prank(CUSTODY);
        token.approve(address(jackpot), PRICE);
        jackpot.armDrawingWithOutcome(block.timestamp + 600, PRIZE, true);
        uint256 losingTicket = _buy();
        jackpot.settlePurchasedDrawing(2, losingTicket);
        require(jackpot.reservedPayout() == PRIZE, "old winning prize released");
        uint256[] memory ids = new uint256[](1);
        ids[0] = oldTicketId;
        vm.prank(CUSTODY);
        jackpot.claimWinnings(ids);
        require(jackpot.reservedPayout() == 0, "old winning prize not paid");
    }
}
