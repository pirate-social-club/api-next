// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm, Token, TicketNft, Jackpot, SafeFactory, Safe} from "./Interfaces.sol";
import {DrawingPurchaseCheck} from "../src/DrawingPurchaseCheck.sol";

/// Local EVM forks only. These tests never broadcast transactions.
contract SafePilotTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant PIN = 52_944_896;
    uint256 private constant EARLIER_PIN = 52_890_000;
    uint256 private constant FIXTURE_KEY = 0x101;
    address private constant SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address private constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address private constant BATCH = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address private constant HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    Token private constant USDC = Token(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    Jackpot private constant JACKPOT = Jackpot(0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2);
    TicketNft private constant NFT = TicketNft(0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4);
    bytes32 private constant SOURCE = keccak256("pirate-safe-local-proof-v1");
    bytes32 private constant PURCHASE =
        keccak256("TicketPurchased(address,uint256,bytes32,uint256,uint8[],uint8,bytes32)");
    Safe private safe;

    function setUp() public {
        vm.createSelectFork("base", PIN);
        require(block.chainid == 8453 && block.number == PIN, "wrong fork");
        require(SINGLETON.codehash == 0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4, "Safe code");
        require(FACTORY.codehash == 0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317, "factory code");
        require(BATCH.codehash == 0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939, "batch code");
        require(
            address(JACKPOT).codehash == 0x597f3a8e9360fbfc2e623243507ee9e8a66609003078ffc33d9013cb0607002d,
            "Jackpot code"
        );
        require(address(NFT).codehash == 0xf08234474c8484705b2e855d9602b6e229359839fc7bad67c9157a9d5dd53ca8, "NFT code");
        require(
            address(USDC).codehash == 0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab,
            "USDC proxy code"
        );
        address implementation = address(
            uint160(uint256(vm.load(address(USDC), 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3)))
        );
        require(implementation == 0x2Ce6311ddAE708829bc0784C967b7d77D19FD779, "USDC implementation");
        require(
            implementation.codehash == 0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873,
            "USDC implementation code"
        );
        safe = _createSafe();
    }

    function _createSafe() private returns (Safe) {
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(FIXTURE_KEY);
        bytes memory init =
            abi.encodeCall(Safe.setup, (owners, 1, address(0), bytes(""), HANDLER, address(0), 0, address(0)));
        return Safe(SafeFactory(FACTORY).createProxyWithNonce(SINGLETON, init, 20261022));
    }

    // Impersonation exists only inside the fork; this is not funding evidence.
    function _fixtureFunds(uint256 amount) private {
        vm.prank(address(JACKPOT));
        require(USDC.transfer(address(safe), amount), "fixture funding");
    }

    function _signature(address to, bytes memory data, uint8 operation, uint256 gasLimit)
        private
        returns (bytes memory)
    {
        bytes32 digest = safe.getTransactionHash(
            to, 0, data, operation, gasLimit, 0, 0, address(0), address(0), safe.nonce()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(FIXTURE_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _execute(address to, bytes memory data, uint8 operation, uint256 gasLimit, bytes memory signature)
        private
        returns (bool)
    {
        return safe.execTransaction(to, 0, data, operation, gasLimit, 0, 0, address(0), payable(address(0)), signature);
    }

    function _call(address to, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), uint256(data.length), data);
    }

    function _batch(bytes memory calls) private pure returns (bytes memory) {
        return abi.encodeWithSignature("multiSend(bytes)", calls);
    }

    function _purchaseCalls(uint256 price) private view returns (bytes memory) {
        Jackpot.Ticket[] memory tickets = new Jackpot.Ticket[](1);
        tickets[0].normals = new uint8[](5);
        for (uint8 i; i < 5; ++i) {
            tickets[0].normals[i] = i + 1;
        }
        tickets[0].bonusball = 1;
        address[] memory referrers = new address[](1);
        referrers[0] = address(0xCAFE);
        uint256[] memory split = new uint256[](1);
        split[0] = 1e18;
        return bytes.concat(
            _call(address(USDC), abi.encodeCall(Token.approve, (address(JACKPOT), price))),
            _call(
                address(JACKPOT), abi.encodeCall(Jackpot.buyTickets, (tickets, address(safe), referrers, split, SOURCE))
            )
        );
    }

    function _purchaseBatch(uint256 price) private view returns (bytes memory) {
        return _batch(_purchaseCalls(price));
    }

    function _guardedPurchase(uint256 drawing, uint256 deadline, uint256 price) private returns (bytes memory) {
        DrawingPurchaseCheck check = new DrawingPurchaseCheck();
        return _batch(
            bytes.concat(
                _call(address(check), abi.encodeCall(DrawingPurchaseCheck.check, (drawing, deadline, price))),
                _purchaseCalls(price)
            )
        );
    }

    function _purchased(Vm.Log[] memory logs) private pure returns (uint256 id, uint256 drawing, address recipient) {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(JACKPOT) && logs[i].topics[0] == PURCHASE) {
                count++;
                recipient = address(uint160(uint256(logs[i].topics[1])));
                drawing = uint256(logs[i].topics[2]);
                require(logs[i].topics[3] == SOURCE, "wrong source");
                (id,,,) = abi.decode(logs[i].data, (uint256, uint8[], uint8, bytes32));
            }
        }
        require(count == 1, "purchase count");
    }

    function testSafeBuysAndOwnsActualMegapotTicket() public {
        uint256 drawing = JACKPOT.currentDrawingId();
        uint256 price = JACKPOT.getDrawingState(drawing).ticketPrice;
        _fixtureFunds(price);
        bytes memory data = _purchaseBatch(price);
        bytes memory signature = _signature(BATCH, data, 1, 0);
        vm.recordLogs();
        require(_execute(BATCH, data, 1, 0, signature), "purchase failed");
        (uint256 id, uint256 boughtDrawing, address recipient) = _purchased(vm.getRecordedLogs());
        require(boughtDrawing == drawing && recipient == address(safe), "purchase identity");
        require(NFT.ownerOf(id) == address(safe), "NFT not owned by Safe");
        require(USDC.balanceOf(address(safe)) == 0, "incorrect price");
        vm.expectRevert();
        _execute(BATCH, data, 1, 0, signature);
    }

    function testGuardedPurchaseSucceedsInItsDrawing() public {
        uint256 drawing = JACKPOT.currentDrawingId();
        Jackpot.Drawing memory state = JACKPOT.getDrawingState(drawing);
        _fixtureFunds(state.ticketPrice);
        bytes memory data = _guardedPurchase(drawing, state.drawingTime - 600, state.ticketPrice);
        bytes memory signature = _signature(BATCH, data, 1, 0);
        vm.recordLogs();
        require(_execute(BATCH, data, 1, 0, signature), "guarded purchase failed");
        (uint256 id, uint256 boughtDrawing,) = _purchased(vm.getRecordedLogs());
        require(boughtDrawing == drawing && NFT.ownerOf(id) == address(safe), "guarded ticket identity");
    }

    function _assertRefusedWithoutSpend(bytes memory data, uint256 balance) private {
        bytes memory signature = _signature(BATCH, data, 1, 0);
        uint256 beforeNonce = safe.nonce();
        uint256 beforeCount = JACKPOT.getDrawingState(JACKPOT.currentDrawingId()).globalTicketsBought;
        vm.expectRevert();
        _execute(BATCH, data, 1, 0, signature);
        require(USDC.balanceOf(address(safe)) == balance, "refused purchase spent funds");
        require(USDC.allowance(address(safe), address(JACKPOT)) == 0, "refused purchase left allowance");
        require(safe.nonce() == beforeNonce, "fully reverted Safe changed nonce");
        require(
            JACKPOT.getDrawingState(JACKPOT.currentDrawingId()).globalTicketsBought == beforeCount,
            "refused purchase minted a ticket"
        );
    }

    function testGuardRejectsDifferentDrawingWithoutSpend() public {
        uint256 drawing = JACKPOT.currentDrawingId();
        Jackpot.Drawing memory state = JACKPOT.getDrawingState(drawing);
        _fixtureFunds(state.ticketPrice);
        _assertRefusedWithoutSpend(
            _guardedPurchase(drawing - 1, state.drawingTime - 600, state.ticketPrice), state.ticketPrice
        );
    }

    function testGuardRejectsChangedPriceWithoutSpend() public {
        uint256 drawing = JACKPOT.currentDrawingId();
        Jackpot.Drawing memory state = JACKPOT.getDrawingState(drawing);
        _fixtureFunds(state.ticketPrice + 1);
        _assertRefusedWithoutSpend(
            _guardedPurchase(drawing, state.drawingTime - 600, state.ticketPrice + 1), state.ticketPrice + 1
        );
    }

    function testGuardRejectsDeadlineAfterProviderDrawingTime() public {
        uint256 drawing = JACKPOT.currentDrawingId();
        Jackpot.Drawing memory state = JACKPOT.getDrawingState(drawing);
        _fixtureFunds(state.ticketPrice);
        _assertRefusedWithoutSpend(
            _guardedPurchase(drawing, state.drawingTime + 1, state.ticketPrice), state.ticketPrice
        );
    }

    function testSignatureExpiresAtGuardDeadlineWithoutSpend() public {
        uint256 drawing = JACKPOT.currentDrawingId();
        Jackpot.Drawing memory state = JACKPOT.getDrawingState(drawing);
        _fixtureFunds(state.ticketPrice);
        uint256 deadline = block.timestamp + 60;
        bytes memory data = _guardedPurchase(drawing, deadline, state.ticketPrice);
        bytes memory signature = _signature(BATCH, data, 1, 0);
        vm.warp(deadline);
        vm.expectRevert();
        _execute(BATCH, data, 1, 0, signature);
        require(USDC.balanceOf(address(safe)) == state.ticketPrice, "expired purchase spent funds");
        require(USDC.allowance(address(safe), address(JACKPOT)) == 0, "expired purchase left allowance");
        require(safe.nonce() == 0, "expired purchase consumed nonce");
    }

    function testSafeClaimsHistoricalWinnerAndPaysTwoRecipients() public {
        // A public, unclaimed round-211 ticket is transferred only on this local fork.
        uint256 id = 14371299406963791530138717777561382263443749636064004594229813669810499573266;
        address historicalOwner = NFT.ownerOf(id);
        vm.prank(historicalOwner);
        NFT.transferFrom(historicalOwner, address(safe), id);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        bytes memory claim = abi.encodeCall(Jackpot.claimWinnings, (ids));
        bytes memory signature = _signature(address(JACKPOT), claim, 0, 0);
        require(_execute(address(JACKPOT), claim, 0, 0, signature), "claim failed");
        uint256 net = USDC.balanceOf(address(safe));
        require(net == 5_605_799, "unexpected actual net winnings");
        vm.expectRevert();
        NFT.ownerOf(id);
        vm.expectRevert();
        _execute(address(JACKPOT), claim, 0, 0, signature);

        address recipient1 = address(0x100001);
        address recipient2 = address(0x100002);
        uint256 before1 = USDC.balanceOf(recipient1);
        uint256 before2 = USDC.balanceOf(recipient2);
        uint256 amount1 = net / 2;
        uint256 amount2 = net - amount1;
        bytes memory payout = _batch(
            bytes.concat(
                _call(address(USDC), abi.encodeCall(Token.transfer, (recipient1, amount1))),
                _call(address(USDC), abi.encodeCall(Token.transfer, (recipient2, amount2)))
            )
        );
        bytes memory payoutSignature = _signature(BATCH, payout, 1, 0);
        require(_execute(BATCH, payout, 1, 0, payoutSignature), "payout failed");
        require(USDC.balanceOf(recipient1) - before1 == amount1, "recipient one");
        require(USDC.balanceOf(recipient2) - before2 == amount2, "recipient two");
        require(USDC.balanceOf(address(safe)) == 0, "payout total");
        vm.expectRevert();
        _execute(BATCH, payout, 1, 0, payoutSignature);
    }

    function testStaleSignedPurchaseBuysIntoLaterRealDrawing() public {
        vm.createSelectFork("base", EARLIER_PIN);
        safe = _createSafe();
        address expectedSafe = address(safe);
        uint256 intendedDrawing = JACKPOT.currentDrawingId();
        uint256 price = JACKPOT.getDrawingState(intendedDrawing).ticketPrice;
        bytes memory data = _purchaseBatch(price);
        bytes memory signature = _signature(BATCH, data, 1, 0);
        vm.createSelectFork("base", PIN);
        safe = _createSafe();
        require(address(safe) == expectedSafe, "fixture Safe identity changed");
        uint256 actualDrawing = JACKPOT.currentDrawingId();
        require(actualDrawing > intendedDrawing, "fixture did not cross drawings");
        _fixtureFunds(price);
        vm.recordLogs();
        require(_execute(BATCH, data, 1, 0, signature), "stale purchase unexpectedly refused");
        (, uint256 purchasedDrawing,) = _purchased(vm.getRecordedLogs());
        require(purchasedDrawing == actualDrawing && purchasedDrawing != intendedDrawing, "stale drawing reproduction");
    }

    function testConfirmedNonceCancellationInvalidatesQueuedSignature() public {
        _fixtureFunds(1_000_000);
        bytes memory payout = abi.encodeCall(Token.transfer, (address(0x100001), 1_000_000));
        bytes memory stale = _signature(address(USDC), payout, 0, 0);
        bytes memory cancellation = _signature(address(safe), bytes(""), 0, 0);
        require(_execute(address(safe), bytes(""), 0, 0, cancellation), "cancel failed");
        vm.expectRevert();
        _execute(address(USDC), payout, 0, 0, stale);
        require(USDC.balanceOf(address(safe)) == 1_000_000, "cancelled payment spent");
    }

    function testNewNonceDoesNotPreventPayingTheSameCreditTwice() public {
        _fixtureFunds(2_000_000);
        address recipient = address(0x100001);
        uint256 beforeBalance = USDC.balanceOf(recipient);
        bytes memory payout = abi.encodeCall(Token.transfer, (recipient, 1_000_000));
        require(_execute(address(USDC), payout, 0, 0, _signature(address(USDC), payout, 0, 0)), "first payout");
        require(_execute(address(USDC), payout, 0, 0, _signature(address(USDC), payout, 0, 0)), "second payout");
        require(USDC.balanceOf(recipient) - beforeBalance == 2_000_000, "duplicate effect reproduction");
    }

    function testBatchFailureRollsBackEarlierTransfer() public {
        _fixtureFunds(1_000_000);
        address recipient = address(0x100001);
        uint256 beforeBalance = USDC.balanceOf(recipient);
        bytes memory data = _batch(
            bytes.concat(
                _call(address(USDC), abi.encodeCall(Token.transfer, (recipient, 1_000_000))),
                _call(address(USDC), abi.encodeCall(Token.transfer, (address(0x100002), 1)))
            )
        );
        bytes memory signature = _signature(BATCH, data, 1, 0);
        vm.expectRevert();
        _execute(BATCH, data, 1, 0, signature);
        require(USDC.balanceOf(address(safe)) == 1_000_000, "failed batch spent");
        require(USDC.balanceOf(recipient) == beforeBalance, "partial payout survived");
        require(safe.nonce() == 0, "reverted batch consumed nonce");
    }

    function testSafeFailureCanConsumeNonceWithoutPaying() public {
        bytes memory payout = abi.encodeCall(Token.transfer, (address(0x100001), 1_000_000));
        bytes memory signature = _signature(address(USDC), payout, 0, 150_000);
        uint256 beforeNonce = safe.nonce();
        vm.recordLogs();
        require(!_execute(address(USDC), payout, 0, 150_000, signature), "expected inner failure");
        require(safe.nonce() == beforeNonce + 1, "failed nonce not consumed");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(safe) && logs[i].topics[0] == keccak256("ExecutionFailure(bytes32,uint256)"))
            {
                found = true;
            }
        }
        require(found, "Safe failure event missing");
    }
}
