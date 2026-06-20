# SmartRemit architecture diagrams — how to read them

Read in order; each diagram zooms one level deeper than the last (C4-model style: context → containers → flaw overlay → one-flow sequence). In the three maps, colors mean the same thing everywhere: **blue = person**, **green = SmartRemit**, **teal = way in**, **amber = data store**, **grey dashed = outside service**, **red = confirmed weakness**. (The sequence diagram uses lanes, not colors.)

Open the `.png` files for a quick look (rendered at 3200px) or the `.svg` files in a browser for crisp infinite zoom. The `.mmd` files are the editable Mermaid sources — paste into [mermaid.live](https://mermaid.live) to tweak and re-render.

1. **`architecture-L1-context`** answers: *who and what does SmartRemit talk to?* The whole product is one green box; SmartRemit orchestrates chat, quotes, identity checks and compliance but **never holds money** — the partner's payout rail pays the recipient. ~11 boxes, 30 seconds to absorb.
2. **`architecture-L2-containers`** answers: *what runs inside, and how does one transfer flow?* Follow the numbered arrows **1 → 12**: chat → quote → pay link → screen → charge → ledger → signed payout → delivered. Dotted arrows mean "queued in the outbox and retried until done" — that queue is the system's durability spine, woken every 5 minutes by GitHub Actions (plus a daily Vercel cron for recurring transfers). The numbered story is expanded step-by-step in `end-to-end-transfer-flow`.
3. **`architecture-L3-flaws`** (flaw overlay) answers: *where do the 10 confirmed weaknesses sit?* A simplified container map; red boxes point (red dotted line) at the component that owns each weakness — process flaws (migrations, delivery guarantee) pin to GitHub Actions CI/CD, the staff-in-Redis flaw pins to the admin/staff-auth surface that chose Redis, and "one app/region/pool" pins to the platform boundary itself. **HIGH = must fix before real money moves; MEDIUM = fix as volume grows.** Every flaw was verified against the code — file evidence below.
4. **`end-to-end-transfer-flow`** is the companion sequence diagram: one transfer's lifecycle step by step, including the charge leg (mock PSP lane) and the signed rail callback into `/api/payment-webhook`.

## The 10 confirmed flaws (with evidence)

| # | Sev | Flaw | Evidence |
|---|-----|------|----------|
| 1 | HIGH | Sanctions screening is a mock exact-match list — a typo or middle initial evades it. No OFAC/vendor integration. | `src/lib/providers/sanctions-provider.ts:26-41` |
| 2 | HIGH | Sender charging is a mock PSP — no one is really charged, no rail really pays out; the money path is unproven against real PSP failure modes. | `src/lib/providers/funding-provider.ts:83-84` |
| 3 | HIGH | Prod DB migrations are manual — CI checks drift but never applies migrations anywhere; one forgotten run already caused the 2026-06-11 dashboard outage. | `.github/workflows/ci.yml` (check only) |
| 4 | HIGH | Staff accounts (password hashes, roles, partner pinning) live only in Redis — the tier the architecture itself labels "ephemeral". Redis loss = locked-out staff, no recovery. | `src/lib/auth-store.ts:14-16`; no staff table in Postgres |
| 5 | HIGH | WhatsApp (Meta) is the single channel for registration/password-reset OTPs, pay-page transaction codes, delivery notices AND the team's own stuck-money alerts — one Meta outage takes out all of them at once. No email/SMS fallback exists. | `src/lib/whatsapp.ts:371-420`; no mail/SMS provider in `package.json` |
| 6 | MED | The outbox delivery guarantee is a 5-minute GitHub Actions cron on a personal repo — best-effort scheduling, auto-disables after 60 days of inactivity. | `.github/workflows/worker-heartbeat.yml` |
| 7 | MED | Tenant isolation is app-level WHERE clauses with no Postgres row-level-security backstop; some platform methods legitimately omit the partner filter. | `src/db/repos/transfer-repo.ts:14, 256-260` |
| 8 | MED | Single FX source (Frankfurter, keyless, no SLA); on outage with a cold cache, hardcoded fallback rates (USD→INR 85) get locked into **binding** quotes with no staleness flag. | `src/lib/rate.ts:12-21, 80` |
| 9 | MED | No error tracker / APM — the only alerting is WhatsApp ops alerts to one phone (no escalation); an elevated 500-rate on `/api/pay` is invisible unless someone reads Vercel logs. | no sentry/datadog/otel in `package.json`; `src/lib/outbox-worker.ts:217` |
| 10 | MED | One Next.js app, one region, one DB pool: a landing-page deploy redeploys the bot, pay page, partner API and worker together — no blast-radius separation between marketing and money paths. | `src/app/*`, `vercel.json`, `src/db/client.ts` |

## Accuracy notes

- **Login has no OTP** (password-only since PR #118). The OTPs that exist are registration, password-reset, and the pay-page transaction code — all sent **directly, in-request**, not through the outbox. Only queued messages (agent replies, pay links, stage-1 notices, ops alerts) ride the outbox.
- Rail payout confirmations arrive as **signed inbound webhooks** (`/api/payment-webhook/[provider]`), which flip the status directly on the ledger and then send the delivered notices **best-effort** (fire-and-forget, not outbox-queued) — a known gap in the durability spine on the real-rail path; the mock rail's notices DO ride the outbox.
- KYC state's source of truth is the Persona webhook (`/api/persona-webhook`, fail-closed HMAC); sanctions screening is structurally untoggleable and runs in both KYC modes — flaw #1 is about the *quality* of the screen, not whether it runs.
- Chat replies are **at-least-once**: if the send to Meta fails after the AI already answered, the whole turn retries — money stays safe (single-use drafts, claim-first mints) but a duplicate chat message is possible.

See `../HOW-THE-BOT-WORKS.md` for the full code-verified walkthrough of the WhatsApp bot pipeline.
