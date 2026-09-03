-- Sweeping user addresses into the treasury.
--
-- A note on what this means for the books.
--
-- Under the invoice model a sweep sent funds to the merchant's own wallet, so
-- it discharged what we owed them: money left our control and the debt went
-- with it.
--
-- Here the destination is our own treasury. The funds move between two
-- accounts we control, and the merchant is still owed every cent of it. The
-- ledger has to say so — a sweep that quietly cleared merchant.payable would
-- make the books show us owing nothing while holding somebody else's money.
--
-- That is the custodial consequence of consolidating into one wallet, and it
-- makes paying merchants out a separate flow that does not exist yet.

-- Which sweep moved a deposit's funds off the user's address. One sweep
-- empties an address and so covers every deposit standing on it, which is why
-- this is a reference rather than a flag.
ALTER TABLE deposits ADD COLUMN sweep_id TEXT REFERENCES sweeps(id) ON DELETE SET NULL;

-- The queue the sweeper reads: credited deposits whose funds are still on the
-- user's address.
CREATE INDEX deposits_unswept_idx ON deposits (project_id, credited_at)
  WHERE state = 'credited' AND sweep_id IS NULL;

CREATE INDEX deposits_sweep_idx ON deposits (sweep_id) WHERE sweep_id IS NOT NULL;
