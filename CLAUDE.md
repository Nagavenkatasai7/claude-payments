# CLAUDE.md — SmartRemit Project Context

Project context for any Claude session working in this repo. Keep concise; update when the architecture or stack changes meaningfully.

## What this is

**SmartRemit** (smartremit.ai) — white-label, non-custodial remittance **infrastructure**. Customers chat with an AI agent in WhatsApp to send money US→India (multi-corridor capable); **partners** (the licensed money transmitters) get a branded bot, a hosted pay page, signed settlement webhooks, a REST API, and a self-service dashboard. SmartRemit orchestrates — conversation, quoting, compliance screening, KYC flows, instructions — and **never holds funds**. Real money movement is mocked or partner-settled; the simulator rail runs the exact signed instruction→callback loop a production rail would.

Live at **https://smartremit.ai** — the canonical production domain (the `claude-payments.vercel.app` alias still resolves for old links). Admin credentials in Vercel env `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` — never commit literal values.

## Stack

- **Next.js 16** (App Router) on **Vercel** — serverless, Fluid Compute
- **TypeScript** + **Vitest** (~120 test files / ~1,270 tests; **PGlite** for real in-process Postgres + `fakeRedis` for Redis-side)
- **Neon Postgres** via **Drizzle ORM** (`drizzle-orm/neon-serverless` WebSocket Pool — money paths need interactive transactions + `FOR UPDATE SKIP LOCKED`) — THE ledger
- **Upstash Redis** — hot/ephemeral only: sessions, conversations (30d TTL), drafts, OTPs, throttles, msg dedup, rate limits, velocity counters, FX L2 cache
- **Tailwind v4 + shadcn/ui** — ONE stylesheet pipeline (`src/app/tailwind.css`); legacy CSS deleted
- **Ollama Cloud / Kimi K2.6** — the conversational agent; **Meta WhatsApp Cloud API** — chat I/O (per-partner BYO numbers supported)
- **Recharts** (analytics) · **Frankfurter** (live FX, no key)

## Architecture spine (do not regress these)

- **Durability**: every external effect (WhatsApp sends, settlement instructions, rail callbacks, agent turns, ops alerts) is an **outbox row** written transactionally with the state change implying it. `/api/worker` drains (SKIP LOCKED, 2^n backoff, dead at 8 → deduped ops alert); a GitHub Actions 5-min heartbeat is the delivery guarantee; `pokeWorker()` is the fast path. The worker also runs `reconcileSweep()` (stuck paid >15m → re-instruct once + alert; stale reviews >24h → alert).
- **Money paths are transactional**: `beginSettlement()` (src/lib/settlement.ts) commits the paid flip + stage-1 message + rail effect in ONE transaction. Minting is **claim-first**: the transfer id is bound to the idempotency key (PK `(partner_id, key)`) BEFORE the insert — crash-replays re-mint the same row; the pay-link draft is consumed AFTER the mint.
- **Tenant isolation is app-level**: partner-facing repo queries take `partnerId` in the WHERE; `getOwnedTransfer` is 404-never-403; partner-scoped staff are PINNED to their tenant regardless of filter args (test-pinned).
- **Encryption at rest** (`field-crypto.ts` envelope AES-256-GCM): payout destinations, recipient legal names, customer PII, integration secrets. Default ledger reads are MASKED (`****last4`); decrypted reads are explicit (`getTransferDecrypted`) and staff reveals are AUDITED (`pii.reveal` in `audit_events`).
- **Sanctions screening always runs** — structurally untoggleable, in both KYC modes. KYC may be delegated to the partner; sanctions may not.
- **Security pack**: instrumentation boot assert (prod refuses to start with missing secrets — the assert's contract MUST mirror the accepting code, see the FIELD_ENCRYPTION_KEY incident), security headers + **enforced CSP**, `/account` + `/admin-dashboard` middleware gates, per-IP rate limits (fail-open) on pay/rail/webhooks, PII-scrubbing logger (`src/lib/log.ts`) in money paths.

## Repo layout (orientation, not exhaustive)

```
src/
  db/            schema.ts (13 tables) · client.ts (getDb Pool singleton) · repos/* (transfer, partner,
                 integrations, api-key, customer, schedule, outbox, aux: idempotency/audit/beneficiaries)
  lib/           agent/tools/prompt (chat) · settlement.ts · pay-finalize.ts · outbox-worker.ts ·
                 reconcile.ts · transfer-create.ts · compliance.ts · partner-api-service.ts ·
                 *-store.ts (thin wrappers; getRedis() in redis.ts is THE shared client) ·
                 ip-rate-limit.ts · log.ts · boot-assert.ts · field-crypto.ts
  app/
    api/         whatsapp[/partnerId] (HMAC fail-closed) · pay/[id] · partner/v1/* (Bearer key) ·
                 payment-webhook/[provider] (signed) · partner-rail (hosted reference rail) ·
                 worker · cron · dashboard/summary (stamp polling)
    admin-dashboard/  shadcn pages: overview · ops · transactions (keyset paged) · schedules · customers ·
                      compliance · kyc · analytics · partners (wizard at /new, tabs at /[id]) · corridors
                      (platform-only) · team · api-keys
    account/     customer portal (WhatsApp-dark Tailwind): auth + history + receipt/[id]
    pay/[id]/    hosted pay page (WhatsApp-dark Tailwind)
    page.tsx     dual-audience landing · docs/ (partner integration hub)
    tailwind.css THE stylesheet pipeline (theme tokens, preflight, scaffold classes, keyframes)
  middleware.ts  gates /admin-dashboard (staff cookie) + /account (customer __Host- cookie)
tests/           one spec per lib module + PGlite repo/tx suites + e2e/ (Playwright smoke, self-provisioning)
drizzle/         checked-in SQL migrations (0001 seeds the 'default' partner)
```

## Conventions & gotchas

- **Server actions are public POST endpoints**: every action self-gates (`require*`), validates target existence + scope before mutating, treats route params as authoritative over body fields, and guards creates against silent overwrite.
- **Pure helpers are TDD'd; UI pages are not unit-tested** — the post-deploy Playwright smoke (`tests/e2e/`, self-provisioning fixtures) is the UI verifier. **Check the `smoke.yml` run on main after every merge.**
- **e2e hooks**: `.sh-page-title`, `aside.sh-sidebar`, the four scaffold classes (`sh-main`/`sh-page-head`/`sh-page-title`/`sh-page-sub` in tailwind.css) — keep them stable or update the smoke in the same PR.
- **Test fixtures**: never hardcode dates that interact with time windows (the 3-day T0 observation window has detonated a suite before — use relative dates). Tests stub global `fetch` (Frankfurter); the FX Redis L2 is VITEST-skipped for that reason.
- **PGlite + fake timers**: `freshDb()` BEFORE `vi.useFakeTimers()`. Occasional parallel-run flakes pass in isolation.
- **`Duplicate identifier` in `.next/types/* 2.ts`** = iCloud duplicate file, not a regression: delete the ` 2` file, `rm -rf .next`.
- **Upstash**: `automaticDeserialization: false` everywhere (via the single `getRedis()`); hgetall returns flat arrays otherwise.
- **Vercel CLI v54**: piped `vercel env add` stores EMPTY values (use `--value`); prod vars are sensitive-by-default so `env pull` returns `''` — verify secrets at RUNTIME.
- **Set-once, never rotate**: `FIELD_ENCRYPTION_KEY` (hex64 OR base64-32 — both valid) and `PASSWORD_PEPPER`.

## Key env vars (see `.env.example`)

`DATABASE_URL` (Neon) · `KV_REST_API_URL/TOKEN` (Upstash) · `FIELD_ENCRYPTION_KEY` · `PASSWORD_PEPPER` · `CRON_SECRET` (worker/cron auth) · `META_APP_SECRET` + `WHATSAPP_*` (Meta) · `OPS_ALERT_PHONE` (stuck-money WhatsApp alerts) · `OLLAMA_*` · `SEED_ADMIN_*` · `APP_BASE_URL` (self-derives on Vercel). Production refuses to boot if the money-grade ones are missing (`src/lib/boot-assert.ts`).

## Workflow rules

- **Plan first, get approval, then build** (`superpowers:brainstorming` → `writing-plans` → `subagent-driven-development` for meaningful changes).
- **No direct pushes to `main`.** PR + the `ci / ci` check; merge auto-deploys prod; then **verify the post-deploy `smoke.yml` run went green**.
- Branches: `main` deploys (GitHub `Nagavenkatasai7/claude-payments`); old `master` archived as `archive/initial-scaffold`.
- See `docs/ROADMAP.md` for feature inventory and the path to production; memory file `sendhome-total-platform-program` tracks the staged program history.
