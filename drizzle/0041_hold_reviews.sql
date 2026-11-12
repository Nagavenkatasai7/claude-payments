-- 0041 — Fix pack 7 (R05, R2, P20): partner compliance decisions.
-- (1) A NEW append-only table hold_reviews: one row per hold decision step
-- (transfer, hold class, reasons fingerprint, step 1 or 2, disposition, the
-- bounded reason, evidence ids, actor and actor scope), two CHECKs (step,
-- actor_scope), two unique indexes (one row per step and one per actor in a
-- cycle), one queue index, FKs to transfers and partners (the OWNER), and one
-- function with two row triggers that reject every UPDATE and DELETE. No
-- TRUNCATE trigger: freshDb truncates (0019 rule).
-- (2) One NULLABLE column customers.screening_watchlist_at (no DEFAULT, no
-- backfill: catalog-only).
-- (3) The rail_messages kind CHECK widened with 'event' (a signed partner
-- compliance event): DROP CONSTRAINT then ADD CONSTRAINT ... NOT VALID, the
-- 0028 pattern. This is the file's ONE reviewed destructive statement.
--
-- SAFE FOR THE BUILD IN PRODUCTION: the serving pack 6 build never names
-- hold_reviews or screening_watchlist_at (drizzle selects explicit column
-- lists; its customer upsert never names the new column, its inserts leave it
-- NULL), and its rail inserts are settle, reverse and callback only, which the
-- wider CHECK accepts: the serving build never writes or reads kind event.
-- NOT VALID skips the scan of the append-only rail_messages: every existing
-- row passed the narrower CHECK, so it satisfies the wider one, and new rows
-- are checked. There is no VALIDATE: inside drizzle-kit migrate's ONE
-- transaction the ACCESS EXCLUSIVE lock the DROP takes on rail_messages is
-- held until commit anyway, so a VALIDATE would only add the scan back. The
-- serving worker's rail records wait at most for that lock (lock_timeout 5s
-- makes the migration fail fast instead of queueing behind a long query).
--
-- Rollback (comments only; the table, the column and the widened CHECK may stay):
--   DROP TRIGGER IF EXISTS hold_reviews_no_update ON hold_reviews;
--   DROP TRIGGER IF EXISTS hold_reviews_no_delete ON hold_reviews;
--   DROP FUNCTION IF EXISTS hold_reviews_append_only();
-- The widened CHECK may stay (an older build writes no kind event).
--
-- Scope of the guarantee: the row trigger rejects UPDATE and DELETE from the
-- application. It is NOT a privilege boundary while the app role owns the
-- table: that role can TRUNCATE (no TRUNCATE trigger: freshDb), DISABLE or
-- DROP the trigger, or DROP the table. A separate owner role is a follow-up.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "hold_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transfer_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"hold_class" text NOT NULL,
	"reasons_fp" text NOT NULL,
	"step" smallint NOT NULL,
	"final" boolean NOT NULL,
	"disposition" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text NOT NULL,
	"actor_scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hold_reviews_step" CHECK ("hold_reviews"."step" IN (1, 2)),
	CONSTRAINT "hold_reviews_actor_scope" CHECK ("hold_reviews"."actor_scope" IN ('partner','platform'))
);
--> statement-breakpoint
ALTER TABLE "hold_reviews" ADD CONSTRAINT "hold_reviews_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_reviews" ADD CONSTRAINT "hold_reviews_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hold_reviews_cycle_step" ON "hold_reviews" USING btree ("transfer_id","hold_class","reasons_fp","step");--> statement-breakpoint
CREATE UNIQUE INDEX "hold_reviews_cycle_actor" ON "hold_reviews" USING btree ("transfer_id","hold_class","reasons_fp","actor");--> statement-breakpoint
CREATE INDEX "hold_reviews_partner_queue" ON "hold_reviews" USING btree ("partner_id","transfer_id","created_at");--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "screening_watchlist_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION hold_reviews_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hold_reviews is append-only: % of row % rejected', TG_OP, OLD.id USING ERRCODE = 'raise_exception';
END; $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER hold_reviews_no_update BEFORE UPDATE ON "hold_reviews" FOR EACH ROW EXECUTE FUNCTION hold_reviews_append_only();--> statement-breakpoint
CREATE OR REPLACE TRIGGER hold_reviews_no_delete BEFORE DELETE ON "hold_reviews" FOR EACH ROW EXECUTE FUNCTION hold_reviews_append_only();--> statement-breakpoint
-- migration-guard: allow-destructive widens the rail_messages kind CHECK with 'event'; the serving build never writes or reads kind event
ALTER TABLE "rail_messages" DROP CONSTRAINT "rail_messages_kind";--> statement-breakpoint
ALTER TABLE "rail_messages" ADD CONSTRAINT "rail_messages_kind" CHECK ("rail_messages"."kind" IN ('settle','reverse','callback','event')) NOT VALID;
