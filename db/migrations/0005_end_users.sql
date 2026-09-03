-- ===========================================================================
-- Account model: users with permanent addresses, and deposits discovered
-- rather than invoiced.
-- ===========================================================================
--
-- The invoice model already here inverts as follows.
--
-- A payment is created first, by the merchant, and then waits for money that
-- may never come. It carries an expected amount, and the arriving funds are
-- judged against it — hence underpaid, overpaid, expired.
--
-- A deposit is the opposite. Nothing exists until the chain shows money
-- arriving at an address we assigned to a user. There is no expected amount,
-- so there is nothing to be short of: whatever arrives is what the user
-- deposited. Attribution is by address, and because each address belongs to
-- exactly one user for its whole life, that attribution is unambiguous
-- without the unique-amount tricks an invoice model on shared addresses
-- would need.
--
-- Both models are kept. They share everything underneath — addresses, the
-- ledger, sweeping, webhook delivery — and a merchant may reasonably want
-- either. The invoice path can be removed later if it turns out nobody does.

CREATE TYPE deposit_state_t AS ENUM (
  -- Seen on chain, not yet buried deep enough to trust.
  'detected',
  'confirming',
  -- Confirmed and written to the ledger. The merchant has been told.
  'credited',
  -- The transfer was orphaned by a reorg, or the deposit was reversed.
  'failed'
);

-- ---------------------------------------------------------------------------
-- Users of a merchant's platform
-- ---------------------------------------------------------------------------

-- We are not these people's counterparty. The user tops up a balance on the
-- merchant's site; we receive the funds and owe the merchant, and the merchant
-- owes their user. This table exists so we can tell the merchant which of
-- their users a deposit belongs to — nothing more.
--
-- Which is why there are no per-user ledger accounts: the money we owe is
-- owed to the project, exactly as in the invoice model.
CREATE TABLE end_users (
  id               TEXT PRIMARY KEY,          -- USR_...
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,

  -- The merchant's own identifier for this person. Opaque to us.
  external_ref     TEXT NOT NULL,

  -- Assigned once and never rotated. Users save addresses, print them into
  -- QR codes, and set up recurring transfers to them; reassignment would send
  -- somebody's money to a stranger.
  deposit_address  TEXT NOT NULL UNIQUE REFERENCES deposit_addresses(address) ON DELETE RESTRICT,

  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'blocked')),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_deposit_at  TIMESTAMPTZ
);

-- One record per user per project, so a repeated create returns the same
-- address rather than issuing a second one.
CREATE UNIQUE INDEX end_users_project_ref_idx ON end_users (project_id, external_ref);
CREATE INDEX end_users_project_idx ON end_users (project_id);

CREATE TRIGGER end_users_touch BEFORE UPDATE ON end_users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Deposits
-- ---------------------------------------------------------------------------

CREATE TABLE deposits (
  id                      TEXT PRIMARY KEY,   -- DEP_...
  end_user_id             TEXT NOT NULL REFERENCES end_users(id) ON DELETE RESTRICT,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,

  asset                   asset_t NOT NULL,
  amount_units            amount_units NOT NULL CHECK (amount_units > 0),

  state                   deposit_state_t NOT NULL DEFAULT 'detected',
  confirmations           INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  required_confirmations  INTEGER NOT NULL CHECK (required_confirmations > 0),

  -- The transfer this deposit is. Not a nullable match to be resolved later:
  -- a deposit cannot exist without the transfer that created it.
  tx_hash                 TEXT NOT NULL,
  log_index               INTEGER NOT NULL,
  block_number            BIGINT NOT NULL,

  -- Pricing frozen at detection, so a later change to the project's rate
  -- cannot rewrite what a deposit already in flight was charged.
  fee_rate_bps            INTEGER NOT NULL CHECK (fee_rate_bps BETWEEN 0 AND 10000),
  fee_flat_units          amount_units NOT NULL,
  fee_units               amount_units,
  net_units               amount_units,

  detected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A credited deposit carries its split; an uncredited one must not.
  CONSTRAINT deposits_split_matches_state CHECK (
    (state = 'credited') = (fee_units IS NOT NULL AND net_units IS NOT NULL)
  )
);

-- The idempotency guarantee, and the reason a replayed block is harmless: one
-- on-chain transfer produces exactly one deposit, forever. Without it, an
-- indexer re-reading a block after a restart would credit the same money
-- twice, and nothing downstream would notice.
CREATE UNIQUE INDEX deposits_transfer_idx ON deposits (tx_hash, log_index);

CREATE INDEX deposits_user_idx ON deposits (end_user_id, detected_at DESC);
CREATE INDEX deposits_project_idx ON deposits (project_id, detected_at DESC);
CREATE INDEX deposits_open_idx ON deposits (detected_at)
  WHERE state IN ('detected', 'confirming');

CREATE TRIGGER deposits_touch BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Sweeps become address-centric
-- ---------------------------------------------------------------------------
--
-- Under the invoice model an address served one payment and was swept once,
-- so keying a sweep to its payment was the same thing as keying it to its
-- address. A permanent user address is swept again every time that user tops
-- up, so the two come apart.

ALTER TABLE sweeps ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE sweeps ADD COLUMN end_user_id TEXT REFERENCES end_users(id) ON DELETE RESTRICT;

-- A sweep belongs to exactly one of the two models.
ALTER TABLE sweeps ADD CONSTRAINT sweeps_has_one_subject CHECK (
  (payment_id IS NULL) <> (end_user_id IS NULL)
);

-- The old index made a second sweep of the same payment impossible, which was
-- the right rule for a single-use address.
DROP INDEX sweeps_payment_idx;
CREATE UNIQUE INDEX sweeps_payment_idx ON sweeps (payment_id) WHERE payment_id IS NOT NULL;

-- The rule that replaces it: an address may be swept any number of times over
-- its life, but never twice at once. Two workers reaching the same address
-- while a transfer is already in flight would sign a second transfer of funds
-- the first one is spending, and one of them would fail on chain after the
-- fee was paid.
CREATE UNIQUE INDEX sweeps_one_in_flight_per_address_idx ON sweeps (from_address)
  WHERE state IN ('planned', 'signed', 'broadcast');

CREATE INDEX sweeps_user_idx ON sweeps (end_user_id) WHERE end_user_id IS NOT NULL;

-- Ledger transactions may now describe a deposit rather than a payment.
ALTER TABLE ledger_transactions ADD COLUMN deposit_id TEXT REFERENCES deposits(id) ON DELETE RESTRICT;
CREATE INDEX ledger_transactions_deposit_idx ON ledger_transactions (deposit_id);

-- Webhook deliveries likewise.
ALTER TABLE webhook_deliveries ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE webhook_deliveries ADD COLUMN deposit_id TEXT REFERENCES deposits(id) ON DELETE CASCADE;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_has_one_subject CHECK (
  (payment_id IS NULL) <> (deposit_id IS NULL)
);
CREATE INDEX webhook_deliveries_deposit_idx ON webhook_deliveries (deposit_id);
