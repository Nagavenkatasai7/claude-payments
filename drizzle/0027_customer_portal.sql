-- 0027 — UI redesign M2-3 (MIGRATION-ONLY): customer portal tables.
--   partner_portal_settings: per-partner WhatsApp auth (OTP) template name/lang + portal_enabled_at.
--   recipient_tombstones:    a deleted saved recipient stays deleted (keyed like recipients' PK).
--   customer_portal_prefs:   email-receipt opt-in + an HMAC tag of the verified email (no address).
--
-- NEW TABLES ONLY: three new, empty tables, their PKs, two CHECKs and three FKs. The only
-- ALTER TABLE statements add FKs to the NEW tables. No ALTER of an existing table, no DEFAULT on an
-- existing table, no backfill, no DROP. (A column added to recipients would have been selected by
-- the build already in production before this was applied: the 2026-06-11 outage pattern.)
--
-- SAFE FOR BOTH BUILDS during the rolling release: no code reads or writes these tables yet, so
-- every build ignores them. Apply with /migrate-prod after this merges and BEFORE any reader or
-- writer merges (the recipients tombstone filter enters the bot's listRecipients).
--
-- The template-name length is a separate predicate: Postgres regex bounds cap at 255, so
-- '{1,512}' would raise 2201B on every non-NULL write.
--
-- The FKs take a SHARE ROW EXCLUSIVE lock on "partners", "customers" and "recipients" (hot
-- bot-path tables) for an instant; lock_timeout makes it fail fast instead of queueing live
-- traffic behind a long transaction. Retry the apply if it times out.
--
-- Erasure (compliance loop A): all three FKs are ON DELETE no action. Once rows exist, a partners,
-- customers or recipients row with a child here cannot be deleted until the erasure engine purges
-- these children first or the FKs move to ON DELETE CASCADE. Not decided here.
--
-- Rollback (only while no reader/writer build is live; the tables do not reference each other):
--   DROP TABLE "partner_portal_settings"; DROP TABLE "recipient_tombstones"; DROP TABLE "customer_portal_prefs";
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "customer_portal_prefs" (
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"email_receipts" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"email_verified_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_portal_prefs_partner_id_phone_pk" PRIMARY KEY("partner_id","phone")
);
--> statement-breakpoint
CREATE TABLE "partner_portal_settings" (
	"partner_id" text PRIMARY KEY NOT NULL,
	"auth_template_name" text,
	"auth_template_lang" text,
	"portal_enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_portal_settings_template_name_format" CHECK ("partner_portal_settings"."auth_template_name" ~ '^[a-z0-9_]+$' AND char_length("partner_portal_settings"."auth_template_name") <= 512),
	CONSTRAINT "partner_portal_settings_template_lang_format" CHECK ("partner_portal_settings"."auth_template_lang" ~ '^[a-z]{2}(_[A-Z]{2})?$')
);
--> statement-breakpoint
CREATE TABLE "recipient_tombstones" (
	"partner_id" text NOT NULL,
	"sender_phone" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipient_tombstones_partner_id_sender_phone_recipient_phone_pk" PRIMARY KEY("partner_id","sender_phone","recipient_phone")
);
--> statement-breakpoint
ALTER TABLE "customer_portal_prefs" ADD CONSTRAINT "customer_portal_prefs_customer_fk" FOREIGN KEY ("partner_id","phone") REFERENCES "public"."customers"("partner_id","phone") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_settings" ADD CONSTRAINT "partner_portal_settings_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_tombstones" ADD CONSTRAINT "recipient_tombstones_recipient_fk" FOREIGN KEY ("partner_id","sender_phone","recipient_phone") REFERENCES "public"."recipients"("partner_id","sender_phone","recipient_phone") ON DELETE no action ON UPDATE no action;