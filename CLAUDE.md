# CLAUDE.md — SmartRemit Project Context

Project context for any Claude session working in this repo. Keep concise; update when the architecture or stack changes meaningfully.

## What this is

**SmartRemit** (smartremit.ai) — white-label, non-custodial remittance **infrastructure**. Customers chat with an AI agent in WhatsApp to send money US→India (multi-corridor capable); **partners** (the licensed money transmitters) get a branded bot, a hosted pay page, signed settlement webhooks, a REST API, and a self-service dashboard. SmartRemit orchestrates — conversation, quoting, compliance screening, KYC flows, instructions — and **never holds funds**. Real money movement is mocked or partner-settled; the simulator rail runs the exact signed instruction→callback loop a production rail would.

**Branding (owner decision, 2026-10-04):** SmartRemit is the only brand customers and staff see: bot and email wording, the customer portal, pay pages, the partner workspace header and the admin dashboard. Partners stay behind the scenes. `resolvePartnerBranding` always returns SmartRemit (no partner logo or colour); the Reg E provider disclosure (`resolvePartnerDisclosure`) still names the licensed partner, as the law requires.

Live at **https://smartremit.ai** — the canonical production domain (the `claude-payments.vercel.app` alias still resolves for old links). Admin credentials in Vercel env `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` — never commit literal values.

## Stack notes (only what `package.json` can't tell you)

- **Neon via `drizzle-orm/neon-serverless` WebSocket Pool** — money paths need interactive transactions + `FOR UPDATE SKIP LOCKED`. Neon is THE ledger.
- **Upstash Redis is hot/ephemeral only**: sessions, conversations (30d TTL), drafts, OTPs, throttles, msg dedup, rate limits, velocity counters, FX L2 cache.
- **ONE stylesheet pipeline** (`src/app/tailwind.css`); legacy CSS deleted. **Ollama Cloud / Kimi K2.6** is the agent; Meta WhatsApp Cloud API is chat I/O (per-partner BYO numbers supported).

## Architecture spine (do not regress these)

- **Durability**: every external effect (WhatsApp sends, settlement instructions, rail callbacks, agent turns, ops alerts) is an **outbox row** written transactionally with the state change implying it. `/api/worker` drains (SKIP LOCKED, 2^n backoff, dead at 8 → deduped ops alert; `settlement.instruct` alone retries ~a day: 56 attempts, 30-min cap, plus one deduped `railfail:<partner>:<hour>` alert from attempt 3); a Vercel cron GETs it every minute (vercel.json), an hourly GitHub Actions heartbeat backs it up (GitHub actually fires it about every 4 h, up to 8.6 h apart; a failed run opens a "Scheduled workflow failing" issue), and `pokeWorker()` is the fast path (`src/lib/worker-cadence.ts` labels the source, keeps the last-cron marker in Redis and raises the `cronquiet` / `draingap` alarms; a row reclaimed past MAX_ATTEMPTS is dead-lettered without running). The worker also runs `reconcileSweep()` (stuck paid >15m → re-instruct once + alert; stale reviews >24h → alert). Outside watchdog: anonymous `GET /api/health` is 503 when the last completed full worker run (`worker:lastFullAt`, Redis only, never Neon) is older than 40 min; a Bearer `CRON_SECRET` call adds a Neon `select 1`. Poke runs also refresh that marker, so only the optional `WORKER_HEARTBEAT_URL` ping (sent after completed cron-sourced full runs) catches a dead Vercel cron. Ollama 401/402/403 raise one `llmdown:<status>:<hour>` alert.
- **Money paths are transactional**: `beginSettlement()` (src/lib/settlement.ts) commits the paid flip + stage-1 message + rail effect in ONE transaction. Minting is **claim-first**: the transfer id is bound to the idempotency key (PK `(partner_id, key)`) BEFORE the insert — crash-replays re-mint the same row; the pay-link draft is consumed AFTER the mint.
- **Tenant isolation is app-level**: partner-facing repo queries take `partnerId` in the WHERE; `getOwnedTransfer` is 404-never-403; partner-scoped staff are PINNED to their tenant regardless of filter args (test-pinned).
- **Encryption at rest** (`field-crypto.ts` envelope AES-256-GCM): payout destinations, recipient legal names, customer KYC PII, integration secrets. **Not encrypted** (crypto-06, deferred to Phase 3 fixes 45/46): sender and recipient phone numbers (lookup keys), `recipient_name`, ticket bodies, 30-day chat history in Redis. Default ledger reads are MASKED (`****last4`); decrypted reads are explicit (`getTransferDecrypted`); staff reveals are AUDITED (`pii.reveal` in `audit_events`), and every customer-identity page view writes `pii.view`. The permanent conversation log (`conversation_messages.body_enc`, v2 bound to tenant, row, thread, channel and direction) is sealed, but the 30-day Redis chat history is still plaintext, so crypto-06 is **not** closed. Log metadata (created_at, channel, direction, ciphertext length) is visible. `thread_key` is an HMAC under an HKDF of `FIELD_ENCRYPTION_KEY` (k0): retiring k0 orphans every thread join. Done outbox payloads (reply bodies, phones) stay plaintext until the 7-day scrub, and failed/dead/dismissed `agent.turn` rows keep `messageText`. Staff reads of the log write `conversation.view`.
- **Sanctions screening always runs** — structurally untoggleable, in both KYC modes. KYC may be delegated to the partner; sanctions may not.
- **Release safety (Batch 2)**: kill switches in `feature_flags` (`src/lib/flags.ts`, `sends.paused` / `settlement.paused`, global / partner / corridor; reads cached 15 s, fail open; sandbox mints never paused; written only by `applyFlagChange` from `/admin-dashboard/switches`). `release-check.yml` runs a sandbox transfer on each held production build (Vercel Deployment Checks); `smoke.yml`'s `rollback` job rolls back on a failed health or synthetic step; the worker's deploy error watch alerts `deployerrors:<sha>`. Steps: `docs/ROLLBACK.md`.
- **Security pack**: instrumentation boot assert (prod refuses to start with missing secrets — the assert's contract MUST mirror the accepting code, see the FIELD_ENCRYPTION_KEY incident), security headers + **enforced CSP**, `/account` + `/admin-dashboard` middleware gates, per-IP rate limits (fail-open) on pay/rail/webhooks, PII-scrubbing logger (`src/lib/log.ts`) in money paths.

## Repo layout

See `docs/COMPONENTS.md` (13 component anchors → directories) and `docs/architecture/smartremit-blueprint.html`. `drizzle/` holds checked-in SQL migrations (0001 seeds the 'default' partner); `tests/e2e/` is the self-provisioning Playwright smoke.

## Conventions & gotchas

- **Server actions are public POST endpoints**: every action self-gates (`require*`), validates target existence + scope before mutating, treats route params as authoritative over body fields, and guards creates against silent overwrite.
- **Pure helpers are TDD'd; UI pages are not unit-tested** — the post-deploy Playwright smoke (`tests/e2e/`, self-provisioning fixtures) is the UI verifier. **Check the `smoke.yml` run on main after every merge.**
- **e2e hooks**: `.sh-page-title`, `aside.sh-sidebar`, the four scaffold classes (`sh-main`/`sh-page-head`/`sh-page-title`/`sh-page-sub` in tailwind.css) — keep them stable or update the smoke in the same PR.
- **Test fixtures**: never hardcode dates that interact with time windows (the 3-day T0 observation window has detonated a suite before — use relative dates). Tests stub global `fetch` (Frankfurter); the FX Redis L2 is VITEST-skipped for that reason.
- **PGlite + fake timers**: `freshDb()` BEFORE `vi.useFakeTimers()`. Occasional parallel-run flakes pass in isolation.
- **`Duplicate identifier` in `.next/types/* 2.ts`** = iCloud duplicate file, not a regression: delete the ` 2` file, `rm -rf .next`.
- **iCloud evicts `node_modules`**: the repo lives in iCloud Drive with Optimize Mac Storage, so files go `dataless` (see `ls -lO`). tsc / eslint / vitest then block on first read with ~0 CPU (a 10-minute "hang" in 2026-09-07's setup). Re-materialize with `find node_modules -type f -print0 | xargs -0 -P 64 -n 100 cat >/dev/null`; the durable fix is keeping the checkout (or at least `node_modules`) outside iCloud.
- **Test memory (2026-09-21 incident)**: an uncapped `vitest run` forks 11 workers here, and 88 suites boot PGlite, so one run peaked at 10.2 GB. Four agents running it together exhausted the 24 GB Mac. Locally the config caps workers at 4 (~5 GB). Agents run the FULL suite only through `~/dev/bin/vitest-full`, a machine-wide lock allowing one full run at a time. During TDD they run targeted files with `--maxWorkers=2`, and at most **2 builder agents** run in parallel. Never kill processes with pattern `pkill`; kill by PID only.
- **Upstash**: `automaticDeserialization: false` everywhere (via the single `getRedis()`); hgetall returns flat arrays otherwise.
- **Migrations apply in the production build**: `vercel-build` (package.json) runs `scripts/migrate-on-build.mjs` before `next build`, only when `VERCEL_ENV=production` and the branch is `main` (preview and local builds skip it). drizzle selects explicit column lists, so a build that goes live before its migration breaks EVERY query on the altered table (2026-06-11 dashboard outage); applying in the build closes that gap. It takes a Postgres advisory lock on one `DATABASE_URL_UNPOOLED` connection, applies every pending additive or reviewed-before-deploy migration in drizzle's single transaction, and prints `migrate-on-build: applied <tag>` in the Vercel build log. A failed apply (or a missing database URL) fails the build, so the previous build keeps serving; it never retries. CI's `migration safety` job (`scripts/ci/migration-guard.mjs`, git only, no secrets) keeps that safe: a PR's new `drizzle/*.sql` must be **additive** (no DROP, RENAME, type change, SET NOT NULL, NOT NULL column without DEFAULT, TRUNCATE, DELETE, UPDATE) unless the file has a reviewed `-- migration-guard: allow-destructive [after-deploy] <reason>` line. The build applies a reviewed step without `after-deploy` like an additive one (it must work with the build still serving), and refuses an unmarked destructive one. An `after-deploy` step (e.g. dropping a column the new build no longer selects) is never applied by the build: it logs `after-deploy migration <tag> waits for a manual apply`, and someone runs `/migrate-prod` right after the deploy; a later migration behind an unapplied `after-deploy` step fails the build until it is applied. Generate new migrations on top of current main: the migrator skips a migration older than the newest applied one, and the guard fails it. `GET /api/version/migrations` (Bearer `CRON_SECRET` or the read-only `MIGRATIONS_READ_TOKEN`; production secrets for smoke, nightly and heartbeat live in the `prod-secrets` GitHub environment) compares the served build's journal with prod's `drizzle.__drizzle_migrations`; smoke.yml and the nightly prod smoke call it and FAIL when prod is behind or the check cannot run (missing/rejected secret, unreadable after the 5-min grace); divergence only warns. A red migration check does not roll the deploy back (only a failed health or synthetic-transfer step does, Release safety part B): read the deploy's Vercel build log, apply what is missing (`/migrate-prod` is the fallback), then re-run the smoke. Rollback steps: `docs/ROLLBACK.md`.
- **Rolling Releases are OFF** (Vercel project config `null`, checked 2026-10-05): a merge's deployment takes 100% of traffic as soon as it is ready. Browser tabs opened before a deploy keep running the build they loaded, and Instant Rollback can put an older build back, so a migration or contract change must still work for the previous build too. `smoke.yml` waits until production serves the merge SHA before testing (the wait also covers a rollout if Rolling Releases are turned back on). Still wait for the previous merge's smoke before merging the next PR, so each deploy is tested on its own.
- **Vercel CLI v54**: piped `vercel env add` stores EMPTY values (use `--value`); prod vars are sensitive-by-default so `env pull` returns `''` — verify secrets at RUNTIME.
- **Set-once, never rotate**: `FIELD_ENCRYPTION_KEY` (hex64 OR base64-32 — both valid) and `PASSWORD_PEPPER`.

## Env vars

Listed in `.env.example`. Production refuses to boot if the money-grade ones are missing (`src/lib/boot-assert.ts`); `APP_BASE_URL` self-derives on Vercel.

## Workflow rules

- **Plan first, get approval, then build** (`superpowers:brainstorming` → `writing-plans` → `subagent-driven-development` for meaningful changes).
- **No direct pushes to `main`.** GitHub branch protection (PR required, `ci / ci` check, enforce_admins) is the real gate; `guard-git-main.sh` is a local convenience guard that regex-matches and can be bypassed by quoting. Merge auto-deploys prod; then **verify the post-deploy `smoke.yml` run went green**.
- Branches: `main` deploys (GitHub `Nagavenkatasai7/claude-payments`); old `master` archived as `archive/initial-scaffold`.
- **Program Ledger** (private artifact https://claude.ai/artifact/7wD2psZ6fndztDjwZC3oNZ): the program's system of record: progress against the audit, every plan (Plans tab, `scripts/tracker/PLAN-SCHEMA.md`), and a journal of every action, including decisions, approvals (given in chat) and agent runs, all with a cited assistant. Log each action in the same turn it happens. Put `Program-Fix: <n>` (manifest fix number) on its own line in every fix PR body; run `/tracker-sync` after every merge (`/post-merge-check` does it), after verification runs and plan approvals. A fix is `done` only when merged + smoke green + verified.
- See `docs/ROADMAP.md` for feature inventory and the path to production; memory file `sendhome-total-platform-program` tracks the staged program history.

## Claude Code tooling

Plugins, hooks (`.claude/hooks/`) and skills (`.claude/skills/`) are inventoried in `docs/COMPONENTS.md`. Non-obvious bits: the GitHub MCP needs `export GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token)` in the shell; the Stop hook blocks until tsc + eslint + `vitest --changed` are green; `.env*` reads are denied (source them inside a command, never print values); force-push and any commit/push to `main` are denied.

## Ground truth & proof (non-negotiable on a money app)

- **No API from memory.** Before using an unfamiliar or fast-moving API (Next.js 16, Drizzle, Neon serverless, Upstash, Playwright, Meta Cloud API), read the installed types in `node_modules` or fetch current docs (context7 / the official site) and cite the source (file:line or URL) in the PR or the reply.
- **"Done" means proof in this session.** typecheck + lint + the relevant vitest specs ran and passed, and the output is quoted. The Stop hook enforces this; fix the failure rather than explaining around it. UI changes get a Claude-in-Chrome walk-through against the deployed page.
- **Every helper is TDD'd** (superpowers red/green); every bug fix starts with a failing test that reproduces it.
- **No collisions.** Before changing a contract (type, function signature, table, event payload, HTTP shape), `grep` every caller and update all of them + their tests in the same PR. The component-boundary hook flags cross-seam edits; treat the flag as "check callers now".
- **Security posture per change**: no secret in code or logs; PII only through the masked/encrypted paths; server actions self-gate; webhooks verify signatures fail-closed; every DB query stays tenant-scoped; new inputs are validated at the edge. Run `/security-review` before opening a PR that touches auth, money, webhooks, crypto, or compliance; run `/claude-security` on main after each release batch.

## Subagent model routing (usage budget)

**Permanent owner rule (2026-09-22, reaffirmed 2026-09-23):** every agent — builders, reviewers, fixers, lookups, money/security paths included — runs on **Opus 5.5 at medium effort**: `subagent_type: "opus-worker"` (`~/.claude/agents/opus-worker.md`) with `model: "opus"`. **Never run an agent on Fable.** The advisor model is **Opus 5.5** (owner-set via `/advisor`). A user-level PreToolUse hook (`~/.claude/hooks/block-fable-agents.mjs`) denies any Agent launch on a Fable model. Main sessions and loops also run Opus 5.5 at medium effort. Quality comes from TDD, the independent review, CI, the post-deploy smoke and the live check — not from a bigger model.

## Branching model

- `main` deploys; never commit or push to it (GitHub-protected; local hook is advisory). PR + `ci / ci` → squash-merge → `/post-merge-check` → `/sync-branches`.
- `component/<name>` (13 anchors, docs/COMPONENTS.md) stay equal to main. Cut `feat/<component>/<slug>` or `fix/<component>/<slug>` from the anchor; the prefix is what the boundary hook keys on.
- Parallel work = one git worktree per component **outside iCloud** (`git worktree add ~/dev/wt/<component> origin/component/<component>`).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
