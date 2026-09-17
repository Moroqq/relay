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
| Money arithmetic, ids, signing, state machines (`@relay/core`) | done |
| Deposit and operational key derivation (`@relay/wallet`) | done |
| Database schema + double-entry ledger | done |
| TRON block indexer (`@relay/indexer`) | done |
| Merchant API (`@relay/api`) — payments, users, deposits, balance, payouts | done |
| Webhook delivery worker (`@relay/webhooks`) | done |
| Account model: users, permanent addresses, deposits | done |
| Consolidating user addresses into the treasury (`@relay/sweeper`) | done, broadcast off by default |
| Merchant balance and payout requests | done |
| Sending approved payouts from the hot wallet | done, broadcast off by default |
| Booking refills between treasury and hot wallet | done |
| Collector contract (`contracts/`) | built and tested, not used — see docs/observed-operator.md |
| Energy rental | deferred — fees are burned in TRX for now |
| TRX price from the WINkLink oracle | done |
| End-to-end run with real testnet USDT | next — needs coins from a faucet |
| Keys out of `.env` into a KMS | before mainnet |
| Operations console: sign-in, payout queue, approve/reject, audit log (`@relay/console`, `apps/console`) | done |
| Merchant dashboard, landing page | later |

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


## Money in, money out

```
deposit credited      chain.deposits  +480    merchant.payable  −475.20
                                              platform.fee_revenue −4.80
consolidated          chain.deposits  −480    chain.treasury    +480
payout completed      merchant.payable +400   chain.treasury    −400
```

Our percentage is taken once, when a deposit is credited. What the ledger owes
a merchant is already net of it, so a payout is pure debt settlement — the
liability moves toward zero and the treasury drops by what actually left.

A separate withdrawal fee exists and defaults to zero. Where it is set, the
merchant's balance drops by the full amount they asked for, less leaves the
wallet, and the difference is ours.

### What a payout may not do

Sending to an address we do not own is the only irreversible operation here,
so it is the most constrained:

- **The available balance is derived from ledger entries**, never from a
  stored column that could drift from them.
- **Requests in flight reserve their amount**, so two cannot each spend the
  same balance, and the project row is locked while the check runs — without
  that, both would read the same figure and both would pass.
- **Nothing leaves unattended by default.** `payout_auto_approve_units` is
  zero, meaning every payout waits for a person. Raising it is a deliberate
  act.
- **A rejected payout releases what it reserved**, and cannot then be
  approved.
- **The destination checksum is verified at request time**, while the money is
  still ours. On chain a mistyped character is simply gone.
- **The signed transaction is persisted before broadcast**, as with sweeps.
  Here the stake is higher: a rebuilt transaction pays a merchant twice.

```bash
curl http://127.0.0.1:3000/v1/balance -H "Authorization: Bearer ak_test_..."
```

```json
{ "object": "balance", "owed": "990.000000", "reserved": "100.000000", "available": "890.000000" }
```

Approving a payout is deliberately not in this API. It is our decision, not the
merchant's, and belongs to the operations console.


## Two wallets

| | Treasury | Hot wallet |
|---|---|---|
| Receives | every sweep | refills from the treasury |
| Sends | payouts nowhere — a person moves funds out | merchant payouts |
| Key | on no server this system runs on | derived on the server, `m/44'/195'/1'/0/0` |
| Holds | the bulk | a working float |

A stolen server costs the float, not the treasury. The sweeper needs only the
treasury's address; the indexer needs only the two addresses and holds no key
at all, which is why `HOT_WALLET_ADDRESS` is configured rather than derived —
and why the sweeper refuses to start if the configured address and the one its
mnemonic derives disagree.

The hot wallet sits on its own BIP44 account rather than a reserved index on
the user account, so no value the deposit-address sequence reaches can ever
collide with it.

A person refills the hot wallet with their own wallet software. The indexer
reads that transfer off the chain and books it, treasury to hot wallet, so the
hot wallet's ledger account does not only ever go down. Money arriving at the
hot wallet from any other address is recorded but not booked: it might be ours,
or a stranger's mistake, and guessing wrong puts somebody else's money on our
books. Fund the hot wallet — TRX included — only from the treasury.

A payout that the hot wallet cannot cover stays approved and waits, logged as
`hot wallet holds 0 USDT, payout needs 50 — refill from the treasury`. Nothing
is ever sent partially.

## When a signed transaction is done, dead, or neither

Every TRON transaction expires about a minute after it is built. That expiry is
what makes a crash between signing and broadcasting recoverable: once it has
passed and neither node has the transaction, the stored bytes can never land,
and building afresh is provably safe.

Both sweeps and payouts are reconciled by asking two nodes:

| Solidity node | Ordinary node | Expiry | Verdict |
|---|---|---|---|
| has it, succeeded | — | — | book it |
| has it, reverted | — | — | failed; nothing moved |
| — | has it | — | wait: landed, not yet irreversible |
| — | — | not passed | wait: may not have propagated |
| — | — | passed | rebuild (or give up after 5 attempts) |
| — | — | unreadable | wait, indefinitely |

Nothing is booked until its block is irreversible, and nothing is rebuilt while
it could still land. `reconcileVerdict` in `services/sweeper` is a pure
function with a test per row.


## Where the TRX price comes from

From WINkLink, TRON's own price oracle, reading the **USDT/TRX** feed — how many
TRX one USDT buys — and inverting it. One read, meaning the same thing on both
networks, rather than dividing TRX/USD by USDT/USD.

| Network | Proxy address |
|---|---|
| mainnet | `TUfV7S4RYtdmBvtHzedfFPVsK9nvndtETp` |
| nile | `TVZjuqiJNNuLQAQoPAFfUqvYUxhZYkUX5Z` |

Taken from the official table at doc.winklink.org, then each checked on chain:
an `EACAggregatorProxy` whose `description()` reads back `USDT/TRX`.

The price is used for exactly one thing — deciding whether a sweep is worth its
network fee — so every way of not trusting it fails toward waiting:

- **The feed must call itself `USDT/TRX`**, checked every pass. Pointing at
  the TRX/USD feed by mistake yields a figure nine times too high that still
  looks like a price; only this check catches it. At startup a wrong feed stops
  the service.
- **A day-old price is normal.** WINkLink updates this pair on a 1% move and
  otherwise every 24 hours. The age limit defaults to 26 hours; WINkLink's own
  guidance is that it must exceed the heartbeat. A shorter limit would refuse
  the oracle every time the market is calm.
- **Zero, negative, never-updated, carried-over, future-dated, or orders of
  magnitude out** — all refused.
- **Refused means sweeps wait.** Nothing is lost: funds stay on their addresses
  until a usable price arrives. Payouts do not use the price and carry on.

**Being throttled is not the same as being empty.** TronGrid answers a
rate-limited request with HTTP 200 and `{"Error": "request rate exceeded…
suspended for 5 s"}`. The client used to return that as a result, so a
throttled balance read looked like an address holding nothing. It now raises a
retriable error and waits out the suspension the node names.


## The operations console

A separate service from the merchant API — its own port, loopback only by
default — because it decides where money goes.

```bash
npm run console:new-key                    # CONSOLE_SECRET_KEY, into the environment
npm run console:create-operator -- --email you@example.com --name "You" --role admin
npm run console:web:build                  # the pages, into apps/console/dist
npm run console:dev                        # http://127.0.0.1:3100/admin/
```

`create-operator` prints a generated password and a second-factor key once.
Run it in your own terminal and put both straight into a password manager and
an authenticator app.

**Signing in takes a password and a six-digit code** (RFC 6238, checked against
the vectors printed in the RFC). A code works once: its counter is stored and
anything at or before it is refused, so a code read over a shoulder cannot be
replayed within its window. Two sign-ins racing with one code cannot both win —
the counter update is conditional.

**Every wrong answer looks the same.** Unknown address, wrong password, wrong
code, locked, disabled: one message, and roughly one scrypt derivation of work
each, so neither the response nor its timing says which part was right. Five
failures lock an account for fifteen minutes, and a locked account is refused
before its password is checked.

**What is stored cannot be used.** Passwords as scrypt hashes; second-factor
secrets sealed with AES-256-GCM under `CONSOLE_SECRET_KEY`, which lives only in
the environment; session tokens as SHA-256. A database dump alone yields no
password, no code and no session.

**Sessions** are HttpOnly, SameSite=Strict cookies, eight hours at most and
thirty minutes idle. Disabling an operator ends their open sessions at once.

**Forged requests are closed three ways**: the SameSite cookie, a required
`x-relay-console` header another origin cannot set without a preflight this
server never answers, and an Origin check. The console also refuses to be
framed, so a hostile page cannot lay it under its own button.

**Roles**: admins and operators can approve and reject; viewers can only look.
Approving succeeds only from `requested`, so two operators deciding one payout
at once get one success and one conflict. A rejection needs a reason.

**The audit log is append-only**, enforced by a trigger like the ledger's. A
record of who approved a payout is worthless if they can edit it.

**The screens** (`apps/console`, React) are served by the console itself, so
the cookie, the header and the origin check all apply to one origin. The payout
queue shows what is waiting, what is owed and whether the hot wallet can cover
what is already approved; a payout opens into its full details and the trail of
who did what to it. Approving asks once more, with the whole destination address
and the network spelled out — testnet or real funds — because a transfer on
TRON cannot be taken back. The network badge also sits in the corner of every
page.

The pages run under a strict Content-Security-Policy: their own scripts, styles
and fonts only (the fonts are bundled, not fetched from a font service), no
inline code, nowhere to post a form. For work on the screens,
`npm run console:web:dev` serves them with hot reload and forwards API calls;
start the console with `CONSOLE_ORIGIN=http://localhost:5173` so it accepts
changes arriving that way.

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
