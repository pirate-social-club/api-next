// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedSupplyBonusToken} from "../src/FixedSupplyBonusToken.sol";

contract TokenSpender {
    function move(FixedSupplyBonusToken token, address from, address to, uint256 value) external returns (bool) {
        return token.transferFrom(from, to, value);
    }
}

contract FixedSupplyBonusTokenTest {
    uint256 private constant SUPPLY = 1_000_000_000_000;
    FixedSupplyBonusToken private token;
    TokenSpender private spender;

    function setUp() public {
        token = new FixedSupplyBonusToken(address(this));
        spender = new TokenSpender();
    }

    function testMetadataAndFixedSupply() public view {
        require(keccak256(bytes(token.name())) == keccak256("Pirate Staging Bonus"));
        require(keccak256(bytes(token.symbol())) == keccak256("PSTB"));
        require(token.decimals() == 6);
        require(token.totalSupply() == SUPPLY);
        require(token.balanceOf(address(this)) == SUPPLY);
    }

    function testTransferMovesTheExactAmount() public {
        address recipient = address(0xBEEF);
        require(token.transfer(recipient, 25_000_000));
        require(token.balanceOf(address(this)) == SUPPLY - 25_000_000);
        require(token.balanceOf(recipient) == 25_000_000);
        require(token.totalSupply() == SUPPLY);
    }

    function testAllowanceMovesTheExactAmount() public {
        address recipient = address(0xCAFE);
        require(token.approve(address(spender), 40_000_000));
        require(spender.move(token, address(this), recipient, 15_000_000));
        require(token.allowance(address(this), address(spender)) == 25_000_000);
        require(token.balanceOf(recipient) == 15_000_000);
        require(token.totalSupply() == SUPPLY);
    }

    function testInsufficientBalanceAndAllowanceRevert() public {
        (bool balanceCall,) = address(token).call(abi.encodeCall(token.transfer, (address(0xBEEF), SUPPLY + 1)));
        require(!balanceCall);

        (bool allowanceCall,) =
            address(spender).call(abi.encodeCall(spender.move, (token, address(this), address(0xBEEF), 1)));
        require(!allowanceCall);
        require(token.totalSupply() == SUPPLY);
        require(token.balanceOf(address(this)) == SUPPLY);
    }
}
