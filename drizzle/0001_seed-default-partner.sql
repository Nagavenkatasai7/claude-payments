-- Seed the `default` partner row — mirrors partner-store.ensureDefaultPartner()
-- (id 'default', SmartRemit Default, US, active). Idempotent on conflict so the
-- migration can re-run against any branch database.
INSERT INTO "partners" ("id", "name", "status", "countries", "kyc_mode")
VALUES ('default', 'SmartRemit Default', 'active', '["US"]'::jsonb, 'ours')
ON CONFLICT ("id") DO NOTHING;