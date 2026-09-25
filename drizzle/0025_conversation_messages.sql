-- 0025 — Partner-Demo R3b (MIGRATION-ONLY): the sealed, permanent
-- conversation log. One row per customer-visible chat message; the body is a
-- field-crypto envelope, the thread is keyed by the 32-byte auditSubjectId HMAC
-- (no plaintext phone). thread_key is keyed by an HKDF of FIELD_ENCRYPTION_KEY
-- (k0), set-once: retiring k0 would orphan every thread join.
--
-- PURELY ADDITIVE: one new, empty table, one FK to partners and one index.
-- No ALTER of an existing table's columns, no DEFAULT on an existing table, no
-- backfill, no DROP.
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: no code reads or writes this table
-- yet (the writer is a later PR), so every build ignores it. Apply with
-- /migrate-prod after this merges and BEFORE the writer PR merges.
--
-- The FK takes a SHARE ROW EXCLUSIVE lock on "partners" for an instant;
-- lock_timeout makes it fail fast instead of queueing live traffic behind a
-- long transaction.
--
-- Rollback (only while no writer build is live):
--   DROP TABLE "conversation_messages";
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"thread_key" "bytea" NOT NULL,
	"channel" smallint NOT NULL,
	"direction" smallint NOT NULL,
	"body_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_thread" ON "conversation_messages" USING btree ("partner_id","thread_key","created_at");