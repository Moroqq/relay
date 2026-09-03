// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

/**
 * RelayCollector
 *
 * Pulls TRC20 balances off many deposit addresses in one transaction and
 * deposits them in the treasury.
 *
 * WHY THIS EXISTS
 *
 * Without it, emptying a deposit address means a transaction signed by that
 * address, which means that address needs energy. With ten thousand user
 * wallets that is ten thousand addresses to keep funded or delegated to. With
 * this contract, each address grants an allowance once and every collection
 * afterwards is paid for by whoever calls `collect` — one account to rent
 * energy for instead of thousands.
 *
 * THE SECURITY PROBLEM THIS DESIGN ANSWERS
 *
 * Every user address grants this contract an unlimited allowance on their
 * USDT. That makes the contract, permanently, the most valuable thing in the
 * system: whoever controls it controls every deposit address at once.
 *
 * So the contract is built to be incapable of misusing that power rather than
 * merely unwilling. `treasury` is immutable — fixed in the constructor, with
 * no setter, no proxy, no upgrade path. There is no function that sends funds
 * anywhere else, no arbitrary call, no delegatecall, no selfdestruct. An
 * attacker who steals every private key in the company can move user funds to
 * the treasury and nowhere else.
 *
 * The cost of that guarantee is real: changing the treasury means deploying a
 * new contract and having every user address re-approve it. That is expensive
 * and slow, and it is the correct trade. A settable treasury turns a stolen
 * operator key into a total loss.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not run on a timer. No contract does. It moves nothing until an
 * operator sends it a transaction; the schedule lives in the sweeper.
 */

interface ITRC20 {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract RelayCollector {
    /// Where every collected token goes. Fixed for the life of the contract.
    address public immutable treasury;

    address public owner;
    mapping(address => bool) public isOperator;

    /**
     * A batch that runs out of energy reverts entirely and the fee is spent
     * for nothing, so the size is capped well below anything that could.
     */
    uint256 public constant MAX_BATCH = 120;

    /**
     * One event per batch rather than per address.
     *
     * The token contract already emits a Transfer log for every address we
     * pull from, and the indexer reads those. Emitting our own per-address
     * event would duplicate that information and pay energy for the privilege.
     */
    event Collected(address indexed token, uint256 addressCount, uint256 totalAmount);
    event OperatorSet(address indexed operator, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotOperator();
    error BatchTooLarge(uint256 given, uint256 maximum);
    error EmptyBatch();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    constructor(address treasury_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        owner = msg.sender;
        isOperator[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorSet(msg.sender, true);
    }

    /**
     * Move the full balance of `token` from each address to the treasury.
     *
     * `from` addresses must have approved this contract. Any that have not,
     * or that hold nothing, are skipped rather than reverting the batch: one
     * revoked allowance must not strand the other hundred and nineteen.
     *
     * The whole balance is taken rather than a caller-supplied amount. There
     * is nothing for a caller to get wrong, and no way to leave a remainder
     * behind by accident.
     */
    function collect(address token, address[] calldata from)
        external
        onlyOperator
        returns (uint256 collectedCount, uint256 totalAmount)
    {
        uint256 count = from.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge(count, MAX_BATCH);

        for (uint256 i = 0; i < count; ) {
            uint256 balance = _balanceOf(token, from[i]);
            if (balance != 0 && _pull(token, from[i], balance)) {
                unchecked {
                    collectedCount += 1;
                    totalAmount += balance;
                }
            }
            unchecked {
                i += 1;
            }
        }

        emit Collected(token, collectedCount, totalAmount);
    }

    /**
     * Read a balance without letting a hostile token halt the batch.
     * A token that reverts or returns nonsense yields zero, and its address
     * is skipped.
     */
    function _balanceOf(address token, address account) private view returns (uint256) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(ITRC20.balanceOf.selector, account));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    /**
     * Pull an allowance, tolerating the two shapes TRC20 tokens come in.
     *
     * The standard says `transferFrom` returns a bool, but a number of widely
     * used tokens return nothing at all. Treating a missing return value as
     * failure would skip them forever; treating a `false` as success would
     * record money that never moved. Both cases are distinguished here.
     */
    function _pull(address token, address account, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ITRC20.transferFrom.selector, account, treasury, amount)
        );
        if (!ok) return false;
        return data.length == 0 || abi.decode(data, (bool));
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /**
     * Ownership only governs who may operate. It cannot redirect funds — the
     * treasury is immutable — so a compromised owner is a nuisance rather than
     * a loss.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
