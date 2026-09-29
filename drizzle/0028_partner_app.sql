-- 0028 — UI redesign M3-7 (MIGRATION-ONLY): partner-app tables + the finance staff role.
--   partner_go_live:            per-partner go-live request/approval (live API keys only after approval).
--   partner_report_jobs:        async CSV report jobs; the body is only ever content_enc (sealed, masked CSV).
--   partner_slug_tombstones:    a released slug is never reusable.
--   partner_webhook_deliveries: settlement-instruction / test-ping delivery log (no request or response body).
--   staff_role_check:           widened to a SUPERSET: 'finance' added. No column change.
--
-- NEW TABLES + ONE CHECK SWAP: the only ALTERs on an EXISTING table are DROP + ADD of the
-- staff_role_check CHECK (same name, superset). No column is added, removed, renamed or retyped
-- anywhere, so every explicit column list (db.select().from(t)) keeps its shape. The other ALTERs
-- add FKs to the NEW tables.
--
-- SAFE FOR BOTH BUILDS during the rolling release, with or without this applied: no code reads or
-- writes the new tables yet, and the build in production never writes 'finance' (every staff
-- create/edit path allowlists admin/agent/support). Apply with /migrate-prod after this merges and
-- BEFORE any reader or writer merges.
--
-- Backfill (C8): every partner that exists when this is applied is grandfathered as live (they
-- already hold live keys): one approved partner_go_live row, approved_by 'system:0028-backfill'.
-- Re-runnable: ON CONFLICT DO NOTHING never touches an existing row. Partners created later start
-- un-approved.
--
-- Locks: the FKs take SHARE ROW EXCLUSIVE on "partners" and the CHECK swap takes ACCESS EXCLUSIVE
-- on "staff" (a tiny table; the ADD re-validates every row). The whole file runs in one transaction,
-- so the CHECK is never absent to another session. The staff swap runs LAST to hold its lock for the
-- shortest time. lock_timeout makes a busy table fail the apply fast instead of queueing live
-- traffic behind it. Retry the apply if it times out.
--
-- Erasure: the four FKs are ON DELETE no action. Once applied, a partners row cannot be deleted until
-- its partner_go_live row (created by the backfill for EVERY existing partner) and any other children
-- here are deleted first (scripts/clean-smoke-partner.ts must purge partner_go_live; follow-up).
--
-- Rollback (only while no reader/writer build is live, and no staff row has role 'finance'):
--   DROP TABLE "partner_go_live"; DROP TABLE "partner_report_jobs"; DROP TABLE "partner_slug_tombstones";
--   DROP TABLE "partner_webhook_deliveries";
--   ALTER TABLE "staff" DROP CONSTRAINT "staff_role_check";
--   ALTER TABLE "staff" ADD CONSTRAINT "staff_role_check" CHECK ("staff"."role" IN ('admin','agent','support'));
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "partner_go_live" (
	"partner_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone,
	"requested_by" text,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_report_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" text NOT NULL,
	"row_count" integer,
	"claimed_at" timestamp with time zone,
	"content_enc" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "partner_report_jobs_kind" CHECK ("partner_report_jobs"."kind" IN ('settlements','transfers','fees_monthly')),
	CONSTRAINT "partner_report_jobs_status" CHECK ("partner_report_jobs"."status" IN ('queued','running','ready','failed','expired'))
);
--> statement-breakpoint
CREATE TABLE "partner_slug_tombstones" (
	"slug" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_webhook_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "partner_webhook_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text,
	"outbox_id" bigint,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_webhook_deliveries_kind" CHECK ("partner_webhook_deliveries"."kind" IN ('settlement.instruct','ping')),
	CONSTRAINT "partner_webhook_deliveries_outcome" CHECK ("partner_webhook_deliveries"."outcome" IN ('ok','http_error','network','refused'))
);
--> statement-breakpoint
ALTER TABLE "partner_go_live" ADD CONSTRAINT "partner_go_live_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_report_jobs" ADD CONSTRAINT "partner_report_jobs_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_slug_tombstones" ADD CONSTRAINT "partner_slug_tombstones_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_webhook_deliveries" ADD CONSTRAINT "partner_webhook_deliveries_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_report_jobs_partner_created" ON "partner_report_jobs" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "partner_webhook_deliveries_partner_created" ON "partner_webhook_deliveries" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- C8: grandfather every existing partner as live (after the FK exists; re-runnable).
INSERT INTO "partner_go_live" ("partner_id", "approved_at", "approved_by")
SELECT "id", now(), 'system:0028-backfill' FROM "partners"
ON CONFLICT ("partner_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT "staff_role_check";--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_role_check" CHECK ("staff"."role" IN ('admin','agent','support','finance'));
