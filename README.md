# SendHome — WhatsApp US→India Remittance (Prototype)

A prototype, inspired by Felix Pago, that lets a US user send money to family
in India entirely through a WhatsApp conversation. An AI agent (Kimi K2.6 on
Ollama Cloud) guides the chat in English / Hindi / Hinglish, hands the user a
mock payment page, then sends WhatsApp confirmations to both sender and
recipient.

**Status:** real conversation, dashboard, and notification layers; everything
else (money movement, KYC, sanctions, payout rail) is a convincing mock. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the full feature inventory and what
turning this into a live service would require.

## What's actually live

- WhatsApp Cloud API on Meta's **test number** `+1 555-629-8293`
  (~5 verified recipients).
- Live FX from Frankfurter (cached 1 hour).
- Mock card / bank-link page at `/pay/[id]` that flips a transfer to *paid*,
  then to *delivered* ~2 minutes later via Vercel `after()` background work.
- Real WhatsApp delivery confirmation to the recipient via the approved
  `transfer_delivered` Utility template.
- Admin dashboard at `claude-payments.vercel.app/dashboard` with per-page
  views for Transactions, Schedules, Compliance, Analytics, and Team — all
  refreshing live every 5 seconds.
- Multi-user staff auth (scrypt + Redis sessions, role = admin/operator/viewer).
- Recurring transfers via daily Vercel Cron.

## What's mocked

| Layer | What we have | What real looks like |
|---|---|---|
| US funding pull | Mock card form on `/pay/[id]` | Plaid + FedNow/RTP or a BaaS partner |
| KYC | None | Persona / Onfido / Veriff |
| Sanctions | Hardcoded watchlist + per-day velocity counter | ComplyAdvantage / Sanctions.io |
| INR payout | ~2-min mock auto-advance | NIUM / M2P / direct AD-II partner |

See [docs/ROADMAP.md](docs/ROADMAP.md) for the honest scorecard.

## Architecture

```
Customer WhatsApp ⇄ Meta WhatsApp Cloud API (test number)
                      ⇣
Next.js on Vercel: /api/whatsapp · /api/pay · /api/cron · /pay · /login · /dashboard/*
                      ⇣                          ⇣
                  Upstash Redis           Ollama Cloud (Kimi K2.6)
```

The agent loop lives in [src/lib/agent.ts](src/lib/agent.ts) and calls
TypeScript tools (`get_quote`, `create_transfer`, `generate_payment_link`,
`check_payment_status`, `cancel_transfer`, `schedule_recurring_transfer`) so
all money math is deterministic and auditable.

## Setup

1. **Install:** `npm install`
2. **Upstash Redis:** in the Vercel dashboard, add the Upstash Redis
   integration from the Marketplace. It sets `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.
3. **Ollama Cloud:** set `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, and `OLLAMA_MODEL`
   (the exact Kimi K2.6 model tag).
4. **Meta WhatsApp:** create a Meta app with WhatsApp, note the test number's
   `WHATSAPP_PHONE_NUMBER_ID` and a permanent System User `WHATSAPP_TOKEN`. Add
   each demo recipient's phone number to the test number's allowed-recipients
   list.
5. **Deploy:** push to Vercel. Set `APP_BASE_URL` to the deployed URL.
6. **Webhook:** in the Meta app, set the WhatsApp webhook callback URL to
   `https://<your-app>/api/whatsapp` and the verify token to your
   `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.

Copy `.env.example` to `.env.local` for local development.

## Dev commands

```bash
npm run dev          # Local Next.js dev server
npm run build        # Production build
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (next/core-web-vitals)
npm test             # Vitest run (29 files / ~209 tests)
npm run test:watch   # Vitest watch mode
npm run e2e          # Playwright smoke test (BASE_URL defaults to prod)
```

## Contributing / CI

The deploy pipeline is GitHub-driven:

1. Branch from `main` (`git checkout -b feat/your-thing`).
2. Push. Open a PR. CI runs typecheck + lint + test + build; Vercel
   posts a preview URL.
3. Once `ci / ci` is green, merge (squash). `main` is protected — direct
   pushes are rejected.
4. The merge auto-deploys to `claude-payments.vercel.app`. A Playwright
   smoke test then logs into the live dashboard; failure shows up on the
   commit's status check.

## Project layout

```
src/
  app/                Next.js routes (api/, dashboard/, pay/, login/, receipt/)
  lib/                Domain modules — agent, tools, store, fx, compliance,
                      auth, schedules, whatsapp, payments, ollama
tests/                Vitest specs (one per src/lib/* module + e2e)
docs/                 ROADMAP.md + brainstorm specs and implementation plans
                      under docs/superpowers/
```

See [CLAUDE.md](CLAUDE.md) for the working conventions Claude follows in this
repo (live-update pattern, server-action boundary, deploy gate, etc.).

## Scope

This is a concept demo. Out of scope: real KYC, real payment/payout rails,
AML/compliance, voice notes, and corridors other than US→India. Lane C of the
roadmap describes what would have to change to lift those constraints — it's
mostly partnerships and licensing, not code.
