-- Ledger accounts are keyed by (code, asset, project_id), where project_id is
-- NULL for platform-wide accounts such as chain.deposits.
--
-- Postgres treats NULLs as distinct in a UNIQUE constraint by default, so the
-- original constraint let 'chain.deposits' + USDT + NULL be inserted any
-- number of times. Each duplicate would collect part of the balance, and the
-- books would appear to balance while the deposits total silently split across
-- several accounts.
--
-- NULLS NOT DISTINCT, available since Postgres 15, is exactly the intent.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_code_asset_project_id_key;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_identity_key
  UNIQUE NULLS NOT DISTINCT (code, asset, project_id);
