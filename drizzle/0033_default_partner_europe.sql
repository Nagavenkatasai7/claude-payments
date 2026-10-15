-- Europe (owner, 2026-10-12): add Hong Kong, Mexico and the eight euro countries to the EXISTING
-- `default` partner, so a sender with a +852, +52 or European number gets their own currency.
-- ensureDefaultPartner (partner-repo.ts) sets DEFAULT_PARTNER_COUNTRIES only on a FRESH insert, so the
-- seeded prod row needs this one-time data update (same pattern as 0006). It only APPENDS codes the row
-- does not have yet: a country staff removed or added by hand stays as it is, and a re-run is a no-op.
-- The previous build reads the new codes as display text; only its send-currency list can show one
-- unknown entry until this build goes live.
-- migration-guard: allow-destructive appends new country codes to the default partner only; existing codes are kept
UPDATE "partners"
SET "countries" = "countries" || (
      SELECT COALESCE(jsonb_agg(code), '[]'::jsonb)
      FROM jsonb_array_elements_text('["HK","MX","DE","FR","NL","IE","IT","ES","AT","BE"]'::jsonb) AS code
      WHERE NOT ("partners"."countries" ? code)
    ),
    "updated_at" = now()
WHERE "id" = 'default';
