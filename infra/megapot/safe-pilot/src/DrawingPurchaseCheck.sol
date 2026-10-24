// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface DrawingSource {
    struct Drawing {
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
    function currentDrawingId() external view returns (uint256);
    function allowTicketPurchases() external view returns (bool);
    function getDrawingState(uint256 drawingId) external view returns (Drawing memory);
}

/// Candidate precondition for an atomic Safe MultiSendCallOnly purchase batch.
/// It holds no funds or permissions and cannot constrain batches that omit it.
contract DrawingPurchaseCheck {
    DrawingSource private constant JACKPOT = DrawingSource(0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2);
    error PurchaseUnavailable();

    function check(uint256 drawingId, uint256 validBefore, uint256 ticketPrice) external view {
        if (
            block.chainid != 8453 || block.timestamp >= validBefore || JACKPOT.currentDrawingId() != drawingId
                || !JACKPOT.allowTicketPurchases()
        ) {
            revert PurchaseUnavailable();
        }
        DrawingSource.Drawing memory drawing = JACKPOT.getDrawingState(drawingId);
        if (
            drawing.jackpotLock || validBefore > drawing.drawingTime || ticketPrice == 0
                || drawing.ticketPrice != ticketPrice
        ) {
            revert PurchaseUnavailable();
        }
    }
}
