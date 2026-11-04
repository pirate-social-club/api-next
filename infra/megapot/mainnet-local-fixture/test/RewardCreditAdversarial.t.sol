// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {RewardCreditSettlement} from "../src/RewardCreditSettlement.sol";
import {AdversarialCreditToken} from "../src/AdversarialCreditToken.sol";

interface VmAdversarialCredit {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function chainId(uint256 chainId) external;
}
// Interface double here; actual released Safe execution is a separate fork gate.
contract AdversarialSafeInterfaceDouble {
    address public module;
    function enable(address target) external { module = target; }
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external returns (bool success, bytes memory result)
    { require(msg.sender == module && value == 0 && operation == 0); return to.call(data); }
}
contract RewardCreditAdversarialTest {
    VmAdversarialCredit private constant vm = VmAdversarialCredit(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant AUTHORITY = 12345;
    address private constant RECIPIENT = address(0xBEEF);
    AdversarialCreditToken private token;
    AdversarialSafeInterfaceDouble private root;
    RewardCreditSettlement private settlement;
    function setUp() public {
        vm.chainId(8453); token = new AdversarialCreditToken(); root = new AdversarialSafeInterfaceDouble();
        settlement = new RewardCreditSettlement(address(root),address(token),vm.addr(AUTHORITY),1000);
        root.enable(address(settlement)); token.mint(address(root),2000);
    }
    function signed(uint256 id, uint256 amount) private returns (bytes memory) {
        uint256 until = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORITY,settlement.creditDigest(bytes32(id),RECIPIENT,amount,until));
        return abi.encodeCall(settlement.settle,(bytes32(id),RECIPIENT,amount,until,v,r,s));
    }
    function testFalseAfterWriteAndRevertAndMalformedReturnsRollBackEverything() public {
        bytes memory credit = signed(1,600);
        for (uint256 mode=1; mode<=5; mode++) {
            if (mode==3) continue; // Empty returns are an explicitly supported token boundary.
            token.configure(AdversarialCreditToken.Mode(mode),address(0),"");
            (bool ok,) = address(settlement).call(credit); require(!ok,"invalid token return admitted");
            require(token.balanceOf(address(root))==2000 && token.balanceOf(RECIPIENT)==0,"token writes survived rollback");
            require(!settlement.consumed(bytes32(uint256(1))) && settlement.spentAtomic()==0,"credit or budget survived rollback");
        }
        token.configure(AdversarialCreditToken.Mode.Normal,address(0),"");
        (bool success,) = address(settlement).call(credit); require(success && settlement.spentAtomic()==600);
    }
    function testEmptyReturnConservesBalancesAndConsumesExactlyOnce() public {
        token.configure(AdversarialCreditToken.Mode.EmptyReturn,address(0),"");
        bytes memory credit=signed(1,600); (bool ok,) = address(settlement).call(credit);
        require(ok && token.balanceOf(address(root))==1400 && token.balanceOf(RECIPIENT)==600);
        (ok,) = address(settlement).call(credit); require(!ok && settlement.spentAtomic()==600);
    }
    function reentry(uint256 innerId) private {
        bytes memory outer=signed(1,600); bytes memory inner=signed(innerId,400);
        token.configure(AdversarialCreditToken.Mode.Reenter,address(settlement),inner);
        (bool ok,) = address(settlement).call(outer); require(ok,"outer credit failed");
        require(!token.callbackSucceeded(),"nested credit succeeded");
        require(keccak256(token.callbackRevert())==keccak256(abi.encodeWithSelector(RewardCreditSettlement.Reentrancy.selector)),"wrong nested refusal");
        require(settlement.spentAtomic()==600 && token.balanceOf(address(root))==1400 && token.balanceOf(RECIPIENT)==600);
        require(settlement.consumed(bytes32(uint256(1))));
        if(innerId!=1) {
            require(!settlement.consumed(bytes32(innerId)),"different credit consumed by reentry");
            token.configure(AdversarialCreditToken.Mode.Normal,address(0),"");
            (ok,) = address(settlement).call(inner); require(ok && settlement.spentAtomic()==1000);
        }
    }
    function testSameCreditReentryIsPreciselyRefused() public { reentry(1); }
    function testDifferentValidCreditReentryIsPreciselyRefusedAndLaterRecovers() public { reentry(2); }
}
