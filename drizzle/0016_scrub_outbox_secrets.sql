-- 0016 — DATA-ONLY scrub of the secrets earlier releases copied into
-- outbox.payload (Phase 1 Task 11 / Program-Fix 18; audit F49/F54/F58/F66).
-- No DDL: the snapshot is a copy of 0015's, so the CI drift check sees no
-- schema change. Apply AFTER the fix-11 code is deployed and the old
-- deployment is drained (the old code keeps writing creds). Idempotent.
--
-- SAFE EVEN IF RUN EARLY: a row that has not been sent yet is never degraded.
-- Its creds are removed only once they are replaceable (a back-filled
-- partnerId) or no longer needed (done/dead), and an unsent invite keeps its
-- link. What a too-early run leaves behind is visible in the SECRETS AT REST
-- section of scripts/outbox-status.ts; the runbook gate makes it empty.
-- The jsonb `?` operator is deliberately avoided (`-> key IS [NOT] NULL`
-- instead) so no driver can mistake it for a bind placeholder.

-- 1. Legacy whatsapp.* rows: record WHICH tenant's number the persisted creds
--    named, so a row that is still pending/failed — or dead and later retried
--    from the ops page — re-resolves that partner's creds at drain time instead
--    of falling back to the shared number. wa_phone_number_id is UNIQUE
--    (partner_integrations_wa_pnid, drizzle/0015), so the match is unambiguous.
UPDATE "outbox" AS o
   SET "payload" = o."payload" || jsonb_build_object('partnerId', pi."partner_id")
  FROM "partner_integrations" AS pi
 WHERE (o."payload" -> 'creds') IS NOT NULL
   AND (o."payload" -> 'partnerId') IS NULL
   AND pi."wa_phone_number_id" = o."payload" -> 'creds' ->> 'phoneNumberId';
--> statement-breakpoint
-- 2. Destroy the plaintext Meta bearer tokens at rest (F49/F54/F58) wherever
--    that cannot change who a message comes from: the row now names its
--    partner (step 1, or written that way), or it is finished (done / dead).
--    An unsent row whose number matches no current partner keeps its creds so
--    the worker's transition shim still sends it from that number, instead of
--    falling back to the shared number (and likely dead-lettering).
UPDATE "outbox" SET "payload" = "payload" - 'creds'
 WHERE ("payload" -> 'creds') IS NOT NULL
   AND (("payload" -> 'partnerId') IS NOT NULL OR "status" IN ('done', 'dead'));
--> statement-breakpoint
-- 3. Neutralise raw 30-day partner-application links at rest in cleartext
--    (F66) — ONLY on finished rows: an unsent invite would otherwise email the
--    redaction text instead of the link. Rows written by the fix-11 code carry
--    `sealed` (ciphertext) and a {{apply_link}} placeholder and are left alone.
UPDATE "outbox"
   SET "payload" = jsonb_set("payload", '{text}', to_jsonb('[redacted by migration 0016: legacy partner-application link]'::text))
 WHERE "kind" = 'email.send'
   AND "status" IN ('done', 'dead')
   AND starts_with("dedupe_key", 'partner_app_invite:')
   AND ("payload" -> 'sealed') IS NULL
   AND "payload" ->> 'text' LIKE '%/partners/apply/%';
