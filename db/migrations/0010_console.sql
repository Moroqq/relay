-- ===========================================================================
-- The operations console: who may sign in, and a record of what they did
-- ===========================================================================
--
-- The console approves payouts, so it is a way to move money. Everything here
-- is arranged around three questions that must always have an answer: who is
-- allowed in, how sure are we it is them, and what did they do.

CREATE TYPE operator_role_t AS ENUM (
  -- Can approve and reject payouts, and manage operators.
  'admin',
  -- Can approve and reject payouts.
  'operator',
  -- Can look, and nothing else.
  'viewer'
);

CREATE TABLE operators (
  id                  TEXT PRIMARY KEY,          -- OPR_...
  email               TEXT NOT NULL,
  name                TEXT NOT NULL,
  role                operator_role_t NOT NULL DEFAULT 'viewer',

  password_hash       TEXT NOT NULL,             -- scrypt, parameters inline

  -- The TOTP secret, sealed with AES-256-GCM under a key held in the
  -- environment. It must be recoverable, so it cannot be hashed; sealed, a
  -- database dump alone does not yield anyone's second factor.
  totp_secret_sealed  TEXT NOT NULL,
  -- The last code counter accepted. A code at or before it is refused, so a
  -- code seen once cannot be replayed within its window.
  totp_last_counter   BIGINT,

  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disabled')),

  -- Consecutive failures since the last success, and when the lockout they
  -- caused ends. Guessing a password or a code gets a handful of tries.
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ
);

-- Case-insensitive: Owner@Relay and owner@relay are one person, and letting
-- them be two accounts is a way to be confused about who approved what.
CREATE UNIQUE INDEX operators_email_idx ON operators (lower(email));

CREATE TRIGGER operators_touch BEFORE UPDATE ON operators
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE operator_sessions (
  -- SHA-256 of the cookie. The token itself is never stored, so this table
  -- cannot be replayed as cookies if it leaks.
  token_hash    TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX operator_sessions_operator_idx ON operator_sessions (operator_id);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
--
-- Append-only, like the ledger and for the same reason: a record of who
-- approved a payout is worthless if the person who approved it can edit it.

CREATE TABLE audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL for events with no signed-in operator, such as a failed login.
  operator_id   TEXT REFERENCES operators(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL,        -- login.succeeded, payout.approved, ...
  subject_type  TEXT,                 -- payout, operator, session
  subject_id    TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id);
CREATE INDEX audit_log_operator_idx ON audit_log (operator_id, created_at DESC);

CREATE FUNCTION forbid_audit_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not allowed', TG_OP;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
