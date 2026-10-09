# Components, branches, and how to work on one thing at a time

SmartRemit is one Next.js app, but it has clear seams. Each seam is a **component** with
its own `component/<name>` branch on GitHub and a path map in `.claude/hooks/components.json`
(the hook `component-boundary.sh` uses that map to flag edits that cross a seam).

| Component | Owns (representative paths) | Branch |
|---|---|---|
| whatsapp-agent | `src/lib/agent.ts` `agent-fallback.ts` `prompt.ts` `tools.ts` `ollama.ts` `whatsapp*.ts` `inbound-throttle.ts` (fix 34A: 20/min, 300/day per sender) `web-chat.ts` `llm-alert.ts` `llm-provider-error.ts` `voice-notes.ts` `voice-transcribe.ts` (Step 1: English voice notes via Azure AI Speech) · `src/app/api/whatsapp/` `api/copilot/` | `component/whatsapp-agent` |
| money-paths | `settlement.ts` `rail-failure.ts` `pay-finalize.ts` `transfer-create.ts` `payment.ts` `refund-policy.ts` `schedule*.ts` · providers (payment/funding/webhook-verify) · `api/pay/` `api/payment-webhook/` `api/funding-webhook/` `api/partner-rail/` · dashboard transactions/refunds/schedules | `component/money-paths` |
| outbox-worker | `outbox.ts` `outbox-worker.ts` `reconcile.ts` `worker-cadence.ts` `cron-run.ts` `health.ts` `dead-man-ping.ts` · `api/worker/` `api/cron/` `api/health/` · `worker-heartbeat.yml` · `scripts/outbox-status.ts` | `component/outbox-worker` |
| compliance-kyc | `compliance*.ts` `kyc-*.ts` `consent.ts` `tier-rules.ts` · providers (kyc/persona/sanctions) · `api/persona-webhook/` · dashboard compliance/kyc | `component/compliance-kyc` |
| partner-api | `partner-api*.ts` `partner-config.ts` `partner-integrations*.ts` `partner-store.ts` · `api/partner/` `api/partner-application/` · dashboard partners/api-keys/partner-requests · `src/app/onboard/` · demo-partner scripts | `component/partner-api` |
| admin-dashboard | `src/app/admin-dashboard/**` (minus the pages owned above) · `src/app/login/` · `api/dashboard/` · `auth*.ts` `staff-scope.ts` `permissions.ts` `dashboard*.ts` `analytics.ts` `ticket-*.ts` | `component/admin-dashboard` |
| customer-portal | `src/app/account/` `api/account/` · `customer-*.ts` `otp-store.ts` `verify-link.ts` | `component/customer-portal` |
| pay-page | `src/app/pay/` (hosted pay page UI; the finalize route is money-paths). Both `/pay/[id]` and `/pay/b2b/[id]` open with the fail-open per-IP page guard `isIpRateLimited` (`ip-rate-limit.ts`, platform-security, fix 23) before any read, and every dead link renders one generic default-branded sheet | `component/pay-page` |
| b2b | `b2b-*.ts` · `src/app/pay/b2b/` `api/pay/b2b/` · dashboard b2b | `component/b2b` |
| corridors-fx | `rate.ts` `fx.ts` `partner-rates.ts` `partner-currency.ts` `payout-format.ts` `destination-country.ts` `corridor-*.ts` · dashboard corridors/rates · rate scripts (`refresh-demo-rates.ts`, `routing-status.ts`) | `component/corridors-fx` |
| landing-docs | `src/app/page.tsx` `landing/` `about/` `docs/` `partners/` `terms/` `privacy/` `legal/` · `src/lib/legal/` · `public/` | `component/landing-docs` |
| platform-security | `proxy.ts` (the auth gate; was `middleware.ts` before fix 40) `boot-assert.ts` `field-crypto.ts` `ip-rate-limit.ts` `redis.ts` `store.ts` · `settlement-url.ts` `safe-fetch.ts` (fix 22: the settlement-URL rule + the only rail client) · `infra-error.ts` `infra-retry.ts` (one bounded retry of an idempotent read on an infra error) · `scripts/audit-settlement-urls.ts` · `blob.ts` + `admin-dashboard/partner-requests/[id]/documents/[index]/` (fix 24: partner documents in a PRIVATE Blob store, read only through this audited platform-staff route; `scripts/migrate-partner-docs-private.ts` re-issues the old public objects) · `next.config` · `.github/` · `tests/e2e/` | `component/platform-security` |
| db-layer | `src/db/**` `drizzle/**` `drizzle.config.ts` · `api/version/migrations/` (prod-vs-journal check) (schema + migrations are *shared*: editing them never warns, but the migration-reminder hook fires) | `component/db-layer` |

**Shared** (never flagged): `types.ts` `env.ts` `utils.ts` `dates.ts` `phone.ts` `defaults.ts` `log.ts` `layout.tsx` `tailwind.css` `schema.ts` `drizzle/` `docs/` `.claude/`. Also `id.ts` (fix 23): `newTransferId()` is 16 CSPRNG bytes as 22 base64url chars, used by every transfer, draft and prefixed id; ids are opaque text PKs, old 8-char ids stay valid, and no read path or CHECK constraint ever checks the format.

## The branch model

- `main` deploys production. Nothing is committed or pushed to it directly (`.claude/hooks/guard-git-main.sh` blocks it).
- `component/<name>` branches are **anchors equal to main**. They carry no commits of their own. After every merge run `/sync-branches` to fast-forward all of them.
- Work happens on `feat/<component>/<slug>` (or `fix/<component>/<slug>`) cut from the component anchor:
  ```
  git fetch origin && git checkout -b feat/b2b/invoice-reminders origin/component/b2b
  ```
  PR → `ci / ci` green → squash-merge → `/post-merge-check` → `/sync-branches`.
- The `feat/<component>/…` name is what tells `component-boundary.sh` which seam you are inside. An edit outside it produces an advisory reminder to check callers and update the contract in the same PR. It never blocks; treat it as a prompt, not noise.

## Working on several components at once

Use one git worktree per component, **outside iCloud Drive** (iCloud duplicates every synced file as `name 2.ext`, which is what breaks builds here):
```
mkdir -p ~/dev/wt
git worktree add ~/dev/wt/b2b        origin/component/b2b
git worktree add ~/dev/wt/money-paths origin/component/money-paths
cd ~/dev/wt/b2b && npm ci && cp "<repo>/.env.local" .
```
Each worktree gets its own `node_modules`, `.next`, and Claude Code session; `.claude/settings.json`, hooks, and skills are committed so every worktree has the same guardrails.

## Editing the map

`.claude/hooks/components.json` is ordered: the first component whose pattern matches wins, so specific seams (b2b, compliance-kyc, corridors-fx) sit above broad ones (money-paths, admin-dashboard). Patterns: `dir/` = prefix, `*` = glob, otherwise exact path. Keep this table and the JSON in the same PR when a seam moves.

## Program Ledger sync

The Program Ledger artifact (v2; collections, ids, writers and health thresholds in `scripts/tracker/LEDGER-SCHEMA.md`) is kept current by an hourly cloud routine whose exact prompt is `scripts/tracker/ROUTINE-PROMPT.md`; the procedure is `.claude/skills/tracker-sync/SKILL.md`. Only a Claude agent can write the database, so every CLI below writes ArtifactData batch files that Claude sends, all under a 20-minute lease in `meta/sync`. The scripts use Node built-ins only (no `npm install` in the routine); pure logic sits in `*-core.mjs` modules unit-tested in `tests/tracker-*.test.ts`. **Engine** (Part A, deterministic): `sync.mjs` (logic `sync-core.mjs`, GitHub reads in `github.mjs`) turns PRs, CI and push-triggered Smoke runs into new `prs`, `prstate`, `fixstate` (archive), `releases` and `feed-YYYY-MM/gh-*` docs plus a pinned `meta/state`. **Collect** (`collect.mjs`, logic `project-core.mjs`) normalises the project threads, PRs and Artifacts into workstream facts, stub workstreams and docs rows, and picks the threads the curator reads (at most 6 a run). **Curate**: the `ledger-curator` agent (`.claude/agents/ledger-curator.md`, Read and Write only; prompt `CURATOR-PROMPT.md`; when that agent type is not loaded, a read-only `Explore` agent returns the patch as text) proposes a patch, and `curate.mjs apply` (logic `curate-core.mjs`) accepts only ops whose verbatim evidence quotes match a fetched source. **Check**: `curate.mjs check` (logic `check-core.mjs`) writes `meta/health`, which the page shows as a banner. `note.mjs` lets any thread add an urgent inbox note; `seed-v2.mjs` (also `curate.mjs seed`) is the one-time cutover seed; `ledger-io.mjs` is the shared dump and batch I/O. The page is built by `build-page.mjs` from `page/ledger-page.src.html` and `page/page-logic.mjs` into the committed `ledger-page.html` (`page/ledger-v1.html` is the rollback copy). `snapshot.mjs` was removed. The v1 collections (events, plans, phases, fixes and the rest) are frozen and shown on the Archive tab. **Owner's Mac only:** `.claude/hooks/ledger-journal.mjs` appends agent runs and `gh pr merge|close` commands to `~/.smartremit-ledger/journal.ndjson` (`scripts/tracker/journal.mjs add` adds decisions and approvals), `sync.mjs --journal` flushes them into `feed-YYYY-MM/j-*` rows without agent rows, and the `ledger-sync-due.mjs` Stop hook asks for a sync when the journal holds an urgent unflushed row or `main` moved. The Stop hook stays silent in the cloud (`CLAUDE_CODE_REMOTE`); a cloud session's journal file is never flushed. The engine never writes `done`.
