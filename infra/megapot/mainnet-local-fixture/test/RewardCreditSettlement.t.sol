// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RewardCreditSettlement} from "../src/RewardCreditSettlement.sol";

interface VmCredit {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function chainId(uint256 chainId) external;
    function warp(uint256 timestamp) external;
}

contract LocalToken {
    mapping(address => uint256) public balanceOf;
    bool public fail;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setFail(bool value) external { fail = value; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (fail || balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
}

// Interface double only. Passing this suite does NOT prove actual Safe integration.
contract LocalSafeInterfaceDouble {
    mapping(address => bool) public enabledModules;
    function enable(address value) external { require(value != address(0)); enabledModules[value] = true; }
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external returns (bool success, bytes memory result)
    {
        require(enabledModules[msg.sender] && value == 0 && operation == 0);
        return to.call(data);
    }
}

contract RewardCreditSettlementTest {
    VmCredit private constant vm = VmCredit(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant TEST_AUTHORITY = 12345;
    address private constant RECIPIENT = address(0xBEEF);
    LocalToken private token;
    LocalSafeInterfaceDouble private root;
    RewardCreditSettlement private settlement;

    function setUp() public {
        vm.chainId(8453);
        token = new LocalToken(); root = new LocalSafeInterfaceDouble();
        settlement = new RewardCreditSettlement(address(root), address(token), vm.addr(TEST_AUTHORITY), 1000);
        root.enable(address(settlement)); token.mint(address(root), 2000);
    }

    function signed(bytes32 id, address recipient, uint256 amount, uint256 until, uint256 key)
        private returns (bytes memory)
    {
        return signedFor(settlement, id, recipient, amount, until, key);
    }

    function signedFor(RewardCreditSettlement target, bytes32 id, address recipient, uint256 amount, uint256 until, uint256 key)
        private returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.creditDigest(id, recipient, amount, until));
        return abi.encodeCall(target.settle, (id, recipient, amount, until, v, r, s));
    }

    function expectInvalidCredit(RewardCreditSettlement target, bytes memory data) private {
        (bool ok, bytes memory reason) = address(target).call(data);
        require(!ok, "cross-module credit accepted");
        require(keccak256(reason) == keccak256(abi.encodeWithSelector(RewardCreditSettlement.InvalidCredit.selector)),
            "rejected for a reason other than InvalidCredit");
    }

    function assertNoSettlement(RewardCreditSettlement other, bytes32 id) private view {
        require(token.balanceOf(address(root)) == 2000 && token.balanceOf(RECIPIENT) == 0, "balance changed");
        require(settlement.spentAtomic() == 0 && other.spentAtomic() == 0, "budget consumed");
        require(!settlement.consumed(id) && !other.consumed(id), "credit consumed");
    }

    function testSingleUseAndAggregateCapSurviveAnotherCredit() public {
        bytes memory first = signed(bytes32(uint256(1)), RECIPIENT, 600, block.timestamp + 60, TEST_AUTHORITY);
        (bool ok,) = address(settlement).call(first); require(ok);
        (ok,) = address(settlement).call(first); require(!ok, "duplicate spent");
        (ok,) = address(settlement).call(signed(bytes32(uint256(2)), RECIPIENT, 401, block.timestamp + 60, TEST_AUTHORITY));
        require(!ok, "aggregate cap exceeded");
        (ok,) = address(settlement).call(signed(bytes32(uint256(2)), RECIPIENT, 400, block.timestamp + 60, TEST_AUTHORITY));
        require(ok && settlement.spentAtomic() == 1000 && token.balanceOf(RECIPIENT) == 1000);
    }

    function testIndependentAuthorityAndExactRecipientAmountAndChain() public {
        bytes memory bad = signed(bytes32(uint256(1)), RECIPIENT, 500, block.timestamp + 60, 67890);
        (bool ok,) = address(settlement).call(bad); require(!ok, "untrusted credit");
        bytes memory good = signed(bytes32(uint256(1)), RECIPIENT, 500, block.timestamp + 60, TEST_AUTHORITY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_AUTHORITY,
            settlement.creditDigest(bytes32(uint256(1)), RECIPIENT, 500, block.timestamp + 60));
        (ok,) = address(settlement).call(abi.encodeCall(settlement.settle,
            (bytes32(uint256(1)), address(0xCAFE), 500, block.timestamp + 60, v, r, s)));
        require(!ok, "recipient changed");
        (ok,) = address(settlement).call(abi.encodeCall(settlement.settle,
            (bytes32(uint256(1)), RECIPIENT, 501, block.timestamp + 60, v, r, s)));
        require(!ok, "amount changed");
        vm.chainId(1); (ok,) = address(settlement).call(good); require(!ok, "cross-chain credit"); vm.chainId(8453);
        require(settlement.spentAtomic() == 0 && !settlement.consumed(bytes32(uint256(1))));
    }

    function testEnabledModulesRejectCrossDomainCopiesAndAcceptOwnSignatures() public {
        RewardCreditSettlement other = new RewardCreditSettlement(address(root), address(token), vm.addr(TEST_AUTHORITY), 1000);
        root.enable(address(other));
        require(root.enabledModules(address(settlement)) && root.enabledModules(address(other)), "module not enabled");
        bytes32 id = bytes32(uint256(1)); uint256 until = block.timestamp + 60;
        bytes memory first = signedFor(settlement, id, RECIPIENT, 500, until, TEST_AUTHORITY);
        bytes memory second = signedFor(other, id, RECIPIENT, 500, until, TEST_AUTHORITY);
        expectInvalidCredit(other, first);
        assertNoSettlement(other, id);
        expectInvalidCredit(settlement, second);
        assertNoSettlement(other, id);

        // Both admission paths work. Cross-domain copies above must fail at
        // signature verification, rather than the Safe double's module gate.
        (bool ok,) = address(settlement).call(first); require(ok, "first own signature rejected");
        require(settlement.spentAtomic() == 500 && settlement.consumed(id));
        require(other.spentAtomic() == 0 && !other.consumed(id));
        require(token.balanceOf(address(root)) == 1500 && token.balanceOf(RECIPIENT) == 500);
        (ok,) = address(other).call(second); require(ok, "second own signature rejected");
        require(settlement.spentAtomic() == 500 && other.spentAtomic() == 500);
        require(settlement.consumed(id) && other.consumed(id));
        require(token.balanceOf(address(root)) == 1000 && token.balanceOf(RECIPIENT) == 1000);
    }

    function testTransferFailureRollsBackCreditAndBudgetAndCanRecover() public {
        bytes memory data = signed(bytes32(uint256(1)), RECIPIENT, 500, block.timestamp + 60, TEST_AUTHORITY);
        token.setFail(true); (bool ok,) = address(settlement).call(data); require(!ok);
        require(!settlement.consumed(bytes32(uint256(1))) && settlement.spentAtomic() == 0);
        token.setFail(false); (ok,) = address(settlement).call(data); require(ok);
        require(settlement.consumed(bytes32(uint256(1))) && token.balanceOf(RECIPIENT) == 500);
    }

    function testExpiredCreditCannotConsumeBudget() public {
        bytes memory data = signed(bytes32(uint256(1)), RECIPIENT, 500, block.timestamp + 1, TEST_AUTHORITY);
        vm.warp(block.timestamp + 2); (bool ok,) = address(settlement).call(data); require(!ok);
        require(settlement.spentAtomic() == 0);
    }

    function testDisabledModuleCannotConsumeCreditOrBudget() public {
        RewardCreditSettlement disabled = new RewardCreditSettlement(address(root), address(token), vm.addr(TEST_AUTHORITY), 1000);
        require(!root.enabledModules(address(disabled)), "disabled module enabled");
        bytes32 id = bytes32(uint256(1)); uint256 until = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_AUTHORITY, disabled.creditDigest(id, RECIPIENT, 500, until));
        (bool ok,) = address(disabled).call(abi.encodeCall(disabled.settle, (id, RECIPIENT, 500, until, v, r, s)));
        require(!ok && disabled.spentAtomic() == 0 && !disabled.consumed(id));
    }
}
