-- 0038 — Fix pack 4 (R18 R41 R03 R32): transfers.disclosure_snapshot,
-- transfers.delivery_business_days and recipients.legal_name_enc.
-- PURELY ADDITIVE: three NULLABLE columns, no DEFAULT, no CHECK, no index, no
-- backfill: catalog-only. ADD COLUMN takes ACCESS EXCLUSIVE for an instant;
-- lock_timeout fails fast. SAFE FOR THE BUILD IN PRODUCTION: drizzle selects
-- explicit column lists, so the old build never names these columns, its
-- inserts leave them NULL, and its recipients upsert never names legal_name_enc.
-- Rollback: revert the code; the columns may stay (harmless).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "disclosure_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "delivery_business_days" smallint;--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "legal_name_enc" text;
