// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

/**
 * Test doubles for the three shapes TRC20 tokens come in.
 *
 * The standard says transfer functions return a bool. Real tokens disagree:
 * some return nothing at all, some return false instead of reverting. The
 * collector has to tell those apart — treating a missing return value as
 * failure would skip such a token forever, and treating a false as success
 * would record money that never moved. Each case gets a token here.
 */

contract MockTRC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/** Returns nothing from transferFrom, as several widely used tokens do. */
contract NoReturnTRC20 is MockTRC20 {
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly { return(0, 0) }
    }
}

/** Reports failure by returning false rather than reverting. */
contract FalseTRC20 is MockTRC20 {
    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }
}

/** Reverts on everything, to prove one bad token cannot halt a batch. */
contract HostileTRC20 {
    function balanceOf(address) external pure returns (uint256) {
        revert("hostile");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("hostile");
    }
}
