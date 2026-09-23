# SmartRemit (smartremit.ai)

White-label, non-custodial remittance **infrastructure** over WhatsApp.
Customers chat with an AI agent in WhatsApp to send money across borders
(US→India first; the corridor set is configured per partner). **Partners**,
the licensed money transmitters, get a branded bot, a hosted pay page, signed
settlement webhooks, a REST API and a self-service dashboard. SmartRemit runs
the conversation, quoting, compliance screening, KYC flows and settlement
instructions. It **never holds funds**.

Live at **https://smartremit.ai**. Partner API guide: **https://smartremit.ai/docs**.

## Status: what is real, what is simulated

Real today: the AI conversation (Kimi K2.6 on Ollama Cloud), live FX quoting
(Frankfurter), the signed instruction-and-callback settlement loop, durable
processing through the outbox, the admin and partner dashboards, the customer
account portal, and WhatsApp notifications.

Simulated today:

| Layer | Today | What production needs |
|---|---|---|
| Fund movement (US funding pull) | Mock card / bank form on the hosted pay page | A funding provider (Plaid + FedNow/RTP, or a BaaS partner) |
| Payout rail | A reference **simulator** rail that runs the exact signed instruction→callback loop a production rail would | The partner's own rail (UPI/IMPS via an AD-II partner, etc.) |
| Sanctions list | Always-on screening against a built-in reference rule set (`MockSanctionsScreener`) | A commercial sanctions/AML feed behind the same `SanctionsScreener` seam |
| Identity verification | Persona integration (hosted flow + signed webhook, human-only approval); the production vendor account is not live | A production KYC vendor account (or the partner's own KYC) |
| WhatsApp number | Meta **test number** for the platform default; partners may bring their own numbers | Meta Business Verification |

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full feature inventory.

## Architecture

```
Customer WhatsApp ⇄ Meta WhatsApp Cloud API (platform or per-partner number)
                      ⇣  signed webhook, de-duplicated
Next.js 16 on Vercel
  /api/whatsapp · /api/pay · /api/worker · /api/cron · /api/partner/v1/*
  /pay/<id> (hosted pay page) · /account (customer portal)
  /admin-dashboard (staff + partner staff) · /docs (partner API guide)
                      ⇣                          ⇣
  Neon Postgres — THE ledger             Ollama Cloud (Kimi K2.6)
  (transfers, customers, partners,       the agent; money math lives in
   audit, idempotency keys, outbox)      deterministic TypeScript tools
  Upstash Redis — hot/ephemeral only
  (sessions, conversations, drafts, OTPs, throttles, rate limits, FX cache)
```

- **Durable outbox.** Every external effect (WhatsApp sends, settlement
  instructions, rail callbacks, agent turns, ops alerts) is an `outbox` row
  written in the same transaction as the state change that implies it.
  `/api/worker` drains it with retries and dead-lettering; see
  [src/lib/outbox-worker.ts](src/lib/outbox-worker.ts) and
  [docs/SYSTEM-ARCHITECTURE.md](docs/SYSTEM-ARCHITECTURE.md) for the cadence.
- **Transactional money paths.** `beginSettlement()`
  ([src/lib/settlement.ts](src/lib/settlement.ts)) commits the paid flip, the
  customer message and the rail instruction together; minting is claim-first
  on an idempotency key.
- **Tenant isolation** at the app level: partner-facing queries always carry
  the partner id.
- **Encryption at rest** (AES-256-GCM envelope) for payout destinations,
  recipient names, customer PII and integration secrets; reads are masked by
  default and staff reveals are audited.
- **Sanctions screening always runs**, in every KYC mode.

The agent loop lives in [src/lib/agent.ts](src/lib/agent.ts) and calls the
tools in [src/lib/tools.ts](src/lib/tools.ts) (quotes, transfers, pay links,
saved recipients, schedules, refunds, B2B bills and more), so all money math is
deterministic and auditable.

## Setup

1. **Install:** `npm install`
2. **Environment:** copy `.env.example` to `.env.local` and fill it in. The
   file lists every variable `src/lib/env.ts` reads, grouped by purpose; the
   first group is the eight that production refuses to boot without
   (`src/lib/boot-assert.ts`). `FIELD_ENCRYPTION_KEY` and `PASSWORD_PEPPER` are
   set-once: never rotate them.
3. **Neon Postgres and Upstash Redis:** add both from the Vercel Marketplace;
   they inject `DATABASE_URL` and `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
4. **Migrations are manual:** `set -a; source .env.local; set +a; npx drizzle-kit migrate`
   (SQL files in `drizzle/`). Nothing in CI or Vercel applies them.
5. **Meta WhatsApp:** set `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` and
   `META_APP_SECRET`. Point the app's webhook at `https://<your-app>/api/whatsapp`
   with your `WHATSAPP_VERIFY_TOKEN`, subscribed to `messages`.

## Dev commands

```bash
npm run dev          # Local Next.js dev server
npm run build        # Production build
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint, zero warnings allowed
npm test             # Vitest + PGlite (in-process Postgres) suite
npm run test:watch   # Vitest watch mode
npm run e2e          # Playwright smoke (self-provisioning fixtures)
```

The full Vitest suite is memory-heavy (many suites boot PGlite); the config
caps local workers at 4. While iterating, run targeted files:
`npx vitest run tests/<file>.test.ts --maxWorkers=2`.

## Contributing / CI

1. Branch from `main` (`fix/<component>/<slug>` or `feat/<component>/<slug>`;
   components are listed in [docs/COMPONENTS.md](docs/COMPONENTS.md)).
2. Open a PR. CI (`ci / ci`) runs typecheck, lint, the Vitest shards, the migration drift
   check and the build; Vercel posts a preview.
3. Squash-merge once `ci / ci` is green. `main` is protected.
4. The merge deploys to `smartremit.ai` as a rolling release; the post-deploy
   Playwright smoke (`smoke.yml`) runs once it reaches 100% of traffic.

## Project layout

```
src/
  app/            Next.js routes: api/, pay/, account/, admin-dashboard/,
                  docs/, about/, login/, onboard/, partners/
  lib/            Domain modules: agent, tools, prompt, settlement, outbox,
                  compliance, KYC, FX, partner config, field crypto, ...
  db/             Drizzle schema and repositories
drizzle/          Checked-in SQL migrations (applied manually)
tests/            Vitest specs; tests/e2e/ is the Playwright smoke
docs/             Architecture, roadmap, component map, plans
```

See [CLAUDE.md](CLAUDE.md) for the working conventions in this repo.
