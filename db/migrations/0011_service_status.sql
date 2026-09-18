-- What each background service last said about itself.
--
-- The console reads this so an operator can see, without a shell on the
-- server, that payouts are not going out because signing is locked after a
-- restart, or because the sweeper has stopped reporting at all.

CREATE TABLE service_status (
  service     text PRIMARY KEY,
  state       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  since       timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
