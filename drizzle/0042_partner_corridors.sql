-- 0042 — Fix pack 8 (R44, R12, R36, P1): Reg E cases, the US licence matrix and
-- the India corridor pack. Additive only (no migration-guard marker).
-- (1) A NEW table partner_corridors: the destination register, one row per OWNER
-- partner and destination country (composite PK partner_corridors_pk), an FK to
-- partners, no check constraint (status, rule_pack and purpose codes are validated in
-- code, the hold_reviews precedent), no trigger (rows update in place; every
-- change is an audit row).
-- (2) Three nullable columns on customers: residence_state, its source and when
-- it was set (no DEFAULT, no backfill: catalog-only).
-- (3) Three nullable columns on tickets (reg_class, first_notice_at, due_at)
-- and one plain partial index tickets_reg_due (non-unique: a unique index would
-- turn a race into a 23505 mid-transaction; the case writer's advisory lock dedupes).
-- (4) Two nullable columns on transfers (payout_dest_bidx, purpose_source) and
-- two plain partial indexes serving both arms of the India beneficiary-year
-- count: transfers_partner_payout_bidx and the expression index
-- transfers_partner_rcpt_digits (its regexp_replace text must match the count's).
--
-- SAFE FOR THE SERVING PACK 7 BUILD: that build never names partner_corridors;
-- drizzle selects explicit column lists, so it never selects the new nullable
-- columns, and its inserts and whole-row upserts never name them (they stay
-- NULL). No existing row is rewritten.
-- LOCKS: every statement runs in drizzle-kit migrate's ONE transaction, so each
-- lock is held until its COMMIT. Each ALTER TABLE ... ADD COLUMN takes an
-- ACCESS EXCLUSIVE lock on customers, tickets and transfers: from that table's
-- first ALTER to the end of the migration (the index builds included) both
-- reads and writes of that table wait. The plain CREATE INDEX statements also
-- take a SHARE lock, which adds nothing to the ACCESS EXCLUSIVE lock already
-- held on tickets and transfers. On today's small tables this window is a short
-- moment. lock_timeout 5s bounds every lock wait (the migration fails fast
-- instead of queueing behind a long query); a lock timeout or a deadlock
-- (an app transaction holding one of these tables while it waits on another)
-- fails the build, which is safe: the previous build keeps serving and the
-- deploy is run again. transfers, the busiest table, comes last so that its
-- window is the shortest. A concurrent index build cannot run inside that
-- transaction, so none is used.
--
-- Rollback (comments only; the columns may stay, an older build never names them):
--   DROP INDEX IF EXISTS transfers_partner_rcpt_digits;
--   DROP INDEX IF EXISTS transfers_partner_payout_bidx;
--   DROP INDEX IF EXISTS tickets_reg_due;
--   DROP TABLE IF EXISTS partner_corridors;
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "partner_corridors" (
	"partner_id" text NOT NULL,
	"destination_country" text NOT NULL,
	"status" text NOT NULL,
	"rule_pack" text,
	"purpose_code_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attestation_ref" text NOT NULL,
	"attestation_sha256" text,
	"recipient_notices" boolean DEFAULT false NOT NULL,
	"travel_dob_from_usd" numeric(12, 2),
	"travel_full_from_usd" numeric(12, 2),
	"reattest_due" date NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attested_by" text,
	"attested_at" timestamp with time zone,
	"attested_hash" text,
	CONSTRAINT "partner_corridors_pk" PRIMARY KEY("partner_id","destination_country")
);
--> statement-breakpoint
ALTER TABLE "partner_corridors" ADD CONSTRAINT "partner_corridors_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "residence_state" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "residence_state_source" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "residence_state_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "reg_class" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "first_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tickets_reg_due" ON "tickets" USING btree ("partner_id","due_at") WHERE "tickets"."reg_class" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "payout_dest_bidx" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "purpose_source" text;--> statement-breakpoint
CREATE INDEX "transfers_partner_payout_bidx" ON "transfers" USING btree ("partner_id","payout_dest_bidx","created_at") WHERE "transfers"."payout_dest_bidx" IS NOT NULL AND "transfers"."destination_country" = 'IN';--> statement-breakpoint
CREATE INDEX "transfers_partner_rcpt_digits" ON "transfers" USING btree ("partner_id",regexp_replace("recipient_phone", '[^0-9]', '', 'g'),"created_at") WHERE "transfers"."destination_country" = 'IN' AND "transfers"."environment" = 'live';
