-- ===========================================================================
-- Hot wallet: where payouts are sent from
-- ===========================================================================
--
-- Two wallets with different jobs.
--
-- The TREASURY receives every sweep. Its private key does not live on any
-- server this system runs on — the sweeper needs only its address to send
-- funds there. It holds the bulk of the money and is spent from by a person.
--
-- The HOT WALLET sends payouts. Its key is derived on the server, so it can
-- sign unattended, and so it holds only a working float that a person tops up
-- from the treasury. A stolen server costs the float, not the treasury.
--
-- The ledger mirrors that split with a separate account, so the books show
-- how much of what we hold is exposed to the server at any moment.

-- Which wallet signed a payout. Recorded because the hot wallet may be rotated,
-- and a payout must remain traceable to the key that authorised it.
ALTER TABLE payouts ADD COLUMN from_address TEXT;

-- Anything signed or later must say what signed it. NOT VALID because payouts
-- completed in development before this column existed have no source to
-- record; the rule is enforced for every row written from here on.
ALTER TABLE payouts ADD CONSTRAINT payouts_signed_has_source CHECK (
  state NOT IN ('signed', 'broadcast', 'completed') OR from_address IS NOT NULL
) NOT VALID;
