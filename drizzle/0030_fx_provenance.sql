-- 0030 — Step 0 FX-7: rate provenance on "transfers" (fixing date, fetch time,
-- pricing source, provider). Stamped once at mint; read by ops and the pay-time
-- rate check (src/lib/minted-rate.ts).
--
-- PURELY ADDITIVE: four nullable ADD COLUMNs (no DEFAULT, no CHECK, no index,
-- no backfill, no DROP). NULL on every existing and every old-build row.
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: drizzle selects explicit column
-- lists, so the old build never names these columns. Apply with /migrate-prod
-- FROM THE PR BRANCH before the merge (CI's migration safety job stays red
-- until it is applied). The journal `when` is FROZEN from the prod apply on:
-- never regenerate this migration after it.
--
-- ADD COLUMN takes a lock on "transfers" for its (catalog-only) duration;
-- lock_timeout makes it fail fast instead of queueing live traffic behind a
-- long transaction.
--
-- Rollback: revert the code FIRST (the new build selects these columns), then
--   ALTER TABLE "transfers" DROP COLUMN "fx_provider", DROP COLUMN "fx_source",
--     DROP COLUMN "fx_fetched_at", DROP COLUMN "fx_as_of";
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "fx_as_of" date;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "fx_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "fx_source" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "fx_provider" text;