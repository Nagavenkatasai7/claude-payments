-- 0037 — Fix pack 3 (R15, R27, R13, R26): partners.live_controls, the live
-- money controls (signed KYC posture, live certification, contract record,
-- capability opt-ins, compliance users) as one jsonb object.
-- PURELY ADDITIVE: one NOT NULL column WITH a constant DEFAULT '{}', no CHECK,
-- no index, no backfill. A constant default is catalog-only (no table rewrite)
-- but ADD COLUMN takes an ACCESS EXCLUSIVE lock for that instant; lock_timeout
-- makes it fail fast. SAFE FOR THE BUILD IN PRODUCTION: drizzle selects
-- explicit column lists, so the old build never names this column, and its
-- partner inserts (savePartner, ensureDefaultPartner) get the default.
-- Rollback: revert the code first; the column may stay (harmless).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "live_controls" jsonb DEFAULT '{}'::jsonb NOT NULL;