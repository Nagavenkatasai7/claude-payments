-- 0026 — UI redesign M1 (MIGRATION-ONLY): partner_sites, per-partner white-label site settings
-- (slug for <slug>.smartremit.ai, accent colour). partner_id PK + FK to partners.
--
-- PURELY ADDITIVE: one new, empty table, one FK to partners, one unique index, three CHECKs.
-- No ALTER of an existing table, no DEFAULT on an existing table, no backfill, no DROP.
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: no code reads or writes this table yet (the theming
-- reader/writer is a later PR), so every build ignores it. Apply with /migrate-prod after this
-- merges and BEFORE the reader/writer PR merges.
--
-- The FK takes a SHARE ROW EXCLUSIVE lock on "partners" for an instant; lock_timeout makes it
-- fail fast instead of queueing live traffic behind a long transaction.
--
-- Rollback (only while no reader/writer build is live):
--   DROP TABLE "partner_sites";
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "partner_sites" (
	"partner_id" text PRIMARY KEY NOT NULL,
	"slug" text,
	"accent_color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_sites_slug_format" CHECK ("partner_sites"."slug" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
	CONSTRAINT "partner_sites_slug_not_reserved" CHECK ("partner_sites"."slug" !~ '^..--'),
	CONSTRAINT "partner_sites_accent_format" CHECK ("partner_sites"."accent_color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "partner_sites" ADD CONSTRAINT "partner_sites_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_sites_slug" ON "partner_sites" USING btree ("slug");