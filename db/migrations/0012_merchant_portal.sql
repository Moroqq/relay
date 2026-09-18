-- ===========================================================================
-- The merchant portal: applications from the website, merchant accounts,
-- invitations and sessions
-- ===========================================================================
--
-- A merchant never signs themselves up. They apply on the website; an
-- operator reviews the application in the console; approving it creates the
-- merchant, their first project and an account, and produces a one-time
-- invitation link. The merchant opens the link, chooses a password and sets up
-- a second factor, and only then can sign in.

CREATE TABLE access_requests (
  id              TEXT PRIMARY KEY,            -- REQ_...
  company         TEXT NOT NULL,
  website         TEXT,
  contact_name    TEXT NOT NULL,
  email           TEXT NOT NULL,
  telegram        TEXT,
  monthly_volume  TEXT NOT NULL,               -- a bracket chosen on the form
  use_case        TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'approved', 'rejected')),
  decided_by      TEXT REFERENCES operators(id) ON DELETE RESTRICT,
  decided_at      TIMESTAMPTZ,
  -- For a rejection, why. Kept for the record; the applicant is told by a person.
  decision_note   TEXT,
  merchant_id     TEXT REFERENCES merchants(id) ON DELETE RESTRICT,

  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT access_requests_decided CHECK (
    (status = 'new') = (decided_at IS NULL)
  ),
  CONSTRAINT access_requests_approved_has_merchant CHECK (
    status <> 'approved' OR merchant_id IS NOT NULL
  )
);

CREATE INDEX access_requests_status_idx ON access_requests (status, created_at DESC);

CREATE TABLE merchant_users (
  id                  TEXT PRIMARY KEY,        -- MUS_...
  merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  email               TEXT NOT NULL,
  name                TEXT NOT NULL,

  -- Both empty until the invitation is accepted: the operator who approves
  -- an application never sees or sets the merchant's credentials.
  password_hash       TEXT,
  totp_secret_sealed  TEXT,
  totp_last_counter   BIGINT,

  status              TEXT NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited', 'active', 'disabled')),
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ,

  CONSTRAINT merchant_users_active_has_credentials CHECK (
    status <> 'active' OR (password_hash IS NOT NULL AND totp_secret_sealed IS NOT NULL)
  )
);

CREATE UNIQUE INDEX merchant_users_email_idx ON merchant_users (lower(email));
CREATE INDEX merchant_users_merchant_idx ON merchant_users (merchant_id);

CREATE TRIGGER merchant_users_touch BEFORE UPDATE ON merchant_users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE merchant_invites (
  -- SHA-256 of the token in the link. The link itself is never stored.
  token_hash          TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
  created_by          TEXT REFERENCES operators(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  -- The second-factor secret offered while the invitation is being accepted,
  -- sealed like the final one. It becomes the account's only once a code from
  -- it is entered, which proves the merchant's app really holds it.
  pending_totp_sealed TEXT
);

CREATE INDEX merchant_invites_user_idx ON merchant_invites (user_id);

CREATE TABLE merchant_sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX merchant_sessions_user_idx ON merchant_sessions (user_id);

-- The audit log records merchants' actions too: who created an API key, who
-- asked for a payout to which address. Still append-only.
ALTER TABLE audit_log ADD COLUMN merchant_user_id TEXT REFERENCES merchant_users(id) ON DELETE RESTRICT;
CREATE INDEX audit_log_merchant_user_idx ON audit_log (merchant_user_id, created_at DESC);
