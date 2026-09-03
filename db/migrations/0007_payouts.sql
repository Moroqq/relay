-- ===========================================================================
-- Paying merchants out of the treasury
-- ===========================================================================
--
-- The most dangerous operation in the system. Everything else moves money
-- between accounts we control; this sends it to an address we do not own, and
-- there is no undo.
--
-- So the guarantees are stricter than anywhere else:
--
--   * A payout can never exceed what the ledger says we owe. The balance is
--     derived from ledger entries, not from a stored column that could drift.
--   * Requests already in flight are subtracted from what is available, so two
--     requests cannot each spend the same balance.
--   * Above a configurable size a human must approve. The threshold is per
--     project and defaults to zero, meaning approve everything by hand until
--     somebody deliberately decides otherwise.
--   * The signed transaction is persisted before broadcast, as with sweeps: a
--     retry re-sends the same bytes rather than paying twice.
--
-- On the fee. Our percentage is taken when a deposit is credited, so what the
-- ledger owes a merchant is already net of it and a payout is pure debt
-- settlement. The fee here is a separate, optional charge on the withdrawal
-- itself — most operators levy a small flat one to cover network cost. It
-- defaults to zero.

ALTER TABLE projects
  ADD COLUMN payout_fee_bps INTEGER NOT NULL DEFAULT 0
    CHECK (payout_fee_bps BETWEEN 0 AND 10000),
  ADD COLUMN payout_fee_flat_units amount_units NOT NULL DEFAULT 0,
  -- Payouts at or below this go straight through. Zero means every payout
  -- waits for a human, which is the right default for a young platform.
  ADD COLUMN payout_auto_approve_units amount_units NOT NULL DEFAULT 0;

CREATE TYPE payout_state_t AS ENUM (
  -- The merchant asked. Nothing has moved.
  'requested',
  -- Cleared to send, either automatically or by a person.
  'approved',
  -- Built and signed. The transaction id is fixed and re-broadcast is safe.
  'signed',
  'broadcast',
  'completed',
  -- Refused by us. The reserved balance is released.
  'rejected',
  -- The network rejected it, or it was abandoned after repeated failures.
  'failed'
);

CREATE TABLE payouts (
  id                 TEXT PRIMARY KEY,          -- PYT_...
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,

  -- The merchant's own reference, and the idempotency key: a retried request
  -- returns the original payout instead of sending the money twice.
  external_ref       TEXT,

  asset              asset_t NOT NULL,
  -- What the merchant asked for, what we charge for the withdrawal, and what
  -- actually leaves. gross = fee + net, always.
  amount_units       amount_units NOT NULL CHECK (amount_units > 0),
  fee_units          amount_units NOT NULL DEFAULT 0,
  net_units          amount_units NOT NULL CHECK (net_units > 0),

  to_address         TEXT NOT NULL,

  state              payout_state_t NOT NULL DEFAULT 'requested',

  tx_hash            TEXT UNIQUE,
  signed_tx          JSONB,
  fee_sun            NUMERIC(38, 0),

  approved_by        TEXT,
  approved_at        TIMESTAMPTZ,
  rejected_reason    TEXT,

  attempt            INTEGER NOT NULL DEFAULT 0,
  error              TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,

  CONSTRAINT payouts_amount_adds_up CHECK (amount_units = fee_units + net_units),

  -- Once signed, the bytes and their hash must both be present: they are what
  -- makes a retry safe rather than a second payment.
  CONSTRAINT payouts_signed_has_transaction CHECK (
    state NOT IN ('signed', 'broadcast', 'completed')
      OR (tx_hash IS NOT NULL AND signed_tx IS NOT NULL)
  )
);

CREATE UNIQUE INDEX payouts_project_ref_idx ON payouts (project_id, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE INDEX payouts_project_idx ON payouts (project_id, created_at DESC);
CREATE INDEX payouts_state_idx ON payouts (state);
-- What still reserves balance, and what the executor has to work through.
CREATE INDEX payouts_open_idx ON payouts (created_at)
  WHERE state IN ('requested', 'approved', 'signed', 'broadcast');

ALTER TABLE ledger_transactions ADD COLUMN payout_id TEXT REFERENCES payouts(id) ON DELETE RESTRICT;
CREATE INDEX ledger_transactions_payout_idx ON ledger_transactions (payout_id);

CREATE TRIGGER payouts_touch BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
