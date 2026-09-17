-- Let a failed sweep be tried again.
--
-- The one-sweep-per-payment index counted failed rows. A payment whose sweep
-- failed once — a node timeout while building, a transaction that expired
-- before it was broadcast — could therefore never be swept again, and its
-- funds would sit on the deposit address with nothing able to move them.
--
-- A failed sweep moved nothing, so it has no claim on the payment. Only sweeps
-- that are in flight or done do.
DROP INDEX sweeps_payment_idx;
CREATE UNIQUE INDEX sweeps_payment_idx ON sweeps (payment_id)
  WHERE payment_id IS NOT NULL AND state <> 'failed';
