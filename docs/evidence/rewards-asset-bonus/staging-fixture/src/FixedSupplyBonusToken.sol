// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Fixed-supply, staging-only ERC-20 fixture with no privileged surface.
contract FixedSupplyBonusToken {
    string public constant name = "Pirate Staging Bonus";
    string public constant symbol = "PSTB";
    uint8 public constant decimals = 6;

    uint256 public constant totalSupply = 1_000_000_000_000;
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidInitialHolder();
    error InvalidRecipient();

    constructor(address initialHolder) {
        if (initialHolder == address(0)) revert InvalidInitialHolder();
        balanceOf[initialHolder] = totalSupply;
        emit Transfer(address(0), initialHolder, totalSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) {
            if (permitted < value) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = permitted - value;
            }
            emit Approval(from, msg.sender, permitted - value);
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert InvalidRecipient();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
