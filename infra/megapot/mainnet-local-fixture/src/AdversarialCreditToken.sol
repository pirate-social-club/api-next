// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice LOCAL fake-owner acceptance token, never a production asset.
contract AdversarialCreditToken {
    enum Mode { Normal, FalseAfterWrite, RevertAfterWrite, EmptyReturn, MalformedReturn, NoncanonicalBool, Reenter }
    mapping(address => uint256) public balanceOf;
    Mode public mode;
    address public callbackTarget;
    bytes public callbackData;
    bytes public callbackRevert;
    bool public callbackSucceeded;
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() { require(block.chainid == 8453, "local Base fixture only"); }
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function configure(Mode next, address target, bytes calldata data) external {
        mode = next; callbackTarget = target; callbackData = data;
        delete callbackRevert; callbackSucceeded = false;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient fixture balance");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        if (mode == Mode.FalseAfterWrite) return false;
        if (mode == Mode.RevertAfterWrite) revert("injected fixture failure");
        if (mode == Mode.EmptyReturn) assembly { return(0, 0) }
        if (mode == Mode.MalformedReturn) assembly { mstore(0, 1) return(31, 1) }
        if (mode == Mode.NoncanonicalBool) assembly { mstore(0, 2) return(0, 32) }
        if (mode == Mode.Reenter) (callbackSucceeded, callbackRevert) = callbackTarget.call(callbackData);
        return true;
    }
}
