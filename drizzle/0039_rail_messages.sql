-- 0039 — Fix pack 5 (R40): the rail record. ADDITIVE: a NEW table
-- rail_messages (no existing explicit-column query changes shape), one
-- NULLABLE column on partner_webhook_deliveries (body_sha256, no DEFAULT), one
-- function and two row triggers on the new table only. SAFE FOR THE BUILD IN
-- PRODUCTION: pack 4 and main never name rail_messages or body_sha256, and
-- their delivery-log inserts leave it NULL. No TRUNCATE trigger: freshDb
-- truncates (0019 rule). drizzle-kit migrate runs this file in ONE
-- transaction; lock_timeout makes the ADD COLUMN fail fast.
--
-- Rollback (comments only; the table and column may stay):
--   DROP TRIGGER IF EXISTS rail_messages_no_update ON rail_messages;
--   DROP TRIGGER IF EXISTS rail_messages_no_delete ON rail_messages;
--   DROP FUNCTION IF EXISTS rail_messages_append_only();
--
-- Scope of the guarantee: the row trigger rejects UPDATE (other than a
-- body_enc-only change) and DELETE from the application.
-- It is NOT a privilege boundary while the app role owns the table: that role
-- can TRUNCATE (no TRUNCATE trigger: freshDb), DISABLE or DROP the trigger,
-- DROP the table, or overwrite body_enc through the re-seal exception
-- (body_sha256 then no longer matches the opened body). A separate owner role
-- is a follow-up.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "rail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" text,
	"rail_partner_id" text,
	"transfer_id" text,
	"direction" smallint NOT NULL,
	"kind" text NOT NULL,
	"body_enc" text NOT NULL,
	"body_sha256" text NOT NULL,
	"signature_header" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rail_messages_direction" CHECK ("rail_messages"."direction" IN (1, 2)),
	CONSTRAINT "rail_messages_kind" CHECK ("rail_messages"."kind" IN ('settle','reverse','callback')),
	CONSTRAINT "rail_messages_sha" CHECK ("rail_messages"."body_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "partner_webhook_deliveries" ADD COLUMN "body_sha256" text;--> statement-breakpoint
ALTER TABLE "rail_messages" ADD CONSTRAINT "rail_messages_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rail_messages" ADD CONSTRAINT "rail_messages_rail_partner_id_partners_id_fk" FOREIGN KEY ("rail_partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rail_messages_transfer" ON "rail_messages" USING btree ("transfer_id","created_at");--> statement-breakpoint
CREATE INDEX "rail_messages_partner_created" ON "rail_messages" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE OR REPLACE FUNCTION rail_messages_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Every column except body_enc unchanged (to_jsonb covers columns added by a LATER migration too), and body_enc changed.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'body_enc') = (to_jsonb(OLD) - 'body_enc')
     AND NEW.body_enc IS DISTINCT FROM OLD.body_enc THEN
    RETURN NEW;                                   -- key-rotation re-seal only
  END IF;
  RAISE EXCEPTION 'rail_messages is append-only: % of row % rejected', TG_OP, OLD.id USING ERRCODE = 'raise_exception';
END; $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER rail_messages_no_update BEFORE UPDATE ON "rail_messages" FOR EACH ROW EXECUTE FUNCTION rail_messages_append_only();--> statement-breakpoint
CREATE OR REPLACE TRIGGER rail_messages_no_delete BEFORE DELETE ON "rail_messages" FOR EACH ROW EXECUTE FUNCTION rail_messages_append_only();
