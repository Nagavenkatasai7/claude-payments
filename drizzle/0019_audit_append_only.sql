-- 0019 — Program-Fix 28 PR B (compliance-12): audit_events is append-only IN
-- THE DATABASE, plus the (partner_id, subject_id) index the per-subject trails
-- read (listKycForSubject, lastSendLimitChange).
--
-- SAFE FOR THE BUILD ALREADY IN PRODUCTION: no code path updates or deletes an
-- audit_events row (every writer is a plain INSERT, no upsert; see the PR's
-- writer audit and tests/audit-append-only.test.ts). The index is additive.
--
-- Scope of the guarantee: the row trigger rejects UPDATE and DELETE of any
-- existing row from the application. It is NOT a privilege boundary while the
-- app role owns the table, so a REVOKE would achieve nothing here either; a
-- separate owner role is a follow-up. There is deliberately NO TRUNCATE
-- trigger: the PGlite test reset (tests/helpers-db.ts freshDb) truncates the
-- table between tests. drizzle-kit migrate runs this file in ONE transaction
-- (so no CONCURRENTLY); lock_timeout makes it fail fast instead of queueing
-- the money transactions' audit inserts behind it.
--
-- Rollback (keeps the harmless index):
--   DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
--   DROP FUNCTION IF EXISTS audit_events_append_only();
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "audit_partner_subject" ON "audit_events" USING btree ("partner_id","subject_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % of row % rejected', TG_OP, OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
