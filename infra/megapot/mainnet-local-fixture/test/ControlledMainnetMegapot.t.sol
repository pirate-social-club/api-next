// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ControlledMainnetMegapot} from "../src/ControlledMainnetMegapot.sol";
import {ControlledMegapotTicket} from "repeatable-e2e-fixture/src/ControlledMegapot.sol";
import {ControlledUsdc} from "repeatable-e2e-fixture/src/ControlledUsdc.sol";

interface VmDrawing {
    function chainId(uint256 chainId) external;
    function prank(address sender) external;
}

contract ControlledMainnetMegapotTest {
    VmDrawing private constant vm = VmDrawing(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CUSTODY = address(0xBEEF);
    address private constant REFERRER = address(0xCAFE);
    ControlledUsdc private token;
    ControlledMainnetMegapot private jackpot;

    function setUp() public {
        // Reuse the unchanged token fixture under its Sepolia constructor guard.
        // The mainnet fork acceptance will instead use actual pinned Circle USDC.
        vm.chainId(84532); token = new ControlledUsdc(1000000); vm.chainId(8453);
        jackpot = new ControlledMainnetMegapot(address(token), address(this), 10000, 1e17);
        token.transfer(address(jackpot), 100100); token.transfer(CUSTODY, 10000);
        vm.prank(CUSTODY); token.approve(address(jackpot), 10000);
    }

    function buy() private returns (uint256) {
        ControlledMainnetMegapot.TicketNumbers[] memory numbers = new ControlledMainnetMegapot.TicketNumbers[](1);
        numbers[0].normals = new uint8[](5);
        for (uint8 i; i < 5; ++i) numbers[0].normals[i] = i + 1;
        numbers[0].bonusball = 1;
        address[] memory referrers = new address[](1); referrers[0] = REFERRER;
        uint256[] memory split = new uint256[](1); split[0] = 1e18;
        vm.prank(CUSTODY);
        return jackpot.buyTickets(numbers, CUSTODY, referrers, split, bytes32(uint256(1)))[0];
    }

    function testWinConservesGrossReferralAndNetAndRetainsReferralLiability() public {
        jackpot.armDrawingWithOutcome(block.timestamp + 3600, 1001, false);
        uint256 ticketId = buy(); jackpot.settlePurchasedDrawing(1, ticketId);
        uint256[] memory ids = new uint256[](1); ids[0] = ticketId;
        require(jackpot.getTicketTierIds(ids)[0] == 1);
        vm.prank(CUSTODY); jackpot.claimWinnings(ids);
        require(token.balanceOf(CUSTODY) == 901 && jackpot.referralFees(REFERRER) == 100);
        require(jackpot.reservedPayout() == 100, "referral liability released");
        vm.prank(CUSTODY);
        (bool ok,) = address(jackpot).call(abi.encodeCall(jackpot.claimWinnings, (ids)));
        require(!ok && token.balanceOf(CUSTODY) == 901, "duplicate claim");
    }

    function testLossCannotClaimAndReleasesOnlyItsOwnPrize() public {
        jackpot.armDrawingWithOutcome(block.timestamp + 3600, 1001, true);
        uint256 ticketId = buy(); jackpot.settlePurchasedDrawing(1, ticketId);
        uint256[] memory ids = new uint256[](1); ids[0] = ticketId;
        require(jackpot.getTicketTierIds(ids)[0] == 0 && jackpot.reservedPayout() == 0);
        require(ControlledMegapotTicket(address(jackpot.jackpotNFT())).ownerOf(ticketId) == CUSTODY);
        vm.prank(CUSTODY);
        (bool ok,) = address(jackpot).call(abi.encodeCall(jackpot.claimWinnings, (ids)));
        require(!ok && token.balanceOf(CUSTODY) == 0, "losing ticket paid");
    }

    function testLaterLossPreservesEarlierUnclaimedWin() public {
        jackpot.armDrawingWithOutcome(block.timestamp + 3600, 1001, false);
        uint256 first = buy(); jackpot.settlePurchasedDrawing(1, first);
        jackpot.armDrawingWithOutcome(block.timestamp + 3600, 2002, true);
        token.transfer(CUSTODY, 10000); vm.prank(CUSTODY); token.approve(address(jackpot), 10000);
        uint256 second = buy(); jackpot.settlePurchasedDrawing(2, second);
        require(jackpot.reservedPayout() == 1001, "earlier win released");
        uint256[] memory ids = new uint256[](1); ids[0] = first;
        vm.prank(CUSTODY); jackpot.claimWinnings(ids);
        require(jackpot.reservedPayout() == 100 && token.balanceOf(CUSTODY) == 901);
    }
}
