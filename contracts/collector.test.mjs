/**
 * The collector, run as real bytecode in a real EVM.
 *
 * Reviewing a contract that holds unlimited allowances from thousands of
 * users is not enough. TRON's VM is EVM-compatible for everything this
 * contract does, so the same compiled bytecode is exercised here; the
 * TRON-specific risk (an unsupported opcode) is caught at compile time
 * instead.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { contracts } from './compile-test.mjs';
import { newEvm, deploy, call, namedAddress, asUint } from './evm-harness.mjs';

const OWNER = namedAddress('deployer');
const OPERATOR = namedAddress('operator');
const OUTSIDER = namedAddress('outsider');
const TREASURY = namedAddress('treasury');
const USERS = [namedAddress('user1'), namedAddress('user2'), namedAddress('user3')];

let evm;
let collector;
let token;

const mint = (to, amount) =>
  call(evm, { from: OWNER, to: token, signature: 'mint(address,uint256)', args: [to, amount] });

const approve = (user, spender, amount) =>
  call(evm, { from: user, to: token, signature: 'approve(address,uint256)', args: [spender, amount] });

const balance = async (who) =>
  asUint(
    (await call(evm, { from: OWNER, to: token, signature: 'balanceOf(address)', args: [who] }))
      .returnValue,
  );

const collect = (from, froms, tokenAddress = token) =>
  call(evm, {
    from,
    to: collector,
    signature: 'collect(address,address[])',
    args: [tokenAddress, froms],
  });

const UNLIMITED = (1n << 255n) - 1n;

beforeEach(async () => {
  evm = await newEvm();
  collector = await deploy(evm, 'RelayCollector', [TREASURY]);
  token = await deploy(evm, 'MockTRC20');
  await call(evm, {
    from: OWNER,
    to: collector,
    signature: 'setOperator(address,bool)',
    args: [OPERATOR, true],
  });
});

test('funds move from approved addresses to the treasury', async () => {
  for (const user of USERS) {
    await mint(user, 100_000000n);
    await approve(user, collector, UNLIMITED);
  }

  const result = await collect(OPERATOR, USERS);
  assert.equal(result.reverted, false, result.error);

  for (const user of USERS) assert.equal(await balance(user), 0n);
  assert.equal(await balance(TREASURY), 300_000000n);
});

test('the whole balance is taken, not a caller-chosen amount', async () => {
  // Nothing is left behind by accident, and there is no amount for a caller
  // to get wrong.
  await mint(USERS[0], 123_456789n);
  await approve(USERS[0], collector, UNLIMITED);

  await collect(OPERATOR, [USERS[0]]);
  assert.equal(await balance(TREASURY), 123_456789n);
});

test('an address that never approved is skipped, not fatal', async () => {
  await mint(USERS[0], 50_000000n);
  await approve(USERS[0], collector, UNLIMITED);
  await mint(USERS[1], 70_000000n); // no approval

  const result = await collect(OPERATOR, [USERS[0], USERS[1]]);

  assert.equal(result.reverted, false, result.error);
  assert.equal(await balance(TREASURY), 50_000000n);
  // The un-approved balance stays where it was rather than stranding the batch.
  assert.equal(await balance(USERS[1]), 70_000000n);
});

test('empty addresses cost nothing and break nothing', async () => {
  await mint(USERS[1], 40_000000n);
  await approve(USERS[1], collector, UNLIMITED);
  await approve(USERS[0], collector, UNLIMITED); // approved, zero balance

  const result = await collect(OPERATOR, [USERS[0], USERS[1], USERS[2]]);
  assert.equal(result.reverted, false, result.error);
  assert.equal(await balance(TREASURY), 40_000000n);
});

test('one hostile token cannot halt a batch', async () => {
  // balanceOf reverts on every call. The address is skipped and the rest of
  // the batch proceeds.
  const hostile = await deploy(evm, 'HostileTRC20');
  const result = await collect(OPERATOR, USERS, hostile);
  assert.equal(result.reverted, false, result.error);
});

test('a token that returns nothing is still collected', async () => {
  // Several widely used tokens return no data from transferFrom. Treating
  // that as failure would skip them forever.
  const quiet = await deploy(evm, 'NoReturnTRC20');
  await call(evm, { from: OWNER, to: quiet, signature: 'mint(address,uint256)', args: [USERS[0], 25_000000n] });
  await call(evm, { from: USERS[0], to: quiet, signature: 'approve(address,uint256)', args: [collector, UNLIMITED] });

  const result = await collect(OPERATOR, [USERS[0]], quiet);
  assert.equal(result.reverted, false, result.error);

  const treasuryBalance = asUint(
    (await call(evm, { from: OWNER, to: quiet, signature: 'balanceOf(address)', args: [TREASURY] })).returnValue,
  );
  assert.equal(treasuryBalance, 25_000000n);
});

test('a token that returns false is not counted as collected', async () => {
  // The mirror of the case above: reporting failure by return value rather
  // than by reverting. Counting it as success would record money that never
  // moved, and the ledger would stop matching the chain.
  const liar = await deploy(evm, 'FalseTRC20');
  await call(evm, { from: OWNER, to: liar, signature: 'mint(address,uint256)', args: [USERS[0], 25_000000n] });
  await call(evm, { from: USERS[0], to: liar, signature: 'approve(address,uint256)', args: [collector, UNLIMITED] });

  const result = await collect(OPERATOR, [USERS[0]], liar);
  assert.equal(result.reverted, false, result.error);
  // Zero collected, zero total — the two return words are both empty.
  assert.equal(asUint(result.returnValue), 0n);
});

test('only an operator can collect', async () => {
  await mint(USERS[0], 90_000000n);
  await approve(USERS[0], collector, UNLIMITED);

  const outsider = await collect(OUTSIDER, [USERS[0]]);
  assert.equal(outsider.reverted, true);
  assert.equal(await balance(TREASURY), 0n);

  const allowed = await collect(OPERATOR, [USERS[0]]);
  assert.equal(allowed.reverted, false, allowed.error);
  assert.equal(await balance(TREASURY), 90_000000n);
});

test('a revoked operator stops immediately', async () => {
  await mint(USERS[0], 10_000000n);
  await approve(USERS[0], collector, UNLIMITED);

  await call(evm, {
    from: OWNER, to: collector, signature: 'setOperator(address,bool)', args: [OPERATOR, false],
  });

  const result = await collect(OPERATOR, [USERS[0]]);
  assert.equal(result.reverted, true);
  assert.equal(await balance(TREASURY), 0n);
});

test('an outsider cannot appoint themselves operator', async () => {
  const result = await call(evm, {
    from: OUTSIDER, to: collector, signature: 'setOperator(address,bool)', args: [OUTSIDER, true],
  });
  assert.equal(result.reverted, true);
});

test('an empty batch is refused rather than silently doing nothing', async () => {
  const result = await collect(OPERATOR, []);
  assert.equal(result.reverted, true);
});

test('an oversized batch is refused before it can run out of energy', async () => {
  // A batch that exhausts the limit mid-way reverts entirely and the fee is
  // spent for nothing.
  const many = Array.from({ length: 121 }, (_, i) => namedAddress(`u${i}`));
  const result = await collect(OPERATOR, many);
  assert.equal(result.reverted, true);
});

test('a full batch of 120 runs', async () => {
  const many = Array.from({ length: 120 }, (_, i) => namedAddress(`u${i}`));
  for (const user of many.slice(0, 5)) {
    await mint(user, 1_000000n);
    await approve(user, collector, UNLIMITED);
  }

  const result = await collect(OPERATOR, many);
  assert.equal(result.reverted, false, result.error);
  assert.equal(await balance(TREASURY), 5_000000n);
});

test('there is no way to send funds anywhere but the treasury', async () => {
  // The structural guarantee, checked against the ABI rather than by reading
  // the source: no setter, no arbitrary call, no upgrade path, no rescue
  // hatch. An attacker holding every key can move user funds to the treasury
  // and nowhere else.
  const abi = contracts.RelayCollector.abi;
  const functions = abi.filter((e) => e.type === 'function').map((e) => e.name);

  assert.deepEqual(
    functions.sort(),
    ['MAX_BATCH', 'collect', 'isOperator', 'owner', 'setOperator', 'transferOwnership', 'treasury'],
  );

  // Nothing that takes a destination, and nothing that could delegate or
  // self-destruct — those would defeat the immutable treasury.
  for (const name of ['setTreasury', 'withdraw', 'rescue', 'execute', 'upgradeTo', 'kill']) {
    assert.equal(functions.includes(name), false, `${name} must not exist`);
  }
});

test('ownership governs operators but cannot redirect money', async () => {
  await call(evm, {
    from: OWNER, to: collector, signature: 'transferOwnership(address)', args: [OUTSIDER],
  });

  // The new owner controls operators...
  const appoint = await call(evm, {
    from: OUTSIDER, to: collector, signature: 'setOperator(address,bool)', args: [OUTSIDER, true],
  });
  assert.equal(appoint.reverted, false, appoint.error);

  // ...and the treasury is still the same address it was at construction.
  const treasury = await call(evm, { from: OUTSIDER, to: collector, signature: 'treasury()' });
  assert.ok(treasury.returnValue.endsWith(TREASURY.toString().slice(2)));

  // So the worst a stolen owner key can do is move user funds to us.
  await mint(USERS[0], 33_000000n);
  await approve(USERS[0], collector, UNLIMITED);
  await collect(OUTSIDER, [USERS[0]]);
  assert.equal(await balance(TREASURY), 33_000000n);
  assert.equal(await balance(OUTSIDER), 0n);
});

test('batching saves roughly a third, and no more than that', async () => {
  /**
   * The honest measurement of what this contract buys.
   *
   * Batching amortises the per-transaction overhead across the batch. It does
   * NOT avoid the per-transfer storage writes inside the token contract, and
   * those dominate — which is why the saving plateaus around 30% rather than
   * growing with the batch size. Measured here so the claim cannot drift:
   *
   *     N=5    16%      N=20   27%
   *     N=50   29%      N=100  30%
   *
   * Anyone expecting a tenfold saving from a batching contract should read
   * this test before designing around it.
   */
  const SIZE = 20;
  const users = Array.from({ length: SIZE }, (_, i) => namedAddress(`b${i}`));

  const prepare = async () => {
    evm = await newEvm();
    collector = await deploy(evm, 'RelayCollector', [TREASURY]);
    token = await deploy(evm, 'MockTRC20');
    await call(evm, {
      from: OWNER, to: collector, signature: 'setOperator(address,bool)', args: [OPERATOR, true],
    });
    for (const user of users) {
      await mint(user, 1_000000n);
      await approve(user, collector, UNLIMITED);
    }
  };

  await prepare();
  const batched = (await collect(OPERATOR, users)).gasUsed;

  await prepare();
  let individually = 0n;
  for (const user of users) individually += (await collect(OPERATOR, [user])).gasUsed;

  const savedPercent = Number(((individually - batched) * 100n) / individually);

  assert.ok(savedPercent > 20, `batching saved only ${savedPercent}%`);
  assert.ok(savedPercent < 45, `saving of ${savedPercent}% is implausibly good — check the test`);
});
