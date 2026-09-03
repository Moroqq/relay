# Relay

TRON payment infrastructure. Merchants accept USDT (TRC20) and TRX; Relay
issues deposit addresses, watches the chain, counts confirmations, and notifies
the merchant.

## Status

The spine is closed: request → address → chain → settlement → merchant notified.
A payment created through the API is settled by the indexer against the real
Nile head and delivered to the merchant with a verifiable signature.

| Piece | State |
|---|---|
| Money arithmetic (`@relay/core`) | done, 8 tests |
| Ids, API keys, webhook signing (`@relay/core`) | done, 22 tests |
| Payment + webhook state machines (`@relay/core`) | done, 9 tests |
| Settlement & fee split (`@relay/core`) | done, 12 tests |
| Deposit address derivation (`@relay/wallet`) | done, 13 tests |
| Database schema + double-entry ledger | done, 17 integration tests |
| TRON block indexer (`@relay/indexer`) | done, 15 decoder tests |
| Merchant API (`@relay/api`) | payments done, 13 tests |
| Settlement into the ledger | done, 10 integration tests |
| Webhook delivery worker (`@relay/webhooks`) | done, 17 tests |
| Sweeping to the merchant (`@relay/sweeper`) | done, 26 tests; broadcast off by default |
| Energy delegation (stake instead of burn) | next |
| Account model: users, permanent addresses, deposits | done, 42 tests |
| Consolidating user addresses into the treasury | done, 11 tests |
| Paying merchants out of the treasury | next |
| Price feed for the sweep decision | next |
| Console + merchant dashboard | later |

## Getting started

```bash
npm install
docker compose up -d          # postgres on :5433, redis on :6380
cp .env.example .env
npm run wallet:new-mnemonic   # generate a master seed, put it in .env
npm run db:migrate            # apply the schema
npm run db:seed               # create a merchant, project and API key
npm run api:dev               # build and start the API on :3000
npm run indexer:dev           # build and start the TRON indexer
npm run webhooks:dev          # build and start the delivery worker
npm run sweeper:dev           # build and start the sweeper (dry run by default)
npm run db:reset              # drop and rebuild the schema (development only)

npm test                      # unit tests, no dependencies
npm run test:db               # integration tests, needs the containers
npm run build
```


## API

```bash
curl -X POST http://127.0.0.1:3000/v1/payments   -H "Authorization: Bearer ak_test_..."   -H "Content-Type: application/json"   -d '{"amount":"480.00","asset":"USDT","external_ref":"ORD-11902"}'
```

```json
{
  "id": "PAY_VWWRZBHZ7NZ2236S",
  "state": "waiting",
  "expected_amount": "480.000000",
  "deposit_address": "TVHPXSQCP9DFqLAYJP8TWu1XMnB6bJ64tH",
  "required_confirmations": 20,
  "expires_at": "2026-09-02T13:30:23.984Z"
}
```

`GET /v1/payments/:id` and `GET /v1/payments` read them back. Amounts are
always decimal strings: a JSON number cannot carry `90071992.547409` intact,
and some clients will parse one into a float without being asked.

`external_ref` is the merchant's own order id and doubles as the idempotency
key. A repeated create returns the original payment with 200 instead of 201 —
including when several retries arrive at the same instant, which is settled by
a unique index rather than by a read-then-insert check that any race defeats.

A payment id belonging to another merchant returns 404, not 403. Otherwise the
API would confirm which ids exist.


## Two models

Relay supports both shapes a crypto gateway comes in. They share everything
underneath — addresses, the ledger, sweeping, webhook delivery — and differ
only in what starts the story.

| | Invoices | Accounts |
|---|---|---|
| Starts with | the merchant asking for an amount | money arriving |
| Address | one per payment, retired after | one per user, permanent |
| Attribution | by address, one payment deep | by address, for that user's life |
| Can be short | yes — underpaid, overpaid, expired | no, there is nothing to be short of |
| Suits | shops, one-off orders | exchanges, gaming, anything with a balance |

The account model is the smaller of the two, because there is nothing to
invoice:

```bash
curl -X POST http://127.0.0.1:3000/v1/users   -H "Authorization: Bearer ak_test_..."   -H "Content-Type: application/json"   -d '{"ref":"player-42"}'
```

```json
{ "id": "USR_ZRZ52WZY1PH1THTX", "deposit_address": "THUMemLcZJ9R9XX6n1V8bwoRC4H2BmoXvk" }
```

`ref` is the merchant's own identifier for that person. The call is idempotent
rather than a create: a merchant hitting it on every page load must get the
same address every time, because users save addresses, print them into QR
codes and set up recurring transfers to them. Reassigning one sends somebody's
money to a stranger.

After that the merchant waits. Every deposit to that address belongs to that
user for as long as the account exists, so attribution needs no unique-amount
tricks. `GET /v1/deposits` reads them back, and a `deposit.credited` webhook
carries the same fields the API returns — built from the same serializer, so
the two cannot drift.

## Decisions worth knowing

**Non-custodial, with a full ledger anyway.** Funds pass through to the
merchant rather than accumulating with us. Custodial float income only beats
the cost of guarding client funds somewhere north of ~$100M annual volume, and
most custody licences forbid earning on client balances in the first place. But
every movement is still written to a double-entry ledger from day one, because
retrofitting one into a live payment system is months of work and guaranteed
discrepancies. Switching to custodial later is a policy change, not a rewrite.

**Consolidating into a treasury does not discharge what we owe.** A payment
sweep sends funds to the merchant's own wallet, so the debt leaves with the
money. A user sweep sends them to our treasury, where they are still ours to
hold and still the merchant's to claim — so the ledger records a movement
between two of our own asset accounts and leaves `merchant.payable`
untouched. Clearing it there would show us owing nothing while holding
somebody else's money. There is a test named for exactly that.

The consequence is that consolidating makes Relay custodial in effect, and
paying merchants out becomes a separate flow that does not exist yet.

**The chain decides how much to sweep, not the ledger.** A user may have
topped up since we last looked, or a previous sweep may have landed after it.
The balance is read from the token contract immediately before building the
transfer.

**A deposit cannot exist without the transfer that created it.** `(tx_hash,
log_index)` is unique, so a block re-read after a restart or a reorg records
nothing the second time. In the invoice model the equivalent guarantee had to
be assembled from a matching step; here it is the primary fact.

**A user's address is assigned once and never rotated.** There is no code path
that changes it.

**The ledger enforces itself in the database.** Every movement of money is
recorded as entries whose signed amounts sum to zero, per asset, checked by a
deferred constraint trigger at commit time. Entries are append-only: a mistake
is corrected with a reversing entry, never an edit. These rules live in
Postgres rather than in application code because application code can be
bypassed by a migration, an admin script, or a hurried manual fix at 3am — and
the one guarantee a payment platform cannot afford to lose is that its books
add up.

**Deposit addresses are never reused.** One address serves one payment and is
then retired. Reuse would make two equal transfers to the same address
impossible to tell apart, and derivation costs nothing.

**Pricing is frozen onto each payment at creation.** Changing a project's fee
must not rewrite what an in-flight payment already agreed to.

**The indexer reads blocks, not addresses.** Two calls per block: the block
body carries native TRX transfers, and the transaction-info response carries
TRC20 event logs. Polling each open deposit address instead would be one
request per address per cycle, which stops scaling at a few hundred payments.

**A TRON address is 21 bytes in a transaction and 20 in an event log.** The log
format is inherited from Ethereum and omits the 0x41 prefix. Confusing the two
produces a valid-looking address belonging to nobody, so the two decoders
reject each other's input rather than guessing. The decoder tests run against
blocks captured verbatim from Nile.

**Confirmations are recomputed from the chain head every pass**, not
incremented. A restart, a missed cycle or a reorg cannot leave a payment stuck
one confirmation short of settling.

**Blocks are recorded before the indexer's position advances.** A crash between
the two re-reads the block instead of skipping it; inserts are keyed on
(tx_hash, log_index) so re-reading costs nothing, while skipping would lose a
payment in silence.

**The transition table stops payments moving backwards — it does not enforce
confirmation depth.** A payment may go straight from `waiting` to `completed`:
that is the indexer returning from an outage to find a transfer already twenty
blocks deep, not a skipped confirmation. Depth is checked against the chain
before any transition is proposed.

**Webhook endpoints are treated as hostile.** The URL is supplied by the
merchant and the worker runs inside our network, so a naive implementation is
a way to make our own infrastructure issue requests on a stranger's behalf.
Private ranges, the cloud metadata address and non-http schemes are refused,
and redirects are not followed. This is a mitigation, not a cure: a hostname
that resolves to a private address at connect time still gets through, and
closing that needs an egress proxy or socket-level pinning. The code says so
rather than implying the hole is shut.

**A queued webhook carries a snapshot, not a reference.** The payload is built
when the event happens. A retry six hours later sends what was true then —
rebuilding it from the current row would show merchants a history that never
occurred.

**Deliveries are claimed with a lease, not a flag.** `FOR UPDATE SKIP LOCKED`
lets several workers run without sending anything twice, and a worker that
dies mid-send releases its rows when the lease expires instead of stranding
them.

**The signature covers the exact bytes sent.** The body is serialised once and
both signed and transmitted from that string. Signing a re-serialisation would
produce failures no merchant could reproduce.

**The sweeper does not broadcast unless told to.** `SWEEP_BROADCAST=true` is
required; anything else builds and signs but stops there. A misconfigured
sweeper that only signs costs nothing, and one that broadcasts by default can
empty every deposit address before a log line is read.

**The signed transaction is persisted before it is broadcast.** TRON's
transaction id is the hash of its body, so it is fixed at signing time. A retry
re-sends the same bytes and the network accepts them once; rebuilding a fresh
transaction on retry would send the money twice. The schema refuses a sweep
marked signed that has no transaction to prove it.

**Nothing is signed without being re-read first.** The node builds the
transaction — we do not reimplement protobuf — but a node is a remote service
and a signature is irrevocable. Before signing, the returned transaction's
owner, contract and call data are checked against what was requested, and the
transaction id is recomputed from the bytes rather than taken on trust.

**The signature header is the recovery id plus 27.** TRON inherited the offset
from Ethereum. A bare recovery id produces a signature correct in all 64 other
bytes that fails with "signature validate failed". Settled by comparing against
TronWeb on a real transaction, and there is a test for that single byte.

**Dust is left where it is.** A 0.05 USDT balance on an address that costs
0.16 USDT to empty is not swept. The decision is re-made every pass against
live network prices, so an address not worth emptying today is emptied when
either the balance grows or energy gets cheaper.

**Resource prices are read from the chain, never hardcoded.** Energy and
bandwidth pricing are governance parameters: they differ between mainnet and
testnet and change by vote. A constant would be wrong on one network today and
on both after the next vote.

**A TRON node says `result: true` for a call that reverted.** It means the
simulation ran, not that the transfer would succeed: a transfer that reverts
for insufficient balance comes back with result true, a message of "REVERT
opcode executed", energy far too low to be real, and an empty return value.
Success requires all three — the call ran, nothing reverted, and the contract
returned boolean true. Reading only the boolean makes the sweeper broadcast
doomed transactions and burn the fee limit on every one. `interpretEstimate`
in `@relay/tron` is a pure function for exactly this reason, tested against a
captured reverting reply.

**The sweeper reads the on-chain balance before it tries.** The ledger says the
funds exist; the chain decides. One extra call turns "the transfer reverted for
some reason" into "address holds 0 USDT, needs 475.2".

**Payment state and webhook state are separate machines.** A payment whose
funds are confirmed on-chain is settled, permanently, whatever the merchant's
HTTP endpoint does afterwards. Collapsing the two — as the design mockups do
with a single `webhook_failed` value — lets an outage on the merchant's side
silently reopen settled money. The console composes the combined label for
display; the model underneath keeps them apart.

**Amounts are `bigint` in base units, never `number`.** `0.1 + 0.2 !== 0.3` in
floating point. Parsing is strict and rejects anything ambiguous rather than
coercing it.

**No TypeScript-only runtime features.** No `enum`, no parameter properties, no
decorators, no `namespace` — so every file runs directly under `node` with type
stripping, and tests need no build step. Imports use `.ts` extensions; the
compiler rewrites them on emit.

**Derivation is verified against an independent implementation.** The address
tests check 25 derived addresses against TronWeb, and check the underlying
keccak pipeline against a published Ethereum vector. A subtle error in
Base58Check or the address prefix sends money to an address nobody controls, so
this is not a place to trust our own arithmetic alone.

## Secrets

The master mnemonic controls every deposit address the platform will ever
issue. It never goes in this repository, in a log, in a screenshot, or in a
chat message. In production it comes from a KMS or HSM. Anything generated
during development is a throwaway — never reuse a development seed on mainnet.

## Layout

```
packages/core      money, state machines, settlement rules
packages/wallet    BIP44 deposit address derivation
db/migrations      schema, applied by scripts/migrate.mjs
test/              integration tests against a live database
packages/tron      shared HTTP client for a TRON full node
packages/db        repositories, transactions, bigint conversion at the edge
services/api       merchant-facing HTTP API
services/indexer   TRON block watcher
services/webhooks  delivery worker with retries
services/sweeper   moves settled funds to the merchant
```

## Design reference

Visual language and screen designs live in
`Desktop/TRON платежная инфраструктура/design_handoff_relay/` — prototypes, not
production code.

## Trying it end to end

Four processes: the API, the indexer, the delivery worker, and a stand-in for
a merchant's server.

```bash
npm run db:seed                      # prints an API key and a project id
node scripts/demo-merchant.mjs       # a merchant's endpoint on :4001
npm run api:dev
npm run indexer:dev
npm run webhooks:dev
```

Create a payment, then stand in for the customer:

```bash
node scripts/demo-receive.mjs <paymentId> <depositAddress> 480000000
```

`demo-receive.mjs` writes a transfer at a block the network has already
buried, so the indexer computes its depth from the real Nile head. Only the
transfer is fabricated; everything after it is the real pipeline. Roughly ten
seconds later:

```
[indexer]  payment advanced payment=PAY_BR4JA3WRTTEBS1F2 from=waiting to=completed confirmations=26
[webhooks] delivered payment=PAY_BR4JA3WRTTEBS1F2 event=payment.completed attempt=1/5 http=200 ms=20
[merchant] signature VALID  payment.completed  completed  net=475.200000 fee=4.800000
```

`scripts/demo-merchant.mjs` doubles as the reference implementation to hand
merchants: it verifies the signature and answers 2xx immediately, doing real
work afterwards rather than holding the request open.

Real testnet USDT would replace `demo-receive.mjs` entirely — the rest of the
flow is unchanged.

## What sweeping costs

The largest running cost of a TRON payment operator, and the reason the
economics live in code rather than in a spreadsheet.

A USDT transfer needs roughly 65,000 energy. An account with none staked burns
TRX for it at the network's energy price:

```
mainnet, nothing staked   13.65 TRX + 0.345 TRX bandwidth  ~= $4.20 per sweep
with energy delegated      0.345 TRX bandwidth only        ~= $0.10 per sweep
```

At a thousand sweeps a day that is about five million TRX a year burned, or
nothing at all — staked TRX is returned when unstaked, so energy obtained by
staking has no running cost, only tied-up capital. `compareEnergyStrategies`
in `@relay/core` computes the difference, and there is a test asserting it.

Delegation itself is not built yet, which is the next piece of work. Until it
is, the sweeper pays the burn price and refuses any sweep where that price
takes more than 5% of the amount.
