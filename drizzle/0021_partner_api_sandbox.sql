-- 0021 — Program-Fix 44 P2: Partner API sandbox mode (rail-12) and a per-key
-- scope column (crypto-11).
--
-- PURELY ADDITIVE: two ADD COLUMN statements, no CHECK, no index, no backfill.
--   • api_keys.scopes jsonb NULL — NULL means "the key mode's default scope
--     set", so every existing key keeps its full live scope.
--   • transfers.environment text NOT NULL DEFAULT 'live' — every existing and
--     every old-build row reads 'live'. A constant DEFAULT is catalog-only on
--     Postgres 11+ (the value is stored once in pg_attribute, no table
--     rewrite, no row touched).
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: drizzle selects explicit column
-- lists, so the old build never names these columns; its transfer inserts
-- take the 'live' default and its reads are unchanged. Apply BEFORE merging
-- the code that reads them.
--
-- ADD COLUMN still takes an ACCESS EXCLUSIVE lock for that instant;
-- lock_timeout makes it fail fast instead of queueing live traffic behind a
-- long transaction.
--
-- Rollback: revert the code FIRST (the new build selects these columns), then
-- remove the two columns; the exact statements and the pre-rollback steps are
-- in the PR body.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "environment" text DEFAULT 'live' NOT NULL;
