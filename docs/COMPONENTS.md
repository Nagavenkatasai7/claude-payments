# Components, branches, and how to work on one thing at a time

SmartRemit is one Next.js app, but it has clear seams. Each seam is a **component** with
its own `component/<name>` branch on GitHub and a path map in `.claude/hooks/components.json`
(the hook `component-boundary.sh` uses that map to flag edits that cross a seam).

| Component | Owns (representative paths) | Branch |
|---|---|---|
| whatsapp-agent | `src/lib/agent.ts` `prompt.ts` `tools.ts` `ollama.ts` `whatsapp*.ts` `web-chat.ts` · `src/app/api/whatsapp/` `api/copilot/` | `component/whatsapp-agent` |
| money-paths | `settlement.ts` `rail-failure.ts` `pay-finalize.ts` `transfer-create.ts` `payment.ts` `refund-policy.ts` `schedule*.ts` · providers (payment/funding/webhook-verify) · `api/pay/` `api/payment-webhook/` `api/funding-webhook/` `api/partner-rail/` · dashboard transactions/refunds/schedules | `component/money-paths` |
| outbox-worker | `outbox.ts` `outbox-worker.ts` `reconcile.ts` `cron-run.ts` · `api/worker/` `api/cron/` · `worker-heartbeat.yml` · `scripts/outbox-status.ts` | `component/outbox-worker` |
| compliance-kyc | `compliance*.ts` `kyc-*.ts` `consent.ts` `tier-rules.ts` · providers (kyc/persona/sanctions) · `api/persona-webhook/` · dashboard compliance/kyc | `component/compliance-kyc` |
| partner-api | `partner-api*.ts` `partner-config.ts` `partner-integrations*.ts` `partner-store.ts` · `api/partner/` `api/partner-application/` · dashboard partners/api-keys/partner-requests · `src/app/onboard/` · demo-partner scripts | `component/partner-api` |
| admin-dashboard | `src/app/admin-dashboard/**` (minus the pages owned above) · `src/app/login/` · `api/dashboard/` · `auth*.ts` `staff-scope.ts` `permissions.ts` `dashboard*.ts` `analytics.ts` `ticket-*.ts` | `component/admin-dashboard` |
| customer-portal | `src/app/account/` `api/account/` · `customer-*.ts` `otp-store.ts` `verify-link.ts` | `component/customer-portal` |
| pay-page | `src/app/pay/` (hosted pay page UI; the finalize route is money-paths) | `component/pay-page` |
| b2b | `b2b-*.ts` · `src/app/pay/b2b/` `api/pay/b2b/` · dashboard b2b | `component/b2b` |
| corridors-fx | `rate.ts` `fx.ts` `partner-rates.ts` `partner-currency.ts` `payout-format.ts` `corridor-*.ts` · dashboard corridors/rates · rate scripts | `component/corridors-fx` |
| landing-docs | `src/app/page.tsx` `landing/` `about/` `docs/` `partners/` · `public/` | `component/landing-docs` |
| platform-security | `middleware.ts` `boot-assert.ts` `field-crypto.ts` `ip-rate-limit.ts` `redis.ts` `store.ts` · `settlement-url.ts` `safe-fetch.ts` (fix 22: the settlement-URL rule + the only rail client) · `scripts/audit-settlement-urls.ts` · `next.config` · `.github/` · `tests/e2e/` | `component/platform-security` |
| db-layer | `src/db/**` `drizzle/**` `drizzle.config.ts` (schema + migrations are *shared*: editing them never warns, but the migration-reminder hook fires) | `component/db-layer` |

**Shared** (never flagged): `types.ts` `env.ts` `utils.ts` `dates.ts` `phone.ts` `defaults.ts` `log.ts` `layout.tsx` `tailwind.css` `schema.ts` `drizzle/` `docs/` `.claude/`.

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

The Program Ledger artifact updates itself from GitHub. `scripts/tracker/sync.mjs` (pure logic in `sync-core.mjs`) reads PRs, CI and push-triggered Smoke runs with curl, compares them with a dump of the ledger database and writes ArtifactData batch files: new docs only (`prs`, `prstate`, `fixstate`, `events`, deterministic ids), plus `meta/state` pinned by version. Only a Claude agent can write the database, so Claude applies the batches with ArtifactData, following `.claude/skills/tracker-sync/SKILL.md`, in two places: a cloud routine (GitHub events and hourly, `--by cloud`) and the owner's sessions. In sessions, `.claude/hooks/ledger-journal.mjs` appends agent runs and `gh pr merge|close` commands to `~/.smartremit-ledger/journal.ndjson` (Claude adds decisions and approvals with `scripts/tracker/journal.mjs add`), the engine turns new journal lines into `events/j-*`, and the `ledger-sync-due.mjs` Stop hook asks for a sync when the journal holds an unflushed `incident`, `merge` or `migration` row (or a successful session `gh pr merge`), when routine rows are unflushed and the last sync is more than 60 minutes old, or when `main` moved since the last sync. It stays silent in the cloud (`CLAUDE_CODE_REMOTE`). The engine never writes `done`: that needs verification evidence and is written by hand.
