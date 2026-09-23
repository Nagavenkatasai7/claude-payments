-- 0024 — Program-Fix 7: the real sender funds-capture seam (Stripe ACH
-- Direct Debit + card, through the LICENSED PARTNER's own Stripe account),
-- behind STRIPE_FUNDING_ENABLED (OFF by default).
--
-- PURELY ADDITIVE: one new table, five nullable ADD COLUMNs (no DEFAULT, no
-- CHECK, no backfill, no DROP) and one partial index.
--   • transfers.funding_provider / funding_intent_ref / funding_state — NULL
--     on every existing and every old-build row (NULL = the legacy synchronous
--     mock / partner-settled capture, i.e. today's behaviour).
--   • partner_integrations.funding_provider_type / funding_credentials_enc —
--     the partner's PSP selector + envelope-encrypted key and endpoint secrets.
--   • funding_events — processed PSP webhook event ids (idempotency backstop).
--   • transfers_funding_intent — partial btree on (partner_id,
--     funding_intent_ref) WHERE funding_intent_ref IS NOT NULL. It is EMPTY at
--     creation (every row is NULL), so the build is a scan of a small table.
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: drizzle selects explicit column
-- lists, so the old build never names these columns or the table. Apply
-- BEFORE merging the code that reads them (/migrate-prod).
--
-- ADD COLUMN and CREATE INDEX take locks on "transfers" for their duration;
-- lock_timeout makes them fail fast instead of queueing live traffic behind a
-- long transaction.
--
-- CHAIN NOTE: 0022 (#348) is on main; 0023 (#350) is byte-copied here unmerged
-- from pull/350/head — regenerate this file's snapshot after #350 merges.
--
-- Rollback: revert the code FIRST (the new build selects these columns), then
--   DROP INDEX "transfers_funding_intent";
--   ALTER TABLE "transfers" DROP COLUMN "funding_state", DROP COLUMN "funding_intent_ref", DROP COLUMN "funding_provider";
--   ALTER TABLE "partner_integrations" DROP COLUMN "funding_credentials_enc", DROP COLUMN "funding_provider_type";
--   DROP TABLE "funding_events";
-- (only while no row has a non-NULL funding_state — with the flag OFF none can).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "funding_events" (
	"partner_id" text NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"transfer_id" text,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_events_partner_id_provider_event_id_pk" PRIMARY KEY("partner_id","provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "partner_integrations" ADD COLUMN "funding_provider_type" text;--> statement-breakpoint
ALTER TABLE "partner_integrations" ADD COLUMN "funding_credentials_enc" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "funding_provider" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "funding_intent_ref" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "funding_state" text;--> statement-breakpoint
ALTER TABLE "funding_events" ADD CONSTRAINT "funding_events_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfers_funding_intent" ON "transfers" USING btree ("partner_id","funding_intent_ref") WHERE "transfers"."funding_intent_ref" IS NOT NULL;