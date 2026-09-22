# Phase 1 — Wave 2 Implementation Plan (re-planned against merged Wave 1)

**Date:** 2026-09-21 · **Program:** SmartRemit Phase 1 (post `2026-09-14` production-readiness audit, PR #241) · **Repo:** `Nagavenkatasai7/claude-payments` · **Base:** `main @ bf4b083` (Wave 1 merged: #254 outbox leases + 0014, #255 tenant-scoped customers + 0015, #256 compliance hold on every settlement path; #257 ledger snapshot tooling).

**Supersedes** the Wave 2 sections (Tasks 9, 6, 5, 11) of `docs/superpowers/plans/2026-09-16-phase1-wave1-money-safe-core.md`. Those drafts were written against `997d9e3`, before Wave 1 rewrote `beginSettlement`, `outbox-worker.ts`, `CustomerStore` and the pay route. Every task below was re-derived from `bf4b083`: anchors, call-site counts, test baselines and the rulings it operates under. That plan's **Architecture Notes, Conflict Rulings (1–33) and Migration Gate stay binding**; this document does not restate them. Each task cites the ruling numbers it depends on.

## Goal

Close four Phase-1 fixes that still leave money or secrets at risk after Wave 1:

| Order | Task | Program-Fix | What it stops | Component → branch | Migration |
|---|---|---|---|---|---|
| 1 | 9 | 13 | Quoting and minting on stale, missing or zero FX rates (AED derived from its peg; `fx_unavailable` refusals end to end) | `corridors-fx` → `fix/corridors-fx/fx-fail-loud` | none |
| 2 | 6 | 10 | Minting or settling with the masked `****last4` placeholder, or with a payout account the model chose | `whatsapp-agent` → `fix/whatsapp-agent/no-masked-destination-mint` | none |
| 3 | 5 | 9 | Staff "Cancel" (and chat `cancel_bill`) voiding a paid, charged or held transfer | `admin-dashboard` → `fix/admin-dashboard/safe-staff-cancel` | none |
| 4 | 11 | 18 | WhatsApp credentials and capability tokens persisted in outbox payloads | `outbox-worker` → `fix/outbox-worker/no-secrets-in-outbox` | `0016_scrub_outbox_secrets` (data-only) |

Merge order is fixed: **9 → 6 → 5 → 11** (rulings 13, 14, 16, 17, 20, 21 of the Wave 1 plan). Each PR is branched only after the previous one is on `main` with the post-deploy smoke green, and rebases onto it.

## How this wave is run

- **Models (owner direction 2026-09-16, supersedes the per-task "Model: Fable 5.1" lines below):** the Fable weekly budget is nearly spent, so each task is built by **Opus 5** and reviewed by a separate **Opus 5** reviewer (spec compliance, then money/security). Fable is used only if a review escalates a money-path question it cannot settle.
- **One PR per fix**, body carrying `Program-Fix: <n>` on its own line and the ruling numbers it operates under. `/security-review` before opening each PR (all four touch money, compliance, secrets or webhooks).
- **Proof per PR:** `npx tsc --noEmit`, `npx eslint --max-warnings 0`, the full `npx vitest run` with the file/test counts each task predicts, `npm run build`, and `npx drizzle-kit generate --name ci_drift_check` printing no changes (except Task 11, whose migration ships with SQL, journal entry and meta snapshot — the 0014 drift lesson).
- **After each merge:** `/post-merge-check` (CI, smoke on the merge SHA, `/tracker-sync` with the snapshot). A fix is `done` only when merged, smoke green and verified in production.
- **Owner production steps (the only ones Claude cannot run):**
  - Tasks 9, 6, 5: none beyond the post-merge smoke; Claude verifies behaviour in Chrome against smartremit.ai.
  - Task 6, before merge: a read-only count of partner-API transfers minted with a `draft:`/`b2binvoice:` key (the only rows the new edit guard cannot tell apart). Expect 0. After merge: the dry-run of the schedule-blanking script, then `--apply` only if you approve the count.
  - Task 11: after the rolling release has reached 100% (smoke's "Wait for the rolling release to reach 100%" step passed, or `/api/version?vcrrForceStable=true` reports the merge SHA), **wait at least 5 more minutes** (old lambdas drain their in-flight rows), check Vercel Skew Protection, confirm `scripts/outbox-status.ts` shows no pending WhatsApp rows, then `/migrate-prod` for `0016` (treated as destructive: it rewrites payloads). The task section has the exact commands and the verification query.

## Review round (2026-09-21)

Two independent Opus reviews ran against all four drafts; each planner then fixed its section in place. Task 6, the widest change, had a third confirmation review.

- **Consistency review** (cross-task anchors, merge order, shared files). One blocker: Task 6's `prompt.ts` edits cited line numbers that Task 9 shifts. Fixed: those edits are anchored on text. Task 9's `// [fix 6 inserts above this line]` marker in `pay-finalize.ts` is the single insertion point for Tasks 6 and 10.
- **Money/security review.** Two blockers, both in Task 6, both fixed:
  1. The model could still choose the payout destination (`create_transfer`, `create_schedule`, `send_approve_picker`, `repeat_transfer`), and anything other than `****` slipped past the mask check. Now every tool path ignores model payout arguments and resolves the stored account server-side (`resolveStoredPayout`); the payout fields are removed from the tool schemas; `isMaskedDestination` also catches `***`, `•` and `●` runs.
  2. The empty-destination exemption keyed on the model-controlled `funding_method`, so a consumer draft marked `bank_pull` could mint an uncharged payout. Now the exemption holds only for `transferType === 'b2b' && fundingMethod === 'ach_pull'`; `funding_method` is enum-checked in all four tools, and `repeat_transfer` never carries a pull method.
- **Task 6 confirmation review.** It found three more blockers, all fixed:
  1. The new "Edit bank details" write rewrote the whole row: it wiped the stored recipient legal name, had no status or payment guard, and could race a paid or held row back to unpaid. It is now a guarded update of the three payout columns only (`awaiting_payment`, uncharged, consumer, same tenant, not a partner-API row). It commits with a `transfer.payout_edit` audit row (id + last 4 only). If no row matches, it writes nothing.
  2. A payer could supply a B2B payee through the pay-page body. Now B2B drafts ignore the body, and the route never writes a B2B destination.
  3. Partner-pulled funding was still reachable on consumer rows: pre-fix schedules, and the model picking B2B via `funding_method`. Now `createTransfer` refuses consumer rows with a pull method before any write. Capture-skip and the ACH branch require `transferType === 'b2b'`, and the rail builder throws. A chat B2B send needs a business entity, `ach_pull` and the sender's own unpaid invoice (tenant-scoped lookup).
  - A narrow re-check confirmed those three fixes and found one gap: a partner-API row could look like a chat row, because the `transaction.create` audit is written outside the mint transaction and the default tenant could issue `draft:*` keys. The partner API now rejects `Idempotency-Key` values starting `draft:` or `b2binvoice:` (400). The ACH branches' whole-row `saveTransfer` on a masked read is replaced by a guarded `setAchTokenIfAbsent`. HK and MX join the pay route's accepted countries. The chat B2B bill gate also requires a non-seller USD bill for the exact amount.
  - Also from that review: body `country` must match the transfer's destination country. The B2B-history check is an exact `(partner_id, phone, recipient_phone, b2b)` query. Old schedules with invented destinations are blanked by a separate owner-run script: dry run by default, a `--before` cutoff is required, and it writes only with `--apply`.
  - Other safeguards in the revised plans: Task 9's schedule-refused ops alert is deduped per schedule per day; Task 5 routes chat `cancel_bill` through the same guarded cancel; Task 11 adds a type-aware build gate and a test-only enqueue tripwire so a secret-bearing payload cannot be reintroduced silently.

## Verification status of this plan

| Task | Status of the plan text |
|---|---|
| 9 | Executed end to end in a scratch worktree at `bf4b083`: 173 files / 2,352 tests green, tsc / eslint / build clean, no migration. |
| 6 | Plan text only (predicts +3 files, +72 tests on top of Task 9: 176 / 2,424); its new tests have not been run. The builder runs every red/green step as written. |
| 5 | Plan text with predicted counts (+1 file, +35 tests); not yet executed end to end. |
| 11 | Executed in a scratch worktree at `bf4b083` (alone, without 9/6/5): 174 files / 2,325 tests green, re-verified after the review fixes. |

The counts in each task assume that task alone on `bf4b083`. After the earlier Wave 2 tasks merge, each builder records its own baseline in Step 0 and checks the delta the task predicts.

## Known residuals (tracked, not fixed in this wave)

- Task 6: Canadian `+1` numbers cannot be told apart from US ones when rehydrating a stored account by calling code; pre-fix partner-pulled consumer rows; address-book refresh after an "Edit bank details" change.
- Task 6: OTP verify stays non-atomic (get → compare → delete); the guarded payout write removes its effect on payouts. Chat B2B sends now require `ach_pull`.
- Task 5: partner-funded rows get no partner-side cancel signal (Program-Fix 31); `cancelB2bTransferAction` permission scope.
- Task 11: a worker compatibility branch for pre-0016 payloads stays until Task 8 (Wave 4) deletes it.

---

### Wave 2


### Task 9: Make FX failure loud — refuse to quote on stale or unavailable rates, derive AED from its peg, close the 0-rate hole

**Program fix:** 13 (manifest row 13, `docs/AUDIT-2026-09-14.md:109`) · **Closes:** obs-08 (`AUDIT:1134`), money-07 (`:3877`, detail `:4020`), ui-08 (`:3129`), prs-04 (`:202`), live-02 + live-03 (`:1934`) · **Component / branch:** `corridors-fx` (`docs/COMPONENTS.md:18`) → `fix/corridors-fx/fx-fail-loud` · **Worktree (outside iCloud):** `git fetch origin && git worktree add ~/dev/wt/corridors-fx origin/component/corridors-fx && cd ~/dev/wt/corridors-fx && git checkout -b fix/corridors-fx/fx-fail-loud` (`origin/component/corridors-fx` = `origin/main` = `bf4b083` at re-plan time; if main has moved, `git rebase origin/main` first) · **Model:** Fable 5.1 (money path) · **Wave 2, merges FIRST** (before Tasks 6 → 5 → 11) · **Migration: NONE** — no `src/db/schema.ts` change; `npx drizzle-kit generate --name ci_drift_check` on the finished tree prints `No schema changes, nothing to migrate` (verified). · **Rulings this PR operates under (plan header `2026-09-16-phase1-wave1-money-safe-core.md:55-89`):** 7 (pay-finalize pre-claim order, marker line), 10 (Task 9 owns `rate.ts` incl. the fetch timeout — Task 7/PR #254 left `rate.ts` untouched, verified: `git diff --stat 997d9e3..origin/main -- src/lib/rate.ts` is empty), 11 (every `getFxRates` call site; `RateUnavailableError` is NOT a `QuoteError`), 12 (Task 9 owns `fx.ts` logic; Task 10 later changes only `MAX_USD`), 13 (no `payout-format.ts` change here), 17 (the honor-verbatim quote gains an age check). Run `/security-review` before opening the PR (money path + pricing + new alert text).

**Ground truth re-verified 2026-09-21 (this re-plan):**
- `curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' 'https://api.frankfurter.app/latest?from=USD&to=INR'` → `301 -> https://api.frankfurter.dev/v1/latest?from=USD&to=INR` (live-03; `rate.ts:82` still dials `.app`).
- `curl -s 'https://api.frankfurter.dev/v1/latest?from=USD&to=INR,GBP,CAD,SGD,AUD,NZD,HKD,MXN'` → `{"amount":1.0,"base":"USD","date":"2026-09-21","rates":{"AUD":1.401,"CAD":1.4004,"GBP":0.74656,"HKD":7.8454,"INR":95.82,"MXN":17.1917,"NZD":1.7437,"SGD":1.2748}}`; `from=GBP&to=USD,INR` → `{"INR":128.35,"USD":1.3395}`; `from=INR&to=USD,INR` → `{"rates":{"USD":0.01044}}` (the base is omitted). `rate.ts:13`'s `85` is 11.3% under the live 95.82.
- `curl -s -o /dev/null -w '%{http_code}' 'https://api.frankfurter.dev/v1/latest?from=AED&to=USD,INR'` → `404`; `/v1/currencies` lists 30 codes, no AED. Every AED quote on main is the silent `FALLBACK_FX_RATES.AED` via `rate.ts:83`.
- `AbortSignal.timeout(milliseconds: number): AbortSignal` — `node_modules/typescript/lib/lib.dom.d.ts:2793` (TypeScript 5.9.3); `tsconfig.json` `lib` includes `dom`; Wave 1 already uses it (`src/lib/whatsapp.ts:204`, `src/lib/outbox.ts:25`).
- `outbox.enqueue(kind, payload, { dedupeKey })` returns `true` only for a NEW row (`src/db/repos/outbox-repo.ts:55-71`, `onConflictDoNothing`); `'ops.alert'` (`:32`) is sent to `env.opsAlertPhone` by `src/lib/outbox-worker.ts:456-461`.
- The scrubbing logger masks every 7+ digit run (`src/lib/log.ts:26`) — log FX ages in SECONDS, never ms (3 600 001 ms would print as `…0001`).
- `http-payment-provider.ts:89` ships `fx_rate: transfer.fxRate, // FX locked at quote time` — the quoted rate is a binding instruction.
- Draft TTL 30 min (`src/lib/draft-store.ts:7`); B2B quote lock 15 min (`src/lib/b2b-quote-store.ts:14`); consumer OTP is single-use on success (`src/lib/transaction-otp.ts:81`).
- The heartbeat drains with a curl **GET** (`.github/workflows/worker-heartbeat.yml:30-33`); every poke is a **POST** (`src/lib/outbox.ts:20-26`).

**Design.** `getFxRates` becomes fail-closed and provenance-stamped: every `FxRates` it returns carries `fetchedAt` (epoch ms of the upstream fetch), `source` (`'live' | 'cache' | 'fallback'`) and `asOf` (the ECB fixing date). A failed re-fetch serves the last good rate only while it is ≤ `FX_MAX_AGE_MS` (60 min) old — from the per-instance L1 **or** the shared Redis L2, whose TTL is raised from 300 s to the ceiling so a cold instance keeps the fleet's grace window — and otherwise THROWS `RateUnavailableError` (a sibling of `QuoteError`, never a subclass). There is no static-table arm on any path: `FALLBACK_FX_RATES` is refreshed to 2026-09-21 mids, tagged `source:'fallback'`, and refused unconditionally by the new `assertRatesUsable` gate in `quote()`, `sourceForDest()` and both B2B quote functions. The host moves to `api.frankfurter.dev/v1`, each fetch gets `AbortSignal.timeout(5000)`, a failure backs off 30 s per currency, rates must be `> 0` (a missing or zero USD leg is `malformed_rates`, never a static `toUsd`), and AED is derived from the 3.6725 USD peg on every call. An INR destination no longer fetches the INR→USD leg at all (`getDestinationRates` → `undefined`): `usdPivotCrossRate` never reads it, so fetching it only added a way to refuse. `usdPivotCrossRate` treats only `null/undefined` as "no destination leg" — a supplied 0/NaN/negative is a `QuoteError` (prs-04). An approved draft quote records the fetch time of its OLDEST rate leg (`quote.fxFetchedAt`); the mint refuses (never re-quotes) once that rate is older than the ceiling. Every caller maps the refusal: 503 on both pay routes and the partner API, `fx_unavailable` pre-claim in `pay-finalize`, a customer-safe `{ error }` in every agent tool, a counted, logged and ops-alerted failure in the scheduler, "—" on the admin rates page, no figure (never a constant labelled live) on the landing page. The worker heartbeat probes every fetched currency and raises one deduped `ops.alert` per degraded/refusing currency per hour. The prompt stops the bot calling the quoted rate "mid-market" or "no markup" (live-02) and tells it to relay an FX refusal instead of estimating.

**Invariants (CLAUDE.md "Architecture spine" / "Ground truth" — restated for this task):**
- **Quoted FX is a binding instruction.** No `source:'fallback'` rate and no rate older than `FX_MAX_AGE_MS` is ever priced (`assertRatesUsable`) or minted from an approved quote (`assertQuoteOverrideFresh`, rate age measured from `quote.fxFetchedAt`).
- **Claim-first minting.** An approved quote is honored VERBATIM — a stale one is REFUSED, never re-quoted, so a crash-replay can never mint the same id at a different price. `pay-finalize`'s FX gate sits BEFORE `idem.claim` (ruling 7: kyc → masked destination (Task 6) → FX (this) → cap (Task 10) → claim), so a refusal never burns the single-use draft key — and it looks the draft's claim up first: a draft that ALREADY minted (crash after the mint, before `consumeDraft`) skips the gate and replays its transfer, never `fx_unavailable`. The partner API keeps its FX refusal AFTER the claim on purpose: a replay of an already-minted key returns 200 even during an outage, and a 503 leaves a bound-but-unminted id that a retry with the same `Idempotency-Key` mints (the existing crash-replay shape, `partner-api-service.ts:296-301`).
- **Money paths are transactional.** No refusal lands between the mint and the rail effect: every FX read happens before `finalizeCrossBorderBillPayment` / `createTransfer`, and the B2B route reads FX before the OTP check.
- **Durability.** The FX alert is an outbox `ops.alert` row (dedupe key `fx-health:<currency>:<hourBucket>` — keys are forever, the hour bucket re-alerts a lasting outage), enqueued from the worker sweep; `getFxRates` itself has no Db handle and never fires a side effect. A scheduled send refused for FX (or any other reason) enqueues its own `ops.alert` (`schedule-refused:<scheduleId>:<day>`) — the daily cron has no catch-up, so a logged-only refusal would silently drop that cycle's send.
- **PII-scrubbing logger** in money paths: `rate.ts` / `cron-run.ts` / `tools.ts` log via `logWarn`/`logError` with currency, reason and age-in-seconds only.
- **Tenant isolation / sanctions / encryption:** untouched — no query, screening or PII path changes; the ledger row shape is unchanged (`fxFetchedAt` lives only on the Redis draft and the in-memory override).
- **e2e hooks** `sh-main` / `sh-page-head` / `sh-page-title` / `sh-page-sub` on `/admin-dashboard/rates` stay byte-identical; no e2e spec asserts landing rate copy (`grep -n "mid-market\|1 USD" tests/e2e/*.ts` → nothing).
- **bot-content-guard:** new prompt/tool text contains none of `partner`, `corridor`, `watchlist`, `sanctions` (`tests/bot-content-guard.test.ts` stays green).

**Re-plan deltas vs the pre-Wave-1 draft (`draft-task9.md`) — the reviewer's checklist:**
1. Wave 1 is merged, so every line number is re-cited against `bf4b083`; tenant-keyed store calls are used as they exist (`getTransferCount(partnerId, phone)`, `createDraft({ …, partnerId })`, `draftTenant`). `rate.ts`/`fx.ts`/`b2b-quote.ts`/`rate-staleness.ts` are byte-identical to the plan base (not touched by #254/#255/#256).
2. NEW `getDestinationRates` — without it this change turns EVERY USD→INR quote into a dependency on an unused INR→USD fetch (verified: the new `rate.ts` alone, without this wiring, fails 222 tests across 16 files on `bf4b083` — every INR-destination mint now needed a live INR→USD response).
3. The draft field is `quote.fxFetchedAt` (age of the OLDEST rate leg), not `quotedAt`: with a 30-min draft TTL a `quotedAt` check can never fire, while rate age is what binds the payout. **Task 10's ordering test must build its stale-FX draft with `quote.fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1`.**
4. Dropped from the old draft: best-rate routing suppression on a cached mid (ECB publishes one fixing per business day — a ≤60-min-old cached mid is the same number), the `'derived'` source value (AED inherits the USD leg's provenance), script `process.exit` wrappers (all three scripts already fail loudly via `main().catch(…process.exit(1))`), and the `corridor-demand.ts` comment (its catch at `:158-161` already reads correctly).
5. Added vs the old draft (items marked † came from the Wave 2 review): † the claim-first replay skip in `pay-finalize` (a minted draft is never refused for FX), † a deduped `schedule-refused` ops alert (the daily cron has no catch-up), † the marker line as the one anchor for Tasks 6 AND 10, the L2 grace window + test seam, `create_schedule` no longer touching FX, `check_send_limit` / `send_approve_picker` wraps (their `resolveCurrencyAndRates` calls sit OUTSIDE any try — `tools.ts:2770-2771`, `:3135`), the live-02 prompt rules, route-level tests for both pay routes, the `ChatMock` landing consumer (`page.tsx:313`), the `/docs` 503 line, a USD B2B buyer skipping FX entirely, and `npm run build` in verification (CI runs it — `.github/workflows/ci.yml:63-64`).

**Files:**
- Modify: `src/lib/rate.ts` (whole file, 115 lines on main)
- Modify: `src/lib/fx.ts:2`, `:16-32`, `:69-70`, `:173-176`
- Modify: `src/lib/b2b-quote.ts:1`, `:91-93`, `:154-156`
- Modify: `src/lib/types.ts:356-364` (`Draft.quote.fxFetchedAt?`)
- Modify: `src/lib/transfer-create.ts:2`, `:51-60`, `:105`, `:117`, `:121`, `:150-158`
- Modify: `src/lib/pay-finalize.ts:1`, `:5`, `:37-39`, `:96-98`, `:108`, `:136-142`
- Modify: `src/app/api/pay/[transferId]/route.ts:26`, `:445-452`
- Modify: `src/lib/partner-api-service.ts:8`, `:175-178`, `:188-191`, `:332-338`
- Modify: `src/lib/tools.ts:2`, `:826`, `:856-892`, `:1152-1153`, `:1285-1288`, `:1299-1304`, `:1379-1382`, `:1702-1705`, `:2574-2575`, `:2769-2771`, `:2893-2894`, `:2964-2966`, `:3134-3135`
- Modify: `src/lib/prompt.ts:82`
- Modify: `src/app/api/pay/b2b/[invoiceId]/route.ts:11`, `:180`, `:193-196`; `src/app/pay/b2b/[invoiceId]/page.tsx:116-118` (comment only)
- Modify: `src/lib/cron-run.ts:4`, `:13-14`, `:34-38`, `:100-104`; `src/app/api/cron/route.ts:8`, `:52-53`, `:105`
- Modify: `src/lib/rate-staleness.ts:3` (+ append `sweepFxHealth`); `src/app/api/worker/route.ts:8`, `:112`, `:143`
- Modify: `src/app/admin-dashboard/rates/page.tsx:9`, `:28`, `:69-75`, `:89`
- Modify: `src/app/page.tsx:3`, `:28-29`, `:136-144`, `:256`, `:313`, `:435-438`, `:444`; `src/app/landing/RateCalculator.tsx:8-11`, `:32`, `:40`, `:80`, `:94-97`; `src/app/landing/HeroPipeline.tsx:11-14`, `:76-78`, `:83`, `:105`; `src/app/landing/showcase.tsx:20`, `:42`, `:45`, `:54`
- Modify: `src/app/docs/page.tsx:82`; `scripts/seed-demo-partners.ts:96-97` (comment)
- Create: `tests/pay-route-fx.test.ts`, `tests/pay-b2b-route-fx.test.ts`
- Test (rewrite): `tests/rate.test.ts`, `tests/fx-multi-currency.test.ts`
- Test (add cases): `tests/fx.test.ts`, `tests/b2b-quote.test.ts`, `tests/transfer-create-gate.test.ts`, `tests/pay-finalize.test.ts`, `tests/partner-api-service.test.ts`, `tests/tools.test.ts`, `tests/prompt.test.ts`, `tests/cron-run.test.ts`, `tests/rate-staleness.test.ts`
- Test (fixture updates): `tests/b2b-crossborder-pay.test.ts:9,29,37-38,292-293`, `tests/partner-api-service.test.ts:85-91`, `tests/mxn-corridor.test.ts:22-25`, `tests/hkd-corridor.test.ts:22-25`, `tests/tools.test.ts:1676-1679,1708-1713,1984-1986`, `tests/cron-run.test.ts:1,67` + the 8 `makeDeps()`/`runDueSchedules({` call sites (`db` threaded)
- NOT touched (verified): `src/lib/corridor-demand.ts` (already fail-open by design at `:152-162` — a demand ranking, not a price), `src/app/admin-dashboard/corridors/page.tsx`, `scripts/refresh-demo-rates.ts`, `scripts/promote-demo-partners.ts` (throw → `main().catch` → exit 1), `src/lib/payout-format.ts`, `drizzle/`. `scripts/routing-status.ts` exists only as an UNTRACKED file in the owner's iCloud checkout (`git status` → `?? scripts/routing-status.ts`), not on main — out of scope.

Cross-seam note: `tools.ts`/`prompt.ts` (whatsapp-agent), `transfer-create.ts`/`pay-finalize.ts`/pay route (money-paths), `partner-api-service.ts` (partner-api), B2B route/page/`b2b-quote.ts` (b2b), `cron-run.ts`/cron + worker routes (outbox-worker), landing + docs (landing-docs) — the component-boundary hook WILL flag them; ruling 11 assigns these call-site guards to this task. Acknowledge the flag in the PR body.

**Interfaces:**
- Consumes (Wave 1, on main): `store.getTransferCount(partnerId, phone)`, `draftStore.createDraft({ senderPhone, partnerId, … })`, `draftTenant(draft, store.legacyTenantOf)` (`pay-finalize.ts:81`), `createIdempotencyRepo(db).find(partnerId, key)` (`src/db/repos/aux-repos.ts:283`), `createOutboxRepo(db).enqueue` (`outbox-repo.ts:55`).
- Produces (`src/lib/rate.ts`): `type FxSource = 'live' | 'cache' | 'fallback'`; `interface FxRates { toInr; toUsd; fetchedAt?: number; source?: FxSource; asOf?: string }`; `FRANKFURTER_BASE_URL`, `FX_FETCH_TIMEOUT_MS = 5_000`, `FX_MAX_AGE_MS = 3_600_000`, `AED_PER_USD = 3.6725`, `FX_UNAVAILABLE_MESSAGE`, `FX_QUOTE_EXPIRED_MESSAGE`; `type FxUnavailableReason`; `class RateUnavailableError extends Error { reason; currency? }`; `getFxRates(source): Promise<FxRates>` (THROWS); `getFxRate(): Promise<number>` (THROWS); `getDestinationRates(dest): Promise<FxRates | undefined>`; `setFxL2ForTests(l2 | null | undefined)`; `resetRateCacheForTests()`; `FALLBACK_FX_RATES` (display-only, `source:'fallback'`), `FALLBACK_FX_RATE`.
- Produces (`src/lib/fx.ts`): `assertRatesUsable(rates: FxRates, now?: number): void`; `usdPivotCrossRate` throws `QuoteError` on a supplied non-positive `destToUsd`.
- Produces (`src/lib/transfer-create.ts`): `CreateTransferInput['quote'].fxFetchedAt?: number`; `assertQuoteOverrideFresh(q: Pick<…, 'fxFetchedAt'>, now?: number): void` (throws `RateUnavailableError('stale_quote')`). `src/lib/types.ts`: `Draft['quote'].fxFetchedAt?: number`.
- Produces (`src/lib/pay-finalize.ts`): `FinalizeResult` error union `'expired_or_used' | 'cap' | 'blocked' | 'kyc_required' | 'fx_unavailable'` and the marker line `// [fix 6 inserts above this line]` directly above the FX block. **The marker line is the single anchor for BOTH later tasks** (the same statement Task 6's plan makes): Task 6 inserts its masked-destination block directly above it; Task 10 anchors on the same marker line and places its cap check after this FX block, before `idem.claim` (ruling 7: kyc → masked destination → FX → cap → claim). The FX block also hoists `const idem = createIdempotencyRepo(db);` above the claim (the claim block reuses it). Pay route 503 body: `{ ok: false, error: FX_UNAVAILABLE_MESSAGE, reason: 'fx_unavailable' }` (Task 6 keeps this arm verbatim).
- Produces (`src/lib/rate-staleness.ts`): `FX_PROBE_CURRENCIES`, `sweepFxHealth(db, fx?: FxRatesFn, now?: Date): Promise<number>`; `/api/worker` JSON gains `fxHealth`. `src/lib/cron-run.ts`: `CronDeps` gains a REQUIRED `db: DbOrTx`; `runDueSchedules` returns `{ fired: number; failed: number }` and enqueues `ops.alert` keyed `schedule-refused:<scheduleId>:<YYYY-MM-DD>` per refused run; `/api/cron` JSON gains `failed`.
- **Outbox census (for Task 11):** this task adds TWO `ops.alert` enqueue sites — `sweepFxHealth` (`src/lib/rate-staleness.ts`) and the schedule-refused alert (`src/lib/cron-run.ts`). `git grep -n "\.enqueue(" -- src | wc -l` is 36 on `bf4b083` and **38** after this task (verified). Task 11's plan counts 37 (it already includes `sweepFxHealth`); its census must add the `cron-run.ts` site → 38. Both payloads are `{ message }` only — no credentials, nothing for Task 11 to scrub.

---

- [ ] **Step 1: `rate.ts` fails closed, stamps provenance, derives AED, dials `.dev/v1` with a timeout; INR destinations stop fetching the unused leg**

**1a — failing tests.** Replace `tests/rate.test.ts` entirely:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getFxRate, getFxRates, getDestinationRates, resetRateCacheForTests, setFxL2ForTests,
  FALLBACK_FX_RATE, FALLBACK_FX_RATES, FX_MAX_AGE_MS, AED_PER_USD,
  FRANKFURTER_BASE_URL, FX_UNAVAILABLE_MESSAGE, RateUnavailableError,
} from '@/lib/rate';

// Task 9 (fail-closed FX). Fake timers only where a test ages the cache; every
// advance is RELATIVE (never a hard-coded date — CLAUDE.md fixture rule).

beforeEach(() => {
  resetRateCacheForTests();
  setFxL2ForTests(undefined);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  setFxL2ForTests(undefined);
  vi.restoreAllMocks();
});

function mockFetch(rateINR: number, date = '2026-09-21') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ date, rates: { INR: rateINR } }) }),
  );
}

function mockFetchFailure() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

function mockFetchNonOk(status = 503) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }));
}

/** A Map-backed stand-in for the shared Redis L2 (the real one is VITEST-skipped). */
function fakeL2() {
  const m = new Map<string, string>();
  return {
    store: m,
    async get(key: string) { return m.get(key) ?? null; },
    async set(key: string, value: string) { m.set(key, value); return 'OK'; },
  };
}

describe('getFxRates — upstream contract (live-03)', () => {
  it('calls api.frankfurter.dev/v1 directly, never the 301-redirecting .app host', async () => {
    mockFetch(95.82);
    await getFxRates('USD');
    const url = String(vi.mocked(global.fetch).mock.calls[0][0]);
    expect(FRANKFURTER_BASE_URL).toBe('https://api.frankfurter.dev/v1');
    expect(url).toBe('https://api.frankfurter.dev/v1/latest?from=USD&to=INR');
  });

  it('passes an AbortSignal (the per-request timeout) to fetch', async () => {
    mockFetch(95.82);
    await getFxRates('USD');
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('stamps fetchedAt, source: live and the provider fixing date on a successful fetch', async () => {
    mockFetch(95.82, '2026-09-21');
    const before = Date.now();
    const r = await getFxRates('USD');
    expect(r).toMatchObject({ toInr: 95.82, toUsd: 1, source: 'live', asOf: '2026-09-21' });
    expect(r.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('getFxRates — never a silent constant (money-07 / obs-08)', () => {
  it('throws RateUnavailableError on a fetch failure with nothing cached', async () => {
    mockFetchFailure();
    await expect(getFxRate()).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('carries the customer-safe message, the reason and the currency', async () => {
    mockFetchNonOk(502);
    await expect(getFxRates('USD')).rejects.toMatchObject({
      name: 'RateUnavailableError', reason: 'http_502', currency: 'USD', message: FX_UNAVAILABLE_MESSAGE,
    });
  });

  it('refuses a 200 carrying INR: 0 (prs-04: a zero rate is never cached or served)', async () => {
    mockFetch(0);
    await expect(getFxRates('USD')).rejects.toMatchObject({ reason: 'malformed_rates' });
  });

  it('refuses a non-USD 200 whose USD leg is missing (no static toUsd substitution)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 128.35 } }) }));
    await expect(getFxRates('GBP')).rejects.toMatchObject({ reason: 'malformed_rates', currency: 'GBP' });
  });

  it('refuses a non-USD 200 whose USD leg is 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 128.35, USD: 0 } }) }));
    await expect(getFxRates('GBP')).rejects.toMatchObject({ reason: 'malformed_rates' });
  });
});

describe('getFxRates — the cache ceiling', () => {
  it('within the ceiling, a failed re-fetch serves the last good rate marked source: cache', async () => {
    vi.useFakeTimers();
    mockFetch(88);
    expect(await getFxRate()).toBe(88); // live
    vi.advanceTimersByTime(300_001); // past the 5-min soft TTL ⇒ a re-fetch is attempted
    mockFetchFailure();
    const stale = await getFxRates('USD');
    expect(stale).toMatchObject({ toInr: 88, source: 'cache' });
    expect(Date.now() - (stale.fetchedAt as number)).toBe(300_001);
  });

  it('beyond the ceiling, a failed re-fetch THROWS instead of serving an unbounded cache', async () => {
    vi.useFakeTimers();
    mockFetch(88);
    await getFxRate();
    vi.advanceTimersByTime(FX_MAX_AGE_MS + 1);
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toMatchObject({ name: 'RateUnavailableError', currency: 'USD' });
  });

  it('backs off for 30s after a failure (no re-dial on every quote), then retries', async () => {
    vi.useFakeTimers();
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    mockFetch(95.82);
    expect((await getFxRates('USD')).toInr).toBe(95.82);
  });

  it('a COLD instance serves the fleet L2 copy inside the ceiling when the provider is down', async () => {
    vi.useFakeTimers();
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    mockFetch(95.82);
    await getFxRates('USD'); // warm: writes L1 + L2
    expect(l2.store.has('fx:USD')).toBe(true);
    resetRateCacheForTests(); // a different (cold) instance: empty L1
    vi.advanceTimersByTime(600_000); // L2 copy is 10 min old — past the soft TTL
    mockFetchFailure();
    expect(await getFxRates('USD')).toMatchObject({ toInr: 95.82, source: 'cache' });
  });

  it('a fresh L2 copy is served as live without dialing the provider', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 95.5, toUsd: 1, fetchedAt: Date.now(), source: 'live' }));
    mockFetchFailure();
    expect(await getFxRates('USD')).toMatchObject({ toInr: 95.5, source: 'live' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('ignores a pre-deploy L2 row with no fetchedAt (its age is unknowable)', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 85, toUsd: 1 }));
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getFxRates(INR) — any-to-any source (Frankfurter omits the base currency)', () => {
  it('uses identity toInr=1 and the LIVE toUsd when the INR base is omitted from rates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 0.01044 } }) }));
    const r = await getFxRates('INR');
    expect(r).toMatchObject({ toInr: 1, toUsd: 0.01044, source: 'live' });
  });

  it('refuses (no static INR rate) when the fetch fails and nothing is cached', async () => {
    mockFetchFailure();
    await expect(getFxRates('INR')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getFxRates(AED) — derived from the USD peg (obs-08: Frankfurter 404s on AED)', () => {
  it('never fetches AED; derives both legs from the live USD leg', async () => {
    mockFetch(95.82);
    const r = await getFxRates('AED');
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('from=AED'))).toBe(false);
    expect(r.toUsd).toBeCloseTo(1 / AED_PER_USD, 10);
    expect(r.toInr).toBeCloseTo(95.82 / AED_PER_USD, 10);
    expect(r.source).toBe('live');
  });

  it('inherits the USD leg provenance — a derived rate is never fresher than its base', async () => {
    vi.useFakeTimers();
    mockFetch(95.82);
    await getFxRates('USD');
    vi.advanceTimersByTime(300_001);
    mockFetchFailure();
    expect((await getFxRates('AED')).source).toBe('cache');
  });

  it('refuses AED when the USD leg is unavailable', async () => {
    mockFetchFailure();
    await expect(getFxRates('AED')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getDestinationRates — the quote destination leg', () => {
  it('returns undefined for INR WITHOUT dialing (quote() prices INR off the source leg)', async () => {
    mockFetchFailure();
    expect(await getDestinationRates('INR')).toBeUndefined();
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('returns the destination rates otherwise, and throws like getFxRates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.3395, INR: 128.35 } }) }));
    expect(await getDestinationRates('GBP')).toMatchObject({ toUsd: 1.3395, source: 'live' });
    resetRateCacheForTests();
    mockFetchFailure();
    await expect(getDestinationRates('GBP')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getFxRate (USD→INR wrapper)', () => {
  it('returns the parsed INR rate on a successful fetch', async () => {
    mockFetch(87.5);
    expect(await getFxRate()).toBe(87.5);
  });

  it('caches the rate — a second call does not fetch again', async () => {
    mockFetch(87.5);
    await getFxRate();
    await getFxRate();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('FALLBACK_FX_RATES — display-only, structurally unquotable', () => {
  it('every entry is tagged source: fallback; FALLBACK_FX_RATE mirrors the USD entry (measured 2026-09-21)', () => {
    for (const r of Object.values(FALLBACK_FX_RATES)) expect(r.source).toBe('fallback');
    expect(FALLBACK_FX_RATE).toBe(FALLBACK_FX_RATES.USD.toInr);
    expect(FALLBACK_FX_RATE).toBe(95.82); // was 85 (−11%)
  });
});
```

Replace `tests/fx-multi-currency.test.ts` entirely:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFxRates, resetRateCacheForTests, FX_MAX_AGE_MS, RateUnavailableError } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

function mockFetch(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

describe('getFxRates', () => {
  it('USD source short-circuits toUsd=1 and fetches only INR', async () => {
    mockFetch({ rates: { INR: 85 } });
    const r = await getFxRates('USD');
    expect(r).toMatchObject({ toInr: 85, toUsd: 1, source: 'live' });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=USD');
    expect(url).toContain('to=INR');
    expect(url).not.toContain('USD,INR');
  });

  it('non-USD source returns both toInr and toUsd', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    const r = await getFxRates('GBP');
    expect(r).toMatchObject({ toInr: 108, toUsd: 1.27, source: 'live' });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=GBP');
    expect(url).toContain('to=USD,INR');
  });

  it('caches per source currency independently', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    await getFxRates('GBP');
    await getFxRates('GBP');
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1); // GBP cached
    await getFxRates('CAD'); // a distinct currency must trigger its own fetch
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });

  it('AED is derived from the USD peg, never fetched (Frankfurter 404s on AED)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('from=AED')
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, json: async () => ({ rates: { INR: 95.82 } }) }));
    const r = await getFxRates('AED');
    expect(r.toUsd).toBeCloseTo(0.27229, 5); // 1 / 3.6725
    expect(r.toInr).toBeCloseTo(26.0912, 3); // 95.82 / 3.6725
    expect(vi.mocked(global.fetch).mock.calls.every(([u]) => !String(u).includes('from=AED'))).toBe(true);
  });

  it('refuses (never caches NaN, never serves a constant) when a 200 response omits INR', async () => {
    mockFetch({ rates: { USD: 1.27 } });
    await expect(getFxRates('GBP')).rejects.toMatchObject({ name: 'RateUnavailableError', reason: 'malformed_rates' });
  });

  it('serves the cache with source: cache when a non-USD re-fetch fails INSIDE the ceiling', async () => {
    vi.useFakeTimers();
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    expect(await getFxRates('GBP')).toMatchObject({ toInr: 108, toUsd: 1.27, source: 'live' });
    vi.advanceTimersByTime(300_001);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await getFxRates('GBP')).toMatchObject({ toInr: 108, toUsd: 1.27, source: 'cache' });
  });

  it('refuses a non-USD re-fetch failure BEYOND the ceiling instead of serving an unbounded cache', async () => {
    vi.useFakeTimers();
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    await getFxRates('GBP');
    vi.advanceTimersByTime(FX_MAX_AGE_MS + 1);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    await expect(getFxRates('GBP')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});
```

`tests/mxn-corridor.test.ts:22-25` — replace the `it('has an offline fallback rate (MXN ≈ 18.5/USD)', …)` block with:

```ts
  it('has a display-only table rate (MXN ≈ 17.19/USD, measured 2026-09-21) that is never priced', () => {
    expect(FALLBACK_FX_RATES.MXN).toBeDefined();
    expect(FALLBACK_FX_RATES.MXN.toUsd).toBeCloseTo(0.0582, 4);
    expect(FALLBACK_FX_RATES.MXN.source).toBe('fallback'); // fx.ts refuses to quote it (Task 9)
  });
```

`tests/hkd-corridor.test.ts:22-25` — replace the `it('has an offline fallback rate (HKD is USD-pegged ≈ 7.8/USD)', …)` block with:

```ts
  it('has a display-only table rate (HKD is USD-pegged ≈ 7.85/USD) that is never priced', () => {
    expect(FALLBACK_FX_RATES.HKD).toBeDefined();
    expect(FALLBACK_FX_RATES.HKD.toUsd).toBeCloseTo(0.128, 2);
    expect(FALLBACK_FX_RATES.HKD.source).toBe('fallback'); // fx.ts refuses to quote it (Task 9)
  });
```

`tests/transfer-create-gate.test.ts:8` → `import { RateUnavailableError, resetRateCacheForTests } from '@/lib/rate';` and append at the end of the file:

```ts
describe('Task 9: createTransfer refuses when FX is unavailable', () => {
  it('re-quote path: Frankfurter down + nothing cached ⇒ RateUnavailableError, nothing minted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const [s, p, m] = await stores();
    await expect(createTransfer(s, p, m, baseInput())).rejects.toBeInstanceOf(RateUnavailableError);
    expect(await s.getTransferCount('default', '15551230000')).toBe(0);
  });

  it('an INR destination never fetches the unused INR→USD leg', async () => {
    const [s, p, m] = await stores();
    await createTransfer(s, p, m, baseInput());
    const urls = vi.mocked(global.fetch).mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(['https://api.frankfurter.dev/v1/latest?from=USD&to=INR']);
  });
});
```

`tests/tools.test.ts` (AED is now DERIVED — tighten the loose `toBeCloseTo(1 / 0.27, 1)` that would pass either way): `:24` → `import { resetRateCacheForTests, AED_PER_USD } from '@/lib/rate';` (Step 6 extends this import). Replace the comment at `:1676-1679` with:

```ts
  // Task 9 (obs-08): AED is DERIVED from the USD peg (AED_PER_USD = 3.6725) —
  // Frankfurter 404s on AED, so it is never fetched. USD→AED cross =
  // 1 / (1 / 3.6725) = 3.6725; for $500: Math.round(500 × 3.6725) = 1836.
  // The from=AED branch in stubAedFetch is kept only to PROVE it is never hit.
```

Replace `:1708-1713` (from `// AED amount should NOT equal the INR amount…` through `expect((r.fx_rate as number)).toBeCloseTo(1 / 0.27, 1);`) with:

```ts
    // AED amount should NOT equal the INR amount for the same $500 send
    // INR: Math.round(500 * 85) = 42500; AED: Math.round(500 * 3.6725) = 1836
    expect(r.amount_inr).toBe(1836);
    // The rate is the USD→AED peg, and AED was never fetched.
    expect(r.fx_rate as number).toBeCloseTo(AED_PER_USD, 10);
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes('from=AED'))).toBe(false);
```

and the comment at `:1984-1986` with (the assertions below it are unchanged — `1000/3.8 = 263.16` is still ≤ the new mid back-solve `1000/3.6725 = 272.29`):

```ts
    // back-solves via the USD-pivot cross-rate (USD→AED = 3.6725, the peg), so the
    // mid send ≈ $272.29 and the recipient gets exactly AED 1000. A better route
    // (3.8) yields a SMALLER send (≈ $263.16 ≤ the cap-checked $272.29), so it applies.
```

**1b — run, expect failure.**

```bash
cd ~/dev/wt/corridors-fx
npx vitest run tests/rate.test.ts tests/fx-multi-currency.test.ts tests/mxn-corridor.test.ts tests/hkd-corridor.test.ts tests/transfer-create-gate.test.ts
npx vitest run tests/tools.test.ts -t "destination_country AE returns"
```

Expected (verified on `bf4b083`): every `rate.test.ts` case fails in `beforeEach` with `TypeError: (0 , setFxL2ForTests) is not a function`; `fx-multi-currency` fails with `expected { toInr: 85, toUsd: 1 } to match object { …, source: 'live' }` and `promise resolved "{ toInr: 108, toUsd: 1.27 }" instead of rejecting`; mxn `expected 0.054 to be close to 0.0582`; hkd `expected undefined to be 'fallback'`; transfer-create-gate `promise resolved "{ id: '…', …(35) }" instead of rejecting` and `expected [ …(2) ] to deeply equal [ Array(1) ]` (main fetches `from=INR` too); tools AED `expected 1852 to be 1836`.

**1c — implementation.** Replace `src/lib/rate.ts` entirely:

```ts
import type { CurrencyCode } from './types';
import type { RedisLike } from './store';
import { logError, logWarn } from './log';

// rate.ts — the platform FX source: Frankfurter, which serves the ECB reference
// rates (one fixing per TARGET business day).
//
// FAIL CLOSED (Phase 1 Task 9). A quoted rate becomes a BINDING payout
// instruction (http-payment-provider.ts ships transfer.fxRate to the rail), so
// this module never hands out a rate it cannot vouch for:
//   • every FxRates it returns carries provenance (fetchedAt / source / asOf);
//   • a failed re-fetch serves the last good rate ONLY while it is younger than
//     FX_MAX_AGE_MS (source 'cache', logged); beyond that — or with nothing
//     cached — it THROWS RateUnavailableError;
//   • there is no static-table arm on any path. FALLBACK_FX_RATES is a display
//     table tagged source:'fallback', which fx.ts refuses to price.

export type FxSource = 'live' | 'cache' | 'fallback';

export interface FxRates {
  toInr: number; // 1 unit of source currency → INR (shown to the customer)
  toUsd: number; // 1 unit of source currency → USD (for USD-equivalent accounting)
  /** Epoch ms of the upstream fetch this rate came from. getFxRates ALWAYS sets
   *  it; optional only so hand-built literals (tests, injected fakes) compile —
   *  fx.ts gates on it whenever it is present. */
  fetchedAt?: number;
  /** 'live' = fetched inside the soft TTL; 'cache' = a re-fetch failed and this
   *  is the last good rate (≤ FX_MAX_AGE_MS old); 'fallback' = the static
   *  display table, which fx.ts refuses unconditionally. */
  source?: FxSource;
  /** The provider's fixing date (Frankfurter `date`, YYYY-MM-DD) — display only. */
  asOf?: string;
}

/** api.frankfurter.app 301-redirects every call here (live-03, verified 2026-09-21). */
export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';
/** Per-request budget. Rate fetches sit on the synchronous quote path. */
export const FX_FETCH_TIMEOUT_MS = 5_000;
/** Soft TTL: re-fetch after this (L1 = per-instance memory, L2 = shared Redis). */
const CACHE_TTL_MS = 300_000;
/** Hard ceiling: never SERVE — and fx.ts never PRICES on — a rate older than this. */
export const FX_MAX_AGE_MS = 3_600_000;
/** After a failed upstream call, do not re-dial for this long: an outage must
 *  not cost FX_FETCH_TIMEOUT_MS on every quote. Serve cache / refuse instead. */
const FAILURE_BACKOFF_MS = 30_000;

/** The dirham has been pegged at 3.6725 per USD since 1997. Frankfurter does
 *  not serve AED at all (HTTP 404, verified 2026-09-21), so AED is DERIVED from
 *  the USD leg on every call — never fetched, never cached on its own. */
export const AED_PER_USD = 3.6725;

/** Customer-safe refusal text (no internal terms — bot-content-guard). */
export const FX_UNAVAILABLE_MESSAGE =
  'Exchange rates are temporarily unavailable — please try again in a few minutes.';
export const FX_QUOTE_EXPIRED_MESSAGE =
  'That quote has expired — please ask for a fresh quote.';

export type FxUnavailableReason =
  | 'fetch_failed'
  | 'timeout'
  | `http_${number}`
  | 'malformed_rates'
  | 'stale'
  | 'fallback_table'
  | 'stale_quote';

/**
 * No rate of acceptable provenance and age exists. Deliberately NOT a
 * QuoteError subclass: QuoteError means "this request is invalid" (400 /
 * "keep the mid quote"); this means "we cannot price right now" (503 / refuse).
 * Every `instanceof QuoteError` handler carries an explicit sibling arm.
 */
export class RateUnavailableError extends Error {
  readonly reason: FxUnavailableReason;
  readonly currency?: CurrencyCode;
  constructor(reason: FxUnavailableReason, currency?: CurrencyCode) {
    super(reason === 'stale_quote' ? FX_QUOTE_EXPIRED_MESSAGE : FX_UNAVAILABLE_MESSAGE);
    this.name = 'RateUnavailableError';
    this.reason = reason;
    this.currency = currency;
  }
}

// DISPLAY ONLY — never priced (fx.ts refuses source:'fallback'). The typed
// Record keeps every CurrencyCode represented (the new-corridor checklist).
// Mids measured 2026-09-21 from api.frankfurter.dev/v1 (USD→INR 95.82):
// toUsd = 1/(USD→X), toInr = 95.82/(USD→X). They go stale the day they are
// typed — the ceiling in getFxRates, not this table, is the safety mechanism.
export const FALLBACK_FX_RATES: Record<CurrencyCode, FxRates> = {
  USD: { toInr: 95.82, toUsd: 1, source: 'fallback' },
  GBP: { toInr: 128.35, toUsd: 1.3395, source: 'fallback' },
  CAD: { toInr: 68.42, toUsd: 0.7141, source: 'fallback' },   // USD→CAD 1.4004
  AED: { toInr: 26.09, toUsd: 0.2723, source: 'fallback' },   // peg 3.6725
  SGD: { toInr: 75.16, toUsd: 0.7844, source: 'fallback' },   // USD→SGD 1.2748
  AUD: { toInr: 68.39, toUsd: 0.7138, source: 'fallback' },   // USD→AUD 1.401
  NZD: { toInr: 54.95, toUsd: 0.5735, source: 'fallback' },   // USD→NZD 1.7437
  INR: { toInr: 1, toUsd: 0.01044, source: 'fallback' },      // INR→USD 0.01044
  HKD: { toInr: 12.21, toUsd: 0.1275, source: 'fallback' },   // USD→HKD 7.8454 (pegged)
  MXN: { toInr: 5.574, toUsd: 0.05817, source: 'fallback' },  // USD→MXN 17.1917
};

/** Illustrative USD→INR for the decorative landing hero ONLY (never priced). */
export const FALLBACK_FX_RATE = FALLBACK_FX_RATES.USD.toInr;

interface StampedFxRates extends FxRates {
  fetchedAt: number;
  source: FxSource;
}

const cache = new Map<CurrencyCode, StampedFxRates>();
const lastFailure = new Map<CurrencyCode, { at: number; reason: FxUnavailableReason }>();

export function resetRateCacheForTests(): void {
  cache.clear();
  lastFailure.clear();
}

// ── L2 (shared Redis) ────────────────────────────────────────────────────────
// Skipped under vitest by default: unit tests stub GLOBAL fetch with a
// Frankfurter response, and the Upstash client rides the same fetch — it would
// parse the FX payload as a Redis REST reply. setFxL2ForTests injects a fake.
// Entries live for FX_MAX_AGE_MS (not the soft TTL) so a COLD instance can
// still serve the fleet's last good rate during an outage.
type FxL2 = Pick<RedisLike, 'get' | 'set'>;
let l2Override: FxL2 | null | undefined;

/** Test seam: a Map-backed fake, or null to force "no L2"; undefined restores the default. */
export function setFxL2ForTests(l2: FxL2 | null | undefined): void {
  l2Override = l2;
}

async function l2Client(): Promise<FxL2 | null> {
  if (l2Override !== undefined) return l2Override;
  if (process.env.VITEST) return null;
  try {
    const { getRedis } = await import('./redis');
    return getRedis();
  } catch {
    return null;
  }
}

const isPositiveFinite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

async function l2Get(source: CurrencyCode): Promise<StampedFxRates | null> {
  try {
    const l2 = await l2Client();
    if (!l2) return null;
    const raw = await l2.get(`fx:${source}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FxRates>;
    // A row written before this deploy has no fetchedAt: ignore it (its 300s
    // Redis TTL drains it) rather than guess its age.
    if (!isPositiveFinite(parsed.toInr) || !isPositiveFinite(parsed.toUsd)) return null;
    if (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt)) return null;
    return {
      toInr: parsed.toInr,
      toUsd: parsed.toUsd,
      fetchedAt: parsed.fetchedAt,
      source: 'live',
      asOf: typeof parsed.asOf === 'string' ? parsed.asOf : undefined,
    };
  } catch {
    return null; // fail-open: no L2 just means one more upstream call
  }
}

async function l2Set(source: CurrencyCode, rates: StampedFxRates): Promise<void> {
  try {
    const l2 = await l2Client();
    if (!l2) return;
    await l2.set(`fx:${source}`, JSON.stringify(rates), { ex: FX_MAX_AGE_MS / 1000 });
  } catch {
    /* best effort */
  }
}

function newer(a: StampedFxRates | undefined, b: StampedFxRates | null): StampedFxRates | undefined {
  if (!b) return a;
  if (!a) return b;
  return b.fetchedAt > a.fetchedAt ? b : a;
}

function serveCacheOrRefuse(
  source: CurrencyCode,
  best: StampedFxRates | undefined,
  now: number,
  reason: FxUnavailableReason,
): FxRates {
  // Seconds, not ms: the scrubbing logger masks any 7+ digit run.
  const ageS = best ? Math.round((now - best.fetchedAt) / 1000) : null;
  if (best && now - best.fetchedAt <= FX_MAX_AGE_MS) {
    logWarn('fx.stale-cache', `FX provider ${reason}; serving the last good rate`, {
      currency: source, ageS, reason,
    });
    return { ...best, source: 'cache' };
  }
  logError('fx.unavailable', `FX provider ${reason}; no rate inside the ceiling — refusing`, {
    currency: source, ageS, reason,
  });
  throw new RateUnavailableError(reason, source);
}

async function fetchFromProvider(
  source: CurrencyCode,
  now: number,
): Promise<StampedFxRates | FxUnavailableReason> {
  try {
    const to = source === 'USD' ? 'INR' : 'USD,INR';
    const res = await fetch(`${FRANKFURTER_BASE_URL}/latest?from=${source}&to=${to}`, {
      signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return `http_${res.status}`;
    const data = (await res.json()) as { date?: unknown; rates?: { USD?: unknown; INR?: unknown } };
    // Frankfurter OMITS the base currency from `rates`: an INR base never
    // echoes INR (identity 1) and a USD base never echoes USD (identity 1).
    const inr = source === 'INR' ? 1 : data.rates?.INR;
    const usd = source === 'USD' ? 1 : data.rates?.USD;
    // `> 0`, not just finite: a 0 would reach usdPivotCrossRate (prs-04), and a
    // missing USD leg is a malformed response — never a static toUsd.
    if (!isPositiveFinite(inr) || !isPositiveFinite(usd)) return 'malformed_rates';
    return {
      toInr: inr,
      toUsd: usd,
      fetchedAt: now,
      source: 'live',
      asOf: typeof data.date === 'string' ? data.date : undefined,
    };
  } catch (err) {
    return err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
  }
}

export async function getFxRates(source: CurrencyCode): Promise<FxRates> {
  if (source === 'AED') {
    const usd = await getFxRates('USD');
    // Derived, never fresher than its USD leg (same fetchedAt / source / asOf).
    return { ...usd, toUsd: 1 / AED_PER_USD, toInr: usd.toInr / AED_PER_USD };
  }

  const now = Date.now();
  const l1 = cache.get(source);
  if (l1 && now - l1.fetchedAt < CACHE_TTL_MS) return l1;

  // Shared L2 before the upstream call — one Frankfurter fetch per soft TTL
  // across the whole fleet, not per instance.
  const shared = await l2Get(source);
  if (shared && now - shared.fetchedAt < CACHE_TTL_MS) {
    cache.set(source, shared);
    return shared;
  }
  const best = newer(l1, shared);

  const recent = lastFailure.get(source);
  if (recent && now - recent.at < FAILURE_BACKOFF_MS) {
    return serveCacheOrRefuse(source, best, now, recent.reason);
  }

  const fetched = await fetchFromProvider(source, now);
  if (typeof fetched !== 'string') {
    cache.set(source, fetched);
    lastFailure.delete(source);
    await l2Set(source, fetched);
    return fetched;
  }
  lastFailure.set(source, { at: now, reason: fetched });
  return serveCacheOrRefuse(source, best, now, fetched);
}

/** Thin USD→INR wrapper. Throws RateUnavailableError exactly like getFxRates. */
export async function getFxRate(): Promise<number> {
  return (await getFxRates('USD')).toInr;
}

/**
 * The destination leg quote()/sourceForDest() need: undefined for an INR
 * destination (usdPivotCrossRate prices INR off the SOURCE leg's toInr and never
 * reads an INR→USD rate — fetching it would only add a way to refuse a quote
 * that does not depend on it), otherwise the destination's rates (callers pass
 * `.toUsd`). Throws RateUnavailableError exactly like getFxRates.
 */
export async function getDestinationRates(destinationCurrency: CurrencyCode): Promise<FxRates | undefined> {
  return destinationCurrency === 'INR' ? undefined : getFxRates(destinationCurrency);
}
```

Wire the destination leg at the three quote call sites (the INR→USD leg is no longer fetched):

`src/lib/transfer-create.ts:2` → `import { getDestinationRates, getFxRates } from './rate';` and replace `:154-158` (from `const rates = await getFxRates(input.sourceCurrency);` through the `q = quote(…destRates.toUsd);` line) with:

```ts
    const rates = await getFxRates(input.sourceCurrency);
    // The destination leg for the USD-pivot cross-rate (undefined for INR —
    // quote() prices INR off rates.toInr). Both legs THROW RateUnavailableError
    // when no rate inside the ceiling exists: it propagates as a clean refusal
    // that every mint caller maps (503 / friendly tool error / fx_unavailable).
    const destRates = await getDestinationRates(destinationCurrency);
    q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount, destinationCurrency, destRates?.toUsd);
```

`src/lib/partner-api-service.ts:8` → `import { getDestinationRates, getFxRates } from './rate';` and replace `:176-178` with:

```ts
    const destRates = await getDestinationRates(destinationCurrency);
    // transferCount drives the fee tier; a partner-API quote uses standard pricing.
    const q = quote(amount, sourceCurrency, rates, 'bank_transfer', 1, destinationCurrency, destRates?.toUsd);
```

`src/lib/tools.ts:2` → `import { getDestinationRates, getFxRates, type FxRates } from './rate';`; in `resolveCurrencyAndRates` change the return type's `destToUsd: number;` (`:867`) to `destToUsd: number | undefined;` and replace `:889-891` with:

```ts
  // undefined for INR: quote() prices an INR destination off rates.toInr.
  const destRates = await getDestinationRates(destinationCurrency);

  return { customer, partner, sourceCurrency, rates, destinationCountry, destinationCurrency, destToUsd: destRates?.toUsd };
```

(`quote()` and `sourceForDest()` already take `destToUsd?: number` — `fx.ts:68`, `:171` — so every consumer of `destToUsd` compiles unchanged.)

Fixture updates the new `rate.ts` forces (both verified necessary):

`tests/b2b-crossborder-pay.test.ts` — the refreshed table moves HKD→USD from 0.128 to 0.1275, and Step 2 makes the table unquotable, so pin the figures the fixtures were written against. `:9` → `import type { FxRates } from '@/lib/rate';`; insert after `:29` (`const INVOICED_AMOUNT = 1000; …`):

```ts

// Offline FX literals. Task 9: the static display table in rate.ts is tagged
// source:'fallback' and is UNQUOTABLE, so these fixtures pin the exact figures
// it used to carry (USD→INR 85, HKD→USD 0.128 ⇒ 7.8125 HKD per USD).
const OFFLINE_USD: FxRates = { toInr: 85, toUsd: 1 };
const HKD_TO_USD = 0.128;
```

and change BOTH `rates: FALLBACK_FX_RATES.USD,` / `sellerToUsd: FALLBACK_FX_RATES.HKD.toUsd,` pairs (`:37-38`, `:292-293`) to `rates: OFFLINE_USD,` / `sellerToUsd: HKD_TO_USD,` (the `3906.25` expectation at `:336` stays exact).

`tests/partner-api-service.test.ts:85-91` — the stub returned `{ INR: 85.2 }` for EVERY base, so a GBP/INR leg used to fall into the silent static `toUsd`; it is now `malformed_rates`. Replace the `beforeEach` with a realistic stub:

```ts
// A realistic Frankfurter stub: a USD base echoes INR only; any other base
// echoes BOTH legs (Task 9: a non-USD response missing its USD leg is now a
// refusal, never a static-table substitution).
function frankfurterStub(url: string) {
  const rates = String(url).includes('from=USD') ? { INR: 85.2 } : { USD: 1.27, INR: 108.2 };
  return { ok: true, json: async () => ({ rates }), text: async () => '' };
}

beforeEach(() => {
  resetRateCacheForTests();
  vi.mocked(pokeWorker).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => frankfurterStub(url)));
});
```

**1d — run, expect green.**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: all green (on `bf4b083`: 171 files, 2310 tests), tsc clean. (`rate.ts` logs `fx.unavailable` lines to stderr in the refusal tests — expected.)

**1e — commit.**

```bash
git add src/lib/rate.ts src/lib/transfer-create.ts src/lib/partner-api-service.ts src/lib/tools.ts \
  tests/rate.test.ts tests/fx-multi-currency.test.ts tests/mxn-corridor.test.ts tests/hkd-corridor.test.ts \
  tests/transfer-create-gate.test.ts tests/tools.test.ts tests/b2b-crossborder-pay.test.ts tests/partner-api-service.test.ts
git commit -m "fix(corridors-fx): fail closed on stale/unavailable FX; derive AED from the USD peg

getFxRates stamps fetchedAt/source/asOf, serves a cached rate only inside a
60-min ceiling (L1 or the fleet L2, now kept for the ceiling) and throws
RateUnavailableError beyond it — no static-table arm on any path. Dials
api.frankfurter.dev/v1 (the .app host 301s) with AbortSignal.timeout(5000),
backs off 30s per currency after a failure, requires rates > 0, derives AED
from 3.6725/USD (Frankfurter 404s on AED) and refreshes the display-only
table to 2026-09-21 mids tagged source:'fallback'. INR destinations no longer
fetch the unused INR→USD leg (getDestinationRates).

Refs: obs-08, money-07, prs-04, live-03."
```

(End every commit message with the attribution trailer lines — `Co-Authored-By:` / `Claude-Session:` — exactly as the EXECUTING session's system reminder gives them.)

- [ ] **Step 2: `fx.ts` closes the 0-rate hole and gates every price on provenance; both B2B quotes too**

**2a — failing tests.** `tests/fx.test.ts:2-3` → 

```ts
import {
  sourceForInr, sourceForDest, quote, QuoteError, MIN_USD, MAX_USD, wouldBeFeeUsd,
  usdPivotCrossRate, assertRatesUsable,
} from '@/lib/fx';
import { FALLBACK_FX_RATES, FX_MAX_AGE_MS, RateUnavailableError, type FxRates } from '@/lib/rate';
```

and append:

```ts
describe('Task 9 / prs-04: a destination USD rate of 0 is a refusal, never a silent INR-branch quote', () => {
  it('quote(100, USD, {85,1}, …, AED, 0) throws (audit repro: returned fxRate 85 / amountInr 8500 labelled AED)', () => {
    expect(() => quote(100, 'USD', USD, 'bank_transfer', 0, 'AED', 0)).toThrow(QuoteError);
    expect(() => quote(100, 'USD', USD, 'bank_transfer', 0, 'AED', 0)).toThrow('Invalid exchange rate; please try again.');
  });

  it('sourceForDest with destToUsd 0 throws (audit repro: returned 2.94 — 250 ÷ toInr)', () => {
    expect(() => sourceForDest(250, USD, 'AED', 0)).toThrow(QuoteError);
  });

  it('usdPivotCrossRate: null/undefined keeps the INR branch; 0, NaN and negatives throw', () => {
    expect(usdPivotCrossRate(USD, 'INR', undefined)).toBe(85);
    expect(usdPivotCrossRate(USD, 'INR', 0)).toBe(85); // INR destination never reads destToUsd
    expect(() => usdPivotCrossRate(USD, 'AED', 0)).toThrow(QuoteError);
    expect(() => usdPivotCrossRate(USD, 'AED', Number.NaN)).toThrow(QuoteError);
    expect(() => usdPivotCrossRate(USD, 'AED', -1)).toThrow(QuoteError);
    expect(usdPivotCrossRate(USD, 'AED', 1 / 3.6725)).toBeCloseTo(3.6725, 10);
  });
});

describe('Task 9 / money-07: the provenance gate — never price off the display table or a rate beyond the ceiling', () => {
  const stale = (): FxRates => ({ toInr: 85, toUsd: 1, fetchedAt: Date.now() - FX_MAX_AGE_MS - 1, source: 'cache' });
  const fresh = (): FxRates => ({ toInr: 95.82, toUsd: 1, fetchedAt: Date.now(), source: 'live' });

  it('quote() refuses a rate whose fetchedAt is beyond FX_MAX_AGE_MS', () => {
    expect(() => quote(100, 'USD', stale(), 'bank_transfer', 0)).toThrow(RateUnavailableError);
  });

  it('quote() refuses the static display table unconditionally (source: fallback)', () => {
    expect(() => quote(100, 'USD', FALLBACK_FX_RATES.USD, 'bank_transfer', 0)).toThrow(RateUnavailableError);
  });

  it('sourceForDest() and sourceForInr() apply the same gate', () => {
    expect(() => sourceForDest(8500, stale())).toThrow(RateUnavailableError);
    expect(() => sourceForInr(8500, FALLBACK_FX_RATES.USD)).toThrow(RateUnavailableError);
  });

  it('RateUnavailableError is NOT a QuoteError (every QuoteError arm needs a sibling arm)', () => {
    let caught: unknown;
    try { quote(100, 'USD', stale(), 'bank_transfer', 0); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RateUnavailableError);
    expect(caught).not.toBeInstanceOf(QuoteError);
  });

  it('a fresh live rate and a provenance-less literal both still quote', () => {
    expect(quote(100, 'USD', fresh(), 'bank_transfer', 0).amountInr).toBe(9582);
    expect(quote(100, 'USD', USD, 'bank_transfer', 0).amountInr).toBe(8500);
  });

  it('assertRatesUsable: reason fallback_table / stale; exactly at the ceiling is still usable', () => {
    const now = Date.now();
    expect(() => assertRatesUsable(FALLBACK_FX_RATES.GBP, now)).toThrow(expect.objectContaining({ reason: 'fallback_table' }));
    expect(() => assertRatesUsable({ ...fresh(), fetchedAt: now - FX_MAX_AGE_MS - 1 }, now)).toThrow(expect.objectContaining({ reason: 'stale' }));
    expect(() => assertRatesUsable({ ...fresh(), fetchedAt: now - FX_MAX_AGE_MS }, now)).not.toThrow();
  });
});
```

`tests/b2b-quote.test.ts:4` → `import { FALLBACK_FX_RATES, FX_MAX_AGE_MS, RateUnavailableError, type FxRates } from '@/lib/rate';` and append:

```ts
describe('Task 9: both bill quotes refuse the display table and rates beyond the ceiling', () => {
  const base = { invoicedAmount: 1000, sellerCurrency: 'HKD' as const, buyerCurrency: 'USD' as const, sellerToUsd: HKD_TO_USD };
  const stale: FxRates = { toInr: 85, toUsd: 1, fetchedAt: Date.now() - FX_MAX_AGE_MS - 1, source: 'cache' };

  it('Case S (quoteCrossBorderBill) refuses', () => {
    expect(() => quoteCrossBorderBill({ ...base, rates: FALLBACK_FX_RATES.USD })).toThrow(RateUnavailableError);
    expect(() => quoteCrossBorderBill({ ...base, rates: stale })).toThrow(RateUnavailableError);
  });

  it('Case B (quoteBuyerDenominatedBill) refuses — it multiplies the cross-rate directly', () => {
    expect(() => quoteBuyerDenominatedBill({ ...base, invoicedAmount: 500, rates: FALLBACK_FX_RATES.USD })).toThrow(RateUnavailableError);
    expect(() => quoteBuyerDenominatedBill({ ...base, invoicedAmount: 500, rates: stale })).toThrow(RateUnavailableError);
  });
});
```

**2b — run, expect failure.** `npx vitest run tests/fx.test.ts tests/b2b-quote.test.ts` → `10 failed | 53 passed`: eight `expected function to throw an error, but it didn't` (the audit repro `quote(100,'USD',USD,…,'AED',0)` returns `fxRate 85`), `expected undefined to be an instance of RateUnavailableError`, and `expected error to match asymmetric matcher` (`assertRatesUsable` is not exported yet).

**2c — implementation.** `src/lib/fx.ts:2` → `import { FX_MAX_AGE_MS, RateUnavailableError, type FxRates } from './rate';` (a runtime import now; `rate.ts` imports nothing from `fx.ts`, so there is no cycle). Replace `usdPivotCrossRate` (`:16-32`) with:

```ts
/**
 * The source→destination cross-rate via the USD pivot — the single source of the
 * FX cross-rate used by BOTH the forward quote() and the inverse sourceForDest().
 * For an INR destination, or when NO destination USD rate is supplied
 * (null/undefined — the INR-only callers), this is the source→INR rate
 * (rates.toInr); otherwise it pivots through USD: src->dest = src.toUsd / dest.toUsd.
 *
 * prs-04: a SUPPLIED destToUsd must be finite and > 0. The old `!destToUsd` test
 * let a 0 fall into the INR branch, so quote(100,'USD',…,'AED',0) returned
 * fxRate 85 / amountInr 8500 labelled AED — now a QuoteError.
 */
export function usdPivotCrossRate(
  rates: FxRates,
  destinationCurrency: CurrencyCode = 'INR',
  destToUsd?: number,
): number {
  if (destinationCurrency === 'INR' || destToUsd == null) return rates.toInr;
  if (!Number.isFinite(destToUsd) || destToUsd <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  return rates.toUsd / destToUsd;
}

/**
 * The provenance gate (money-07). A quoted rate becomes a BINDING payout
 * instruction, so nothing from the static display table and nothing older than
 * FX_MAX_AGE_MS may price a transfer. getFxRates ALWAYS stamps real rates;
 * provenance-less literals (tests, injected fakes) pass.
 */
export function assertRatesUsable(rates: FxRates, now: number = Date.now()): void {
  if (rates.source === 'fallback') throw new RateUnavailableError('fallback_table');
  if (rates.fetchedAt !== undefined && now - rates.fetchedAt > FX_MAX_AGE_MS) {
    throw new RateUnavailableError('stale');
  }
}
```

In `quote()` insert `  assertRatesUsable(rates);` as the FIRST statement of the body (above `if (!Number.isFinite(amountSource)) {` at `:70`). In `sourceForDest()` insert `  assertRatesUsable(rates);` directly after the amount check's closing `}` (`:175`), before `const crossRate = …` (`:176`). `sourceForInr` delegates to `sourceForDest`, so it is covered. The post-hoc `crossRate` guards at `:117-119` and `:177-179` stay (they now only ever see a bad SOURCE leg).

`src/lib/b2b-quote.ts:1` → `import { QuoteError, assertRatesUsable, sourceForDest, usdPivotCrossRate, wouldBeFeeUsd } from './fx';`. In `quoteCrossBorderBill`, after the `invoicedAmount` check's closing `}` (`:93`), insert:

```ts
  // Provenance gate (Task 9): never price a bill off the static display table
  // or a rate older than FX_MAX_AGE_MS — throws RateUnavailableError.
  assertRatesUsable(rates);
```

In `quoteBuyerDenominatedBill`, after its `invoicedAmount` check's `}` (`:156`), insert:

```ts
  // Provenance gate (Task 9) — Case B multiplies usdPivotCrossRate directly
  // below, so nothing downstream would otherwise check where the rate came from.
  assertRatesUsable(rates);
```

**2d — run, expect green.** `npx vitest run && npx tsc --noEmit` → all green (171 files, 2321 tests on `bf4b083`).

**2e — commit.**

```bash
git add src/lib/fx.ts src/lib/b2b-quote.ts tests/fx.test.ts tests/b2b-quote.test.ts
git commit -m "fix(corridors-fx): close the prs-04 zero-rate hole; gate every price on rate provenance

usdPivotCrossRate treats only null/undefined as 'no destination leg'; a
supplied 0, NaN or negative destToUsd is a QuoteError instead of a silent
INR-branch quote labelled with the wrong currency. quote(), sourceForDest()
and both B2B bill quotes refuse source:'fallback' and any rate older than
FX_MAX_AGE_MS (assertRatesUsable) with RateUnavailableError — a sibling of
QuoteError, never a subclass.

Refs: prs-04, money-07."
```

- [ ] **Step 3: the mint refuses an approved quote whose rate aged past the ceiling (ruling 17)**

**3a — failing tests.** `tests/transfer-create-gate.test.ts:8` (as edited in Step 1) → `import { FX_MAX_AGE_MS, RateUnavailableError, resetRateCacheForTests } from '@/lib/rate';` and append:

```ts
describe('Task 9: an approved quote is honored verbatim only while its rate is inside the ceiling', () => {
  const override = (fxFetchedAt?: number): NonNullable<CreateTransferInput['quote']> => ({
    amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 95.82, amountInr: 9582,
    amountSource: 100, feeSource: 0, totalChargeSource: 100, fxFetchedAt,
  });

  it('honors a fresh override VERBATIM without dialing FX (claim-first re-mints never re-price)', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(s, p, m, baseInput({ quote: override(Date.now() - 60_000) }));
    expect(t.fxRate).toBe(95.82);
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('refuses an override whose rate is older than the ceiling — and never falls back to a re-quote', async () => {
    const [s, p, m] = await stores();
    await expect(
      createTransfer(s, p, m, baseInput({ quote: override(Date.now() - FX_MAX_AGE_MS - 1) })),
    ).rejects.toMatchObject({ name: 'RateUnavailableError', reason: 'stale_quote' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
    expect(await s.getTransferCount('default', '15551230000')).toBe(0);
  });

  it('an override without fxFetchedAt (pre-Task-9 draft, B2B locked quote) is honored as before', async () => {
    const [s, p, m] = await stores();
    const t = await createTransfer(s, p, m, baseInput({ quote: override(undefined) }));
    expect(t.fxRate).toBe(95.82);
  });
});
```

**3b — run, expect failure.** `npx vitest run tests/transfer-create-gate.test.ts` → `1 failed`: `promise resolved "{ id: '…', …(35) }" instead of rejecting` (main mints a stale override verbatim). `npx tsc --noEmit` → `TS2353: Object literal may only specify known properties, and 'fxFetchedAt' does not exist in type '{ amountUsd: number; …; totalChargeSource: number; }'`.

**3c — implementation.** `src/lib/types.ts` — in `Draft.quote` insert after `destinationCurrency?: CurrencyCode; // NEW (any-to-any)` (`:363`):

```ts
    // Task 9: epoch ms of the OLDEST FX leg this quote was priced on. The mint
    // refuses the quote once that rate is older than FX_MAX_AGE_MS (it never
    // re-quotes). Absent on drafts created before Task 9 (honored as before).
    fxFetchedAt?: number;
```

`src/lib/transfer-create.ts`:
- `:2` → `import { FX_MAX_AGE_MS, RateUnavailableError, getDestinationRates, getFxRates } from './rate';`
- `CreateTransferInput.quote` — insert after `totalChargeSource: number;` (`:59`):

```ts
    // Task 9: when the rate behind these figures was fetched (the draft's
    // quote.fxFetchedAt). Beyond FX_MAX_AGE_MS the mint refuses; absent ⇒ no check.
    fxFetchedAt?: number;
```

- `quoteOverrideFromDraft` — add `      fxFetchedAt: dq.fxFetchedAt,` as the last property of BOTH returned objects (after `totalChargeSource: totalChargeUsd,` at `:105` and after `totalChargeSource: dq.totalChargeSource,` at `:117`).
- Insert after `quoteOverrideFromDraft`'s closing `}` (`:121`):

```ts

/**
 * Task 9: an approved quote is honored VERBATIM (claim-first re-mints must
 * never re-price), so the only admissible check is the age of the rate behind
 * it. Beyond FX_MAX_AGE_MS the mint REFUSES — it never silently re-quotes.
 * An override without fxFetchedAt (a pre-Task-9 draft, the B2B locked quote)
 * passes unchanged.
 */
export function assertQuoteOverrideFresh(
  q: Pick<NonNullable<CreateTransferInput['quote']>, 'fxFetchedAt'>,
  now: number = Date.now(),
): void {
  if (q.fxFetchedAt !== undefined && now - q.fxFetchedAt > FX_MAX_AGE_MS) {
    throw new RateUnavailableError('stale_quote');
  }
}
```

- In `createTransfer` replace `:150-151` (`if (input.quote) {` / `q = input.quote;`) with:

```ts
  if (input.quote) {
    assertQuoteOverrideFresh(input.quote);
    q = input.quote;
```

The Transfer row is built field-by-field from `q` (`:194-231`), so `fxFetchedAt` never reaches the ledger — no schema change. The B2B mint (`b2b-pay-finalize.ts:226-235`) passes no `fxFetchedAt` (its lock is bounded by the 15-min TTL — see residuals) and is unaffected.

**3d — run, expect green.** `npx vitest run && npx tsc --noEmit` → green (171 files, 2324 tests).

**3e — commit.**

```bash
git add src/lib/types.ts src/lib/transfer-create.ts tests/transfer-create-gate.test.ts
git commit -m "fix(money-paths): refuse to mint an approved quote whose rate aged past the FX ceiling

Draft.quote and the createTransfer override carry fxFetchedAt (the oldest
rate leg's fetch time). assertQuoteOverrideFresh refuses beyond FX_MAX_AGE_MS
with RateUnavailableError('stale_quote') and never re-quotes, so a
claim-first replay can never mint the same id at a different price.
Pre-Task-9 drafts (no stamp) are honored as before.

Refs: money-07 (ruling 17)."
```

- [ ] **Step 4: `pay-finalize` FX gate BEFORE the claim; the pay route answers 503 (ruling 7)**

**4a — failing tests.** `tests/pay-finalize.test.ts:11` → `import { FX_MAX_AGE_MS, resetRateCacheForTests } from '@/lib/rate';` and append:

```ts
describe('finalizeDraftPayment — FX gate (Task 9): refuses BEFORE the claim, never burns the draft', () => {
  // Ruling 7 pre-claim order: kyc → masked destination (fix 6) → FX (this) → cap (fix 10) → idem.claim.
  async function verifiedSender(stores: Awaited<ReturnType<typeof buildStores>>) {
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified' });
  }

  it('a stored quote whose rate is older than the ceiling → fx_unavailable; no FX dial, draft kept, key unclaimed, nothing minted', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17_000, fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1 },
    });

    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'fx_unavailable' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled(); // honored-verbatim path never re-quotes
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    expect(await createIdempotencyRepo(stores.db).find('default', `draft:${draftId}`)).toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);
  });

  it('a crash-replay of an ALREADY-MINTED draft replays its transfer — the FX gate never refuses a minted draft', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17_000, fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1 },
    });
    // The crash window: a prior attempt claimed the key and MINTED (while the
    // rate was still fresh), then died before consumeDraft — the draft is still
    // live and its quote has since aged past the ceiling.
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    await createIdempotencyRepo(stores.db).claim('default', `draft:${draftId}`, 'tr_minted');
    await createTransfer(stores.store, stores.partnerStore, stores.monthlyVolumeStore, {
      id: 'tr_minted', phone: PHONE, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
      amountSource: 200, sourceCurrency: 'USD', partnerId: 'default', senderKycStatus: 'verified',
      quote: {
        amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
        amountSource: 200, feeSource: 0, totalChargeSource: 200,
      },
    });

    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: true, transferId: 'tr_minted' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1); // replayed, never re-minted
  });

  it('a fresh stored quote (fxFetchedAt inside the ceiling) mints verbatim', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 95.82, amountInr: 19_164, fxFetchedAt: Date.now() - 10 * 60_000 },
    });
    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await stores.store.getTransfer(result.transferId))?.fxRate).toBe(95.82);
  });

  it('a legacy draft that must re-quote while Frankfurter is down → fx_unavailable; the SAME link mints once FX is back', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 254, amountSource: 200, sourceCurrency: 'GBP', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600 }, // no feeSource/totalChargeSource ⇒ re-quote path
    });
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));

    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'fx_unavailable' });
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);

    // Provider recovers: the single-use key was never burned, so the same link completes.
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.3395, INR: 128.35 } }) }));
    expect((await finalizeDraftPayment(stores, draftId)).ok).toBe(true);
  });
});
```

Create `tests/pay-route-fx.test.ts`:

```ts
/**
 * Task 9 — the consumer pay route maps finalizeDraftPayment's fx_unavailable
 * arm to a retryable 503 (never the generic 400 "link no longer active").
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue: async () => ({ ok: true, code: '000000' }), verify: async () => ({ ok: true }) }),
}));
// A live draft (so the OTP phone resolves) and no minted transfer for its id.
vi.mock('@/lib/draft-store', () => ({
  getDraftStore: () => ({ getDraft: async () => ({ senderPhone: '15551234567', partnerId: 'default' }) }),
}));
vi.mock('@/lib/store', () => ({ getStore: () => ({ getTransfer: async () => null }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({}) }));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/lib/daily-volume-store', () => ({ getDailyVolumeStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
const finalizeDraftPayment = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pay-finalize', () => ({ finalizeDraftPayment }));

import { POST } from '@/app/api/pay/[transferId]/route';

const DRAFT = 'draft_fx_1';
const post = () =>
  POST(
    new NextRequest('http://x/api/pay/' + DRAFT, {
      method: 'POST', body: JSON.stringify({ otp: '000000' }), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ transferId: DRAFT }) },
  );

describe('POST /api/pay/[transferId] — fx_unavailable (Task 9)', () => {
  it('maps fx_unavailable to 503 with the customer-safe message and reason', async () => {
    finalizeDraftPayment.mockResolvedValueOnce({ ok: false, error: 'fx_unavailable' });
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: FX_UNAVAILABLE_MESSAGE, reason: 'fx_unavailable' });
  });

  it('the other refusal arms keep their 400 (regression)', async () => {
    finalizeDraftPayment.mockResolvedValueOnce({ ok: false, error: 'cap' });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That amount exceeds your current limit.');
  });
});
```

**4b — run, expect failure.** `npx vitest run tests/pay-finalize.test.ts tests/pay-route-fx.test.ts` → `3 failed | 25 passed`: the stale-quote case throws `RateUnavailableError: That quote has expired — please ask for a fresh quote.` and the legacy-draft case throws `RateUnavailableError: Exchange rates are temporarily unavailable — …` out of `createTransfer` — AFTER `idem.claim` (the defect this step fixes); the route case `expected 400 to be 503`. The ALREADY-MINTED replay case passes before this step (there is no gate yet) and pins that the gate must never refuse a minted draft: a gate placed ahead of the claim lookup fails it with `expected { ok: false, error: 'fx_unavailable' } to deeply equal { ok: true, transferId: 'tr_minted' }` (verified).

**4c — implementation.** `src/lib/pay-finalize.ts`:
- `:1` → two lines:

```ts
import { assertQuoteOverrideFresh, createTransfer, quoteOverrideFromDraft } from './transfer-create';
import { getDestinationRates, getFxRates, RateUnavailableError } from './rate';
```

- `:5` → `import { DEFAULT_DESTINATION_CURRENCY, DEFAULT_PARTNER_ID } from './defaults';`
- `FinalizeResult` (`:37-39`) →

```ts
export type FinalizeResult =
  | { ok: true; transferId: string }
  | { ok: false; error: 'expired_or_used' | 'cap' | 'blocked' | 'kyc_required' | 'fx_unavailable'; transferId?: string };
```

- Insert between the kyc gate (`:96`, `if (sendGateActive(partner) && !payVerified) return { ok: false, error: 'kyc_required' };`) and the cap block's comment (`:98`, `// Defense-in-depth cap re-check …`). The marker is the FIRST line and must stay verbatim: it is the ONE anchor both later tasks use (`grep -n "fix 6 inserts above this line" src/lib/pay-finalize.ts`) — Task 6 inserts its masked-destination block directly ABOVE it, and Task 10 anchors on the same marker line to place its cap check after this FX block and before `idem.claim` (ruling 7 order):

```ts
  // [fix 6 inserts above this line]
  // ── FX gate (Task 9) — BEFORE idem.claim, so a provider outage or a stale
  // quote never burns the single-use draft key (ruling 7 pre-claim contract:
  // kyc → masked destination (fix 6) → FX (this) → cap (fix 10) → idem.claim).
  // A draft with a COMPLETE stored quote is honored verbatim — never re-quoted
  // — so the only check is the age of the rate behind it. A legacy draft with
  // no complete quote re-quotes inside createTransfer, so pre-flight both FX
  // legs here (this also warms the L1 cache the mint reads moments later).
  // A draft that ALREADY minted (the process died after the mint, before
  // consumeDraft) skips the gate: the claim below replays that transfer's
  // outcome, and a replay is never re-priced or refused for FX. A bound-but-
  // UNminted claim is still gated — nothing has been priced into the ledger.
  const quoteOverride = quoteOverrideFromDraft(draft);
  const idem = createIdempotencyRepo(db);
  const priorClaim = await idem.find(DEFAULT_PARTNER_ID, `draft:${draftId}`);
  const alreadyMinted = priorClaim !== null && (await store.getTransfer(priorClaim)) !== null;
  if (!alreadyMinted) {
    try {
      if (quoteOverride) {
        assertQuoteOverrideFresh(quoteOverride);
      } else {
        await getFxRates(draft.sourceCurrency);
        await getDestinationRates(draft.destinationCurrency ?? DEFAULT_DESTINATION_CURRENCY);
      }
    } catch (err) {
      if (err instanceof RateUnavailableError) return { ok: false, error: 'fx_unavailable' };
      throw err;
    }
  }

```

- The FX block now creates `idem`, so replace the claim block's `  const idem = createIdempotencyRepo(db);` (`:108`) with this comment line (`idem.claim` at `:110` is unchanged):

```ts
  // (`idem` is created above by the FX gate — Task 9.)
```
- Delete the now-duplicate `const quoteOverride = quoteOverrideFromDraft(draft);` (`:142`) and put in its place the comment line `  // (quoteOverride is computed ABOVE the claim by the FX gate — Task 9.)` — keep the U7 comment block `:136-141` above it. `quoteOverride` is still read at `:175` and `:180`.
- Why the claim lookup sits INSIDE the gate: if a prior attempt minted and then died before `consumeDraft` (`:193`), the draft is still live and a replay must return that transfer (the claim block's `existing` branch, `:111-121`), never `fx_unavailable` — the minted row's price is already fixed. A bound-but-UNminted claim (crash between claim and mint) stays gated: nothing has been priced into the ledger yet, and the refused retry keeps the claimed id for a later replay. Cost: one indexed PK read (`idempotency_keys`) per draft pay POST.

`src/app/api/pay/[transferId]/route.ts`:
- after `:26` (`import { draftTenant } from '@/lib/legacy-tenant';`) add `import { FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';`
- inside `if (!result.ok) {` (`:445`), between the `kyc_required` arm's closing `}` (`:451`) and `const msg =` (`:452`), insert:

```ts
      if (result.error === 'fx_unavailable') {
        // Task 9: retryable — the FX provider is down or the quote's rate aged
        // past the ceiling. Nothing was claimed, minted or charged; the draft
        // (and its link) is untouched.
        return NextResponse.json(
          { ok: false, error: FX_UNAVAILABLE_MESSAGE, reason: 'fx_unavailable' },
          { status: 503 },
        );
      }
```

`FinalizeResult` has exactly one consumer (`route.ts:444`, grep `finalizeDraftPayment` → the route + tests). The pay-page client (`src/app/pay/[transferId]/pay-form.tsx:198-205`) reads only `reason === 'otp'` and otherwise shows its generic "Something went wrong. Please try again." — no client change.

**4d — run, expect green.** `npx vitest run && npx tsc --noEmit` → green (172 files, 2330 tests).

**4e — commit.**

```bash
git add src/lib/pay-finalize.ts "src/app/api/pay/[transferId]/route.ts" tests/pay-finalize.test.ts tests/pay-route-fx.test.ts
git commit -m "fix(money-paths): refuse a draft mint on unavailable/stale FX before the claim-first key is bound

finalizeDraftPayment gains the fx_unavailable arm. The FX gate sits after
the kyc gate and before the cap check and idem.claim (ruling 7: kyc →
masked destination → FX → cap → claim; the marker line is the anchor for
Tasks 6 and 10), so an outage or a stale quote never burns the single-use
draft key. A draft that already minted skips the gate so its crash-replay
returns the minted transfer. The pay route maps it to a retryable 503.

Refs: money-07 (ruling 7)."
```

- [ ] **Step 5: the partner API answers 503, never 400, when FX is unavailable (ruling 11)**

**5a — failing tests.** `tests/partner-api-service.test.ts:11` → `import { FX_UNAVAILABLE_MESSAGE, resetRateCacheForTests } from '@/lib/rate';` and append:

```ts
describe('partner-api-service: FX unavailable is a 503 (retryable), never a 400 (Task 9)', () => {
  it('createQuote → 503 with the customer-safe message when Frankfurter is down and nothing is cached', async () => {
    const { deps } = await harness();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await createQuote(deps, DELEGATED, { amount_source: 500 })).toEqual({
      ok: false, status: 503, error: FX_UNAVAILABLE_MESSAGE,
    });
  });

  it('createTransaction → 503, nothing minted; a retry with the SAME key mints once FX is back', async () => {
    const { deps, store } = await harness();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await createTransaction(deps, DELEGATED, 'pk_1', 'idem-fx', txBody())).toMatchObject({ ok: false, status: 503 });
    expect(await store.listTransfers()).toHaveLength(0);

    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => frankfurterStub(url)));
    const retry = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-fx', txBody());
    expect(retry).toMatchObject({ ok: true, status: 201 }); // the bound-but-unminted id is minted now
    expect(await store.listTransfers()).toHaveLength(1);
  });

  it('a replay of an ALREADY-minted key still returns 200 during an FX outage (the replay never re-prices)', async () => {
    const { deps } = await harness();
    const first = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-ok', txBody());
    expect(first).toMatchObject({ ok: true, status: 201 });
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await createTransaction(deps, DELEGATED, 'pk_1', 'idem-ok', txBody())).toMatchObject({ ok: true, status: 200 });
  });
});
```

**5b — run, expect failure.** `npx vitest run tests/partner-api-service.test.ts` → `2 failed`, both with an uncaught `RateUnavailableError: Exchange rates are temporarily unavailable — …` (neither catch knows the class; the route would 500). The replay case already passes (the replay returns before `createTransfer`) — it pins that this step must not move the refusal above the claim.

**5c — implementation.** `src/lib/partner-api-service.ts:8` → `import { getDestinationRates, getFxRates, RateUnavailableError } from './rate';`. `createQuote` catch (`:188-191`) →

```ts
  } catch (e) {
    // Task 9: the FX provider is down / beyond the ceiling ⇒ 503 (retryable).
    // A QuoteError is the caller's request being invalid ⇒ 400. The two are
    // sibling classes — RateUnavailableError is NOT a QuoteError.
    if (e instanceof RateUnavailableError) return err(503, e.message);
    if (e instanceof QuoteError) return err(400, e.message);
    throw e;
  }
```

`createTransaction` catch (`:332-338`) →

```ts
  } catch (e) {
    // Task 9: FX unavailable ⇒ 503. The key is bound to reservedId but nothing
    // was minted — exactly the crash-replay shape above: a retry with the SAME
    // Idempotency-Key falls through and mints THAT id once FX is back, and a
    // replay of an already-minted key never reaches this point (200 above).
    if (e instanceof RateUnavailableError) return err(503, e.message);
    if (e instanceof QuoteError) return err(400, e.message);
    if (e instanceof Error && e.message === 'kyc_required') {
      return err(422, 'Sender identity verification required (this partner runs SmartRemit KYC).');
    }
    throw e;
  }
```

`svcResponse` (`src/lib/partner-api.ts:64-68`) forwards `status` verbatim, so the routes need no change. `listPartnerRates` / `pushPartnerRate` never call FX (grep) — unaffected.

**5d — run, expect green.** `npx vitest run && npx tsc --noEmit` → green (172 files, 2333 tests).

**5e — commit.**

```bash
git add src/lib/partner-api-service.ts tests/partner-api-service.test.ts
git commit -m "fix(partner-api): map RateUnavailableError to 503 on /quote and /transactions

A provider outage is retryable, not a client error. /transactions keeps the
refusal after the idempotency claim so a replay of an already-minted key
still returns 200 during an outage, and a retry with the same key mints the
bound id once FX is back.

Refs: money-07 (ruling 11)."
```

- [ ] **Step 6: every agent tool turns an FX refusal into a customer-safe error; drafts stamp `fxFetchedAt`**

**6a — failing tests.** `tests/tools.test.ts:24` (as edited in Step 1) →

```ts
import {
  resetRateCacheForTests, AED_PER_USD, FX_MAX_AGE_MS, FX_QUOTE_EXPIRED_MESSAGE, FX_UNAVAILABLE_MESSAGE,
} from '@/lib/rate';
```

and append:

```ts
describe('Task 9 — FX unavailable is a friendly refusal, never a thrown agent turn', () => {
  const fxDown = () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
  };

  it('get_quote returns { error: FX_UNAVAILABLE_MESSAGE } and no figures', async () => {
    const ctx = await buildCtx(fakeRedis());
    fxDown();
    const r = await executeTool('get_quote', { amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(r).toEqual({ error: FX_UNAVAILABLE_MESSAGE });
  });

  it('send_approve_picker refuses the same way and creates NO draft', async () => {
    const ctx = await buildCtx(fakeRedis());
    fxDown();
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210',
    }, ctx);
    expect(r).toEqual({ error: FX_UNAVAILABLE_MESSAGE });
    expect(await ctx.draftStore.getActiveDraftId('default', PHONE)).toBeNull();
  });

  it('create_transfer (legacy explicit-args path) refuses and mints nothing', async () => {
    const ctx = await buildCtx(fakeRedis());
    fxDown();
    const r = await executeTool('create_transfer', {
      amount_usd: 100, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    }, ctx);
    expect(r).toEqual({ error: FX_UNAVAILABLE_MESSAGE });
    expect(await ctx.store.getTransferCount('default', PHONE)).toBe(0);
  });

  it('check_send_limit refuses rather than evaluating the cap on an unknown USD rate', async () => {
    const ctx = await buildCtx(fakeRedis());
    fxDown();
    expect(await executeTool('check_send_limit', { amount_usd: 100 }, ctx)).toEqual({ error: FX_UNAVAILABLE_MESSAGE });
  });

  it('create_schedule needs no FX — an outage never blocks setting one up (it prices at run time)', async () => {
    const ctx = await buildCtx(fakeRedis());
    fxDown();
    const r = await executeTool('create_schedule', {
      amount_usd: 150, recipient_name: 'Mom', recipient_phone: '919133001840',
      frequency: 'monthly', day_of_month: 10,
    }, ctx);
    expect(r.schedule_id).toBeTruthy();
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('send_approve_picker stamps the draft quote with the rate fetch time (quote.fxFetchedAt)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const before = Date.now();
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('graph.facebook.com')
        ? { ok: true, json: async () => ({}), text: async () => '' }
        : { ok: true, json: async () => ({ rates: { INR: MOCK_RATE } }) }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210',
    }, ctx);
    expect(r.error).toBeUndefined();
    const draft = await ctx.draftStore.getDraft(r.draft_id as string);
    expect(draft?.quote.fxFetchedAt).toBeGreaterThanOrEqual(before);
    expect(draft?.quote.fxFetchedAt).toBeLessThanOrEqual(Date.now());
  });

  it('an approve tap on a draft whose rate is older than the ceiling is refused (fresh quote needed), nothing minted', async () => {
    const base = await buildCtx(fakeRedis());
    const draftId = await base.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 8500, fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1 },
    });
    const ctx = { ...base, turn: { isNewConversation: false, buttonTap: { kind: 'approve' as const, draftId } } };
    const r = await executeTool('create_transfer', {}, ctx);
    expect(r).toEqual({ error: FX_QUOTE_EXPIRED_MESSAGE });
    expect(await ctx.store.getTransferCount('default', PHONE)).toBe(0);
  });
});
```

**6b — run, expect failure.** `npx vitest run tests/tools.test.ts -t "Task 9"` → `7 failed`: five throw `RateUnavailableError: Exchange rates are temporarily unavailable — …` out of `executeTool` (on main the agent's per-tool catch, `src/lib/agent.ts:317-320`, downgrades that to the generic "temporary snag" error with an unscrubbed `console.error` — the customer never learns why, and nothing says FX), the approve tap throws `RateUnavailableError: That quote has expired — …`, and the stamp case fails `TypeError: actual value must be number or bigint, received "undefined"`.

**6c — implementation** (`src/lib/tools.ts`):

1. `:2` → `import { getDestinationRates, getFxRates, RateUnavailableError, type FxRates } from './rate';`
2. After `type ToolResult = Record<string, unknown>;` (`:826`) add:

```ts

/**
 * Task 9: a RateUnavailableError (FX provider down, a rate beyond the ceiling,
 * or a stale approved quote) becomes the customer-safe refusal — logged
 * (scrubbed), never a thrown agent turn. null ⇒ not an FX refusal; the caller
 * rethrows. RateUnavailableError is NOT a QuoteError, so every QuoteError arm
 * in this file sits next to one of these.
 */
function fxRefusal(err: unknown, scope: string): ToolResult | null {
  if (!(err instanceof RateUnavailableError)) return null;
  logWarn(`${scope}.fx-unavailable`, err.reason, { currency: err.currency ?? '' });
  return { error: err.message };
}
```

3. Replace `resolveCurrencyAndRates` (`:856-892`, as edited in Step 1) with the pair:

```ts
/** The turn's customer, owning partner and send currency — no FX involved. */
async function resolveSender(
  ctx: ToolContext,
  requested: unknown,
): Promise<{ customer: Customer; partner: Partner; sourceCurrency: CurrencyCode }> {
  const customer =
    (await ctx.customerStore.getCustomer(ctx.partnerId, ctx.phone)) ??
    (await ctx.customerStore.upsertOnFirstInbound(ctx.partnerId, ctx.phone)).customer;
  const partner =
    (await ctx.partnerStore.getPartner(ctx.partnerId)) ??
    (await ctx.partnerStore.ensureDefaultPartner());
  const sourceCurrency = resolveSendCurrency(
    partner,
    typeof requested === 'string' ? requested : undefined,
    ctx.phone,
  );
  return { customer, partner, sourceCurrency };
}

/**
 * Sender + live FX for a quote. THROWS RateUnavailableError (Task 9) when a
 * leg has no rate inside FX_MAX_AGE_MS — every caller maps it via fxRefusal.
 */
async function resolveCurrencyAndRates(
  ctx: ToolContext,
  requested: unknown,
  destinationCountryArg?: unknown,
): Promise<{
  customer: Customer;
  partner: Partner;
  sourceCurrency: CurrencyCode;
  rates: FxRates;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  destToUsd: number | undefined;
  fxFetchedAt: number | undefined;
}> {
  const { customer, partner, sourceCurrency } = await resolveSender(ctx, requested);
  const rates = await getFxRates(sourceCurrency);

  // Destination resolution — validated; unknown country code → 'IN' (back-compat).
  const destinationCountry: CountryCode =
    typeof destinationCountryArg === 'string' &&
    VALID_COUNTRY_CODES.has(destinationCountryArg.toUpperCase())
      ? (destinationCountryArg.toUpperCase() as CountryCode)
      : 'IN';
  const destinationCurrency = DEFAULT_CURRENCY_FOR_COUNTRY[destinationCountry];
  // undefined for INR: quote() prices an INR destination off rates.toInr.
  const destRates = await getDestinationRates(destinationCurrency);
  // The OLDEST leg's fetch time — a stored draft quote's age is measured from it.
  const stamps = [rates.fetchedAt, destRates?.fetchedAt].filter((t): t is number => t !== undefined);
  const fxFetchedAt = stamps.length > 0 ? Math.min(...stamps) : undefined;

  return {
    customer, partner, sourceCurrency, rates, destinationCountry, destinationCurrency,
    destToUsd: destRates?.toUsd, fxFetchedAt,
  };
}
```

4. `getQuoteTool` outer catch (`:1152`): make its first two lines

```ts
  } catch (err) {
    const refusal = fxRefusal(err, 'get_quote');
    if (refusal) return refusal;
    if (err instanceof QuoteError) {
```

(the rest of the arm is unchanged). The routed receive-first inner catch (`:1129-1131`, `if (!(err instanceof QuoteError)) throw err;`) needs NO edit: it rethrows a `RateUnavailableError` to this arm instead of "keeping the mid quote" — precisely why the class must not extend `QuoteError`.

5. Approve-tap draft path catch (`:1285-1288`) →

```ts
    } catch (err) {
      // A stale approved quote (FX_QUOTE_EXPIRED_MESSAGE) or, for a legacy draft
      // that re-quotes, an FX outage — the customer asks for a fresh quote.
      const refusal = fxRefusal(err, 'create_transfer');
      if (refusal) return refusal;
      if (err instanceof QuoteError) return { error: err.message };
      throw err;
    }
```

(The draft was consumed at `:1181` before any gate, exactly like the existing cap refusal at `:1220-1225` — the customer re-quotes.)

6. Legacy explicit-args path — replace the destructuring call `:1299-1304` with:

```ts
  // Resolve currency + rates and reuse customer for cap check + partnerId.
  let legacyResolved: Awaited<ReturnType<typeof resolveCurrencyAndRates>>;
  try {
    legacyResolved = await resolveCurrencyAndRates(ctx, args.source_currency, args.destination_country);
  } catch (err) {
    const refusal = fxRefusal(err, 'create_transfer');
    if (refusal) return refusal;
    throw err;
  }
  const { customer: legacyCustomer, partner: legacyPartner, sourceCurrency, rates, destinationCountry: legacyDestCountry, destinationCurrency: legacyDestCurrency } = legacyResolved;
```

and its catch (`:1379-1382`) →

```ts
  } catch (err) {
    const refusal = fxRefusal(err, 'create_transfer');
    if (refusal) return refusal;
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
```

7. `create_invoice` USD snapshot comment (`:1702-1705`; the try/catch at `:1707-1716` already keeps it best-effort — it is a display snapshot, never a price) →

```ts
  // USD-equivalent snapshot for the NOT-NULL amountUsd column (back-compat display
  // ONLY — the authoritative obligation is invoicedAmount/invoicedCurrency). A USD
  // bill is exactly 1 (skip the FX hit). getFxRates THROWS when no rate inside the
  // ceiling exists (Task 9); this snapshot is not a price and never reaches a payout
  // instruction, so the catch below keeps it best-effort (it never blocks creation).
```

8. `createScheduleTool` (`:2574-2575`) — it only needs the currency:

```ts
  // Resolve currency (P4 wiring); the schedule is owned by the turn's tenant (fix 1).
  // No FX here (Task 9): a schedule prices at RUN time, so a provider outage must
  // not stop the customer from setting one up.
  const { sourceCurrency } = await resolveSender(ctx, args.source_currency);
```

9. `sendApprovePickerTool` — its resolve call (`:2769-2771`) sits OUTSIDE the tool's try (which opens at `:2806`); replace it with:

```ts
  // Resolve currency+rates+destination ONCE; reuse `customer` for the cap check (no second getCustomer).
  let resolved: Awaited<ReturnType<typeof resolveCurrencyAndRates>>;
  try {
    resolved = await resolveCurrencyAndRates(ctx, args.source_currency, args.destination_country);
  } catch (err) {
    const refusal = fxRefusal(err, 'send_approve_picker');
    if (refusal) return refusal;
    throw err;
  }
  const { customer, partner, sourceCurrency, rates, destinationCountry, destinationCurrency, destToUsd, fxFetchedAt } =
    resolved;
```

In the draft's `quote: { … }` add after `destinationCurrency: q.destinationCurrency,` (`:2894`):

```ts
        fxFetchedAt, // Task 9: the mint refuses this quote once its rate is older than FX_MAX_AGE_MS
```

and make the tool's catch (`:2964-2966`):

```ts
  } catch (err) {
    const refusal = fxRefusal(err, 'send_approve_picker');
    if (refusal) return refusal;
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
```

10. `checkSendLimitTool` (`:3134-3135`) →

```ts
  // Resolve currency+rates and reuse `customer` — no second getCustomer.
  let resolved: Awaited<ReturnType<typeof resolveCurrencyAndRates>>;
  try {
    resolved = await resolveCurrencyAndRates(ctx, args.source_currency);
  } catch (err) {
    const refusal = fxRefusal(err, 'check_send_limit');
    if (refusal) return refusal;
    throw err;
  }
  const { customer, partner, rates } = resolved;
```

Call-site audit (all `resolveCurrencyAndRates` / `getFxRates` users in `tools.ts`, grep on `bf4b083`): `:1031` get_quote (inside try → item 4), `:1300` legacy create_transfer (item 6), `:1709` create_invoice (item 7, best-effort by design), `:2575` create_schedule (item 8, no FX), `:2771` send_approve_picker (item 9), `:3135` check_send_limit (item 10). `repeat_transfer` reaches FX only through `send_approve_picker`.

**6d — run, expect green.** `npx vitest run && npx tsc --noEmit` → green (172 files, 2340 tests).

**6e — commit.**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "fix(whatsapp-agent): FX unavailable is a customer-safe refusal in every tool; drafts stamp fxFetchedAt

fxRefusal maps RateUnavailableError next to every QuoteError arm
(get_quote, create_transfer both paths, send_approve_picker,
check_send_limit) so an outage is named to the customer instead of
falling into the agent's generic 'temporary snag' catch. create_schedule
resolves the sender without FX. Approval drafts record the oldest rate
leg's fetch time for the mint-time age check; AED assertions pin the peg.

Refs: money-07, obs-08 (ruling 11)."
```

- [ ] **Step 7: the bot never calls the quoted rate "mid-market"/"no markup" and relays an FX refusal (live-02)**

**7a — failing test.** Append to `tests/prompt.test.ts`:

```ts
describe('SYSTEM_PROMPT — FX honesty (Task 9: live-02, money-07)', () => {
  const variants = [
    buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: true }),
    buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: false }),
  ];

  it('never lets the bot call the quoted rate mid-market or claim there is no markup (live-02)', () => {
    for (const p of variants) {
      expect(p).toContain('Describe the exchange rate only as the rate for this transfer, exactly as get_quote returned it.');
      expect(p).toContain('Never call it the "mid-market", "interbank" or "real" rate');
      expect(p).toContain('never claim there is "no markup" or "no spread" on it');
    }
  });

  it('relays an FX-unavailable refusal and never estimates or reuses a rate', () => {
    for (const p of variants) {
      expect(p).toContain('If a tool returns that exchange rates are temporarily unavailable');
      expect(p).toContain('Never estimate a rate yourself and never reuse a rate from an earlier message.');
    }
  });
});
```

**7b — run, expect failure.** `npx vitest run tests/prompt.test.ts` → `2 failed`: `expected 'You are the assistant for SmartRemit,…' to contain 'Describe the exchange rate only as th…'` and `… to contain 'If a tool returns that exchange rates…'`.

**7c — implementation.** `src/lib/prompt.ts` — insert after `- Never invent exchange rates or fees. Always call get_quote for real numbers.` (`:82`, inside the shared `base` template, so both `kycGateActive` variants carry it):

```text
- Describe the exchange rate only as the rate for this transfer, exactly as get_quote returned it. Never call it the "mid-market", "interbank" or "real" rate, and never claim there is "no markup" or "no spread" on it.
- If a tool returns that exchange rates are temporarily unavailable, tell the customer exactly that and ask them to try again in a few minutes. Never estimate a rate yourself and never reuse a rate from an earlier message.
```

(live-02 observed the model improvising "the rate you see is the rate your recipient gets" over a routed 45 bps rate; the prompt never told it that. The explicit FX-spread DISCLOSURE a licensed partner owes is Reg E copy — program fix 15, "Ship Reg E remittance disclosures" — and stays there.)

**7d — run, expect green.** `npx vitest run tests/prompt.test.ts tests/bot-content-guard.test.ts` → `87 passed`; then `npx vitest run` → green (172 files, 2342 tests).

**7e — commit.**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "fix(whatsapp-agent): the bot never labels a quoted rate mid-market and relays FX refusals verbatim

Refs: live-02."
```

- [ ] **Step 8: the B2B checkout reads FX before the OTP and answers 503; a USD buyer needs no FX**

**8a — failing test.** Create `tests/pay-b2b-route-fx.test.ts`:

```ts
/**
 * Task 9 — the cross-border B2B checkout fetches FX BEFORE the OTP check: a
 * provider outage is a retryable 503 that never burns the single-use code and
 * never reaches the claim-first mint. A USD buyer needs no FX at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetRateCacheForTests } from '@/lib/rate';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

const NOW_ISO = new Date().toISOString();
let buyerPhone = '447700900123'; // GB ⇒ GBP (needs FX)
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    getB2bInvoice: async (id: string) => ({
      id, partnerId: 'default', businessName: 'Kowloon Design Co', buyerPhone,
      lineItems: [], amountUsd: 128, currency: 'HKD', sellerId: 's_hk1',
      invoicedAmount: 1000, invoicedCurrency: 'HKD', status: 'unpaid', createdAt: NOW_ISO,
    }),
    getSellerById: async () => ({ id: 's_hk1', partnerId: 'default', status: 'active', currency: 'HKD' }),
    getTransfer: async () => null,
  }),
}));
vi.mock('@/lib/b2b-quote-store', () => ({
  getB2bQuoteStore: () => ({
    getLockedQuote: async () => ({
      sellerAmount: 1000, sellerCurrency: 'HKD',
      buyerCurrency: buyerPhone.startsWith('44') ? 'GBP' : 'USD',
      buyerPrincipal: 95.5, feeBuyer: 1.49, buyerTotal: 96.99, fxRate: 10.47, lockedAt: NOW_ISO,
    }),
  }),
}));
vi.mock('@/lib/customer-store', () => ({
  getCustomerStore: () => ({ getCustomer: async () => ({ kycStatus: 'verified', fullName: 'Buyer Ltd' }) }),
}));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => ({ id: 'default', kycMode: 'delegated', countries: ['US'] }) }),
}));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
const verify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue: async () => ({ ok: true, code: '123456' }), verify }),
}));
const finalizeCrossBorderBillPayment = vi.hoisted(() => vi.fn());
vi.mock('@/lib/b2b-pay-finalize', () => ({ finalizeCrossBorderBillPayment }));

import { POST } from '@/app/api/pay/b2b/[invoiceId]/route';

const post = (fields: Record<string, string>) =>
  POST(
    new NextRequest('http://x/api/pay/b2b/inv_1', {
      method: 'POST',
      body: JSON.stringify({ otp: '123456', fields }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ invoiceId: 'inv_1' }) },
  );

beforeEach(() => {
  resetRateCacheForTests();
  verify.mockReset().mockResolvedValue({ ok: true });
  finalizeCrossBorderBillPayment.mockReset().mockResolvedValue({ ok: false, error: 'seller_unavailable' });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net'))); // FX provider down
});

describe('POST /api/pay/b2b/[invoiceId] — FX before OTP (Task 9)', () => {
  it('a non-USD buyer while FX is down → 503 fx_unavailable; the OTP is NOT consumed and nothing is minted', async () => {
    buyerPhone = '447700900123';
    const res = await post({ sortCode: '112233', accountNumber: '12345678' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'fx_unavailable' });
    expect(verify).not.toHaveBeenCalled();
    expect(finalizeCrossBorderBillPayment).not.toHaveBeenCalled();
  });

  it('a USD buyer needs no FX: the outage does not block the checkout (buyerToUsd = 1)', async () => {
    buyerPhone = '15551112222';
    const res = await post({ routingNumber: '021000021', accountNumber: '12345678' });
    expect(verify).toHaveBeenCalledOnce();
    expect(finalizeCrossBorderBillPayment).toHaveBeenCalledOnce();
    expect(finalizeCrossBorderBillPayment.mock.calls[0][1]).toMatchObject({ buyerToUsd: 1 });
    expect(res.status).toBe(400); // the stubbed finalize refusal — the FX gate did not fire
  });
});
```

**8b — run, expect failure.** `npx vitest run tests/pay-b2b-route-fx.test.ts` → `2 failed`: `expected 400 to be 503` (main verifies — and BURNS — the OTP at `:185`, then its unguarded `getFxRates` throws into the route's generic 400 at `:265-267`) and `expected "spy" to be called once, but got 0 times` (main fetches FX even for a USD buyer, so the outage blocks it).

**8c — implementation.** `src/app/api/pay/b2b/[invoiceId]/route.ts`:
- `:11` → `import { getFxRates, RateUnavailableError } from '@/lib/rate';`
- delete `:193-196` (the `// buyer→USD for the ledger USD-equivalent …` comment and the `buyerRates` / `buyerToUsd` consts, plus the blank line after them);
- insert immediately ABOVE `// ── OTP step-up — verified LAST …` (`:180`):

```ts
    // ── FX (Task 9) — BEFORE the OTP check, so a provider outage never burns
    // the single-use code, and before the claim-first mint, so a refusal never
    // lands between mint and settlement. buyer→USD is the ledger USD-equivalent
    // (screening + accrual basis) — the CHARGED figure is the locked
    // buyer-currency quote; this is internal only. A USD buyer needs no FX.
    let buyerToUsd = 1;
    if (buyerCurrency !== 'USD') {
      try {
        buyerToUsd = (await getFxRates(buyerCurrency)).toUsd;
      } catch (err) {
        if (err instanceof RateUnavailableError) {
          return NextResponse.json(
            { ok: false, reason: 'fx_unavailable', error: err.message },
            { status: 503 },
          );
        }
        throw err;
      }
    }

```

`buyerToUsd` is consumed unchanged by the `finalizeCrossBorderBillPayment` call (`:199-202`).

`src/app/pay/b2b/[invoiceId]/page.tsx:116-118` — comment only (its bare `catch` at `:148-150` already renders the Inactive sheet for any throw, including `RateUnavailableError` from `:121`/`:126`, and `quoteCrossBorderBill`/`quoteBuyerDenominatedBill` now refuse fallback/stale rates too):

```tsx
  // Live-locked checkout quote — reused on reload, re-quoted on expiry. Wrapped:
  // a QuoteError (bad FX input) or a RateUnavailableError (Task 9: provider
  // down / no rate inside the ceiling) degrades to the friendly Inactive sheet
  // instead of a 500, matching the POST route's 503.
```

**8d — run, expect green.** `npx vitest run tests/pay-b2b-route-fx.test.ts tests/b2b-crossborder-pay.test.ts tests/b2b-crossborder-invoice.test.ts && npx vitest run && npx tsc --noEmit` → green (173 files, 2344 tests).

**8e — commit.**

```bash
git add "src/app/api/pay/b2b/[invoiceId]/route.ts" "src/app/pay/b2b/[invoiceId]/page.tsx" tests/pay-b2b-route-fx.test.ts
git commit -m "fix(b2b): read FX before the OTP check and refuse with 503; a USD buyer needs no FX

An outage no longer burns the buyer's single-use code or falls into the
generic 400; the refusal happens before the claim-first mint.

Refs: money-07."
```

- [ ] **Step 9: a refused scheduled send is counted, logged (scrubbed) and pages ops once per day — never silent**

**9a — failing tests.** `tests/cron-run.test.ts`:
- after `:1` add `import { sql } from 'drizzle-orm';`
- `makeDeps` (`:58-67`) must hand out its db: change its return (`:67`) to `  return { redis, db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore };`
- `CronDeps` gains a REQUIRED `db` (so the one production caller cannot forget it). Update all 8 existing call sites mechanically — replace EVERY
  `    const { store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();` with
  `    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();`
  and EVERY
  `      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,` with
  `      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,`
  (8 occurrences each — `:72/:79`, `:92/:100`, `:109/:121`, `:133/:144`, `:156/:163`, `:174/:190`, `:203/:218`, `:227/:241`).
- append:

```ts
describe('runDueSchedules — a refused scheduled send is loud (Task 9)', () => {
  // The daily cron (vercel.json "0 13 * * *") has no catch-up — isScheduleDueToday
  // matches the day exactly — so a refused run must page ops, not just log.
  async function opsAlerts(db: Awaited<ReturnType<typeof makeDeps>>['db']) {
    const r = await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ dedupe_key: string; payload: { message: string } }> }).rows;
  }

  it('FX unavailable ⇒ not fired, counted, logged (scrubbed), ONE ops.alert keyed schedule-refused:<id>:<day>; lastRunAt untouched', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notified: string[] = [];

    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(notified).toHaveLength(0);
    expect(await store.getTransferCount('default', '15551234567')).toBe(0);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeUndefined();
    const lines = errors.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.includes('"scope":"cron.schedule-run"') && l.includes('"reason":"fetch_failed"'))).toBe(true);
    const alerts = await opsAlerts(db);
    expect(alerts.map((a) => a.dedupe_key)).toEqual(['schedule-refused:due:2026-05-21']); // NOW, Eastern day
    expect(alerts[0].payload.message).toContain('due');
    expect(alerts[0].payload.message).toContain('fetch_failed');
    expect(alerts[0].payload.message).not.toMatch(/\d{7,}/); // never the customer's phone
  });

  it('a same-day re-run that is refused again adds NO second alert (dedupe) but is still counted', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = {
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    };

    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    expect(await runDueSchedules(deps)).toEqual({ fired: 0, failed: 1 });
    expect(await opsAlerts(db)).toHaveLength(1);
  });

  it('a clean run reports failed: 0 and raises no alert (the result shape is { fired, failed })', async () => {
    const { db, store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(sched('due', 21));
    const result = await runDueSchedules({
      db, store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async () => {},
    });
    expect(result).toEqual({ fired: 1, failed: 0 });
    expect(await opsAlerts(db)).toHaveLength(0);
  });
});
```

**9b — run, expect failure.** `npx vitest run tests/cron-run.test.ts` → `3 failed | 8 passed`: `expected { fired: +0 } to deeply equal { fired: +0, failed: 1 }` (twice) and `expected { fired: 1 } to deeply equal { fired: 1, failed: +0 }` — main swallows the refusal with a raw `console.error` and pages nobody. `npx tsc --noEmit` → `TS2353: Object literal may only specify known properties, and 'db' does not exist in type 'CronDeps'` at every call site.

**9c — implementation.** `src/lib/cron-run.ts`:
- after `:4` (`import { env } from './env';`) add:

```ts
import { logError } from './log';
import { RateUnavailableError } from './rate';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { DbOrTx } from '@/db/client';
```

- `CronDeps` (`:13-14`) — make its first member the ledger handle:

```ts
export interface CronDeps {
  // Task 9: the ledger handle a refused run's deduped ops alert is enqueued on.
  db: DbOrTx;
  store: Store;
```

- `runDueSchedules` signature + counters (`:34-38`) →

```ts
export async function runDueSchedules(
  deps: CronDeps,
): Promise<{ fired: number; failed: number }> {
  const schedules = await deps.scheduleStore.listActiveSchedules();
  let fired = 0;
  let failed = 0;
```

- the catch + return (`:100-104`) →

```ts
    } catch (err) {
      // A refused mint (Task 9: FX unavailable; or any other refusal) is LOUD:
      // a scrubbed error line, counted in the result (the /api/cron JSON), and
      // ONE deduped ops alert per schedule per Eastern day. lastRunAt is NOT
      // advanced, so a same-day re-run of /api/cron fires it — but the daily
      // cron has no next-day catch-up (isScheduleDueToday matches the day), so
      // without the alert this cycle's send would silently disappear.
      failed++;
      const reason = err instanceof RateUnavailableError ? err.reason : 'error';
      logError('cron.schedule-run', err, { scheduleId: schedule.id, reason });
      // YYYY-MM-DD for the same Eastern day isScheduleDueToday matches.
      const day = new Date(deps.now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      try {
        await createOutboxRepo(deps.db).enqueue(
          'ops.alert',
          {
            message:
              `⚠️ SmartRemit ops: scheduled send ${schedule.id} was NOT created on ${day} (${reason}) — ` +
              `the customer got no pay link. Re-run /api/cron today once the cause clears; ` +
              `the daily cron does not retry it tomorrow.`,
          },
          { dedupeKey: `schedule-refused:${schedule.id}:${day}` },
        );
      } catch (alertErr) {
        logError('cron.schedule-alert', alertErr, { scheduleId: schedule.id });
      }
    }
  }
  return { fired, failed };
```

`src/app/api/cron/route.ts` (the only production caller — grep `runDueSchedules`): after `:8` (`import { runDueSchedules } from '@/lib/cron-run';`) add `import { getDb } from '@/db/client';`; make the first property of the `runDueSchedules({` argument (`:52-53`)

```ts
    db: getDb(),                  // Task 9: a refused run enqueues a deduped ops alert
```

and `:105` → `  return NextResponse.json({ ok: true, fired: result.fired, failed: result.failed });`.

The alert is keyed `schedule-refused:<scheduleId>:<YYYY-MM-DD>` on the Eastern day `isScheduleDueToday` uses (`src/lib/schedule.ts:4-16`, `src/lib/dates.ts:1-5`), so a same-day re-run that is refused again pages nobody twice (dedupe keys are forever, `outbox-repo.ts:55-71`) and next month's refusal pages again. The message carries the schedule id, day and reason only — never the phone (the scrubber would mask it anyway). A failing enqueue is logged and never aborts the loop over the remaining schedules.

**9d — run, expect green.** `npx vitest run tests/cron-run.test.ts && npx vitest run && npx tsc --noEmit` → `11 passed`; full suite green (173 files, 2347 tests); tsc clean.

**9e — commit.**

```bash
git add src/lib/cron-run.ts src/app/api/cron/route.ts tests/cron-run.test.ts
git commit -m "fix(scheduler): a refused scheduled send is counted, logged and pages ops once per day

The daily cron has no catch-up, so a refused run (FX unavailable or any
other mint refusal) now enqueues ONE deduped ops.alert keyed
schedule-refused:<scheduleId>:<day> on top of the scrubbed log and the
new failed count in the /api/cron JSON. CronDeps gains a required db.

Refs: money-07."
```

- [ ] **Step 10: the worker heartbeat raises one deduped ops alert per degraded/refusing currency per hour**

**10a — failing tests.** `tests/rate-staleness.test.ts:5-6` →

```ts
import { sweepStaleRates, sweepFxHealth, FX_PROBE_CURRENCIES } from '@/lib/rate-staleness';
import { RateUnavailableError, type FxRates } from '@/lib/rate';
import type { FxRatesFn } from '@/lib/corridor-demand';
import type { Db } from '@/db/client';
import type { CurrencyCode } from '@/lib/types';
```

and append:

```ts
describe('sweepFxHealth (Task 9) — the FX outage alert', () => {
  const live = (): FxRates => ({ toInr: 95.82, toUsd: 1, fetchedAt: Date.now(), source: 'live' });
  const fxWith = (bad: Partial<Record<CurrencyCode, 'cache' | 'down'>>): FxRatesFn => async (c) => {
    if (bad[c] === 'down') throw new RateUnavailableError('fetch_failed', c);
    if (bad[c] === 'cache') return { ...live(), fetchedAt: Date.now() - 600_000, source: 'cache' };
    return live();
  };

  it('probes every fetched currency — never AED (derived from the USD peg)', () => {
    expect([...FX_PROBE_CURRENCIES].sort()).toEqual(['AUD', 'CAD', 'GBP', 'HKD', 'INR', 'MXN', 'NZD', 'SGD', 'USD']);
  });

  it('a refusing and a degraded currency each raise ONE ops.alert keyed on the hour bucket', async () => {
    const now = new Date();
    const bucket = Math.floor(now.getTime() / 3_600_000);
    expect(await sweepFxHealth(db, fxWith({ GBP: 'down', USD: 'cache' }), now)).toBe(2);
    const rows = await outboxRows();
    expect(rows.every((r) => r.kind === 'ops.alert')).toBe(true);
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual([`fx-health:GBP:${bucket}`, `fx-health:USD:${bucket}`]);
  });

  it('re-running in the same hour adds NOTHING; the next hour alerts again', async () => {
    const now = new Date();
    const fx = fxWith({ GBP: 'down' });
    expect(await sweepFxHealth(db, fx, now)).toBe(1);
    expect(await sweepFxHealth(db, fx, now)).toBe(0);
    expect(await sweepFxHealth(db, fx, new Date(now.getTime() + 3_600_000))).toBe(1);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('all-live rates raise no alert', async () => {
    expect(await sweepFxHealth(db, fxWith({}), new Date())).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('the alert names the currency and state only — no phone, amount or partner data', async () => {
    await sweepFxHealth(db, fxWith({ MXN: 'down' }), new Date());
    const r = await db.execute(sql`SELECT payload FROM outbox`);
    const { message } = (r as unknown as { rows: Array<{ payload: { message: string } }> }).rows[0].payload;
    expect(message).toContain('MXN');
    expect(message).toContain('UNAVAILABLE (fetch_failed)');
    expect(message).not.toMatch(/\d{7,}/);
  });
});
```

**10b — run, expect failure.** `npx vitest run tests/rate-staleness.test.ts` → `5 failed`: `TypeError: FX_PROBE_CURRENCIES is not iterable` and `TypeError: (0 , sweepFxHealth) is not a function`.

**10c — implementation.** `src/lib/rate-staleness.ts` — after `:3` (`import { createOutboxRepo } from '@/db/repos/outbox-repo';`) add:

```ts
import { FALLBACK_FX_RATES, FRANKFURTER_BASE_URL, RateUnavailableError, getFxRates } from './rate';
import type { FxRatesFn } from './corridor-demand';
import type { CurrencyCode } from './types';
```

and append to the file:

```ts
// ── Platform FX health (Task 9) ─────────────────────────────────────────────
// getFxRates has no Db handle, so the FX alert is raised HERE, on the worker
// heartbeat, by PROBING the platform FX for every currency Frankfurter serves.
// A probe that comes back source:'cache' (a re-fetch failed; the last good rate
// is being served) or throws RateUnavailableError (quotes are being REFUSED)
// enqueues ONE deduped ops.alert per currency per clock hour — dedupe keys are
// forever, so the hour bucket is what lets a lasting outage alert again.
// AED is derived from USD (never fetched), so probing USD covers it.

/** Every currency getFxRates actually fetches (the typed table lists them all). */
export const FX_PROBE_CURRENCIES: readonly CurrencyCode[] = (
  Object.keys(FALLBACK_FX_RATES) as CurrencyCode[]
).filter((c) => c !== 'AED');

/**
 * Enqueue one deduped ops alert per currency whose platform FX is degraded
 * (stale cache) or unavailable (refusing). Returns the number of NEW alerts.
 */
export async function sweepFxHealth(
  db: Db,
  fx: FxRatesFn = getFxRates,
  now: Date = new Date(),
): Promise<number> {
  const outbox = createOutboxRepo(db);
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const results = await Promise.allSettled(FX_PROBE_CURRENCIES.map((c) => fx(c)));
  let alerted = 0;
  for (let i = 0; i < FX_PROBE_CURRENCIES.length; i++) {
    const currency = FX_PROBE_CURRENCIES[i];
    const r = results[i];
    let state: string | null = null;
    if (r.status === 'rejected') {
      const reason = r.reason instanceof RateUnavailableError ? r.reason.reason : 'error';
      state = `UNAVAILABLE (${reason}) — every quote in ${currency} is being refused`;
    } else if (r.value.source === 'cache') {
      state = 'DEGRADED — serving the last good rate; quotes will be refused once it is 60 min old';
    }
    if (!state) continue;
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: platform FX for ${currency} is ${state}. ` +
          `Check ${FRANKFURTER_BASE_URL}.`,
      },
      { dedupeKey: `fx-health:${currency}:${hourBucket}` },
    );
    if (fresh) alerted++;
  }
  return alerted;
}
```

`src/app/api/worker/route.ts`:
- `:8` → `import { sweepFxHealth, sweepStaleRates } from '@/lib/rate-staleness';`
- after the stale-rates block (its closing `}` at `:112`) insert:

```ts

  // Platform FX health (Task 9): one deduped ops alert per degraded/refusing
  // currency per hour. The 5-minute heartbeat's GET only
  // (.github/workflows/worker-heartbeat.yml) — never a POST poke
  // (src/lib/outbox.ts): during an outage every poke would otherwise re-dial
  // Frankfurter for 9 currencies. The probes run in parallel, each bounded by
  // FX_FETCH_TIMEOUT_MS; a throw never blocks the drain.
  let fxHealth = 0;
  if (req.method === 'GET') {
    try {
      fxHealth = await sweepFxHealth(deps.db);
    } catch (err) {
      logError('worker.fx-sweep', err);
    }
  }
```

- `:143` → `  return NextResponse.json({ ok: true, processed, failed, dead, released, sweep, staleRates, fxHealth });` (no test asserts this JSON — grep `staleRates` in `tests/`).

Budget note (Task 7 owns this file's time budget; this is additive): the sweep runs before `started` (`:115`), so the drain window is unchanged; `hardStopAt` (`:116`) is still measured from `invocationStart`, and `stopAfter = min(started + START_CUTOFF_MS, hardStopAt − RAIL_TIMEOUT_MS)` (`:119`) already absorbs a ≤5 s probe. Healthy steady state: every probe is an L1/L2 hit or one fetch per currency per soft TTL (≤ 9 Frankfurter calls per heartbeat), which also keeps the fleet L2 warm.

**10d — run, expect green.** `npx vitest run tests/rate-staleness.test.ts && npx vitest run && npx tsc --noEmit` → green (173 files, 2352 tests).

**10e — commit.**

```bash
git add src/lib/rate-staleness.ts src/app/api/worker/route.ts tests/rate-staleness.test.ts
git commit -m "feat(corridors-fx): heartbeat FX probe raises one deduped ops.alert per degraded currency per hour

sweepFxHealth probes every fetched currency (AED rides USD) on the
heartbeat GET only; a cached-rate or refusing currency enqueues an
ops.alert keyed fx-health:<currency>:<hourBucket>.

Refs: obs-08, money-07."
```

- [ ] **Step 11: honest surfaces — admin rates page, landing (ui-08), public API docs, seed comment**

UI pages are not unit-tested (CLAUDE.md); they are verified by tsc + eslint + `npm run build` here and the Chrome walk-through after deploy.

`src/app/admin-dashboard/rates/page.tsx` (currently 500s the whole page when `getFxRates` throws):
- `:9` → `import { getFxRates, RateUnavailableError, type FxRates } from '@/lib/rate';`
- `midFor` signature (`:28`) → `function midFor(rate: PartnerRate, fx: Map<CurrencyCode, FxRates | null>): number | null {` (its existing `if (!src) return null` / `if (!dest …) return null` handle `null`).
- replace `:69-75` with:

```tsx
  // One live mid fetch per distinct currency involved (L1/L2-cached) — fine on
  // a force-dynamic admin page. Task 9: a currency the platform FX refuses
  // (provider down / no rate inside the ceiling) renders as "—" with a notice
  // instead of 500-ing the page; a stale-cache mid is flagged.
  const currencies = [...new Set(rates.flatMap((r) => [r.sourceCurrency, r.destinationCurrency]))];
  const fxEntries = await Promise.all(
    currencies.map(async (c) => {
      try {
        return [c, await getFxRates(c)] as const;
      } catch (err) {
        if (err instanceof RateUnavailableError) return [c, null] as const;
        throw err;
      }
    }),
  );
  const fx = new Map<CurrencyCode, FxRates | null>(fxEntries);
  const fxDown = currencies.filter((c) => fx.get(c) === null);
  const fxStale = currencies.filter((c) => fx.get(c)?.source === 'cache');
```

- after the `sh-page-sub` div's closing `</div>` (`:89`), still inside the inner `<div>`, insert (the `sh-*` classes are untouched):

```tsx
            {(fxDown.length > 0 || fxStale.length > 0) && (
              <p className="mt-2 text-sm text-destructive">
                {fxDown.length > 0 && `Platform FX unavailable for ${fxDown.join(', ')}: mids show —, quotes are refused. `}
                {fxStale.length > 0 && `Platform FX for ${fxStale.join(', ')} is a cached rate (under 60 min old).`}
              </p>
            )}
```

`src/app/page.tsx` (ui-08 — main renders `FALLBACK_FX_RATE` as "Today, 1 USD = ₹85.00 (live mid-market rate)" on any failure, `:138-144`, `:436-437`):
- `:3` → `import { getFxRates, FALLBACK_FX_RATE } from '@/lib/rate';`
- `:28-29` →

```ts
// ISR revalidates hourly. getFxRates() caches 5 min with a 60-min ceiling, and
// the ECB publishes one fixing per business day, so the figure below is always
// printed WITH its fixing date (ui-08).
```

- replace `:136-144` with:

```ts
  // ui-08 (Task 9): the figure is shown ONLY with its provenance — live ⇒
  // "mid-market rate, ECB fixing of <date>"; a cached rate ⇒ "indicative";
  // refused (getFxRates throws RateUnavailableError) ⇒ no figure at all, never
  // a constant labelled live. Any throw degrades — the page never errors on FX.
  let fxRate: number | null = null;
  let fxLive = false;
  let fxAsOf: string | null = null;
  try {
    const fx = await getFxRates('USD');
    fxRate = fx.toInr;
    fxLive = fx.source === 'live';
    fxAsOf = fx.asOf ?? null;
  } catch {
    /* no figure */
  }
  // The decorative hero + chat mock always draw A figure: the live mid when we
  // have it, else the display table's illustrative one — and only a live figure
  // is ever labelled live (HeroPipeline's `live`; ChatMock never claims it).
  const illustrativeRate = fxRate ?? FALLBACK_FX_RATE;
```

- `:256` → `              <HeroPipeline rate={illustrativeRate} live={fxLive} />`
- `:313` → `                <ChatMock rate={illustrativeRate} />`
- replace `:435-438` with:

```tsx
              <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#f5f7f8]">
                {fxRate === null ? (
                  <>Live rate temporarily unavailable — you&apos;ll see the exact rate in chat before you confirm.</>
                ) : (
                  <>
                    1 USD = {fmtRate(fxRate)}{' '}
                    <span className="text-[#8b94a0]">
                      ({fxLive ? 'mid-market rate' : 'indicative rate'}
                      {fxAsOf ? `, ECB fixing of ${fxAsOf}` : ''}).
                    </span>
                  </>
                )}
              </p>
```

- `:444` → `            <RateCalculator rate={fxRate} live={fxLive} asOf={fxAsOf} />`

`src/app/landing/RateCalculator.tsx`:
- Props (`:8-11`) →

```ts
interface Props {
  /** Server-passed USD→INR rate; null when the FX provider refused (no figure shown). */
  rate: number | null;
  /** true only for a rate fetched live; false ⇒ an indicative cached rate. */
  live: boolean;
  /** The ECB fixing date the provider reported (YYYY-MM-DD), for the "as of" copy. */
  asOf: string | null;
}
```

- `:32` → `export default function RateCalculator({ rate, live, asOf }: Props) {`
- `:40` → `  const theyGet = rate === null ? null : numeric * rate;`
- `:80` → `            {theyGet === null ? '—' : hasAmount ? formatInr(theyGet) : '₹0'}`
- replace `:94-97` with:

```tsx
      <p className="mt-3 text-xs leading-[1.5] text-[var(--lp-text-300)]">
        {rate === null
          ? 'Our FX provider is temporarily unreachable, so no rate is shown. The exact rate is quoted and locked when you confirm in chat.'
          : live
            ? `Mid-market rate from our FX provider${asOf ? ` (ECB fixing of ${asOf})` : ''}. Final rate is locked when you confirm in chat.`
            : `Indicative rate${asOf ? ` (ECB fixing of ${asOf})` : ''}: our FX provider is temporarily unreachable. The exact rate is quoted and locked when you confirm in chat.`}
      </p>
```

`src/app/landing/HeroPipeline.tsx`:
- Props (`:11-14`) →

```ts
interface Props {
  /** USD→INR figure for the illustration (the live mid, or an illustrative one). */
  rate: number;
  /** true only when `rate` was fetched live — otherwise it is labelled illustrative (ui-08). */
  live: boolean;
}
```

- `:76-78` →

```ts
export default function HeroPipeline({ rate, live }: Props) {
  const payout = inr(200 * rate);
  const rateText = '₹' + rate.toFixed(2);
  const rateLabel = live ? 'live mid-market' : 'illustrative rate';
```

- in the `aria-label` (`:83`) replace `at the live rate of 1 USD = ${rate}` with `at ${live ? 'the live rate' : 'an illustrative rate'} of 1 USD = ${rateText}`;
- `:105` → `            1 USD = {rateText} · {rateLabel}`

`src/app/landing/showcase.tsx` (`ChatMock` — a decorative mock that never labels its figure live): `:20` → `export function ChatMock({ rate }: { rate: number }) {`, and replace `liveRate` with `rate` at `:42`, `:45`, `:54` (`{inr(500 * rate)}`, `₹{rate.toFixed(2)}`, `{inr(500 * rate)}`). `grep -n "liveRate" src/app` must print nothing afterwards.

`src/app/docs/page.tsx:82` →

```tsx
            Errors are JSON: <code>{`{ "error": "…" }`}</code>. <code>503</code> means live FX
            is temporarily unavailable and nothing was minted — retry later (a{' '}
            <code>POST /transactions</code> retry may reuse the same Idempotency-Key).
```

`scripts/seed-demo-partners.ts:96-97` (the "falls back to 85 offline" comment is now false) →

```ts
  // Live mid for the winner's strictly-better pushed rate (real Frankfurter).
  // getFxRates THROWS when no rate inside the ceiling exists (Task 9) — the
  // seed fails loudly via main().catch instead of pushing rates off a constant.
```

Run: `npx tsc --noEmit && npx eslint . --max-warnings 0 && npm run build` → clean; build `EXIT 0` (verified: `/` is dynamic — it reads `searchParams` — so the build never pre-renders an FX figure). Optional local proof: `npx next start -p 4317` then `curl -s localhost:4317/ | grep -o 'ECB fixing of [0-9-]*'` → `ECB fixing of <today's fixing date>` (verified: rendered `1 USD = ₹95.82 (mid-market rate, ECB fixing of 2026-09-21).`).

Commit:

```bash
git add src/app/admin-dashboard/rates/page.tsx src/app/page.tsx src/app/landing/RateCalculator.tsx \
  src/app/landing/HeroPipeline.tsx src/app/landing/showcase.tsx src/app/docs/page.tsx scripts/seed-demo-partners.ts
git commit -m "fix(landing,admin-dashboard): show an FX figure only with its provenance; rates page degrades instead of 500

The landing rate carries its ECB fixing date and is never a constant
labelled live (no figure when refused; decorative mocks say illustrative).
The admin rates page renders — for a refused currency and flags a cached
mid. /docs documents the partner-API 503.

Refs: ui-08, money-07."
```

- [ ] **Step 12: full verification (the Stop hook enforces it — quote the output in the PR)**

```bash
cd ~/dev/wt/corridors-fx
npx tsc --noEmit
npx eslint . --max-warnings 0
npx vitest run
# CI migration drift check, exactly as .github/workflows/ci.yml:38-52 runs it:
npx drizzle-kit generate --name ci_drift_check
git status --porcelain -- drizzle/     # expect: nothing ("No schema changes, nothing to migrate")
git checkout -- drizzle/ && git clean -fdq drizzle/
npm run build
```

Expected: tsc 0 errors; eslint 0 warnings; vitest all green (verified on `bf4b083` + this task: **173 files, 2352 tests**; a PGlite cold-start timeout on the first test of a file under full-suite load — seen once in verification — re-runs green in isolation, per CLAUDE.md); drift check empty — **no migration**; build `EXIT 0`. Then grep-prove the fail-open is gone:

```bash
grep -rn "FALLBACK_FX_RATES\[" src/ | wc -l                          # 0 — no code path indexes the table
grep -rn "https://api.frankfurter.app" src tests scripts | wc -l      # 0
grep -rn "instanceof QuoteError" src | wc -l                          # 8 = 7 handlers + the rate.ts doc comment
grep -rn "instanceof RateUnavailableError\|fxRefusal(err" src | wc -l  # 16 — every QuoteError handler has its sibling arm
grep -rn "liveRate" src/app | wc -l                                   # 0
```

- [ ] **Step 13: PR, review gates, deploy proof**

1. `/security-review` on the branch (pricing + money path + new ops-alert text); fix findings, re-run Step 12.
2. `git push -u origin fix/corridors-fx/fx-fail-loud`; open the PR against `main`, title `fix(corridors-fx): make FX failure loud — refuse on stale/unavailable rates, derive AED, close the 0-rate hole (Phase 1 fix 13)`. The PR body carries, on its own line, `Program-Fix: 13`, and states: (a) rulings 7, 10, 11, 12, 13, 17 and how each is met (Task 9 owns `rate.ts` incl. `AbortSignal.timeout(5000)`); (b) `RateUnavailableError` is deliberately NOT a `QuoteError` subclass, with the sibling-arm list (Step 12 grep); (c) the component-boundary flags (tools/prompt, money-paths, partner-api, b2b, outbox-worker, landing-docs) are the ruling-11 call-site guards; (d) **no migration** (drift check output quoted); (e) contracts later tasks consume: `FinalizeResult`'s `'fx_unavailable'`, the `// [fix 6 inserts above this line]` marker (the anchor for Tasks 6 AND 10), the 503 body, `quote.fxFetchedAt` (Task 10's stale-FX fixture uses it — NOT `quotedAt`), and the two new `ops.alert` enqueue sites Task 11's census must count (38 total); (f) the residuals below; (g) quoted Step 12 output. End the body with the attribution lines from the executing session's system reminder.
3. Wait for `ci / ci` green; squash-merge; run `/post-merge-check` (no pending migration) and confirm the post-deploy `smoke.yml` run for the merge SHA is green (it walks `/`, the admin dashboard and a pay link; `sh-*` hooks untouched); `/tracker-sync` (fix 13 → `done` only after smoke green + the walk-through below).
4. Claude-in-Chrome walk-through against https://smartremit.ai: (i) the landing "Live FX" block reads `1 USD = ₹<rate> (mid-market rate, ECB fixing of <date>).` — no "Today", no "live mid-market rate" suffix; the calculator footnote names the fixing date; (ii) `/admin-dashboard/rates` renders with NO notice line while FX is healthy; (iii) a quote to an AE recipient (the `/account` web chat, or WhatsApp) shows the peg — the approve summary reads `1 USD = AED 3.67…` (`buildApproveSummary`, pinned by `tests/tools.test.ts:1774`); (iv) `/outbox-status` (read-only prod ledger snapshot) shows no `ops.alert` row with an `fx-health:` dedupe key after two heartbeats, and the Vercel runtime logs show no `fx.unavailable` / `fx.stale-cache` line since the deploy (the heartbeat discards the worker JSON — `-o /dev/null`, `worker-heartbeat.yml:30-33` — and `CRON_SECRET` must never be printed to fetch it by hand).
5. `/sync-branches` so every `component/*` anchor equals main before Task 6 cuts `fix/whatsapp-agent/…` (Task 6 inserts above this task's marker in `pay-finalize.ts` and adds its `bank_details_required` arm after this task's 503 arm in the pay route).

**Residuals (state them in the PR — none is a regression; each is bounded):**
- **Consumer pay route burns the OTP on an FX refusal.** The OTP is verified (`route.ts:309-316`) before `finalizeDraftPayment`, exactly as for today's `cap`/`kyc_required` refusals; the customer's retry is answered `reason:'otp'` and they resend a code. The B2B route is fixed here because its FX read has no prerequisite.
- **B2B locked quote carries no `fxFetchedAt`.** Its age is bounded by the 15-min lock (`b2b-quote-store.ts:14`) on top of the ≤60-min rate the page locked it from (the page re-quotes on expiry and the quote functions now refuse stale/fallback rates).
- **ECB fixing staleness is displayed, not enforced.** Frankfurter publishes one fixing per TARGET business day (weekends/holidays legitimately serve a 1-4-day-old fixing); the ceiling detects a provider outage, not market movement. A contracted FX provider with an SLA is the audit's longer-term recommendation (obs-08) and out of scope.
- **Scheduler has no next-day catch-up** (`src/lib/schedule.ts:4-16` matches the day exactly) — pre-existing, not changed here. A refused run now pages ops once per schedule per day (`schedule-refused:<id>:<day>`), is counted in the `/api/cron` JSON and logged; a same-day re-run of `/api/cron` fires it. Automatic catch-up is a scheduler change outside this task.
- **live-02 explicit spread disclosure** is Reg E copy — program fix 15. This task removes the bot's unsupported "mid-market/no markup" claims only.


---

### Task 6: Stop minting and settling with the masked placeholder `****last4` as the payout account (ctx-01)

**Program-Fix:** 10 · **Finding:** ctx-01 (`docs/AUDIT-2026-09-14.md:106` manifest row, `:1895` confirmed 3-lens finding) · **Component:** whatsapp-agent (crosses corridors-fx `payout-format.ts`, money-paths `transfer-create.ts` / `pay-finalize.ts` / `http-payment-provider.ts` / `transfer-repo.ts` / `api/pay/`, pay-page `src/app/pay/`, platform-security `store.ts`, partner-api `partner-api-service.ts`, landing-docs `src/app/docs/page.tsx`; the boundary hook WILL flag it — expected under rulings 13, 16, 17) · **Branch:** `fix/whatsapp-agent/no-masked-destination-mint` · **Model:** Fable 5.1 for build and final review (money path + compliance ordering) · **Wave 2**, merge order 9 → **6** → 5 → 11 (wave table + rulings 7, 13, 14, 15, 16, 17, 23, 31 in `docs/superpowers/plans/2026-09-16-phase1-wave1-money-safe-core.md:27,43,50,51,52,53,54,59,67`) · **Migration:** none.

Every `file:line` below was read at `origin/main` = `bf4b083` (Wave 1 merged: Task 7 / PR #254, Task 1 / PR #255, Task 3 / PR #256). **Task 9 (Program-Fix 13, final plan `wave2/task-09.md`) merges before this task** and edits `pay-finalize.ts`, `api/pay/[transferId]/route.ts`, `transfer-create.ts`, `tools.ts`, `prompt.ts`, `partner-api-service.ts`, `cron-run.ts` and their tests; every edit below that touches one of those files is a **delta on Task 9's result**, anchored by content — never by a `bf4b083` line number — and Step 0 stops the build if a Task 9 anchor is missing. Anchors re-verified against the current `wave2/task-09.md`: the marker `// [fix 6 inserts above this line]` (Interfaces `:65`, Step 4c `:1317-1320` — its FX block also hoists `const idem = createIdempotencyRepo(db);` and computes an `alreadyMinted` replay skip below the marker); the `'fx_unavailable'` union arm and 503 route arm (Step 4c); `fxRefusal(err, 'create_transfer')` / `fxRefusal(err, 'send_approve_picker')`, `resolveSender`, `legacyResolved` (Step 6c, `:1607-1745`); `quote.fxFetchedAt` (not `quotedAt`); the prompt insert after `- Never invent exchange rates or fees.` (Step 7c, `:1835`); the cron catch rewrite (`cron-run.ts:100-104` → `failed++` + `logError`, Step 9c, `:2118`); Task 9's end state **173 test files, 2352 tests** (`task-09.md:2545`).

Numbering convention (unchanged from wave 1): in code comments "fix N" means **plan Task N** — `route.ts:80` and Task 9's marker already say "fix 6" for this task. The PR title and `Program-Fix:` trailer use the manifest number **10**.

---

#### The defect, end to end (bf4b083)

1. **Source of the poison.** `maskAccount` (`src/lib/tools.ts:115-119`) renders a bank destination as `"****<last4>"` (or `'account on file'`); `list_saved_recipients` (`:2658`) / `resolve_recipient` (`:2689`) hand it to the model, and `prompt.ts:130`, the `resolve_recipient` description (`tools.ts:728`), the `repeat_transfer` description (`:743`) and `prompt.ts:137` tell the model to hand it back.
2. **The model chooses the payout destination in three chat tools.** `send_approve_picker` keeps `args.payout_*` verbatim (`tools.ts:2762-2763`) into `recordBlockedAttempt` (`:2837-2840`), `createDraft` (`:2866-2874`) and the card (`:2910-2917`); legacy `create_transfer` reads `args.payout_destination` (`:1346`) and its schema asks for "The UPI ID, or the bank account number with IFSC code." (`:387-392`); `create_schedule` reads it (`:2594`; schema `:550-551`). Any string — a placeholder, `xxxx9012`, `•••• 9012`, "ending 9012", an invented account — becomes the payout account.
3. **The pay page skips the bank step** for any non-empty value (`src/app/pay/[transferId]/page.tsx:151,164` → bodyless POST, `pay-form.tsx:89-91`); for an existing transfer the page (`:132`) and route (`src/app/api/pay/[transferId]/route.ts:410`) decide on the **masked default read**, which renders every non-empty stored value as `****<last4>` (`src/db/repos/mappers.ts:134-140`; `last4('****9012') === '9012'`, `:36-40`).
4. **The mint.** `finalizeDraftPayment` falls back to the draft's stored destination for a bodyless POST (`src/lib/pay-finalize.ts:127-130`) *after* `idem.claim` (`:108-121`); `createTransfer` writes it (`src/lib/transfer-create.ts:205`, `:232`) and **overwrites the saved real account** (`:240-247` → `aux-repos.ts:44-62`) — also with `''` on every cold-start mint, and with a **B2B seller's profile account** on every `b2b-pay-finalize` mint (`b2b-pay-finalize.ts:205-214`).
5. **The rail.** `settlement.instruct` reads the decrypted row (`src/lib/outbox-worker.ts:243-246`) and POSTs `buildSettlementInstruction(transfer)` (`:285`) with `payout.destination` = the stored string (`http-payment-provider.ts:67-73`).
6. **No blocked-row early return** in `createTransfer`: a watchlist hit falls through to the velocity bump (`:237`), monthly accrual (`:238`) and `upsertRecipient` (`:240-247`) — the watchlisted recipient lands in the address book, contradicting `recordBlockedAttempt`'s contract (`:282-285`).
7. **`funding_method` is model-controlled and unchecked** (`tools.ts:2757`, `:1347`, `:1369`, `:2595`; repeat from memory `:3007-3010`), and **the B2B shape is model-selectable**: `isB2bArgs` (`:212-214`) treats `funding_method: 'ach_pull'` alone as B2B. The pay route skips OUR funds capture (`route.ts:158`, `isPartnerPulled`) and takes the ACH branch (`:373`, `:470`) on `fundingMethod` alone, so a consumer draft/transfer/schedule carrying `ach_pull` / `bank_pull` is never charged while the rail is still instructed; pre-fix schedules keep such values (`tools.ts:2595`) and cron mints them (`cron-run.ts:80-90`).

---

#### Design (read before Step 1)

**The model never chooses a payout destination.** No chat tool reads `args.payout_method` / `args.payout_destination`; the `create_transfer` / `create_schedule` schemas no longer offer them. `send_approve_picker`, legacy `create_transfer`, `create_schedule` and `repeat_transfer` take the destination from `resolveStoredPayout(ctx, recipientPhone, destinationCountry)` or use `''` / `'bank'` (cold start — collected on the secure pay page). The helper is keyed `(ctx.partnerId, ctx.phone)` + normalized recipient phone (no global / name / cross-sender / cross-tenant lookup) and returns:
1. the **saved recipient** (`listRecipients`, the explicit decrypt path) only when (a) the number's calling-code country (`countryForPhone`, `partner-currency.ts:11-18`) equals the send's destination country — `recipients` has no country column (`schema.ts:418-431`) — and (b) `store.hasB2bTransferTo(...)` (a single indexed `EXISTS`-style probe on `(partner_id, phone, recipient_phone, transfer_type='b2b')`) is false, since a pre-fix B2B mint may have written a seller's profile account there;
2. else `store.latestSettledConsumerTransferTo(...)`: the sender's most recent **`b2c` transfer to that number with `status IN ('paid','delivered')` in the same destination country**, decrypted.
`''` or a display placeholder is never usable; a B2B payee never rehydrates. `repeat_transfer` passes the last transfer's `destination_country`, so the country check compares the corridor being repeated.

**`funding_method` and the B2B shape are closed.** `send_approve_picker` / legacy `create_transfer` accept only `credit_card | debit_card | bank_transfer | ach_pull`; `create_schedule` / `repeat_transfer` only the three consumer methods; absent ⇒ `bank_transfer`; anything else ⇒ refused before any draft, row or schedule. **A chat send is B2B only when it pays the sender's own open bill:** `entity_type: 'business'` AND `funding_method: 'ach_pull'` AND an `invoice_id` that resolves via `store.getB2bInvoiceScoped(invoiceId, ctx.partnerId)` (`store.ts:304-309`) to an `unpaid` invoice whose `buyerPhone === ctx.phone`, that has **no `sellerId`** (a registered seller's cross-border bill is paid only on its own checkout, `/pay/b2b/<id>`; the refusal hands back that `pay_url`), in USD, sent in USD for **exactly** `amountUsd` (delivery marks the linked invoice paid, so the model must not choose the amount); any other request that looks B2B (`isB2bArgs`) is refused. `repeat_transfer` never carries a remembered / last-used `ach_pull` / `bank_pull`. **`createTransfer` refuses a partner-pulled funding method on anything but a B2B transfer** (before any read or write) — the cron catch counts it as `failed`; pay-finalize refuses such a draft before the claim; the pay route refuses such a row outright and skips capture / takes the ACH branch **only** when `transferType === 'b2b'`; the rail instruction refuses it too.

**The `''` exemption and the payee are structural.** pay-finalize lets a bodyless `''` draft mint only when `draft.transferType === 'b2b' && draft.fundingMethod === 'ach_pull'` (the chat B2B bill — its pay form collects only the payer's debit mandate, `pay-form.tsx:78-86,473-477`), and **ignores the bank-details body on every B2B draft**: a B2B payee is never payer input (delivery of a B2B transfer marks its linked invoice paid — `src/app/api/payment-webhook/[provider]/route.ts:93-104`).

**Pay-page writes on an existing transfer are one guarded, column-targeted UPDATE.** The existing-transfer branch no longer re-saves a masked read (a whole-row upsert: `transferToRow` writes `recipientLegalNameEnc: sealOptional(t.recipientLegalName) ?? null` — `mappers.ts:99` — so the masked read's absent legal name is written as `NULL`, and the status / funding columns are rewritten from a stale read). New `transfer-repo.setPayoutIfEditable(id, partnerId, payout)` sets **only** `payout_method`, `payout_destination_enc`, `payout_destination_last4` `WHERE id AND partner_id AND status='awaiting_payment' AND funding_ref IS NULL AND transfer_type='b2c' AND` the row was **not minted through the partner API** `RETURNING *`, inside one transaction with an `audit_events` row `transfer.payout_edit` (id + last-4 only). No row back ⇒ the route re-reads and reports current truth — it never writes around the guard. This closes the race the non-atomic OTP verify opens (`transaction-otp.ts:59-83`: get → compare → del — two POSTs can pass on one code): an Edit can never revert a `paid` / `in_review` row or touch a charged one. The B2B ACH branches' mandate bind had the same whole-row re-save (`route.ts:394-401`, `:478-483`); it becomes `transfer-repo.setAchTokenIfAbsent` — `ach_token_ref` only, `WHERE id AND partner_id AND status='awaiting_payment' AND transfer_type='b2b' AND` no token yet — and a miss re-reads (the first mandate wins; a moved row answers its current truth).
**Partner-API detection** (no source/channel column exists on `transfers` — `schema.ts:52-133`): a partner-API mint always binds its `Idempotency-Key` claim-first before minting (`partner-api-service.ts:295`) and then writes an `audit_events` row `action='transaction.create', actor_type='api_key', subject_id=<id>` (`:340`, `:532-546`); pay-page drafts claim `draft:<id>` under the default tenant (`pay-finalize.ts:110`) and B2B checkout claims `b2binvoice:<id>` (`b2b-pay-finalize.ts:84,181`); chat/approve-tap/legacy/cron mints claim nothing. B2B checkout mints are always `transferType: 'b2b'` (`b2b-pay-finalize.ts:236`) and the guard already requires `transfer_type='b2c'`, so a `b2binvoice:` claim never reaches the check. So "partner-API-minted" ⇔ an `idempotency_keys` row for the transfer other than (`draft:%` under `default`), **or** that audit event. Either marker locks the payout (fill and Edit) and hides the page's Edit offer. **The first marker is made unspoofable at the edge:** `createTransaction` rejects an `Idempotency-Key` beginning `draft:` or `b2binvoice:` with 400 (Step 7) — without it, the default tenant (which can be issued API keys, `src/app/admin-dashboard/partners/actions.ts:346-354`) could mint under `draft:*` and a crash between the insert and the audit write (`partner-api-service.ts:315-340`, the audit is written outside any transaction; the replay at `:297-299` writes none) would leave the row with neither marker.

**"Edit bank details".** For a real stored destination on an editable consumer row (or a consumer draft), the single-step form shows "Paying to account ending ####" and an **Edit bank details** button that switches to the two-step bank form; the body's `country` must equal the payment's own destination country.

**`isMaskedDestination` is a backstop, not the defense.** True when the trimmed value contains a run of three or more `*` / `•` / `●`, or case-insensitively equals `'account on file'` or the cold-start card text; `''` is not masked. It does not try to recognise `xxxx9012` or invented accounts — those cannot reach a chokepoint from chat any more.

**Chokepoints, in money order:** (1) `createTransfer` — partner-pulled-consumer refusal (top); then, after compliance is final, the **blocked-row early return** (mask scrubbed to `''`, no accrual, no upsert), the **placeholder refusal** (`MaskedDestinationError`, nothing written), and an address-book upsert only for a non-empty destination on a non-B2B transfer; (2) `finalizeDraftPayment` — directly above Task 9's marker (ruling 7: kyc → **destination** → FX → cap → claim): partner-pulled consumer draft ⇒ `expired_or_used`; placeholder, or `''` without the B2B-ach_pull exemption ⇒ `bank_details_required`; B2B body ignored; (3) pay route + page — decrypted `hasDestination`, the guarded payout write, the body-country tie, `bank_details_required` → 400 after Task 9's 503 arm, consumer-partner-pulled rows refused; (4) `buildSettlementInstruction` — throws on a placeholder (`settlement_destination_invalid:<id>`) or a consumer partner-pulled row (`settlement_funding_invalid:<id>`); (5) approve-tap maps both new errors (restores the draft for a placeholder); the partner API refuses a placeholder `payout_destination` with 422 before the claim.

**Remediation without a migration:** a read-only sweep (`scripts/audit-masked-destinations.ts`) lists placeholder transfers/recipients/schedules, consumer transfers with a partner-pulled method, active schedules with a non-consumer funding method, and **every active schedule holding any non-empty destination written before the fix** (a model invention like `xxxx9012` is not recognisable, so all pre-fix schedule destinations are suspect). A **separate, owner-run** script (`scripts/blank-prefix-schedule-destinations.ts`, dry-run by default, `--apply` + a mandatory `--before <deploy ISO>` cutoff) blanks those to `''` / `'bank'` so each run collects the details on the pay page.

**Money-path invariants from CLAUDE.md that apply, and where:**
- *Money paths are transactional* (Step 5): the pay-page payout write + its audit row commit in one transaction; the write is a single guarded UPDATE — no read-modify-write re-save.
- *Claim-first minting* (Step 4): every new pay-finalize refusal returns before `idem.claim` / `consumeDraft`; pure function of `(draft, body)`.
- *Sanctions screening always runs* (Steps 3, 6): the blocked early return precedes the placeholder refusal; tools rehydrate before `screenTransfer` / `recordBlockedAttempt`.
- *Encryption at rest + masked reads* (Steps 5, 6): no default read widened; decrypted reads feed booleans, a last-4 label and the draft/schedule only; the audit row carries last-4 only; the page (link-reachable without OTP) never renders more than 4 digits.
- *Tenant isolation* (Steps 5, 6): every new query carries `partner_id` (`setPayoutIfEditable`, `setAchTokenIfAbsent`, `hasB2bTransferTo`, `latestSettledConsumerTo`, the invoice lookup is `getB2bInvoiceScoped(…, ctx.partnerId)`).
- *Durability* (Step 2): no new external effect; the backstop throws behave like `outbox-worker.ts:283`.
- *Server-side/edge validation* (Steps 5, 6, 7): model inputs (`funding_method`, B2B shape), payer inputs (`country`, B2B body) and partner inputs (`payout_destination`) are validated before any side effect.

**Files:**
- Create: `tests/pay-route-masked-draft.test.ts` (first route test of the DRAFT branch — every existing `pay-route-*` suite mocks `getDraft → null`: `pay-route-bank-details.test.ts:39`, `-otp:39`, `-funding:55`, `-ach-pull:54`, `-delayed-poke:51`)
- Create: `scripts/audit-masked-destinations.ts` + `tests/audit-masked-destinations.test.ts`; `scripts/blank-prefix-schedule-destinations.ts` + `tests/blank-prefix-schedule-destinations.test.ts`
- Modify: `src/lib/payout-format.ts` (additive: `isMaskedDestination`, `ACCOUNT_ON_FILE_PLACEHOLDER`, `NO_BANK_DETAILS_PLACEHOLDER` moved from `tools.ts:125-126`)
- Modify: `src/lib/providers/http-payment-provider.ts` (two backstops)
- Modify: `src/lib/transfer-create.ts` (`PartnerPulledConsumerError`, `MaskedDestinationError`, blocked early return, placeholder refusal, upsert rule, docblock)
- Modify: `src/db/repos/transfer-repo.ts` (`isPayoutEditable`, `setPayoutIfEditable`, `setAchTokenIfAbsent`, `hasB2bTransferTo`, `latestSettledConsumerTo`) and `src/lib/store.ts` (two wrappers)
- Modify: `src/lib/pay-finalize.ts` (`'bank_details_required'` arm; guard above Task 9's marker)
- Modify: `src/app/api/pay/[transferId]/route.ts` (`VALID_COUNTRY_CODES` += HK, MX; country tie; consumer-partner-pulled refusal; B2B-keyed ACH/capture; guarded ACH mandate bind in both ACH branches; decrypted `hasDestination`; guarded payout write + audit; 400 arm; docblock)
- Modify: `src/app/pay/[transferId]/page.tsx`, `src/app/pay/[transferId]/pay-form.tsx` (Edit path)
- Modify: `src/lib/tools.ts` (imports; `maskAccount` literal; placeholder re-export; funding closed sets; B2B bill gate; `resolveStoredPayout`; picker, both `create_transfer` paths, `create_schedule`, `repeat_transfer`; two schemas + four descriptions)
- Modify: `src/lib/prompt.ts` (three content-anchored lines), `src/lib/agent.ts` (trailing `[RECIPIENT SELECTED]` instruction only; data fields stay until Task 2, ruling 15)
- Modify: `src/lib/partner-api-service.ts` (reserved `draft:` / `b2binvoice:` Idempotency-Key → 400; masked destination → 422), `src/app/docs/page.tsx` (two sentences)
- Test (append): `tests/payout-format.test.ts`, `tests/http-payment-provider.test.ts`, `tests/transfer-create.test.ts`, `tests/transfer-repo.test.ts`, `tests/pay-finalize.test.ts`, `tests/pay-route-bank-details.test.ts`, `tests/pay-route-ach-pull.test.ts`, `tests/tools.test.ts`, `tests/partner-api-service.test.ts`, `tests/cron-run.test.ts`
- Test (update existing fixtures): `tests/tools.test.ts` — `seedPastTransfer` (`:1609-1621` on bf4b083), `seedPast` (`:2792-2806`), the two B2B tool tests (`:3316-3342`, `:3358-3397`) and `mintB2b` (`:3414-3427`) seed an unpaid invoice (B2B now requires the sender's own open bill)
- **Deliberately unchanged (callers re-read):** `src/lib/cron-run.ts` (a refused mint lands in the catch, `:100-102` on bf4b083 → Task 9's `failed++` + `logError`; pinned in Step 7), `src/lib/b2b-pay-finalize.ts` (transferType `'b2b'`, profile payout; `''` refused at `:110-111`), `src/lib/outbox-worker.ts` (throws propagate like `:283`), `src/lib/transaction-otp.ts` (its non-atomic verify is neutralised for payout writes by the guarded UPDATE — see residuals), `get_quote`'s `funding_method` cast (`tools.ts:1087-1088` — quotes only).

All commands run from the worktree root; single-file runs `npx vitest run <file>`. The Stop hook additionally requires `npm run typecheck`, `npm run lint`, `npx vitest run --changed` green. End every commit message with the attribution trailers from the executing session's system reminder.

---

#### Step 0 — Worktree, branch, pre-flight, baseline (no code)

1. Worktree **outside iCloud**, branch, take `main` (Tasks 7, 1, 3, 9 on it):
   ```
   git -C "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" fetch -q origin
   git -C "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" worktree add ~/dev/wt/whatsapp-agent origin/component/whatsapp-agent
   cd ~/dev/wt/whatsapp-agent
   git checkout -b fix/whatsapp-agent/no-masked-destination-mint
   git merge --no-edit origin/main
   npm ci
   ```
2. **Task 9 gate — STOP if any line prints nothing:**
   ```
   grep -n "\[fix 6 inserts above this line\]" src/lib/pay-finalize.ts
   grep -n "'fx_unavailable'" src/lib/pay-finalize.ts "src/app/api/pay/[transferId]/route.ts"
   grep -n "function fxRefusal\|fxRefusal(err, 'create_transfer')\|fxRefusal(err, 'send_approve_picker')" src/lib/tools.ts
   grep -n "async function resolveSender\|legacyResolved" src/lib/tools.ts
   grep -n "RateUnavailableError" src/lib/partner-api-service.ts
   grep -n "fxFetchedAt" src/lib/types.ts
   grep -n "Never invent exchange rates or fees" src/lib/prompt.ts
   grep -n "alreadyMinted" src/lib/pay-finalize.ts
   ```
   Expected: the marker once, directly below the `kyc_required` return and directly above Task 9's `// ── FX gate (Task 9)` block (which creates `idem` and `alreadyMinted`); `'fx_unavailable'` in the union and the route arm; `fxRefusal` in both `createTransferTool` catches and both `sendApprovePickerTool` catches.
3. `ls drizzle/*.sql | tail -2` → `drizzle/0014_outbox_lease.sql`, `drizzle/0015_tenant_scoped_customers.sql` (this task adds none).
4. **Re-cite on the rebased tree.** Task 9 moved lines in `tools.ts`, `prompt.ts` (two lines inserted after `:82`), `transfer-create.ts`, `pay-finalize.ts`, `route.ts`, `partner-api-service.ts`, `cron-run.ts`, `tests/tools.test.ts` (its rate import at `:24` became multi-line — `import type { Db } from '@/db/client';` is now `:34`), `tests/pay-finalize.test.ts`, `tests/partner-api-service.test.ts`, `tests/cron-run.test.ts`. **Every edit below names its anchor by content.** The three `prompt.ts` edits anchor on `- If you see a "[RECIPIENT SELECTED] ..." note`, `  • match "exact"     → use the returned recipient's payout_method`, `- If repeat_transfer returns needs_edd: true`.
5. **Baseline:** `npx vitest run` on the rebased tree → **173 test files, 2352 tests, all passed** (Task 9's verified end state, `task-09.md:2545`; a PGlite cold-start timeout re-runs green in isolation per CLAUDE.md). Record the exact line. **Expected delta after this task: +3 files → 176 files; +72 tests → 2424 tests** (new test files: `pay-route-masked-draft`, `audit-masked-destinations`, `blank-prefix-schedule-destinations`; the new `it(` blocks in Steps 1–8: payout-format 3, http-payment-provider 5, transfer-create 6, pay-finalize 7, transfer-repo 6, pay-route-bank-details 11, pay-route-ach-pull 2, pay-route-masked-draft 4, tools 21, partner-api-service 2, cron-run 2, audit sweep 1, blanking script 2 — the fixture edits in `tests/tools.test.ts` change no count). If the baseline differs from 173/2352, use it and apply the same delta.

---

#### Step 1 — `isMaskedDestination`: the backstop predicate (RED → GREEN)

1. **Failing test** — in `tests/payout-format.test.ts` extend the import block (`:2-12`) with `maskAccountDisplay, isMaskedDestination, ACCOUNT_ON_FILE_PLACEHOLDER, NO_BANK_DETAILS_PLACEHOLDER,` after `payoutMethodLabel,`, then append:

```ts
describe('isMaskedDestination — display placeholders are never payout accounts (fix 6 / ctx-01)', () => {
  it('is TRUE for every mask the codebase renders and for common mask glyph runs', () => {
    for (const v of [
      '****9012',                                     // tools.maskAccount / mappers.rowToTransfer default read
      '****',                                         // a mask with no digits
      '********',                                     // the default read of a row POISONED with '****' (mappers.last4('****') === '****')
      '  ****9012 ',                                  // whitespace never launders it
      'bank a/c ****9012',                            // the approve-card "To:" line (tools.maskDestination)
      'account ****6789',                             // the free-text form prompt.ts:87-88 tells the model to write
      '***9012',
      '•••• 9012',
      '●●●●9012',
      maskAccountDisplay('HDFC0001234 123456789012'), // payout-format's own staff mask
      ACCOUNT_ON_FILE_PLACEHOLDER,
      'Account On File',
      NO_BANK_DETAILS_PLACEHOLDER,
    ]) {
      expect(isMaskedDestination(v), v).toBe(true);
    }
  });

  it('is FALSE for real composed bank, US routing+account, IBAN, UPI and USDC destinations', () => {
    for (const v of [
      composePayoutDestination('IN', { accountNumber: '123456789012', ifsc: 'HDFC0001234' }),
      '021000021 12345678901',
      'AE070331234567890123456',
      'mom@okhdfc',
      composeUsdcDestination('0x' + 'a'.repeat(40)),
    ]) {
      expect(isMaskedDestination(v), v).toBe(false);
    }
  });

  it("is FALSE for '' / whitespace / null / undefined — empty means 'collect on the pay page', which each caller handles", () => {
    expect(isMaskedDestination('')).toBe(false);
    expect(isMaskedDestination('   ')).toBe(false);
    expect(isMaskedDestination(null)).toBe(false);
    expect(isMaskedDestination(undefined)).toBe(false);
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/payout-format.test.ts` → the three new tests fail `TypeError: isMaskedDestination is not a function`.

3. **Implement** — `src/lib/payout-format.ts`, insert AFTER `maskAccountDisplay` (ends `:233`) and BEFORE the `// ── USDC seller payout` banner (`:235`); `accountLast4` / `maskAccountDisplay` untouched (ruling 13):

```ts
// ── Display placeholders are never payout accounts (fix 6 / ctx-01) ─────────
//
// Default ledger reads (mappers.rowToTransfer), the LLM-facing tool results
// (tools.maskAccount), the approve card (tools.maskDestination) and staff views
// (maskAccountDisplay) render a destination as a "****<last4>" mask. The audit
// found that string minted, written over a saved recipient's real account and
// sent to the partner rail. isMaskedDestination is the BACKSTOP every money
// chokepoint uses (pay-finalize, createTransfer, pay route + page, partner-API
// edge, rail instruction). The DEFENSE is structural: no chat tool reads a
// model-supplied destination at all.
//
// '' is deliberately NOT masked: an empty destination means "collect on the
// secure pay page" (Item 2), and each caller decides what '' means for it.

/** Cold-start text for the approve card's "To:" line (moved from tools.ts, which re-exports it). */
export const NO_BANK_DETAILS_PLACEHOLDER =
  "their bank account (you'll enter the details on the secure page)";

/** What tools.maskAccount renders for a bank destination that holds no digits. */
export const ACCOUNT_ON_FILE_PLACEHOLDER = 'account on file';

/** Three or more mask glyphs in a row: asterisk, bullet, black circle. No legal destination contains one. */
const MASK_RUN = /[*•●]{3,}/;

/**
 * True when `dest` is display text rather than a payout account: anything that
 * contains a mask-glyph run, or the two fixed placeholders, case-insensitively.
 * Pure; trims; '' / whitespace / null / undefined → false.
 */
export function isMaskedDestination(dest: string | null | undefined): boolean {
  const v = (dest ?? '').trim();
  if (v === '') return false;
  if (MASK_RUN.test(v)) return true;
  const lower = v.toLowerCase();
  return lower === ACCOUNT_ON_FILE_PLACEHOLDER || lower === NO_BANK_DETAILS_PLACEHOLDER.toLowerCase();
}
```

   Then in `src/lib/tools.ts`: add after `import { logWarn } from './log';` (`:36`) `import { ACCOUNT_ON_FILE_PLACEHOLDER, NO_BANK_DETAILS_PLACEHOLDER } from './payout-format';` (`isMaskedDestination` joins it in Step 6, where it is first used — importing it now fails `eslint --max-warnings 0`); in `maskAccount` replace `: 'account on file';` with `: ACCOUNT_ON_FILE_PLACEHOLDER;` (byte-identical output; `tests/tools.test.ts:1442-1460` green); replace the block starting `// Cold-start placeholder for the approve card's "To:" line when no bank details` through `"their bank account (you'll enter the details on the secure page)";` (`:121-126`) with:
   ```ts
   // Cold-start placeholder for the approve card's "To:" line (Item 2). The
   // literal lives in payout-format.ts so isMaskedDestination and the card share
   // ONE string; re-exported here so no importer changes.
   export { NO_BANK_DETAILS_PLACEHOLDER };
   ```

4. **Run:** `npx vitest run tests/payout-format.test.ts tests/tools.test.ts` → green.

5. **Commit:** `feat(corridors-fx): isMaskedDestination — one backstop predicate for display placeholders (ctx-01)`

---

#### Step 2 — Last-line backstops: the rail instruction refuses a placeholder or a consumer partner-pulled row (RED → GREEN)

1. **Failing test** — append to `tests/http-payment-provider.test.ts` (`fixture()` at `:23-34`: `id 'rail_t1'`, `payoutDestination '1234567890'`, no `transferType` ⇒ consumer):

```ts
describe('buildSettlementInstruction — ctx-01 backstops (fix 6)', () => {
  it('throws instead of instructing the rail to pay a masked placeholder', () => {
    for (const bad of ['****9012', '****', '********', 'account on file', 'bank a/c ****9012', '•••• 9012']) {
      expect(() => buildSettlementInstruction({ ...fixture(), payoutDestination: bad }), bad)
        .toThrow('settlement_destination_invalid:rail_t1');
    }
  });

  it('the error carries the transfer id only — never the destination', () => {
    let message = '';
    try {
      buildSettlementInstruction({ ...fixture(), payoutDestination: '****9012' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe('settlement_destination_invalid:rail_t1');
    expect(message).not.toContain('9012');
  });

  it('throws for a CONSUMER row carrying a partner-pulled funding method (never charged by us, never legitimately pulled)', () => {
    for (const fundingMethod of ['ach_pull', 'bank_pull'] as const) {
      expect(() => buildSettlementInstruction({ ...fixture(), fundingMethod }), fundingMethod)
        .toThrow('settlement_funding_invalid:rail_t1');
    }
  });

  it('real bank / UPI / USDC destinations build unchanged, and a B2B ach_pull row with NO destination still builds', () => {
    type Built = { payout: { destination: string } };
    expect((buildSettlementInstruction(fixture()) as Built).payout.destination).toBe('1234567890');
    expect((buildSettlementInstruction({ ...fixture(), payoutMethod: 'upi', payoutDestination: 'mom@okhdfc' }) as Built)
      .payout.destination).toBe('mom@okhdfc');
    const wallet = '0x' + 'b'.repeat(40);
    expect((buildSettlementInstruction({ ...fixture(), payoutMethod: 'usdc', payoutDestination: `USDC|${wallet}` }) as Built)
      .payout.destination).toBe(wallet);
    const b2b = buildSettlementInstruction({
      ...fixture(), fundingMethod: 'ach_pull', achTokenRef: 'ach_abc', transferType: 'b2b', payoutDestination: '',
    } as Transfer) as Built;
    expect(b2b.payout.destination).toBe('');
  });

  it('existing B2B funding-leg fixtures still build (they all carry transferType b2b)', () => {
    const achPull = { ...fixture(), id: 'ach_t2', fundingMethod: 'ach_pull', achTokenRef: 'ach_x', transferType: 'b2b' } as Transfer;
    expect((buildSettlementInstruction(achPull) as { funding?: { method: string } }).funding?.method).toBe('ach_debit');
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/http-payment-provider.test.ts` → tests 1 and 3 `expected [Function] to throw an error`; test 2 `expected '' to be 'settlement_destination_invalid:rail_t1'`; tests 4–5 pass (locks).

3. **Implement** — `src/lib/providers/http-payment-provider.ts` (untouched by Task 9). Import at `:3` →
   ```ts
   import { isMaskedDestination, usdcAddressFromDestination } from '../payout-format';
   import { isPartnerPulled } from '../funding-method';
   ```
   Replace the builder head (`:58-60`) `/** The signed instruction body POSTed to the partner's settlement endpoint. */` / `export function buildSettlementInstruction(transfer: Transfer) {` / `  return {` with:
   ```ts
   /**
    * The signed instruction body POSTed to the partner's settlement endpoint.
    *
    * fix 6 (ctx-01) LAST-LINE BACKSTOPS — a row written before fix 6 fails loudly
    * in its settlement.instruct outbox row (2^n backoff → dead at 8 → deduped ops
    * alert, plus reconcile's stuck-paid alert) instead of instructing:
    *   • a display placeholder ("****9012", "account on file") as the payout; and
    *   • a partner-pulled funding leg (ach_pull / bank_pull) on a CONSUMER row —
    *     the pay route never charged it, and only a B2B bill may be pulled.
    * Messages carry the transfer id only. '' is NOT refused: a B2B ach_pull row
    * legitimately carries no payee destination.
    */
   export function buildSettlementInstruction(transfer: Transfer) {
     if (isMaskedDestination(transfer.payoutDestination)) {
       throw new Error(`settlement_destination_invalid:${transfer.id}`);
     }
     if (isPartnerPulled(transfer.fundingMethod) && transfer.transferType !== 'b2b') {
       throw new Error(`settlement_funding_invalid:${transfer.id}`);
     }
     return {
   ```
   Unchanged: the `payout` block (`:67-73`), `buildReverseInstruction`, `initiateTransfer` (`:184-201`; no production caller — only `handleWebhook` is reached, `src/app/api/payment-webhook/[provider]/route.ts:86`). Every existing partner-pulled fixture carries `transferType: 'b2b'` (`http-payment-provider.test.ts:177-183,186-198,244-256`, `b2b-foundation.test.ts:12-22`, `outbox-worker.test.ts:513-521,762`), and the one consumer override there uses `bank_transfer` (`b2b-foundation.test.ts:74-77`).

4. **Run:** `npx vitest run tests/http-payment-provider.test.ts tests/b2b-foundation.test.ts tests/outbox-worker.test.ts tests/settlement.test.ts tests/reconcile.test.ts` → green.

5. **Commit:** `fix(money-paths): the rail instruction refuses a masked destination or a consumer partner-pulled funding leg (ctx-01 backstops)`

---

#### Step 3 — `createTransfer`: partner-pulled-consumer refusal, blocked-row early return, placeholder refusal, address-book rule (RED → GREEN)

1. **Failing tests** — append at the end of `tests/transfer-create.test.ts` (after `:590`; `makeStores` `:21-30` → `{ db, store, partnerStore, mvs }`, `base` `:32-43`):

```ts
describe('createTransfer — ctx-01 chokepoint (fix 6)', () => {
  const REAL = 'HDFC0001234 123456789012';
  const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();
  async function seedSavedMom(store: Awaited<ReturnType<typeof makeStores>>['store'], at: string) {
    await store.upsertRecipient('default', base.phone, {
      name: 'Mom', recipientPhone: base.recipientPhone, payoutMethod: 'bank', payoutDestination: REAL, lastUsedAt: at,
    });
  }

  it('REFUSES a partner-pulled funding method on a CONSUMER transfer before any write; a B2B ach_pull mint is unaffected', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    for (const fundingMethod of ['ach_pull', 'bank_pull'] as const) {
      await expect(createTransfer(store, partnerStore, mvs, { ...base, fundingMethod }))
        .rejects.toThrow('partner_pulled_funding_requires_b2b');
    }
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    const b2b = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'Globex Trading LLC', fundingMethod: 'ach_pull', payoutDestination: '',
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC',
    });
    expect(b2b.status).toBe('awaiting_payment');
  });

  it('REFUSES a masked destination before ANY write: no ledger row, no velocity/monthly accrual, the saved real account untouched', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const at = yesterday();
    await seedSavedMom(store, at);
    for (const bad of ['****9012', '****', 'account on file', 'account ****9012']) {
      await expect(
        createTransfer(store, partnerStore, mvs, { ...base, payoutMethod: 'bank', payoutDestination: bad }),
      ).rejects.toThrow('masked_payout_destination');
    }
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    const [saved] = await store.listRecipients('default', base.phone, 5);
    expect(saved.payoutDestination).toBe(REAL);
    expect(saved.lastUsedAt).toBe(at);
  });

  it('sanctions run FIRST: a watchlisted recipient with a masked destination leaves ONE blocked audit row with an EMPTY destination — and nothing else', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'John Doe', payoutMethod: 'bank', payoutDestination: '****9012',
    });
    expect(t.status).toBe('blocked');
    expect(t.payoutDestination).toBe('');
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await store.getTransferDecrypted(t.id))?.payoutDestination).toBe('');
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
  });

  it('BEHAVIOUR CHANGE: a blocked mint with a REAL destination keeps it as evidence but never accrues and never writes the address book', async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'John Doe', payoutMethod: 'bank', payoutDestination: REAL,
    });
    expect(t.status).toBe('blocked');
    expect((await store.getTransferDecrypted(t.id))?.payoutDestination).toBe(REAL);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
  });

  it("an EMPTY destination still mints (the pay page collects it) and still accrues, but never overwrites the sender's saved real account", async () => {
    const { store, partnerStore, mvs } = await makeStores();
    const at = yesterday();
    await seedSavedMom(store, at);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, payoutMethod: 'bank', payoutDestination: '' });
    expect(t.status).toBe('awaiting_payment');
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(1);
    const [saved] = await store.listRecipients('default', base.phone, 5);
    expect(saved.payoutDestination).toBe(REAL);
    expect(saved.lastUsedAt).toBe(at);
  });

  it("a B2B mint never writes the payee (a seller's profile account) into the sender's personal address book", async () => {
    const { store, partnerStore, mvs } = await makeStores();
    await createTransfer(store, partnerStore, mvs, {
      ...base, recipientName: 'Globex Trading LLC', payoutMethod: 'bank', payoutDestination: REAL,
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC',
    });
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/transfer-create.test.ts` → test 1 `promise resolved … instead of rejecting`; test 2 same; test 3 `expected '****9012' to be ''`; test 4 `expected 1 to be 0`; test 5 `expected '' to be 'HDFC0001234 123456789012'`; test 6 `expected [ { name: 'Globex Trading LLC', … } ] to deeply equal []`.

3. **Implement** — `src/lib/transfer-create.ts` (Task 9 edited `:2`, the quote type and the `if (input.quote)` arm — none of these anchors):
   - Imports, after `import { logWarn } from './log';`:
     ```ts
     import { isMaskedDestination } from './payout-format';
     import { isPartnerPulled } from './funding-method';
     ```
   - Directly above `export async function createTransfer(`:
     ```ts
     /**
      * fix 6 (ctx-01): thrown by createTransfer when the payout destination is a
      * display placeholder (payout-format.isMaskedDestination). NOTHING has been
      * written. The message is a constant and never carries the destination.
      */
     export class MaskedDestinationError extends Error {
       constructor() {
         super('masked_payout_destination');
         this.name = 'MaskedDestinationError';
       }
     }

     /**
      * fix 6: thrown when a partner-pulled funding method (ach_pull / bank_pull —
      * the LICENSED PARTNER debits the payer, so the pay route skips OUR capture)
      * is asked for on anything but a B2B transfer. NOTHING has been read or written.
      */
     export class PartnerPulledConsumerError extends Error {
       constructor() {
         super('partner_pulled_funding_requires_b2b');
         this.name = 'PartnerPulledConsumerError';
       }
     }
     ```
   - Directly after the kyc refusal (`if (requiresKyc && input.senderKycStatus !== 'verified') { throw new Error('kyc_required'); }`, `:137-140`):
     ```ts
       // fix 6: only a B2B bill payment may carry a partner-pulled funding method —
       // on a consumer transfer it would move money with no charge. Refuse before
       // any read or write (cron counts it as a failed run).
       if (isPartnerPulled(input.fundingMethod) && (input.transferType ?? 'b2c') !== 'b2b') {
         throw new PartnerPulledConsumerError();
       }
     ```
   - Replace the tail — from `await store.saveTransfer(transfer);` (`:232`) through its closing `return transfer;` (`:252`); the `transfer` literal and everything above it stay:

```ts
  // ── Blocked-row early return (fix 6 / ctx-01) ─────────────────────────────
  // complianceStatus is FINAL here (screenTransfer + the EDD merge above). A
  // watchlist hit is an auditable, never-charged, never-instructed row and
  // NOTHING else: no velocity / monthly accrual and no address-book write — the
  // contract recordBlockedAttempt (below) has always documented. Its destination
  // is evidence only, so a display placeholder is scrubbed to '' (a blocked row
  // is saved with an empty or a real destination, never a mask). It sits ABOVE
  // the placeholder refusal on purpose: sanctions always run and leave their row.
  if (complianceStatus === 'blocked') {
    const blockedRow: Transfer = isMaskedDestination(transfer.payoutDestination)
      ? { ...transfer, payoutDestination: '' }
      : transfer;
    await store.saveTransfer(blockedRow);
    return blockedRow;
  }

  // ── Placeholder refusal (fix 6 / ctx-01) ──────────────────────────────────
  // "****9012" / "account on file" is what a MASKED read renders, never an
  // account. Refuse BEFORE the insert, any counter and any recipient write. ''
  // is NOT refused: a cron, approve-tap, legacy or B2B ach_pull mint legitimately
  // starts with none; the pay route collects it and pay-finalize refuses a
  // bodyless '' on any draft but a B2B ach_pull one. (Task 10 later adds its cap
  // check between this refusal and the insert.)
  if (isMaskedDestination(transfer.payoutDestination)) {
    throw new MaskedDestinationError();
  }

  await store.saveTransfer(transfer);
  // (transfer count is now DERIVED from the ledger — no counter to bump)
  // Accruals and the address book are keyed by the transfer's TENANT (fix 1 /
  // F45, F47): a partner-API mint for a number can never touch another tenant's
  // saved destinations or compliance counters for that same number.
  await store.incrementTodayTransferCount(input.partnerId, input.phone);
  await monthlyVolumeStore.addCents(input.partnerId, input.phone, Math.round(transfer.amountUsd * 100));   // NEW (KYC)

  // Refresh the sender's PERSONAL address book only with a real consumer
  // destination (fix 6): a '' mint must never erase a saved account, and a B2B
  // payee's account (seller profile / partner-held) is never a personal payout.
  if (transfer.transferType !== 'b2b' && transfer.payoutDestination.trim() !== '') {
    try {
      await store.upsertRecipient(input.partnerId, input.phone, {
        name: input.recipientName,
        recipientPhone: input.recipientPhone,
        payoutMethod: input.payoutMethod,
        payoutDestination: transfer.payoutDestination,
        lastUsedAt: new Date().toISOString(),
      });
    } catch (err) {
      logWarn('transfer.upsert_recipient', err, { transferId: transfer.id });
    }
  }

  return transfer;
}
```

   - `recordBlockedAttempt` docblock (`:282-285`): `Unlike createTransfer's blocked branch, this writes ONLY the row:` → `Like createTransfer's blocked branch (early return since fix 6), this writes ONLY the row:`.

   **Callers** (`grep -rn "createTransfer(" src | grep -v "src/lib/transfer-create.ts"` → six):

   | Caller (bf4b083) | `PartnerPulledConsumerError` | `MaskedDestinationError` |
   |---|---|---|
   | `pay-finalize.ts:153` | refused pre-claim in Step 4 (`expired_or_used`) | refused pre-claim in Step 4 |
   | `tools.ts:1241` approve tap | mapped in Step 6 (pre-fix draft) | mapped in Step 6 (restores the draft) |
   | `tools.ts:1335` legacy | unreachable (closed set + B2B bill gate, Step 6) | unreachable (args never read) |
   | `cron-run.ts:80` | caught (`:100-102` → Task 9 `failed++` + `logError`); pinned in Step 7 | same |
   | `partner-api-service.ts:315` | unreachable (`fundingMethod: 'bank_transfer'`, `:324`) | pre-empted by the Step 7 edge refusal |
   | `b2b-pay-finalize.ts:205` | unreachable (`transferType: 'b2b'`) | impossible (validated profile payout) |

   Other direct suites (`recipient-store.test.ts:126-176`, `scoped-store.test.ts:64-72`, `customer-store.test.ts:96-190`, `transfer-create-gate.test.ts`, `tenant-boundary.test.ts`) use consumer `bank_transfer`/`credit_card` mints with real destinations; blocked cases assert status only.

4. **Run:** `npx vitest run tests/transfer-create.test.ts tests/transfer-create-gate.test.ts tests/recipient-store.test.ts tests/pay-finalize.test.ts tests/cron-run.test.ts tests/partner-api-service.test.ts tests/tenant-boundary.test.ts tests/b2b-crossborder-pay.test.ts` → green.

5. **Commit:** `fix(money-paths): createTransfer refuses a consumer partner-pulled mint and a masked destination, returns early for a blocked row, and only saves real consumer accounts (ctx-01)`

---

#### Step 4 — `finalizeDraftPayment` settles the destination BEFORE the claim (delta on Task 9; RED → GREEN)

1. **Failing tests** — `tests/pay-finalize.test.ts`: add after `import { freshDb, seedPartner } from './helpers-db';`:
   ```ts
   import { createIdempotencyRepo } from '@/db/repos/aux-repos';
   import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
   ```
   and append (`buildStores` `:17-27`, `makeDraft(stores, amountUsd, recipientName, payoutDestination, payoutMethod)` `:29-54`):

```ts
describe('fix 6 (ctx-01): the payout destination is settled BEFORE idem.claim — a refusal burns nothing', () => {
  const claimFor = (stores: Awaited<ReturnType<typeof buildStores>>, draftId: string) =>
    createIdempotencyRepo(stores.db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);

  async function verifiedDraft(
    stores: Awaited<ReturnType<typeof buildStores>>,
    over: Record<string, unknown>,
  ): Promise<string> {
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified' });
    return stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
      ...over,
    } as Parameters<typeof stores.draftStore.createDraft>[0]);
  }
  const b2bAchDraft = {
    recipient: { name: 'Globex Trading LLC', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
    amountUsd: 400, amountSource: 400, fundingMethod: 'ach_pull',
    quote: { feeUsd: 1.99, fxRate: 85, amountInr: 34000 },
    transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
    senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC', invoiceId: 'inv_u1',
  };

  it('a masked stored destination + a bodyless POST → bank_details_required: nothing minted, key NOT claimed, draft NOT consumed, no accrual', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '****9012', 'bank');
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'bank_details_required' });
    expect(await stores.store.listTransfers()).toHaveLength(0);
    expect(await claimFor(stores, draftId)).toBeNull();
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.dailyVolumeStore.getTodayCents('default', PHONE)).toBe(0);
  });

  it('the SAME link then finalizes with real bank details — the claim binds only now; ledger and address book hold the real account', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '****9012', 'bank');
    await finalizeDraftPayment(stores, draftId);
    const result = await finalizeDraftPayment(stores, draftId, {
      payoutMethod: 'bank', payoutDestination: '021000021 12345678901',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(await claimFor(stores, draftId)).toBe(result.transferId);
    expect((await stores.store.getTransferDecrypted(result.transferId))?.payoutDestination).toBe('021000021 12345678901');
    expect(await stores.draftStore.getDraft(draftId)).toBeNull();
    const [rec] = await stores.store.listRecipients('default', PHONE, 1);
    expect(rec.payoutDestination).toBe('021000021 12345678901');
  });

  it("BEHAVIOUR CHANGE: a consumer cold-start draft ('' destination) with a bodyless POST is refused", async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '', 'bank');
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'bank_details_required' });
    expect(await claimFor(stores, draftId)).toBeNull();
  });

  it('a masked value in the BODY is refused too (defence in depth)', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);
    expect(await finalizeDraftPayment(stores, draftId, { payoutMethod: 'bank', payoutDestination: '****9012' }))
      .toEqual({ ok: false, error: 'bank_details_required' });
    expect(await claimFor(stores, draftId)).toBeNull();
  });

  it("the '' exemption keys on the DRAFT'S shape: a CONSUMER draft carrying a partner-pulled method is dead (expired_or_used) even with a body; a B2B bank_pull draft is refused", async () => {
    for (const fundingMethod of ['bank_pull', 'ach_pull']) {
      const stores = await buildStores();
      const draftId = await verifiedDraft(stores, { fundingMethod });
      expect(await finalizeDraftPayment(stores, draftId, { payoutMethod: 'bank', payoutDestination: '021000021 12345678901' }), fundingMethod)
        .toEqual({ ok: false, error: 'expired_or_used' });
      expect(await claimFor(stores, draftId)).toBeNull();
      expect(await stores.store.listTransfers()).toHaveLength(0);
    }
    const stores = await buildStores();
    const draftId = await verifiedDraft(stores, { ...b2bAchDraft, fundingMethod: 'bank_pull' });
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'bank_details_required' });
  });

  it("a B2B ach_pull draft mints with NO destination, and a body NEVER sets its payee (the payee is never payer input)", async () => {
    // Separate stores per mint: two $400 bills in one day would trip the T0 $500 cap.
    const s1 = await buildStores();
    const plain = await verifiedDraft(s1, b2bAchDraft);
    const r1 = await finalizeDraftPayment(s1, plain);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unexpected');
    expect((await s1.store.getTransferDecrypted(r1.transferId))?.payoutDestination).toBe('');
    const s2 = await buildStores();
    const crafted = await verifiedDraft(s2, b2bAchDraft);
    const r2 = await finalizeDraftPayment(s2, crafted, { payoutMethod: 'bank', payoutDestination: '999999999999 SBIN0009999' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unexpected');
    expect((await s2.store.getTransferDecrypted(r2.transferId))?.payoutDestination).toBe('');
  });

  it('guard order (ruling 7): an unverified sender with a masked draft gets kyc_required — the kyc gate runs first', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '****9012', 'bank');
    const dflt = await stores.partnerStore.ensureDefaultPartner();
    await stores.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const c = await stores.customerStore.getCustomer('default', PHONE);
    await stores.customerStore.saveCustomer({ ...c!, kycStatus: 'grandfathered' });
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'kyc_required' });
    expect(await claimFor(stores, draftId)).toBeNull();
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/pay-finalize.test.ts` → tests 1, 3, 4 `expected { ok: true, … } to deeply equal { ok: false, error: 'bank_details_required' }`; test 2 `expected '****9012' to be '021000021 12345678901'`; test 5 `expected { ok: true, … } to deeply equal { ok: false, error: 'expired_or_used' }` (on main a consumer `bank_pull` draft mints and is never captured); test 6 fails on `r2` (`expected '999999999999 SBIN0009999' to be ''` — on main the payer sets the B2B payee); test 7 passes (lock).

3. **Implement** — `src/lib/pay-finalize.ts`, a **delta on Task 9**:
   - Imports (after `import { newTransferId } from './id';`):
     ```ts
     import { isMaskedDestination } from './payout-format';
     import { isPartnerPulled } from './funding-method';
     ```
   - `FinalizeResult`: **append** one arm to Task 9's union (never drop `'fx_unavailable'`):
     ```ts
     export type FinalizeResult =
       | { ok: true; transferId: string }
       | {
           ok: false;
           // 'bank_details_required' (fix 6 / ctx-01): the resolved payout destination
           // is a masked placeholder, or '' on anything but a B2B ach_pull draft.
           // Nothing was claimed or consumed; the route answers 400. Never a 500.
           error: 'expired_or_used' | 'cap' | 'blocked' | 'kyc_required' | 'fx_unavailable' | 'bank_details_required';
           transferId?: string;
         };
     ```
   - Insert **directly ABOVE the line `// [fix 6 inserts above this line]`** and leave the marker in place — in Task 9's words (Interfaces, `wave2/task-09.md:65`): "Task 6 inserts its masked-destination block directly above it; Task 10 anchors on the same marker line and places its cap check after this FX block, before `idem.claim`". Declare no `idem` here (Task 9's FX block creates it):

```ts
  // ── fix 6 (ctx-01): resolve the payout destination BEFORE the claim ───────
  // Ruling 7 guard order, all ABOVE idem.claim: kyc → THIS → FX (Task 9) → cap
  // (Task 10) → idem.claim. A refusal leaves the single-use draft AND its
  // draft:<draftId> key untouched. Pure function of (draft, body).
  //
  // A CONSUMER draft carrying a partner-pulled method (ach_pull / bank_pull —
  // only a pre-fix model argument could create one) would never be charged:
  // it is dead, never minted (createTransfer refuses it too).
  if (isPartnerPulled(draft.fundingMethod) && draft.transferType !== 'b2b') {
    return { ok: false, error: 'expired_or_used' };
  }
  //   body → route.ts composed it from validated, country-bound fields; it also
  //          REPLACES a stored destination (the page's "Edit bank details") —
  //          on a CONSUMER draft only: a B2B payee is never payer input.
  //   none → the draft's stored destination, used ONLY when it is a real account.
  //          '' ("the pay page must collect it") is refused except on a B2B
  //          ach_pull draft, whose pay form collects only the payer's debit
  //          mandate (the licensed partner pays the payee on its own records).
  const bodyDestination =
    draft.transferType === 'b2b' ? '' : (bankDetails?.payoutDestination ?? '').trim();
  const payoutDestination =
    bodyDestination !== '' ? bodyDestination : (draft.recipient.payoutDestination ?? '').trim();
  const b2bAchPull = draft.transferType === 'b2b' && draft.fundingMethod === 'ach_pull';
  if (isMaskedDestination(payoutDestination) || (payoutDestination === '' && !b2bAchPull)) {
    return { ok: false, error: 'bank_details_required' };
  }
  const payoutMethod =
    bodyDestination !== '' && bankDetails?.payoutMethod
      ? bankDetails.payoutMethod
      : draft.recipient.payoutMethod;
```

   - **Delete** the old post-claim block by content: from `// Item 2: the recipient's bank details are entered on the secure pay page and` through `: draft.recipient.payoutMethod;` (`:123-134` on bf4b083; untouched by Task 9).
   - Docblocks by content: `BankDetails` (`:17-21`) `→ fall back to the draft's stored destination (covers old in-flight drafts during the TTL drain).` → `→ fall back to the draft's stored destination, used only when it is a real account (fix 6: a placeholder, or '' on anything but a B2B ach_pull draft, answers bank_details_required; a B2B draft ignores the body).`; `finalizeDraftPayment`'s order sentence → `peek → kyc → payout destination (fix 6) → FX (Task 9) → cap → CLAIM-FIRST mint → consume → accruals`.
   - **Replay note:** this block sits above Task 9's `alreadyMinted` skip, so a *bodyless* re-POST of a draft that already minted (crash after mint, before `consumeDraft`) with an unusable stored destination answers `bank_details_required`; the page re-renders Step 1 and the re-submit reaches the claim, which replays the minted transfer (the body is ignored — the mint already happened). No second mint is possible.

   **Callers of the widened union:** `grep -rn "finalizeDraftPayment(" src` → `route.ts:444` only (Step 5). Pre-existing tests stay green: `'mom@upi'` fallbacks (`:185-213`), the B2B body test (`:466-500`, `ach_pull` + `b2b` — asserts discriminators/invoice, not the destination), claim-first replays (`:218-265`), Task 9's FX tests (`'mom@upi'` drafts).

4. **Run:** `npx vitest run tests/pay-finalize.test.ts && npx tsc --noEmit` → green (tsc after Step 5).

5. **Commit:** `fix(money-paths): pay-finalize settles the payout destination before the claim; a B2B payee is never payer input (ctx-01)`

---

#### Step 5 — Guarded payout write (repo) + pay route and page (delta on Task 9; RED → GREEN)

**5a — repo methods.**

1. **Failing tests** — append to `tests/transfer-repo.test.ts` (harness `:1-45`: `fixture()`, `repo = createTransferRepo(db, provider)`); add imports `import { createAuditRepo, createIdempotencyRepo } from '@/db/repos/aux-repos';`:

```ts
describe('transfer-repo — fix 6 (ctx-01): guarded payout write + rehydration probes', () => {
  const NEW = { payoutMethod: 'bank' as const, payoutDestination: '987654321098 SBIN0001234' };

  it('setPayoutIfEditable writes ONLY the payout columns — the encrypted legal name, EDD fields and status survive', async () => {
    await repo.saveTransfer(fixture({ recipientLegalName: 'Mother Legal Name', relationship: 'parent', purpose: 'family_support' }));
    const updated = await repo.setPayoutIfEditable('tr_1', 'default', NEW);
    expect(updated?.status).toBe('awaiting_payment');
    const full = await repo.getTransfer('tr_1', { decrypt: true });
    expect(full?.payoutDestination).toBe(NEW.payoutDestination);
    expect(full?.recipientLegalName).toBe('Mother Legal Name');
    expect(full?.relationship).toBe('parent');
    expect(full?.purpose).toBe('family_support');
  });

  it('refuses (null, row untouched) for a paid / in_review / charged / B2B / other-tenant / partner-API row', async () => {
    await seedPartner(db, 'acme');
    const cases: Array<[string, Partial<Transfer>]> = [
      ['p_paid', { status: 'paid' }],
      ['p_review', { status: 'in_review' }],
      ['p_charged', { fundingRef: 'mockfund-p_charged' }],
      ['p_b2b', { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }],
      ['p_acme', { partnerId: 'acme' }],
      ['p_api', {}],
      ['p_api_audit', {}],
    ];
    for (const [id, over] of cases) await repo.saveTransfer(fixture({ id, ...over }));
    await createIdempotencyRepo(db).claim('default', 'order-8841', 'p_api');          // a partner-API claim
    await createAuditRepo(db).record({ partnerId: 'default', actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: 'p_api_audit' });
    for (const [id] of cases) {
      expect(await repo.setPayoutIfEditable(id, 'default', NEW), id).toBeNull();
      expect(await repo.isPayoutEditable(id, 'default'), id).toBe(false);
      expect((await repo.getTransfer(id, { decrypt: true }))?.payoutDestination, id).toBe('123456789012|HDFC0001234');
    }
  });

  it('a pay-page draft claim (draft:<id> under default) does NOT lock the payout', async () => {
    await repo.saveTransfer(fixture({ id: 'p_draft' }));
    await createIdempotencyRepo(db).claim('default', 'draft:d_1', 'p_draft');
    expect(await repo.isPayoutEditable('p_draft', 'default')).toBe(true);
    expect((await repo.setPayoutIfEditable('p_draft', 'default', NEW))?.id).toBe('p_draft');
  });

  it('hasB2bTransferTo is an exact (tenant, sender, recipient, b2b) probe', async () => {
    await repo.saveTransfer(fixture({ id: 'b_1', transferType: 'b2b', recipientPhone: '919822222222' }));
    expect(await repo.hasB2bTransferTo('default', '15551230000', '919822222222')).toBe(true);
    expect(await repo.hasB2bTransferTo('default', '15551230000', '919876543210')).toBe(false);
    expect(await repo.hasB2bTransferTo('acme', '15551230000', '919822222222')).toBe(false);
  });

  it('latestSettledConsumerTo returns the newest paid/delivered b2c row in the destination country, DECRYPTED', async () => {
    await repo.saveTransfer(fixture({ id: 's_old', status: 'delivered', createdAt: '2026-06-01T00:00:00.000Z', payoutDestination: 'OLD 111111111111' }));
    await repo.saveTransfer(fixture({ id: 's_new', status: 'paid', createdAt: '2026-06-05T00:00:00.000Z', payoutDestination: 'NEW 222222222222' }));
    await repo.saveTransfer(fixture({ id: 's_await', status: 'awaiting_payment', createdAt: '2026-06-09T00:00:00.000Z' }));
    await repo.saveTransfer(fixture({ id: 's_gb', status: 'delivered', createdAt: '2026-06-10T00:00:00.000Z', destinationCountry: 'GB', destinationCurrency: 'GBP' }));
    const hit = await repo.latestSettledConsumerTo('default', '15551230000', '919876543210', 'IN');
    expect(hit?.id).toBe('s_new');
    expect(hit?.payoutDestination).toBe('NEW 222222222222');
    expect(await repo.latestSettledConsumerTo('default', '15551230000', '919876543210', 'AE')).toBeNull();
  });

  it('setAchTokenIfAbsent writes ONLY ach_token_ref, once, on an awaiting B2B row of this tenant — the legal name and status survive', async () => {
    const b2b = { transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business', fundingMethod: 'ach_pull' } as const;
    await repo.saveTransfer(fixture({ id: 'a_1', ...b2b, recipientLegalName: 'Globex Trading Private Limited' }));
    await repo.saveTransfer(fixture({ id: 'a_paid', ...b2b, status: 'paid' }));
    await repo.saveTransfer(fixture({ id: 'a_b2c' }));
    expect(await repo.setAchTokenIfAbsent('a_1', 'acme', 'ach_x')).toBeNull();                        // other tenant
    expect((await repo.setAchTokenIfAbsent('a_1', 'default', 'ach_first'))?.achTokenRef).toBe('ach_first');
    expect(await repo.setAchTokenIfAbsent('a_1', 'default', 'ach_second')).toBeNull();                // the FIRST mandate is kept
    const full = await repo.getTransfer('a_1', { decrypt: true });
    expect(full?.achTokenRef).toBe('ach_first');
    expect(full?.recipientLegalName).toBe('Globex Trading Private Limited');
    expect(full?.status).toBe('awaiting_payment');
    expect(await repo.setAchTokenIfAbsent('a_paid', 'default', 'ach_x')).toBeNull();                  // moved on — untouched
    expect((await repo.getTransfer('a_paid'))?.achTokenRef).toBeUndefined();
    expect((await repo.getTransfer('a_paid'))?.status).toBe('paid');
    expect(await repo.setAchTokenIfAbsent('a_b2c', 'default', 'ach_x')).toBeNull();                   // a consumer row never carries a mandate
  });
});
```

   (The `createdAt` literals order rows only — they interact with no time window.)

2. **Run, expect failure:** `npx vitest run tests/transfer-repo.test.ts` → `TypeError: repo.setPayoutIfEditable is not a function` (and the siblings, incl. `repo.setAchTokenIfAbsent`).

3. **Implement** — `src/db/repos/transfer-repo.ts`:
   - Imports: `import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';`; `import { auditEvents, idempotencyKeys, transfers } from '@/db/schema';`; `import { defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';`; `import { last4, rowToTransfer, transferToRow, type TransferRow } from './mappers';`; `import { DEFAULT_PARTNER_ID } from '@/lib/defaults';`; extend the types import with `CountryCode, PayoutMethod`.
   - Inside `createTransferRepo`, directly after `const toDomain = …;`:

```ts
  // fix 6 (ctx-01): the pay page may write a transfer's payout ONLY while every
  // one of these holds — evaluated INSIDE the UPDATE, so a concurrent charge /
  // settle / hold (the OTP verify is get→compare→del, not atomic —
  // transaction-otp.ts:59-83 — so two POSTs can pass on one code) can never be
  // reverted or overwritten. Not minted through the partner API: a partner-API
  // mint binds its Idempotency-Key claim-first (partner-api-service.ts:295) and
  // records a transaction.create audit event by an api_key (:340); pay-page
  // drafts claim 'draft:<id>' under the default tenant (pay-finalize.ts:110) —
  // a prefix the partner API refuses at its edge (createTransaction, fix 6), so
  // a 'draft:' key under default is never a partner claim. ('b2binvoice:<id>'
  // claims need no exemption: those mints are always transfer_type 'b2b',
  // b2b-pay-finalize.ts:236, and fail the b2c test above.) Either partner-API
  // marker locks the payout the partner supplied.
  const payoutEditable = (id: string, partnerId: PartnerId) =>
    and(
      eq(transfers.id, id),
      eq(transfers.partnerId, partnerId),
      eq(transfers.status, 'awaiting_payment'),
      isNull(transfers.fundingRef),
      eq(transfers.transferType, 'b2c'),
      sql`NOT EXISTS (SELECT 1 FROM ${idempotencyKeys} WHERE ${idempotencyKeys.transferId} = ${transfers.id} AND NOT (${idempotencyKeys.partnerId} = ${DEFAULT_PARTNER_ID} AND ${idempotencyKeys.key} LIKE 'draft:%'))`,
      sql`NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.subjectId} = ${transfers.id} AND ${auditEvents.action} = 'transaction.create' AND ${auditEvents.actorType} = 'api_key')`,
    );
```

   (`${transfers.id}` inside `sql` renders the qualified `"transfers"."id"` and a table renders its name — `node_modules/drizzle-orm/sql/sql.js:118-127`.)
   - Add to the returned object (e.g. after `updateIfStatus`, `:371-382`):

```ts
    /** fix 6: may the pay page write this transfer's payout? (the same guard setPayoutIfEditable applies) */
    async isPayoutEditable(id: string, partnerId: PartnerId): Promise<boolean> {
      const rows = await db.select({ id: transfers.id }).from(transfers).where(payoutEditable(id, partnerId)).limit(1);
      return rows.length > 0;
    },

    /**
     * fix 6: the pay page's ONLY payout write on an existing transfer. Sets
     * payout_method, payout_destination_enc and payout_destination_last4 and
     * NOTHING else — never a whole-row upsert from a masked read (transferToRow
     * would write recipient_legal_name_enc = NULL, mappers.ts:99, and rewrite
     * status/funding columns from a stale read). Returns the updated (masked)
     * row, or null when any guard failed — the caller reports current truth.
     */
    async setPayoutIfEditable(
      id: string,
      partnerId: PartnerId,
      payout: { payoutMethod: PayoutMethod; payoutDestination: string },
    ): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({
          payoutMethod: payout.payoutMethod,
          payoutDestinationEnc: payout.payoutDestination ? encryptField(payout.payoutDestination, provider) : '',
          payoutDestinationLast4: last4(payout.payoutDestination),
        })
        .where(payoutEditable(id, partnerId))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * fix 6: the pay route's ONLY ACH-mandate write. Sets ach_token_ref and
     * NOTHING else, only while the row is this tenant's awaiting_payment B2B
     * transfer with no token yet — replacing the route's whole-row
     * saveTransfer of a masked read (route.ts:398, :482 on bf4b083), which wrote
     * recipient_legal_name_enc = NULL (mappers.ts:99) and rewrote status from a
     * stale read (a concurrent POST's paid flip reverted → settled twice).
     * Null ⇒ a guard failed; the caller re-reads and reports current truth.
     */
    async setAchTokenIfAbsent(id: string, partnerId: PartnerId, token: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ achTokenRef: token })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.partnerId, partnerId),
          eq(transfers.status, 'awaiting_payment'),
          eq(transfers.transferType, 'b2b'),
          or(isNull(transfers.achTokenRef), eq(transfers.achTokenRef, '')),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /** fix 6: does this sender have ANY B2B transfer to this number? (tenant-scoped, one probe) */
    async hasB2bTransferTo(partnerId: PartnerId, phone: string, recipientPhone: string): Promise<boolean> {
      const rows = await db
        .select({ id: transfers.id })
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          eq(transfers.recipientPhone, recipientPhone),
          eq(transfers.transferType, 'b2b'),
        ))
        .limit(1);
      return rows.length > 0;
    },

    /** fix 6: the sender's newest SETTLED consumer transfer to this number in this country — DECRYPTED (rehydration only). */
    async latestSettledConsumerTo(
      partnerId: PartnerId,
      phone: string,
      recipientPhone: string,
      destinationCountry: CountryCode,
    ): Promise<Transfer | null> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          eq(transfers.recipientPhone, recipientPhone),
          eq(transfers.transferType, 'b2c'),
          inArray(transfers.status, ['paid', 'delivered']),
          eq(transfers.destinationCountry, destinationCountry),
        ))
        .orderBy(desc(transfers.createdAt))
        .limit(1);
      return rows[0] ? toDomain(rows[0], true) : null;
    },
```

   - `src/lib/store.ts`: extend `import type { ChatMessage, PartnerId, Transfer, TransferStatus } from './types';` with `CountryCode`; add after `firstTransferAt` (`:150-153`):
     ```ts
         /** fix 6: EXISTS a B2B transfer from this sender to this number (tenant-scoped). */
         async hasB2bTransferTo(partnerId: PartnerId, phone: string, recipientPhone: string): Promise<boolean> {
           return transfersRepo.hasB2bTransferTo(partnerId, phone, recipientPhone);
         },
         /** fix 6: DECRYPTED newest settled consumer transfer to this number in this country (rehydration only). */
         async latestSettledConsumerTransferTo(
           partnerId: PartnerId,
           phone: string,
           recipientPhone: string,
           destinationCountry: CountryCode,
         ): Promise<Transfer | null> {
           return transfersRepo.latestSettledConsumerTo(partnerId, phone, recipientPhone, destinationCountry);
         },
     ```
     (Store fakes in tests are `as unknown as Store` — `tests/recent-transfers.test.ts:43`, `account-verify-action.test.ts:47` — and `webThreadStore` spreads `...base`, `web-chat.ts:33-40`; nothing else implements `Store`.)

4. **Run:** `npx vitest run tests/transfer-repo.test.ts tests/store.test.ts tests/pg-repos.test.ts` → green.

**5b — route + page.**

1. **Failing tests.**

   (a) Append to `tests/pay-route-bank-details.test.ts` (`makeTransfer` `:90-100`, `post` `:102-110`, `status` `:127`); add imports `import { createIdempotencyRepo } from '@/db/repos/aux-repos';`:

```ts
describe('pay route — existing-transfer payout writes (fix 6 / ctx-01)', () => {
  const EDIT = { country: 'IN', fields: { accountNumber: '987654321098', ifsc: 'SBIN0001234' } };

  it('a masked stored destination is treated as NO destination: bodyless → 400, never charged, row untouched', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm1', payoutDestination: '****9012' }));
    expect((await store.getTransfer('m1'))?.payoutDestination).toBe('****9012');
    expect((await post('m1')).status).toBe(400);
    expect(await status('m1')).toBe('awaiting_payment');
    expect((await store.getTransferDecrypted('m1'))?.payoutDestination).toBe('****9012');
  });

  it('the same row + a VALID body → the real destination replaces the mask, then it charges', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm2', payoutDestination: '****9012' }));
    const res = await post('m2', { country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(200);
    expect(await status('m2')).toBe('paid');
    expect((await store.getTransferDecrypted('m2'))?.payoutDestination).toContain('123456789012');
  });

  it("a row poisoned with '****' (default read '********') also needs bank details", async () => {
    await store.saveTransfer(makeTransfer({ id: 'm3', payoutDestination: '****' }));
    expect((await post('m3')).status).toBe(400);
  });

  it('Edit bank details REPLACES a real stored destination on a consumer row — and the encrypted legal name survives (no whole-row re-save)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e1', payoutDestination: '123456789 HDFC0001234', recipientLegalName: 'Mother Legal Name' }));
    const res = await post('e1', EDIT);
    expect(res.status).toBe(200);
    expect(await status('e1')).toBe('paid');
    const full = await store.getTransferDecrypted('e1');
    expect(full?.payoutDestination).toContain('987654321098');
    expect(full?.recipientLegalName).toBe('Mother Legal Name');
    const audit = (await db.execute(sql`SELECT action, subject_id, meta FROM audit_events WHERE subject_id = 'e1'`)) as unknown as { rows: Array<{ action: string; meta: { last4: string } }> };
    expect(audit.rows.map((r) => r.action)).toContain('transfer.payout_edit');
    expect(JSON.stringify(audit.rows)).not.toContain('987654321098');
  });

  it('a CHARGED awaiting row (fundingRef set) is never edited: 409, destination unchanged', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e2', payoutDestination: '123456789 HDFC0001234', fundingRef: 'mockfund-e2' }));
    const res = await post('e2', EDIT);
    expect(res.status).toBe(409);
    expect((await store.getTransferDecrypted('e2'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it('RACE: a concurrent no-body POST settles the row between our read and the Edit write → current truth, never reverted', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e3', payoutDestination: '123456789 HDFC0001234' }));
    const realDecrypt = store.getTransferDecrypted.bind(store);
    vi.spyOn(store, 'getTransferDecrypted').mockImplementationOnce(async (id: string) => {
      const before = await realDecrypt(id);
      await store.updateTransferFromWebhook(id, 'paid'); // the other POST won
      return before;
    });
    const res = await post('e3', EDIT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });
    expect(await status('e3')).toBe('paid');
    expect((await store.getTransferDecrypted('e3'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it('RACE: a concurrent hold (in_review) is never reverted to awaiting_payment by an Edit', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e4', payoutDestination: '123456789 HDFC0001234' }));
    const realDecrypt = store.getTransferDecrypted.bind(store);
    vi.spyOn(store, 'getTransferDecrypted').mockImplementationOnce(async (id: string) => {
      const before = await realDecrypt(id);
      await store.updateTransferIfStatus(id, 'awaiting_payment', { status: 'in_review' });
      return before;
    });
    const res = await post('e4', EDIT);
    expect(await res.json()).toMatchObject({ ok: true, status: 'in_review' });
    expect(await status('e4')).toBe('in_review');
    expect((await store.getTransferDecrypted('e4'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it("a PARTNER-API-minted row's beneficiary is never payer-editable: 409, unchanged", async () => {
    await store.saveTransfer(makeTransfer({ id: 'e5', payoutDestination: '123456789 HDFC0001234' }));
    await createIdempotencyRepo(db).claim('default', 'order-8841', 'e5');
    const res = await post('e5', EDIT);
    expect(res.status).toBe(409);
    expect((await store.getTransferDecrypted('e5'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it("a body NEVER touches a B2B transfer's payee: its stored destination is kept and it settles as before", async () => {
    await store.saveTransfer(makeTransfer({
      id: 'e6', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      fundingMethod: 'bank_pull', payoutDestination: '123456789 HDFC0001234',
    }));
    expect((await post('e6', EDIT)).status).toBe(200);
    expect((await store.getTransferDecrypted('e6'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it("the body's country must be the payment's own destination country; a CONSUMER row carrying a partner-pulled method is refused outright", async () => {
    await store.saveTransfer(makeTransfer({ id: 'c1', payoutDestination: '' }));
    const res = await post('c1', { country: 'GB', fields: { accountNumber: '12345678', sortCode: '123456' } });
    expect(res.status).toBe(400);
    expect((await store.getTransferDecrypted('c1'))?.payoutDestination).toBe('');
    await store.saveTransfer(makeTransfer({ id: 'c2', payoutDestination: '123456789 HDFC0001234', fundingMethod: 'bank_pull' }));
    expect((await post('c2')).status).toBe(400);
    expect(await status('c2')).toBe('awaiting_payment'); // never charged, never instructed
  });

  it('an HK or MX consumer row accepts its own country\'s bank form (the route knows every CountryCode)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'hk1', destinationCountry: 'HK', destinationCurrency: 'HKD' }));
    expect((await post('hk1', { country: 'HK', fields: { bankCode: '004', branchCode: '123', accountNumber: '123456789' } })).status).toBe(200);
    expect(await status('hk1')).toBe('paid');
    expect((await store.getTransferDecrypted('hk1'))?.payoutDestination).toBe('004 123 123456789');
    await store.saveTransfer(makeTransfer({ id: 'mx1', destinationCountry: 'MX', destinationCurrency: 'MXN' }));
    expect((await post('mx1', { country: 'MX', fields: { clabe: '012345678901234567' } })).status).toBe(200);
    expect(await status('mx1')).toBe('paid');
    expect((await store.getTransferDecrypted('mx1'))?.payoutDestination).toBe('012345678901234567');
  });
});
```

   (`sql` — add `import { sql } from 'drizzle-orm';` to the file's imports; `vi` is already imported.)

   (b) Create `tests/pay-route-masked-draft.test.ts`:

```ts
/**
 * fix 6 (ctx-01) at the HTTP boundary, DRAFT branch. Every other pay-route suite
 * mocks getDraft → null; this one drives the real finalizeDraftPayment through
 * the route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Draft } from '@/lib/types';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => ({ ok: true }),
  }),
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let draftStore: ReturnType<typeof createDraftStore>;
let dailyVolumeStore: ReturnType<typeof createDailyVolumeStore>;
let monthlyVolumeStore: ReturnType<typeof createMonthlyVolumeStore>;

vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});
vi.mock('@/lib/draft-store', async (orig) => {
  const real = await orig<typeof import('@/lib/draft-store')>();
  return { ...real, getDraftStore: () => draftStore };
});
vi.mock('@/lib/daily-volume-store', async (orig) => {
  const real = await orig<typeof import('@/lib/daily-volume-store')>();
  return { ...real, getDailyVolumeStore: () => dailyVolumeStore };
});
vi.mock('@/lib/monthly-volume-store', async (orig) => {
  const real = await orig<typeof import('@/lib/monthly-volume-store')>();
  return { ...real, getMonthlyVolumeStore: () => monthlyVolumeStore };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';

function post(id: string, body?: unknown): Promise<Response> {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

function makeDraftWith(dest: string, over: Partial<Draft> = {}): Promise<string> {
  return draftStore.createDraft({
    senderPhone: PHONE,
    partnerId: 'default',
    recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: dest },
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000, feeSource: 0, totalChargeSource: 200, totalChargeUsd: 200 },
    ...over,
  });
}
const minted = (draftId: string) => createIdempotencyRepo(db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);

beforeEach(async () => {
  db = await freshDb();
  const redis = fakeRedis();
  store = createStore(redis, db);
  customerStore = createCustomerStore(db, store);
  draftStore = createDraftStore(redis);
  dailyVolumeStore = createDailyVolumeStore(redis);
  monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  });
});

describe('POST /api/pay/<draftId> — fix 6 (ctx-01)', () => {
  it('a bodyless POST on a masked draft answers 400 bank_details_required and mutates nothing', async () => {
    const draftId = await makeDraftWith('****9012');
    const res = await post(draftId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason?: string; error?: string };
    expect(body.reason).toBe('bank_details_required');
    expect(body.error ?? '').not.toContain('9012');
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await minted(draftId)).toBeNull();
    expect(await draftStore.getDraft(draftId)).not.toBeNull();
  });

  it('the same link then finalizes and charges once real fields are posted', async () => {
    const draftId = await makeDraftWith('****9012');
    expect((await post(draftId)).status).toBe(400);
    const res = await post(draftId, { country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(200);
    const full = await store.getTransferDecrypted((await minted(draftId))!);
    expect(full?.payoutDestination).toContain('123456789012');
    expect(full?.status).toBe('paid');
  });

  it('Edit bank details on a PREFILLED consumer draft: posted fields replace the rehydrated destination', async () => {
    const draftId = await makeDraftWith('HDFC0001234 123456789012');
    expect((await post(draftId, { country: 'IN', fields: { accountNumber: '987654321098', ifsc: 'SBIN0001234' } })).status).toBe(200);
    expect((await store.getTransferDecrypted((await minted(draftId))!))?.payoutDestination).toContain('987654321098');
  });

  it('a crafted {ach, country, fields} POST on a B2B ach_pull draft NEVER sets the payee: minted with no destination, mandate bound', async () => {
    const draftId = await makeDraftWith('', {
      recipient: { name: 'Globex Trading LLC', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 400, amountSource: 400, fundingMethod: 'ach_pull',
      quote: { feeUsd: 1.99, fxRate: 85, amountInr: 34000 },
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC', invoiceId: 'inv_u1',
    });
    const res = await post(draftId, {
      ach: { routingNumber: '021000021', accountNumber: '1234567890', accountType: 'checking' },
      country: 'IN', fields: { accountNumber: '999999999999', ifsc: 'SBIN0009999' },
    });
    expect(res.status).toBe(200);
    const full = await store.getTransferDecrypted((await minted(draftId))!);
    expect(full?.payoutDestination).toBe('');
    expect(full?.achTokenRef).toMatch(/^ach_[0-9a-f]+$/);
  });
});
```

   (c) Append to `tests/pay-route-ach-pull.test.ts` (`makeB2bTransfer` `:128-141`, `postAch` `:143-152`, `outboxCount` `:154-159`, `capture` spy `:92`, the module-level `customerStore` returned by the `getCustomerStore` mock `:67-70` — `getCustomer` is a plain method, `customer-repo.ts:181-182`; `sql`, `vi` already imported):

```ts
describe('pay route — the ACH mandate bind is one guarded column write (fix 6 / ctx-01)', () => {
  it('binding the mandate writes ONLY ach_token_ref: the encrypted legal name survives the masked read', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'bl1', recipientLegalName: 'Acme Supplies Private Limited' }));
    const res = await postAch('bl1');
    expect(res.status).toBe(200);
    const full = await store.getTransferDecrypted('bl1');
    expect(full?.status).toBe('paid');
    expect(full?.achTokenRef).toMatch(/^ach_[0-9a-f]+$/);
    expect(full?.recipientLegalName).toBe('Acme Supplies Private Limited');
  });

  it('RACE: a concurrent POST binds its mandate and settles between our read and our bind → current truth; never reverted, never settled twice', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'bl2' }));
    const realGetCustomer = customerStore.getCustomer.bind(customerStore);
    // getCustomer runs after the route's transfer read and before the bind (route.ts:361 on bf4b083).
    vi.spyOn(customerStore, 'getCustomer').mockImplementationOnce(async (...a: Parameters<typeof customerStore.getCustomer>) => {
      await db.execute(sql`UPDATE transfers SET status = 'paid', ach_token_ref = 'ach_first' WHERE id = 'bl2'`); // the other POST won
      return realGetCustomer(...a);
    });
    const res = await postAch('bl2');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });
    const row = await store.getTransfer('bl2');
    expect(row?.status).toBe('paid');
    expect(row?.achTokenRef).toBe('ach_first');
    expect(await outboxCount()).toBe(0); // no second settlement enqueued
    expect(capture).not.toHaveBeenCalled();
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/pay-route-bank-details.test.ts tests/pay-route-masked-draft.test.ts tests/pay-route-ach-pull.test.ts` → (a) `m1`/`m3` `expected 200 to be 400`; `m2` passes only after the write fix (`expected '****9012'…` on main — main ignores a body once "a destination is set"); `e1` `expected '123456789 HDFC0001234' to contain '987654321098'`; `e2`/`e5` `expected 200 to be 409` (main charges and ignores the body); the two RACE tests fail on the destination/status asserts only if the write path is a re-save (they pin the guard); `e6` passes (lock); `c1` `expected 200 to be 400`, `c2` `expected 200 to be 400` (main never captures a consumer `bank_pull` row and settles it). (b) test 1 `expected undefined to be 'bank_details_required'` after Step 4 (`expected 200 to be 400` before); test 4 fails on main with the payer's account as the payee. `hk1`/`mx1` `expected 400 to be 200` (main drops an HK/MX `country`). (c) `bl1` `expected undefined to be 'Acme Supplies Private Limited'` (main's whole-row re-save writes the legal name as NULL); `bl2` `expected 'ach_…' to be 'ach_first'` and `expected <n> to be 0` (main re-saves the stale read — status back to `awaiting_payment`, token overwritten — then settles again).

3. **Implement.**

   **`src/app/api/pay/[transferId]/route.ts`**
   - Imports: extend `:23` → `import { validatePayoutFields, BANK_FIELDS_BY_COUNTRY, isMaskedDestination, accountLast4 } from '@/lib/payout-format';`; add `import { createAuditRepo } from '@/db/repos/aux-repos';` and `import { DEFAULT_DESTINATION_COUNTRY } from '@/lib/defaults';`.
   - Add after `refuseUnlessAwaiting` (ends `:70`):

```ts
/**
 * fix 6 (ctx-01): the pay page's ONLY payout write on an existing transfer — one
 * transaction: the guarded, column-targeted UPDATE (transfer-repo
 * setPayoutIfEditable: awaiting_payment, uncharged, consumer, this tenant, not
 * partner-API-minted) + a `transfer.payout_edit` audit row carrying the id and
 * last-4 only. Returns the updated (masked) row, or null when a guard failed.
 */
async function writePayoutIfEditable(transfer: Transfer, bankDetails: BankDetails): Promise<Transfer | null> {
  const destination = bankDetails.payoutDestination ?? '';
  return getDb().transaction(async (tx) => {
    const updated = await createTransferRepo(tx).setPayoutIfEditable(transfer.id, transfer.partnerId, {
      payoutMethod: bankDetails.payoutMethod ?? 'bank',
      payoutDestination: destination,
    });
    if (updated) {
      await createAuditRepo(tx).record({
        partnerId: transfer.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'transfer.payout_edit',
        subjectId: transfer.id,
        meta: { last4: accountLast4(destination) },
      });
    }
    return updated;
  });
}

/**
 * fix 6 (ctx-01): bind the payer's opaque ACH mandate to a B2B ach_pull transfer
 * through ONE guarded, column-targeted UPDATE (transfer-repo setAchTokenIfAbsent:
 * this tenant, awaiting_payment, b2b, no token yet) — never a whole-row re-save
 * of a masked read (transferToRow writes recipient_legal_name_enc = NULL,
 * mappers.ts:99, and rewrites status from the stale read, so a concurrent POST's
 * paid flip could be reverted and settled twice). A token already bound — ours
 * from a crash-then-retry, or a concurrent POST's — is kept: the FIRST mandate
 * wins. Returns the row to settle, or the response to send (current truth).
 */
async function bindAchToken(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
  token: string,
): Promise<Transfer | NextResponse> {
  if ((transfer.achTokenRef ?? '').trim() !== '') return transfer;
  const bound = await createTransferRepo(getDb()).setAchTokenIfAbsent(transfer.id, transfer.partnerId, token);
  if (bound) return bound;
  const current = await store.getTransfer(transfer.id);
  if (!current) return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  const refused = refuseUnlessAwaiting(current);
  if (refused) return refused;
  if ((current.achTokenRef ?? '').trim() !== '') return current;
  // Awaiting, token-less, yet the guarded write matched nothing: not a B2B row
  // (callers only reach here with transferType 'b2b'). Never write around it.
  return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 409 });
}
```

   - **Country allow-list** — `VALID_COUNTRY_CODES` (`:214-216`) lacks `'HK'` and `'MX'` although both are `CountryCode`s (`types.ts:515-516`) with a bank form (`payout-format.ts:107-115`): a posted HK/MX form is silently dropped (`country` → `undefined`, `:318-321`), so such a row could never get bank details. Change the list to `'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN', 'HK', 'MX',` (pinned by the `hk1`/`mx1` test).
   - **Body-country tie** — inside `if (hasSubmittedFields) {` (`:333`), before `const validation = validatePayoutFields(country!, fields);`:
     ```ts
           // fix 6: the per-country form is bound to THIS payment's destination
           // country (the transfer's, else the draft's) — a caller never picks
           // another country's field set for it.
           const target = (await store.getTransfer(transferId)) ?? otpDraft;
           if (country !== (target?.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY)) {
             return NextResponse.json(
               { ok: false, error: 'Please check the bank details.', fieldErrors: { country: 'These bank details are for a different country.' } },
               { status: 400 },
             );
           }
     ```
   - **Existing-transfer branch** — directly after `const refused = refuseUnlessAwaiting(transfer); if (refused) return refused;` (`:356-357`):
     ```ts
           // fix 6: a CONSUMER row carrying a partner-pulled funding method (only a
           // pre-fix model argument could mint one) is neither captured by us nor
           // legitimately pulled by the partner. Fail closed: never charge, never instruct.
           if (isPartnerPulled(transfer.fundingMethod) && transfer.transferType !== 'b2b') {
             logError('pay.consumer-partner-pulled', new Error('consumer transfer with a partner-pulled funding method'), { transferId: transfer.id });
             return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
           }
     ```
     and change the ACH condition `if (transfer.fundingMethod === 'ach_pull') {` (`:373`) → `if (transfer.transferType === 'b2b' && transfer.fundingMethod === 'ach_pull') {`. Inside it, replace the mandate bind by content — from `const withToken: Transfer =` (`:394`) through `return await processTransferPayment(store, withToken);` (`:401`) — with:
     ```ts
             const withToken = await bindAchToken(store, transfer, ach.token);
             if (withToken instanceof NextResponse) return withToken;
             // Capture is skipped structurally inside processTransferPayment (keyed on
             // transferType 'b2b' + a partner-pulled fundingMethod — fix 6); no caller flag needed.
             return await processTransferPayment(store, withToken);
     ```
     (the `// Bind the opaque mandate token. Idempotent: …` comment above it stays — it is still true.)
   - Replace the existing-transfer tail by content — from `const hasDestination = (transfer.payoutDestination ?? '').trim() !== '';` (`:410`) through `return await processTransferPayment(store, transfer);` (`:431`):

```ts
      // fix 6 (ctx-01): `transfer` is the DEFAULT (masked) read — it renders every
      // stored value, real or poisoned, as "****<last4>". Decide on the explicit
      // decrypted read; the value only feeds this boolean.
      const storedDestination =
        ((await store.getTransferDecrypted(transferId))?.payoutDestination ?? '').trim();
      const hasDestination = storedDestination !== '' && !isMaskedDestination(storedDestination);
      // Sender-entered, server-validated, country-bound bank details (the page's
      // Step 1, or its "Edit bank details") fill or replace the payout of a
      // CONSUMER transfer through ONE guarded write. A B2B payee is never payer
      // input: its body is ignored.
      if (bankDetails && transfer.transferType !== 'b2b') {
        const edited = await writePayoutIfEditable(transfer, bankDetails);
        if (!edited) {
          // A guard failed after our read (a concurrent POST charged / settled /
          // held it — the OTP verify is not atomic), or the row is not editable
          // here (charged, partner-API-minted). Never write around the guard:
          // report current truth.
          const current = await store.getTransfer(transferId);
          const nowRefused = current ? refuseUnlessAwaiting(current) : null;
          if (nowRefused) return nowRefused;
          return NextResponse.json(
            { ok: false, error: "This transfer's bank details can't be changed here.", reason: 'payout_locked' },
            { status: 409 },
          );
        }
        return await processTransferPayment(store, edited);
      }
      if (!hasDestination) {
        // A SCHEDULED/cron transfer can be created with an empty destination (Item 2:
        // never collected in chat). It MUST be collected + validated here before
        // charging — a no-account transfer must never be delivered.
        return NextResponse.json(
          { ok: false, error: 'Bank details are required to complete this transfer.' },
          { status: 400 },
        );
      }
      // Destination already set (re-opened link) → process exactly as before.
      return await processTransferPayment(store, transfer);
```

   - **Draft branch:** Task 9's `fx_unavailable → 503` arm stays **verbatim**; insert directly after it, before `const msg =`:
     ```ts
           if (result.error === 'bank_details_required') {
             // fix 6 (ctx-01): the draft holds no usable destination. 400 — never 500 —
             // nothing was claimed or consumed; the SAME link re-submits.
             return NextResponse.json(
               { ok: false, error: 'Bank details are required to complete this transfer.', reason: 'bank_details_required' },
               { status: 400 },
             );
           }
     ```
     and change `if (created.fundingMethod === 'ach_pull') {` (`:470`) → `if (created.transferType === 'b2b' && created.fundingMethod === 'ach_pull') {`; inside it replace `const withToken: Transfer =` (`:478`) through `return await processTransferPayment(store, withToken);` (`:483`) with:
     ```ts
           const withToken = await bindAchToken(store, created, ach.token);
           if (withToken instanceof NextResponse) return withToken;
           return await processTransferPayment(store, withToken);
     ```
   - **`processTransferPayment`:** change `if (!isPartnerPulled(transfer.fundingMethod)) {` (`:158`) → `if (!(transfer.transferType === 'b2b' && isPartnerPulled(transfer.fundingMethod))) {`; in its docblock (`:95-101`) change the sentence ending `(fundingMethod === 'ach_pull'), NOT a caller flag` to `(transferType === 'b2b' AND a partner-pulled fundingMethod — fix 6), NOT a caller flag`, and append after `…ever minted into the transfer this function receives.` (`:80-84`): ` An EXISTING transfer's destination is checked by POST's existing-transfer branch (hasDestination, decrypted read; payout writes through writePayoutIfEditable) before it is handed to this function.`

   **`src/app/pay/[transferId]/page.tsx`** (UI — tsc + the Step 10 walk-through):
   - Imports after `import { draftTenant } from '@/lib/legacy-tenant';` (`:7`): `import { accountLast4, isMaskedDestination } from '@/lib/payout-format';`, `import { getDb } from '@/db/client';`, `import { createTransferRepo } from '@/db/repos/transfer-repo';`.
   - After the `Row` component (ends `:58`):
     ```tsx
     /** fix 6: last-4 label for a REAL stored destination (this page is link-reachable without OTP — never more than 4 digits). */
     function savedAccountLabelFor(dest: string): string {
       const l4 = accountLast4(dest);
       return l4 ? `account ending ${l4}` : 'the saved account';
     }
     ```
   - In `type View` (`:88-107`) after `needsBankDetails: boolean;`: `savedAccountLabel: string | null; // fix 6: non-null ⇒ the single-step form offers "Edit bank details"`.
   - Directly after `brandPartnerId = transfer.partnerId;` (`:114`):
     ```ts
         // fix 6 (ctx-01): decide Step 1 and the Edit offer on the explicit decrypted
         // read (boolean + last-4 label only); Edit only where the guarded write would
         // accept it (consumer, uncharged, awaiting, not partner-API-minted).
         const storedTransferDest =
           ((await getStore().getTransferDecrypted(transferId))?.payoutDestination ?? '').trim();
         const transferNeedsDetails = storedTransferDest === '' || isMaskedDestination(storedTransferDest);
         const transferEditable =
           !transferNeedsDetails && (await createTransferRepo(getDb()).isPayoutEditable(transfer.id, transfer.partnerId));
     ```
   - Replace `needsBankDetails: (transfer.payoutDestination ?? '').trim() === '',` (`:132`) with:
     ```ts
           needsBankDetails: transferNeedsDetails,
           savedAccountLabel: transferEditable ? savedAccountLabelFor(storedTransferDest) : null,
     ```
   - Replace the `hasStoredDest` block (`:147-151`, `// A cold-start draft carries NO bank string …` through `const hasStoredDest = (draft.recipient.payoutDestination ?? '').trim() !== '';`) with:
     ```ts
           // A cold-start draft carries NO bank string (Item 2). A draft carrying a REAL
           // stored destination (rehydrated server-side) skips Step 1 but offers "Edit bank
           // details" on a consumer draft. fix 6: a MASKED placeholder is not a stored
           // destination — collect it on Step 1 like a cold start.
           const storedDraftDest = (draft.recipient.payoutDestination ?? '').trim();
           const hasStoredDest = storedDraftDest !== '' && !isMaskedDestination(storedDraftDest);
     ```
     and after `needsBankDetails: !hasStoredDest,` (`:164`) add `savedAccountLabel: hasStoredDest && draft.transferType !== 'b2b' ? savedAccountLabelFor(storedDraftDest) : null,`.
   - In `<PayForm … />` (`:214-227`) add `savedAccountLabel={view.savedAccountLabel}`.

   **`src/app/pay/[transferId]/pay-form.tsx`** (UI):
   - `PayForm` (`:60-101`): add the prop `savedAccountLabel = null,` and `savedAccountLabel?: string | null;` to its type; body:
     ```tsx
       // fix 6: the sender may replace a prefilled (server-rehydrated) destination.
       const [editBankDetails, setEditBankDetails] = useState(false);
       if (fundingMethod === 'ach_pull') {
         return <AchDebitPayForm transferId={transferId} recipientName={recipientName} summary={summary} />;
       }
       if (!needsBankDetails && !editBankDetails) {
         return (
           <SimplePayForm
             transferId={transferId}
             savedAccountLabel={savedAccountLabel}
             onEditBankDetails={savedAccountLabel ? () => setEditBankDetails(true) : undefined}
           />
         );
       }
       return (
         <BankDetailsPayForm
           transferId={transferId}
           destinationCountry={destinationCountry}
           recipientName={recipientName}
           summary={summary}
         />
       );
     ```
     (keep the existing explanatory comments above each branch; `useState` precedes every return.)
   - `SimplePayForm` (`:174-248`): props `{ transferId, savedAccountLabel = null, onEditBankDetails }: { transferId: string; savedAccountLabel?: string | null; onEditBankDetails?: () => void }`; its returned `<form>` becomes:
     ```tsx
       return (
         <form onSubmit={handleSubmit}>
           {savedAccountLabel && (
             <div className={panelClasses}>
               <div className={lineClasses}>
                 <span className="text-[#8696a0]">Paying to</span>
                 <span>{savedAccountLabel}</span>
               </div>
             </div>
           )}
           <OtpFields transferId={transferId} code={code} setCode={setCode} sent={sent} setSent={setSent} otpError={otpError} />
           <button type="submit" className={primaryBtnClasses} disabled={status === 'paying' || !sent || code.length !== 6}>
             {status === 'paying' ? 'Processing…' : 'Pay now'}
           </button>
           {onEditBankDetails && (
             <button type="button" className={secondaryBtnClasses} onClick={onEditBankDetails} disabled={status === 'paying'}>
               Edit bank details
             </button>
           )}
           {status === 'error' && !otpError && (
             <p className={formErrorClasses}>Something went wrong. Please try again.</p>
           )}
         </form>
       );
     ```
     (`panelClasses` `:57`, `lineClasses` `:58`, `secondaryBtnClasses` `:51` exist. `BankDetailsPayForm` posts `country: destinationCountry` = the view's destination country, which the route's tie accepts.)

4. **Run:**
   ```
   npx vitest run tests/transfer-repo.test.ts tests/pay-route-bank-details.test.ts tests/pay-route-masked-draft.test.ts tests/pay-route-otp.test.ts tests/pay-route-funding.test.ts tests/pay-route-ach-pull.test.ts tests/pay-route-delayed-poke.test.ts tests/pay-route-in-review.test.ts tests/pay-route-fx.test.ts tests/pay-finalize.test.ts
   npx tsc --noEmit
   npx eslint "src/app/pay/[transferId]" "src/app/api/pay/[transferId]" src/db/repos/transfer-repo.ts src/lib/store.ts
   ```
   → green; `pay-route-ach-pull.test.ts` rows are all `transferType: 'b2b'` (`:128-141`), so its pre-existing ACH/capture tests pass unchanged (its replay test, `:266-277`, is answered by `refuseUnlessAwaiting` before any bind); `'destination already set + NO body → processes'` (`pay-route-bank-details.test.ts:156-161`) still passes.

5. **Commit:** `fix(pay-page): one guarded, audited payout write; Edit bank details; B2B payee never payer input; consumer partner-pulled rows refused (ctx-01)`

---

#### Step 6 — Chat tools: the model never chooses a payout destination, a partner-pulled method, or the B2B shape (RED → GREEN)

1. **Failing tests** — `tests/tools.test.ts`:
   - `import type { CurrencyCode, Quote } from '@/lib/types';` → `import type { CurrencyCode, Quote, Transfer } from '@/lib/types';`; add after `import type { Db } from '@/db/client';` (`:34` post-Task-9): `import { finalizeDraftPayment } from '@/lib/pay-finalize';`.
   - **Update existing fixtures:**
     - `seedPastTransfer` (`describe('repeat_transfer — reactive re-send to a past recipient (Bundle C)'`, `:1609-1621`) and `seedPast` (`describe('repeat_transfer on the web channel (B5 safe degrade)'`, `:2792-2806`) — replace each body with a server-side seed then an arg-free create (keep `seedPast`'s trailing `ctx, // whatsapp channel — the past send happened in the bot` comment):
       ```ts
           // fix 6: the model can no longer supply a destination — seed the saved
           // account server-side; the create rehydrates it (recipient + ledger row).
           await ctx.store.upsertRecipient('default', ctx.phone, {
             name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@okhdfc',
             lastUsedAt: new Date().toISOString(),
           });
           // $200 (not $500) so a repeat stays within the T0 $500/day cap and exercises
           // the REAL cap gate inside repeat_transfer rather than tripping it.
           await executeTool('create_transfer', {
             amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer',
           }, ctx);
       ```
       (their assertions `:1635`, `:1671`, `:2823` stay green — `maskAccount` still passes UPI through.)
     - `describe('create_transfer — B2B (business-to-business, ach_pull, non-custodial)'` first test (`:3316-3342`) and `describe('send_approve_picker — B2B draft → approve-tap mint threads business fields'` (`:3358-3397`): insert at the top of each test body (after `buildCtx`):
       ```ts
           // fix 6: a chat B2B send pays the sender's OWN unpaid bill (b2b_invoices is
           // not in freshDb's TRUNCATE set — clear it, then seed the bill).
           await db.execute(sql`TRUNCATE b2b_invoices`);
           await ctx.store.saveB2bInvoice({
             id: 'inv_u1', partnerId: 'default', businessName: 'Globex Trading LLC',
             buyerPhone: PHONE, lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 400 }],
             amountUsd: 400, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
           });
       ```
     - `mintB2b` (`describe('B2B buyer lifecycle controls (L1)'`, `:3414-3427`; its `beforeEach` already truncates `b2b_invoices`, `:3406-3409`): make the invoice mandatory —
       ```ts
         let invoiceSeq = 0;
         async function mintB2b(ctx: Ctx, invoiceId?: string): Promise<string> {
           // fix 6: a chat B2B mint pays the sender's OWN open bill, for exactly its
           // amount (400 — within the T0 $500/day cap; seedUnpaidInvoice's 1000 is not).
           let id = invoiceId;
           if (!id) {
             id = `inv_mint_${++invoiceSeq}`;
             await ctx.store.saveB2bInvoice({
               id, partnerId: 'default', businessName: 'Globex Trading LLC',
               buyerPhone: ctx.phone, lineItems: [{ description: 'Widgets', qty: 40, unitAmountUsd: 10 }],
               amountUsd: 400, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
             });
           }
           const created = await executeTool('create_transfer', {
             amount_source: 400,
             recipient_name: 'Globex Trading LLC',
             recipient_phone: '919876543210',
             funding_method: 'ach_pull',
             entity_type: 'business',
             sender_business_name: 'Acme Imports Ltd',
             recipient_business_name: 'Globex Trading LLC',
             invoice_id: id,
           }, ctx);
           expect(created.error).toBeUndefined();
           return created.transfer_id as string;
         }
       ```
       (`seedUnpaidInvoice` (`:3435-3442`, `amountUsd: 1000`) stays as is for the dispute tests, which never call `mintB2b`; the one explicit-id caller, `mintB2b(ctx, 'inv_cbs')` (`:3498`), seeds a 400-USD, `buyerPhone: PHONE`, seller-less invoice (`:3492-3496`), which passes the amount gate. The L1 assertions read status / refund / ticket / invoice-status fields, which a linked unpaid invoice does not change — `cancelBillTool`'s `awaiting_payment` / `in_review` / `paid` / `delivered` arms do not read the invoice.)
   - Append at the end of the file:

```ts
const FIX6_REAL = 'HDFC0001234 123456789012';
const FIX6_MOM = '919876543210';

/** A ledger row as a past send would have left it (default: a delivered consumer bank send to Mom in IN). */
function fix6LedgerRow(phone: string, o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17000,
    recipientName: 'Mom', recipientPhone: FIX6_MOM, payoutMethod: 'bank', payoutDestination: FIX6_REAL,
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
    destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 0, totalChargeSource: 200,
    transferType: 'b2c', ...o,
  };
}

describe('fix 6 (ctx-01): the model never chooses a payout destination, a partner-pulled method or the B2B shape', () => {
  const REAL = FIX6_REAL;
  const MOM = FIX6_MOM;

  async function returningCtx(phone = '15550006006') {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, phone);
    await ctx.store.upsertRecipient('default', phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: REAL,
      lastUsedAt: new Date().toISOString(),
    });
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx); // prime FX
    const sends: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') sends.push(init.body);
      return { ok: true, text: async () => '', json: async () => ({ rates: { INR: MOCK_RATE } }) };
    }));
    return { ctx, redis, sends };
  }
  const cardOf = (sends: string[]) => sends.find((s) => s.includes('cta_url')) ?? '';
  const draftDest = async (ctx: Awaited<ReturnType<typeof buildCtx>>, r: Record<string, unknown>) =>
    (await ctx.draftStore.consumeDraft(r.draft_id as string))?.recipient.payoutDestination;

  it('no tool offers payout_method / payout_destination to the model', () => {
    for (const name of ['create_transfer', 'create_schedule', 'send_approve_picker', 'repeat_transfer']) {
      const props = toolSchemas.find((t) => t.function.name === name)!.function.parameters.properties as Record<string, unknown>;
      expect(props, name).not.toHaveProperty('payout_method');
      expect(props, name).not.toHaveProperty('payout_destination');
    }
  });

  it('resolve_recipient → send_approve_picker → pay-page finalize mints the REAL account, never "****9012", saved recipient intact, no digits leak', async () => {
    const { ctx, sends } = await returningCtx();
    const resolved = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    const shown = (resolved.recipient as Record<string, unknown>).payout_destination;
    expect(shown).toBe('****9012');
    const picker = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
      payout_method: 'bank', payout_destination: shown,
    }, ctx);
    const draftId = picker.draft_id as string;
    expect((await ctx.draftStore.getDraft(draftId))?.recipient.payoutDestination).toBe(REAL);
    const result = await finalizeDraftPayment({
      store: ctx.store, customerStore: ctx.customerStore, draftStore: ctx.draftStore,
      partnerStore: ctx.partnerStore, monthlyVolumeStore: ctx.monthlyVolumeStore,
      dailyVolumeStore: ctx.dailyVolumeStore, db,
    }, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await ctx.store.getTransferDecrypted(result.transferId))?.payoutDestination).toBe(REAL);
    expect((await ctx.store.getTransfer(result.transferId))?.payoutDestination).toBe('****9012');
    expect((await ctx.store.listRecipients('default', ctx.phone, 1))[0].payoutDestination).toBe(REAL);
    for (const s of [JSON.stringify(resolved), JSON.stringify(picker), ...sends]) expect(s).not.toContain('123456789012');
  });

  it('send_approve_picker IGNORES any model-supplied destination and rehydrates by the NORMALIZED phone', async () => {
    const { ctx } = await returningCtx();
    for (const supplied of ['account on file', 'xxxx9012', 'ending 9012', 'SBIN0009999 000000000001']) {
      const r = await executeTool('send_approve_picker', {
        amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom',
        recipient_phone: '+91 98765 43210', payout_method: 'bank', payout_destination: supplied,
      }, ctx);
      expect(await draftDest(ctx, r), supplied).toBe(REAL);
    }
  });

  it('a number with NO stored record → cold-start draft and the placeholder card, whatever the model supplied', async () => {
    const { ctx, sends } = await returningCtx();
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Dad', recipient_phone: '919811111111',
      payout_method: 'bank', payout_destination: 'xxxx4321',
    }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.recipient.payoutDestination).toBe('');
    expect(draft?.recipient.payoutMethod).toBe('bank');
    expect(cardOf(sends)).toContain("you'll enter the details on the secure page");
    expect(cardOf(sends)).not.toContain('4321');
  });

  it("rehydration is scoped to (tenant, sender): another sender's record, or the same phone under another tenant, is never used", async () => {
    await seedPartner(db, 'acme');
    const { ctx, redis } = await returningCtx('15550006007');
    const other = await buildCtx(redis, '15559990000');
    await other.store.upsertRecipient('default', other.phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: 'ICIC0000001 999999999999',
      lastUsedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(await draftDest(ctx, await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
    }, ctx))).toBe(REAL);
    const acme = await buildCtx(redis, '15550006007', 'acme');
    const a1 = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
    }, acme);
    const acmeCold = await acme.draftStore.consumeDraft(a1.draft_id as string);
    expect(acmeCold?.recipient.payoutDestination).toBe('');
    expect(acmeCold?.partnerId).toBe('acme');
    await acme.store.upsertRecipient('acme', acme.phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: 'SBIN0000123 555555555555',
      lastUsedAt: new Date().toISOString(),
    });
    expect(await draftDest(acme, await executeTool('send_approve_picker', {
      amount_usd: 150, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
    }, acme))).toBe('SBIN0000123 555555555555');
  });

  it("a saved recipient is used only when the number's country IS the send's destination country", async () => {
    const { ctx } = await returningCtx();
    const UNCLE = '15557654321'; // a US number; the send defaults to IN
    await ctx.store.upsertRecipient('default', ctx.phone, {
      name: 'Uncle', recipientPhone: UNCLE, payoutMethod: 'bank', payoutDestination: 'HDFC0001234 555566667777',
      lastUsedAt: new Date().toISOString(),
    });
    expect(await draftDest(ctx, await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Uncle', recipient_phone: UNCLE,
    }, ctx))).toBe('');
  });

  it('the ledger fallback uses ONLY a settled (paid / delivered) consumer row in the SAME destination country', async () => {
    const { ctx } = await returningCtx();
    await ctx.store.upsertRecipient('default', ctx.phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: '****9012',
      lastUsedAt: new Date().toISOString(),
    });
    const t0 = Date.now();
    await ctx.store.saveTransfer(fix6LedgerRow(ctx.phone, {
      id: 'l_await', status: 'awaiting_payment', payoutDestination: 'ICIC0000001 111111111111',
      createdAt: new Date(t0 - 1000).toISOString(),
    }));
    await ctx.store.saveTransfer(fix6LedgerRow(ctx.phone, {
      id: 'l_gb', destinationCountry: 'GB', destinationCurrency: 'GBP', payoutDestination: '12-34-56 33333333',
      createdAt: new Date(t0 - 2000).toISOString(),
    }));
    expect(await draftDest(ctx, await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
    }, ctx))).toBe('');
    await ctx.store.saveTransfer(fix6LedgerRow(ctx.phone, { id: 'l_ok', createdAt: new Date(t0 - 3000).toISOString() }));
    expect(await draftDest(ctx, await executeTool('send_approve_picker', {
      amount_usd: 150, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
    }, ctx))).toBe(REAL);
  });

  it("a number the sender paid as a BUSINESS never rehydrates (a pre-fix B2B mint may have saved a seller's profile account)", async () => {
    const { ctx } = await returningCtx();
    const SELLER = '919822222222';
    await ctx.store.upsertRecipient('default', ctx.phone, {
      name: 'Globex Trading LLC', recipientPhone: SELLER, payoutMethod: 'bank', payoutDestination: 'HDFC0009999 444444444444',
      lastUsedAt: new Date().toISOString(),
    });
    await ctx.store.saveTransfer(fix6LedgerRow(ctx.phone, {
      id: 'b2b_bill', recipientPhone: SELLER, recipientName: 'Globex Trading LLC', transferType: 'b2b',
      senderEntityType: 'business', recipientEntityType: 'business', fundingMethod: 'bank_pull',
      payoutDestination: 'HDFC0009999 444444444444',
    }));
    expect(await draftDest(ctx, await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Globex', recipient_phone: SELLER,
    }, ctx))).toBe('');
  });

  it('the rehydrated account never appears in the ToolResult or the card — the card reads "bank a/c ****9012"', async () => {
    const { ctx, sends } = await returningCtx();
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
    }, ctx);
    const card = cardOf(sends);
    expect(card).toContain('bank a/c ****9012');
    for (const s of [JSON.stringify(r), card]) {
      expect(s).not.toContain('123456789012');
      expect(s).not.toContain('HDFC0001234');
    }
  });

  it('a saved recipient that is ITSELF poisoned is not rehydrated — cold start, never the mask', async () => {
    const { ctx } = await returningCtx();
    await ctx.store.upsertRecipient('default', ctx.phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: '****9012',
      lastUsedAt: new Date().toISOString(),
    });
    expect(await draftDest(ctx, await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
      payout_method: 'bank', payout_destination: '****9012',
    }, ctx))).toBe('');
  });

  it('screening still runs first: a blocked attempt is recorded with real figures, never with a model-supplied value', async () => {
    const { ctx } = await returningCtx();
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'John Doe',
      recipient_phone: '919800000000', payout_method: 'bank', payout_destination: '****1111',
    }, ctx);
    expect(r.blocked).toBe(true);
    const blocked = (await ctx.store.listTransfers()).filter((t) => t.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].amountUsd).toBe(200);
    expect((await ctx.store.getTransferDecrypted(blocked[0].id))?.payoutDestination).toBe('');
  });

  it('legacy create_transfer IGNORES the model-supplied destination: the stored account for a known number, "" for an unknown one', async () => {
    const { ctx } = await returningCtx();
    const a = await executeTool('create_transfer', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: MOM,
      payout_method: 'bank', payout_destination: 'xxxx9012', funding_method: 'bank_transfer',
    }, ctx);
    expect((await ctx.store.getTransferDecrypted(a.transfer_id as string))?.payoutDestination).toBe(REAL);
    const b = await executeTool('create_transfer', {
      amount_usd: 100, recipient_name: 'Dad', recipient_phone: '919811111111',
      payout_method: 'bank', payout_destination: 'SBIN0009999 000000000001', funding_method: 'bank_transfer',
    }, ctx);
    expect((await ctx.store.getTransferDecrypted(b.transfer_id as string))?.payoutDestination).toBe('');
    expect((await ctx.store.listRecipients('default', ctx.phone, 25)).map((x) => x.name)).not.toContain('Dad');
  });

  it('legacy create_transfer: a WATCHLISTED name is still blocked and recorded (empty destination), never saved as a recipient', async () => {
    const { ctx } = await returningCtx();
    const r = await executeTool('create_transfer', {
      amount_usd: 100, recipient_name: 'John Doe', recipient_phone: '919800000000',
      payout_method: 'bank', payout_destination: '****9012', funding_method: 'bank_transfer',
    }, ctx);
    expect(r.status).toBe('blocked');
    expect((await ctx.store.getTransferDecrypted(r.transfer_id as string))?.payoutDestination).toBe('');
    expect((await ctx.store.listRecipients('default', ctx.phone, 25)).map((x) => x.name)).not.toContain('John Doe');
  });

  it('create_schedule IGNORES the model-supplied destination: the stored account for a known number, "" for an unknown one', async () => {
    const { ctx } = await returningCtx();
    const s1 = await executeTool('create_schedule', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: MOM, frequency: 'monthly', day_of_month: 5,
      payout_method: 'bank', payout_destination: 'xxxx9012', funding_method: 'bank_transfer',
    }, ctx);
    expect((await ctx.scheduleStore.getSchedule(s1.schedule_id as string))?.payoutDestination).toBe(REAL);
    const s2 = await executeTool('create_schedule', {
      amount_usd: 100, recipient_name: 'Dad', recipient_phone: '919811111111', frequency: 'monthly', day_of_month: 5,
      payout_method: 'bank', payout_destination: 'SBIN0009999 000000000001', funding_method: 'bank_transfer',
    }, ctx);
    expect((await ctx.scheduleStore.getSchedule(s2.schedule_id as string))?.payoutDestination).toBe('');
  });

  it('funding_method is a closed set: a partner-pulled or unknown method is refused before any draft, row or schedule', async () => {
    const { ctx } = await returningCtx();
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');
    for (const bad of ['bank_pull', 'crypto']) {
      expect((await executeTool('send_approve_picker', { amount_usd: 200, funding_method: bad, recipient_name: 'Mom', recipient_phone: MOM }, ctx)).error, bad).toBeDefined();
      expect((await executeTool('create_transfer', { amount_usd: 100, funding_method: bad, recipient_name: 'Mom', recipient_phone: MOM }, ctx)).error, bad).toBeDefined();
    }
    for (const bad of ['bank_pull', 'ach_pull', 'crypto']) {
      expect((await executeTool('create_schedule', {
        amount_usd: 100, funding_method: bad, recipient_name: 'Mom', recipient_phone: MOM, frequency: 'monthly', day_of_month: 5,
      }, ctx)).error, bad).toBeDefined();
    }
    expect(createDraft).not.toHaveBeenCalled();
    expect(await ctx.store.listTransfers()).toHaveLength(0);
    expect(await ctx.scheduleStore.listActiveSchedules()).toHaveLength(0);
  });

  it("the B2B shape is not model-selectable: ach_pull / entity_type 'business' need the sender's OWN open bill, seller-less, for exactly its amount", async () => {
    const { ctx } = await returningCtx();
    await db.execute(sql`TRUNCATE b2b_invoices`);
    const seed = (id: string, buyerPhone: string, status: 'unpaid' | 'paid', extra: { sellerId?: string } = {}) => ctx.store.saveB2bInvoice({
      id, partnerId: 'default', businessName: 'Globex Trading LLC', buyerPhone,
      lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 400 }], amountUsd: 400, currency: 'USD',
      status, createdAt: new Date().toISOString(), ...extra,
    });
    await seed('inv_mine', ctx.phone, 'unpaid');
    await seed('inv_paid', ctx.phone, 'paid');
    await seed('inv_other', '15559990000', 'unpaid');
    await ctx.store.createSeller({ id: 's_fix6', partnerId: 'default', phone: '15557770000', businessName: 'Globex Trading LLC', country: 'US', currency: 'USD' });
    await seed('inv_checkout', ctx.phone, 'unpaid', { sellerId: 's_fix6' }); // b2b_invoices.seller_id → sellers.id (schema.ts:156)
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');
    const b2bArgs = (over: Record<string, unknown>) => ({
      amount_source: 400, recipient_name: 'Globex Trading LLC', recipient_phone: '919876543210',
      sender_business_name: 'Acme Imports Ltd', recipient_business_name: 'Globex Trading LLC', ...over,
    });
    for (const over of [
      { funding_method: 'ach_pull' },                                                       // no entity_type, no bill
      { funding_method: 'ach_pull', entity_type: 'business' },                              // no bill
      { funding_method: 'bank_transfer', entity_type: 'business', invoice_id: 'inv_mine' }, // B2B must be ach_pull
      { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_nope' },
      { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_paid' },
      { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_other' },
      { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_checkout' },                   // a seller's checkout bill
      { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_mine', amount_source: 399 },  // not the billed amount
    ]) {
      expect((await executeTool('send_approve_picker', b2bArgs(over), ctx)).error, JSON.stringify(over)).toBeDefined();
      expect((await executeTool('create_transfer', b2bArgs(over), ctx)).error, JSON.stringify(over)).toBeDefined();
    }
    expect(createDraft).not.toHaveBeenCalled();
    expect(await ctx.store.listTransfers()).toHaveLength(0);
    const ok = await executeTool('send_approve_picker', b2bArgs({ funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_mine' }), ctx);
    expect(ok.sent).toBe(true);
  });

  it('approve tap on a PRE-FIX draft: a placeholder → friendly error + draft RESTORED; a consumer partner-pulled draft → friendly error, nothing minted', async () => {
    const { ctx } = await returningCtx();
    const draftOf = (over: Record<string, unknown>) => ctx.draftStore.createDraft({
      senderPhone: ctx.phone, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: '****9012' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
      ...over,
    } as Parameters<typeof ctx.draftStore.createDraft>[0]);
    const tap = (draftId: string) => executeTool('create_transfer', {}, { ...ctx, turn: { isNewConversation: false, buttonTap: { kind: 'approve' as const, draftId } } });
    const masked = await draftOf({});
    expect((await tap(masked)).error).toBeDefined();
    expect(await ctx.draftStore.getDraft(masked)).not.toBeNull();
    const pulled = await draftOf({ recipient: { name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: REAL }, fundingMethod: 'bank_pull' });
    expect((await tap(pulled)).error).toBeDefined();
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });
});

describe('fix 6 (ctx-01): repeat_transfer rehydrates server-side and never carries a destination or a partner-pulled method', () => {
  const REAL = FIX6_REAL;
  const MOM = FIX6_MOM;
  async function seedBankPast(ctx: Awaited<ReturnType<typeof buildCtx>>) {
    await ctx.store.upsertRecipient('default', ctx.phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: REAL,
      lastUsedAt: new Date().toISOString(),
    });
    await ctx.store.saveTransfer(fix6LedgerRow(ctx.phone, { id: 'past_1' }));
  }

  it('the new draft carries the real account and the repeated corridor; the result carries no digits', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedBankPast(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: MOM }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.recipient.payoutDestination).toBe(REAL);
    expect(draft?.destinationCountry).toBe('IN');
    expect(JSON.stringify(r)).not.toContain('123456789012');
  });

  it('a POISONED saved recipient falls back to the DECRYPTED settled ledger row, never the mask', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedBankPast(ctx);
    await ctx.store.upsertRecipient('default', ctx.phone, {
      name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: '****9012',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('repeat_transfer', { recipient_phone: MOM }, ctx);
    expect((await ctx.draftStore.consumeDraft(r.draft_id as string))?.recipient.payoutDestination).toBe(REAL);
  });

  it('needs_edd returns the destination MASKED', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedBankPast(ctx);
    await ctx.monthlyVolumeStore.addCents('default', ctx.phone, 300000);
    const r = await executeTool('repeat_transfer', { recipient_phone: MOM, amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(r.payout_destination).toBe('****9012');
    expect(JSON.stringify(r)).not.toContain('123456789012');
  });

  it('funding_method is a closed set on repeat, and a remembered partner-pulled method is never carried into a chat draft', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedBankPast(ctx);
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');
    expect((await executeTool('repeat_transfer', { recipient_phone: MOM, funding_method: 'bank_pull' }, ctx)).error).toBeDefined();
    expect(createDraft).not.toHaveBeenCalled();
    await ctx.customerStore.recordFundingMethod('default', ctx.phone, 'bank_pull');
    const r = await executeTool('repeat_transfer', { recipient_phone: MOM }, ctx);
    expect((await ctx.draftStore.consumeDraft(r.draft_id as string))?.fundingMethod).toBe('bank_transfer');
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/tools.test.ts -t "fix 6"` → RED on main: schemas (`create_transfer` offers `payout_method`); chain (`expected '****9012' to be 'HDFC0001234 123456789012'`); ignore-supplied; cold start (`'xxxx4321'`); scope; ledger fallback (`r2`); card; poisoned; blocked (`'****1111'`); both legacy; schedule; funding (`bank_pull` drafts on main); B2B shape (main drafts `ach_pull` with no bill); approve tap (main mints both); repeat tests 2–4. The country-gate and business-number tests pass on main (main never rehydrates) — they lock the helper's rules. The fixture edits are green on main and after.

3. **Implement** — `src/lib/tools.ts` (anchors by content):

   (a) **Imports:** `import { createTransfer, quoteOverrideFromDraft, recordBlockedAttempt } from './transfer-create';` → add `MaskedDestinationError, PartnerPulledConsumerError`; `import { DEFAULT_PARTNER_ID } from './defaults';` → `import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_PARTNER_ID } from './defaults';`; the Step 1 import → `import { isMaskedDestination, ACCOUNT_ON_FILE_PLACEHOLDER, NO_BANK_DETAILS_PLACEHOLDER } from './payout-format';` (`countryForPhone` is already imported, `:3`).

   (b) **Closed sets + the B2B bill gate** — directly after `function asEnum…`'s closing `}` (`:197-199`):

```ts
// ── funding_method and the B2B shape are closed (fix 6) ─────────────────────
// Tools used to cast the model's funding_method straight to FundingMethod, and
// isB2bArgs treats funding_method 'ach_pull' alone as B2B — so a model could put
// a partner-pulled method (the pay route skips OUR funds capture for it) on a
// consumer send, or make any send "B2B". Each tool now accepts ONLY its schema
// enum (absent ⇒ bank_transfer), and a send is B2B only when it pays the
// sender's OWN open bill.
const CHAT_FUNDING_METHODS = ['credit_card', 'debit_card', 'bank_transfer', 'ach_pull'] as const;
const CONSUMER_FUNDING_METHODS = ['credit_card', 'debit_card', 'bank_transfer'] as const;
/** undefined ⇒ not supplied (caller defaults); null ⇒ supplied but outside `set` (caller refuses). */
function parseFundingArg<T extends readonly string[]>(set: T, v: unknown): T[number] | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return asEnum(set, v) ?? null;
}
function fundingMethodError(set: readonly string[]): string {
  return `funding_method must be one of: ${set.join(', ')}.`;
}
/**
 * A B2B send (isB2bArgs: entity_type 'business' OR funding_method 'ach_pull')
 * must be the payment of the sender's OWN open US bill, for exactly its amount:
 * entity_type 'business' AND funding_method 'ach_pull' AND an invoice_id that
 * resolves — tenant-scoped (getB2bInvoiceScoped) — to an 'unpaid' invoice whose
 * buyer is ctx.phone, that has NO sellerId (a registered seller's cross-border
 * bill is paid only on its own checkout, /pay/b2b/<id> — b2b-pay-finalize.ts:76
 * requires the sellerId there, and delivery of a B2B transfer marks its linked
 * invoice paid, so a chat send must not settle it for a model-chosen amount),
 * in USD, sent in USD for exactly amountUsd. Returns a refusal, or null.
 */
async function refuseUnlessOwnOpenBill(
  ctx: ToolContext,
  args: Record<string, unknown>,
  b2b: ParsedB2b,
  amountSource: number,
  sourceCurrency: CurrencyCode,
): Promise<ToolResult | null> {
  if (args.entity_type !== 'business' || args.funding_method !== 'ach_pull' || !b2b.invoiceId) {
    return { error: 'A business bill payment needs entity_type business, funding_method ach_pull and the invoice_id from present_bill.' };
  }
  const invoice = await ctx.store.getB2bInvoiceScoped(b2b.invoiceId, ctx.partnerId);
  if (!invoice || invoice.status !== 'unpaid' || invoice.buyerPhone !== ctx.phone) {
    return { error: 'That bill is not open for this account. Call present_bill to fetch the current bill.' };
  }
  if (invoice.sellerId) {
    return {
      error: 'This bill is paid on its secure checkout page, not in chat. Share the pay_url with the customer.',
      pay_url: `${env.appBaseUrl}/pay/b2b/${invoice.id}`,
    };
  }
  if (
    invoice.currency !== 'USD' ||
    sourceCurrency !== 'USD' ||
    Math.round(amountSource * 100) !== Math.round(invoice.amountUsd * 100)
  ) {
    return { error: `This bill is for exactly ${invoice.amountUsd} USD: send amount_source ${invoice.amountUsd} with source_currency USD.` };
  }
  return null;
}
```

   (c) **`resolveStoredPayout`** — directly after `maskDestination` (ends `:141`):

```ts
// ── Server-side payout rehydration (fix 6 / audit ctx-01) ────────────────────

/**
 * The ONLY source of a payout destination for a chat-created draft, transfer or
 * schedule — no tool reads args.payout_* (and no schema offers them). Returns
 * the sender's OWN stored payout for this number, or null (the caller
 * cold-starts: '' / 'bank', collected on the secure pay page):
 *   1. the saved recipient (listRecipients — explicit decrypt), used ONLY when
 *      (a) the number's own calling-code country IS the send's destination
 *      country (the recipients row carries no country) and (b) the sender has
 *      NO B2B transfer to that number (one tenant-scoped probe — a pre-fix B2B
 *      mint may have saved a seller's verified-profile account there);
 *   2. else the sender's newest CONSUMER transfer to that number that settled
 *      (paid / delivered) in the SAME destination country, DECRYPTED.
 * '' or a display placeholder is never usable. Keyed (ctx.partnerId, ctx.phone)
 * + the normalized recipient phone ONLY (fix 1: a phone is not an identity).
 * The value goes into a DRAFT or an encrypted SCHEDULE row only — never a
 * ToolResult, card body or log line. Read errors propagate (the agent turn's
 * outbox row retries).
 */
async function resolveStoredPayout(
  ctx: ToolContext,
  recipientPhone: string,
  destinationCountry: CountryCode,
): Promise<{ payoutMethod: PayoutMethod; payoutDestination: string } | null> {
  const usable = (v: string | undefined): string | null => {
    const t = (v ?? '').trim();
    return t !== '' && !isMaskedDestination(t) ? t : null;
  };
  const paidAsBusiness = await ctx.store.hasB2bTransferTo(ctx.partnerId, ctx.phone, recipientPhone);
  if (!paidAsBusiness && countryForPhone(recipientPhone) === destinationCountry) {
    const saved = (await ctx.store.listRecipients(ctx.partnerId, ctx.phone, 25)).find(
      (r) => normalizePhone(r.recipientPhone) === recipientPhone,
    );
    const fromBook = usable(saved?.payoutDestination);
    if (saved && fromBook) return { payoutMethod: saved.payoutMethod, payoutDestination: fromBook };
  }
  const settled = await ctx.store.latestSettledConsumerTransferTo(ctx.partnerId, ctx.phone, recipientPhone, destinationCountry);
  const fromLedger = usable(settled?.payoutDestination);
  return settled && fromLedger ? { payoutMethod: settled.payoutMethod, payoutDestination: fromLedger } : null;
}
```

   (d) **Schemas + descriptions.** `create_transfer`: description `'Create the transfer record after the user confirms the quote and provides recipient details.'` → `"Create the transfer record after the user confirms the quote and gives the recipient's name, WhatsApp number and destination country. Never collect or pass bank details: the stored payout details for that number are reused automatically, otherwise the sender enters them on the secure pay page."`; DELETE its `payout_method: { type: 'string', enum: ['upi', 'bank'] },` and the `payout_destination: { type: 'string', description: 'The UPI ID, or the bank account number with IFSC code.' },` properties (`:387-392`). `create_schedule`: description `'Set up a recurring transfer that repeats monthly or weekly. Collect all recipient details first, just like create_transfer.'` → `"Set up a recurring transfer that repeats monthly or weekly. Collect the recipient's name and WhatsApp number first — never bank details: the stored payout details for that number are reused automatically, otherwise the sender enters them on the secure page for each scheduled payment."`; DELETE `payout_method: { type: 'string', enum: ['upi', 'bank'] },` and `payout_destination: { type: 'string' },` (`:550-551`). `resolve_recipient`: replace the description string beginning `"Look up the sender's saved recipients by a name they typed` with `"Look up the sender's saved recipients by a name they typed (e.g. 'Mom'). Returns { match: 'exact', recipient } when exactly one saved recipient matches — use its recipient_phone directly (do not re-ask). Its payout_destination is a masked display value: NEVER pass payout details to another tool — the stored payout details are reused automatically. Returns { match: 'ambiguous', candidates } when more than one could match — call send_recipient_picker with the candidates. Returns { match: 'none' } when nothing matches — ask for the recipient's name, number and destination country (bank details are entered on the secure pay page)."`. `repeat_transfer`: its final sentence `If it returns needs_edd: true, ask the source-of-funds + occupation questions, then call send_approve_picker with all the details it returned plus those two fields.` → `If it returns needs_edd: true, ask the source-of-funds + occupation questions, then call send_approve_picker with the amount, source_currency, funding_method, destination_country, recipient_name and recipient_phone it returned plus those two fields (never payout details — the stored ones are reused automatically).` (`send_approve_picker`'s description, `:635`, is now accurate — unchanged.)

   (e) **`sendApprovePickerTool`:**
   - Replace `// G: default funding_method to bank_transfer when absent` / `const fundingMethod = (args.funding_method as FundingMethod | undefined) ?? 'bank_transfer';` with:
     ```ts
       // G: default funding_method to bank_transfer when absent. fix 6: a value outside
       // the schema enum (e.g. a model-invented 'bank_pull') is refused, never cast.
       const fundingArg = parseFundingArg(CHAT_FUNDING_METHODS, args.funding_method);
       if (fundingArg === null) return { error: fundingMethodError(CHAT_FUNDING_METHODS) };
       const fundingMethod: FundingMethod = fundingArg ?? 'bank_transfer';
     ```
   - DELETE (by content) the four comment lines beginning `// Item 2: bank details are entered on the secure pay page, not collected in` and the consts `const payoutMethod: PayoutMethod = (args.payout_method …` / `const payoutDestination = typeof args.payout_destination …`.
   - Directly after this tool's `const amountSource = Number(args.amount_source ?? args.amount_usd);` (the line directly above `// Cap enforcement (defense in depth — check_send_limit + this + create_transfer)`; `:2783` on bf4b083 — below Task 9's `resolved` destructuring, which supplies `sourceCurrency`, and the verify gate; above the cap check):
     ```ts
       if (b2b) {
         const notOwnBill = await refuseUnlessOwnOpenBill(ctx, args, b2b, amountSource, sourceCurrency);
         if (notOwnBill) return notOwnBill;
       }
     ```
   - Directly above `// Screen at card-show (read-only) BEFORE creating the draft. Quote first so a`:
     ```ts
       // ── Payout destination: SERVER-SIDE ONLY (fix 6 / audit ctx-01) ─────────
       // args.payout_* are NEVER read: the sender's OWN stored record for this number
       // in this destination country, or '' (cold start — the secure pay page). A
       // B2B payee never comes from the sender's address book ('' — the partner
       // pays the payee). After the verify + cap gates (a refused call decrypts
       // nothing), before screening (a blocked attempt never records a model string).
       const stored = b2b ? null : await resolveStoredPayout(ctx, recipientPhone, destinationCountry);
       const payoutMethod: PayoutMethod = stored?.payoutMethod ?? 'bank';
       const payoutDestination = stored?.payoutDestination ?? '';
     ```
   - In the `recordBlockedAttempt` call replace the two comment lines above `payoutDestination,` (`// Item 2: bank details aren't collected in chat — the screener matches` / `// on name, not the account number — so a blocked attempt records ''.`) with `// fix 6: the sender's stored destination for this number, or '' — never a` / `// model-supplied value (the screener matches on name, not the account).`.

   (f) **Approve-tap catch** (`if (ctxDraftId)` block; Task 9's `const refusal = fxRefusal(err, 'create_transfer'); …`) — insert directly above that catch's `throw err;`:
     ```ts
           if (err instanceof MaskedDestinationError) {
             // fix 6: a pre-fix draft carrying a display placeholder. Nothing was
             // written — put the draft back under ITS tenant; its secure pay link now
             // collects the bank details.
             await ctx.draftStore.restoreDraft(draft, ctxDraftId);
             return {
               error:
                 "This approval has no usable bank details. Ask the customer to tap Approve & Pay on the card and enter the recipient's bank details on the secure page.",
             };
           }
           if (err instanceof PartnerPulledConsumerError) {
             // fix 6: a pre-fix consumer draft carrying a partner-pulled method — dead.
             return { error: 'That approval is no longer valid. Ask the customer to start the send again.' };
           }
     ```

   (g) **Legacy explicit-args path:**
   - After the recipient-phone validation block and above Task 9's `// Resolve currency + rates` / `let legacyResolved`:
     ```ts
       // fix 6: funding_method is a closed set.
       const legacyFundingArg = parseFundingArg(CHAT_FUNDING_METHODS, args.funding_method);
       if (legacyFundingArg === null) return { error: fundingMethodError(CHAT_FUNDING_METHODS) };
       const legacyFunding: FundingMethod = legacyFundingArg ?? 'bank_transfer';
     ```
   - Directly after the legacy path's `const amountSource = Number(args.amount_source ?? args.amount_usd);` (the line directly above `// Cap check on the legacy path (cron-fired or no-button cold-start)`; `:1318` on bf4b083 — below Task 9's `legacyResolved` destructuring, which supplies `sourceCurrency`, and the verify gate):
     ```ts
       if (legacyB2b) {
         const notOwnBill = await refuseUnlessOwnOpenBill(ctx, args, legacyB2b, amountSource, sourceCurrency);
         if (notOwnBill) return notOwnBill;
       }
     ```
   - Directly above `const legacySof = asEnum(SOURCE_OF_FUNDS, args.source_of_funds);`:
     ```ts
       // fix 6: the payout destination is SERVER-SIDE only (never args.payout_*).
       const legacyPayout = legacyB2b ? null : await resolveStoredPayout(ctx, recipientPhone, legacyDestCountry);
     ```
   - In that path's `createTransfer({ … })` replace `payoutMethod: (args.payout_method as PayoutMethod | undefined) ?? 'bank',` / `// Item 2: bank details come from the secure pay page; legacy reads default to ''.` / `payoutDestination: typeof args.payout_destination === 'string' ? args.payout_destination : '',` / `fundingMethod: (args.funding_method as FundingMethod | undefined) ?? 'bank_transfer',` (`:1344-1347`) with:
     ```ts
           payoutMethod: legacyPayout?.payoutMethod ?? 'bank',
           // fix 6: the sender's own stored record for this number, or '' (the secure pay page collects it).
           payoutDestination: legacyPayout?.payoutDestination ?? '',
           fundingMethod: legacyFunding,
     ```
     and `recordFundingMethod(ctx.partnerId, ctx.phone, args.funding_method as FundingMethod)` (`:1369`) → `recordFundingMethod(ctx.partnerId, ctx.phone, legacyFunding)`. (No new catch arm: both new errors are unreachable here.)

   (h) **`createScheduleTool`:** after its recipient-phone validation block:
     ```ts
       // fix 6: a schedule is a consumer send — funding_method is a closed set.
       const scheduleFundingArg = parseFundingArg(CONSUMER_FUNDING_METHODS, args.funding_method);
       if (scheduleFundingArg === null) return { error: fundingMethodError(CONSUMER_FUNDING_METHODS) };
     ```
     directly above `const schedule: Schedule = {`:
     ```ts
       // fix 6: SERVER-SIDE payout only; cron mints a schedule with no destination
       // country, i.e. DEFAULT_DESTINATION_COUNTRY.
       const schedulePayout = await resolveStoredPayout(ctx, recipientPhone, DEFAULT_DESTINATION_COUNTRY);
     ```
     and in the literal replace the four lines `payoutMethod: (args.payout_method as Schedule['payoutMethod'] | undefined) ?? 'bank',` / `// Item 2: …` / `payoutDestination: typeof args.payout_destination === 'string' ? args.payout_destination : '',` / `fundingMethod: (args.funding_method as Schedule['fundingMethod'] | undefined) ?? 'bank_transfer',` (`:2592-2595`) with `payoutMethod: schedulePayout?.payoutMethod ?? 'bank',` / `// fix 6: the sender's own stored record, or '' (collected on the pay page each run).` / `payoutDestination: schedulePayout?.payoutDestination ?? '',` / `fundingMethod: scheduleFundingArg ?? 'bank_transfer',`.

   (i) **`repeatTransferTool`:** after its phone validation: `const repeatFundingArg = parseFundingArg(CONSUMER_FUNDING_METHODS, args.funding_method); if (repeatFundingArg === null) return { error: fundingMethodError(CONSUMER_FUNDING_METHODS) };` (with a `// fix 6: funding_method is a closed set (the schema's consumer enum).` comment); DELETE, by content, from `// The default ledger read MASKS payout destinations (****last4) — a repeat` through the `'';` ending `realPayoutDestination` (`:2989-2998`); replace the funding fallback (`:3007-3010`) with:
     ```ts
       // fix 6: never carry a partner-pulled method (a B2B bill's ach_pull / bank_pull,
       // remembered or last-used) into a chat draft — consumer methods only.
       const fundingMethod: FundingMethod =
         repeatFundingArg ??
         asEnum(CONSUMER_FUNDING_METHODS, customer?.lastFundingMethod) ??
         asEnum(CONSUMER_FUNDING_METHODS, last.fundingMethod) ??
         'bank_transfer';
     ```
     in the `needs_edd` branch directly above its `return {`: `const stored = await resolveStoredPayout(ctx, recipientPhone, last.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY);` (comment: `// fix 6: surface the stored destination MASKED; the follow-up card rehydrates by itself.`), and in that return replace `payout_method: last.payoutMethod,` / `payout_destination: realPayoutDestination,` with `payout_method: stored?.payoutMethod ?? last.payoutMethod,` / `payout_destination: stored ? maskAccount(stored.payoutMethod, stored.payoutDestination) : '',` / `destination_country: last.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY,`; in the final `sendApprovePickerTool({ … }, ctx)` call DELETE `payout_method: last.payoutMethod,` and `payout_destination: realPayoutDestination,` and ADD `destination_country: last.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY,` after `recipient_phone: recipientPhone,`.

   (j) **`src/lib/prompt.ts` — content-anchored** (never line numbers — Task 9 inserted two lines after `:82`): replace the whole line beginning `- If you see a "[RECIPIENT SELECTED] ..." note` with `- If you see a "[RECIPIENT SELECTED] ..." note (the user tapped a saved-recipient button), you ALREADY have that recipient's name + number. Do NOT call send_recipient_picker or ask who again — go straight to collecting the amount, then send_approve_picker with recipient_name + recipient_phone. NEVER pass payout_method or payout_destination to any tool — the system reuses the stored payout details for that number automatically.`; the whole line beginning `  • match "exact"     → use the returned recipient's payout_method` with `  • match "exact"     → use the returned recipient's recipient_phone (and destination_country, when given) directly. Do NOT ask for bank details, and do NOT pass payout_method or payout_destination to any tool — the returned payout_destination is a masked display value; the system reuses the stored payout details for that number automatically. Continue with amount, then send_approve_picker.`; the whole line beginning `- If repeat_transfer returns needs_edd: true` with `- If repeat_transfer returns needs_edd: true, ask the enhanced-verification questions (source of funds + occupation) first, then call send_approve_picker with the amount, source_currency, funding_method, destination_country, recipient_name and recipient_phone it returned plus those two fields — never payout_method or payout_destination (the system reuses the stored payout details).` (No new `content:` literal; none of `partner` / `corridor` / `watchlist` / `sanctions` — `tests/bot-content-guard.test.ts:9-60`; every `tests/prompt.test.ts` phrase, incl. Task 9's two rules, stays.)

   (k) **`src/lib/agent.ts`:** replace `'Just collect the amount and funding method, then send_approve_picker.',` with `'Just collect the amount and funding method, then send_approve_picker with recipient_name + recipient_phone — never payout_method or payout_destination (the stored payout details are reused automatically).',` (the `payout_destination=${found.payoutDestination}` data field stays until Task 2 — ruling 15; `tests/agent.test.ts:1079-1095` pins it).

   **Suites re-checked.** Every suite call passing `payout_method` / `payout_destination` — `grep -n "payout_destination: '" tests/tools.test.ts` → `:363,389,413,440,462,481,505,535,577,604,618,640,652,662,673,695,805,837,859,1080,1111,1135,1160,1207,1228,1254,1600,1618,1752,1820,1833,2052,2075,2132,2340,2412,2800,3347,3476,3774` (plus `:3790`), `tests/e2e.test.ts:92,197,328`, `tests/partner-orchestration.test.ts:105,155,185,211` — now mints/drafts `''`/`'bank'` or the rehydrated account; none asserts the destination/method except the two repeat fixtures updated above and `:1192-1193` (cold start, still `''`/`'bank'`). `e2e.test.ts:155-293` seeds Mom (IN number, IN send) → rehydrated; `lastUsedAt` advances (`:290-292`). `entity_type: 'business'` / `funding_method: 'ach_pull'` appear only in `tests/tools.test.ts:3322,3372,3419` (+`get_quote` `:3363`, quote-only) — all three now seed the bill (above); no other suite drives a chat B2B send. Suite `funding_method` values are only the four enum members.

4. **Run:** `npx vitest run tests/tools.test.ts tests/agent.test.ts tests/prompt.test.ts tests/bot-content-guard.test.ts tests/web-content-guard.test.ts tests/web-chat.test.ts tests/e2e.test.ts tests/partner-orchestration.test.ts` → green (re-run a single file on a PGlite parallel flake, per CLAUDE.md).

5. **Commit:** `fix(whatsapp-agent): the model never chooses a payout destination, a partner-pulled method or the B2B shape — rehydrate the sender's own record server-side (ctx-01)`

---

#### Step 7 — Partner API edge refusal + the scheduled-send locks (RED → GREEN)

1. **Failing tests.**
   - `tests/partner-api-service.test.ts`: add `import { createIdempotencyRepo } from '@/db/repos/aux-repos';` after `import type { Partner } from '@/lib/types';`, append:

```ts
describe('fix 6 (ctx-01): a masked payout_destination is refused at the edge, before the claim', () => {
  it('inline masked destination → 422; no row, key unbound; the same key then mints with a real account', async () => {
    const { deps, store, db } = await harness();
    const masked = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-masked', txBody({
      beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '****7890' },
    }));
    expect(masked).toMatchObject({ ok: false, status: 422 });
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await createIdempotencyRepo(db).find('acme', 'idem-masked')).toBeNull();
    const retry = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-masked', txBody());
    expect(retry).toMatchObject({ ok: true, status: 201 });
    const [t] = await store.listTransfers();
    expect((await store.getTransferDecrypted(t.id))?.payoutDestination).toBe('1234567890');
  });

  it("an Idempotency-Key in the pay page's / B2B checkout's reserved namespace ('draft:', 'b2binvoice:') → 400; nothing bound, nothing minted", async () => {
    const { deps, store, db } = await harness();
    for (const key of ['draft:abc', 'b2binvoice:inv_1']) {
      expect(await createTransaction(deps, DELEGATED, 'pk_1', key, txBody()), key).toMatchObject({ ok: false, status: 400 });
      expect(await createIdempotencyRepo(db).find('acme', key), key).toBeNull();
    }
    expect(await store.listTransfers()).toHaveLength(0);
  });
});
```

   - Append to `tests/cron-run.test.ts` (`makeDeps` `:59-68`, `sched` `:43-53`, `seedVerified` `:24-30`; Task 9 returns `{ fired, failed }`):

```ts
describe('runDueSchedules — pre-fix schedules (fix 6 / ctx-01)', () => {
  async function runOnly(schedule: Schedule) {
    const { store, partnerStore, monthlyVolumeStore, customerStore, scheduleStore } = await makeDeps();
    await seedVerified(customerStore);
    await scheduleStore.saveSchedule(schedule);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const notified: string[] = [];
    const result = await runDueSchedules({
      store, partnerStore, customerStore, monthlyVolumeStore, scheduleStore, kycProvider, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });
    return { result, notified, store, scheduleStore };
  }

  it('a masked destination is NOT fired: no transfer, no link, counted in failed, lastRunAt untouched', async () => {
    const { result, notified, store, scheduleStore } = await runOnly({ ...sched('masked', 21), payoutMethod: 'bank', payoutDestination: '****9012' });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(notified).toHaveLength(0);
    expect(await store.listTransfers()).toHaveLength(0);
    expect((await scheduleStore.getSchedule('masked'))?.lastRunAt).toBeUndefined();
  });

  it('a partner-pulled funding method is NOT fired (a consumer row would never be charged)', async () => {
    const { result, store } = await runOnly({ ...sched('pulled', 21), fundingMethod: 'bank_pull' });
    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(await store.listTransfers()).toHaveLength(0);
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/partner-api-service.test.ts tests/cron-run.test.ts` → partner API `expected { ok: true, status: 201, … } to match object { ok: false, status: 422 }` and, for the reserved keys, `… to match object { ok: false, status: 400 }` (today `draft:abc` mints a 201); the cron tests pass once Step 3 is in (locks for the unchanged `cron-run.ts`; before Step 3 → `expected { fired: 1, failed: 0 } to deeply equal { fired: 0, failed: 1 }`).

3. **Implement** — `src/lib/partner-api-service.ts`:
   - **Reserved key namespace** — in `createTransaction`, directly after `if (!idempotencyKey) return err(400, 'Idempotency-Key header is required.');` (`:249` on bf4b083):
   ```ts
     // fix 6 (ctx-01): 'draft:' and 'b2binvoice:' keys belong to the pay page
     // (pay-finalize.ts:110, under the default tenant) and the B2B checkout
     // (b2b-pay-finalize.ts:84). transfer-repo's payoutEditable reads a
     // 'draft:' claim under default as "NOT partner-API-minted"; a partner key
     // there (the default tenant can hold API keys —
     // admin-dashboard/partners/actions.ts:346-354) would unlock the payout of
     // a transfer the partner supplied. Refused before any read or write.
     if (/^(draft|b2binvoice):/.test(idempotencyKey)) {
       return err(400, "Idempotency-Key may not begin with 'draft:' or 'b2binvoice:' (reserved).");
     }
   ```
   (The same check is case-sensitive like the guard's `LIKE 'draft:%'`, so the two can never disagree. Callers: `grep -rn "createTransaction(" src` → `src/app/api/partner/v1/transactions/route.ts:12` only, which trims the header and passes the result through `svcResponse` unchanged.)
   - **Masked destination** — `import { validatePayoutFields } from './payout-format';` → `import { isMaskedDestination, validatePayoutFields } from './payout-format';`; insert directly ABOVE the comment `// The LAST step before the claim, AFTER every body check (Task 2 Step 28`:
   ```ts
     // fix 6 (ctx-01): a masked display value is never an account. Refuse at the
     // edge — BEFORE the customer write and the idempotency claim — so a corrected
     // retry under the same key mints normally.
     if (isMaskedDestination(payoutDestination)) {
       return err(422, 'beneficiary payout_destination must be the recipient account, not a masked display value.');
     }
   ```
   (`createTransaction`'s catch — Task 9's shape — unchanged.) `src/app/docs/page.tsx` (transaction paragraph, by content): after `watchlist hit returns 422 and the attempt is recorded as <code>blocked</code>.` add ` A <code>payout_destination</code> that is a masked display value (for example <code>****1234</code> or <code>account on file</code>) is refused with 422 before the Idempotency-Key is bound. Idempotency-Key values beginning <code>draft:</code> or <code>b2binvoice:</code> are reserved and refused with 400. A payer can never change the beneficiary account of a transaction created through this API: every transaction is bound to its Idempotency-Key before it is created, and that binding locks the account.`

4. **Run:** `npx vitest run tests/partner-api-service.test.ts tests/cron-run.test.ts tests/tenant-boundary.test.ts` → green.

5. **Commit:** `fix(partner-api): refuse a masked payout_destination and a reserved Idempotency-Key prefix at the edge, before the claim (ctx-01)`

---

#### Step 8 — Read-only sweep + the separate, owner-run schedule-destination blanking (no migration; RED → GREEN)

No `drizzle/` file: all columns exist (`transfers` `:80,82,101`; `schedules` `:373-397`; `recipients` `:418-431`). Both scripts decrypt in process via `openOptional` (`mappers.ts:50-58`) and print ids, tenant, status, dates and last-4 of phones only.

1. **Failing tests.**
   - Create `tests/audit-masked-destinations.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { findMaskedDestinationRows } from '../scripts/audit-masked-destinations';
import type { Db } from '@/db/client';
import type { Schedule, Transfer } from '@/lib/types';

const SENDER = '15551234567';
const DAY = 86_400_000;

const t = (id: string, dest: string, over: Partial<Transfer> = {}): Transfer => ({
  id, phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17000,
  recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: dest,
  fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
  createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
  destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 0, totalChargeSource: 200,
  ...over,
});

const s = (id: string, dest: string, over: Partial<Schedule> = {}): Schedule => ({
  id, phone: SENDER, amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
  payoutMethod: 'bank', payoutDestination: dest, fundingMethod: 'bank_transfer', frequency: 'monthly',
  dayOfMonth: 5, status: 'active', createdAt: new Date(Date.now() - 2 * DAY).toISOString(), partnerId: 'default',
  sourceCurrency: 'USD', amountSource: 100, ...over,
});

describe('scripts/audit-masked-destinations — findMaskedDestinationRows (fix 6 / ctx-01)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('reports every ctx-01 footprint and prints no destination and no full phone', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(t('poisoned', '****9012'));
    await store.saveTransfer(t('poisoned_paid', 'account on file', { status: 'paid' }));
    await store.saveTransfer(t('real', 'HDFC0001234 123456789012'));
    await store.saveTransfer(t('empty', ''));
    await store.saveTransfer(t('pulled_consumer', 'HDFC0001234 123456789012', { fundingMethod: 'bank_pull' }));
    await store.saveTransfer(t('b2b_ach', '', { fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await store.upsertRecipient('default', SENDER, {
      name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '****9012',
      lastUsedAt: new Date().toISOString(),
    });
    await store.upsertRecipient('default', SENDER, {
      name: 'Dad', recipientPhone: '919811111111', payoutMethod: 'bank', payoutDestination: 'SBIN0001234 987654321',
      lastUsedAt: new Date().toISOString(),
    });
    const schedules = createScheduleStore(db);
    await schedules.saveSchedule(s('sch_masked', '****9012'));
    await schedules.saveSchedule(s('sch_invented', 'xxxx9012'));
    await schedules.saveSchedule(s('sch_empty', ''));
    await schedules.saveSchedule(s('sch_post', 'HDFC0001234 123456789012', { createdAt: new Date().toISOString() }));
    await schedules.saveSchedule(s('sch_pulled', '', { fundingMethod: 'ach_pull' }));

    const report = await findMaskedDestinationRows(db, { before: new Date(Date.now() - DAY) });

    expect(report.transfers.map((r) => r.id).sort()).toEqual(['poisoned', 'poisoned_paid']);
    expect(report.recipients).toHaveLength(1);
    expect(report.recipients[0]).toMatchObject({ partner_id: 'default', sender_last4: '4567', recipient_last4: '3210' });
    expect(report.schedules.map((r) => r.id)).toEqual(['sch_masked']);
    expect(report.pulledConsumerTransfers.map((r) => r.id)).toEqual(['pulled_consumer']);
    expect(report.nonConsumerFundingSchedules.map((r) => r.id)).toEqual(['sch_pulled']);
    expect(report.preFixScheduleDestinations.map((r) => r.id).sort()).toEqual(['sch_invented', 'sch_masked']);
    const printed = JSON.stringify(report);
    for (const secret of ['123456789012', '987654321', '9012', SENDER, '919876543210']) {
      expect(printed).not.toContain(secret);
    }
  });
});
```

   - Create `tests/blank-prefix-schedule-destinations.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { freshDb } from './helpers-db';
import { blankPreFixScheduleDestinations } from '../scripts/blank-prefix-schedule-destinations';
import type { Db } from '@/db/client';
import type { Schedule } from '@/lib/types';

const DAY = 86_400_000;
const s = (id: string, dest: string, over: Partial<Schedule> = {}): Schedule => ({
  id, phone: '15551234567', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
  payoutMethod: 'upi', payoutDestination: dest, fundingMethod: 'bank_transfer', frequency: 'monthly',
  dayOfMonth: 5, status: 'active', createdAt: new Date(Date.now() - 2 * DAY).toISOString(), partnerId: 'default',
  sourceCurrency: 'USD', amountSource: 100, ...over,
});

describe('scripts/blank-prefix-schedule-destinations (fix 6 / ctx-01)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    const store = createScheduleStore(db);
    await store.saveSchedule(s('pre', 'xxxx9012'));
    await store.saveSchedule(s('pre_cancelled', 'xxxx9012', { status: 'cancelled' }));
    await store.saveSchedule(s('pre_empty', ''));
    await store.saveSchedule(s('post', 'HDFC0001234 123456789012', { createdAt: new Date().toISOString() }));
  });

  it('DRY RUN (default) counts the pre-cutoff active schedules holding any destination and changes nothing', async () => {
    const r = await blankPreFixScheduleDestinations(db, { before: new Date(Date.now() - DAY), apply: false });
    expect(r).toEqual({ count: 1, ids: ['pre'], applied: false });
    expect((await createScheduleStore(db).getSchedule('pre'))?.payoutDestination).toBe('xxxx9012');
  });

  it('APPLY blanks exactly those to "" / bank — post-cutoff, cancelled and empty schedules untouched', async () => {
    const r = await blankPreFixScheduleDestinations(db, { before: new Date(Date.now() - DAY), apply: true });
    expect(r).toEqual({ count: 1, ids: ['pre'], applied: true });
    const store = createScheduleStore(db);
    expect(await store.getSchedule('pre')).toMatchObject({ payoutDestination: '', payoutMethod: 'bank' });
    expect((await store.getSchedule('pre_cancelled'))?.payoutDestination).toBe('xxxx9012');
    expect((await store.getSchedule('post'))?.payoutDestination).toBe('HDFC0001234 123456789012');
  });
});
```

2. **Run, expect failure:** `npx vitest run tests/audit-masked-destinations.test.ts tests/blank-prefix-schedule-destinations.test.ts` → `Failed to resolve import "../scripts/…"` for both.

3. **Implement.**
   - `scripts/audit-masked-destinations.ts`:

```ts
/**
 * READ-ONLY sweep for the ctx-01 blast radius left by rows written before Phase
 * 1 fix 6 (Program-Fix 10). SELECTs only; decrypts in process; prints ids,
 * tenant, status, dates and last-4 of phones — never a destination, never a
 * full phone number.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/audit-masked-destinations.ts [--before <fix deploy ISO>]
 *
 * After fix 6 (this script rewrites nothing):
 *   • placeholder transfers: awaiting_payment self-heal (the pay page collects);
 *     paid / in_review ones are REFUSED by the rail instruction → ops obtains the
 *     real account or refunds — never guess one.
 *   • placeholder recipients: self-heal (rehydration skips them).
 *   • CONSUMER transfers with a partner-pulled funding method: never captured —
 *     the pay route now refuses them and the rail instruction throws; review each.
 *   • active schedules with a non-consumer funding method: every run now fails.
 *   • active schedules holding ANY destination written before --before: a model
 *     invention (e.g. "xxxx9012") is not recognisable — blank them with the
 *     SEPARATE owner-run scripts/blank-prefix-schedule-destinations.ts.
 */
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import { recipients, schedules, transfers } from '@/db/schema';
import { defaultProvider } from '@/lib/field-crypto';
import { openOptional } from '@/db/repos/mappers';
import { isMaskedDestination } from '@/lib/payout-format';

const CONSUMER_FUNDING = ['credit_card', 'debit_card', 'bank_transfer'];

export interface MaskedRowsReport {
  transfers: { id: string; partner_id: string; status: string; created_at: string }[];
  recipients: { partner_id: string; sender_last4: string; recipient_last4: string; last_used_at: string }[];
  schedules: { id: string; partner_id: string; status: string }[];
  pulledConsumerTransfers: { id: string; partner_id: string; status: string; funding_method: string; created_at: string }[];
  nonConsumerFundingSchedules: { id: string; partner_id: string; funding_method: string }[];
  preFixScheduleDestinations: { id: string; partner_id: string; created_at: string }[];
}

/** Pure over the db handle; exported so the sweep is unit-tested on PGlite. */
export async function findMaskedDestinationRows(
  db: DbOrTx,
  opts: { before?: Date } = {},
): Promise<MaskedRowsReport> {
  const provider = defaultProvider();
  const masked = (blob: string | null) => isMaskedDestination(openOptional(blob, provider));

  const tRows = await db
    .select({ id: transfers.id, partnerId: transfers.partnerId, status: transfers.status, createdAt: transfers.createdAt, enc: transfers.payoutDestinationEnc })
    .from(transfers);
  const rRows = await db
    .select({ partnerId: recipients.partnerId, senderPhone: recipients.senderPhone, recipientPhone: recipients.recipientPhone, lastUsedAt: recipients.lastUsedAt, enc: recipients.payoutDestinationEnc })
    .from(recipients);
  const sRows = await db
    .select({ id: schedules.id, partnerId: schedules.partnerId, status: schedules.status, createdAt: schedules.createdAt, fundingMethod: schedules.fundingMethod, enc: schedules.payoutDestinationEnc })
    .from(schedules)
    .where(eq(schedules.status, 'active'));
  const pRows = await db
    .select({ id: transfers.id, partnerId: transfers.partnerId, status: transfers.status, fundingMethod: transfers.fundingMethod, createdAt: transfers.createdAt })
    .from(transfers)
    .where(and(eq(transfers.transferType, 'b2c'), inArray(transfers.fundingMethod, ['ach_pull', 'bank_pull'])));
  const preFix = opts.before
    ? await db
        .select({ id: schedules.id, partnerId: schedules.partnerId, createdAt: schedules.createdAt })
        .from(schedules)
        .where(and(eq(schedules.status, 'active'), ne(schedules.payoutDestinationEnc, ''), lt(schedules.createdAt, opts.before)))
    : [];

  return {
    transfers: tRows.filter((r) => masked(r.enc)).map((r) => ({ id: r.id, partner_id: r.partnerId, status: r.status, created_at: r.createdAt.toISOString() })),
    recipients: rRows.filter((r) => masked(r.enc)).map((r) => ({
      partner_id: r.partnerId, sender_last4: r.senderPhone.slice(-4), recipient_last4: r.recipientPhone.slice(-4),
      last_used_at: r.lastUsedAt.toISOString(),
    })),
    schedules: sRows.filter((r) => masked(r.enc)).map((r) => ({ id: r.id, partner_id: r.partnerId, status: r.status })),
    pulledConsumerTransfers: pRows.map((r) => ({
      id: r.id, partner_id: r.partnerId, status: r.status, funding_method: r.fundingMethod, created_at: r.createdAt.toISOString(),
    })),
    nonConsumerFundingSchedules: sRows
      .filter((r) => !CONSUMER_FUNDING.includes(r.fundingMethod))
      .map((r) => ({ id: r.id, partner_id: r.partnerId, funding_method: r.fundingMethod })),
    preFixScheduleDestinations: preFix.map((r) => ({ id: r.id, partner_id: r.partnerId, created_at: r.createdAt.toISOString() })),
  };
}

function parseBefore(argv: string[]): Date | undefined {
  const i = argv.indexOf('--before');
  if (i < 0) return undefined;
  const d = new Date(argv[i + 1] ?? '');
  if (Number.isNaN(d.getTime())) throw new Error('--before needs an ISO timestamp (the fix 6 deploy time).');
  return d;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
  const before = parseBefore(process.argv);
  console.log(`\nctx-01 audit against ${host} — ${new Date().toISOString()}${before ? ` (pre-fix cutoff ${before.toISOString()})` : ''}`);
  const report = await findMaskedDestinationRows(getDb(), { before });
  const section = (title: string, rows: Record<string, unknown>[]) => {
    console.log(`\n${title}`);
    if (rows.length === 0) console.log('  none');
    else console.table(rows);
  };
  section('TRANSFERS whose payout destination is a display placeholder', report.transfers);
  section('RECIPIENTS holding a placeholder — self-heal', report.recipients);
  section('ACTIVE SCHEDULES carrying a placeholder', report.schedules);
  section('CONSUMER TRANSFERS with a partner-pulled funding method — review each', report.pulledConsumerTransfers);
  section('ACTIVE SCHEDULES with a non-consumer funding method — cancel or re-create', report.nonConsumerFundingSchedules);
  section('ACTIVE SCHEDULES holding ANY destination written before the cutoff — blank via the separate script', report.preFixScheduleDestinations);
  console.log(
    `\nSUMMARY: transfers=${report.transfers.length} recipients=${report.recipients.length} schedules=${report.schedules.length} ` +
    `pulledConsumer=${report.pulledConsumerTransfers.length} nonConsumerFundingSchedules=${report.nonConsumerFundingSchedules.length} ` +
    `preFixScheduleDestinations=${before ? report.preFixScheduleDestinations.length : 'n/a (pass --before)'}\n`,
  );
}

if (process.argv[1]?.endsWith('audit-masked-destinations.ts')) {
  main().then(() => process.exit(0)).catch((e) => { console.error('audit-masked-destinations failed:', e); process.exit(1); });
}
```

   (The non-consumer-funding filter runs in JS over the active-schedule set already selected.)
   - `scripts/blank-prefix-schedule-destinations.ts`:

```ts
/**
 * OWNER-RUN, REVIEWED remediation (fix 6 / ctx-01). Before fix 6, create_schedule
 * stored whatever payout destination the model supplied; a model invention
 * (e.g. "xxxx9012") is indistinguishable from a real account, so EVERY active
 * schedule created before the fix deploy that holds a destination is blanked to
 * '' / 'bank' — each run then collects the account on the secure pay page.
 *
 * DRY RUN by default — prints the count and schedule ids only:
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/blank-prefix-schedule-destinations.ts --before <fix deploy ISO>
 * Apply ONLY after the owner reviewed the dry-run count:
 *   … scripts/blank-prefix-schedule-destinations.ts --before <fix deploy ISO> --apply
 */
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import { schedules } from '@/db/schema';

export async function blankPreFixScheduleDestinations(
  db: DbOrTx,
  opts: { before: Date; apply: boolean },
): Promise<{ count: number; ids: string[]; applied: boolean }> {
  const due = and(eq(schedules.status, 'active'), ne(schedules.payoutDestinationEnc, ''), lt(schedules.createdAt, opts.before));
  const ids = (await db.select({ id: schedules.id }).from(schedules).where(due)).map((r) => r.id).sort();
  if (opts.apply && ids.length > 0) {
    await db
      .update(schedules)
      .set({ payoutMethod: 'bank', payoutDestinationEnc: '', payoutDestinationLast4: '' })
      .where(and(inArray(schedules.id, ids), due));
  }
  return { count: ids.length, ids, applied: opts.apply };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const i = process.argv.indexOf('--before');
  const before = new Date(i >= 0 ? (process.argv[i + 1] ?? '') : '');
  if (Number.isNaN(before.getTime())) {
    console.error('--before <ISO> is required: the fix 6 deploy time (schedules created after it hold server-rehydrated destinations).');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const r = await blankPreFixScheduleDestinations(getDb(), { before, apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${r.count} active schedule(s) created before ${before.toISOString()} ${apply ? 'blanked' : 'would be blanked'}.`);
  if (r.ids.length) console.log(r.ids.join('\n'));
}

if (process.argv[1]?.endsWith('blank-prefix-schedule-destinations.ts')) {
  main().then(() => process.exit(0)).catch((e) => { console.error('blank-prefix-schedule-destinations failed:', e); process.exit(1); });
}
```

   (Both scripts are unmapped in `.claude/hooks/components.json`; typechecked via `tsconfig.json` `"include": ["**/*.ts"]` and linted by `eslint .` like `scripts/outbox-status.ts`; the `process.argv[1]` guard keeps `main()` out of vitest.)

4. **Run:** `npx vitest run tests/audit-masked-destinations.test.ts tests/blank-prefix-schedule-destinations.test.ts && npx tsc --noEmit` → green, clean.

5. **Commit:** `chore(ops): read-only ctx-01 sweep and an owner-run, dry-run-first blanking of pre-fix schedule destinations`

---

#### Step 9 — Whole-task verification (the Stop hook enforces it; quote the output verbatim in the PR)

1. **Contract stragglers** — each must print only the sites listed:
   ```
   grep -rn "realPayoutDestination" src/                                          # → nothing
   grep -n "args.payout_destination\|args.payout_method" src/lib/tools.ts         # → nothing
   grep -n "payout_destination: {\|payout_method: {" src/lib/tools.ts             # → nothing
   grep -n "args.funding_method as" src/lib/tools.ts                              # → get_quote only
   grep -rn "bank_details_required" src/                                          # → pay-finalize.ts (union + refusal), route.ts (arm)
   grep -rn "MaskedDestinationError\|PartnerPulledConsumerError" src/             # → transfer-create.ts (classes + throws), tools.ts (import + approve-tap catch)
   grep -rn "setPayoutIfEditable\|isPayoutEditable" src/                          # → transfer-repo.ts (defs), route.ts (writePayoutIfEditable), page.tsx
   grep -n "store.saveTransfer(" "src/app/api/pay/[transferId]/route.ts"          # → nothing (no whole-row re-save of a masked read: payout or ACH mandate)
   grep -rn "setAchTokenIfAbsent" src/                                            # → transfer-repo.ts (def), route.ts (bindAchToken)
   grep -n "'HK', 'MX'" "src/app/api/pay/[transferId]/route.ts"                   # → VALID_COUNTRY_CODES
   grep -n "draft|b2binvoice" src/lib/partner-api-service.ts                      # → the reserved-key refusal
   grep -n "fundingMethod === 'ach_pull'\|isPartnerPulled(" "src/app/api/pay/[transferId]/route.ts"  # → each paired with transferType === 'b2b' (or the consumer refusal)
   grep -rn "resolveStoredPayout(" src/                                           # → tools.ts: def + picker, legacy, create_schedule, repeat needs_edd
   grep -n "\[fix 6 inserts above this line\]" src/lib/pay-finalize.ts            # → still present, destination block directly above it
   grep -rn "createTransfer(" src/ | grep -v "src/lib/transfer-create.ts"         # → exactly 6
   ```
2. **Full proof:**
   ```
   npm run typecheck
   npm run lint
   npx vitest run
   npm run build
   ```
   Expected: tsc 0 errors; eslint 0 problems; vitest **176 files, 2424 tests** passed (baseline 173/2352 + the Step 0.5 delta — if the baseline differed, baseline + 3 files / + 72 tests); `next build` exit 0 (CI runs it — `.github/workflows/ci.yml:63-64`).
3. **CI migration drift check** (as `.github/workflows/ci.yml:38-52`): `npx drizzle-kit generate --name ci_drift_check`, then `git status --porcelain -- drizzle/` → empty, then `git checkout -- drizzle/ && git clean -fdq drizzle/`.
4. **`/security-review`** — must confirm (quoted in the PR): no model-controlled value becomes a payout destination, a partner-pulled method or the B2B shape; the `''` exemption keys on the draft's `transferType` + `fundingMethod`; a B2B payee is never payer input (draft body ignored; existing-row body ignored); every pay-page payout write is the single guarded UPDATE (status / funding_ref / b2c / tenant / partner-API markers in the WHERE) + an audit row with last-4 only; the ACH mandate bind is a guarded `ach_token_ref`-only UPDATE; no whole-row re-save of a masked read remains in the route; the partner API cannot claim a `draft:` / `b2binvoice:` key; capture skip / ACH branch key on `transferType === 'b2b'`; consumer partner-pulled rows are refused by createTransfer, pay-finalize, the route and the rail builder; the body country is bound to the payment; no destination string in any log / error / tool result; new queries all carry `partner_id`.
5. **Final review** (Fable 5.1): rulings 7, 13, 14, 16, 17, 23 as before; plus the race and partner-API tests in Step 5 exist and pass.

---

#### Step 10 — PR, merge, live verification, owner remediation

1. `git push -u origin fix/whatsapp-agent/no-masked-destination-mint`; PR against `main`, title `fix(whatsapp-agent): stop minting and settling the masked "****last4" placeholder as the payout account (Phase 1 fix 10)`. Body: `Program-Fix: 10` on its own line; finding ctx-01 + defects 2 and 7; rulings 7, 13, 14, 15, 16, 17, 23, 31 (and the deliberate deviation: the destination refusal sits below screening so blocked rows are always recorded); the design + chokepoints; boundary acknowledgement (corridors-fx / money-paths / pay-page / platform-security / partner-api / landing-docs); "no migration" + drift output; **behaviour changes:** (1) no chat tool reads a model-supplied destination; two schemas lose the fields; (2) `funding_method` is a closed set per tool; a chat B2B send requires the sender's own unpaid, seller-less USD bill, paid with `ach_pull` for exactly its amount (a card-funded chat B2B bill is no longer possible; a registered seller's bill is steered to its checkout link); (3) consumer transfers can never carry a partner-pulled method (createTransfer, pay-finalize, route, rail); the route skips capture / takes the ACH branch only for B2B; (4) blocked mints save only the audit row; (5) `''` mints never overwrite a saved account; B2B mints never write the address book; (6) a draft with no destination and no body → 400 unless B2B ach_pull; a B2B draft ignores the bank-details body; (7) a repeat stays in its corridor; (8) the pay page offers **Edit bank details** for a prefilled consumer destination; pay-page payout writes on existing transfers are one guarded, audited UPDATE (409 `payout_locked` when not editable — charged, partner-API-minted), and a body never touches a B2B payee (the old "fill a missing B2B destination" allowance is gone); the body's `country` must match the payment; (9) `needs_edd` returns a masked destination; (10) partner API 422 for a masked `payout_destination` and 400 for an `Idempotency-Key` beginning `draft:` / `b2binvoice:`; (10a) the pay page accepts HK and MX bank forms; the B2B ACH mandate bind is a guarded column write; (11) the rail instruction refuses a placeholder or a consumer partner-pulled row. **Residuals:** Task 2 owns the `[RECIPIENT SELECTED]` full destination and the `maskAccount` UPI passthrough (rulings 14/15) and partner-API inline destination shape validation (Step 28); the OTP verify itself stays non-atomic (`transaction-otp.ts:59-83`) — its consequence for payout writes is closed by the guarded UPDATE, the atomic `GETDEL` belongs to the OTP owner; `+1` numbers resolve to US, so a Canadian recipient's saved account is not rehydrated for a CA send (the settled-ledger fallback still covers it); partner-API detection relies on the claim-first idempotency row (bound before the insert, so present on every partner-API row) plus the `transaction.create` audit event as a second marker; the partner API now refuses `draft:` / `b2binvoice:` keys (400), so the only row that can escape both markers is one minted BEFORE this fix under a `draft:`-prefixed key by the default tenant whose audit write was then lost to a crash between the insert and the audit (`partner-api-service.ts:315-340` — the audit is outside any transaction and the replay at `:297-299` writes none); the sweep cannot tell that shape from a pay-page draft, so the owner runs `SELECT count(*) FROM api_keys WHERE partner_id = 'default'` (revoked keys included — `schema.ts:355-364`) before merge: 0 ⇒ the shape cannot exist; pre-fix consumer partner-pulled rows and card-funded B2B drafts are dead-ended loudly and listed by the sweep; an Edit on an existing transfer does not refresh the address book; the mock (demo) rail never builds an instruction; `HttpPaymentProvider.initiateTransfer` has no caller (ruling 24). Quoted tsc / eslint / vitest (176/2424) / build output; security-review summary; the attribution lines from the session reminder. Wait for `ci / ci`.
2. **Chrome walk-through** (preview first — `vercel:access-protected-vercel-deployment` for a protected preview — then prod): (i) returning demo customer with a saved **bank** recipient (Indian number) in `/account/chat` asks to send again → the pay link shows no bank step, "Paying to account ending ####", and **Edit bank details** switching to the two-step form; page source / network carry ≤4 account digits; (ii) WhatsApp demo number, a send to a **new** number even typing an account in chat → Step 1 renders; (iii) after merge, simulator partner only: complete (i) once as-is and once via Edit; `/admin-dashboard/transactions/<id>` masks the saved/edited account and the audited `pii.reveal` shows the real one; the audit log shows `transfer.payout_edit` with last-4 only.
3. **Before merging**, the owner runs `SELECT count(*) FROM api_keys WHERE partner_id = 'default'` against prod Neon (a `!` command — this session cannot source `.env.local`) and the number goes in the PR (see the partner-API residual). Squash-merge (no migration). `/post-merge-check` (post-deploy `smoke.yml` green for the merge SHA; it runs `/tracker-sync`), then `/sync-branches`. **Owner remediation, in this order, each output reviewed before the next:** (a) `set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/audit-masked-destinations.ts --before <merge-deploy ISO>` → paste only the `SUMMARY:` line and the transfer / schedule ids into the merge note; ops tickets for paid / in_review placeholder transfers and every `pulledConsumer` row (obtain the real account or refund — never guess); cancel `nonConsumerFundingSchedules`; (b) `node_modules/.bin/tsx scripts/blank-prefix-schedule-destinations.ts --before <merge-deploy ISO>` (DRY RUN) → paste the count; (c) only after the owner approves that count, re-run with `--apply` and paste the `APPLIED:` line. Mark Program-Fix 10 `done` in the ledger only when merged + smoke green + verified.

---

#### Rebase notes for the tasks that land after this one

- **Task 5 (Program-Fix 9), next in wave 2:** its `tools.ts` edits (`cancelBillTool`) and `route.ts` comment are disjoint (ruling 20; `wave2/task-05.md:110,1000`); re-cite by content — the route's existing-transfer branch now has the consumer-partner-pulled refusal, the B2B-keyed ACH branch and the guarded payout write; its `transfer-repo.ts` `cancelIfCancellable` sits beside this task's five new methods.
- **Task 11 (Program-Fix 18):** its `tools.ts` enqueue sites are disjoint (ruling 20).
- **Task 10 (Program-Fix 16), wave 3 (ruling 31):** in Task 9's words (`task-09.md:65`), "Task 6 inserts its masked-destination block directly above [the marker]; Task 10 anchors on the same marker line and places its cap check after this FX block, before `idem.claim`" — this task's block is directly above the marker, which stays verbatim. Task 10's ordering test (masked + stale `quote.fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1` + over-cap ⇒ `bank_details_required`) holds; a consumer partner-pulled draft refuses even earlier (`expired_or_used`). In `createTransfer` the cap check goes between the placeholder refusal and `await store.saveTransfer(transfer)` — never above the blocked-row early return; its counter deletion removes the two accrual lines below `saveTransfer`.
- **Task 2 (Program-Fix 5), last in wave 3:** may remove the `maskAccount` UPI passthrough and mask the `[RECIPIENT SELECTED]` note; keeps this task's three prompt rules; its Step 28 partner-API destination validation goes above the same `// The LAST step before the claim` comment.
- **Task 4 (Program-Fix 8), wave 3:** keeps both backstop throws at the top of `buildSettlementInstruction` (ruling 23).
- **Task 13 (Program-Fix 23), wave 4 (ruling 32):** its fail-open throttle goes above `getTransfer` and this task's decrypted read / `isPayoutEditable` in `page.tsx`; its CSPRNG `newTransferId` is unaffected.


---

### Task 5: Stop staff "Cancel" (and the customer chat `cancel_bill`) from voiding a paid, charged or held transfer (money-05, the prevention half on top of PR #256)

**Program-Fix:** 9 · **Finding:** money-05 (`docs/AUDIT-2026-09-14.md:105` manifest row, `:3859` finding, `:4018` §1.4(c)) · **Component:** admin-dashboard · **Branch:** `fix/admin-dashboard/safe-staff-cancel` · **Model:** Fable 5.1 (money path) for the build and the final review · **Wave 2**, merge order 9 → 6 → **5** → 11 (wave table + rulings 5, 21, 22 in `docs/superpowers/plans/2026-09-16-phase1-wave1-money-safe-core.md:27,46,62,63`) · **Migration:** none.

Every `file:line` below was read at `origin/main` = `bf4b083`. Tasks 9 (Program-Fix 13) and 6 (Program-Fix 10) merge before this one; Step 0 re-cites the lines this task edits after rebasing onto them.

**Numbering and attribution conventions** (unchanged from wave 1; same as Tasks 9, 6 and 11):
- In code comments, "fix N" means plan **Task** N; that is why `route.ts:182` and `reconcile.ts:160` already say "fix 5" for this task.
- The PR title uses the manifest number: **"(Phase 1 fix 9)"**. The PR body carries `Program-Fix: 9` on its own line.
- **Every commit message and the PR body end with the attribution trailer lines (`Co-Authored-By:` / `Claude-Session:` and the PR footer) exactly as the EXECUTING session's system reminder gives them.** The commit bodies below leave them out on purpose. Never hardcode a model name or session URL.

---

#### What PR #256 already fixed, and what is left of money-05

PR #256 (Program-Fix 6) touched this area on purpose, but only the **race** and **detection** halves:

| # | Covered by #256 | Where (bf4b083) |
|---|---|---|
| a | `cancelTransfer` no longer does a stale full-row `saveTransfer`. It does a status-guarded, column-targeted `store.updateTransferIfStatus(id, <read status>, { status: 'cancelled' })` and throws `"…changed concurrently…"` if the row moved. A cancel can no longer clobber a concurrent `paid` or `delivered`. | `src/lib/dashboard-ops.ts:31-36`; `src/db/repos/transfer-repo.ts:362-382` (`updateIfStatus`); `src/lib/store.ts:100-107`; test `tests/dashboard-ops.test.ts:556-564` |
| b | The `settlement.instruct` handler skips a `cancelled` row (marked done, `outbox.instruct-skipped` warning). A cancel that lands **before** the drain means the rail is never told to pay out. | `src/lib/outbox-worker.ts:256-269` |
| c | The pay route refuses to capture a non-`awaiting_payment` (for example, staff-cancelled) transfer (F53), and logs `pay.charged-but-cancelled` for the capture↔cancel race. | `src/app/api/pay/[transferId]/route.ts:62-70`, `:176-190` |
| d | The sweep raises a `cancelcharged:<id>` ops alert for `cancelled + funding_ref IS NOT NULL + refund_status = 'none'`. This is detection only. | `src/lib/reconcile.ts:182-195`; `src/db/repos/transfer-repo.ts:570-579` (`findCancelledCharged`) |

**Still open. Prevention was never done:**

1. **`cancelTransfer` still flips a PAID custodial transfer to `cancelled` with no refund.** The only refusal is `paid && isPartnerPulled` (`dashboard-ops.ts:26-30`); every other paid row reaches the guarded flip at `:33`. The test that asserts the bug is still on main: `tests/dashboard-ops.test.ts:63-69` (`'sets status to cancelled for paid'`). What happens next:
   - The sender's charge is never returned. Pay-page rows **are** charged: `MockFundingProvider.capture` returns `mockfund-<id>` (`src/lib/providers/funding-provider.ts:52-55`), and the route writes it before settling (`route.ts:46-48`, `:158-165`).
   - If the instruction was already POSTed, the partner pays out and the `paid_out` callback is dropped (`transfer-repo.ts:156` refuses `cancelled`).
   - `findStuckPaid` never looks at the row again (`transfer-repo.ts:588`).
   - The remedy is locked out: `issueRefund` accepts only `paid|delivered` (`dashboard-ops.ts:219-223`). So the `cancelcharged:` alert's advice, "refund it by hand", has no in-app path.
2. **A CHARGED `in_review` or CHARGED `awaiting_payment` row can be bare-cancelled.**
   - Direct POST to `cancelTransferAction` (`src/app/admin-dashboard/actions.ts:57-66`): server actions are public POST endpoints.
   - The B2B page's Cancel button, which renders for every `awaiting_payment | in_review` B2B row (`src/app/admin-dashboard/b2b/page.tsx:263-275`). A **card-funded** B2B bill is charged (`src/lib/pay-finalize.ts:145-151`: "a B2B bill paid via the card"; capture at `route.ts:158-165`), so the button voids a charged hold with no refund.
   - `rejectTransfer` (cancel + auto-refund in one transaction, `dashboard-ops.ts:166-197`) is the only safe exit for a charged hold, and Cancel bypasses it.
   - A charged `awaiting_payment` row (crash between capture and settle) is taken out of the resume sweep's reach, because `listAwaitingWithFunding` reads only `awaiting_payment` (`transfer-repo.ts:263-275`).
3. **`blocked` can be cancelled by direct POST.** The read status is `blocked`, so the guarded update matches. This rewrites a terminal sanctions state and moves the row out of the Blocked tab.
4. **The UI still offers Cancel on paid rows:** `(t.status === 'awaiting_payment' || t.status === 'paid') && canCancel` (`src/app/admin-dashboard/transactions-tabs.tsx:256-261`).
5. **Permission escalation hidden in 1-4.** `canCancel` can be granted to NON-admin staff (`src/lib/permissions.ts:3-9`, `src/app/admin-dashboard/team/page.tsx:111`; role `'agent'`, `src/lib/types.ts:237`), but every money-returning action is `requireAdmin` (`actions.ts:133-139` reject, `:148-154` refund; `src/lib/auth.ts:36-40`). Cancel must therefore never stand in for a refund. It may only void rows with no money behind them.
   - **The same escalation applies to compliance decisions (Wave 2 review finding).** Voiding an UNCHARGED `in_review` hold ends a compliance review, and today a non-admin can do it: any `canCancel` agent by direct POST to `cancelTransferAction`, and any platform-scoped staffer from the B2B page. `cancelB2bTransferAction` checks only platform scope (`b2b/actions.ts:32-38`) and never checks `canCancel` or role.
   - The only admin-gated exits from a hold are Release (`requireAdmin` + `canReleaseHeld`, a settlement: `actions.ts:112-125`) and Reject (`requireAdmin`; cancel-only when uncharged, cancel + auto-refund when charged: `actions.ts:133-139`, `dashboard-ops.ts:166-197`).
   - Every `in_review` row, B2B included, is listed with a Reject button in the Compliance queue (`compliance/page.tsx:178-190`; `scoped-store.ts:56-65` lists `status: 'in_review'` with no type filter).
6. **The customer's chat cancel has the same defect class.** `cancel_bill`'s `awaiting_payment` branch writes `await ctx.store.saveTransfer({ ...active, status: 'cancelled' })` (`src/lib/tools.ts:2383-2389`). That is a full-row upsert of a row read earlier (`listOwnB2bTransfers`, `:2302-2305`), and it has two consequences:
   - **It overwrites a concurrent settlement.** Suppose the bill is paid (`beginSettlement` flips it to `paid` and enqueues `instruct:<id>`) between the read and the write. The upsert writes `cancelled` over `paid`. If the `instruct` row has already drained, the partner pulls the debit and pays out, but the ledger says `cancelled`: the `paid_out` callback is dropped (`transfer-repo.ts:156`) and no sweep watches the row. For an `ach_pull` bill, #256's `cancelcharged:` alert never fires either, because there is no `fundingRef`.
   - **It voids a card-funded bill whose charge has landed** (`fundingRef` set, not yet settled). That leaves cancelled + charged + no refund, which only #256's alert catches.
   - Its docstring (`:2355-2356`) still assumes "nothing was debited" for every `awaiting_payment` bill, which is only true for partner-pulled bills. Task 5 creates the guarded claim, so it is the right place to route this write through it as well. Task 6, which owns `tools.ts` in wave 2 (ruling 20), merges before this task.

**Status matrix. What staff Cancel does today (bf4b083) and after this task:**

| Row | Today | After |
|---|---|---|
| `awaiting_payment`, no `fundingRef` | void | void (one guarded claim) |
| `awaiting_payment`, `fundingRef` set (charged, not yet settled) | void, **charge stranded** | refuse ("already been charged": the resume sweep settles or holds it) |
| `in_review`, no `fundingRef` (partner-pulled hold, partner-API hold) | void, **by any `canCancel` agent or platform staffer** (a compliance decision taken without admin) | refuse ("use Reject": a hold is decided on the Compliance page by an admin; Reject is cancel-only when uncharged) |
| `in_review`, `fundingRef` set (charged hold) | void, **no refund** | refuse ("use Reject": cancel + auto-refund) |
| `paid`, custodial (card / debit / bank_transfer) | void, **no refund** | refuse ("use Refund", admin, Details page) |
| `paid`, partner-pulled (ach_pull / bank_pull) | refuse ("use Reverse") | unchanged |
| `blocked` | void (direct POST) | refuse (terminal compliance state) |
| `delivered`, `cancelled` | silent no-op | silent no-op |

**What the customer chat `cancel_bill` does on its `awaiting_payment` branch, today and after** (its other branches are unchanged: `in_review` defers, `paid` requests a reverse, `delivered` opens a recall case):

| Row at the moment of the write | Today (full-row `saveTransfer`) | After (guarded claim) |
|---|---|---|
| unfunded `awaiting_payment` (every `ach_pull` bill; a card bill before capture) | cancelled, "nothing was debited" | cancelled, "nothing was debited" (unchanged) |
| card-funded, charge landed (`fundingRef` set), not yet settled | cancelled, **charge stranded**, "nothing was debited" (false) | NOT cancelled: `error_code: 'payment_processing'`; row left for the resume sweep |
| settled between the read and the write (now `paid`, rail instructed) | **`cancelled` written over `paid`** | NOT cancelled: `payment_processing`; `paid` stands |
| cancelled concurrently (for example by staff) | cancelled again (upsert) | `cancelled: true`, "already cancelled" (no write) |

---

#### Design (read before Step 1)

Cancel commits **no** effect: no refund, no reversal, no rail message. So it may only flip a row that has no money behind it and no decision pending on it: an **unfunded draft**, meaning `awaiting_payment` with `funding_ref IS NULL`.

**A compliance hold is never Cancel-voidable, charged or not.** `in_review` has no money in flight to the rail: `settlement.beginHold` enqueues only the stage-1 message (`src/lib/settlement.ts:128-165`), and only `releaseHold` adds the rail effect (`:212-220`). But ending a hold IS the compliance decision, and it must stay with admins. A hold leaves `in_review` only through:
- **Release:** `requireAdmin` + `canReleaseHeld`; it is a settlement.
- **Reject:** `requireAdmin`. It is cancel-only when uncharged and cancel + auto-refund when charged, in one transaction (`dashboard-ops.ts:166-197`).

So every `in_review` row is refused with "use Reject on the Compliance page" and routed through `rejectTransfer`; the Compliance queue lists every hold, B2B included. The ledger claim enforces the same rule structurally: its `WHERE` admits `awaiting_payment` only. This follows the review option "route them through rejectTransfer" rather than an admin carve-out inside Cancel. It keeps Cancel's permission (`canCancel`, grantable to agents) strictly below every decision that moves or releases money.

The rule lives in **one pure function**, `decideStaffCancel(t) → void | noop | refuse(reason)`, in a new client-safe module `src/lib/dashboard-cancel-policy.ts`. It imports only `isPartnerPulled` from `funding-method.ts`, whose own import is type-only, so a `'use client'` component can import it. Three places call it:
- `cancelTransfer`, the authority;
- the transactions list, a client component;
- the B2B page.

The UI therefore never offers a Cancel the server would refuse. This mirrors how `canReleaseHeld` is shared between the release action and the Compliance page (`dashboard-ops.ts:111-128`).

`cancelTransfer` makes the decision on the row it read. On `void` it runs ONE guarded, column-targeted UPDATE: `transfer-repo.cancelIfCancellable`, exposed as `store.cancelTransferIfUnfunded`, with `WHERE id = $1 AND status = 'awaiting_payment' AND funding_ref IS NULL RETURNING`.
- The read is advisory; the UPDATE is the claim.
- A null claim means the row moved: a paid flip, a hold, a capture, or a concurrent click. In that case the function re-reads and throws the refusal for the **fresh** row, or `"…changed concurrently…"`. It never falls back to a write.
- The refusal copy names the action that actually returns money or decides the hold (Refund / Reverse / Reject). This task ships **no** refund helper (ruling 21).

**What a partner sees when its transfer is voided.** Partner-API transactions are funded at the partner, outside SmartRemit. `createTransaction` / `confirmTransaction` never call SmartRemit's funding-capture seam (`partner-api-service.ts:242-347`, `:389-450`; `grep -n "captureFunding\|getFundingProvider" src/lib/partner-api-service.ts` is empty), so these rows carry no `fundingRef`, and `transferView` exposes `funding_ref: null` (`:92`). An unpaid (`awaiting_payment`) partner-API row is therefore "unfunded" by the ledger's definition and stays staff-voidable, even though the partner may already have collected from its own customer.
- **What the partner gets: no signal.** SmartRemit has NO outbound partner events. The API documents only inbound status webhooks, partner → SmartRemit (`src/app/docs/page.tsx:228-237`). The partner learns of a void only by polling:
  - `GET /api/partner/v1/transactions/:id` and the list return `status: 'cancelled'` (`partner-api-service.ts:370-380`, `transferView` `:76-96`);
  - a later `POST …/confirm` returns `409 "Cannot confirm a transfer in status cancelled."` (`:403`).
- **The sender gets no WhatsApp message.** Staff Cancel never messaged; this is unchanged.
- **Partner-API holds are no longer Cancel-voidable at all.** After this task, holds (`in_review`) exit only via Release (a settlement, which instructs the rail) or Reject (admin). A Reject of an uncharged partner-API hold has the same no-signal property as a void.
- **Is an event needed?** Yes, for partners that collect before confirm: a signed outbound `transaction.cancelled` event, whose remedy (the partner refunds its own customer) is on the partner side. That is a new outbound-webhook surface (signing, retries, a per-partner endpoint), so it is **out of scope** here (guard-only, ruling 21). It is recorded as a follow-up under Program-Fix 31 ("Give partners a reconciliation surface", rail-10), and the PR states it. Until then, the ops note in the PR says: when voiding a partner-API row, tell the partner out-of-band.

**The customer chat `cancel_bill` uses the same claim (Step 3A).** Its `awaiting_payment` branch drops the full-row upsert (`tools.ts:2384`) for `ctx.store.cancelTransferIfUnfunded(active.id)`.
- It does NOT use `decideStaffCancel`: the chat tool keeps its own per-status routing.
- If the claim misses, it re-reads the row. A concurrently `cancelled` row answers "already cancelled". Anything else answers a customer-safe `payment_processing` reply that promises nothing ("Ask me again once it settles and I can request a reversal for our team to review"). This matches the `paid` branch and the prompt's "NEVER say it is reversed" rule (`src/lib/prompt.ts:154`).
- It never calls `cancelTransfer`, so the "staff-only" note at `tools.ts:2255` still holds.

After this task the ONLY writes of `status = 'cancelled'` in `src/` are:
- `rejectTransfer`'s in-review claim, which commits together with the refund;
- `cancelIfCancellable`.

**Invariants this task must hold (test-pinned):**
1. *Non-custodial:* no status flip may imply that money came back unless the effect that returns it commits with it. `cancelTransfer` enqueues nothing, so it may only touch `awaiting_payment` rows with `funding_ref IS NULL`. Tests assert `outbox` stays EMPTY on every refusal and every void.
1a. *A compliance hold is decided only by an admin.* No Cancel path, staff or chat, can move a row out of `in_review`. Only Release and Reject can, both `requireAdmin` (tests `c7`, `m4`, and the repo test "returns null for an in_review hold").
2. *"Charged" is `fundingRef`, not status.* `fundingRef` is write-once (`transfer-repo.ts:187-192`) and written by the capture seam before any settlement claim.
3. *No unguarded read-modify-write on the ledger.* The void is one UPDATE; a lost race refuses; it never falls back to `saveTransfer`.
4. *No state that no sweep watches.* This task adds no new path to `cancelled + charged + refund none`. The one residual is the PSP-charged-but-`fundingRef`-not-yet-written window inside `captureFunding` (`route.ts:46-48`). It stays covered by #256's `cancelcharged:` alert and is documented, not fixed (fixing it needs a pre-capture claim in the money-paths route; ruling 7 owns that gate order).
5. *Server actions self-gate and stay tenant-scoped.* `requirePermission('canCancel')` and `getScopedTransfer` (404-never-403) are unchanged and still run BEFORE the money guard, so the refusal copy is never an existence oracle for another tenant's id (test m3).
6. *Idempotent:* a second click on `cancelled` / `delivered` is a silent no-op with no effect.
7. *Staff-safe copy:* refusal strings carry no PII (no digits, `@` or destination; test-pinned).
8. *Permission boundary:* `canCancel` (grantable to non-admins) can never cause money movement or end a compliance hold; Refund / Reject / Release / Reverse stay `requireAdmin` / platform-gated.
9. *Customer chat is own-row and money-free.* `cancel_bill` keeps its own-phone, tenant-scoped resolution (`listTransfersByPhone(ctx.partnerId, ctx.phone)`) and the `active.phone === ctx.phone` assertion (`tools.ts:2381`). Its void is the same guarded claim. Its replies carry no internal tokens (no `fundingRef`, no "partner", no "blocked").

**Deviations from the pre-Wave-1 draft (`/Users/nagavenkatasai/dev/program-ledger/draft-task5.md`), and rulings:**
- **Race work dropped.** #256 already made cancel status-guarded. This task swaps that guard for the stronger funding-aware claim.
  - #256's `cancel racing a release` test (`tests/dashboard-ops.test.ts:556-564`) keeps its money assertion (the row stays `paid`) but changes ONE line: the thrown-message regex goes from `/changed/i` to `/use Reject/i`.
  - The reason: a hold is now refused at the decision, before any write, so the stale `in_review` read never reaches the claim.
  - The rest of the `:527-577` describe is byte-identical.
- **The draft's claim "every prod row has no fundingRef" was wrong.** The mock capture writes `mockfund-<id>` (`funding-provider.ts:52-55`), so paid pay-page rows are Refund-eligible.
- **Dropped from the draft:**
  - the `transfer.cancel` audit row (staff audit trail belongs to Program-Fix 17 / 28);
  - the `Promise<boolean>` return (`cancelTransfer` keeps `Promise<void>`, so no caller contract changes);
  - the b2b copy refactor;
  - the `Refund →` / `Reverse →` links and the `#refund` anchor. The Details link already leads to the Refund card, and adding links would cross into the money-paths `transactions/[id]` page for no safety gain.
- **The predicate follows ruling 22, not ruling 21's IN-set.** It is `status = 'awaiting_payment' AND funding_ref IS NULL`, ruling 22's "(awaiting_payment only)". Ruling 21's `IN ('awaiting_payment','in_review')` and the Wave 1 plan's rebase note ("Fix 5's `cancelIfCancellable` admits an UNCHARGED `in_review` row") are superseded by the Wave 2 review finding: voiding a hold is a compliance decision a non-admin must not take.
  - Everything else in ruling 21 holds: guard-only, no shared refund helper, `refund:<id>` as the contract.
  - Release and Reject are unaffected; neither uses `cancelIfCancellable`.
  - The B2B page loses its in-review Cancel. Those holds are already in the Compliance queue with Reject.
  - State this in the PR.
- **Ruling 5:** `transfer-repo.ts` is additive only (`cancelIfCancellable`; no import change: `and`, `eq` and `isNull` are already imported at `:1`).
- **Ruling 20:** Task 6 owns `src/lib/tools.ts` in wave 2 and merges BEFORE this task (9 → 6 → 5 → 11), so the Step 3A edit sits on top of 6's `tools.ts` and `tests/tools.test.ts`. It touches only `cancelBillTool`'s docstring and its `awaiting_payment` case (`tools.ts:2351-2389` on bf4b083) plus the `cancel_bill` describe (`tests/tools.test.ts:3529-3650`). Those regions are disjoint from 6's masked-destination edits and from 11's enqueue-payload edits (`billpush:` / `enqueueSellerLink`; ruling 20). Task 11 rebases onto post-5 `tools.ts`.
- **Ruling 27:** `src/lib/reconcile.ts` is NOT touched. Its comments at `:160` and `:183-184` already describe this task's `cancelIfCancellable` and become true when it merges.

**Files:**
- Create: `src/lib/dashboard-cancel-policy.ts`, the pure rule (`CANCEL_REFUSAL`, `StaffCancelDecision`, `decideStaffCancel`, `showsStaffCancel`). Matches `src/lib/dashboard*` → admin-dashboard seam.
- Create: `tests/dashboard-cancel-policy.test.ts`.
- Modify: `src/db/repos/transfer-repo.ts`. Add `cancelIfCancellable` after `updateIfStatus` (`:382`). Money-paths seam; the boundary hook flags it; additive per ruling 5.
- Modify: `src/lib/store.ts`. Add `cancelTransferIfUnfunded` after `updateTransferIfStatus` (`:100-107`) and correct that method's doc comment. Platform-security seam; additive.
- Modify: `src/lib/dashboard-ops.ts`. Rewrite `cancelTransfer` (`:13-37`) on the policy and the claim; signature unchanged.
- Modify: `src/app/admin-dashboard/transactions-tabs.tsx`. Cancel is gated by `showsStaffCancel` (`:256-261`) and gets one import.
- Modify: `src/app/admin-dashboard/b2b/page.tsx`. Cancel is gated by `decideStaffCancel` (`:263`), so it appears only on unfunded `awaiting_payment` rows. A hint cell is added for holds ("In review — decide in Compliance") and charged awaiting rows. B2B seam.
- Modify: `src/app/admin-dashboard/b2b/actions.ts`. Docstring only (`:94-100`). B2B seam.
- Modify: `src/app/api/pay/[transferId]/route.ts`. Comment only (`:182-183`, "fix 5's planned" → the shipped name). Money-paths seam.
- Test: `tests/transfer-repo.test.ts`. Append a `cancelIfCancellable` describe after `:292`.
- Test: `tests/dashboard-ops.test.ts`. Replace the `cancelTransfer` describe `:54-106`, which INVERTS `:63-69`; add one import. In the `:527-577` race describe, change only the message regex of the `cancel racing a release` case (`:562`).
- Test: `tests/admin-actions-scope.test.ts`. Append the public-POST refusal describe after `:123`, including the non-admin agent case.
- Modify: `src/lib/tools.ts`. In `cancelBillTool`, the docstring bullet (`:2355-2356`) and the `awaiting_payment` case (`:2383-2389`) now use `ctx.store.cancelTransferIfUnfunded`. Whatsapp-agent seam; it sits on Task 6's `tools.ts` (ruling 20).
- Test: `tests/tools.test.ts`. Add 3 tests at the end of the `cancel_bill` describe, after the STRICT-ownership test that closes at `:3649`.
- NOT touched, stated on purpose:
  - `src/app/admin-dashboard/actions.ts`: `cancelTransferAction` needs no change; the lib guard is authoritative and the action already scopes first.
  - `src/lib/prompt.ts` and the `cancel_bill` tool-schema description (`tools.ts:349-352`): both already tell the model to relay `reply_hint` and never to promise a reversal, and the new reply follows that.
  - `src/lib/reconcile.ts` (ruling 27).
  - `drizzle/`: no DDL.
  - `tests/e2e/`: `grep -rn -i cancel tests/e2e` is empty; the scaffold hooks are untouched.

---

#### Step 0 — Worktree, branch, pre-flight (no code)

```bash
git -C "/Users/nagavenkatasai/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" fetch -q origin
git -C "/Users/nagavenkatasai/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" worktree add ~/dev/wt/admin-dashboard origin/component/admin-dashboard
cd ~/dev/wt/admin-dashboard
git checkout -b fix/admin-dashboard/safe-staff-cancel
git merge --no-edit origin/main     # the anchor must equal main; this is a no-op when /sync-branches ran
npm ci                              # node_modules OUTSIDE iCloud (no dataless-file stalls)
```

0.1 **Wave-2 predecessors are merged.** Tasks 9 (Program-Fix 13) and 6 (Program-Fix 10) must both be on `main`:

```bash
gh pr list --state merged --limit 40 --json number,title,body \
  --jq '.[] | select(.body | test("Program-Fix: (13|10)\\b")) | "\(.number) \(.title)"'
```

Expected: exactly two lines. If either is missing, stop: the merge order is 9 → 6 → 5 → 11.

0.2 **Re-cite the edit anchors on the rebased tree.** Every line number below must still hold; update the step text if one moved. Task 6 may have shifted `route.ts` (ruling 16) and, as the wave-2 owner of the file (ruling 20), `src/lib/tools.ts` and `tests/tools.test.ts`. Expect those line numbers to move, and find the Step 3A anchors by content, not by number.

```bash
grep -n "export async function cancelTransfer" src/lib/dashboard-ops.ts          # expect :13
grep -n "async updateIfStatus" src/db/repos/transfer-repo.ts                      # expect :371 (method ends :382)
grep -n "^import { and, desc, eq" src/db/repos/transfer-repo.ts                   # expect :1 (and / eq / isNull already imported; no change)
grep -n "async updateTransferIfStatus" src/lib/store.ts                           # expect :101 (doc comment :100)
grep -n "t.status === 'awaiting_payment' || t.status === 'paid'" src/app/admin-dashboard/transactions-tabs.tsx   # expect :256
grep -n "t.status === 'awaiting_payment' || t.status === 'in_review' ?" src/app/admin-dashboard/b2b/page.tsx     # expect :263
grep -n "fix 5's planned" "src/app/api/pay/[transferId]/route.ts"                 # expect one hit (:182 on bf4b083)
grep -n "sets status to cancelled for paid" tests/dashboard-ops.test.ts            # expect :63 (the bug-asserting test)
grep -n "'race_can')).rejects.toThrow(/changed/i)" tests/dashboard-ops.test.ts     # expect :562 (the one #256 line Step 3 edits)
grep -n "await ctx.store.saveTransfer({ ...active, status: 'cancelled' });" src/lib/tools.ts   # expect ONE hit (:2384 on bf4b083): the cancel_bill upsert Step 3A replaces
grep -n "awaiting_payment → flip to cancelled (nothing was debited" src/lib/tools.ts            # expect ONE hit (:2355 on bf4b083): the docstring bullet Step 3A replaces
grep -n "STRICT ownership: a stranger cannot cancel the owner's paid bill" tests/tools.test.ts # expect ONE hit (:3637 on bf4b083); its it() closes 12 lines later, and the cancel_bill describe closes on the next line
```

0.3 **Callers of every contract this task touches** (the "No collisions" rule). Record the output in the PR.

```bash
grep -rn "cancelTransfer(" src tests          # 11 hits on bf4b083: dashboard-ops.ts:13, actions.ts:61, b2b/actions.ts:120, tests/dashboard-ops.test.ts ×8
grep -rn "updateTransferIfStatus" src tests   # store.ts:101, dashboard-ops.ts:33 (cancel — removed by Step 3), :92 (assign — stays)
grep -rn "as unknown as Store" tests          # tests/recent-transfers.test.ts:43 and tests/account-verify-action.test.ts:47 are casts, so an ADDITIVE Store member breaks neither
grep -rn "status: 'cancelled'" src            # 3 writers on bf4b083: dashboard-ops.ts:33 (staff cancel, Step 3), :182 (reject, stays), tools.ts:2384 (cancel_bill, Step 3A)
```

0.4 **Baseline:** `npx vitest run 2>&1 | tail -4`. Record `Test Files X passed (X)` and `Tests Y passed (Y)`. Step 5 must show exactly **X+1 files** and **Y+35 tests**:
- +11 in the new `tests/dashboard-cancel-policy.test.ts`;
- +7 in `tests/transfer-repo.test.ts`;
- +10 net in `tests/dashboard-ops.test.ts` (the replaced cancel describe grows from 7 to 17 tests);
- +4 in `tests/admin-actions-scope.test.ts`;
- +3 in `tests/tools.test.ts` (Step 3A).

---

#### Step 1 — The pure rule: `src/lib/dashboard-cancel-policy.ts` (RED → GREEN)

**1.1 Write the failing test.** Create `tests/dashboard-cancel-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CANCEL_REFUSAL, decideStaffCancel, showsStaffCancel } from '@/lib/dashboard-cancel-policy';
import type { FundingMethod, TransferStatus } from '@/lib/types';

// Phase 1 Task 5 / Program-Fix 9 / money-05. Staff Cancel commits NO effect
// (no refund, no reversal, no rail message), so it may only VOID an unfunded
// draft. This pure rule is shared by the server guard (dashboard-ops
// cancelTransfer), the transactions list and the B2B page.

const CUSTODIAL: FundingMethod[] = ['credit_card', 'debit_card', 'bank_transfer'];
const PULLED: FundingMethod[] = ['ach_pull', 'bank_pull'];

describe('decideStaffCancel', () => {
  it('VOIDS an unfunded draft: awaiting_payment with no fundingRef, for every funding method', () => {
    for (const fundingMethod of [...CUSTODIAL, ...PULLED]) {
      expect(decideStaffCancel({ status: 'awaiting_payment', fundingMethod })).toEqual({ kind: 'void' });
    }
  });

  it('REFUSES every in_review hold, charged or NOT: a hold is a compliance decision, so Reject (admin) is the path', () => {
    for (const fundingMethod of [...CUSTODIAL, ...PULLED]) {
      expect(decideStaffCancel({ status: 'in_review', fundingMethod }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.inReview });
    }
    expect(decideStaffCancel({ status: 'in_review', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' }))
      .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.inReview });
  });

  it('REFUSES every PAID custodial transfer, charged or not: steers to Refund (the rail was already told to pay out)', () => {
    for (const fundingMethod of CUSTODIAL) {
      expect(decideStaffCancel({ status: 'paid', fundingMethod, fundingRef: 'mockfund-x' }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.paid });
      expect(decideStaffCancel({ status: 'paid', fundingMethod }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.paid });
    }
  });

  it('REFUSES every PAID partner-pulled transfer: steers to Reverse (the signed instruction is live)', () => {
    for (const fundingMethod of PULLED) {
      expect(decideStaffCancel({ status: 'paid', fundingMethod }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.paidPartnerPulled });
    }
  });

  it('REFUSES a CHARGED awaiting_payment row: the funding-resume sweep settles or holds it', () => {
    expect(decideStaffCancel({ status: 'awaiting_payment', fundingMethod: 'debit_card', fundingRef: 'mockfund-x' }))
      .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.chargedAwaiting });
  });

  it('REFUSES blocked: a terminal compliance state is never rewritten', () => {
    expect(decideStaffCancel({ status: 'blocked', fundingMethod: 'credit_card' }))
      .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.blocked });
  });

  it('is a NO-OP on delivered and cancelled (a second click is silent, never an error)', () => {
    expect(decideStaffCancel({ status: 'delivered', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' })).toEqual({ kind: 'noop' });
    expect(decideStaffCancel({ status: 'cancelled', fundingMethod: 'ach_pull' })).toEqual({ kind: 'noop' });
  });

  it('decides every TransferStatus (tsc forces a case for any new status; nothing falls through to void)', () => {
    const all: TransferStatus[] = ['awaiting_payment', 'paid', 'in_review', 'delivered', 'cancelled', 'blocked'];
    const voided = all.filter((status) => decideStaffCancel({ status, fundingMethod: 'credit_card' }).kind === 'void');
    expect(voided).toEqual(['awaiting_payment']);
  });
});

describe('CANCEL_REFUSAL: the copy contract', () => {
  it('names the action that actually returns money or decides the hold', () => {
    expect(CANCEL_REFUSAL.paid).toMatch(/use Refund/i);
    expect(CANCEL_REFUSAL.paidPartnerPulled).toMatch(/use Reverse/i);
    expect(CANCEL_REFUSAL.inReview).toMatch(/use Reject/i);
    expect(CANCEL_REFUSAL.inReview).toMatch(/admin/i);
    expect(CANCEL_REFUSAL.chargedAwaiting).toMatch(/already been charged/i);
    expect(CANCEL_REFUSAL.blocked).toMatch(/blocked/i);
    expect(CANCEL_REFUSAL.changed).toMatch(/changed concurrently/i);
  });

  it('is staff-safe: no digit runs, no email, nothing that could carry PII', () => {
    for (const msg of Object.values(CANCEL_REFUSAL)) expect(msg).not.toMatch(/@|\d{4,}/);
  });
});

describe('showsStaffCancel: the transactions list offers Cancel only where the server would void it', () => {
  it('true ONLY for an uncharged awaiting_payment row (paid rows lose the button: money-05)', () => {
    expect(showsStaffCancel({ status: 'awaiting_payment', fundingMethod: 'credit_card' })).toBe(true);
    expect(showsStaffCancel({ status: 'awaiting_payment', fundingMethod: 'ach_pull' })).toBe(true);
    expect(showsStaffCancel({ status: 'awaiting_payment', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' })).toBe(false);
    expect(showsStaffCancel({ status: 'paid', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' })).toBe(false);
    expect(showsStaffCancel({ status: 'paid', fundingMethod: 'ach_pull' })).toBe(false);
    // holds are decided on the Compliance page (Release / Reject), never by Cancel
    expect(showsStaffCancel({ status: 'in_review', fundingMethod: 'credit_card' })).toBe(false);
    expect(showsStaffCancel({ status: 'in_review', fundingMethod: 'bank_pull' })).toBe(false);
    for (const status of ['delivered', 'cancelled', 'blocked'] as const) {
      expect(showsStaffCancel({ status, fundingMethod: 'credit_card' })).toBe(false);
    }
  });
});
```

**1.2 Run and expect failure:** `npx vitest run tests/dashboard-cancel-policy.test.ts`

Expected: the file fails to load because the module does not exist yet. Vitest reports `Failed to resolve import "@/lib/dashboard-cancel-policy"` or `Cannot find module`, and no tests run. Any other error means the test itself is wrong; fix it before implementing.

**1.3 Implement.** Create `src/lib/dashboard-cancel-policy.ts`:

```ts
import { isPartnerPulled } from './funding-method';
import type { Transfer } from './types';

// dashboard-cancel-policy: the ONE rule for what staff "Cancel" may do
// (Phase 1 Task 5 / Program-Fix 9 / money-05).
//
// NON-CUSTODIAL: Cancel commits NO effect (no refund, no reversal, no rail
// message). So it may only VOID a row with no money behind it and no decision
// pending on it: an UNFUNDED draft, meaning awaiting_payment with no fundingRef.
// "Charged" is fundingRef (write-once, set by the capture seam BEFORE any
// settlement claim), not status.
//
// A compliance HOLD (in_review) is never Cancel-voidable, charged or not.
// Ending a hold IS the compliance decision, and it stays with admins: Release
// (a settlement) or Reject (cancel-only when uncharged, cancel + auto-refund
// when charged). Both are requireAdmin; the Compliance queue lists every hold.
// Everything else is refused with the action that returns money or decides the
// hold. canCancel can be granted to non-admin staff, so Cancel must never stand
// in for a refund, a reversal, or a compliance decision.
//
// PURE and client-safe: funding-method.ts has only a type import. The server
// guard (dashboard-ops.cancelTransfer), the transactions list (a 'use client'
// component) and the B2B page all call it, so the UI can never offer a Cancel
// the server refuses. The same pattern as canReleaseHeld.

/** Refusal copy. Thrown to the browser, so staff-safe: no PII (test-pinned). */
export const CANCEL_REFUSAL = {
  paid:
    'Cannot cancel a paid transfer: the rail has already been told to pay out, and a cancel would not return the sender’s charge. If the sender was charged here, an admin can use Refund on the transfer’s Details page.',
  paidPartnerPulled:
    'Cannot cancel a paid partner-pulled transfer directly — use Reverse (it instructs the partner to return the debit).',
  inReview:
    'Cannot cancel a transfer that is in compliance review — a hold is a compliance decision: an admin can use Reject on the Compliance page (it cancels the transfer and refunds any captured charge in one step).',
  chargedAwaiting:
    'Cannot cancel: the sender has already been charged. The reconcile sweep settles or holds this transfer within minutes — then use Refund (paid) or Reject (in review).',
  blocked: 'Cannot cancel a blocked transfer — blocked is a terminal compliance state.',
  changed: 'Cannot cancel: the transfer changed concurrently — reload and try again.',
} as const;

export type StaffCancelDecision =
  | { kind: 'void' } // unfunded draft: the guarded claim may run
  | { kind: 'noop' } // delivered / cancelled: idempotent second click
  | { kind: 'refuse'; reason: string };

type CancelView = Pick<Transfer, 'status' | 'fundingMethod' | 'fundingRef'>;

export function decideStaffCancel(t: CancelView): StaffCancelDecision {
  switch (t.status) {
    case 'delivered':
    case 'cancelled':
      return { kind: 'noop' };
    case 'blocked':
      return { kind: 'refuse', reason: CANCEL_REFUSAL.blocked };
    case 'paid':
      return {
        kind: 'refuse',
        reason: isPartnerPulled(t.fundingMethod) ? CANCEL_REFUSAL.paidPartnerPulled : CANCEL_REFUSAL.paid,
      };
    case 'in_review':
      // Charged or not: a hold is decided by Reject / Release (admin), never by Cancel.
      return { kind: 'refuse', reason: CANCEL_REFUSAL.inReview };
    case 'awaiting_payment':
      return t.fundingRef ? { kind: 'refuse', reason: CANCEL_REFUSAL.chargedAwaiting } : { kind: 'void' };
    default: {
      // Exhaustive: a new TransferStatus (e.g. Task 4's rail-failure state)
      // fails tsc HERE until its Cancel semantics are decided. At runtime an
      // unknown ledger value is refused, never voided.
      const unknownStatus: never = t.status;
      return { kind: 'refuse', reason: `Cannot cancel a transfer in status ${String(unknownStatus)}.` };
    }
  }
}

/**
 * The transactions list (and the B2B page, through decideStaffCancel) shows
 * Cancel only where the server would void it: an UNCHARGED awaiting_payment
 * row. Holds are decided on the Compliance page (Release / Reject).
 */
export function showsStaffCancel(t: CancelView): boolean {
  return decideStaffCancel(t).kind === 'void';
}
```

**1.4 Run tests:** `npx vitest run tests/dashboard-cancel-policy.test.ts`. Expect `Tests 11 passed (11)`. Then run `npm run typecheck` and expect exit 0.

**1.5 Commit:**
```
feat(dashboard): dashboard-cancel-policy, the one pure rule for staff Cancel (money-05)

decideStaffCancel → void | noop | refuse(reason): Cancel commits no effect,
so it may only void an unfunded draft (awaiting_payment with no fundingRef).
Paid → Refund (custodial) or Reverse (partner-pulled); any in_review hold,
charged or not → Reject (admin: a hold is a compliance decision); charged
awaiting → the resume sweep; blocked → refused. Client-safe so the list, the
B2B page and the server guard share it.
```
(End the message with the attribution trailer lines from the executing session's system reminder.)

---

#### Step 2 — The ledger claim: `transfer-repo.cancelIfCancellable` + `store.cancelTransferIfUnfunded` (RED → GREEN)

API ground truth for drizzle-orm 0.45.2 (`package.json` `^0.45.2`): `isNull(value)` is declared at `node_modules/drizzle-orm/sql/expressions/conditions.d.ts:206`. `and`, `eq` and `isNull` are already imported at `transfer-repo.ts:1`, so the import line does not change. `transfers.status` is plain `text` (`src/db/schema.ts:62`).

**2.1 Write the failing test.** Append to the END of `tests/transfer-repo.test.ts`, after the last describe, which closes at `:292`. This file uses no fake timers, so the PGlite rule "freshDb() BEFORE vi.useFakeTimers()" holds trivially. No test here depends on a hardcoded date inside a time window.

```ts
describe('transfer-repo: cancelIfCancellable — atomic VOID of an unfunded draft (Phase 1 Task 5 / money-05)', () => {
  it('voids an UNCHARGED awaiting_payment row; RETURNING is the masked read; only status is written', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_await' }));
    const res = await repo.cancelIfCancellable('cc_await');
    expect(res?.status).toBe('cancelled');
    expect(res?.payoutDestination).toBe('****1234'); // masked, like every default read
    const after = await repo.getTransfer('cc_await', { decrypt: true });
    expect(after!.status).toBe('cancelled');
    expect(after!.payoutDestination).toBe('123456789012|HDFC0001234'); // column-targeted: ciphertext untouched
  });

  it('returns null for an in_review hold, charged OR NOT: a hold leaves in_review only via Release or Reject (admin)', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_review', status: 'in_review', complianceStatus: 'flagged' }));
    await repo.saveTransfer(
      fixture({ id: 'cc_review_chg', status: 'in_review', complianceStatus: 'flagged', fundingRef: 'mockfund-cc_review_chg' }),
    );
    expect(await repo.cancelIfCancellable('cc_review')).toBeNull();
    expect(await repo.cancelIfCancellable('cc_review_chg')).toBeNull();
    expect((await repo.getTransfer('cc_review'))!.status).toBe('in_review');
    expect((await repo.getTransfer('cc_review_chg'))!.status).toBe('in_review');
  });

  it('returns null and moves NOTHING for paid / delivered / cancelled / blocked', async () => {
    const paidAt = new Date().toISOString();
    for (const status of ['paid', 'delivered', 'cancelled', 'blocked'] as const) {
      const id = `cc_${status}`;
      await repo.saveTransfer(
        fixture({
          id,
          status,
          ...(status === 'paid' || status === 'delivered' ? { paidAt } : {}),
          complianceStatus: status === 'blocked' ? 'blocked' : 'cleared',
        }),
      );
      expect(await repo.cancelIfCancellable(id)).toBeNull();
      expect((await repo.getTransfer(id))!.status).toBe(status);
    }
  });

  it('returns null for a CHARGED awaiting_payment row (fundingRef set): the resume sweep owns it', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_chg_await', fundingRef: 'mockfund-cc_chg_await' }));
    expect(await repo.cancelIfCancellable('cc_chg_await')).toBeNull();
    expect((await repo.getTransfer('cc_chg_await'))!.status).toBe('awaiting_payment');
  });

  it('a capture that lands first (setFundingRef) makes the void miss, and the charged row stays visible to the resume sweep', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_cap' }));
    await repo.setFundingRef('cc_cap', 'mockfund-cc_cap');
    expect(await repo.cancelIfCancellable('cc_cap')).toBeNull();
    const resumable = await repo.listAwaitingWithFunding(0, new Date(Date.now() + 60_000));
    expect(resumable.map((t) => t.id)).toContain('cc_cap');
  });

  it('a paid flip that lands first makes the void miss and leaves paid (the claim decides, not the read)', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_late' }));
    expect((await repo.markPaidIfAwaiting('cc_late'))?.status).toBe('paid');
    expect(await repo.cancelIfCancellable('cc_late')).toBeNull();
    expect((await repo.getTransfer('cc_late'))!.status).toBe('paid');
  });

  it('CONCURRENT paid claim + void: exactly one wins and the ledger holds the winner', async () => {
    await repo.saveTransfer(fixture({ id: 'cc_race' }));
    const [paid, voided] = await Promise.all([
      repo.markPaidIfAwaiting('cc_race'),
      repo.cancelIfCancellable('cc_race'),
    ]);
    expect([paid, voided].filter((r) => r !== null)).toHaveLength(1);
    expect((await repo.getTransfer('cc_race'))!.status).toBe(paid ? 'paid' : 'cancelled');
  });
});
```

**2.2 Run and expect failure:** `npx vitest run tests/transfer-repo.test.ts -t cancelIfCancellable`

Expected: 7 failed, each `TypeError: repo.cancelIfCancellable is not a function`. The rest of the file is skipped by `-t`.

**2.3 Implement.**

(a) No import change: `and`, `eq` and `isNull` are already imported at `src/db/repos/transfer-repo.ts:1`.

(b) Insert directly after the closing `},` of `updateIfStatus` (`:382`) and before `/** Compliance views: newest-first by compliance_status (indexed-friendly). */` (`:384`):

```ts
    /**
     * Atomically VOID an UNFUNDED draft: the ONLY cancel write, used by staff
     * Cancel (dashboard-ops.cancelTransfer) and the customer chat cancel_bill
     * (tools.ts), both via store.cancelTransferIfUnfunded (Phase 1 Task 5 /
     * Program-Fix 9 / money-05; ruling 22's "awaiting_payment only"). ONE
     * guarded UPDATE:
     *   WHERE id = $1 AND status = 'awaiting_payment' AND funding_ref IS NULL
     * • funding_ref IS NULL means "never charged". The capture seam writes it
     *   (write-once, setFundingRef) BEFORE any settlement claim. A charged
     *   awaiting_payment row is still resumed by listAwaitingWithFunding.
     * • in_review NEVER matches, charged or not. Ending a compliance hold is
     *   the compliance decision, so it leaves in_review only via Release or
     *   Reject (both requireAdmin). This predicate enforces that for every
     *   Cancel path (Wave 2 review).
     * • paid / delivered / blocked / cancelled never match. Cancel commits NO
     *   refund or reversal effect, so it may never touch a row with money
     *   behind it.
     * Column-targeted (status only): encrypted columns are never rewritten.
     * Null ⇒ not voidable NOW (a concurrent paid flip, hold or capture won).
     * The caller re-reads and refuses; it must NEVER fall back to saveTransfer.
     * Residual (alerted, not closed here): a PSP capture that has charged but
     * not yet written funding_ref is invisible to this predicate. reconcile's
     * cancelcharged:<id> alert (findCancelledCharged) is the net for it.
     */
    async cancelIfCancellable(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'cancelled' })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'awaiting_payment'),
          isNull(transfers.fundingRef),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },
```

(c) In `src/lib/store.ts`, replace the doc comment line `:100`:

```ts
    /** Status-guarded staff edit (reject / cancel / assign) — see transfer-repo.updateIfStatus. */
```

with:

```ts
    /** Status-guarded staff edit (assign) — see transfer-repo.updateIfStatus. Cancel
     *  uses cancelTransferIfUnfunded; reject claims inside its own transaction. */
```

Then insert directly after the closing `},` of `updateTransferIfStatus` (`:107`) and before `async updateTransferFromWebhook(` (`:108`):

```ts
    /** Atomic VOID of an unfunded draft (awaiting_payment with no fundingRef;
     *  never an in_review hold) → cancelled: transfer-repo.cancelIfCancellable. Callers:
     *  dashboard-ops.cancelTransfer (staff) and tools.ts cancel_bill (customer
     *  chat). Null ⇒ not voidable now; the caller refuses and never falls back
     *  to saveTransfer. */
    async cancelTransferIfUnfunded(id: string): Promise<Transfer | null> {
      return transfersRepo.cancelIfCancellable(id);
    },
```

`Transfer` is already imported at `store.ts:8`. `Store` is `ReturnType<typeof createStore>` (`:394`), so the member is additive; Step 0.3 showed the only fakes are `as unknown as Store` casts.

**2.4 Run tests:**

```bash
npx vitest run tests/transfer-repo.test.ts
npm run typecheck
```

Expected: every describe is green, including the 7 new tests; `tsc` exits 0. If `Duplicate identifier` appears from `.next/types/* 2.ts`, it is an iCloud duplicate (CLAUDE.md): delete the ` 2` file and run `rm -rf .next`. This should not happen in the `~/dev/wt` worktree.

**2.5 Commit:**
```
feat(transfer-repo): cancelIfCancellable, an atomic funding-aware void of an unfunded draft

One guarded, column-targeted UPDATE (ruling 22): status = awaiting_payment
AND funding_ref IS NULL … RETURNING. A compliance hold (in_review) never
matches, so it leaves review only via Release or Reject (admin). Null ⇒ not
voidable; callers refuse and never fall back to the saveTransfer upsert.
Exposed additively as store.cancelTransferIfUnfunded.
```
(End the message with the attribution trailer lines from the executing session's system reminder.)

---

#### Step 3 — `cancelTransfer` on the rule + the claim; the public POST endpoint refuses (RED → GREEN; INVERTS `tests/dashboard-ops.test.ts:63-69`)

**3.1 Write the failing tests.**

(a) In `tests/dashboard-ops.test.ts`, add this import after `:12` (`import { createIntegrationsRepo } from '@/db/repos/integrations-repo';`):

```ts
import { createTransferRepo } from '@/db/repos/transfer-repo';
```

(b) REPLACE the whole `describe('cancelTransfer', () => { … });` block (`:54-106`) with the block below.

(c) In the `stale-read races with a release` describe (`:527-577`), change exactly ONE line: `:562` in the `cancel racing a release` case. Everything else in that describe stays byte-identical, including this case's money assertion at `:563` (the row stays `paid`). The stale `in_review` read is now refused at the DECISION, before any write, because a hold is never Cancel-voidable. So the thrown message is the Reject copy, not `"changed concurrently"`. Replace:

```ts
    await expect(cancelTransfer(staleView(store, stale), 'race_can')).rejects.toThrow(/changed/i);
```

with:

```ts
    await expect(cancelTransfer(staleView(store, stale), 'race_can')).rejects.toThrow(/use Reject/i); // a hold is refused at the decision (Task 5)
```

```ts
describe('cancelTransfer — staff Cancel VOIDS an unfunded draft and nothing else (Phase 1 Task 5 / money-05)', () => {
  // ── The legal void: unfunded drafts ────────────────────────────────────
  it('voids an uncharged awaiting_payment transfer and enqueues nothing', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c1', status: 'awaiting_payment' }));
    await cancelTransfer(store, 'c1');
    expect((await store.getTransfer('c1'))?.status).toBe('cancelled');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('still voids an AWAITING_PAYMENT ach_pull transfer (no instruction posted yet — safe void)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c6', status: 'awaiting_payment', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await cancelTransfer(store, 'c6');
    expect((await store.getTransfer('c6'))?.status).toBe('cancelled');
  });

  // ── Holds: a compliance decision, never a Cancel (Wave 2 review) ────────
  it('REFUSES an UNCHARGED in_review hold (B2B bank_pull), and Reject (admin) is the path that ends it', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(
      makeTransfer({ id: 'c7', status: 'in_review', complianceStatus: 'flagged', fundingMethod: 'bank_pull', transferType: 'b2b' }),
    );
    await expect(cancelTransfer(store, 'c7')).rejects.toThrow(/use Reject/i);
    expect((await store.getTransfer('c7'))?.status).toBe('in_review');
    // The routed path: rejectTransfer is cancel-only for an uncharged hold, with no refund and no outbox row.
    await rejectTransfer(store, db, 'c7');
    const loaded = await store.getTransfer('c7');
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.refundStatus ?? 'none').toBe('none');
    expect(loaded?.adminNote).toContain('rejected in review');
    expect(await outboxRows()).toHaveLength(0);
  });

  // ── Idempotent no-ops ───────────────────────────────────────────────────
  it('is a no-op for delivered transfers', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c3', status: 'delivered', fundingRef: 'mockfund-c3' }));
    await cancelTransfer(store, 'c3');
    expect((await store.getTransfer('c3'))?.status).toBe('delivered');
  });

  it('is a no-op for already cancelled transfers (a second click is silent)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c4', status: 'cancelled' }));
    await cancelTransfer(store, 'c4');
    expect((await store.getTransfer('c4'))?.status).toBe('cancelled');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(cancelTransfer(store, 'missing')).rejects.toThrow('Transfer not found');
  });

  // ── INVERTED. This used to be 'sets status to cancelled for paid' (:63-69)
  //    and ASSERTED money-05: a charged sender, a cancelled row, no refund,
  //    and issueRefund locked out (it accepts paid|delivered only). ──────────
  it('REFUSES a PAID card transfer (charged): steers to Refund and mutates NOTHING', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c2', status: 'paid', fundingRef: 'mockfund-c2', adminNote: 'keep me' }));
    await expect(cancelTransfer(store, 'c2')).rejects.toThrow(/use Refund/i);
    const loaded = await store.getTransfer('c2');
    expect(loaded?.status).toBe('paid');
    expect(loaded?.refundStatus ?? 'none').toBe('none');
    expect(loaded?.adminNote).toBe('keep me');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('REFUSES a PAID custodial transfer with no fundingRef too: paid means the rail was told', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c2b', status: 'paid', fundingMethod: 'bank_transfer' }));
    await expect(cancelTransfer(store, 'c2b')).rejects.toThrow(/use Refund/i);
    expect((await store.getTransfer('c2b'))?.status).toBe('paid');
  });

  it('REFUSES to bare-cancel a PAID ach_pull transfer (non-custodial guard — must use Reverse)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c5', status: 'paid', fundingMethod: 'ach_pull', transferType: 'b2b' }));
    await expect(cancelTransfer(store, 'c5')).rejects.toThrow(/use Reverse/i);
    // Status is untouched: the partner instruction is still live.
    expect((await store.getTransfer('c5'))?.status).toBe('paid');
  });

  it('REFUSES a PAID bank_pull transfer too (both partner-pulled methods steer to Reverse)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c9', status: 'paid', fundingMethod: 'bank_pull', transferType: 'b2b' }));
    await expect(cancelTransfer(store, 'c9')).rejects.toThrow(/use Reverse/i);
    expect((await store.getTransfer('c9'))?.status).toBe('paid');
  });

  it('REFUSES a CHARGED in_review transfer: Reject is the auto-refunding path', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c10', status: 'in_review', complianceStatus: 'flagged', fundingRef: 'mockfund-c10' }));
    await expect(cancelTransfer(store, 'c10')).rejects.toThrow(/use Reject/i);
    const loaded = await store.getTransfer('c10');
    expect(loaded?.status).toBe('in_review');
    expect(loaded?.refundStatus ?? 'none').toBe('none');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('REFUSES a CHARGED card-funded B2B hold (the B2B page Cancel used to void it with no refund)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(
      makeTransfer({ id: 'c10b', status: 'in_review', complianceStatus: 'flagged', transferType: 'b2b', fundingMethod: 'credit_card', fundingRef: 'mockfund-c10b' }),
    );
    await expect(cancelTransfer(store, 'c10b')).rejects.toThrow(/use Reject/i);
    expect((await store.getTransfer('c10b'))?.status).toBe('in_review');
  });

  it('REFUSES a CHARGED awaiting_payment transfer, which stays visible to the funding-resume sweep', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c11', status: 'awaiting_payment', fundingRef: 'mockfund-c11' }));
    await expect(cancelTransfer(store, 'c11')).rejects.toThrow(/already been charged/i);
    expect((await store.getTransfer('c11'))?.status).toBe('awaiting_payment');
    const resumable = await createTransferRepo(db).listAwaitingWithFunding(0, new Date(Date.now() + 60_000));
    expect(resumable.map((t) => t.id)).toContain('c11');
  });

  it('REFUSES blocked: never rewrites a terminal compliance state', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c12', status: 'blocked', complianceStatus: 'blocked' }));
    await expect(cancelTransfer(store, 'c12')).rejects.toThrow(/blocked/i);
    expect((await store.getTransfer('c12'))?.status).toBe('blocked');
  });

  // ── Races: the read is advisory, the guarded claim decides ──────────────
  it('a cancel whose read raced the PAID flip refuses from the FRESH row (Refund) and never clobbers paid', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c13', status: 'awaiting_payment' }));
    let raced = false;
    const racy: typeof store = {
      ...store,
      async getTransfer(id: string) {
        const snapshot = await store.getTransfer(id);
        if (!raced) {
          raced = true;
          await store.updateTransferFromWebhook(id, 'paid'); // settlement wins between the read and the claim
        }
        return snapshot;
      },
    };
    await expect(cancelTransfer(racy, 'c13')).rejects.toThrow(/use Refund/i);
    const loaded = await store.getTransfer('c13');
    expect(loaded?.status).toBe('paid');
    expect(loaded?.refundStatus ?? 'none').toBe('none');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('a cancel whose read raced the CAPTURE (fundingRef written) refuses and leaves the charged row for the resume sweep', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c14', status: 'awaiting_payment' }));
    let raced = false;
    const racy: typeof store = {
      ...store,
      async getTransfer(id: string) {
        const snapshot = await store.getTransfer(id);
        if (!raced) {
          raced = true;
          await createTransferRepo(db).setFundingRef(id, 'mockfund-c14'); // the capture seam lands between the read and the claim
        }
        return snapshot;
      },
    };
    await expect(cancelTransfer(racy, 'c14')).rejects.toThrow(/already been charged/i);
    const loaded = await store.getTransfer('c14');
    expect(loaded?.status).toBe('awaiting_payment');
    expect(loaded?.fundingRef).toBe('mockfund-c14');
  });

  it('a double click racing itself: the second claim misses on the now-cancelled row and throws "changed concurrently" (no second write)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'c15', status: 'awaiting_payment' }));
    let raced = false;
    const racy: typeof store = {
      ...store,
      async getTransfer(id: string) {
        const snapshot = await store.getTransfer(id);
        if (!raced) {
          raced = true;
          await cancelTransfer(store, id); // the first click lands between this click's read and its claim
        }
        return snapshot;
      },
    };
    await expect(cancelTransfer(racy, 'c15')).rejects.toThrow(/changed concurrently/i);
    expect((await store.getTransfer('c15'))?.status).toBe('cancelled');
  });
});
```

(d) In `tests/admin-actions-scope.test.ts`, append after the `cancelTransferAction partner scope (H1)` describe, which closes at `:123`. That file's `makeTransfer` defaults to `fundingMethod: 'bank_transfer'` (custodial) and `partnerId: 'A'`; partners `A` and `B` are seeded in `beforeEach` (`:93-100`). Its `requireAdmin` mock returns `currentStaff` without a role check (`:19-25`). The real `requireAdmin` redirects non-admins (`src/lib/auth.ts:36-40`), so the case added here pins the Cancel side (`requirePermission('canCancel')` → lib guard) for a non-admin `'agent'` (`StaffRole`, `src/lib/types.ts:237`).

```ts
describe('cancelTransferAction — the public POST endpoint refuses money-05 (Phase 1 Task 5)', () => {
  it('refuses a PAID charged transfer even for a platform admin: steers to Refund, ledger untouched', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm1', partnerId: 'A', status: 'paid', fundingRef: 'mockfund-m1' }));
    currentStaff = staff({ username: 'plat' });
    await expect(cancelTransferAction(form({ id: 'm1' }))).rejects.toThrow(/use Refund/i);
    const t = await store.getTransfer('m1');
    expect(t?.status).toBe('paid');
    expect(t?.refundStatus ?? 'none').toBe('none');
  });

  it('refuses a CHARGED in_review transfer POSTed directly (the list never renders Cancel there): steers to Reject', async () => {
    await store.saveTransfer(
      makeTransfer({ id: 'm2', partnerId: 'B', status: 'in_review', complianceStatus: 'flagged', fundingRef: 'mockfund-m2' }),
    );
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(cancelTransferAction(form({ id: 'm2' }))).rejects.toThrow(/use Reject/i);
    expect((await store.getTransfer('m2'))?.status).toBe('in_review');
  });

  it('scope still runs FIRST: another tenant’s paid row answers the generic not-found, never the money refusal', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm3', partnerId: 'A', status: 'paid', fundingRef: 'mockfund-m3' }));
    currentStaff = staff({ username: 'pb', partnerId: 'B' });
    await expect(cancelTransferAction(form({ id: 'm3' }))).rejects.toThrow(/^Transfer not found$/);
    expect((await store.getTransfer('m3'))?.status).toBe('paid');
  });

  it('a NON-admin agent with canCancel cannot end an UNCHARGED compliance hold: the hold is refused and stays in_review', async () => {
    await store.saveTransfer(
      makeTransfer({ id: 'm4', partnerId: 'A', status: 'in_review', complianceStatus: 'flagged', fundingMethod: 'bank_pull', transferType: 'b2b' }),
    );
    currentStaff = staff({
      username: 'agentA',
      role: 'agent',
      partnerId: 'A',
      permissions: { canCancel: true, canResend: false, canAssign: false },
    });
    await expect(cancelTransferAction(form({ id: 'm4' }))).rejects.toThrow(/use Reject/i);
    expect((await store.getTransfer('m4'))?.status).toBe('in_review');
  });
});
```

**3.2 Run and expect failure:**

```bash
npx vitest run tests/dashboard-ops.test.ts tests/admin-actions-scope.test.ts
```

Expected RED, each for the predicted reason:
- `dashboard-ops`: `c2`, `c2b`, `c7`, `c10`, `c10b`, `c11` and `c12` fail with `AssertionError: promise resolved "undefined" instead of rejecting`. Today's code flips each of them through `updateTransferIfStatus(id, <read status>)`, including the uncharged hold `c7`.
- #256's edited `cancel racing a release` case fails on the `toThrow(/use Reject/i)` match: today it throws `"…changed concurrently…"`.
- `c13` fails on the `toThrow(/use Refund/i)` match: today's code DOES reject, but with `'Cannot cancel: the transfer changed concurrently — reload and try again.'`, because the status guard misses and it never re-reads.
- `c14` fails with `promise resolved "undefined" instead of rejecting`, because the status-only guard ignores `fundingRef`.
- `admin-actions-scope`: `m1`, `m2` and `m4` fail with `promise resolved "undefined" instead of rejecting`. `m4` is the non-admin agent voiding a hold.
- Already green (contract locks, stated in the PR):
  - `c1`, `c6`, `c3`, `c4`, `missing`, `c5`, `c9`;
  - `c15`: today's status guard also throws "changed concurrently";
  - `m3`;
  - the three H1 cases;
  - the other three cases of #256's race describe.

**3.3 Implement.** In `src/lib/dashboard-ops.ts`:

(a) Insert after `:2` (`import { isPartnerPulled } from './funding-method';`). Keep that import: `reverseB2bSettlement` uses it at `:57`.

```ts
import { CANCEL_REFUSAL, decideStaffCancel } from './dashboard-cancel-policy';
```

(b) REPLACE `cancelTransfer` (`:13-37`) with:

```ts
/**
 * Staff "Cancel" = VOID an UNFUNDED draft, and nothing else (Phase 1 Task 5 /
 * Program-Fix 9 / money-05). NON-CUSTODIAL: this function commits NO effect
 * (no refund, no reversal, no rail message), so it may only flip a row with no
 * money behind it. The rule is the pure decideStaffCancel
 * (dashboard-cancel-policy), shared with the transactions list and the B2B page:
 *   • delivered / cancelled → silent no-op (a second click is never an error),
 *   • paid → refused: custodial → Refund (issueRefund), partner-pulled → Reverse,
 *   • ANY in_review hold, charged or not → refused: a hold is a compliance
 *     decision, so Reject (admin; cancel-only when uncharged, cancel +
 *     auto-refund when charged, one txn) or Release (admin),
 *   • charged awaiting_payment → refused: the funding-resume sweep settles or holds it,
 *   • blocked → refused (terminal compliance state),
 *   • otherwise (an unfunded awaiting_payment draft) → ONE guarded UPDATE
 *     (store.cancelTransferIfUnfunded → transfer-repo.cancelIfCancellable).
 *     The read above is advisory; the UPDATE is the claim. A miss means the
 *     row moved (paid flip, hold, capture, or a concurrent click): refuse
 *     from the FRESH row, and never fall back to a write.
 * Why refuse instead of flipping: a cancelled row is invisible to every safety
 * net. updateTransferFromWebhook refuses it, findStuckPaid skips it, and
 * issueRefund rejects it. A charged transfer cancelled here used to strand the
 * sender's money, with reconcile's cancelcharged:<id> alert as the only trace.
 */
export async function cancelTransfer(store: Store, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  const decision = decideStaffCancel(transfer);
  if (decision.kind === 'noop') return;
  if (decision.kind === 'refuse') throw new Error(decision.reason);
  if (await store.cancelTransferIfUnfunded(id)) return;
  const fresh = await store.getTransfer(id);
  const again = fresh ? decideStaffCancel(fresh) : null;
  throw new Error(again?.kind === 'refuse' ? again.reason : CANCEL_REFUSAL.changed);
}
```

`src/app/admin-dashboard/actions.ts:57-66` (`cancelTransferAction`) and `src/app/admin-dashboard/b2b/actions.ts:101-130` (`cancelB2bTransferAction`) both `await cancelTransfer(store, id)`. The signature is unchanged, so neither needs a code change.
- **b2c action:** it scopes first (`getScopedTransfer`, `:60`), then the lib guard refuses (tests `m1`-`m4`).
- **b2b action:** its own pre-checks already reject `paid && isPartnerPulled` (`:113-115`) and any status other than `awaiting_payment | in_review` (`:116-118`).
  - An `in_review` hold still passes that pre-check, but `cancelTransfer` now refuses every hold with the Reject copy.
  - So does a charged card-funded awaiting row.
  - In both cases the lib guard throws before the audit write at `:121`, so a refused cancel writes no `b2b.transfer.cancel` row.
  - The action's own gate is platform scope only (`:32-38`, no `canCancel` or role check). That is no longer money- or compliance-relevant, because the only thing it can still do is void an unfunded awaiting draft. The missing `canCancel` check is listed under Out of scope.
  - A lost race to a concurrent click also throws (`CANCEL_REFUSAL.changed`), so a void writes at most one audit row.

**3.4 Run tests:**

```bash
npx vitest run tests/dashboard-ops.test.ts tests/admin-actions-scope.test.ts tests/transfer-repo.test.ts tests/dashboard-cancel-policy.test.ts
npm run typecheck
```

Expected: all green, and `tsc` exits 0.

Count check against the Step 0.4 baseline:

| File | Change |
|---|---|
| `tests/dashboard-ops.test.ts` | 7 → 17 in the cancel describe (+10). One regex edited in #256's race describe; no count change there. |
| `tests/admin-actions-scope.test.ts` | +4 |
| `tests/transfer-repo.test.ts` | +7 |
| `tests/dashboard-cancel-policy.test.ts` | +11 (new file) |

Running total after Step 3: **+32 tests, +1 file**. Step 3A adds 3 more, which gives Step 0.4's **+35**.

**3.5 Commit:**
```
fix(dashboard-ops): staff Cancel refuses every paid, charged or held transfer (money-05)

PR #256 made cancel status-guarded, so a cancel no longer clobbers a
concurrent paid/delivered. It still flipped a PAID custodial transfer (and
any charged in_review / awaiting_payment row, and blocked) to cancelled
with no refund, leaving the row invisible to the webhook, findStuckPaid and
issueRefund. cancelTransfer now decides with dashboard-cancel-policy
(refuse → Refund / Reverse / Reject) and voids only through the funding-aware
claim cancelIfCancellable, refusing from the fresh row if the claim misses.
Any in_review hold, charged or not, is refused (use Reject): ending a hold is
a compliance decision that stays with admins (Wave 2 review).

tests/dashboard-ops.test.ts 'sets status to cancelled for paid' is INVERTED
on purpose: it asserted the bug. #256's cancel-race case now expects the
Reject copy (the stale hold is refused before any write); its paid assertion
is unchanged.
```
(End the message with the attribution trailer lines from the executing session's system reminder.)

---

#### Step 3A — Customer chat `cancel_bill` on the same guarded claim (RED → GREEN; sits on Task 6's `tools.ts`, ruling 20)

Read first:
- `src/lib/tools.ts:2351-2450`: `cancelBillTool`. Own-phone resolution is at `:2369-2377` via `listOwnB2bTransfers` (`:2302-2305`); the ownership assertion is at `:2381`; the `awaiting_payment` upsert is at `:2383-2389`.
- `tests/tools.test.ts:3403-3442`: the L1 harness (`mintB2b` mints an `ach_pull` B2B bill through `create_transfer`; `forceStatus`).
- `tests/tools.test.ts:3529-3650`: the `cancel_bill` describe.
- `tests/tools.test.ts:27` already imports `createTransferRepo`, and `db` is the per-test PGlite (`:39`).

Re-find these by content after the rebase onto Task 6 (Step 0.2).

**3A.1 Write the failing tests.** In `tests/tools.test.ts`, inside `describe('cancel_bill', …)`, insert directly after the `STRICT ownership: a stranger cannot cancel the owner's paid bill` test (its `});` is `:3649`) and before the describe's closing `});` (`:3650`):

```ts
    // ── Phase 1 Task 5 (money-05 class): the void is the guarded claim, never a full-row upsert ──
    it('awaiting_payment but already CHARGED (card-funded bill, fundingRef set) ⇒ NOT cancelled; customer-safe reply; the charged row stays for the resume sweep', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      const t = (await ctx.store.getTransfer(id))!;
      await ctx.store.saveTransfer({ ...t, fundingMethod: 'credit_card' }); // a B2B bill paid by card (pay-finalize.ts)
      await createTransferRepo(db).setFundingRef(id, `mockfund-${id}`);   // the capture landed; settlement has not run yet
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.cancelled).toBe(false);
      expect(r.error_code).toBe('payment_processing');
      expect(r.transfer_id).toBe(id);
      expect(String(r.reply_hint).toLowerCase()).toContain('already being processed');
      expect(String(r.reply_hint)).not.toMatch(/mockfund|partner|blocked|reversed/i); // no internal tokens, no promise
      const after = await ctx.store.getTransfer(id);
      expect(after?.status).toBe('awaiting_payment');
      expect(after?.fundingRef).toBe(`mockfund-${id}`);
      expect(after?.refundStatus ?? 'none').toBe('none');
    });

    it('a bill that SETTLES between the read and the cancel is never overwritten (the old full-row upsert wrote cancelled over paid)', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      let raced = false;
      const racyStore: typeof ctx.store = {
        ...ctx.store,
        async listTransfersByPhone(partnerId, phone, limit) {
          const snapshot = await ctx.store.listTransfersByPhone(partnerId, phone, limit); // sees awaiting_payment
          if (!raced) {
            raced = true;
            await ctx.store.updateTransferFromWebhook(id, 'paid'); // the settlement wins after the read
          }
          return snapshot;
        },
      };
      const r = await executeTool('cancel_bill', {}, { ...ctx, store: racyStore });
      expect(r.cancelled).toBe(false);
      expect(r.error_code).toBe('payment_processing');
      const after = await ctx.store.getTransfer(id);
      expect(after?.status).toBe('paid');                 // the instructed row stands
      expect(after?.refundStatus ?? 'none').toBe('none');
    });

    it('a bill cancelled concurrently (e.g. by staff) answers "already cancelled" without writing again', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      let raced = false;
      const racyStore: typeof ctx.store = {
        ...ctx.store,
        async listTransfersByPhone(partnerId, phone, limit) {
          const snapshot = await ctx.store.listTransfersByPhone(partnerId, phone, limit);
          if (!raced) {
            raced = true;
            expect(await ctx.store.cancelTransferIfUnfunded(id)).not.toBeNull(); // a staff Cancel lands first
          }
          return snapshot;
        },
      };
      const r = await executeTool('cancel_bill', {}, { ...ctx, store: racyStore });
      expect(r.cancelled).toBe(true);
      expect(r.transfer_id).toBe(id);
      expect(String(r.reply_hint).toLowerCase()).toContain('already cancelled');
      expect((await ctx.store.getTransfer(id))?.status).toBe('cancelled');
    });
```

The existing `awaiting_payment ⇒ flips to cancelled; nothing debited, no refund flag` test (`:3530-3540`, an uncharged `ach_pull` bill) stays byte-identical and must stay green. It is the regression floor for the legal void.

**3A.2 Run and expect failure:** `npx vitest run tests/tools.test.ts -t "cancel_bill"`

Expected RED, against today's `saveTransfer({ ...active, status: 'cancelled' })`:
- Test 1 (charged card bill): `expected true to be false`. Today it voids the charged row.
- Test 2 (settle race): `expected true to be false`. Today it writes `cancelled` over `paid`.
- Test 3 (concurrent cancel): `expected 'cancelled — nothing was debited.' to contain 'already cancelled'`. Today it upserts again and claims nothing was debited.

The other 10 tests in the `cancel_bill` describe (`:3530-3649`) stay green. The test-3 setup line (`cancelTransferIfUnfunded` from Step 2) already exists, so none of the three fails with a `TypeError`.

**3A.3 Implement.** In `src/lib/tools.ts`:

(a) In the `cancelBillTool` docstring, replace the two-line bullet at `:2355-2356`:

```ts
 *   • awaiting_payment → flip to cancelled (nothing was debited — the ACH pull
 *     only fires after the buyer approves+pays).
```

with:

```ts
 *   • awaiting_payment → void through the SAME guarded claim staff Cancel uses
 *     (store.cancelTransferIfUnfunded → transfer-repo.cancelIfCancellable;
 *     Phase 1 Task 5). Only an UNFUNDED bill flips: nothing was debited, since
 *     the ACH pull fires only after the buyer approves and pays. A card-funded
 *     bill whose charge already landed, or a bill that settled after the read,
 *     is NOT cancelled (error_code 'payment_processing'). Never a full-row upsert.
```

(b) REPLACE the `awaiting_payment` case (`:2383-2389`):

```ts
        case 'awaiting_payment':
          await ctx.store.saveTransfer({ ...active, status: 'cancelled' });
          return {
            cancelled: true,
            transfer_id: active.id,
            reply_hint: 'Cancelled — nothing was debited.',
          };
```

with:

```ts
        case 'awaiting_payment': {
          // Phase 1 Task 5 (money-05 class): ONE guarded claim, never a full-row
          // upsert of the row read above. It voids only an UNFUNDED bill; a
          // charged one is left for the funding-resume sweep, and a bill that
          // settled after the read is never overwritten.
          const voided = await ctx.store.cancelTransferIfUnfunded(active.id);
          if (voided) {
            return {
              cancelled: true,
              transfer_id: active.id,
              reply_hint: 'Cancelled — nothing was debited.',
            };
          }
          // The claim missed: answer from the FRESH row and never fall back to a write.
          const fresh = await ctx.store.getTransfer(active.id);
          if (fresh?.status === 'cancelled') {
            return {
              cancelled: true,
              transfer_id: active.id,
              reply_hint: 'This bill payment is already cancelled.',
            };
          }
          return {
            cancelled: false,
            error_code: 'payment_processing',
            transfer_id: active.id,
            reply_hint:
              "This payment is already being processed, so I can't cancel it right now. Ask me again once it settles and I can request a reversal for our team to review.",
          };
        }
```

The replies:
- follow the existing tool contract: the schema description at `:350-351` says "Always relay the tool's reply_hint";
- never promise a reversal (`prompt.ts:154`);
- carry none of the tokens the bot content guard bans (`tests/bot-content-guard.test.ts` scans `content:` literals for `partner` / `corridor` / `watchlist` / `sanctions`; these `reply_hint`s contain none of them).

`ToolResult` is `Record<string, unknown>` (`tools.ts:826`), so no type changes. The header note at `:2255` ("We NEVER call reverseB2bSettlement or cancelTransfer here") stays true: the tool calls the store claim, not the staff function.

**3A.4 Run tests:**

```bash
npx vitest run tests/tools.test.ts tests/bot-content-guard.test.ts tests/agent.test.ts
npm run typecheck
npm run lint
```

Expected: all green; `tsc` and `eslint --max-warnings 0` exit 0. `tests/tools.test.ts` gains exactly 3 tests; the running total is now **+35 tests, +1 file**.

**3A.5 Commit:**
```
fix(tools): cancel_bill voids through the guarded claim, never a full-row upsert (money-05 class)

The buyer's chat cancel wrote saveTransfer({ ...active, status: 'cancelled' })
over a row read earlier: a bill that settled in between had cancelled
written over paid (rail already instructed), and a card-funded bill whose
charge had landed was voided with no refund. It now uses
store.cancelTransferIfUnfunded (Task 5's claim); a miss answers
'payment_processing' (or 'already cancelled') from the fresh row.
```
(End the message with the attribution trailer lines from the executing session's system reminder.)

---

#### Step 4 — UI: Cancel offered only where the server voids it; stale comments corrected (no unit test; tsc + eslint + the Step 6 Chrome walk-through verify it)

CLAUDE.md: UI pages are not unit-tested. The rule they render (`showsStaffCancel` / `decideStaffCancel`) is TDD'd in Step 1. No e2e hook changes: the four scaffold classes, `.sh-page-title` and `aside.sh-sidebar` are untouched.

**4.1 `src/app/admin-dashboard/transactions-tabs.tsx`.**

(a) Insert after `:5` (`import type { Partner, Staff, Tier, Transfer } from '@/lib/types';`). This is a client-safe runtime import: the module's only import is `funding-method.ts`, whose own import is type-only.

```ts
import { showsStaffCancel } from '@/lib/dashboard-cancel-policy';
```

(b) REPLACE `:256-261`:

```tsx
              {(t.status === 'awaiting_payment' || t.status === 'paid') && canCancel && (
                <form action={cancelAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className={MINI_BTN_DANGER}>Cancel</button>
                </form>
              )}
```

with:

```tsx
              {showsStaffCancel(t) && canCancel && (
                // money-05: only an UNCHARGED awaiting_payment row is voidable. A paid
                // transfer is refunded (admin, Details page) or reversed, never cancelled.
                <form action={cancelAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button
                    type="submit"
                    className={MINI_BTN_DANGER}
                    title="Voids this unpaid transfer. Nothing was charged."
                  >
                    Cancel
                  </button>
                </form>
              )}
```

**4.2 `src/app/admin-dashboard/b2b/page.tsx`** (server component).

(a) Insert after `:7` (`import { isPartnerPulled } from '@/lib/funding-method';`); keep that import, since the Reverse branch uses it at `:276`:

```ts
import { decideStaffCancel } from '@/lib/dashboard-cancel-policy';
```

(b) Change `:263` from:

```tsx
                  t.status === 'awaiting_payment' || t.status === 'in_review' ? (
```

to:

```tsx
                  decideStaffCancel(t).kind === 'void' ? (
```

(c) Directly before the `) : t.status === 'delivered' ? (` line (`:289`), insert this branch. It sits after the Reverse branch and renders for the rows the new condition no longer offers Cancel on:
- EVERY `in_review` hold, charged or not;
- a CHARGED `awaiting_payment` row.

```tsx
                  ) : t.status === 'in_review' ? (
                    // A compliance hold, charged or not, is decided by an admin on the
                    // Compliance page (Release / Reject), never by Cancel (Task 5,
                    // Wave 2 review). Reject is cancel-only when uncharged and
                    // cancel + auto-refund when charged.
                    <span key="actions" className="text-xs text-muted-foreground">In review — decide in Compliance</span>
                  ) : t.status === 'awaiting_payment' ? (
                    // CHARGED (a card-funded B2B bill, pay-finalize.ts:145-151): a bare
                    // cancel would strand the charge; the reconcile sweep resumes it. money-05.
                    <span key="actions" className="text-xs text-muted-foreground">Charged — settling</span>
```

**4.3 `src/app/admin-dashboard/b2b/actions.ts`.** Docstring only. REPLACE `:94-100` with:

```ts
/**
 * Cancel an UNFUNDED B2B transfer: awaiting_payment with no fundingRef. The
 * rule is dashboard-cancel-policy.decideStaffCancel, enforced by cancelTransfer:
 *   • a partner-pulled (ach_pull / bank_pull) awaiting row never carries a
 *     fundingRef, so it is always a clean void;
 *   • an in_review HOLD, charged or not, is REFUSED: ending a hold is a
 *     compliance decision, so an admin Rejects or Releases it on the Compliance
 *     page (Task 5, Wave 2 review). The pre-check below still admits in_review
 *     so staff get the Reject copy from the guard;
 *   • a CARD-funded bill that was already charged (pay-finalize.ts) is REFUSED
 *     too; the reconcile sweep resumes it.
 * A *paid* ach_pull is steered to Reverse here first so staff see the
 * B2B-specific copy.
 */
```

**4.4 `src/app/api/pay/[transferId]/route.ts`.** Comment only. The comment says the guard is "planned"; after this merge it exists. REPLACE the two lines at `:182-183`:

```ts
      // leaves a cancelled row that WAS charged — fix 5's planned
      // `funding_ref IS NULL` cancel guard cannot see that window either). Say
```

with:

```ts
      // leaves a cancelled row that WAS charged — fix 5's staff cancel claim,
      // transfer-repo.cancelIfCancellable (`funding_ref IS NULL`), cannot see
      // that window either). Say
```

Rebase notes for this file:
- If Task 6 changed neighbouring lines of this route (ruling 16), keep 6's lines and re-apply only this comment edit.
- **Task 11 also edits `route.ts`**, in regions disjoint from this one: `:110-124` (the rail/brand integrations fetch) and `:167-171` (the `settleOrHold` call), against this task's `:182-183` comment. Task 11 merges after this task and rebases onto it. Neither PR should reflow the other's lines.

**4.5 Verify:**

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0 (`eslint . --max-warnings 0`). Each JSX branch has a single child, so `react/jsx-key` needs no new keys; the new `<span>` carries `key="actions"` like its siblings.

**4.6 Commit:**
```
ui(admin-dashboard): offer Cancel only where the server would void it (money-05)

Transactions list: Cancel only on an uncharged awaiting_payment row
(showsStaffCancel): paid rows lose the button. B2B page: Cancel only when
decideStaffCancel voids (an unfunded awaiting draft). Holds show "In review —
decide in Compliance" and charged awaiting rows show "Charged — settling".
Comments in b2b/actions.ts and the pay route name the shipped guard.
```
(End the message with the attribution trailer lines from the executing session's system reminder.)

---

#### Step 5 — Full verification (the Stop hook enforces it; quote the output verbatim in the PR)

```bash
cd ~/dev/wt/admin-dashboard
npm run typecheck                          # expect: exit 0, no output
npm run lint                               # expect: exit 0 (--max-warnings 0)
npx vitest run tests/dashboard-cancel-policy.test.ts tests/transfer-repo.test.ts tests/dashboard-ops.test.ts \
  tests/admin-actions-scope.test.ts tests/tools.test.ts tests/bot-content-guard.test.ts tests/agent.test.ts \
  tests/reconcile.test.ts tests/settlement.test.ts tests/pay-route-funding.test.ts
npx vitest run                             # FULL suite: expect Step 0.4 baseline + 1 file, + 35 tests, 0 failed
```

**CI migration drift check** (mirrors `.github/workflows/ci.yml:38-52`; this task has no DDL):

```bash
npx drizzle-kit generate --name ci_drift_check
git status --porcelain -- drizzle/         # expect: EMPTY (drizzle-kit prints "No schema changes, nothing to migrate")
git checkout -- drizzle/ && git clean -fdq drizzle/
```

If a PGlite suite flakes in the parallel run, re-run that single file and quote both runs. Never skip it (CLAUDE.md gotcha).

**Caller and contract sweep** (quote in the PR):

```bash
grep -rn "cancelTransfer(" src tests
#   src/lib/dashboard-ops.ts (definition), src/app/admin-dashboard/actions.ts:61, src/app/admin-dashboard/b2b/actions.ts (the await, shifted by the 4.3 docstring), tests/dashboard-ops.test.ts
grep -rn "decideStaffCancel\|showsStaffCancel\|CANCEL_REFUSAL" src tests
#   dashboard-cancel-policy.ts, dashboard-ops.ts, transactions-tabs.tsx, b2b/page.tsx, tests/dashboard-cancel-policy.test.ts — nothing else
grep -rn "cancelIfCancellable\|cancelTransferIfUnfunded" src tests
#   transfer-repo.ts, store.ts, dashboard-ops.ts, tools.ts (cancel_bill + its docstring), reconcile.ts (comments :183-184, unchanged),
#   pay route (comment), tests/transfer-repo.test.ts, tests/tools.test.ts (the concurrent-cancel setup)
grep -rn "updateTransferIfStatus" src tests
#   store.ts (definition), dashboard-ops.ts assignTransfer ONLY: cancel no longer uses it
grep -rn "status: 'cancelled'" src
#   EXACTLY two writers: dashboard-ops.ts rejectTransfer (in_review claim + refund, one txn) and transfer-repo.ts cancelIfCancellable.
#   The tools.ts cancel_bill upsert is gone.
grep -n "saveTransfer" src/lib/tools.ts
#   no hit inside cancelBillTool
```

---

#### Step 6 — Security review, PR, merge, live verification

**6.1** Run `/security-review` on the branch; it touches money and server actions. The diff must answer:
- (a) Every action still self-gates: `requirePermission('canCancel')` → `getScopedTransfer` (404-never-403) → lib guard, in that order (test `m3`).
- (b) No new input crosses the edge: the policy reads only ledger columns.
- (c) The refusal copy carries no PII (test-pinned: `/@|\d{4,}/`).
- (d) No money moves from a `canCancel` (possibly non-admin) click: `cancelTransfer` enqueues nothing (outbox-empty assertions).
- (d2) No compliance decision is reachable through Cancel. Every `in_review` row is refused by the decision (tests `c7`, `m4`) AND by the claim's `WHERE` (repo test 2), including for platform staff on the B2B page. Holds leave review only via Release or Reject (`requireAdmin`, `src/lib/auth.ts:36-40`).
- (e) The only new query is Drizzle-builder DML with a bound id, column-targeted, and never touches the encrypted columns (repo test 1).
- (f) Customer chat `cancel_bill`:
  - It still resolves only the caller's own tenant-scoped rows and asserts `active.phone === ctx.phone` before the claim (the existing STRICT-ownership test stays green).
  - It takes no id from the model.
  - Its new replies carry no internal token (`fundingRef`, "partner", "blocked") and promise no reversal (Step 3A test 1).

**6.2 Fable 5.1 final review checklist:**
- `git diff origin/main -- src/lib/dashboard-ops.ts`: `cancelTransfer` never calls `saveTransfer` or `updateTransferIfStatus`; its only write is `cancelTransferIfUnfunded`.
- `cancelIfCancellable`'s WHERE is exactly `id AND status = 'awaiting_payment' AND funding_ref IS NULL` (ruling 22; no `in_review`).
- `rejectTransfer`, `issueRefund`, `approveRefund`, `retryRefund` and `reverseB2bSettlement` are byte-identical to main (ruling 21: no shared refund helper).
- `listAwaitingWithFunding`, `findCancelledCharged` and `findStuckPaid` are byte-identical to main.
- `tests/dashboard-ops.test.ts:527-577` (#256 races) is byte-identical except the one `:562` regex (`/changed/i` → `/use Reject/i`), and it is green.
- `decideStaffCancel` has no path from `in_review` to `void`, and `cancelIfCancellable` has no `in_review` in its WHERE. Both are asserted by tests.
- `git diff origin/main -- src/lib/tools.ts` touches only `cancelBillTool`: the docstring bullet and the `awaiting_payment` case. The `in_review` / `paid` / `delivered` branches, the draft-discard tail and every other tool are byte-identical to post-Task-6 main.

**6.3 Push and open the PR:**

```bash
git push -u origin fix/admin-dashboard/safe-staff-cancel
gh pr create --base main --title "fix(admin-dashboard): staff Cancel and chat cancel_bill never void a paid, charged or held transfer (Phase 1 fix 9)" --body-file - <<'EOF'
## Phase 1 fix 9: stop staff Cancel (and the customer chat cancel_bill) from voiding a paid, charged or held transfer

Program-Fix: 9

**Finding:** money-05 (docs/AUDIT-2026-09-14.md §1.4(c)).

**Rulings:**
- 5: transfer-repo is add-only.
- 20: tools.ts is Task 6's in wave 2. This PR is rebased on 6 and touches only `cancelBillTool`; Task 11 rebases onto it.
- 21: guard-only, and there is no shared refund helper. Its predicate `IN ('awaiting_payment','in_review')` is deliberately NARROWED; see ruling 22.
- 22: governs the predicate: `status = 'awaiting_payment' AND funding_ref IS NULL`. Wave 2 review: voiding even an UNCHARGED in_review hold ends a compliance review, and `canCancel` agents (direct POST) and any platform staffer (the B2B page's action checks only scope) could do it. Holds now leave review only via Release or Reject, both requireAdmin.

No migration.

### What PR #256 already did (not redone here)
- cancel/assign status-guarded — no stale full-row upsert can clobber a concurrent paid/delivered
- the `settlement.instruct` handler skips a cancelled row
- the pay route refuses to capture a non-awaiting transfer
- the reconcile sweep alerts `cancelcharged:<id>` for cancelled + charged + unrefunded rows (detection only)

### What was still broken (bf4b083)
- `cancelTransfer` flipped a **paid custodial** transfer to cancelled with no refund (dashboard-ops.ts:26-36; asserted as correct by tests/dashboard-ops.test.ts:63-69). The row then became invisible to the rail callback (transfer-repo.ts:156), findStuckPaid, and issueRefund (paid|delivered only).
- A **charged** in_review or awaiting_payment row, and a **blocked** row, could be bare-cancelled by direct POST. The B2B page's Cancel voided charged card-funded holds.
- Even an **uncharged** in_review hold could be voided, which ends a compliance review, by a non-admin: a `canCancel` agent via direct POST, or any platform staffer via the B2B page (its action checks only scope).
- The transactions list rendered Cancel on paid rows (transactions-tabs.tsx:256).
- The customer chat `cancel_bill` voided an awaiting_payment bill with a full-row `saveTransfer` of a row read earlier (tools.ts:2384). A bill that settled in between had `cancelled` written over `paid` after the rail was instructed. A card-funded bill whose charge had landed was voided with no refund.

### Now
- `src/lib/dashboard-cancel-policy.ts` holds `decideStaffCancel`, a pure, client-safe function returning void / noop / refuse(Refund | Reverse | Reject | already-charged | blocked). The server guard, the transactions list and the B2B page all use it.
- `transfer-repo.cancelIfCancellable` is ONE guarded, column-targeted UPDATE. It is exposed additively as `store.cancelTransferIfUnfunded`. A miss refuses from the fresh row and never falls back to a write.
- `cancelTransfer` keeps its signature (`Promise<void>`), so no caller changes. `cancelTransferAction` still scopes first (404-never-403).
- A compliance hold (`in_review`), charged or not, is NEVER Cancel-voidable: it is refused with the Reject copy, and the claim's WHERE admits only `awaiting_payment`. Holds leave review only via Release or Reject, both requireAdmin, from the Compliance queue that lists every hold (B2B included).
- UI: Cancel appears only on uncharged awaiting_payment rows (list and B2B page). The B2B page shows "In review — decide in Compliance" on holds and "Charged — settling" on charged awaiting rows.
- `cancel_bill`'s awaiting_payment branch voids through the same `store.cancelTransferIfUnfunded` claim. If the claim misses, it answers from the fresh row: "already cancelled", or `payment_processing` with a customer-safe reply that promises nothing. After this PR the only `status: 'cancelled'` writers in `src/` are `rejectTransfer`'s in-review claim (which commits with the refund) and `cancelIfCancellable`.

### Behaviour changes
1. Cancel on a paid transfer now throws "use Refund" (custodial) or "use Reverse" (partner-pulled, unchanged). Before, it silently voided the row.
2. Cancel on ANY in_review hold, charged or not, throws "use Reject" (admin, Compliance page). The B2B page no longer offers Cancel on holds. Cancel on a charged awaiting_payment row throws "already been charged", and the funding-resume sweep settles or holds the row.
3. Cancel on a blocked row throws. Nothing in the UI offered it.
4. A cancel that loses a race refuses from the fresh row: "use Refund" after a concurrent paid flip, "changed concurrently" otherwise. Before, it was always "changed concurrently". A stale read of a hold is refused at the decision with the Reject copy; #256's cancel-race test regex is updated to match, and its money assertion is unchanged.
5. INVERTED test: `'sets status to cancelled for paid'` asserted the bug.
6. The buyer's chat "cancel the payment" on a card-funded bill whose charge has landed (or one that settled a moment earlier) no longer cancels it. The bot relays: "This payment is already being processed, so I can't cancel it right now. Ask me again once it settles and I can request a reversal for our team to review." Uncharged `ach_pull` bills cancel exactly as before.

### Residuals (documented, not fixed here)
- Capture↔cancel window: the PSP has charged but `setFundingRef` has not landed yet (pay route `captureFunding`). The funding-aware claim cannot see this window. #256's `cancelcharged:<id>` alert and the pay route's `pay.charged-but-cancelled` log remain the net. Closing it needs a pre-capture claim in the money-paths route (ruling 7 gate order).
- Historical cancelled + charged + unrefunded rows (if any) keep their `cancelcharged:` alerts. The remedy is a refund at the funding provider plus a change-ticket ledger edit (issueRefund accepts paid|delivered only).
- **Partner signal.** Partner-API transactions are funded at the partner, so they carry no `fundingRef` and an unpaid one stays staff-voidable. A void, or a Reject of a partner-API hold, sends the partner NO signal:
  - SmartRemit has no outbound partner events.
  - The partner sees `status: 'cancelled'` only by polling `GET /api/partner/v1/transactions/:id` or the list.
  - A later confirm returns 409.
  - A partner that collected before confirm must refund its own customer, and today learns of that only by polling.
  - **Follow-up:** a signed outbound `transaction.cancelled` event, under Program-Fix 31 (partner reconciliation surface, rail-10).
  - **Ops note until then:** when voiding or rejecting a partner-API row, tell the partner out-of-band.
- `cancelB2bTransferAction` gates on platform scope only, with no `canCancel` or role check (b2b/actions.ts:32-38). After this PR it can only void an unfunded awaiting draft, so it moves no money and ends no hold. The missing `canCancel` check is a separate permissions follow-up ticket.

### Proof
(Step 5 output quoted verbatim: typecheck, lint, the targeted vitest run, the full vitest run with file/test counts vs the baseline, the drift check, and the caller sweep.)

### Security review
(Step 6.1 summary.)
EOF
```

Before submitting:
- Replace the two parenthesised Proof / Security lines with the actual quoted outputs. The PR is never opened with them unfilled.
- Append the PR attribution footer exactly as the EXECUTING session's system reminder gives it. Never hardcode a model name or session URL.

**6.4 Merge.**
1. Wait for `ci / ci` to go green.
2. Squash-merge, after Tasks 9 and 6 are on main (Step 0.1). There is no migration, so no `drizzle-kit migrate` step.
3. Run `/post-merge-check`. Expect "no pending migrations", then a green post-deploy `smoke.yml` for the merge SHA.

**6.5 Live verification on production** (read-only; a fix is `done` only when merged + smoke green + verified).

(a) **Ledger invariant.** Run this before the merge and again after the deploy. The prod connection is used read-only (`readOnly: true` is a documented option: `node_modules/@neondatabase/serverless/index.d.ts:575`; tagged-template usage: `:503-529`). It prints counts only: no ids, no PII, no secret.

```bash
cd "/Users/nagavenkatasai/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments"
set -a; source .env.local; set +a; node - <<'EOF'
const { neon } = require('@neondatabase/serverless');
const q = neon(process.env.DATABASE_URL, { readOnly: true });
q`SELECT status, (funding_ref IS NOT NULL) AS charged, refund_status, count(*)::int AS n
    FROM transfers WHERE status = 'cancelled' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`
  .then((rows) => console.table(rows));
EOF
```

If the iCloud checkout's `node_modules` stalls (dataless files, CLAUDE.md), run the same command from `~/dev/wt/admin-dashboard`, sourcing the main checkout's `.env.local` by absolute path. Expected: the `charged = true, refund_status = none` count after deploy is **no higher** than the pre-merge baseline. Record both tables (counts only) in the PR comment.

(b) **Claude-in-Chrome walk-through** against https://smartremit.ai, as the seeded admin. The owner enters the credentials from Vercel env `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`; they are never typed into chat or the PR.
- `/admin-dashboard/transactions`:
  - **Paid** tab: the Actions column shows `Details` (plus Assign) and **no** `Cancel` on any row. Use `find` "Cancel button" and expect 0 matches in the table.
  - **Awaiting** tab: `Cancel` appears only on rows whose Details page shows Funding "Uncharged". Open one row with Cancel and one without, if the data has both.
  - **In review** and **Blocked** tabs: no `Cancel`.
- `/admin-dashboard/b2b`: `Cancel` appears only on uncharged `awaiting_payment` rows. Every `in_review` row shows "In review — decide in Compliance" and NO Cancel. A charged card-funded awaiting row, if one exists, shows "Charged — settling". A paid ach_pull row still shows `Reverse`.
- `/admin-dashboard/compliance`: the same B2B holds appear in "Needs review" with Reject (and Release where `canReleaseHeld` allows it).
- Do NOT click Cancel on production data, and do NOT send "cancel the payment" to the production WhatsApp bot on a real buyer's bill. The void and refusal paths are proven against real Postgres (PGlite): Step 3 covers the staff path, including the public server action, and Step 3A covers the chat path, including both races.
- Record screenshots or the find-results in a PR comment.

(c) Run `/outbox-status` and confirm no `dead` `settlement.instruct` rows or new stuck-paid rows appeared since the deploy (sanity only; this task enqueues nothing).

**6.6** Run `/tracker-sync`, which marks Program-Fix 9 done with the merge SHA, smoke run and verification evidence. Then run `/sync-branches` so `component/admin-dashboard` equals main.

---

#### Out of scope (each stated in the PR) and rebase notes for later tasks

**Out of scope:**
- **`cancel_bill`'s other branches.** `in_review` still defers, `paid` still only requests a reverse (the guarded `none → requested` refund flag), and `delivered` still opens a recall case. None of them writes `status`. The tool-schema description and `prompt.ts:154` are unchanged.
- **Capture↔cancel residual window:** see the PR "Residuals". Closing it needs a pre-capture claim in `route.ts` (money-paths, ruling 7).
- **Audit row for b2c cancel:** the staff audit trail belongs to Program-Fix 17 (staff auth + audit) and Program-Fix 28 (compliance decisions).
- **Outbound partner event on a void or reject.** Partner-API rows are funded at the partner (no `fundingRef`). A void of an unpaid row, or a Reject of a partner-API hold, sends the partner no signal: it sees `status: 'cancelled'` only by polling, and a later confirm returns 409. A signed outbound `transaction.cancelled` event is a new outbound-webhook surface (signing, retries, per-partner endpoint), so it is a follow-up under Program-Fix 31 (partner reconciliation surface, rail-10). The PR records the interim ops note: tell the partner out-of-band.
- **`cancelB2bTransferAction`'s permission gate** (`b2b/actions.ts:32-38`): platform scope only, with no `canCancel` or role check. After this task it can only void an unfunded awaiting draft, so it moves no money and ends no hold. Adding `requirePermission('canCancel')` there is a separate permissions follow-up.
- **`completePaymentStage2`'s full-row `saveTransfer`** (`src/lib/payment.ts:187`, the mock.settle path): after this task Cancel cannot touch a paid row, so it no longer races it.

**Rebase notes:**
- **Task 6 (Program-Fix 10) → this task.** Step 3A sits ON TOP of Task 6's `src/lib/tools.ts` and `tests/tools.test.ts` (ruling 20: 6 owns `tools.ts` in wave 2 and merges first).
  - Rebase onto post-6 main before Step 3A.
  - Re-find the three anchors by content (Step 0.2 greps), not by line number.
  - If 6 changed the `mintB2b` / `forceStatus` / `buildCtx` helpers in `tests/tools.test.ts`, use 6's versions: the three new tests depend only on `buildCtx`, `mintB2b`, `executeTool`, `createTransferRepo` and `db`.
  - If 6 edited `cancelBillTool` itself (not expected: 6's scope is the masked-destination mint guard), keep 6's lines and re-apply only the docstring bullet and the `awaiting_payment` case.
- **Task 11 (Program-Fix 18)** merges after this one and shares TWO files with it, both in disjoint regions:
  - **`src/lib/tools.ts`:** its two enqueue-payload edits (`billpush:` and `enqueueSellerLink`; ruling 20 cites them at `tools.ts:1733/1780` against the Wave 1 plan's base) do not overlap this task's `cancelBillTool` edits.
  - **`src/app/api/pay/[transferId]/route.ts`:** Task 11 edits `:110-124` (the rail/brand integrations fetch) and `:167-171` (the `settleOrHold` call). This task changes only the comment at `:182-183` (Step 4.4).
  - Task 11 rebases onto post-5 main. Neither PR reflows the other's lines. It touches none of this task's other files.
- **Task 4 (Program-Fix 8, rail failure; ruling 22)** must re-run `tests/dashboard-ops.test.ts`, `tests/transfer-repo.test.ts` and `tests/dashboard-cancel-policy.test.ts` green.
  - If it adds a terminal-failed `TransferStatus`, `tsc` fails in `decideStaffCancel`'s `never` branch until it adds a case. Expected: `refuse` (the failure path owns the refund), or `noop` once the refund is in flight.
  - It must also add a tab/pill for the new status in `transactions-tabs.tsx`.
  - It reuses the `funding.refund` kind with the `refund:<id>` dedupe key inline (ruling 21), never a Cancel path.


---

### Task 11: Stop persisting secrets in outbox payloads — resolve WhatsApp creds at drain time and seal the partner-application link (F49, F54, F58, F66)

**Program-Fix:** 18 · **Findings:** F49 (`docs/AUDIT-2026-09-14.md:4478`), F54 (`:4559`), F58 (`:4607`), F66 (`:4754`); manifest row `:114` · **Component:** outbox-worker · **Branch:** `fix/outbox-worker/no-secrets-in-outbox` · **Model:** Fable 5.1 (durability spine, money-path signatures, crypto, a data migration) for the build and the final review · **Wave 2**, merge order 9 → 6 → 5 → **11** (Program-Fix 13 → 10 → 9 → **18**) · **Migration:** `0016_scrub_outbox_secrets` (data-only, pre-assigned by the Migration Gate, `docs/superpowers/plans/2026-09-16-phase1-wave1-money-safe-core.md:76-85`).

**Conflict rulings this PR operates under** (`2026-09-16-phase1-wave1-money-safe-core.md:36-74`; quote them in the PR body): **#1** (migration numbering: 11 → 0016; merge → `/migrate-prod` → smoke green before the next migration PR), **#18** (3↔11: this task drops the creds parameter from the settlement entry points and persists `partnerId`, on top of Task 3 (PF 6)'s arms), **#19** (7↔11: 7 owns claim/lease/deadline; 11 owns the send handlers and the payload shape; the scrub migration runs AFTER the code deploy and after the backlog check), **#20** (6↔11: `tools.ts` edits rebase onto Task 6 (PF 10)'s tree), **#27** (8↔11: Task 8 keeps this task's per-batch `partner` resolver and deletes this task's transition shim).

**Numbering.** Repo code comments and test names use "fix N" for plan **Task** N: `fix 7` is the lease work and `fix 1` is tenant scoping. So in code this task is **`fix 11`**. The prose of this plan says "Task N (PF M)" or "Program-Fix 18" and never a bare "fix N".

Every `file:line` below was read at `origin/main` = `bf4b083` (Wave 1 merged: #254 Task 7 (PF 11) leases/deadlines + drizzle 0014, #255 Task 1 (PF 4) tenant-scoped customers + drizzle 0015, #256 Task 3 (PF 6) compliance hold). Every code block in Steps 1-9 was applied to a scratch copy of `bf4b083` and run, and re-run after the Wave 2 review fixes: full suite `171 files / 2291 tests` → `174 / 2325` green, `tsc --noEmit` clean, `eslint . --max-warnings 0` clean, CI's drift command prints `No schema changes, nothing to migrate` with a clean `git status drizzle/`. Each new test was also run against the unmodified `bf4b083` sources to record the exact RED output quoted in its step. Tasks 9, 6 and 5 merge first; Step 0 re-verifies that none of them touched the blocks this task replaces.

---

#### Ground truth at `bf4b083` — what persists a secret today

`outbox.payload` is plain `jsonb` (`src/db/schema.ts:529`). `markDone` only flips status (`src/db/repos/outbox-repo.ts:120-127`), and nothing deletes rows. A copy of a secret in a payload therefore stays in cleartext for as long as the table exists, next to the envelope-encrypted original (`partner_integrations.wa_token_enc`, `src/db/repos/integrations-repo.ts:47-50`, `:67`).

**Census.** At `bf4b083` there are 36 `.enqueue(` call sites under `src/` (`git grep -n "\.enqueue(" -- src`). Task 9 (PF 13) adds two more before this task lands, making 38: `sweepFxHealth` in `src/lib/rate-staleness.ts` and a schedule-refused alert in `src/lib/cron-run.ts`. Both are `ops.alert` enqueues with a `{ message }` payload. The Step 7 gate scans them like every other `src/` file. 28 carry only ids or operator text: `account/actions.ts:98`; `partner-rail/route.ts:86`; `partners-action.ts:96` (team lead email); `dashboard-ops.ts:69,188,231,257,296`; `outbox-worker.ts:493,627`; `payment-provider.ts:81`; `rate-staleness.ts:28`; ten sites in `reconcile.ts:71-232`; `settlement.ts:74,76`; `ticket-triage.ts:24`; `tools.ts:2222,2511`; `whatsapp-inbound.ts:151` (`agent.turn` already carries `routedPartnerId`, never creds — `:146-155`). **Eight write a secret:**

| # | Site | What is persisted | Finding |
|---|---|---|---|
| 1 | `src/lib/settlement.ts:117-122` (`beginSettlement`, stage-1) | `creds: waCreds`, the 4th parameter (`:101`) | F49 |
| 2 | `src/lib/settlement.ts:158-162` (`beginHold`, held stage-1) | `creds: waCreds` (`:151`) | F49 |
| 3 | `src/lib/outbox-worker.ts:396-400` (`funding.refund` → `refundmsg:`) | `creds: waCreds` resolved at `:386` | F54 |
| 4 | `src/app/admin-dashboard/tickets/actions.ts:111-119` (`ticketmsg:`) | `creds: waCreds` resolved at `:99` | F58 |
| 5 | `src/app/admin-dashboard/tickets/actions.ts:219-227` (`ticketresolved:`) | `creds: waCreds` resolved at `:214` | F58 |
| 6 | `src/lib/tools.ts:1753-1761` (`billpush:`) | `...(ctx.waCreds ? { creds: ctx.waCreds } : {})` | F58 |
| 7 | `src/lib/tools.ts:1800-1804` (`enqueueSellerLink` → `sellerbill:`, `selleronboard:`) | the same spread | F58 |
| 8 | `src/app/partners-action.ts:115-128` (`partner_app_invite:`) | the raw 30-day token inside `text` (`:123`) | F66 |

Sites 1 and 2 are reached from five settlement callers: `src/app/api/pay/[transferId]/route.ts:171`, `src/app/api/pay/b2b/[invoiceId]/route.ts:248`, `src/lib/reconcile.ts:133`, and `src/lib/partner-api-service.ts:410` (`beginHold`) and `:429` (`settleOrHold`). `releaseHold` (`settlement.ts:212-223`, called from `dashboard-ops.ts:150`) never took creds.

**The one consumer.** `outbox-worker.ts:193-208`: `whatsapp.text` and `whatsapp.template` read `p.creds`. Every other handler already resolves creds at drain time through `partnerContext` (`:179-187`): `mock.settle` (`:213`), `rail.callback` (`:317`) and `agent.turn` (`:502-506`).

**How a routed partner's creds resolve after Task 1 (PF 4).** Customer-facing creds always come from the OWNING tenant: `transfer.partnerId`, `ticket.partnerId`, or the routed tenant of an agent turn. The agent turn's `routedPartnerId` is validated as an ACTIVE partner (`outbox-worker.ts:488-501`). The worker route then builds the agent with `waCreds` resolved from that partner and `partnerId: routedPartnerId ?? DEFAULT_PARTNER_ID` (`src/app/api/worker/route.ts:74-89`). So inside a tool, `ctx.waCreds` is set **only** on a partner's BYO number, and `ctx.partnerId` is then that same partner. Rail config is a different path: it resolves from `settlementPartnerId ?? partnerId` and is untouched here. `waCredsFrom` (`src/lib/whatsapp-creds.ts:8-16`) returns `undefined` unless both `phoneNumberId` and `token` are set. A partner with no integrations row resolves to `EMPTY_PARTNER_INTEGRATIONS` (`integrations-repo.ts:31`), which means the shared env number and never a throw. `getPartnerIntegrationsStore()` is the same repo as the worker's `createIntegrationsRepo` (`src/lib/partner-integrations-store.ts:15-20`). A drain-time read therefore returns exactly what the enqueue-time read returned, except that a token rotated in between is now picked up.

**Left alone: direct in-process sends that are never persisted.** `pay/[transferId]/route.ts:299` (OTP), `pay/b2b/[invoiceId]/route.ts:102` (OTP), `payment-webhook/[provider]/route.ts:117`, `whatsapp/route.ts:75`, `whatsapp/[partnerId]/route.ts:73`, `cron/route.ts:49`, `onboard/seller/[id]/actions.ts:55`, `MockPaymentProvider`'s in-memory `waCreds` (`providers/payment-provider.ts:105-120`). Also unchanged: `ToolContext.waCreds` (`tools.ts:802`), `AgentDeps.waCreds` (`agent.ts:39`), and the `WorkerDeps.sendText/sendTemplate/runAgentTurn` creds parameters (`outbox-worker.ts:46-74`).

**What reads payloads besides the worker** (all unaffected, and none of them prints a payload):
- `scripts/outbox-status.ts:102` and `reconcile.ts:209` read `payload->>'transferId'` on `funding.refund` rows.
- The ops copilot reads `payload.partnerId` on dead rows to find the provider type (`src/app/api/copilot/ops-diagnose/route.ts:84-95`). Dead `whatsapp.*` rows will now name their partner. That is a read-only improvement.
- The ops page renders dead rows' `id/kind/lastError` only (`src/app/admin-dashboard/ops/page.tsx:155-167`).

---

#### Design (read before Step 1)

**WhatsApp creds.** Every customer-facing `whatsapp.text` / `whatsapp.template` payload stores the **owning `partnerId`**, never creds. The worker resolves `waCredsFrom(getIntegrations(partnerId))` **at drain time**, through one resolver per claimed batch (`memoizedPartnerContext`). N rows for one partner therefore cost one partner read and one integrations read. A rejected lookup is evicted so the next row re-reads it. The resolver is built after `claimBatch` and passed into `handle(deps, row, signal, partner)`. That is inside Task 7 (PF 11)'s `withRowDeadline` and lease compare-and-set, so a slow lookup is bounded by the row deadline like any other handler I/O. `mock.settle`, `rail.callback` and `agent.turn` switch from `partnerContext(deps, id)` to the same resolver. `agent.turn` keeps its un-memoized ACTIVE-partner check (`:488-501`).

**Settlement entry points.** `beginSettlement(db, transfer, integrations)`, `beginHold(db, transfer)` and `settleOrHold(db, transfer, integrations)` lose their creds parameter. The stage-1 row names `paid.partnerId` / `held.partnerId`, taken from the claim's RETURNING row, so no read is added inside the money transaction. All five callers stop resolving brand creds. The two pay routes and reconcile drop their brand-side integrations read. The partner-API hold path drops its integrations read entirely.

**Tools.** `tools.ts` pushes store `partnerId: routedSenderPartnerId(ctx)`, which is `ctx.waCreds ? ctx.partnerId : undefined`. This is a literal translation of the old `...(ctx.waCreds ? { creds } : {})`: a shared-number turn persists no `partnerId` (drizzle serializes jsonb with `JSON.stringify`, which drops `undefined` keys; `node_modules/drizzle-orm/pg-core/columns/jsonb.js:21-23`, v0.45.2) and still sends on the shared number.

**Partner-application token.** The token is minted once, at enqueue, exactly as today. The full apply link is sealed with `encryptField` (`src/lib/field-crypto.ts:136`) into `payload.sealed.apply_link`, and the text carries a `{{apply_link}}` placeholder. The `email.send` handler renders it with `renderSealedText`, which calls `decryptField` (`:172`) at SEND time. The token is never re-minted per attempt: `setApplicationToken` overwrites the hash (`src/db/repos/aux-repos.ts:212`), so a re-mint on redelivery would kill the link the applicant already holds. That is why the audit's alternative ("mint at send time") is rejected.

**Transition shim and migration.** A row enqueued by the previous release (it has `creds` and no `partnerId`) keeps working through a transition shim in the worker. **drizzle 0016** is data-only and runs after the deploy. Its statements never degrade a row that has not been sent yet:
1. It back-fills `partnerId` on legacy rows by matching `creds.phoneNumberId` to `partner_integrations.wa_phone_number_id`, which is UNIQUE since 0015 (`drizzle/0015_tenant_scoped_customers.sql:10`).
2. It strips `creds` **only** where a `partnerId` is now present (so the creds are replaceable) or the row is `done`/`dead` (so they are no longer needed). An unsent row whose number matches no current partner keeps its creds. Stripping them would send it from the shared number, which likely dead-letters.
3. It redacts legacy cleartext invite links **only** on `done`/`dead` rows. Redacting an unsent invite would email "[redacted…]" to the applicant.

What a too-early run leaves behind is visible in the counts-only `SECRETS AT REST` section of `scripts/outbox-status.ts`. So the runbook has two layers of protection, with the migration's own conditions as the fallback:
- **Timing** (Steps 11.3-11.4): wait until the rolling release has reached 100%, then at least 5 more minutes (the pay route's `maxDuration` is 300 s), and confirm Skew Protection is off or its window has passed.
- **Gate** (Step 11.5): before `/migrate-prod`, every row that still holds a secret must be `done` or `dead`.

After 0016 is applied, the shim is unreachable and Task 8 deletes it.

**Static gate plus runtime tripwire.** `tests/outbox-payload-secrets.test.ts` builds a real `ts.Program` over `tsconfig.json`, so `@/` aliases and types resolve. It checks every `.enqueue(` payload under `src/` with the **type checker**. It fails the build on any of these:
- **TYPE:** the payload's type contains `WaCreds` or any interface of `partner-integrations.ts`, however innocently the key is named (`{ cfg: integrations.whatsapp }`).
- **NAME:** a secret-named key or value, including inside template literals.
- **DATAFLOW:** a payload identifier followed to its local initializer or destructuring (`const note = waCreds.token; { note }` and `const { token: memo } = waCreds; { memo }`); reading a field of a secret-bearing object also counts.
- a payload that is not an inline literal.

`encryptField(...)` is the one sanctioned sealer, and its output is not scanned.

Name matching alone cannot prove a payload is clean. So `outbox-repo.enqueue` also gets a **test-only tripwire**. Under `process.env.VITEST` it throws if a payload carries a secret-bearing shape: a `creds`/`token`/`apiKey`/… key anywhere, or a `{ kyc, payment, whatsapp }` object. The error names paths, never values. The `VITEST` pattern has precedent at `src/lib/rate.ts:45`, `:58`. With it, every producer that any test exercises is checked at runtime too. One limit is documented: a value that crosses a function boundary as a plain `string` parameter is not traced statically.

**Considered and rejected:**
- *A production throw inside `outbox-repo.enqueue`.* It would add a new failure mode inside money transactions. The tripwire is test-only, and the static gate blocks at CI time.
- *Branding `WaCreds.token` as a nominal secret type.* Every `WaCreds` literal in the tests would need a cast, which ripples into three components. Local dataflow catches the same laundering patterns. A branded type is the upgrade path if the documented limit ever bites.
- *Encrypting `creds` in place.* This is the audit's stop-gap. It keeps a secret copy per row and does not pick up token rotation.
- *Scrubbing payloads on `markDone`, or a retention purge.* Once this fix lands no secret remains, so retention becomes a storage and PII concern. That belongs to Program-Fix 37 ("Stop leaking PII into … outbox payloads").

**Invariants (CLAUDE.md, restated where they apply):**
- **Durability spine.** Every effect stays an outbox row written in the same transaction as its state change. No read is added inside any money transaction:
  - `beginSettlement` and `beginHold` use the claim's RETURNING row;
  - the refund handler loses its pre-transaction `partnerContext` read (`outbox-worker.ts:384-386`);
  - the ticket actions lose theirs (`:99`, `:214`);
  - `encryptField` in `partners-action.ts` is CPU-only.
- **Dedupe keys are the idempotency constraint and do not change:** `stage1:`, `instruct:`, `mocksettle:`, `refundmsg:`, `ticketmsg:<t>:<m>`, `ticketresolved:`, `billpush:`, `sellerbill:`, `selleronboard:`, `partner_app_invite:`, `preq:`.
- **At-least-once and idempotent.** Drain-time resolution is a pure read, repeated per attempt. The sealed link is opened per attempt and minted once.
- **Brand vs rail.** Payload `partnerId` is always the OWNER (`transfer.partnerId`, `ticket.partnerId`, or the routed tenant of the turn), never `settlementPartnerId`. Rail config still resolves from `settlementPartnerId ?? partnerId` (`outbox-worker.ts:279`, `:356`; `reconcile.ts:61-63`, `:127-129`). The worker never infers a tenant from `to`.
- **Tenant isolation.** Every persisted `partnerId` is a server-side value: a ledger row, the scoped ticket from `getScopedTicket` (404-never-403, `tickets/actions.ts:29-38`), or the validated routed tenant. It is never a request field.
- **Fail-safe.** An unknown partner, a missing integrations row or a half-configured channel sends on the shared number and never dead-letters. A transient DB error rides Task 7 (PF 11)'s backoff. `MAX_ATTEMPTS`, the `dead:<id>` alert, the lease compare-and-set and `ROW_DEADLINE_MS` are untouched.
- **No secret in logs or `last_error`.** The only new production error text is `sealed-text: no sealed value for {{<key>}}`. The test-only `enqueue` tripwire names payload paths, never values. `field-crypto` errors name the format, never the plaintext (`field-crypto.ts:176-199`).
- **Boot assert mirrors the accepting code.** `FIELD_ENCRYPTION_KEY` is already required, with its shape check (`src/lib/boot-assert.ts:15`, `:76-78`). Sealing adds no new env contract. The key is set-once and never rotated (CLAUDE.md), so sealed rows stay openable.

---

**Files:**
- Create: `src/lib/sealed-text.ts` — the pure `{{key}}` → `decryptField(sealed[key])` renderer.
- Create: `tests/sealed-text.test.ts`.
- Create: `tests/outbox-payload-secrets.test.ts` — the type-aware static build gate and its probe, the enqueue tripwire test, and the 0016 scrub test.
- Create: `tests/drizzle-meta-chain.test.ts` — the guard that keeps CI's drift check from passing vacuously.
- Create: `drizzle/0016_scrub_outbox_secrets.sql` and `drizzle/meta/0016_snapshot.json`, both via `drizzle-kit generate --custom`.
- Modify: `drizzle/meta/_journal.json` — appends idx 16 (written by `drizzle-kit`).
- Modify: `src/lib/outbox-worker.ts` — the drain-time resolver and memoization, the transition shim, the refund payload, sealed email rendering.
- Modify: `src/lib/settlement.ts` (money-paths) — `beginSettlement`, `beginHold` and `settleOrHold` lose the creds parameter; stage-1 rows persist `partnerId`.
- Modify: `src/app/api/pay/[transferId]/route.ts`, `src/app/api/pay/b2b/[invoiceId]/route.ts`, `src/lib/reconcile.ts`, `src/lib/partner-api-service.ts` — the five settlement callers.
- Modify: `src/app/admin-dashboard/tickets/actions.ts` (admin-dashboard) — both nudges persist `ticket.partnerId`; two imports removed.
- Modify: `src/lib/tools.ts` (whatsapp-agent) — `routedSenderPartnerId`; `billpush:` and `enqueueSellerLink` use it.
- Modify: `src/app/partners-action.ts` (landing-docs) — the sealed `apply_link` and the `{{apply_link}}` placeholder.
- Modify: `src/db/repos/outbox-repo.ts` — the test-only tripwire in `enqueue` plus the pure `secretShapePaths` it uses (Step 7), and the `:197-198` comment (Step 9).
- Modify: `scripts/outbox-status.ts` — new `SECRETS AT REST` section (counts only), used by the runbook gates.
- Modify: `docs/SYSTEM-ARCHITECTURE.md` — one paragraph in §7.
- Test (modify): `tests/outbox-worker.test.ts`, `tests/settlement.test.ts`, `tests/partner-api-service.test.ts`, `tests/reconcile.test.ts`, `tests/pay-route-delayed-poke.test.ts`, `tests/ticket-actions.test.ts`, `tests/tools.test.ts`, `tests/partners-action.test.ts`.
- Verified to need no edit:
  - `tests/pay-route-funding.test.ts:118-124` and `tests/pay-route-ach-pull.test.ts:115-121` wrap `settleOrHold` with `(...args: Parameters<typeof real.settleOrHold>)`, so the arity change propagates.
  - `tests/dashboard-ops.test.ts`, `tests/pay-route-in-review.test.ts` and `tests/reconcile.test.ts:79` already call `beginHold(db, t)` with two arguments.
  - `tests/pay-route-bank-details.test.ts` and `tests/pay-route-otp.test.ts` mention creds only in comments.
- Expect the component-boundary hook to flag this PR. `settlement.ts` and the pay routes belong to money-paths, the b2b route to b2b, `partner-api-service.ts` to partner-api, `tickets/actions.ts` to admin-dashboard, `tools.ts` to whatsapp-agent, `partners-action.ts` to landing-docs. The flag is correct: every caller and its test moves in this PR (CLAUDE.md "No collisions").

---

#### Step 0 — Preconditions, worktree, baseline (no code)

1. **Merge-order gate.** The wave table row for 11 reads "After 7 and 3; after 5", and ruling 20 orders 6 → 11. So the PRs for Program-Fix 13 (Task 9), Program-Fix 10 (Task 6) and Program-Fix 9 (Task 5) must be merged, each with `smoke.yml` green on `main` and the ledger synced. No migration may be pending:

   ```bash
   cd ~/dev/wt/outbox-worker && git fetch -q origin
   gh pr list --state merged --search '"Program-Fix: 13" in:body' --json number,title,mergedAt
   gh pr list --state merged --search '"Program-Fix: 10" in:body' --json number,title,mergedAt
   gh pr list --state merged --search '"Program-Fix: 9" in:body' --json number,title,mergedAt
   git rev-list --count origin/component/outbox-worker..origin/main                       # 0 — else run /sync-branches first
   ```

   `.env.local` exists only in the main (iCloud) checkout, not in `~/dev/wt/*`. Run the migration check from the main checkout, sourcing the file inside the command and never printing it:

   ```bash
   cd "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" && git fetch -q origin && git checkout -q --detach origin/main \
     && set -a && source .env.local && set +a && node_modules/.bin/tsx scripts/migration-status.ts   # 0014 + 0015 APPLIED, nothing PENDING
   ```

   If the command stalls at ~0 CPU, iCloud has evicted `node_modules`. Re-materialize it with the CLAUDE.md one-liner (`find node_modules -type f -print0 | xargs -0 -P 64 -n 100 cat >/dev/null`).

2. **Worktree.** The worktree already exists outside iCloud (`~/dev/wt/outbox-worker`; it was left on Task 7 (PF 11)'s branch at `b484a82`). `git status --short` must print nothing. Then:

   ```bash
   git -C ~/dev/wt/outbox-worker checkout -b fix/outbox-worker/no-secrets-in-outbox origin/component/outbox-worker
   ```

3. **Re-anchor after 9/6/5.** Every edit below is an exact "Replace → With" block quoted from `bf4b083`. Apply each with the Edit tool; it anchors on the text, and fails if the text is missing or not unique. The `:line` numbers are those of the unedited `bf4b083` file and drift as earlier edits in the same step land. Confirm that no predecessor touched these blocks:

   ```bash
   git diff bf4b083..origin/main --stat -- src/lib/settlement.ts src/lib/outbox-worker.ts src/lib/reconcile.ts \
     src/lib/partner-api-service.ts "src/app/api/pay/[transferId]/route.ts" "src/app/api/pay/b2b/[invoiceId]/route.ts" \
     src/app/admin-dashboard/tickets/actions.ts src/app/partners-action.ts src/db/repos/outbox-repo.ts scripts/outbox-status.ts
   git diff bf4b083..origin/main -U0 -- src/lib/tools.ts | grep -n "enqueueSellerLink\|billpush\|ctx.waCreds"   # expected: no hit
   git grep -n "\.enqueue(" -- src | wc -l    # 36 at bf4b083; 38 after Task 9 (sweepFxHealth + cron-run schedule-refused ops.alert) — the Step 7 gate scans every site
   ```

   Expected predecessor edits (from the Task 9, 6 and 5 plans; `bf4b083` line numbers). None overlaps a block this task replaces:

   | File | Task 9 (PF 13) | Task 6 (PF 10) | Task 5 (PF 9) | This task's blocks |
   |---|---|---|---|---|
   | `src/lib/partner-api-service.ts` | `createQuote` / `createTransaction` `getFxRates` guards (ruling 11) | `:10` import; an edge refusal above `:283` | — | `:15`, `:405-410`, `:423-429` |
   | `src/app/api/pay/[transferId]/route.ts` | `:26` import, `:445-452` | `:23` import, `:80-84`, `:410` | `:182-183` comment | `:110-124`, `:167-171` |
   | `src/app/api/pay/b2b/[invoiceId]/route.ts` | `:11` import, `:180`, `:193-196` | — | — | `:239-248` |
   | `src/lib/tools.ts` | `getFxRates` call-site guards | `send_approve_picker` / `maskAccount` (ruling 14) | `cancel_bill` (its Step 3A) | `:1758`, `:1789-1804` |
   | `src/lib/rate-staleness.ts`, `src/lib/cron-run.ts` | two new `ops.alert` enqueues (`{ message }`) | — | — | none; the Step 7 gate scans them |

   Any other hunk in the files of the `--stat` list is unexpected: read it before editing. If a replaced block moved, re-cite it from the diff before editing. Also check the settlement signature is still the bf4b083 one:

   ```bash
   git grep -n "settleOrHold(\|beginHold(\|beginSettlement(" -- src tests
   ```

   Expected: the five `src` callers listed in Ground truth, plus `settlement.ts` itself.

4. **Baseline** (quote the output in the PR as the "before" proof):

   ```bash
   npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run
   ```

   At `bf4b083` this is `Test Files 171 passed (171) · Tests 2291 passed (2291)`. After 9/6/5 the counts are higher; record them. This task adds **+3 files and +34 tests**.

5. All commits and the PR end with the attribution lines from the executing session's system reminder. PR body format is in Step 10.

---

#### Step 1 — Pure helper `renderSealedText` (RED → GREEN)

1. Create `tests/sealed-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderSealedText } from '@/lib/sealed-text';
import { encryptField, decryptField, EnvKeyProvider } from '@/lib/field-crypto';

// sealed-text — the ONE way an outbox payload may carry a capability (fix 11 /
// F66): the value is sealed with field-crypto at enqueue and opened at SEND time.
// tests/setup.ts pins FIELD_ENCRYPTION_KEY to 32×0x07, so the default provider
// matches this one — injected explicitly to keep the test env-independent.
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const open = (blob: string) => decryptField(blob, provider);

describe('renderSealedText', () => {
  it('replaces each {{key}} with the DECRYPTED sealed value', () => {
    const sealed = { apply_link: encryptField('https://smartremit.test/partners/apply/abc', provider) };
    expect(renderSealedText('Hi,\n\n{{apply_link}}\n\nBye', sealed, open)).toBe(
      'Hi,\n\nhttps://smartremit.test/partners/apply/abc\n\nBye',
    );
  });

  it('returns the text untouched when nothing is sealed (legacy rows, plain emails)', () => {
    expect(renderSealedText('plain text', undefined, open)).toBe('plain text');
    expect(renderSealedText('plain text', null, open)).toBe('plain text');
    expect(renderSealedText('no placeholders', {}, open)).toBe('no placeholders');
  });

  it('throws naming ONLY the placeholder (never a value) when a key has no sealed blob', () => {
    expect(() => renderSealedText('x {{apply_link}} y', {}, open)).toThrow(
      'sealed-text: no sealed value for {{apply_link}}',
    );
  });

  it('a tampered blob fails closed (the field-crypto auth error propagates)', () => {
    const blob = encryptField('https://x', provider);
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => renderSealedText('{{apply_link}}', { apply_link: tampered }, open)).toThrow();
  });

  it('defaults to the env key provider (the worker calls it without an opener)', () => {
    const sealed = { apply_link: encryptField('https://smartremit.test/partners/apply/def') };
    expect(renderSealedText('{{apply_link}}', sealed)).toBe('https://smartremit.test/partners/apply/def');
  });
});
```

2. Run `npx vitest run tests/sealed-text.test.ts`. **Expected RED:** `Error: Cannot find module '@/lib/sealed-text' imported from …/tests/sealed-text.test.ts`.

3. Create `src/lib/sealed-text.ts`:

```ts
import { decryptField } from '@/lib/field-crypto';

// sealed-text — renders `{{key}}` placeholders in a durable email payload from a
// map of field-crypto blobs. This is how the ONE outbox payload that must carry
// a capability (the partner-application invite link, fix 11 / F66) stays
// ciphertext at rest: the link is sealed with encryptField at ENQUEUE and opened
// here at SEND time. The token is minted exactly once (partners-action.ts) —
// never per attempt: setApplicationToken overwrites application_token_hash, so a
// re-mint on an at-least-once redelivery would kill the link already delivered.
//
// Pure, with an injectable opener so it is unit-tested without env. A missing
// blob throws a message naming the PLACEHOLDER only — it lands in
// outbox.last_error (sliced to 1000 chars), which the ops page renders.

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

export function renderSealedText(
  text: string,
  sealed: unknown,
  open: (blob: string) => string = (blob) => decryptField(blob),
): string {
  if (!sealed || typeof sealed !== 'object') return text;
  const map = sealed as Record<string, unknown>;
  return text.replace(PLACEHOLDER, (_whole, key: string) => {
    const blob = map[key];
    if (typeof blob !== 'string') {
      throw new Error(`sealed-text: no sealed value for {{${key}}}`);
    }
    return open(blob);
  });
}
```

4. Run `npx vitest run tests/sealed-text.test.ts`. **Expected:** `Tests 5 passed (5)`. Then run `npx tsc --noEmit && npx eslint --max-warnings 0 src/lib/sealed-text.ts tests/sealed-text.test.ts`; both are clean.

5. Commit: `git add src/lib/sealed-text.ts tests/sealed-text.test.ts && git commit -m "feat(outbox-worker): renderSealedText — field-crypto placeholder renderer for email.send payloads (Program-Fix 18)"`.

---

#### Step 2 — Worker: drain-time creds, per-batch memo, legacy shim, refund payload, sealed email (RED → GREEN)

The consumer changes first, so that every later producer commit lands on a worker that already understands `partnerId`, and the branch is shippable at every commit.

1. Edit `tests/outbox-worker.test.ts`.

   a. Line 12: **Replace** `import { EnvKeyProvider } from '@/lib/field-crypto';` **with** `import { EnvKeyProvider, encryptField } from '@/lib/field-crypto';`, then insert this block directly after the imports (after line 15, `import { RAIL_TIMEOUT_MS } …`):

```ts

// Spy on the integrations repo FACTORY: partnerContext() builds one repo per
// resolution, so "how many were built during a drain" is an engine-independent
// measure of the per-batch creds memoization (fix 11).
const integrationsRepoSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...args: Parameters<typeof real.createIntegrationsRepo>) => {
      integrationsRepoSpy.calls++;
      return real.createIntegrationsRepo(...args);
    },
  };
});
```

   b. In `describe('drainOnce — email.send (partner-lead notification)', …)` (`:248-263`), **Replace:**

```ts
    expect(sent[0].to).toEqual(['venkat@smartremit.ai', 'rohan@smartremit.ai']);
    expect(sent[0].subject).toContain('Acme Remit');
  });
});
```

   **With:**

```ts
    expect(sent[0].to).toEqual(['venkat@smartremit.ai', 'rohan@smartremit.ai']);
    expect(sent[0].subject).toContain('Acme Remit');
  });

  it('renders {{placeholders}} from field-crypto SEALED values at send time; the row holds only ciphertext (fix 11 / F66)', async () => {
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const d: WorkerDeps = { ...deps(), sendEmail: async (m) => { sent.push(m); } };
    const link = 'https://smartremit.test/partners/apply/deadbeef';
    await outbox.enqueue(
      'email.send',
      { to: ['lead@acme.com'], subject: 'Complete', text: 'Go:\n\n{{apply_link}}\n\nThanks', sealed: { apply_link: encryptField(link) } },
      { dedupeKey: 'partner_app_invite:preq_x' },
    );
    const r = await drainOnce(d, 'w1');
    expect(r.processed).toBe(1);
    expect(sent[0].text).toBe(`Go:\n\n${link}\n\nThanks`);
    const row = (await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'partner_app_invite:preq_x'`)) as unknown as {
      rows: Array<{ payload: unknown }>;
    };
    expect(JSON.stringify(row.rows[0].payload)).not.toContain('deadbeef');
  });

  it('a placeholder with no sealed blob FAILS the row (retryable) with a last_error naming only the placeholder', async () => {
    const d: WorkerDeps = { ...deps(), sendEmail: async () => {} };
    await outbox.enqueue('email.send', { to: ['lead@acme.com'], subject: 's', text: '{{apply_link}}', sealed: {} });
    const r = await drainOnce(d, 'w1');
    expect(r.failed).toBe(1);
    const row = (await db.execute(sql`SELECT last_error FROM outbox WHERE kind = 'email.send'`)) as unknown as {
      rows: Array<{ last_error: string }>;
    };
    expect(row.rows[0].last_error).toBe('sealed-text: no sealed value for {{apply_link}}');
  });
});
```

   c. **Replace** the head of `describe('drainOnce — plain sends', …)` (`:265-273`, i.e. the describe line plus the `'whatsapp.text and whatsapp.template flow through with creds'` test; KEEP the `'an unknown kind dead-letters instead of looping forever'` test and the closing `});` that follow it):

```ts
describe('drainOnce — plain sends', () => {
  it('whatsapp.text and whatsapp.template flow through with creds', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi', creds: { phoneNumberId: '111', token: 't' } });
    await outbox.enqueue('whatsapp.template', { to: '919876543210', template: 'transfer_delivered', lang: 'en', params: ['a'] });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', { phoneNumberId: '111', token: 't' });
    expect(sendTemplate).toHaveBeenCalledWith('919876543210', 'transfer_delivered', 'en', ['a'], undefined);
  });
```

   **With:**

```ts
describe('drainOnce — plain sends resolve WhatsApp creds at DRAIN time (fix 11 / F49·F54·F58)', () => {
  const ACME_WA = { phoneNumberId: 'pn_acme', token: 'tok_acme' };
  async function byoWhatsApp(partnerId: string, whatsapp: Record<string, string>) {
    await createIntegrationsRepo(db, provider).saveIntegrations(partnerId, {
      kyc: {}, payment: { providerType: 'mock' }, whatsapp,
    });
  }

  it('whatsapp.text resolves the partner creds from payload.partnerId', async () => {
    await byoWhatsApp('acme', ACME_WA);
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi', partnerId: 'acme' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', ACME_WA);
  });

  it('whatsapp.template resolves the partner creds from payload.partnerId', async () => {
    await byoWhatsApp('acme', ACME_WA);
    await outbox.enqueue('whatsapp.template', {
      to: '919876543210', template: 'transfer_delivered', lang: 'en', params: ['a'], partnerId: 'acme',
    });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendTemplate).toHaveBeenCalledWith('919876543210', 'transfer_delivered', 'en', ['a'], ACME_WA);
  });

  it('no partnerId ⇒ the shared env number (creds undefined), exactly as before', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    await outbox.enqueue('whatsapp.template', { to: '919876543210', template: 'transfer_delivered', lang: 'en', params: ['a'] });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', undefined);
    expect(sendTemplate).toHaveBeenCalledWith('919876543210', 'transfer_delivered', 'en', ['a'], undefined);
  });

  it('a partner with no integrations row, a half-configured channel, or no partner row degrades to the shared number — never dead-letters', async () => {
    await seedPartner(db, 'ghostp'); // partner row, no integrations row
    await byoWhatsApp('acme', { phoneNumberId: 'pn_only' }); // no token ⇒ waCredsFrom ⇒ undefined
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'a', partnerId: 'ghostp' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'b', partnerId: 'acme' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'c', partnerId: 'never_seeded' });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 3, failed: 0, dead: 0 });
    expect(sendText).toHaveBeenCalledTimes(3);
    for (const call of sendText.mock.calls) expect((call as unknown[])[2]).toBeUndefined();
  });

  it('a token ROTATED after enqueue is used at drain time with no re-enqueue — and the row never held either token', async () => {
    await byoWhatsApp('acme', { phoneNumberId: 'pn_acme', token: 'tok_v1' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi', partnerId: 'acme' }, { dedupeKey: 'rot:1' });
    await byoWhatsApp('acme', { phoneNumberId: 'pn_acme', token: 'tok_v2' });
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', { phoneNumberId: 'pn_acme', token: 'tok_v2' });
    const row = (await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'rot:1'`)) as unknown as {
      rows: Array<{ payload: unknown }>;
    };
    expect(JSON.stringify(row.rows[0].payload)).not.toMatch(/tok_v1|tok_v2|creds/);
  });

  it('per-batch memoization: five rows for ONE partner cost ONE integrations resolution', async () => {
    await byoWhatsApp('acme', ACME_WA);
    for (let i = 0; i < 5; i++) {
      await outbox.enqueue('whatsapp.text', { to: '15551230000', body: `m${i}`, partnerId: 'acme' });
    }
    integrationsRepoSpy.calls = 0;
    const r = await drainOnce(deps(), 'w1', 10);
    expect(r.processed).toBe(5);
    expect(integrationsRepoSpy.calls).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(5);
    for (const call of sendText.mock.calls) expect((call as unknown[])[2]).toEqual(ACME_WA);
  });

  // Legacy rows are INSERTed raw: they are what the PREVIOUS release wrote, and
  // outbox-repo.enqueue's test-only tripwire (fix 11) refuses a creds payload.
  it('TRANSITION SHIM: a legacy row (previous release) with creds and no partnerId still sends on the persisted number', async () => {
    await db.execute(sql`INSERT INTO outbox (kind, payload) VALUES
      ('whatsapp.text', '{"to":"15551230000","body":"legacy","creds":{"phoneNumberId":"111","token":"t"}}'::jsonb)`);
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'legacy', { phoneNumberId: '111', token: 't' });
  });

  it('partnerId WINS over a persisted creds object — a stale or foreign token can never be pinned by a payload', async () => {
    await byoWhatsApp('acme', { phoneNumberId: 'pn_acme', token: 'tok_live' });
    await db.execute(sql`INSERT INTO outbox (kind, payload) VALUES
      ('whatsapp.text', '{"to":"15551230000","body":"both","partnerId":"acme","creds":{"phoneNumberId":"pn_stale","token":"tok_stale"}}'::jsonb)`);
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'both', { phoneNumberId: 'pn_acme', token: 'tok_live' });
  });
```

   The `'TRANSITION SHIM'` and `'partnerId WINS'` tests simulate pre-fix rows with raw `INSERT`s, not `enqueue`. The Step 7 tripwire makes `enqueue` refuse a `creds` payload under test, and the static gate scans `src/` only.

   d. In the refund test `"completes the refund and queues the customer message with the OWNING partner's creds (never the settlement partner's)"`, **Replace** (`:393-396`):

```ts
    const rows = (await db.execute(
      sql`SELECT kind, dedupe_key FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ kind: string; dedupe_key: string }> };
    expect(rows.rows).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'refundmsg:wk_t1' }]);
```

   **With:**

```ts
    const rows = (await db.execute(
      sql`SELECT kind, dedupe_key, payload FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ kind: string; dedupe_key: string; payload: Record<string, unknown> }> };
    expect(rows.rows.map(({ kind, dedupe_key }) => ({ kind, dedupe_key }))).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'refundmsg:wk_t1' },
    ]);
    // fix 11 / F54: the refund message persists the OWNING partnerId, never creds.
    expect(rows.rows[0].payload.partnerId).toBe('acme');
    expect(JSON.stringify(rows.rows[0].payload)).not.toMatch(/creds|tok_acme|tok_railp/);
```

   The existing assertion at `:407` (`expect(creds).toEqual({ phoneNumberId: 'pn_acme', token: 'tok_acme' })` on the second drain) stays. It now proves drain-time resolution from `partnerId`.

2. Run `npx vitest run tests/outbox-worker.test.ts`. **Expected RED, 8 failures, verified against bf4b083:**
   - `whatsapp.text resolves…`, `whatsapp.template resolves…`, `a token ROTATED…` and `partnerId WINS…` fail with `AssertionError: expected "spy" to be called with arguments: [ '15551230000', 'hi', { …(2) } ]`.
   - `per-batch memoization…` fails with `expected +0 to be 1`.
   - `renders {{placeholders}}…` fails with `expected 'Go:\n\n{{apply_link}}\n\nThanks' to be 'Go:\n\nhttps://smartremit.test/partne…'`.
   - `a placeholder with no sealed blob…` fails with `expected +0 to be 1`.
   - The refund test fails with `expected undefined to be 'acme'`.
   - `no partnerId…`, `…degrades…` and the SHIM test already pass. That is intended: they pin today's behaviour through the change.

3. Implement in `src/lib/outbox-worker.ts`.

   a. **Replace** (`:20-21`):

```ts
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
```

   **With:**

```ts
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { renderSealedText } from '@/lib/sealed-text';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
```

   b. **Replace** `partnerContext` + the head of `handle` through the `whatsapp.template` case (`:179-208`):

```ts
async function partnerContext(deps: WorkerDeps, partnerId: string) {
  const partner = await createPartnerRepo(deps.db).getPartner(partnerId);
  const integrations = await createIntegrationsRepo(deps.db).getIntegrations(partnerId);
  return {
    brand: resolvePartnerBranding(partner).brand,
    waCreds: waCredsFrom(integrations),
    integrations,
  };
}

async function handle(deps: WorkerDeps, row: OutboxRow, signal: RowSignal): Promise<void> {
  const p = row.payload as Payload;
  switch (row.kind) {
    // ── Plain customer-facing sends (the transactional message outbox) ──────
    case 'whatsapp.text': {
      const creds = p.creds as WaCreds | undefined;
      await deps.sendText(str(p.to), str(p.body), creds);
      return;
    }
    case 'whatsapp.template': {
      const creds = p.creds as WaCreds | undefined;
      await deps.sendTemplate(
        str(p.to),
        str(p.template),
        str(p.lang),
        (p.params as string[]) ?? [],
        creds,
      );
      return;
    }
```

   **With:**

```ts
export interface PartnerCtx {
  brand: string;
  waCreds: WaCreds | undefined;
  integrations: PartnerIntegrations;
}

/** The drain-time resolver every handler uses for a partner's brand + WhatsApp creds + rail config. */
export type PartnerResolver = (partnerId: string) => Promise<PartnerCtx>;

async function partnerContext(deps: WorkerDeps, partnerId: string): Promise<PartnerCtx> {
  // Pure reads, repeatable on every attempt. No row / a half-configured channel
  // ⇒ waCreds undefined ⇒ the shared env number — never a throw, so a customer
  // message cannot dead-letter on a tenant-config gap. A transient DB error
  // throws and rides the ordinary backoff (no token is in the error: the token
  // is never in scope until getIntegrations returns).
  const partner = await createPartnerRepo(deps.db).getPartner(partnerId);
  const integrations = await createIntegrationsRepo(deps.db).getIntegrations(partnerId);
  return {
    brand: resolvePartnerBranding(partner).brand,
    waCreds: waCredsFrom(integrations),
    integrations,
  };
}

/**
 * One resolver per drain BATCH (fix 11): whatsapp.text/template now resolve
 * creds per row, so N rows for one partner must cost ONE partner + ONE
 * integrations read, not 2N. A rejected resolution is evicted so the next row
 * re-reads instead of inheriting it. Scope is the batch, never the process — a
 * rotated token is picked up by the next drain with no re-enqueue.
 */
export function memoizedPartnerContext(deps: WorkerDeps): PartnerResolver {
  const cache = new Map<string, Promise<PartnerCtx>>();
  return (partnerId) => {
    const hit = cache.get(partnerId);
    if (hit) return hit;
    const fresh = partnerContext(deps, partnerId);
    cache.set(partnerId, fresh);
    fresh.catch(() => cache.delete(partnerId));
    return fresh;
  };
}

/**
 * Creds for a plain customer-facing send. `payload.partnerId` is the
 * AUTHORITATIVE tenant (a ledger value written by the producer — never inferred
 * from `to`); its creds are resolved NOW, so a DB dump holds no bearer token
 * and a rotated token needs no re-enqueue. No partnerId ⇒ shared env number.
 *
 * TRANSITION SHIM — remove in the first outbox-worker PR after
 * drizzle/0016_scrub_outbox_secrets is applied to prod (Task 8, wave 4): a row
 * the PREVIOUS release enqueued carries `creds` and no `partnerId`; honour it
 * so the deploy→migrate window drains on the right number. 0016 strips every
 * `creds` key (backfilling partnerId from the phone number id), after which
 * this branch is unreachable.
 */
async function resolveSendCreds(p: Payload, partner: PartnerResolver): Promise<WaCreds | undefined> {
  const partnerId = str(p.partnerId);
  if (partnerId) return (await partner(partnerId)).waCreds;
  const legacy = p.creds as Partial<WaCreds> | null | undefined;
  if (legacy && typeof legacy.phoneNumberId === 'string' && typeof legacy.token === 'string') {
    return { phoneNumberId: legacy.phoneNumberId, token: legacy.token };
  }
  return undefined;
}

async function handle(
  deps: WorkerDeps,
  row: OutboxRow,
  signal: RowSignal,
  partner: PartnerResolver,
): Promise<void> {
  const p = row.payload as Payload;
  switch (row.kind) {
    // ── Plain customer-facing sends (the transactional message outbox) ──────
    // Payloads carry the OWNING partnerId, never creds (fix 11 / F49·F54·F58).
    case 'whatsapp.text': {
      await deps.sendText(str(p.to), str(p.body), await resolveSendCreds(p, partner));
      return;
    }
    case 'whatsapp.template': {
      await deps.sendTemplate(
        str(p.to),
        str(p.template),
        str(p.lang),
        (p.params as string[]) ?? [],
        await resolveSendCreds(p, partner),
      );
      return;
    }
```

   c. `mock.settle` (`:213`). **Replace** `      const { brand, waCreds } = await partnerContext(deps, str(p.partnerId) || 'default');` **with** `      const { brand, waCreds } = await partner(str(p.partnerId) || 'default');`.

   d. `rail.callback` (`:317`). **Replace** `      const { integrations } = await partnerContext(deps, partnerId);` **with** `      const { integrations } = await partner(partnerId);`.

   e. `funding.refund`. **Replace** (`:384-387`):

```ts
      // The customer-facing message rides the OWNING partner's number — the
      // brand the sender talks to — NEVER the settlement partner's.
      const { waCreds } = await partnerContext(deps, transfer.partnerId);
      await deps.db.transaction(async (tx) => {
```

   **With:**

```ts
      await deps.db.transaction(async (tx) => {
```

   and **Replace** (`:395-400`):

```ts
        if (!updated) return;
        await createOutboxRepo(tx).enqueue(
          'whatsapp.text',
          { to: transfer.phone, body: buildRefundMessage(transfer), creds: waCreds },
          { dedupeKey: `refundmsg:${transferId}` },
        );
```

   **With:**

```ts
        if (!updated) return;
        // The customer-facing message rides the OWNING partner's number — the
        // brand the sender talks to — NEVER the settlement partner's. Only the
        // id is persisted (fix 11 / F54); creds resolve when THIS row drains.
        await createOutboxRepo(tx).enqueue(
          'whatsapp.text',
          { to: transfer.phone, body: buildRefundMessage(transfer), partnerId: transfer.partnerId },
          { dedupeKey: `refundmsg:${transferId}` },
        );
```

   f. `email.send`. **Replace** (`:463-474`):

```ts
    // ── Transactional email (partner-lead notifications) ────────────────────
    // Durable: the real sender no-ops when SMTP is unconfigured (no retry storm);
    // when configured, a send failure throws and rides the backoff/dead-letter.
    case 'email.send': {
      await (deps.sendEmail ?? sendEmailDefault)({
        to: Array.isArray(p.to) ? (p.to as unknown[]).map(str).filter(Boolean) : [],
        subject: str(p.subject),
        text: str(p.text),
        ...(typeof p.html === 'string' ? { html: p.html } : {}),
      });
      return;
    }
```

   **With:**

```ts
    // ── Transactional email (partner-lead notifications) ────────────────────
    // Durable: the real sender no-ops when SMTP is unconfigured (no retry storm);
    // when configured, a send failure throws and rides the backoff/dead-letter.
    // `sealed` (optional) maps {{placeholders}} in text/html to field-crypto
    // blobs — the partner-application invite link (fix 11 / F66). Opened at SEND
    // time only; the row stays ciphertext. A missing blob throws naming the
    // placeholder, never a value.
    case 'email.send': {
      await (deps.sendEmail ?? sendEmailDefault)({
        to: Array.isArray(p.to) ? (p.to as unknown[]).map(str).filter(Boolean) : [],
        subject: str(p.subject),
        text: renderSealedText(str(p.text), p.sealed),
        ...(typeof p.html === 'string' ? { html: renderSealedText(p.html, p.sealed) } : {}),
      });
      return;
    }
```

   g. `agent.turn`. **Replace** (`:502-506`):

```ts
      // Re-resolve the routing partner's outbound creds at RUN time (the
      // payload never carries tokens; rotation is picked up automatically).
      const waCreds = routedPartnerId
        ? (await partnerContext(deps, routedPartnerId)).waCreds
        : undefined;
```

   **With:**

```ts
      // Re-resolve the routing partner's outbound creds at RUN time (the
      // payload never carries tokens; rotation is picked up automatically).
      const waCreds = routedPartnerId ? (await partner(routedPartnerId)).waCreds : undefined;
```

   The ACTIVE-partner check above it (`:488-501`, `createPartnerRepo(deps.db).getPartner(requested)`) stays un-memoized. It is an identity gate, not a creds lookup.

   h. `drainOnce`. **Replace** (`:566-567`):

```ts
  const rows = await outbox.claimBatch(batchSize, workerId);
  const rowDeadlineMs = opts.rowDeadlineMs ?? ROW_DEADLINE_MS;
```

   **With:**

```ts
  const rows = await outbox.claimBatch(batchSize, workerId);
  const partner = memoizedPartnerContext(deps); // one drain-time creds resolver per BATCH (fix 11)
  const rowDeadlineMs = opts.rowDeadlineMs ?? ROW_DEADLINE_MS;
```

   and **Replace** (`:593`) `      await withRowDeadline(handle(deps, row, signal), rowDeadlineMs, signal);` **with** `      await withRowDeadline(handle(deps, row, signal, partner), rowDeadlineMs, signal);`. Nothing else in `drainOnce` changes: `stopAfter`/`releaseUnstarted`, `hardStopAt`, `newRowSignal`, the owner-CAS `markDone`/`markFailed`, the `TERMINAL_ON_DEADLINE` branch and the `dead:<id>` alert all stay.

   After this step `git grep -n "partnerContext(deps" -- src/lib/outbox-worker.ts` shows exactly one line: the call inside `memoizedPartnerContext`.

4. Run `npx vitest run tests/outbox-worker.test.ts tests/sealed-text.test.ts`. **Expected:** `Tests 50 passed (50)` (45 in the worker suite, 5 sealed-text). This includes all of Task 7 (PF 11)'s lease, deadline and `hardStopAt` tests, unchanged. Then run `npx tsc --noEmit && npx eslint --max-warnings 0 src/lib/outbox-worker.ts tests/outbox-worker.test.ts`; both are clean.

5. Commit: `git commit -am "fix(outbox-worker): resolve WhatsApp creds at drain time from payload.partnerId (batch-memoized, legacy shim) and render sealed email placeholders (Program-Fix 18, F49/F54/F66)"`.

---

#### Step 3 — Settlement entry points drop the creds parameter; all five callers (RED → GREEN)

1. Tests first.

   a. `tests/settlement.test.ts`. **Replace** the fix-6 test at `:224-230`:

```ts
  it('carries the OWNER partner WhatsApp creds on the held message (same payload shape as the paid stage-1)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' }, { phoneNumberId: 'pn_acme', token: 'tok_acme' });
    const r = await db.execute(sql`SELECT payload->'creds'->>'phoneNumberId' AS pn, payload->>'to' AS "to" FROM outbox WHERE dedupe_key = 'stage1:st_t1'`);
    const row = (r as unknown as { rows: Array<{ pn: string; to: string }> }).rows[0];
    expect(row).toEqual({ pn: 'pn_acme', to: '15551230000' });
  });
```

   **With:**

```ts
  it('the held stage-1 payload names the OWNER partnerId and carries NO creds (same shape as the paid stage-1 — fix 11)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const payload = await stage1Payload('st_t1');
    expect(payload.partnerId).toBe('acme');
    expect(payload.to).toBe('15551230000');
    expect(Object.keys(payload).sort()).toEqual(['body', 'partnerId', 'to']);
  });
```

   Then **Replace** the line `async function stage1Body(id: string): Promise<string | null> {` (`:177`) **with**:

```ts
async function stage1Payload(id: string): Promise<Record<string, unknown>> {
  const r = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = ${'stage1:' + id}`);
  return (r as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0].payload;
}

describe('stage-1 payloads never carry a secret (fix 11 / F49)', () => {
  it('beginSettlement: the stage-1 payload is exactly { to, body, partnerId } — the OWNING partner, no creds/token', async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), SIMULATOR);
    const payload = await stage1Payload('st_t1');
    expect(payload.partnerId).toBe('acme');
    expect(payload.to).toBe('15551230000');
    expect(Object.keys(payload).sort()).toEqual(['body', 'partnerId', 'to']);
    expect(JSON.stringify(payload)).not.toMatch(/creds|token/i);
  });

  it('a ROUTED transfer: the stage-1 row names transfer.partnerId (the brand), never settlementPartnerId (the rail)', async () => {
    await seedPartner(db, 'railp');
    await store.saveTransfer({ ...fixture(), settlementPartnerId: 'railp' });
    await beginSettlement(db, { ...fixture(), settlementPartnerId: 'railp' }, SIMULATOR);
    expect((await stage1Payload('st_t1')).partnerId).toBe('acme');
  });

  it('dedupe keys are unchanged by the payload change (stage1:/mocksettle:)', async () => {
    await store.saveTransfer(fixture());
    await beginSettlement(db, fixture(), MOCK);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1', 'mocksettle:st_t1']);
  });

  it('no settlement entry point accepts a creds argument any more (compile-time guard — tsc fails if one is re-added)', () => {
    // Never executed: exists so `tsc --noEmit` (CI + the Stop hook) reports an
    // unused @ts-expect-error the moment a 4th/3rd creds parameter returns.
    const neverRun = async () => {
      // @ts-expect-error beginSettlement takes exactly (db, transfer, integrations)
      await beginSettlement(db, fixture(), MOCK, { phoneNumberId: 'x', token: 'y' });
      // @ts-expect-error beginHold takes exactly (db, transfer)
      await beginHold(db, fixture(), { phoneNumberId: 'x', token: 'y' });
      // @ts-expect-error settleOrHold takes exactly (db, transfer, integrations)
      await settleOrHold(db, fixture(), MOCK, { phoneNumberId: 'x', token: 'y' });
    };
    expect(typeof neverRun).toBe('function');
  });
});

async function stage1Body(id: string): Promise<string | null> {
```

   b. `tests/partner-api-service.test.ts`, inside `describe('partner-api-service: confirmTransaction enforces the compliance hold (F51)', …)`. Insert **before** `it('on a flagged transfer NEVER calls deps.initiatePayment (the hold is decided before the injection seam)', …` (`:501`):

```ts
  it("the held stage-1 row names the OWNING partner and never carries its WhatsApp token (fix 11 / F49)", async () => {
    const h = await harness();
    await h.deps.integrationsStore.saveIntegrations('acme', {
      kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
    const id = await mintFlagged(h, DELEGATED, 'idem-hold-creds');
    await confirmTransaction(h.deps, DELEGATED, 'pk_1', id);
    const r = await h.db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = ${`stage1:${id}`}`);
    const payload = (r as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0].payload;
    expect(payload.partnerId).toBe('acme');
    expect('creds' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('tok_acme');
  });

```

   c. `tests/reconcile.test.ts:193-222`. Rename the test and **Replace** its tail:

```ts
  it("routed victim: rail config resolves via the SETTLEMENT partner; stage-1 creds via the OWNER", async () => {
```

   **→**

```ts
  it("routed victim: rail config resolves via the SETTLEMENT partner; the stage-1 row names the OWNER and holds no creds (fix 11)", async () => {
```

   and

```ts
    // Brand-side: the stage-1 message rides the OWNER's number.
    const stage1 = (await db.execute(sql`
      SELECT payload->'creds'->>'phoneNumberId' AS pn FROM outbox
      WHERE dedupe_key = 'stage1:rc_fund1'
    `)) as unknown as { rows: Array<{ pn: string | null }> };
    expect(stage1.rows[0].pn).toBe('pn_acme');
  });
```

   **→**

```ts
    // Brand-side: the stage-1 message names the OWNER (its creds resolve at
    // drain time) — the row holds neither partner's token nor the rail's number.
    const stage1 = (await db.execute(sql`
      SELECT payload->>'partnerId' AS pid, (payload -> 'creds') IS NOT NULL AS has_creds, payload::text AS raw
      FROM outbox WHERE dedupe_key = 'stage1:rc_fund1'
    `)) as unknown as { rows: Array<{ pid: string | null; has_creds: boolean; raw: string }> };
    expect(stage1.rows[0].pid).toBe('acme');
    expect(stage1.rows[0].has_creds).toBe(false);
    expect(stage1.rows[0].raw).not.toMatch(/tok_acme|tok_railp|pn_railp/);
  });
```

   These are the only two tests today that would catch a cross-tenant brand leak on the money path: this one and d. below. They are rewritten, not deleted.

   d. `tests/pay-route-delayed-poke.test.ts:215-244`. **Replace** `  it("ROUTED transfer: the RAIL is the settlement partner's; stage-1 creds stay the OWNER's", async () => {` **with** `  it("ROUTED transfer: the RAIL is the settlement partner's; the stage-1 row names the OWNER and carries no token (fix 11)", async () => {`, and **Replace**:

```ts
    const rows = (await db.execute(
      sql`SELECT kind, payload FROM outbox ORDER BY id`,
    )) as unknown as { rows: Array<{ kind: string; payload: { creds?: { phoneNumberId?: string } } }> };
    expect(rows.rows.map((r) => r.kind)).toEqual(['whatsapp.text', 'settlement.instruct']);
    // Brand-side: the stage-1 "payment received" goes from the OWNER's number.
    expect(rows.rows[0].payload.creds).toMatchObject({ phoneNumberId: 'pn_owner' });
  });
```

   **With:**

```ts
    const rows = (await db.execute(
      sql`SELECT kind, payload FROM outbox ORDER BY id`,
    )) as unknown as { rows: Array<{ kind: string; payload: { partnerId?: string; creds?: unknown } }> };
    expect(rows.rows.map((r) => r.kind)).toEqual(['whatsapp.text', 'settlement.instruct']);
    // Brand-side: the stage-1 "payment received" names the OWNER — never the
    // rail partner — and the worker resolves the owner's creds at drain time.
    expect(rows.rows[0].payload.partnerId).toBe('default');
    expect(rows.rows[0].payload.creds).toBeUndefined();
    expect(JSON.stringify(rows.rows[0].payload)).not.toMatch(/tok_owner|tok_rail|pn_rail/);
  });
```

2. Run `npx vitest run tests/settlement.test.ts tests/partner-api-service.test.ts tests/reconcile.test.ts tests/pay-route-delayed-poke.test.ts`. **Expected RED, 6 failures:**
   - the three settlement tests fail with `expected undefined to be 'acme'`;
   - the partner-API test fails with `expected undefined to be 'acme'`;
   - reconcile fails with `expected null to be 'acme'`;
   - pay-route fails with `expected undefined to be 'default'`.

   The compile-time guard passes at runtime, but `npx tsc --noEmit` reports `error TS2578: Unused '@ts-expect-error' directive.` ×3 in `tests/settlement.test.ts`. That is the type-level RED.

3. Implement.

   a. `src/lib/settlement.ts`.
      - Delete the import at `:7`: `import type { WaCreds } from '@/lib/whatsapp';`.
      - **Replace** the header line at `:15` (`//   • the customer's stage-1 "payment received" message (outbox, deduped),`) **with**:

```ts
//   • the customer's stage-1 "payment received" message (outbox, deduped;
//     the payload names the OWNING partnerId only — the worker resolves that
//     partner's WhatsApp creds at drain time, so no token is ever at rest here),
```

      - **Replace** the `beginSettlement` signature (`:97-102`):

```ts
export async function beginSettlement(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
  waCreds?: WaCreds,
): Promise<SettlementResult> {
```

      **With:**

```ts
export async function beginSettlement(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<SettlementResult> {
```

      - **Replace** the stage-1 enqueue (`:117-122`):

```ts
    const outbox = createOutboxRepo(tx);
    await outbox.enqueue(
      'whatsapp.text',
      { to: paid.phone, body: buildStage1Message(paid), creds: waCreds },
      { dedupeKey: `stage1:${paid.id}` },
    );
```

      **With:**

```ts
    // Brand vs rail: the customer-facing message rides the OWNING partner's
    // WhatsApp number (paid.partnerId, already in hand — no read added to this
    // transaction); the rail is decided from `integrations` below. Only the id
    // is persisted (fix 11 / F49): the worker resolves the creds at DRAIN time.
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      { to: paid.phone, body: buildStage1Message(paid), partnerId: paid.partnerId },
      { dedupeKey: `stage1:${paid.id}` },
    );
```

      - **Replace** the `beginHold` signature (`:148-152`):

```ts
export async function beginHold(
  db: Db,
  transfer: Transfer,
  waCreds?: WaCreds,
): Promise<HoldResult> {
```

      **With:** `export async function beginHold(db: Db, transfer: Transfer): Promise<HoldResult> {`. Then **Replace** its enqueue (`:156-162`):

```ts
    // `held` is the masked RETURNING row; buildStage1Message never names the
    // destination, so no payout field can reach the outbox payload.
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      { to: held.phone, body: buildStage1Message(held, { held: true }), creds: waCreds },
      { dedupeKey: `stage1:${held.id}` },
    );
```

      **With:**

```ts
    // `held` is the masked RETURNING row; buildStage1Message never names the
    // destination, so no payout field can reach the outbox payload. Same shape
    // as the paid stage-1: the OWNING partnerId, never creds (fix 11 / F49).
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      { to: held.phone, body: buildStage1Message(held, { held: true }), partnerId: held.partnerId },
      { dedupeKey: `stage1:${held.id}` },
    );
```

      - **Replace** the body of `settleOrHold` (`:177-193`):

```ts
export async function settleOrHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
  waCreds?: WaCreds,
): Promise<SettleOrHoldResult> {
  if (transfer.complianceStatus === 'blocked') {
    return { kind: 'refused', complianceStatus: 'blocked' };
  }
  if (transfer.complianceStatus === 'cleared') {
    const settled = await beginSettlement(db, transfer, integrations, waCreds);
    if (settled.kind !== 'refused') return settled;
    if (settled.complianceStatus === 'blocked') return { kind: 'refused', complianceStatus: 'blocked' };
    // Ledger says flagged: hold it.
  }
  return beginHold(db, transfer, waCreds);
}
```

      **With:**

```ts
export async function settleOrHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<SettleOrHoldResult> {
  if (transfer.complianceStatus === 'blocked') {
    return { kind: 'refused', complianceStatus: 'blocked' };
  }
  if (transfer.complianceStatus === 'cleared') {
    const settled = await beginSettlement(db, transfer, integrations);
    if (settled.kind !== 'refused') return settled;
    if (settled.complianceStatus === 'blocked') return { kind: 'refused', complianceStatus: 'blocked' };
    // Ledger says flagged: hold it.
  }
  return beginHold(db, transfer);
}
```

      `releaseHold` and `enqueueRailEffect` are untouched.

   b. `src/app/api/pay/[transferId]/route.ts`. **Replace** (`:110-124`):

```ts
  // WL2/WL3 + best-rate routing: RAIL-side config (settlement URL/secret/
  // providerType) resolves via the ROUTED settlement partner when set; the
  // customer-facing WhatsApp creds ALWAYS resolve via the OWNING partner.
  // Unrouted (settlementPartnerId absent) ⇒ ONE fetch, exactly as before;
  // routed ⇒ the two independent fetches run in parallel.
  const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
  const integrationsStore = getPartnerIntegrationsStore();
  const railIntegrationsPromise = integrationsStore.getIntegrations(railPartnerId);
  const [railIntegrations, brandIntegrations] = await Promise.all([
    railIntegrationsPromise,
    railPartnerId === transfer.partnerId
      ? railIntegrationsPromise
      : integrationsStore.getIntegrations(transfer.partnerId),
  ]);
  const waCreds = waCredsFrom(brandIntegrations);
```

   **With:**

```ts
  // WL3 + best-rate routing: RAIL-side config (settlement URL/secret/
  // providerType) resolves via the ROUTED settlement partner when set. The
  // customer-facing WhatsApp message is BRAND-side: settleOrHold persists the
  // OWNING partnerId on the stage-1 row and the worker resolves that partner's
  // creds at drain time (fix 11) — so no brand-side read happens here.
  const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
  const railIntegrations = await getPartnerIntegrationsStore().getIntegrations(railPartnerId);
```

   and **Replace** (`:167-171`):

```ts
  // The ONE compliance decision: settle (cleared) or hold (flagged) — each an
  // atomic transaction whose effects are dedupe-keyed outbox rows. settleOrHold
  // decides the rail purely from the PASSED integrations — hand it the RAIL
  // partner's config, message with the OWNER's creds.
  const result = await settleOrHold(getDb(), transfer, railIntegrations, waCreds);
```

   **With:**

```ts
  // The ONE compliance decision: settle (cleared) or hold (flagged) — each an
  // atomic transaction whose effects are dedupe-keyed outbox rows. settleOrHold
  // decides the rail purely from the PASSED integrations — hand it the RAIL
  // partner's config; the stage-1 row names the OWNER (transfer.partnerId).
  const result = await settleOrHold(getDb(), transfer, railIntegrations);
```

   Keep the `waCredsFrom` import (`:20`) and `type WaCreds` (`:22`). The OTP branch still uses both at `:292-299`, for a direct in-process send.

   c. `src/app/api/pay/b2b/[invoiceId]/route.ts`. **Replace** (`:239-248`):

```ts
    const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
    const integrationsStore = getPartnerIntegrationsStore();
    const railIntegrations = await integrationsStore.getIntegrations(railPartnerId);
    const brandIntegrations =
      railPartnerId === transfer.partnerId
        ? railIntegrations
        : await integrationsStore.getIntegrations(transfer.partnerId);
    const waCreds = waCredsFrom(brandIntegrations);

    const result = await settleOrHold(getDb(), transfer, railIntegrations, waCreds);
```

   **With:**

```ts
    // Rail config is the SETTLEMENT partner's when routed; the held/stage-1
    // message names the OWNING partner and its creds resolve at drain (fix 11).
    const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
    const railIntegrations = await getPartnerIntegrationsStore().getIntegrations(railPartnerId);

    const result = await settleOrHold(getDb(), transfer, railIntegrations);
```

   Keep the `waCredsFrom` and `WaCreds` imports (`:18-19`). The OTP branch still uses them (`:100-102`).

   d. `src/lib/reconcile.ts`.
      - Delete the import at `:7`: `import { waCredsFrom } from '@/lib/whatsapp-creds';`.
      - **Replace** (`:124-133`):

```ts
    // Rail-side config is the SETTLEMENT partner's when routed (same rule as
    // the re-instruct above); the customer-facing stage-1 message rides the
    // OWNING partner's WhatsApp number (brand-side).
    const railIntegrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    const brandIntegrations = t.settlementPartnerId
      ? await integrationsRepo.getIntegrations(t.partnerId)
      : railIntegrations;
    const result = await settleOrHold(db, t, railIntegrations, waCredsFrom(brandIntegrations));
```

      **With:**

```ts
    // Rail-side config is the SETTLEMENT partner's when routed (same rule as
    // the re-instruct above); the customer-facing stage-1 message rides the
    // OWNING partner's WhatsApp number — settleOrHold persists t.partnerId and
    // the worker resolves the brand creds at drain time (fix 11), never here.
    const railIntegrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    const result = await settleOrHold(db, t, railIntegrations);
```

      - **Replace** the comment at `:229`, `  // band. Ids/kinds only: payloads may still carry creds (fix 11).`, **with** `  // band. Ids/kinds only — never print a payload.`.

   e. `src/lib/partner-api-service.ts`.
      - Delete the import at `:15`: `import { waCredsFrom } from './whatsapp-creds';`. After the two edits below it has no other use (`git grep -n waCredsFrom -- src/lib/partner-api-service.ts` then prints nothing).
      - **Replace** (`:405-410`):

```ts
    // FLAGGED: hold, never settle. beginHold is ONE transaction (in_review
    // flip + held stage-1 outbox row, dedupe stage1:<id>); NO rail effect.
    // Partner-scoped: ownership was checked above; creds are the OWNER's.
    const integrations = await deps.integrationsStore.getIntegrations(partner.id);
    const hold = await beginHold(deps.db as Db, t, waCredsFrom(integrations));
```

      **With:**

```ts
    // FLAGGED: hold, never settle. beginHold is ONE transaction (in_review
    // flip + held stage-1 outbox row, dedupe stage1:<id>); NO rail effect.
    // Partner-scoped: ownership was checked above; the held row names the
    // OWNER (t.partnerId) and the worker resolves its creds at drain (fix 11).
    const hold = await beginHold(deps.db as Db, t);
```

      - **Replace** (`:423-429`):

```ts
    // Stage 2c: the atomic settlement transaction — paid flip + stage-1 message
    // + rail effect (signed instruct / delayed mock settle) commit together,
    // with the partner's WhatsApp creds on the customer message. settleOrHold
    // re-checks the LEDGER: if the row was re-screened to flagged since the
    // read above, it is held instead of instructed.
    const integrations = await deps.integrationsStore.getIntegrations(partner.id);
    const result = await settleOrHold(deps.db as Db, tr, integrations, waCredsFrom(integrations));
```

      **With:**

```ts
    // Stage 2c: the atomic settlement transaction — paid flip + stage-1 message
    // + rail effect (signed instruct / delayed mock settle) commit together;
    // the customer message names the OWNING partner (creds resolve at drain —
    // fix 11). settleOrHold re-checks the LEDGER: if the row was re-screened
    // to flagged since the read above, it is held instead of instructed.
    const integrations = await deps.integrationsStore.getIntegrations(partner.id);
    const result = await settleOrHold(deps.db as Db, tr, integrations);
```

4. Run the checks below.

   ```bash
   npx vitest run tests/settlement.test.ts tests/partner-api-service.test.ts tests/reconcile.test.ts \
     tests/pay-route-delayed-poke.test.ts tests/pay-route-funding.test.ts tests/pay-route-ach-pull.test.ts \
     tests/pay-route-in-review.test.ts tests/pay-route-otp.test.ts tests/pay-route-bank-details.test.ts tests/dashboard-ops.test.ts \
     tests/pay-route-masked-draft.test.ts tests/pay-route-fx.test.ts tests/pay-b2b-route-fx.test.ts
   npx tsc --noEmit
   npx eslint --max-warnings 0 src/lib/settlement.ts src/lib/reconcile.ts src/lib/partner-api-service.ts \
     "src/app/api/pay/[transferId]/route.ts" "src/app/api/pay/b2b/[invoiceId]/route.ts" \
     tests/settlement.test.ts tests/partner-api-service.test.ts tests/reconcile.test.ts tests/pay-route-delayed-poke.test.ts
   git grep -n "settleOrHold(\|beginHold(\|beginSettlement(" -- src
   ```

   The last three suites are added by Task 6 (PF 10: `pay-route-masked-draft`) and Task 9 (PF 13: `pay-route-fx`, `pay-b2b-route-fx`), so they exist once those merge. They drive the pay routes whose settlement call changes here.

   Expected:
   - all suites green;
   - `tsc` clean (the three `@ts-expect-error` directives are now used);
   - `eslint` clean (no unused imports);
   - the grep shows the five callers, each with the new arity: `settleOrHold(getDb(), transfer, railIntegrations)` ×2, `settleOrHold(db, t, railIntegrations)`, `beginHold(deps.db as Db, t)` and `settleOrHold(deps.db as Db, tr, integrations)`.

5. Commit: `git commit -am "fix(money-paths): settlement entry points persist the owner partnerId, never WhatsApp creds — five callers updated (Program-Fix 18, F49)"`.

---

#### Step 4 — Ticket nudges persist `ticket.partnerId` (F58, ticket half) (RED → GREEN)

1. In `tests/ticket-actions.test.ts`, add `import { createIntegrationsRepo } from '@/db/repos/integrations-repo';` directly below `import { createTicketRepo } from '@/db/repos/ticket-repo';` (`:49`). Then append at EOF:

```ts

describe('nudge payloads never carry a secret (fix 11 / F58)', () => {
  // A BYO-WhatsApp tenant: the previous code copied this token into every nudge row.
  async function byoWhatsApp(partnerId: string) {
    await createIntegrationsRepo(db).saveIntegrations(partnerId, {
      kyc: {}, payment: {}, whatsapp: { phoneNumberId: `pn_${partnerId}`, token: `tok_${partnerId}` },
    });
  }

  it('replyAction: the nudge payload names ticket.partnerId and carries no creds/token', async () => {
    await byoWhatsApp('p1');
    const t = await makeTicket('p1', { customerPhone: '15559998888' });
    currentStaff = staff({ partnerId: 'p1' });
    await replyAction(form({ ticketId: t.id, body: 'We are checking.' }));
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.partnerId).toBe('p1');
    expect(payload.to).toBe('15559998888');
    expect('creds' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('tok_p1');
  });

  it('resolveAction: the ticketresolved nudge names ticket.partnerId and carries no creds/token', async () => {
    await byoWhatsApp('p1');
    const t = await makeTicket('p1');
    currentStaff = staff({ partnerId: 'p1' });
    await resolveAction(form({ ticketId: t.id }));
    const nudge = (await outboxRows()).find((r) => r.dedupeKey === `ticketresolved:${t.id}`)!;
    const payload = nudge.payload as Record<string, unknown>;
    expect(payload.partnerId).toBe('p1');
    expect('creds' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('tok_p1');
  });

  it("platform support replying to p2's ticket persists p2 (the ticket's OWNER), never the actor's tenant", async () => {
    await byoWhatsApp('p2');
    const t = await makeTicket('p2');
    currentStaff = staff({}); // unscoped platform support
    await replyAction(form({ ticketId: t.id, body: 'Hello from platform support.' }));
    const payload = (await outboxRows())[0].payload as Record<string, unknown>;
    expect(payload.partnerId).toBe('p2');
    expect(JSON.stringify(payload)).not.toContain('tok_p2');
  });
});
```

2. Run `npx vitest run tests/ticket-actions.test.ts`. **Expected RED, 3 failures:** `expected undefined to be 'p1'` ×2 and `expected undefined to be 'p2'`.

3. Implement in `src/app/admin-dashboard/tickets/actions.ts`.
   - Delete the imports at `:10` (`import { createIntegrationsRepo } from '@/db/repos/integrations-repo';`) and `:12` (`import { waCredsFrom } from '@/lib/whatsapp-creds';`). They have no other use in the file (`:99`, `:214` only).
   - **Replace** (`:95-99`):

```ts
  const db = getDb();
  // The nudge rides the OWNING partner's WhatsApp number (brand-side), exactly
  // like reconcile's customer-facing sends. Resolved OUTSIDE the transaction —
  // it's a read; the payload carries the creds like every whatsapp.text row.
  const waCreds = waCredsFrom(await createIntegrationsRepo(db).getIntegrations(ticket.partnerId));
  await db.transaction(async (tx) => {
```

   **With:**

```ts
  const db = getDb();
  // The nudge rides the OWNING partner's WhatsApp number (brand-side), exactly
  // like reconcile's customer-facing sends. Only ticket.partnerId is persisted
  // (fix 11 / F58) — a repo value from getScopedTicket, never a form field; the
  // worker resolves that partner's creds at drain time.
  await db.transaction(async (tx) => {
```

   - In the `ticketmsg:` payload (`:116`), **Replace** `          creds: waCreds,` **with** `          partnerId: ticket.partnerId,`. The edit is unique once it is scoped to the reply body line above it: `You have a new reply from support`.
   - **Replace** (`:213-214`):

```ts
  const db = getDb();
  const waCreds = waCredsFrom(await createIntegrationsRepo(db).getIntegrations(ticket.partnerId));
```

   **With:**

```ts
  const db = getDb();
  // Owner tenant only (fix 11 / F58); creds resolve at drain.
```

   - In the `ticketresolved:` payload (`:224`), **Replace** `          creds: waCreds,` **with** `          partnerId: ticket.partnerId,`, scoped to `Your support request has been resolved`.

4. Run `npx vitest run tests/ticket-actions.test.ts && npx eslint --max-warnings 0 src/app/admin-dashboard/tickets/actions.ts tests/ticket-actions.test.ts && npx tsc --noEmit`. **Expected:** green (the whole file, including the scope-pinning and audit suites), no lint.

5. Commit: `git commit -am "fix(admin-dashboard): ticket nudges persist ticket.partnerId, never WhatsApp creds (Program-Fix 18, F58)"`.

---

#### Step 5 — `tools.ts`: seller links and bill push persist the routed tenant (F58, agent half) (RED → GREEN)

Ruling 20: Task 6 (PF 10) owns `tools.ts` in wave 2 and merges first, and Task 5 (PF 9, its Step 3A) edits `cancel_bill`. Both regions are disjoint from `:1753-1761` and `:1789-1808`. Note that `enqueueSellerLink` keeps its signature, so its three callers (`:1493`, `:1569`, `:1772`) are untouched.

1. `tests/tools.test.ts`.
   - In `describe('register_seller — …')`, insert **before** `  it('is blocked at dispatch on the web channel (WhatsApp-only)', async () => {` (`:3060`, the one WITHOUT "— creates NOTHING"):

```ts
  it('a turn on a partner BYO number: the onboarding-link row names that partner and never carries ctx.waCreds (fix 11 / F58)', async () => {
    await seedPartner(db, 'acme');
    const ctx = await buildCtx(fakeRedis(), PHONE, 'acme');
    const r = await executeTool(
      'register_seller',
      { business_name: 'Acme Exports Inc' },
      { ...ctx, waCreds: { phoneNumberId: 'pn_acme', token: 'tok_ctx' } },
    );
    expect(r.registered).toBe(true);
    const rows = (await db.execute(
      sql`SELECT payload FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ payload: Record<string, unknown> }> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload.partnerId).toBe('acme');
    expect('creds' in rows.rows[0].payload).toBe(false);
    expect(JSON.stringify(rows.rows[0].payload)).not.toContain('tok_ctx');
  });

  it('a shared-number turn (no ctx.waCreds): the row carries neither partnerId nor creds ⇒ the worker uses the shared number, as before', async () => {
    const ctx = await buildCtx(fakeRedis());
    await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    const rows = (await db.execute(
      sql`SELECT payload FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ payload: Record<string, unknown> }> };
    expect(Object.keys(rows.rows[0].payload).sort()).toEqual(['body', 'to']);
  });

```

   - In `describe('create_invoice — …')`, insert **before** `  it('is replay-safe: a duplicate call returns the SAME bill (one invoice, one buyer push)', async () => {` (`:3144`):

```ts
  it('billpush: and sellerbill: rows name the routed partner and never carry ctx.waCreds (fix 11 / F58)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedActiveSeller(ctx);
    // 'default' reached on its OWN BYO number: the routed tenant and ctx.partnerId coincide.
    const r = await executeTool(
      'create_invoice',
      { buyer_phone: '+1 555 987 6543', amount: 250, description: 'design work' },
      { ...ctx, waCreds: { phoneNumberId: 'pn_default', token: 'tok_ctx' } },
    );
    expect(r.created).toBe(true);
    const rows = (await db.execute(
      sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ payload: Record<string, unknown>; dedupe_key: string }> };
    expect(rows.rows.map((x) => x.dedupe_key).sort()).toEqual(
      [`billpush:${r.invoice_id}`, `sellerbill:${r.invoice_id}`].sort(),
    );
    for (const row of rows.rows) {
      expect(row.payload.partnerId).toBe('default');
      expect('creds' in row.payload).toBe(false);
      expect(JSON.stringify(row.payload)).not.toContain('tok_ctx');
    }
  });

```

2. Run `npx vitest run tests/tools.test.ts -t "fix 11|shared-number turn"`. **Expected RED:** 2 failures, `expected undefined to be 'acme'` and `expected undefined to be 'default'`. The shared-number test passes already. It pins the unchanged behaviour.

3. Implement in `src/lib/tools.ts`.
   - **Replace** the line `        ...(ctx.waCreds ? { creds: ctx.waCreds } : {}),` (`:1758`, inside the `billpush:` payload) **with** `        partnerId: routedSenderPartnerId(ctx),`.
   - **Replace** the comment block + head of `enqueueSellerLink` (`:1789-1804`):

```ts
// Seller-facing links (onboarding / pay) are delivered by the SYSTEM via the
// durable outbox — NOT typed by the bot, which is globally barred from writing URLs
// (the consumer pay link is system-delivered the same way). Best-effort + deduped:
// a failed enqueue never fails the action, and a replay can't double-send.
async function enqueueSellerLink(
  ctx: ToolContext,
  to: string,
  body: string,
  dedupeKey: string,
): Promise<void> {
  try {
    await (ctx.outboxRepo ?? createOutboxRepo(getDb())).enqueue(
      'whatsapp.text',
      { to, body, ...(ctx.waCreds ? { creds: ctx.waCreds } : {}) },
      { dedupeKey },
    );
```

   **With:**

```ts
/**
 * The tenant whose WhatsApp NUMBER this turn runs on, persisted on a system push
 * so the worker re-resolves that tenant's creds at drain time (fix 11 / F58 —
 * the payload never carries ctx.waCreds). A turn holds waCreds ONLY when it
 * arrived on a partner's BYO number, and then ctx.partnerId IS that routed
 * partner (src/app/api/worker/route.ts: both come from the agent.turn row's
 * routedPartnerId). A shared-number turn has neither ⇒ undefined ⇒ the key is
 * dropped by JSON serialization ⇒ the worker sends on the shared env number,
 * exactly as before.
 */
function routedSenderPartnerId(ctx: ToolContext): PartnerId | undefined {
  return ctx.waCreds ? ctx.partnerId : undefined;
}

// Seller-facing links (onboarding / pay) are delivered by the SYSTEM via the
// durable outbox — NOT typed by the bot, which is globally barred from writing URLs
// (the consumer pay link is system-delivered the same way). Best-effort + deduped:
// a failed enqueue never fails the action, and a replay can't double-send.
async function enqueueSellerLink(
  ctx: ToolContext,
  to: string,
  body: string,
  dedupeKey: string,
): Promise<void> {
  try {
    await (ctx.outboxRepo ?? createOutboxRepo(getDb())).enqueue(
      'whatsapp.text',
      { to, body, partnerId: routedSenderPartnerId(ctx) },
      { dedupeKey },
    );
```

   `PartnerId` is already imported (`:12`).

   **Why not `seller.partnerId`, as the pre-Wave-1 draft had it.** That would move a shared-number conversation onto the partner's BYO number, which is a behaviour change. The helper is the exact translation of the old conditional spread.

4. Run `npx vitest run tests/tools.test.ts && npx tsc --noEmit && npx eslint --max-warnings 0 src/lib/tools.ts tests/tools.test.ts`. **Expected:** the whole file green, including the existing `selleronboard:` / `billpush:` / `sellerbill:` assertions at `:2993-3002` and `:3128-3141`. `tests/bot-content-guard.test.ts` is unaffected: no chat `content:` string changed.

5. Commit: `git commit -am "fix(whatsapp-agent): seller links and bill push persist the routed tenant, never ctx.waCreds (Program-Fix 18, F58)"`.

---

#### Step 6 — Partner invite: seal the apply link, never persist the raw token (F66) (RED → GREEN)

1. `tests/partners-action.test.ts`.
   - Add after `import type { Db } from '@/db/client';` (`:5`):

```ts
import { createStore } from '@/lib/store';
import { decryptField } from '@/lib/field-crypto';
import { hashApplicationToken } from '@/lib/partner-application-token';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
```

   - **Replace** `emailOutboxRows` (`:84-95`):

```ts
async function emailOutboxRows(): Promise<
  { dedupeKey: string; payload: { to: string[]; subject: string; text: string } }[]
> {
  const res = await db.execute(
    sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`,
  );
  return (
    res as unknown as {
      rows: { dedupe_key: string; payload: { to: string[]; subject: string; text: string } }[];
    }
  ).rows.map((r) => ({ dedupeKey: r.dedupe_key, payload: r.payload }));
}
```

   **With:**

```ts
type EmailPayload = { to: string[]; subject: string; text: string; sealed?: Record<string, string> };

async function emailOutboxRows(): Promise<{ dedupeKey: string; payload: EmailPayload }[]> {
  const res = await db.execute(
    sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`,
  );
  return (
    res as unknown as {
      rows: { dedupe_key: string; payload: EmailPayload }[];
    }
  ).rows.map((r) => ({ dedupeKey: r.dedupe_key, payload: r.payload }));
}
```

   - In the first test (`:141-146`), **Replace**:

```ts
    expect(invite!.payload.to).toEqual(['partners@acme.com']);
    expect(invite!.payload.text).toContain('/partners/apply/');
```

   **With:**

```ts
    expect(invite!.payload.to).toEqual(['partners@acme.com']);
    // The link is a placeholder rendered from a field-crypto blob at send time (fix 11 / F66).
    expect(invite!.payload.text).toContain('{{apply_link}}');
    expect(invite!.payload.text).not.toContain('/partners/apply/');
```

   - Append at EOF:

```ts

describe('the partner-invite email never persists the raw capability token (fix 11 / F66)', () => {
  function workerDeps(sent: { to: string[]; subject: string; text: string }[]): WorkerDeps {
    return {
      db,
      store: createStore(redis, db),
      sendText: async () => {},
      sendTemplate: async () => {},
      fetchFn: (() => { throw new Error('no network in this test'); }) as unknown as typeof fetch,
      recipientTemplateName: 'transfer_delivered',
      recipientTemplateLang: 'en',
      listStaff: async () => [],
      runAgentTurn: async () => '',
      sendEmail: async (m) => { sent.push(m); },
    };
  }

  async function submitAndGetInvite() {
    await expect(submitPartnerRequestAction(form(VALID))).rejects.toThrow('REDIRECT:/?partner=ok#partner-with-us');
    const [lead] = await partnerRequestRows();
    const invite = (await emailOutboxRows()).find((e) => e.dedupeKey === `partner_app_invite:${lead.id}`)!;
    return { lead, invite };
  }

  it('the email.send payload holds a field-crypto blob, never the raw token or the apply link', async () => {
    const { invite } = await submitAndGetInvite();
    const raw = JSON.stringify(invite.payload);
    expect(raw).not.toMatch(/\/partners\/apply\//);
    expect(raw).not.toMatch(/[0-9a-f]{64}/);
    expect(invite.payload.sealed?.apply_link).toMatch(/^v1\./);
  });

  it('the sealed link decrypts to /partners/apply/<token> whose HASH is on the lead row, and the worker delivers it rendered', async () => {
    const { lead, invite } = await submitAndGetInvite();
    const link = decryptField(invite.payload.sealed!.apply_link);
    expect(link).toMatch(/^https:\/\/smartremit\.test\/partners\/apply\/[0-9a-f]{64}$/);
    // The apply page resolves getByTokenHash(hashApplicationToken(token)).
    expect(hashApplicationToken(link.split('/partners/apply/')[1])).toBe(lead.applicationTokenHash);

    const sent: { to: string[]; subject: string; text: string }[] = [];
    const r = await drainOnce(workerDeps(sent), 'w1');
    expect(r.processed).toBe(2); // team notification + invite
    const delivered = sent.find((m) => m.to[0] === 'partners@acme.com')!;
    expect(delivered.text).toContain(link);
    expect(delivered.text).not.toContain('{{apply_link}}');
  });

  it('a redelivered invite does NOT re-mint: the same link twice, application_token_hash unchanged', async () => {
    const { lead: before } = await submitAndGetInvite();
    const sent: { to: string[]; subject: string; text: string }[] = [];
    await drainOnce(workerDeps(sent), 'w1');
    // "Delivered but not acked": the machinery re-runs the row.
    await db.execute(sql`UPDATE outbox SET status = 'pending', next_attempt_at = now() WHERE dedupe_key = ${`partner_app_invite:${before.id}`}`);
    await drainOnce(workerDeps(sent), 'w1');
    const invites = sent.filter((m) => m.to[0] === 'partners@acme.com');
    expect(invites).toHaveLength(2);
    expect(invites[1].text).toBe(invites[0].text);
    const [after] = await partnerRequestRows();
    expect(after.applicationTokenHash).toBe(before.applicationTokenHash);
  });
});
```

   The `@/db/client`, `@/lib/redis`, `next/*` and `@/lib/outbox` mocks at `:31-40` already cover `drainOnce`. `tests/setup.ts:15-16` pins `FIELD_ENCRYPTION_KEY`.

2. Run `npx vitest run tests/partners-action.test.ts`. **Expected RED, 3 failures:**
   - the first test fails with `expected 'Hi,\n\nThanks for your interest in pa…' to contain '{{apply_link}}'`;
   - the payload test fails with `expected '{"to":["partners@acme.com"],"text":"H…' not to match /\/partners\/apply\//`;
   - the decrypt test fails with `TypeError: Cannot read properties of undefined (reading 'apply_link')`.

   The redelivery test already passes. It guards against a future "mint at send time" rewrite.

3. Implement in `src/app/partners-action.ts`.
   - Add `import { encryptField } from '@/lib/field-crypto';` directly below `import { env } from '@/lib/env';` (`:8`).
   - **Replace** (`:89-93`):

```ts
    // Mint a 30-day, single-use capability token for the detailed application
    // form and persist only its HASH on the lead row. The raw token lives ONLY in
    // the partner-facing email link below.
    const { token, hash, expiresAt } = issueApplicationToken();
    await requests.setApplicationToken(id, hash, expiresAt);
```

   **With:**

```ts
    // Mint a 30-day, single-use capability token for the detailed application
    // form and persist only its HASH on the lead row. The raw token's one durable
    // copy — the emailed link — is SEALED with field-crypto (fix 11 / F66): the
    // outbox row holds ciphertext and the worker opens it at send time
    // (src/lib/sealed-text.ts). Minted ONCE here, never per send attempt: a
    // re-mint on redelivery would overwrite the hash and kill a delivered link.
    // encryptField is CPU-only — the transaction gains no I/O.
    const { token, hash, expiresAt } = issueApplicationToken();
    await requests.setApplicationToken(id, hash, expiresAt);
    const sealedApplyLink = encryptField(`${env.appBaseUrl}/partners/apply/${token}`);
```

   - **Replace** the invite enqueue (`:113-128`):

```ts
    // Partner invite — the unique link to the detailed application form. Goes to
    // the email the partner submitted (NOT the internal lead list).
    await outbox.enqueue(
      'email.send',
      {
        to: [email],
        subject: 'Complete your SmartRemit partner application',
        text:
          `Hi,\n\n` +
          `Thanks for your interest in partnering with SmartRemit. Please complete your detailed application here:\n\n` +
          `${env.appBaseUrl}/partners/apply/${token}\n\n` +
          `This secure link is unique to you and expires in 30 days.\n\n` +
          `— The SmartRemit team`,
      },
      { dedupeKey: `partner_app_invite:${id}` },
    );
```

   **With:**

```ts
    // Partner invite — the unique link to the detailed application form. Goes to
    // the email the partner submitted (NOT the internal lead list). The link is
    // the {{apply_link}} placeholder, rendered from `sealed` at send time.
    await outbox.enqueue(
      'email.send',
      {
        to: [email],
        subject: 'Complete your SmartRemit partner application',
        text:
          `Hi,\n\n` +
          `Thanks for your interest in partnering with SmartRemit. Please complete your detailed application here:\n\n` +
          `{{apply_link}}\n\n` +
          `This secure link is unique to you and expires in 30 days.\n\n` +
          `— The SmartRemit team`,
        sealed: { apply_link: sealedApplyLink },
      },
      { dedupeKey: `partner_app_invite:${id}` },
    );
```

   The team notification (`:96-111`) is unchanged. It carries no token.

4. Run `npx vitest run tests/partners-action.test.ts tests/outbox-worker.test.ts && npx tsc --noEmit && npx eslint --max-warnings 0 src/app/partners-action.ts tests/partners-action.test.ts`. **Expected:** `partners-action` 11 passed, `outbox-worker` 45 passed, and both tsc and eslint clean.

5. Commit: `git commit -am "fix(landing-docs): seal the partner-application invite link with field-crypto; the raw token never reaches outbox.payload (Program-Fix 18, F66)"`.

---

#### Step 7 — The build gate: type-aware static scan of every enqueue payload + a test-only tripwire in `enqueue` (RED → GREEN)

The gate is written after Steps 2-6 so every commit stays green: the Stop hook runs `vitest --changed`. Its RED proof runs against the pre-fix sources in 7.3.

**Why type-aware.** A name-only scan cannot prove a payload is clean. `{ cfg: integrations.whatsapp }` has no secret-named key or value. A token laundered through an innocently named local (`const note = waCreds.token; { note }`) or a destructuring (`const { token: memo } = waCreds; { memo }`) passes a name check too. The gate therefore builds a real `ts.Program` from `tsconfig.json` and asks the checker for each payload's **type**. It also follows each payload identifier to its local declaration. The runtime tripwire covers what static analysis cannot see.

**API grounding** (the `typescript` devDependency, 5.9.3 installed; `node_modules/typescript/lib/typescript.d.ts`):
- `readConfigFile` `:9228`, `parseJsonConfigFileContent` `:9257`, `createCompilerHost` `:9519`, `createProgram` `:9604`, `Program.getTypeChecker` `:6049`;
- checker: `getTypeAtLocation` `:6256`, `getSymbolAtLocation` `:6237`, `getShorthandAssignmentValueSymbol` `:6243`, `getPropertiesOfType` `:6180`, `getTypeOfSymbol` `:6178`, `getTypeArguments` `:6215`, `isArrayType` `:6352`, `isTupleType` `:6357`;
- `Type.isUnionOrIntersection` `:6672`;
- `isSatisfiesExpression` `:9045`, `isShorthandPropertyAssignment` `:9122`, `forEachChild` `:9191`, `createSourceFile` `:9192`.

In the scratch run, building the program and scanning every `src/` enqueue site took about 1 s. The tests still carry a 120 s timeout because CI machines are slower.

1. Create `tests/outbox-payload-secrets.test.ts` with the static half. 7.4 adds the tripwire test, and Step 8 adds the migration test and their imports.

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// fix 11 (Program-Fix 18; audit F49/F54/F58/F66): NO outbox payload may carry a secret.
//
// (1) STATIC — the build gate. Every `.enqueue(` call under src/ is checked with
//     the TypeScript CHECKER (a real ts.Program over tsconfig.json):
//       • TYPE: the payload expression's type may not contain a secret-bearing
//         type — WaCreds (src/lib/whatsapp.ts) or any interface of
//         src/lib/partner-integrations.ts — however innocently the key is named
//         (`{ cfg: integrations.whatsapp }`);
//       • NAME: no secret-named key or value (creds, token, secret, …), incl.
//         inside template literals;
//       • DATAFLOW: a payload identifier is followed to its local declaration
//         (initializer / destructuring), so `const note = waCreds.token` or
//         `const { token: memo } = waCreds` cannot launder a token; reading a
//         field of a secret-bearing object is itself a finding;
//       • a payload that is not an inline literal is a finding (it could not be
//         checked). encryptField(...) is the ONE sanctioned sealer: its output is
//         ciphertext and is not scanned. Only CONDITIONS are skipped
//         (`x ? {…} : {}` persists a branch, never x).
//     Limit (documented, covered by (2)): a value that crosses a function
//     boundary as a plain `string` parameter is not traced.
// (2) TRIPWIRE — outbox-repo.enqueue throws under VITEST when a payload carries
//     a secret-bearing shape; every producer exercised anywhere in the suite
//     trips it at runtime.
// (3) MIGRATION — drizzle/0016_scrub_outbox_secrets scrubs legacy rows safely
//     and is idempotent (freshDb already applied it once, to an empty outbox).

const ROOT = join(__dirname, '..');
const SECRET_NAME = /(cred|token|secret|passw|pepper|authori[sz]ation|bearer|api_?key|private_?key)/i;
const SECRET_TYPE_DECLS: Record<string, 'all' | ReadonlySet<string>> = {
  [join('src', 'lib', 'partner-integrations.ts')]: 'all',
  [join('src', 'lib', 'whatsapp.ts')]: new Set(['WaCreds']),
};
const SEALERS: ReadonlySet<string> = new Set(['encryptField']);
const PROBE = join(ROOT, 'src', '__outbox_probe__.ts');

type Report = (at: ts.Node, why: string) => void;
interface Scan { checker: ts.TypeChecker; report: Report; seen: Set<ts.Node>; depth: number }

function isSecretSymbol(sym: ts.Symbol | undefined): boolean {
  for (const d of sym?.declarations ?? []) {
    const rule = SECRET_TYPE_DECLS[relative(ROOT, d.getSourceFile().fileName)];
    if (rule === 'all' || (rule && rule.has(sym!.getName()))) return true;
  }
  return false;
}

/** Deep: does this type CONTAIN a secret-bearing type anywhere (≤ 4 property levels)? */
function secretIn(checker: ts.TypeChecker, type: ts.Type, depth = 0, seen = new Set<ts.Type>()): string | null {
  if (depth > 4 || seen.has(type)) return null;
  seen.add(type);
  const sym = type.aliasSymbol ?? type.getSymbol();
  if (isSecretSymbol(sym)) return sym!.getName();
  if (type.isUnionOrIntersection()) {
    for (const t of type.types) { const hit = secretIn(checker, t, depth, seen); if (hit) return hit; }
    return null;
  }
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length > 0) return null;
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const t of checker.getTypeArguments(type as ts.TypeReference)) {
      const hit = secretIn(checker, t, depth + 1, seen); if (hit) return hit;
    }
    return null;
  }
  for (const prop of checker.getPropertiesOfType(type)) {
    const hit = secretIn(checker, checker.getTypeOfSymbol(prop), depth + 1, seen);
    if (hit) return `${hit} (via .${prop.getName()})`;
  }
  return null;
}

/** Shallow: IS this value a secret-bearing object (so reading one of its fields leaks it)? */
function secretAtTop(type: ts.Type): string | null {
  for (const t of type.isUnion() ? type.types : [type]) {
    const sym = t.aliasSymbol ?? t.getSymbol();
    if (isSecretSymbol(sym)) return sym!.getName();
  }
  return null;
}

function unwrap(n: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)
  ) n = n.expression;
  return n;
}

/** Follow a local binding to what it was initialised from (same-file dataflow, ≤ 3 hops). */
function followDeclaration(sym: ts.Symbol | undefined, s: Scan): void {
  const decl = sym?.valueDeclaration;
  if (!decl || s.seen.has(decl) || s.depth >= 3) return;
  s.seen.add(decl);
  const next: Scan = { ...s, depth: s.depth + 1 };
  if (ts.isVariableDeclaration(decl) && decl.initializer) { scanValue(decl.initializer, next); return; }
  if (ts.isBindingElement(decl)) {
    const from = decl.propertyName ?? decl.name;
    if (ts.isIdentifier(from) && SECRET_NAME.test(from.text)) s.report(decl, `destructured from "${from.text}"`);
    let root: ts.Node = decl.parent;
    while (root && !ts.isVariableDeclaration(root) && !ts.isParameter(root)) root = root.parent;
    if (root && ts.isVariableDeclaration(root) && root.initializer) {
      const top = secretAtTop(s.checker.getTypeAtLocation(root.initializer));
      if (top) s.report(decl, `destructured from a ${top}`);
      scanValue(root.initializer, next);
    }
  }
  // Parameters and catch bindings have no initializer to follow (see the Limit above).
}

function scanObject(node: ts.Expression, s: Scan): void {
  node = unwrap(node);
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) { scanObject(prop.expression, s); continue; }
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (SECRET_NAME.test(prop.name.text)) s.report(prop, `key "${prop.name.text}"`);
        followDeclaration(s.checker.getShorthandAssignmentValueSymbol(prop), s);
        continue;
      }
      if (ts.isPropertyAssignment(prop)) {
        const n = prop.name;
        const key = ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null;
        if (key === null) s.report(prop, 'computed key');
        else if (SECRET_NAME.test(key)) s.report(prop, `key "${key}"`);
        scanValue(prop.initializer, s);
        continue;
      }
      s.report(prop, 'method/accessor in a payload');
    }
    return;
  }
  if (ts.isConditionalExpression(node)) { scanObject(node.whenTrue, s); scanObject(node.whenFalse, s); return; }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) scanObject(node.left, s);
    scanObject(node.right, s);
    return;
  }
  s.report(node, `non-literal payload \`${node.getText().slice(0, 60)}\` (inline the object so it can be checked)`);
}

function scanValue(node: ts.Expression, s: Scan): void {
  node = unwrap(node);
  if (ts.isObjectLiteralExpression(node)) return scanObject(node, s);
  if (ts.isArrayLiteralExpression(node)) {
    for (const e of node.elements) scanValue(ts.isSpreadElement(e) ? e.expression : e, s);
    return;
  }
  if (ts.isIdentifier(node)) {
    if (SECRET_NAME.test(node.text)) s.report(node, `value \`${node.text}\``);
    followDeclaration(s.checker.getSymbolAtLocation(node), s);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (SECRET_NAME.test(node.name.text)) s.report(node, `value \`${node.getText()}\``);
    const top = secretAtTop(s.checker.getTypeAtLocation(node.expression));
    if (top) s.report(node, `reads a field of a ${top}`);
    scanValue(node.expression, s);
    return;
  }
  if (ts.isElementAccessExpression(node)) { scanValue(node.expression, s); scanValue(node.argumentExpression, s); return; }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (SEALERS.has(name)) return; // sealed by field-crypto: ciphertext only
    scanValue(node.expression, s);
    node.arguments.forEach((a) => scanValue(a, s));
    return;
  }
  if (ts.isTemplateExpression(node)) { node.templateSpans.forEach((sp) => scanValue(sp.expression, s)); return; }
  if (ts.isBinaryExpression(node)) { scanValue(node.left, s); scanValue(node.right, s); return; }
  if (ts.isConditionalExpression(node)) { scanValue(node.whenTrue, s); scanValue(node.whenFalse, s); return; }
  if (ts.isAwaitExpression(node) || ts.isTypeOfExpression(node)) { scanValue(node.expression, s); return; }
  if (ts.isPrefixUnaryExpression(node)) { scanValue(node.operand, s); return; }
  // String/number literals, `new X()`, arrow functions: nothing a secret can hide in by name.
}

/** Scan every `.enqueue(` payload in the given source files. */
function scanFiles(program: ts.Program, files: readonly string[]): { sites: number; findings: string[] } {
  const checker = program.getTypeChecker();
  const findings: string[] = [];
  let sites = 0;
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`not in program: ${file}`);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'enqueue') {
        sites++;
        const report: Report = (at, why) => {
          const { line } = sf.getLineAndCharacterOfPosition(at.getStart(sf));
          findings.push(`${relative(ROOT, file)}:${line + 1} ${why}`);
        };
        const payload = n.arguments[1];
        if (!payload) report(n, 'enqueue without a payload argument');
        else {
          const hit = secretIn(checker, checker.getTypeAtLocation(payload));
          if (hit) report(payload, `payload type contains ${hit}`);
          scanObject(payload, { checker, report, seen: new Set(), depth: 0 });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, findings };
}

/** A real ts.Program over tsconfig.json (so `@/` aliases and types resolve); optional in-memory probe file. */
function buildProgram(probeSource?: string): { program: ts.Program; files: string[] } {
  const { config } = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };
  const files = parsed.fileNames.filter(
    (f) => relative(ROOT, f).startsWith(`src${sep}`) && readFileSync(f, 'utf8').includes('.enqueue('),
  );
  const host = ts.createCompilerHost(options, true);
  if (probeSource !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.getSourceFile = (f, lang, onError, create) =>
      f === PROBE ? ts.createSourceFile(f, probeSource, lang, true) : getSourceFile(f, lang, onError, create);
    host.fileExists = (f) => f === PROBE || fileExists(f);
  }
  const rootNames = probeSource !== undefined ? [PROBE] : files;
  return { program: ts.createProgram({ rootNames, options, host }), files };
}

describe('STATIC: no enqueue payload under src/ carries creds / tokens / secrets (fix 11)', () => {
  it('every .enqueue( payload is an inline literal whose TYPE, NAMES and local DATAFLOW are free of secrets', () => {
    const { program, files } = buildProgram();
    const { sites, findings } = scanFiles(program, files);
    // The scan must actually see the producers (36 at bf4b083; 38 once Task 9's
    // sweepFxHealth + schedule-refused ops.alert sites land — both scanned here
    // like every other src file) — a rename that makes it scan nothing must fail.
    expect(sites).toBeGreaterThanOrEqual(30);
    expect(findings).toEqual([]);
  }, 120_000);

  it('the scanner is live: it flags every shape the audit found AND the two name-only bypasses', () => {
    const probe = [
      "import type { WaCreds } from '@/lib/whatsapp';",
      "import type { PartnerIntegrations } from '@/lib/partner-integrations';",
      "import { encryptField } from '@/lib/field-crypto';",
      'declare const o: { enqueue(kind: string, payload: Record<string, unknown>): Promise<boolean> };',
      'declare const waCreds: WaCreds;',
      'declare const integrations: PartnerIntegrations;',
      'declare const ctx: { waCreds?: WaCreds; partnerId: string };',
      'declare const to: string, body: string, base: string, token: string;',
      'declare const payload: Record<string, unknown>;',
      'declare function pickPartner(c: unknown): string | undefined;',
      'export async function probe(): Promise<void> {',
      "  await o.enqueue('p1', { to, body, creds: waCreds });",
      "  await o.enqueue('p2', { to, body, ...(ctx.waCreds ? { creds: ctx.waCreds } : {}) });",
      "  await o.enqueue('p3', { text: `${base}/partners/apply/${token}` });",
      "  await o.enqueue('p4', { to, token });",
      "  await o.enqueue('p5', payload);",
      "  await o.enqueue('p6', { to, body, cfg: integrations.whatsapp });", // BYPASS A: innocent key, secret TYPE
      '  const note = waCreds.token;',
      "  await o.enqueue('p7', { to, note });", // BYPASS B: innocent local/shorthand
      '  const { token: memo } = waCreds;',
      "  await o.enqueue('p8', { to, memo });", // BYPASS B′: innocent destructured name
      "  await o.enqueue('c1', { to, body, partnerId: pickPartner(ctx) });", // the fixed shape: clean
      "  await o.enqueue('c2', { to, sealed: { apply_link: encryptField(`${base}/partners/apply/${token}`) } });", // sealed: clean
      '}',
    ].join('\n');
    const { program } = buildProgram(probe);
    const sf = program.getSourceFile(PROBE)!;
    const checker = program.getTypeChecker();
    const flagged: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'enqueue') {
        const kind = (n.arguments[0] as ts.StringLiteral).text;
        let hit = false;
        const report: Report = () => { hit = true; };
        if (secretIn(checker, checker.getTypeAtLocation(n.arguments[1]))) hit = true;
        scanObject(n.arguments[1], { checker, report, seen: new Set(), depth: 0 });
        if (hit) flagged.push(kind);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(flagged).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  }, 120_000);
});
```

2. Run `npx vitest run tests/outbox-payload-secrets.test.ts && npx eslint --max-warnings 0 tests/outbox-payload-secrets.test.ts`. **Expected:** `2 passed`, and eslint is clean.
   - The census test finds no finding at any site. After Task 9 that is 38 sites, including `rate-staleness.ts`'s `sweepFxHealth` and `cron-run.ts`'s schedule-refused `{ message }` alerts. The gate follows `message` to its local initializer; if that ever interpolated a secret-named value, it would be flagged, which is intended.
   - The probe flags exactly `p1`-`p8` and passes the clean `c1` / `c2`. `p6` (secret TYPE under the innocent key `cfg`), `p7` (a token through the local `note`) and `p8` (a token destructured as `memo`) are the two review bypasses. The earlier name-only scanner passed all three.

3. **RED proof.** It shows the gate catches the pre-fix code; record it in the PR. The Step 2-6 edits are already committed, so run the new test in a throwaway checkout of the pre-fix `main`. The checkout sits next to this worktree in `~/dev/wt`, so it is outside iCloud.

   ```bash
   git worktree add -q ../wt-fix18-red origin/main && cp tests/outbox-payload-secrets.test.ts ../wt-fix18-red/tests/ \
     && ln -s "$PWD/node_modules" ../wt-fix18-red/node_modules \
     && (cd ../wt-fix18-red && npx vitest run tests/outbox-payload-secrets.test.ts -t "every .enqueue") ; \
     git worktree remove --force ../wt-fix18-red
   ```

   **Expected RED** (verified at `bf4b083`): `AssertionError: expected [ …(27) ] to deeply equal []`. Every finding lies in one of the 8 census sites or in the declaration that feeds it:
   - `partners-action.ts:123`, value `token`; `:92`, destructured from `"token"` and value `issueApplicationToken`.
   - `tickets/actions.ts:113` and `:221`, `payload type contains WaCreds (via .creds)`; `:116` and `:224`, key `"creds"` and value `waCreds`; `:99` and `:214`, value `waCredsFrom`.
   - `outbox-worker.ts:398`, type + key + value; `:386`, destructured from `"waCreds"`.
   - `settlement.ts:120` and `:160`, type + key + value.
   - `tools.ts:1755` and `:1802`, type; `:1758` and `:1802`, key `"creds"` and value `ctx.waCreds`.

   Line numbers shift if Tasks 9, 6 or 5 moved code; the eight sites do not.

4. **Tripwire (RED → GREEN).**

   a. In `tests/outbox-payload-secrets.test.ts`:
      - **Replace** `import { describe, it, expect } from 'vitest';` **with** `import { describe, it, expect, beforeEach } from 'vitest';`.
      - **Replace** `import ts from 'typescript';` **with**:

```ts
import ts from 'typescript';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';
```

      Then append at EOF:

```ts

describe('TRIPWIRE: outbox-repo.enqueue refuses a secret-bearing payload under test (fix 11)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('rejects creds, a nested WaCreds shape and a PartnerIntegrations shape — naming paths, never values', async () => {
    const outbox = createOutboxRepo(db);
    await expect(outbox.enqueue('whatsapp.text', { to: '1', body: 'x', creds: { phoneNumberId: 'p', token: 'SEKRIT' } }))
      .rejects.toThrow(/secret-bearing shape at \$\.creds/);
    await expect(outbox.enqueue('whatsapp.text', { to: '1', meta: { cfg: { phoneNumberId: 'p', token: 'SEKRIT' } } }))
      .rejects.toThrow(/\$\.meta\.cfg\.token/);
    await expect(outbox.enqueue('email.send', { cfg: { kyc: {}, payment: {}, whatsapp: {} } }))
      .rejects.toThrow(/\$\.cfg \(PartnerIntegrations shape\)/);
    await expect(outbox.enqueue('whatsapp.text', { to: '1', creds: { token: 'SEKRIT' } })).rejects.not.toThrow(/SEKRIT/);
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows[0].n).toBe(0);
    expect(await outbox.enqueue('whatsapp.text', { to: '1', body: 'x', partnerId: 'default' })).toBe(true);
  });
});
```

   b. Run `npx vitest run tests/outbox-payload-secrets.test.ts -t TRIPWIRE`. **Expected RED:** `AssertionError: promise resolved "true" instead of rejecting`.

   c. Implement in `src/db/repos/outbox-repo.ts`. Insert directly after `export type OutboxRow = typeof outbox.$inferSelect;` (`:35`):

```ts

// Keys that only a secret-bearing shape carries: WaCreds ({ phoneNumberId, token }),
// the PartnerIntegrations sub-configs (apiKey, webhookSecret, credentials,
// verifyToken, appSecret) and the pre-fix-11 `creds` envelope.
const SECRET_SHAPE_KEYS: ReadonlySet<string> = new Set([
  'creds', 'token', 'verifytoken', 'appsecret', 'apikey', 'webhooksecret',
  'credentials', 'signingsecret', 'secret', 'password',
]);

/**
 * Paths (never values) at which `value` carries a secret-bearing shape: a
 * secret-named key anywhere, or a { kyc, payment, whatsapp } PartnerIntegrations
 * object. Pure; used by enqueue's test-only tripwire (fix 11).
 */
export function secretShapePaths(value: unknown, path = '$', depth = 0, out: string[] = []): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => secretShapePaths(v, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  const obj = value as Record<string, unknown>;
  if ('kyc' in obj && 'payment' in obj && 'whatsapp' in obj) out.push(`${path} (PartnerIntegrations shape)`);
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_SHAPE_KEYS.has(k.toLowerCase())) out.push(`${path}.${k}`);
    secretShapePaths(v, `${path}.${k}`, depth + 1, out);
  }
  return out;
}
```

      Then, in `enqueue`, **Replace** (`:59-61`):

```ts
    ): Promise<boolean> {
      const rows = await db
        .insert(outbox)
```

      **With:**

```ts
    ): Promise<boolean> {
      // TEST-ONLY tripwire (fix 11): a payload must never carry a secret-bearing
      // shape — creds resolve at drain time, capabilities are sealed. Under
      // vitest every producer the suite exercises is checked at runtime; in
      // production this is a no-op (a new throw inside money transactions is not
      // worth it — tests/outbox-payload-secrets.test.ts is the build gate).
      if (process.env.VITEST) {
        const paths = secretShapePaths(payload);
        if (paths.length > 0) {
          throw new Error(`outbox payload for ${kind} carries a secret-bearing shape at ${paths.join(', ')} (fix 11)`);
        }
      }
      const rows = await db
        .insert(outbox)
```

      `process.env.VITEST` is set by vitest in every worker; the same guard is already used at `src/lib/rate.ts:45` and `:58`.

   d. Run `npx vitest run tests/outbox-payload-secrets.test.ts tests/outbox-worker.test.ts && npx tsc --noEmit && npx eslint --max-warnings 0 src/db/repos/outbox-repo.ts tests/outbox-payload-secrets.test.ts`. **Expected:** `4 passed` + `45 passed`, and tsc and eslint are clean. The worker suite's two legacy-row tests already use raw `INSERT`s (Step 2), so the tripwire does not trip them. Then run the **full** `npx vitest run` once. With the tripwire on, every producer that any suite exercises is now checked at runtime. In the scratch run nothing else tripped: the full suite was green.

5. Commit: `git add tests/outbox-payload-secrets.test.ts src/db/repos/outbox-repo.ts && git commit -m "test(outbox-worker): type-aware no-secrets gate over every enqueue payload + test-only enqueue tripwire (Program-Fix 18)"`.

---

#### Step 8 — Migration `0016_scrub_outbox_secrets` (data-only) + its snapshot, journal, test and chain guard

**API grounding** (drizzle-kit 0.31.10, `node_modules/drizzle-kit/bin.cjs`):
- `generate --custom` skips the schema diff (`:32176-32187`) and writes, for the next idx: an empty SQL file, a snapshot that is the previous snapshot with a fresh `id` and `prevId = previous.id` (`preparePgMigrationSnapshot`, `:19848-19860`), and the journal entry (`:32960-32972`).
- The previous snapshot is the last one by sorted filename (`preparePrevSnapshot`, `:19862-19871`).
- When two snapshots name the same parent, `prepareMigrationFolder` prints a collision and **exits 0 writing nothing** (`:8197-8230`), which makes CI's drift check pass vacuously.
- Precedent: data-only `0001` and `0006` both have snapshots (`drizzle/meta/0001_snapshot.json`, `0006_snapshot.json`). `0014` shipped without one and failed CI's drift check until `b484a82` added it. The pre-Wave-1 draft's "data migrations have no snapshot" was wrong.

1. In `tests/outbox-payload-secrets.test.ts`, widen the imports.
   - **Replace** `import { freshDb } from './helpers-db';` **with** `import { freshDb, seedPartner } from './helpers-db';`.
   - **Replace** `import { createOutboxRepo } from '@/db/repos/outbox-repo';` **with**:

```ts
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
```

   Then append the migration describe at EOF. The resulting file is byte-identical to the verified one.

```ts

describe('drizzle/0016_scrub_outbox_secrets (data-only) — scrubs legacy rows without degrading an unsent one, idempotent', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb(); // migrate() already ran 0016 once, against an empty outbox
    await seedPartner(db, 'acme');
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
  });

  async function runMigration(): Promise<void> {
    const file = readFileSync(join(ROOT, 'drizzle/0016_scrub_outbox_secrets.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
  }

  async function payloads(): Promise<Record<string, Record<string, unknown>>> {
    const r = (await db.execute(sql`SELECT dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ dedupe_key: string; payload: Record<string, unknown> }>;
    };
    return Object.fromEntries(r.rows.map((x) => [x.dedupe_key, x.payload]));
  }

  it('back-fills partnerId, strips creds only where safe, redacts only FINISHED legacy invites, leaves new-shape rows alone', async () => {
    // Raw INSERTs: these are rows the PREVIOUS release wrote (the enqueue tripwire refuses them).
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, dedupe_key) VALUES
      ('whatsapp.text', '{"to":"1","body":"a","creds":{"phoneNumberId":"pn_acme","token":"LEAKED1"}}'::jsonb, 'pending', 'stage1:legacy_known_pending'),
      ('whatsapp.text', '{"to":"1","body":"b","creds":{"phoneNumberId":"pn_gone","token":"LEAKED2"}}'::jsonb, 'done', 'stage1:legacy_unknown_done'),
      ('whatsapp.text', '{"to":"1","body":"c","creds":{"phoneNumberId":"pn_gone","token":"LEAKED3"}}'::jsonb, 'dead', 'stage1:legacy_unknown_dead'),
      ('whatsapp.text', '{"to":"1","body":"d","creds":{"phoneNumberId":"pn_gone","token":"KEEP4"}}'::jsonb, 'pending', 'stage1:legacy_unknown_pending'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/0123456789abcdef"}'::jsonb, 'done', 'partner_app_invite:preq_done'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/fedcba9876543210"}'::jsonb, 'dead', 'partner_app_invite:preq_dead'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/00112233445566778"}'::jsonb, 'pending', 'partner_app_invite:preq_pending'),
      ('whatsapp.text', '{"to":"1","body":"z","partnerId":"acme"}'::jsonb, 'pending', 'stage1:new'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"{{apply_link}}","sealed":{"apply_link":"v1.a.b.c.d"}}'::jsonb, 'done', 'partner_app_invite:preq_new'),
      ('email.send', '{"to":["team@x"],"subject":"New partner request","text":"Review: https://x/admin-dashboard/partner-requests"}'::jsonb, 'done', 'preq:preq_new'),
      ('funding.refund', '{"transferId":"keep_me"}'::jsonb, 'done', 'refund:keep_me')`);

    await runMigration();
    const by = await payloads();
    // Replaceable ⇒ stripped: the pending row now names acme and re-resolves its creds at drain.
    expect(by['stage1:legacy_known_pending']).toEqual({ to: '1', body: 'a', partnerId: 'acme' });
    // Finished ⇒ stripped (no current owner ⇒ no partnerId).
    expect(by['stage1:legacy_unknown_done']).toEqual({ to: '1', body: 'b' });
    expect(by['stage1:legacy_unknown_dead']).toEqual({ to: '1', body: 'c' });
    // UNSENT and unresolvable ⇒ untouched, so the shim still sends it from its own number.
    expect(by['stage1:legacy_unknown_pending']).toEqual({ to: '1', body: 'd', creds: { phoneNumberId: 'pn_gone', token: 'KEEP4' } });
    // Finished legacy invites are redacted; an UNSENT one keeps its link (never emails the redaction).
    expect(by['partner_app_invite:preq_done'].text).toBe('[redacted by migration 0016: legacy partner-application link]');
    expect(by['partner_app_invite:preq_dead'].text).toBe('[redacted by migration 0016: legacy partner-application link]');
    expect(by['partner_app_invite:preq_pending'].text).toBe('link: https://x/partners/apply/00112233445566778');
    // New-shape and unrelated rows are untouched.
    expect(by['stage1:new']).toEqual({ to: '1', body: 'z', partnerId: 'acme' });
    expect(by['partner_app_invite:preq_new'].text).toBe('{{apply_link}}');
    expect(by['preq:preq_new'].text).toBe('Review: https://x/admin-dashboard/partner-requests');
    expect(by['refund:keep_me']).toEqual({ transferId: 'keep_me' }); // scripts/outbox-status.ts + reconcile read payload->>'transferId'
    expect(JSON.stringify(by)).not.toMatch(/LEAKED/);

    await runMigration(); // idempotent
    expect(await payloads()).toEqual(by);
  });
});
```

   (`LEAKED1`-`LEAKED3`, `KEEP4` and `tok_acme` are fake fixtures, not credentials.)

2. Create `tests/drizzle-meta-chain.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// CI's "Migration drift check" (.github/workflows/ci.yml:38-52) runs
// `drizzle-kit generate` against the LATEST drizzle/meta snapshot. Two ways it
// can pass while the tree is wrong (drizzle-kit 0.31.10, node_modules/drizzle-kit/bin.cjs):
//   • the newest migration ships without a snapshot (the 0014 incident, fixed in
//     b484a82) — generate then diffs against a stale snapshot;
//   • two snapshots name the same parent (two migrations authored in parallel) —
//     prepareMigrationFolder prints a collision and exits 0 writing nothing
//     (bin.cjs:8197-8230), so `git status drizzle/` is clean and the check is vacuous.
const META = join(__dirname, '..', 'drizzle', 'meta');

describe('drizzle/meta — the snapshot chain the drift check depends on', () => {
  const snapshots = readdirSync(META).filter((f) => f.endsWith('_snapshot.json')).sort();
  const journal = JSON.parse(readFileSync(join(META, '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  it('every snapshot points at the previous one (no fork, no collision)', () => {
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const f of snapshots) {
      const snap = JSON.parse(readFileSync(join(META, f), 'utf8')) as { id: string; prevId: string };
      expect({ file: f, prevId: snap.prevId }).toEqual({ file: f, prevId: prev });
      prev = snap.id;
    }
  });

  it('the newest journal entry has its own snapshot', () => {
    const last = journal.entries[journal.entries.length - 1];
    expect(snapshots[snapshots.length - 1]).toBe(`${last.tag.slice(0, 4)}_snapshot.json`);
  });
});
```

   This guard also protects wave 3. If Task 10's `0017` snapshot is generated before `0016` is on `main`, both snapshots name 0015 as their parent. The first test then fails in CI, where the drift check alone would silently pass.

3. Run `npx vitest run tests/outbox-payload-secrets.test.ts tests/drizzle-meta-chain.test.ts`. **Expected RED:** the migration test fails with `Error: ENOENT: no such file or directory, open '…/drizzle/0016_scrub_outbox_secrets.sql'`. Both chain tests pass, because 0015 is still the last snapshot.

4. Generate the migration skeleton. No DB connection is needed and no `.env` is read:

   ```bash
   npx drizzle-kit generate --custom --name scrub_outbox_secrets
   ```

   **Expected:** `Prepared empty file for your custom SQL migration!` and `[✓] Your SQL migration file ➜ drizzle/0016_scrub_outbox_secrets.sql`. `git status --short drizzle/` shows ` M drizzle/meta/_journal.json`, `?? drizzle/0016_scrub_outbox_secrets.sql` and `?? drizzle/meta/0016_snapshot.json`. The journal diff is one appended entry: `idx 16`, `version "7"`, `tag "0016_scrub_outbox_secrets"`, `breakpoints true`, and a `when` greater than 0015's `1789582583101`. Verify the snapshot:

   ```bash
   python3 -c "import json;a=json.load(open('drizzle/meta/0015_snapshot.json'));b=json.load(open('drizzle/meta/0016_snapshot.json'));print(b['prevId']==a['id']=='a76e256e-3c7e-4a5a-8238-744f66f68ce9', {k:v for k,v in a.items() if k not in('id','prevId')}=={k:v for k,v in b.items() if k not in('id','prevId')})"
   ```

   **Expected:** `True True`.

5. Overwrite `drizzle/0016_scrub_outbox_secrets.sql`, which drizzle-kit wrote as a one-line placeholder:

```sql
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
```

   SQL grounding: jsonb `-`, `||`, `->`, `->>`, `jsonb_set` and `jsonb_build_object` are documented at https://www.postgresql.org/docs/current/functions-json.html; `starts_with` (PG ≥ 11) at https://www.postgresql.org/docs/current/functions-string.html. PGlite 0.5.4 (the test engine) and Neon both run PG ≥ 16. Statements are split on `--> statement-breakpoint`, the same separator `0003_funding_refunds.sql:2` uses. `freshDb()` applies every migration once through `migrate()` (`tests/helpers-db.ts:26`), so a malformed file breaks every PGlite suite. That is why step 7 runs the full suite.

   **Why statements 2 and 3 are conditional** (Wave 2 review). Without the conditions, a legacy row still unsent at migration time would be degraded:
   - an unmatched `whatsapp.*` row would lose its creds and fall back to the shared number, where it likely dead-letters;
   - an unsent invite would email `[redacted…]` to the applicant.

   With the conditions, a too-early run harms no customer. It can only leave residual secret rows, which `SECRETS AT REST` shows. The Step 11 timing and gate exist so that nothing remains. The migration test pins every branch:
   - pending + matched → stripped, and `partnerId` back-filled;
   - pending + unmatched → untouched;
   - done / dead → stripped, or redacted for invites;
   - pending invite → untouched.

6. Run `npx vitest run tests/outbox-payload-secrets.test.ts tests/drizzle-meta-chain.test.ts`. **Expected:** `6 passed`: four in the gate file (static, probe, tripwire, migration) and two chain tests. Then prove the chain guard is live:

   ```bash
   mv drizzle/meta/0016_snapshot.json ../0016_snapshot.parked \
     && npx vitest run tests/drizzle-meta-chain.test.ts ; mv ../0016_snapshot.parked drizzle/meta/0016_snapshot.json
   ```

   **Expected while parked:** `× … the newest journal entry has its own snapshot` with `Expected: "0016_snapshot.json" Received: "0015_snapshot.json"`. Restored: green.

7. Emulate CI's drift check (`.github/workflows/ci.yml:38-52`) on the committed tree. Commit first, then run:

   ```bash
   git add drizzle/0016_scrub_outbox_secrets.sql drizzle/meta/0016_snapshot.json drizzle/meta/_journal.json \
     tests/outbox-payload-secrets.test.ts tests/drizzle-meta-chain.test.ts
   git commit -m "chore(db): drizzle 0016_scrub_outbox_secrets (data-only, conditional, custom snapshot) + its scrub test + snapshot-chain guard (Program-Fix 18)"
   npx drizzle-kit generate --name ci_drift_check; echo "drift: [$(git status --porcelain -- drizzle/)]"; git checkout -- drizzle/; git clean -fdq drizzle/
   ```

   **Expected:** `No schema changes, nothing to migrate 😴` and `drift: []`. If the output instead contains `which is a collision`, the snapshot chain is broken. Regenerate the snapshot; never commit around it. Finally, run `npx eslint --max-warnings 0 tests/outbox-payload-secrets.test.ts tests/drizzle-meta-chain.test.ts` (clean) and the full `npx vitest run` once. A broken journal shows up here as every PGlite suite failing.

---

#### Step 9 — Ops visibility and the stale comments

1. `scripts/outbox-status.ts`. **Replace** (`:106-107`):

```ts
  const needsHuman =
    dead.length + staleLocks.length + stuckPaid.length + staleReview.length + pendingRefunds.length;
```

   **With:**

```ts
  // fix 11: secrets that pre-fix releases copied into payloads. COUNTS ONLY —
  // the payload itself is never selected. The 0016 gate: before /migrate-prod
  // every row here must be done or dead (0016 leaves an UNSENT legacy row
  // untouched so it still sends correctly — it would survive the scrub); after
  // the apply this must print "none".
  const secretsAtRest = await q(sql`
    SELECT kind, status, count(*)::int AS n
    FROM outbox
    WHERE (payload -> 'creds') IS NOT NULL
       OR (kind = 'email.send' AND starts_with(dedupe_key, 'partner_app_invite:')
           AND (payload -> 'sealed') IS NULL AND payload ->> 'text' LIKE '%/partners/apply/%')
    GROUP BY kind, status ORDER BY kind, status`);
  section('SECRETS AT REST (fix 11: legacy creds / cleartext invite links — must be none once drizzle 0016 is applied)', secretsAtRest);

  const needsHuman =
    dead.length + staleLocks.length + stuckPaid.length + staleReview.length + pendingRefunds.length +
    secretsAtRest.length;
```

   The query was executed on PGlite against three rows: a legacy `creds` row, a legacy invite row and a sealed invite row. It returned exactly `[{ kind: 'email.send', status: 'done', n: 1 }, { kind: 'whatsapp.text', status: 'pending', n: 1 }]`. The script header's promise ("prints no secret and no PII", `:1-3`) still holds.

2. `src/db/repos/outbox-repo.ts`. **Replace** (`:197-198`):

```ts
     * the drain itself is not running. Ids/kinds/timestamps only — callers must
     * never print `payload` (it may carry creds until fix 11).
```

   **With:**

```ts
     * the drain itself is not running. Ids/kinds/timestamps only — callers must
     * never print `payload` (message bodies are customer-facing text; sealed
     * email values are ciphertext — fix 11 keeps secrets out, not PII).
```

3. `docs/SYSTEM-ARCHITECTURE.md` §7. Insert this paragraph directly after the **Outbox pattern** paragraph that ends `…delivery can never double-send.` (`:378-382`):

```markdown
**No secrets at rest in payloads** (Phase 1 Task 11 / Program-Fix 18): a customer-facing
`whatsapp.text`/`whatsapp.template` row carries the OWNING `partnerId`, and the
worker resolves that partner's WhatsApp creds at drain time (one lookup per
partner per claimed batch) — a rotated token needs no re-enqueue and a DB dump
holds no bearer token. The one capability that must ride a payload, the
partner-application link, is sealed with field-crypto (`payload.sealed`) and
rendered into `{{placeholders}}` at send time. `tests/outbox-payload-secrets.test.ts`
rejects at build time any `.enqueue(` payload whose type contains `WaCreds` or a
`partner-integrations` config, or that carries a secret-named key or value (followed
through local variables). Under test, `outbox-repo.enqueue` also throws on a
secret-bearing payload shape.
```

4. Run `npx tsc --noEmit && npx eslint --max-warnings 0 scripts/outbox-status.ts src/db/repos/outbox-repo.ts`. Both are clean.

5. Commit: `git commit -am "chore(outbox-worker): outbox-status reports secrets at rest (counts only); comments and architecture doc for Program-Fix 18"`.

---

#### Step 10 — Full verification, security review, PR

1. Proof, quoted verbatim in the PR (the Stop hook enforces it):

   ```bash
   npx tsc --noEmit
   npx eslint . --max-warnings 0
   npx vitest run
   npx drizzle-kit generate --name ci_drift_check; echo "drift: [$(git status --porcelain -- drizzle/)]"; git checkout -- drizzle/; git clean -fdq drizzle/
   git grep -n "creds:" -- src
   git grep -n "settleOrHold(\|beginHold(\|beginSettlement(" -- src
   ```

   Expected:
   - `tsc` and `eslint` clean.
   - `vitest` shows the baseline from Step 0 **+3 files, +34 tests**, all green. At bf4b083 plus this task alone that is `Test Files 174 passed (174) · Tests 2325 passed (2325)`, re-verified after the Wave 2 review fixes. The enqueue tripwire is active for the whole run.
   - The drift check prints `No schema changes, nothing to migrate` and `drift: []`.
   - The `creds:` grep has exactly one hit, `src/app/onboard/seller/[id]/actions.ts:53:    let creds: WaCreds | undefined;`. That is a local variable for a direct OTP send, not a payload key. The shim reads `p.creds` without writing it.
   - The settlement grep shows `settlement.ts` itself plus the five callers with the new arity.

2. Run `/security-review`. This branch touches money paths, crypto, compliance-adjacent settlement signatures and a data migration (CLAUDE.md). It must confirm:
   - (a) no new `console.*`/`log*` call includes a payload; the only new error string is `sealed-text: no sealed value for {{key}}`;
   - (b) every persisted `partnerId` is a server-side value (`paid.partnerId`, `held.partnerId`, `transfer.partnerId`, `ticket.partnerId` from `getScopedTicket`, or `ctx.partnerId` only when `ctx.waCreds` is set), never a form or body field;
   - (c) `encryptField` output is the only capability at rest, under the same key as the `*_enc` columns;
   - (d) 0016 selects no payload into any output, only removes or adds keys, and never alters a row that is unsent and cannot be re-resolved (statements 2 and 3 are conditional);
   - (e) the transition shim can only *send*, never re-persist, a legacy `creds` object;
   - (f) the `enqueue` tripwire is gated on `process.env.VITEST`, so it can never throw in production, and its error names paths only, never values.

3. Run `/code-review` at `high` on the diff. Model routing: the final review is Fable 5.1.

4. Push, then open the PR:

   ```bash
   git push -u origin fix/outbox-worker/no-secrets-in-outbox
   gh pr create --base main --head fix/outbox-worker/no-secrets-in-outbox \
     --title "fix(outbox-worker): stop persisting secrets in outbox payloads — drain-time WhatsApp creds, sealed partner invite link, drizzle 0016 scrub (Program-Fix 18)" \
     --body-file "$SCRATCH/pr-body-fix18.md"
   ```

   `$SCRATCH` is the executing session's scratchpad directory, from its system prompt. Write the body file there with this content, completed from the Step 10.1 and 10.2 outputs:

```markdown
## Summary
Closes audit F49, F54, F58 (partner Meta WhatsApp bearer tokens copied in cleartext into `outbox.payload`) and F66 (raw 30-day partner-application token in `outbox.payload`).

- `whatsapp.text` / `whatsapp.template` payloads now carry the OWNING `partnerId`; the worker resolves `waCredsFrom(getIntegrations(partnerId))` at drain time through a per-batch memoized resolver (N rows for one partner = one lookup). Token rotation needs no re-enqueue.
- `beginSettlement` / `beginHold` / `settleOrHold` drop the creds parameter (ruling 18, on top of Task 3 (PF 6)'s result arms); all five callers updated (pay route, B2B pay route, reconcile funding-resume, partner-API confirm hold + default initiate). No read added inside any money transaction.
- Refund message, ticket nudges, seller links and bill push persist the owner / routed tenant instead of creds.
- The partner invite link is sealed with field-crypto (`payload.sealed.apply_link`) and rendered at send time; the token is still minted exactly once (a re-mint would kill a delivered link).
- `drizzle/0016_scrub_outbox_secrets` (DATA-ONLY, custom snapshot = 0015's, prevId chain verified): back-fills `partnerId` on legacy rows from the unique `wa_phone_number_id`; strips `creds` only where a `partnerId` is present or the row is done/dead; redacts legacy cleartext invite links only on done/dead rows. So an unsent row is never degraded, even if the migration runs early. Idempotent.
- Build gate `tests/outbox-payload-secrets.test.ts`: a type-aware scan (a real `ts.Program` + the checker) of every `.enqueue(` payload under `src/` — 38 sites, including Task 9's two new `ops.alert` sites. A payload whose TYPE contains `WaCreds` or a `partner-integrations` config, a secret-named key or value (followed through local variables and destructuring), or a non-literal payload fails CI. A probe proves the scanner catches the `{ cfg: integrations.whatsapp }` and laundered-local bypasses.
- Test-only tripwire in `outbox-repo.enqueue`: under `VITEST` a secret-bearing payload shape throws, naming paths only, so every producer the suite exercises is checked at runtime. It is a no-op in production.
- `tests/drizzle-meta-chain.test.ts` means the drift check can never pass vacuously.
- `scripts/outbox-status.ts` gains a counts-only `SECRETS AT REST` section used by the runbook gates.

Dedupe keys unchanged: stage1:, instruct:, mocksettle:, refundmsg:, ticketmsg:, ticketresolved:, billpush:, sellerbill:, selleronboard:, partner_app_invite:, preq:.

Conflict rulings: #1 (0016 pre-assigned), #18 (3↔11), #19 (7↔11 — migration runs AFTER deploy), #20 (6↔11), #27 (Task 8 keeps the resolver, deletes the shim).

## Transition shim
`resolveSendCreds` honours a legacy `creds` object only when a row has no `partnerId` (rows enqueued by the previous release during the deploy→migrate window). Unreachable once 0016 is applied; Task 8 (Program-Fix 12) deletes it and its test.

## Proof
(The executor pastes, verbatim: the Step 10.1 outputs — tsc, eslint, the vitest totals line, the drift-check lines and both greps — and the Step 7.3 RED output, 27 findings at the 8 census sites.)

## Security review
(The executor pastes the /security-review conclusion for points (a)–(f) of Step 10.2.)

## Post-merge runbook (ORDER MATTERS — owner runs /migrate-prod)
See the task plan "Step 11". Summary: merge → deploy Ready + smoke green → wait ≥ 5 min (pay route maxDuration 300 s) and confirm Skew Protection is off or its window has passed → /outbox-status gate (every SECRETS AT REST row done/dead) → /migrate-prod (0016, data-only: 3 conditional UPDATEs, explicit sign-off) → verify SECRETS AT REST = none → /tracker-sync → /sync-branches.

Program-Fix: 18

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

   After the `🤖 Generated with…` line, the body ends with the session-URL line that the executing session's system reminder prescribes for PR descriptions.

---

#### Step 11 — Merge and the production runbook (owner)

Ruling 19 and the Migration Gate apply: this is the one migration deliberately run *after* its code deploy. There are two protections, and each works without the other:
- **Runbook:** steps 3-5 below make sure no old code is still writing secrets and nothing unsent still holds one.
- **Migration:** 0016's own conditions (Step 8) never degrade an unsent row. So if the runbook is short-cut, the worst outcome is residual secret rows, never a wrong or failed customer message.

1. After `ci / ci` is green, including "Migration drift check", squash-merge.

2. Run `/post-merge-check` with the merged PR's number. Its migration gate says "run /migrate-prod NOW". For **this** merge, hold it until step 6. 0016 changes no column, so nothing selects a missing column while it is pending, and the shim drains any legacy row correctly. Let the skill watch `smoke.yml` for the merge SHA to green.

3. **Old-code drain time.** Wait until the rolling release of the merge SHA has reached 100%: the smoke run's "Wait for the rolling release to reach 100%" step passed, or `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'` reports the merge SHA's first 7 chars. Until then the previous deployment still takes new requests (90% of traffic for the first 5 minutes). Then wait **at least 5 more minutes**. This is the longest function lifetime:
   - `src/app/api/pay/[transferId]/route.ts:33` — `maxDuration = 300`;
   - `src/app/api/cron/route.ts:21` — `maxDuration = 300`;
   - `src/app/api/worker/route.ts:29` — `60`.

   After 5 minutes, no invocation of the previous deployment that began before the cut-over can still be running and enqueuing.

4. **Skew Protection.** With Skew Protection on, a browser tab opened before the deploy keeps sending its server actions to the OLD deployment until the max age passes. That covers the public partner form (`partners-action.ts`, raw invite link) and an open dashboard's ticket actions (`creds` payloads). Check it from the linked main checkout. Vercel CLI v54 per CLAUDE.md; command reference: https://vercel.com/docs/cli/project.

   ```bash
   vercel project protection claude-payments --format json
   ```

   - **Skew protection disabled** → continue.
   - **Enabled** → record its max age in the merge comment. Then either:
     - wait until the previous production deployment is older than that max age; or
     - (owner decision) run `vercel project protection disable claude-payments --skew`, wait 5 more minutes, finish steps 5-7, then restore it with `vercel project protection enable claude-payments --skew --skew-max-age`, passing the recorded max age in seconds.

   Why this matters: a stale old-code writer that runs after the migration leaves secret rows that 0016 has already passed over. Clearing them would need another data statement, and the next migration slot belongs to Task 10's `0017`.

5. **Gate.** Bring the main checkout to the merge SHA. That checkout holds `.env.local`, and both `/outbox-status` (the new `SECRETS AT REST` section) and `/migrate-prod` (which needs `drizzle/0016…` on disk) run there:

   ```bash
   cd "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" && git fetch -q origin && git checkout -q --detach origin/main
   ```

   Run `/outbox-status` and read `SECRETS AT REST`. Every row listed there must be `done` or `dead`, because 0016 deliberately leaves an unsent legacy row untouched so it still sends correctly, and such a row would outlive the scrub.
   - A `pending` / `failed` / `processing` row: wait for the drain, or run `/worker-poke`, then re-run `/outbox-status`.
   - A `dead` legacy **invite**: Retry it from `/admin-dashboard/ops` first. The new handler sends a legacy text unchanged, because it has no `{{…}}` placeholder. Wait until it is `done`. If the retry dies again (SMTP), record the lead id in the merge comment for manual outreach: 0016 redacts dead invites.
   - A `dead` legacy **whatsapp** row may stay dead. 0016 back-fills its `partnerId` when a current partner owns the number; otherwise a later Retry sends it on the shared number.

6. **Owner:** run `/migrate-prod`.
   - `scripts/migration-status.ts` lists `0016_scrub_outbox_secrets` as the only PENDING tag.
   - The skill classifies it as **destructive** (three conditional `UPDATE`s). It prints them verbatim and needs your explicit sign-off.
   - It applies once (`npx drizzle-kit migrate` over `DATABASE_URL_UNPOOLED`).
   - Verify: `set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts --check "SELECT count(*)::int AS creds_rows FROM outbox WHERE (payload -> 'creds') IS NOT NULL"` → `creds_rows = 0`.

7. Re-run `/outbox-status`. `SECRETS AT REST` must print `none`. **Live proof of the new shape.** It prints counts only:

   ```bash
   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts --check "SELECT count(*) FILTER (WHERE (payload -> 'creds') IS NOT NULL)::int AS with_creds, count(*) FILTER (WHERE (payload ->> 'partnerId') IS NOT NULL)::int AS with_partner, count(*)::int AS total FROM outbox WHERE kind IN ('whatsapp.text','whatsapp.template') AND created_at > now() - interval '1 day'"
   ```

   Expected: `with_creds = 0`. The post-deploy smoke specs (`tests/e2e/dashboard-smoke.spec.ts`, `support-smoke.spec.ts`) do not settle a payment, so there may be no fresh message row yet. If `total = 0`, re-run the check after the next organic customer-facing message (a pay-link payment, a refund, a ticket reply) and record it in the ledger then. Never create a real customer message just to prove this.

   If `SECRETS AT REST` is not empty after the apply, stop. That is only possible if step 3, 4 or 5 was skipped. Do not hand-edit the ledger, and record an `incident` in the ledger. The rows cannot harm a customer, because 0016 never degraded an unsent row, but they do hold secrets. Clearing them needs the same three idempotent statements run again in the next migration slot. Raise it on Task 10's `0017` PR (append the statements there), instead of creating a migration that collides with it.

8. Run `/tracker-sync`. Program-Fix 18 counts as `done` only when it is merged, smoke is green, and steps 6-7 are verified and quoted in the merge comment, together with the step 4 Skew Protection result. Then run `/sync-branches` so that `component/outbox-worker` equals `main` for Task 8 (Program-Fix 12, wave 4), and so Task 10 (Program-Fix 16) can generate `0017` with `prevId` = 0016's id.

---

#### Out of scope (stated in the PR) and notes for later tasks

- **Task 8 (Program-Fix 12, ruling 27):**
  - deletes the TRANSITION SHIM branch of `resolveSendCreds` and the `'TRANSITION SHIM: …'` test. They are unreachable once 0016 is applied and `SECRETS AT REST` prints `none`; check the latter first, because 0016 leaves an unsent legacy row untouched;
  - keeps `memoizedPartnerContext` / the `partner` argument of `handle` when it reworks `drainOnce`.
- **Task 4 (Program-Fix 8, wave 3):** the rail-failure customer message must enqueue `{ to, body, partnerId: transfer.partnerId }`. Two checks fail CI on anything else: the Step 7 gate (type, name and dataflow) and the `enqueue` tripwire, which covers any `creds`, `WaCreds` or integrations object.
- **Task 10 (Program-Fix 16, wave 3):** generate `0017` only after 0016 is on `main`. `tests/drizzle-meta-chain.test.ts` rejects a collided snapshot.
- **Program-Fix 37 (Phase 3), not this task:**
  - retention and purge of `done` rows;
  - scrubbing payloads on `markDone`;
  - PII (phone numbers, message bodies) in payloads.

  None of these holds a secret after this task.
- **Not changed here:**
  - direct in-process sends with creds held in memory (the "Left alone" list in Ground truth);
  - Redis session tokens (Program-Fix 20);
  - pay-link / invoice / seller ids in message bodies. Those ids are already primary keys at rest in their own tables, so the outbox adds no exposure.


---

