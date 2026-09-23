-- 0022 — Program-Fix 45 P5 (crypto-03): the staff ledger table.
--
-- PURELY ADDITIVE: one NEW table (plus its FK to partners and one index). No
-- existing table gains, loses or rewrites a column, and no row is copied here
-- (no backfill): the new build copies each Redis staff record in lazily on
-- read (INSERT ... ON CONFLICT DO NOTHING) and dual-writes every change.
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: that build never names "staff" in
-- SQL (its staff records live only in Redis), so it is unaffected. Apply
-- BEFORE merging the code that reads it.
--
-- Locks: CREATE TABLE is on a brand-new relation; the FK briefly takes a
-- SHARE ROW EXCLUSIVE lock on "partners" (blocks partner writes, not reads,
-- for that instant). lock_timeout makes it fail fast instead of queueing live
-- traffic behind a long transaction.
--
-- Rollback: revert the code FIRST (the new build reads this table), then
-- remove the table; the exact statement is in the PR body.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "staff" (
	"username" text PRIMARY KEY NOT NULL,
	"partner_id" text,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_login_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_role_check" CHECK ("staff"."role" IN ('admin','agent','support')),
	CONSTRAINT "staff_status_check" CHECK ("staff"."status" IN ('active','suspended'))
);
--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_partner" ON "staff" USING btree ("partner_id");
