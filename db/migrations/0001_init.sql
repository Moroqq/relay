-- ===========================================================================
-- Relay 0001 — merchants, payments, chain observations, and the ledger
-- ===========================================================================

-- Amounts are integer counts of an asset's smallest unit (1 USDT = 1e6), never
-- a fraction. NUMERIC(38,0) is exact and leaves headroom no float ever will.
CREATE DOMAIN amount_units AS NUMERIC(38, 0) CHECK (VALUE >= 0);

-- Signed variant, for ledger entries where one leg is always negative.
CREATE DOMAIN signed_units AS NUMERIC(38, 0);

CREATE TYPE asset_t AS ENUM ('USDT', 'TRX');

CREATE TYPE payment_state_t AS ENUM (
  'waiting', 'detected', 'confirming',
  'completed', 'underpaid', 'overpaid', 'expired', 'failed'
);

CREATE TYPE webhook_state_t AS ENUM ('pending', 'delivered', 'retrying', 'failed');

CREATE TYPE address_status_t AS ENUM ('free', 'assigned', 'retired');

CREATE TYPE account_kind_t AS ENUM ('asset', 'liability', 'revenue', 'expense');

-- Keeps updated_at honest without the application having to remember.
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Merchants and their projects
-- ---------------------------------------------------------------------------

CREATE TABLE merchants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER merchants_touch BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'archived')),

  -- Where settled funds are forwarded. Non-custodial: money does not stay
  -- with us. NULL parks the funds pending a payout address, which the API
  -- must refuse to let a live project reach.
  payout_address    TEXT,

  -- Pricing. Copied onto every payment at creation so that a later price
  -- change cannot rewrite what an in-flight payment already agreed to.
  fee_rate_bps      INTEGER NOT NULL DEFAULT 100 CHECK (fee_rate_bps BETWEEN 0 AND 10000),
  fee_flat_units    amount_units NOT NULL DEFAULT 0,

  -- How far off the expected amount still counts as paid in full.
  tolerance_under_bps    INTEGER NOT NULL DEFAULT 50 CHECK (tolerance_under_bps BETWEEN 0 AND 10000),
  tolerance_under_floor  amount_units NOT NULL DEFAULT 100000,
  tolerance_over_bps     INTEGER NOT NULL DEFAULT 50 CHECK (tolerance_over_bps BETWEEN 0 AND 10000),
  tolerance_over_floor   amount_units NOT NULL DEFAULT 100000,

  webhook_url       TEXT,
  -- Shared secret for signing webhook payloads, so the merchant can prove a
  -- callback came from us and not from someone who guessed their URL.
  webhook_secret    TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX projects_merchant_idx ON projects (merchant_id);
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- API credentials. The key itself is never stored — only its hash, so a
-- database leak does not hand over the ability to create payments.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  key_prefix    TEXT NOT NULL,           -- e.g. 'ak_live_a91f', shown in the UI
  key_hash      TEXT NOT NULL UNIQUE,    -- hash of the full key
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX api_keys_project_idx ON api_keys (project_id);
CREATE INDEX api_keys_active_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Deposit addresses
-- ---------------------------------------------------------------------------

-- Derived from the master mnemonic; no private key is ever stored. The
-- derivation index alone rebuilds the address, and with the mnemonic it also
-- rebuilds the key needed to sweep the address.
--
-- An address serves exactly one payment and is then retired. Reuse would make
-- two payments of the same amount to the same address indistinguishable, and
-- there is no upside — derivation costs nothing.
CREATE TABLE deposit_addresses (
  address           TEXT PRIMARY KEY,
  derivation_index  BIGINT NOT NULL UNIQUE CHECK (derivation_index >= 0),
  derivation_path   TEXT NOT NULL,
  status            address_status_t NOT NULL DEFAULT 'free',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at       TIMESTAMPTZ,
  retired_at        TIMESTAMPTZ
);

CREATE INDEX deposit_addresses_free_idx ON deposit_addresses (derivation_index)
  WHERE status = 'free';

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id                      TEXT PRIMARY KEY,          -- PAY_9C4D18
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,

  -- The merchant's own order reference, and the idempotency key: a retried
  -- create returns the original payment instead of issuing a second address.
  external_ref            TEXT,

  asset                   asset_t NOT NULL,
  expected_units          amount_units NOT NULL CHECK (expected_units > 0),
  received_units          amount_units NOT NULL DEFAULT 0,

  state                   payment_state_t NOT NULL DEFAULT 'waiting',

  deposit_address         TEXT NOT NULL UNIQUE REFERENCES deposit_addresses(address),

  confirmations           INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  required_confirmations  INTEGER NOT NULL CHECK (required_confirmations > 0),

  -- Pricing and tolerance frozen at creation time.
  fee_rate_bps            INTEGER NOT NULL CHECK (fee_rate_bps BETWEEN 0 AND 10000),
  fee_flat_units          amount_units NOT NULL,
  tolerance_under_bps     INTEGER NOT NULL,
  tolerance_under_floor   amount_units NOT NULL,
  tolerance_over_bps      INTEGER NOT NULL,
  tolerance_over_floor    amount_units NOT NULL,

  -- Filled in once the payment settles.
  fee_units               amount_units,
  net_units               amount_units,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  first_detected_at       TIMESTAMPTZ,
  settled_at              TIMESTAMPTZ,

  -- A settled payment must carry its split; an unsettled one must not.
  CONSTRAINT payments_split_matches_state CHECK (
    (state IN ('completed', 'overpaid')) = (fee_units IS NOT NULL AND net_units IS NOT NULL)
  )
);

-- Idempotency: one external reference per project.
CREATE UNIQUE INDEX payments_project_ref_idx ON payments (project_id, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE INDEX payments_project_created_idx ON payments (project_id, created_at DESC);
CREATE INDEX payments_state_idx ON payments (state);
-- Drives the expiry sweep: only rows that can still expire.
CREATE INDEX payments_open_expiry_idx ON payments (expires_at)
  WHERE state IN ('waiting', 'detected', 'confirming');

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- What the chain actually showed us
-- ---------------------------------------------------------------------------

-- One row per transfer observed on TRON. A single transaction can carry
-- several TRC20 transfers, so the key is (hash, log index) — which is also
-- what makes re-reading a block harmless: the repeat insert simply conflicts.
CREATE TABLE chain_transfers (
  tx_hash        TEXT NOT NULL,
  log_index      INTEGER NOT NULL,

  block_number   BIGINT NOT NULL,
  block_time     TIMESTAMPTZ NOT NULL,

  asset          asset_t NOT NULL,
  from_address   TEXT NOT NULL,
  to_address     TEXT NOT NULL,
  amount_units   amount_units NOT NULL,

  confirmations  INTEGER NOT NULL DEFAULT 0,

  -- NULL means money we cannot attribute — the "unmatched transaction"
  -- exception in the console. That is a queue for humans, not an error.
  payment_id     TEXT REFERENCES payments(id) ON DELETE SET NULL,
  matched_at     TIMESTAMPTZ,

  -- Set if a reorg later orphans the transaction.
  reverted_at    TIMESTAMPTZ,

  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX chain_transfers_payment_idx ON chain_transfers (payment_id);
CREATE INDEX chain_transfers_to_idx ON chain_transfers (to_address);
CREATE INDEX chain_transfers_block_idx ON chain_transfers (block_number);
CREATE INDEX chain_transfers_unmatched_idx ON chain_transfers (first_seen_at)
  WHERE payment_id IS NULL AND reverted_at IS NULL;

-- How far the indexer has read. Exactly one row, enforced by the primary key.
CREATE TABLE indexer_state (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_block_number  BIGINT NOT NULL,
  last_block_time    TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Telling the merchant
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,
  payment_id       TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  event            TEXT NOT NULL,        -- payment.completed, payment.underpaid, ...
  payload          JSONB NOT NULL,
  endpoint         TEXT NOT NULL,

  state            webhook_state_t NOT NULL DEFAULT 'pending',
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,

  http_status      INTEGER,
  latency_ms       INTEGER,
  error            TEXT,

  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

CREATE INDEX webhook_deliveries_payment_idx ON webhook_deliveries (payment_id);
-- The worker's queue: what is due, oldest first.
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE state IN ('pending', 'retrying');

CREATE TRIGGER webhook_deliveries_touch BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ===========================================================================
-- The ledger
-- ===========================================================================
--
-- Double-entry bookkeeping, the same discipline banks have used since the
-- fifteenth century. Money is never created or destroyed, only moved: every
-- movement is recorded as two or more entries whose signed amounts add to
-- exactly zero.
--
-- Sign convention: what we hold is positive, what we owe is negative.
-- A 480 USDT payment with a 4.80 fee is one transaction of three entries:
--
--     chain.deposits        +480.00   (we now hold this on a deposit address)
--     merchant.payable      -475.20   (we owe the merchant this much)
--     platform.fee_revenue    -4.80   (this part is ours)
--                          ---------
--                             0.00
--
-- If a bug ever tried to credit a merchant more than arrived, the sum would
-- be non-zero and the database would refuse the whole transaction. That check
-- lives here rather than in application code on purpose: application code can
-- be bypassed by a migration, a script, or a hurried manual fix at 3am.

CREATE TABLE ledger_accounts (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,        -- chain.deposits, platform.fee_revenue, ...
  kind        account_kind_t NOT NULL,
  asset       asset_t NOT NULL,
  -- Set for per-merchant accounts such as a payable balance.
  project_id  TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (code, asset, project_id)
);

CREATE INDEX ledger_accounts_project_idx ON ledger_accounts (project_id);

-- A group of entries that must balance. One real-world event, one row here.
CREATE TABLE ledger_transactions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- payment.settled, payout.sent, fee.collected
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What in the outside world this records. Kept loose so a ledger transaction
  -- can point at a payment, a payout, or a manual correction alike.
  payment_id  TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  reference   TEXT,
  memo        TEXT
);

CREATE INDEX ledger_transactions_payment_idx ON ledger_transactions (payment_id);
CREATE INDEX ledger_transactions_occurred_idx ON ledger_transactions (occurred_at DESC);

CREATE TABLE ledger_entries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account_id      TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  asset           asset_t NOT NULL,
  amount_units    signed_units NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at DESC);

-- An entry's asset must match its account's asset. Mixing them would let a
-- USDT credit balance out a TRX debit, which is nonsense that sums to zero.
CREATE FUNCTION assert_entry_asset_matches() RETURNS trigger AS $fn$
DECLARE
  account_asset asset_t;
BEGIN
  SELECT a.asset INTO account_asset FROM ledger_accounts a WHERE a.id = NEW.account_id;
  IF account_asset IS DISTINCT FROM NEW.asset THEN
    RAISE EXCEPTION 'Entry asset % does not match account % which holds %',
      NEW.asset, NEW.account_id, account_asset;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_asset_check BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION assert_entry_asset_matches();

-- The invariant. Deferred to commit time so that both legs of a movement can
-- be inserted before the check runs, and checked per asset because USDT and
-- TRX do not offset each other.
CREATE FUNCTION assert_ledger_balanced() RETURNS trigger AS $fn$
DECLARE
  txn_id TEXT := COALESCE(NEW.transaction_id, OLD.transaction_id);
  offending RECORD;
BEGIN
  SELECT e.asset, SUM(e.amount_units) AS total
    INTO offending
    FROM ledger_entries e
   WHERE e.transaction_id = txn_id
   GROUP BY e.asset
  HAVING SUM(e.amount_units) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Ledger transaction % does not balance in %: entries sum to % instead of 0',
      txn_id, offending.asset, offending.total;
  END IF;

  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- The ledger is append-only. A mistake is corrected by posting an opposite
-- entry, never by editing history — otherwise last month's closed books can
-- change silently and no reconciliation can be trusted.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only; post a reversing entry instead of a % ', TG_OP;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Current balance of every account, derived rather than stored, so it can
-- never drift out of agreement with the entries behind it.
CREATE VIEW ledger_balances AS
SELECT
  a.id           AS account_id,
  a.code,
  a.kind,
  a.asset,
  a.project_id,
  COALESCE(SUM(e.amount_units), 0)::NUMERIC(38, 0) AS balance_units,
  COUNT(e.id)    AS entry_count,
  MAX(e.created_at) AS last_entry_at
FROM ledger_accounts a
LEFT JOIN ledger_entries e ON e.account_id = a.id
GROUP BY a.id, a.code, a.kind, a.asset, a.project_id;
