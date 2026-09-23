-- 0023 — Program-Fix 14 PR C: the loaded sanctions lists (OFAC SDN), the
-- per-transfer screening evidence column, and two audit_events indexes.
--
-- PURELY ADDITIVE: two NEW tables (sanctions_list_versions,
-- sanctions_list_entries) with their indexes and FK, one nullable ADD COLUMN
-- (transfers.screening jsonb, no default, no backfill), and two new indexes on
-- audit_events. Nothing is dropped, renamed or rewritten, and no row is copied.
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: drizzle selects explicit column
-- lists, so the old build never names transfers.screening (its inserts leave
-- it NULL) or the new tables. Apply BEFORE merging the code that writes them.
--
-- Locks: ADD COLUMN (nullable, no default) is catalog-only but takes an ACCESS
-- EXCLUSIVE lock on "transfers", held until COMMIT — so it is the LAST
-- statement. (If 0022 is applied in the same run, its FK's SHARE ROW EXCLUSIVE
-- lock on "partners" is also held to COMMIT: partner WRITES wait for the whole
-- run, reads do not.) The two CREATE INDEX on
-- "audit_events" take a SHARE lock for the index build (blocks INSERTs into
-- audit_events, not reads, for the build — the table is small today). The
-- drizzle migrator runs every pending migration inside ONE transaction
-- (drizzle-orm pg-core/dialect.js migrate → session.transaction), so CREATE
-- INDEX CONCURRENTLY is not possible here. lock_timeout makes any of these
-- fail fast instead of queueing live traffic behind a long transaction.
--
-- Rollback: revert the code FIRST (the new build writes these), then drop the
-- two indexes, the column and the two tables; the exact statements are in the
-- PR body.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "sanctions_list_entries" (
	"version_id" bigint NOT NULL,
	"entry_id" text NOT NULL,
	"type" text NOT NULL,
	"programs" jsonb NOT NULL,
	"names" jsonb NOT NULL,
	"weak_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "sanctions_list_entries_version_id_entry_id_pk" PRIMARY KEY("version_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "sanctions_list_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sanctions_list_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"version" text NOT NULL,
	"hash" text NOT NULL,
	"entry_count" integer NOT NULL,
	"name_count" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sanctions_list_entries" ADD CONSTRAINT "sanctions_list_entries_version_id_sanctions_list_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."sanctions_list_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sanctions_list_versions_source_hash" ON "sanctions_list_versions" USING btree ("source","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sanctions_list_versions_one_active" ON "sanctions_list_versions" USING btree ("source") WHERE "sanctions_list_versions"."active";--> statement-breakpoint
CREATE INDEX "audit_subject_action" ON "audit_events" USING btree ("subject_id","action");--> statement-breakpoint
CREATE INDEX "audit_actor_type_at" ON "audit_events" USING btree ("actor_type","at" DESC NULLS LAST);--> statement-breakpoint
-- LAST on purpose: the ACCESS EXCLUSIVE lock on "transfers" is held until
-- COMMIT, so nothing else (the audit_events index builds) runs while it is held.
ALTER TABLE "transfers" ADD COLUMN "screening" jsonb;