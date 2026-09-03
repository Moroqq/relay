-- Moving settled funds off deposit addresses.
--
-- The safety property this table exists for: a sweep must never be sent twice.
--
-- TRON's transaction id is the hash of the transaction body, so it is known
-- the moment we sign and before we broadcast. That lets us persist the signed
-- bytes first and broadcast second. If the process dies in between, the retry
-- re-broadcasts the SAME bytes with the SAME id, which the network accepts
-- once and ignores thereafter. Rebuilding a fresh transaction on retry would
-- instead produce a second valid transfer and send the money twice.

CREATE TYPE sweep_state_t AS ENUM (
  -- Decided to move funds; nothing built yet.
  'planned',
  -- Built and signed. The transaction id is now fixed and re-broadcast is safe.
  'signed',
  -- Handed to the network.
  'broadcast',
  -- Seen on chain with enough confirmations.
  'confirmed',
  -- Rejected by the network, or abandoned after repeated failures.
  'failed'
);

CREATE TABLE sweeps (
  id              TEXT PRIMARY KEY,

  -- The payment whose funds these are. One sweep per payment, enforced below.
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  from_address    TEXT NOT NULL REFERENCES deposit_addresses(address) ON DELETE RESTRICT,
  to_address      TEXT NOT NULL,

  asset           asset_t NOT NULL,
  amount_units    amount_units NOT NULL CHECK (amount_units > 0),

  state           sweep_state_t NOT NULL DEFAULT 'planned',

  -- Known at signing time, before broadcast.
  tx_hash         TEXT UNIQUE,
  -- The exact signed transaction, kept so a retry re-sends these bytes rather
  -- than building new ones.
  signed_tx       JSONB,

  -- What the network actually charged, filled in once the receipt is read.
  fee_sun         NUMERIC(38, 0),
  energy_used     BIGINT,

  attempt         INTEGER NOT NULL DEFAULT 0,
  error           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  broadcast_at    TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,

  -- Once signed, the transaction id and the bytes must both be present: they
  -- are what makes a retry safe.
  CONSTRAINT sweeps_signed_has_transaction CHECK (
    state = 'planned' OR state = 'failed' OR (tx_hash IS NOT NULL AND signed_tx IS NOT NULL)
  )
);

-- One sweep per payment. A second attempt updates this row rather than
-- creating another transfer of the same funds.
CREATE UNIQUE INDEX sweeps_payment_idx ON sweeps (payment_id);

CREATE INDEX sweeps_state_idx ON sweeps (state);
CREATE INDEX sweeps_pending_idx ON sweeps (created_at)
  WHERE state IN ('planned', 'signed', 'broadcast');

CREATE TRIGGER sweeps_touch BEFORE UPDATE ON sweeps
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
