# Relay

TRON payment infrastructure. Merchants accept USDT (TRC20) and TRX; Relay
issues deposit addresses, watches the chain, counts confirmations, and notifies
the merchant.

## Status

Building the spine: one real payment end to end on the Nile testnet.

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
| Webhook delivery worker | next |
| Sweeping & energy management | later |
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

## Decisions worth knowing

**Non-custodial, with a full ledger anyway.** Funds pass through to the
merchant rather than accumulating with us. Custodial float income only beats
the cost of guarding client funds somewhere north of ~$100M annual volume, and
most custody licences forbid earning on client balances in the first place. But
every movement is still written to a double-entry ledger from day one, because
retrofitting one into a live payment system is months of work and guaranteed
discrepancies. Switching to custodial later is a policy change, not a rewrite.

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
packages/db        repositories, transactions, bigint conversion at the edge
services/api       merchant-facing HTTP API
services/indexer   TRON block watcher
services/webhooks  delivery worker with retries        (empty)
```

## Design reference

Visual language and screen designs live in
`Desktop/TRON платежная инфраструктура/design_handoff_relay/` — prototypes, not
production code.
