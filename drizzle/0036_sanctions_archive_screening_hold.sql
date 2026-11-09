-- 0036 — Fix pack 2 (R06, R07): sender screening hold times and the sanctions
-- list archive pointers.
-- PURELY ADDITIVE: five NULLABLE columns, no default, no CHECK, no index, no
-- backfill. SAFE FOR THE BUILD IN PRODUCTION: drizzle selects explicit column
-- lists, so the old build never names these columns (nor does its saveCustomer).
-- ADD COLUMN without a default is catalog-only but takes an ACCESS EXCLUSIVE
-- lock for that instant; lock_timeout makes it fail fast.
-- Rollback: revert the code first; the columns may stay (harmless).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "screening_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "screening_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sanctions_list_versions" ADD COLUMN "archive_path" text;--> statement-breakpoint
ALTER TABLE "sanctions_list_versions" ADD COLUMN "archive_sha256" text;--> statement-breakpoint
ALTER TABLE "sanctions_list_versions" ADD COLUMN "archived_at" timestamp with time zone;