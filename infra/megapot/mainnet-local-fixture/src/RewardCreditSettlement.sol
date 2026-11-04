// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IRewardSafeRoot {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external returns (bool success, bytes memory returnData);
}

/// @notice Source candidate for an independently authorized Safe payout module.
/// @dev No deployment, enabled module, credit authority or production cap is selected here.
contract RewardCreditSettlement {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant CREDIT_TYPEHASH = keccak256(
        "RewardCredit(bytes32 creditId,address safeRoot,address token,address recipient,uint256 amount,uint256 validUntil)"
    );
    uint256 private constant HALF_CURVE_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable safeRoot;
    address public immutable token;
    address public immutable independentCreditAuthority;
    uint256 public immutable aggregateCapAtomic;
    uint256 public spentAtomic;
    mapping(bytes32 => bool) public consumed;
    bool private entered;

    error InvalidConfiguration();
    error InvalidCredit();
    error CreditConsumed();
    error AggregateCapExceeded();
    error TransferFailed();
    error Reentrancy();

    event CreditSettled(bytes32 indexed creditId, address indexed recipient, uint256 amountAtomic);

    constructor(address safeRoot_, address token_, address independentCreditAuthority_, uint256 aggregateCapAtomic_) {
        if (safeRoot_.code.length == 0 || token_.code.length == 0 || independentCreditAuthority_ == address(0)
            || independentCreditAuthority_ == safeRoot_ || aggregateCapAtomic_ == 0) revert InvalidConfiguration();
        safeRoot = safeRoot_;
        token = token_;
        independentCreditAuthority = independentCreditAuthority_;
        aggregateCapAtomic = aggregateCapAtomic_;
    }

    function creditDigest(bytes32 creditId, address recipient, uint256 amountAtomic, uint256 validUntil)
        public view returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Pirate Reward Credit"),
            keccak256("1"), block.chainid, address(this)));
        bytes32 credit = keccak256(abi.encode(CREDIT_TYPEHASH, creditId, safeRoot, token, recipient, amountAtomic, validUntil));
        return keccak256(abi.encodePacked("\x19\x01", domain, credit));
    }

    function settle(bytes32 creditId, address recipient, uint256 amountAtomic, uint256 validUntil,
        uint8 v, bytes32 r, bytes32 s) external
    {
        if (entered) revert Reentrancy();
        if (creditId == bytes32(0) || recipient == address(0) || recipient == safeRoot || amountAtomic == 0
            || block.timestamp > validUntil || (v != 27 && v != 28) || uint256(s) > HALF_CURVE_ORDER)
            revert InvalidCredit();
        if (consumed[creditId]) revert CreditConsumed();
        if (amountAtomic > aggregateCapAtomic - spentAtomic) revert AggregateCapExceeded();
        address recovered = ecrecover(creditDigest(creditId, recipient, amountAtomic, validUntil), v, r, s);
        if (recovered == address(0) || recovered != independentCreditAuthority) revert InvalidCredit();
        entered = true;
        consumed[creditId] = true;
        spentAtomic += amountAtomic;
        (bool success, bytes memory result) = IRewardSafeRoot(safeRoot).execTransactionFromModuleReturnData(
            token, 0, abi.encodeWithSignature("transfer(address,uint256)", recipient, amountAtomic), 0
        );
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool)))))
            revert TransferFailed();
        entered = false;
        emit CreditSettled(creditId, recipient, amountAtomic);
    }
}
