// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function createSelectFork(string calldata endpoint, uint256 blockNumber) external returns (uint256);
    function selectFork(uint256 forkId) external;
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function expectRevert() external;
    function load(address target, bytes32 slot) external view returns (bytes32);
}

interface Token {
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface TicketNft {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface Jackpot {
    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

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
    function getDrawingState(uint256 id) external view returns (Drawing memory);
    function buyTickets(
        Ticket[] calldata tickets,
        address recipient,
        address[] calldata referrers,
        uint256[] calldata split,
        bytes32 source
    ) external returns (uint256[] memory);
    function claimWinnings(uint256[] calldata ids) external;
}

interface SafeFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 nonce)
        external
        returns (address);
}

interface Safe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address handler,
        address paymentToken,
        uint256 payment,
        address receiver
    ) external;
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 transactionNonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool);
}
