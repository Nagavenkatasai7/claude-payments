# Records retention (DRAFT for counsel, fix pack 5)

Status: draft for counsel. Nothing in this document is enforced: no job purges any record today.

This draft lists what SmartRemit keeps, where it is kept, how long it is kept today, and the period we propose. It holds no customer data and no example bodies. Counsel sets the final periods; the sanctions spec (`docs/compliance/sanctions-screening-spec.md`, section 8) and this file are then updated to match.

## What is kept, where, and for how long today

| Record | Where | Sealed | Kept today | Proposed |
| --- | --- | --- | --- | --- |
| Rail messages (every settle and reverse instruction sent: the exact bytes POSTed; every verified callback received: the UTF-8 text the signature was verified over, a leading BOM dropped; `body_sha256` of those bytes; signature header) | `rail_messages` (migration 0039) | yes (`body_enc`, AES-256-GCM, bound to id, direction, kind) | forever (append-only against application code (trigger; not TRUNCATE, not the table-owner role): UPDATE and DELETE refused, except a key-rotation re-seal of `body_enc`) | 5 years from `created_at`, counsel to confirm |
| Instruction delivery log | `partner_webhook_deliveries` | no (ids, outcome, status, latency, `body_sha256`) | forever | 5 years |
| Screening evidence | `audit_events` (`sanctions.screen`, `sanctions.block`) | no PII in meta | forever | 5 years (sanctions spec section 8) |
| Sanctions list versions | `sanctions_list_versions` and the private Blob `sanctions-archive/` | n/a | forever (entries pruned only after a verified archive) | 5 years (spec section 8) |
| Conversation log | `conversation_messages` | yes | forever | counsel to set |
| Customer identity (name, address, date of birth, ID) | `customers` | yes | forever | counsel to set (end of relationship + N years) |
| E-SIGN consent (fix pack 6: the consent version, when it was given and when it was withdrawn; each consent and withdrawal) | `customers` (`esign_consent_version`, `esign_consented_at`, `esign_withdrawn_at`, migration 0040) and `audit_events` (`customer.consent.esign`) | no (a version and two times; no PII in meta) | forever | counsel to set |
| AML and risk hold evidence (fix pack 6: each in-mint AML hold and risk-signal hold, and each change of a corridor's AML hold rules or risk signals) | `audit_events` (`aml.hold`, `risk.signals`, `aml.hold_rules_set`, `risk_signals.set`) | no (ids and enum values only) | forever | 5 years, like the screening evidence (sanctions spec section 8) |
| Outbox payloads | `outbox` | no | payload scrubbed at 7 days (`OUTBOX_PAYLOAD_RETENTION_DAYS`), rows kept | unchanged |
| Chat history | Redis | no (crypto-06 open) | 30 days TTL | unchanged |
| Runtime logs | Vercel | n/a | Vercel buffer until a Log Drain is attached (ROADMAP) | partner's rule |

## Why 5 years

The 5-year period follows the proposal in the sanctions spec, section 8, so that the rail record, the delivery log, the screening evidence and the list versions it was screened against can be kept for the same time. The partner (the licensed money transmitter) may need to keep records longer under its own programme. An earlier planning note said 10 years for sanctions records; this draft does not adopt it: counsel decides one number per record class, and the sanctions spec is updated to match.

## How a period would be set

`live_controls.retentionYears` is a reserved key (copied as stored, never read, no writer, `src/lib/live-controls.ts`). The writer and a purge job are PR8 follow-ups. A purge of `rail_messages` needs a reviewed migration or function, because the append-only trigger refuses DELETE. The smoke cleaner (`scripts/clean-smoke-partner.ts`) never deletes these rows and skips any partner that has them.

## Erasure and correction requests

1. No app path can delete or edit a `rail_messages` row: the trigger refuses DELETE and every UPDATE except a `body_enc` re-seal, so honouring an erasure request needs a reviewed migration or function run by the table owner.
2. The sealed bodies hold the recipient account and phone numbers, sender and recipient names, and on real money the sender's address and date of birth.
3. A customer's stored address and date of birth cannot be corrected or cleared from any page or support tool today, because the writes are set-if-unset and `saveCustomer` keeps them. The portal files delete requests (`src/lib/portal-data-rights.ts`), but nothing applies them to these records.
4. Counsel decides whether AML record-keeping overrides erasure, and for how long.

## Known limits

- Append-only is against application code only: the table owner role can still TRUNCATE the table or disable the trigger (0039's header, "NOT a privilege boundary").
- An erasure or correction request cannot be applied to `rail_messages` or to a stored sender address/DOB by any app path (append-only trigger; set-once fields).
- A crash after the record and before the POST leaves an attempted-send row.
- A failing rail adds one row per POSTed attempt, with no fixed limit per transfer: up to 56 per outbox run of the settlement instruction (`INSTRUCT_MAX_ATTEMPTS`), another run of up to 56 after each ops Retry or partner Replay of a dead instruction (both set its attempts back to 0), at most one reconcile re-instruction of a stuck paid transfer (`reinstruct:<id>`, its own 56), plus one `reverse` row per `funding.refund` attempt that reaches the POST (up to 8 per run, again after each Retry).
- A build older than fix pack 5 sends unrecorded instructions (`docs/ROLLBACK.md`).
- The reference rail's inbound side, the simulator's own callback POST and funding webhooks are not recorded.
- There is no reader of the bodies yet: a staff reader with a `pii.reveal` audit and an export are follow-ups.

## Questions for counsel

1. The retention period for each record class above.
2. Whether the sealed body, or only its hash, must be kept after N years.
3. Whether the partner's own record-keeping rule overrides ours.
4. Legal hold: how a hold is placed and lifted, and which records it covers.
5. Whether AML record-keeping overrides a customer's erasure or correction request for rail messages and the stored sender address and date of birth, and how a correction is recorded (a new row, never an edit).
