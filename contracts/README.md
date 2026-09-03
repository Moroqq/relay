# RelayCollector

Pulls TRC20 balances off many deposit addresses in one transaction and
deposits them in the treasury.

```bash
npm run contracts:build   # compile, refusing opcodes TRON cannot execute
npm run contracts:test    # 21 tests, run as real bytecode in a real EVM
```

## Why it exists

Emptying a deposit address normally means a transaction signed by that
address, so that address needs energy. With ten thousand user wallets that is
ten thousand addresses to keep funded. With this contract each address grants
an allowance once, and every collection afterwards is paid for by whoever
calls `collect` — one account to rent energy for instead of thousands.

## What it buys, measured

Batching amortises the per-transaction overhead. It does not avoid the
per-transfer storage writes inside the token contract, and those dominate:

| Addresses per call | Saving vs. one call each |
|---:|---:|
| 5 | 16% |
| 20 | 27% |
| 50 | 29% |
| 100 | 30% |

The saving plateaus around 30% rather than growing with batch size. Anyone
expecting tenfold should read `collector.test.mjs` before designing around it.

The larger win is operational: energy comes from one account.

## The security problem this design answers

Every user address grants this contract an unlimited allowance on their USDT.
That makes it, permanently, the most valuable thing in the system — whoever
controls it controls every deposit address at once.

So it is built to be *incapable* of misusing that power rather than merely
unwilling:

- `treasury` is immutable. Set in the constructor, no setter, no proxy, no
  upgrade path.
- No arbitrary call, no `delegatecall`, no `selfdestruct`, no rescue hatch.
- Ownership governs who may operate. It cannot redirect funds.

An attacker holding every private key in the company can move user funds to
the treasury and nowhere else. There is a test asserting the ABI contains
nothing that could break that.

The cost is real: changing the treasury means a new contract and every user
address re-approving it. That is expensive, slow, and the correct trade — a
settable treasury turns one stolen key into a total loss.

## What it does not do

It does not run on a timer. No contract on any chain does; they execute only
when someone sends a transaction and pays for it. The schedule lives in the
sweeper.

## Compiling

Pinned to solc 0.8.19 targeting the Istanbul EVM. From 0.8.20 solc emits the
`PUSH0` opcode, which TRON does not implement — a contract containing it
deploys successfully and then reverts on every call, with nothing in the
failure pointing at the cause. The build disassembles both bytecodes and
refuses to emit an artifact containing it.

## Testing

TRON's VM is EVM-compatible for everything this contract does, so the tests
run the same compiled bytecode in `@ethereumjs/evm`. What that cannot cover —
TRON's resource model and unsupported opcodes — is handled at compile time.

Mock tokens cover the three shapes TRC20 comes in: returning `true`, returning
nothing, and returning `false` instead of reverting. A hostile token that
reverts on every call is there to prove one bad address cannot halt a batch.
