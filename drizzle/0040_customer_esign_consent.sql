-- 0040 — Fix pack 6 (R46): the customer's E-SIGN consent on customers
-- (esign_consent_version, esign_consented_at, esign_withdrawn_at).
-- PURELY ADDITIVE: three NULLABLE columns, no DEFAULT, no CHECK, no index, no
-- backfill: catalog-only. ADD COLUMN takes ACCESS EXCLUSIVE for an instant;
-- lock_timeout fails fast. SAFE FOR THE BUILD IN PRODUCTION: drizzle selects
-- explicit column lists, so the old build never names these columns, its
-- inserts leave them NULL, and its saveCustomer upsert never names them.
-- Rollback: revert the code; the columns may stay (harmless).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "esign_consent_version" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "esign_consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "esign_withdrawn_at" timestamp with time zone;