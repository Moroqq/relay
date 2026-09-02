-- Hands out derivation indices for deposit addresses.
--
-- Two API requests arriving at the same instant must never be given the same
-- index, or two customers would be shown the same deposit address and their
-- payments would become impossible to tell apart. A sequence is atomic across
-- concurrent transactions, which `SELECT max(index) + 1` is not.
--
-- Sequences leave gaps when a transaction rolls back. That is harmless here:
-- a skipped index simply means an address that was never derived.
CREATE SEQUENCE deposit_address_index_seq
  AS BIGINT
  START WITH 0
  MINVALUE 0
  INCREMENT BY 1
  NO CYCLE;
