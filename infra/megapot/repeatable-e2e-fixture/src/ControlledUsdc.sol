// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Fixed-supply test token for the isolated Base Sepolia win rehearsal.
/// @dev The deployer receives the entire supply. There is no mint or owner method.
contract ControlledUsdc {
    string public constant name = "Controlled Test USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supplyAtomic) {
        require(block.chainid == 84_532 && supplyAtomic > 0 && supplyAtomic <= 10_000_000, "invalid test supply");
        totalSupply = supplyAtomic;
        balanceOf[msg.sender] = supplyAtomic;
        emit Transfer(address(0), msg.sender, supplyAtomic);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _move(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[owner][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[owner][msg.sender] = permitted - amount;
        _move(owner, recipient, amount);
        return true;
    }

    function _move(address owner, address recipient, uint256 amount) private {
        require(recipient != address(0) && balanceOf[owner] >= amount, "invalid transfer");
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(owner, recipient, amount);
    }
}
