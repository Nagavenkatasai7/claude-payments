-- Any-to-any corridors: widen the EXISTING `default` partner so it serves
-- senders from every supported source country with an unambiguous calling code
-- (CA excluded — shares +1 with the US). The code (ensureDefaultPartner) only
-- sets this on a FRESH insert, so the already-seeded prod/default row needs this
-- one-time data update; without it, resolveSendCurrency stays single-currency
-- and every sender collapses to USD. Idempotent (re-running sets the same value).
UPDATE "partners"
SET "countries" = '["US","GB","AE","SG","AU","NZ","IN"]'::jsonb,
    "updated_at" = now()
WHERE "id" = 'default';
