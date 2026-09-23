-- 0020 — Program-Fix 49D: opt-in customer portal TOTP (portal-03) and a review
-- state for corridor demand leads (partner-02).
--
-- PURELY ADDITIVE: three NULLABLE columns, no default, no CHECK, no index, no
-- backfill. SAFE FOR THE BUILD ALREADY IN PRODUCTION: drizzle selects explicit
-- column lists, so the old build never names these columns and its reads and
-- writes are unchanged (its saveCustomer upsert does not name them either, so
-- it can never clear an enrolment). Apply BEFORE merging the code that reads
-- them.
--
-- customers.mfa_totp_enc is a field-crypto blob (the TOTP secret, sealed for
-- its own (partner_id, phone) row); customers.mfa_enrolled_at is when it was
-- turned on. corridor_requests.status NULL means 'open'.
--
-- ADD COLUMN without a default is a catalog-only change, but it still takes an
-- ACCESS EXCLUSIVE lock for that instant; lock_timeout makes it fail fast
-- instead of queueing live traffic behind a long transaction.
--
-- Rollback: revert the code FIRST (the new build selects these columns), then
-- remove the three columns; the exact statements are in the PR body.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "corridor_requests" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "mfa_totp_enc" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "mfa_enrolled_at" timestamp with time zone;
