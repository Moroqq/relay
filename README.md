# Relay

TRON payment infrastructure. Merchants accept USDT (TRC20) and TRX; Relay
issues deposit addresses, watches the chain, counts confirmations, and notifies
the merchant.

## Status

Building the spine: one real payment end to end on the Nile testnet.

| Piece | State |
|---|---|
| Money arithmetic (`@relay/core`) | done, 8 tests |
| Payment + webhook state machines (`@relay/core`) | done, 9 tests |
| Settlement & fee split (`@relay/core`) | done, 12 tests |
| Deposit address derivation (`@relay/wallet`) | done, 13 tests |
| Database schema + ledger | next |
| TRON block indexer | next |
| Merchant API | next |
| Webhook delivery worker | next |
| Sweeping & energy management | later |
| Console + merchant dashboard | later |

## Getting started

```bash
npm install
docker compose up -d          # postgres on :5433, redis on :6380
cp .env.example .env
npm run wallet:new-mnemonic   # generate a master seed, put it in .env
npm test
npm run build
```

## Decisions worth knowing

**Non-custodial, with a full ledger anyway.** Funds pass through to the
merchant rather than accumulating with us. Custodial float income only beats
the cost of guarding client funds somewhere north of ~$100M annual volume, and
most custody licences forbid earning on client balances in the first place. But
every movement is still written to a double-entry ledger from day one, because
retrofitting one into a live payment system is months of work and guaranteed
discrepancies. Switching to custodial later is a policy change, not a rewrite.

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
services/api       merchant-facing HTTP API            (empty)
services/indexer   TRON block watcher                  (empty)
services/webhooks  delivery worker with retries        (empty)
db/migrations      schema                              (empty)
```

## Design reference

Visual language and screen designs live in
`Desktop/TRON платежная инфраструктура/design_handoff_relay/` — prototypes, not
production code.
