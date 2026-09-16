# Phase 1 — Money-Safe Core Implementation Plan

**Date:** 2026-09-15 · **Program:** SmartRemit Phase 1 (post `2026-09-14` production-readiness audit, PR #241) · **Repo:** `Nagavenkatasai7/claude-payments` · **Base:** `main @ 997d9e3` (NOT `4ee8d25` — that commit is the merge commit on `fix/platform-security/e2e-no-hardcoded-creds`, not on `main`; `main` moved to `4fc4e6a` five PRs later — #244 e2e login fallbacks, #249 `vercel.json` `ignoreCommand`, #246 js-yaml, #247 smoke artifacts, #248 docs — and then to `997d9e3` via #250/#251/#252, which touch ONLY `.claude/skills/`, `CLAUDE.md`, `scripts/tracker/` and `tests/e2e/dashboard-smoke.spec.ts` (`git diff --stat 4fc4e6a..997d9e3`), so every `src/` and `tests/*.test.ts` line cited below is unchanged between the two). Every `file:line` in the task sections below was READ against `4ee8d25` and re-verified on `4fc4e6a`; before cutting any branch re-cite the lines you touch against `997d9e3` (the "on `4fc4e6a`" notes in the task bodies remain true on `997d9e3`) — in particular `vercel.json` now carries `"ignoreCommand"` (Task 8 must MERGE, never replace it) and `tests/e2e/*.spec.ts` now require `E2E_USERNAME`/`E2E_PASSWORD` (Task 13's new e2e spec must read them the same way, never a literal).

## Goal

Close the 13 Phase-1 findings that put money, compliance or the durability spine at risk — outbox durability (lease/timeout/secrets/cadence), tenant isolation for phone-keyed state, compliance-hold enforcement on every settlement path, FX fail-loud, masked-destination minting, staff-cancel voiding paid transfers, rail-failure refund/notify/alert, restored send caps with ledger-derived counters, SSRF-safe settlement URLs, and CSPRNG transfer ids with a fail-open pay-page throttle — **without regressing any of the invariants in `CLAUDE.md`'s Architecture Spine** (transactional money paths, outbox-as-system-of-record, app-level tenant isolation, encryption-at-rest with masked-by-default reads, sanctions-always-runs, and the security pack). Thirteen fixes land across 8 component worktrees in 4 dependency-ordered waves, each wave's PRs merged and migrated one at a time, so that at every commit on `main` the ledger, the outbox and the compliance gate stay internally consistent.

## Architecture Notes

- **Waves are dependency order, not urgency order.** A fix in wave *N* may only be branched after every fix it `rebases onto` in wave < *N* is on `main`; fixes within the same wave that touch a shared file are still serialized per the conflict rulings below (see e.g. 9 → 6 → 5 → 11 inside wave 2).
- **One component = one worktree, one branch prefix.** Branches are `fix/<component>/<slug>` cut from `origin/component/<component>` in a worktree **outside iCloud** (`git worktree add ~/dev/wt/<component> origin/component/<component>`) — iCloud eviction stalls tsc/eslint/vitest on first read (see CLAUDE.md gotchas). Task 1 is the sole exception: it holds both the `partner-api` and `customer-portal` anchors in one PR (owner-acknowledged boundary-hook flag) because tenant-scoping the customer identity touches both.
- **Migrations are manual and serialized.** Nothing in CI/Vercel applies `drizzle/` migrations to prod Neon; each of the four migrations in this program (0014–0017) is applied by hand immediately after its PR merges, before the next PR in the queue is opened. See "Migration Gate" below.
- **The compliance/settlement/outbox spine is the hot path.** Tasks 7, 1, 3, 9, 6, 11 (waves 1–2) rewrite the exact functions — `beginSettlement`, `markPaidIfAwaiting`, `outbox-worker.ts` claim/lease, `CustomerStore`, FX rate gating, and the masked-destination mint guard — that every later fix in waves 3–4 rebases onto. Landing them out of order (see conflict rulings) either reintroduces the defect a later fix exists to kill (6 before 2; 5 before 4) or breaks compilation (1 before anyone touching `CustomerStore`/velocity keys; 9 before anyone touching FX call sites).
- **Every fix restates, not just cites, the CLAUDE.md invariants it touches** — durability (outbox row in the same transaction as the state change), claim-first minting, tenant isolation (404-never-403, partnerId in every WHERE), masked-by-default reads, sanctions-always-runs, and fail-open vs fail-closed posture per surface (rate limits fail-open; webhook signatures and the new SSRF guard fail-closed). Each task file below states its own applicable subset up front.
- **No corridor/prompt/tool-copy contract may reintroduce banned tokens.** `tests/bot-content-guard.test.ts` statically scans agent-facing prose for `partner`, `corridor`, `watchlist`, `sanctions`, `blocked` — tasks 2, 9 and 10 touch prompt/tool copy and must not trip it.

## Wave / Worktree Table

| Wave | Task | Title | Component (worktree) | Model | Migration | Merge-order note |
|---|---|---|---|---|---|---|
| 1 | 7 | Add outbox lock leases and timeouts on every outbound fetch | `outbox-worker` | Fable 5.1 | `0014_outbox_lease` | Merges **first** in the whole program |
| 1 | 1 | Scope phone-keyed customer state by tenant (partner API + WhatsApp webhook) | `partner-api` **+** `customer-portal` (one PR) | Fable 5.1 | `0015_tenant_scoped_customers` | After 7 · **D11 shared-webhook variant: fail-closed** (a routed event verifies with THAT partner's app secret only; no secret ⇒ 401) — unless Step 2.2 pre-apply query (c) finds a production partner with a `wa_phone_number_id` but no `wa_app_secret_enc` that cannot be configured before merge, in which case variant B ships (routed + no partner secret ⇒ platform secret, legal only under lock (a)); the PR body names the variant and `tests/whatsapp-route.test.ts` pins it |
| 1 | 3 | Enforce the compliance hold on every settlement path | `money-paths` | Fable 5.1 | none | After 7 and 1 |
| 2 | 9 | Make FX failure loud (stale/unavailable rates, AED, 0-rate) | `corridors-fx` | Fable 5.1 | none | First in wave 2, after 7/1/3 |
| 2 | 6 | Stop minting/settling with the masked `****last4` placeholder | `whatsapp-agent` | Fable 5.1 | none | After 9 and 3, before 2 |
| 2 | 5 | Stop staff "Cancel" from voiding a paid transfer with no refund | `admin-dashboard` | Fable 5.1 | none | After 9 and 6, before 11 |
| 2 | 11 | Stop persisting secrets in outbox payloads (WhatsApp + capability tokens) | `outbox-worker` | Fable 5.1 | `0016_scrub_outbox_secrets` | After 7 and 3; after 5 |
| 3 | 10 | Restore real send caps; derive volume counters from the ledger | `compliance-kyc` | Fable 5.1 | `0017_partner_send_limits` | First in wave 3 |
| 3 | 4 | Rail-failure path: `failed` callback refunds, notifies, alerts | `money-paths` | Fable 5.1 | none | After 10 |
| 3 | 12 | SSRF guard, https validation, redirect cap on settlement URLs | `platform-security` | Fable 5.1 | none | After 4 |
| 3 | 2 | Keep untrusted text out of the agent's system role; always mask shown payout destinations | `whatsapp-agent` | Fable 5.1 | none | Last in wave 3, after 6 (wave 2) and after 10/4/12 |
| 4 | 8 | Move the outbox drain to a real cadence (lease reclaim + heartbeat tuning) | `outbox-worker` | Fable 5.1 | none | After 7, 11, 12 |
| 4 | 13 | Replace `Math.random()` transfer ids with a CSPRNG; fail-open pay-page throttle | `platform-security` | Fable 5.1 | none | Last in the whole program, after 3/6/9/10/12 |

## Conflict Rulings

Every cross-task file collision identified in the sequencing pass, with the binding merge-order ruling. Each PR description must state the ruling(s) it operates under.

| # | a↔b | File(s) | Ruling |
|---|---|---|---|
| 1 | 7↔1 | `drizzle/meta/_journal.json` + `drizzle/00NN_*.sql` | Journal is at idx 13 (latest `0013_glamorous_the_call`), so fixes 7, 1, 11 and 10 ALL currently claim `0014`. Pre-assigned before any branch is cut: **7→0014_outbox_lease, 1→0015_tenant_scoped_customers, 11→0016_scrub_outbox_secrets, 10→0017_partner_send_limits**. Journal edits merge deterministically (append-only, different idx). Merges + `/migrate-prod` are serialized one PR at a time: merge → `set -a; source .env.local; set +a; npx drizzle-kit migrate` → verify `smoke.yml` green → next merge. Never two unapplied migrations in flight. |
| 2 | 7↔1 | `src/db/schema.ts` | Shared file, disjoint tables: 7 owns the `outbox` block (lease_until/lease_owner + widened outbox_drain predicate), 1 owns `customers`/`recipients` (composite PKs), 10 owns `partners.send_limits`, 11 touches no DDL. Merge order 7 → 1 → 10 makes every hunk a clean append. |
| 3 | 7↔1 | `src/lib/outbox-worker.ts` | 7 OWNS outbox-worker.ts for the whole program (claim/lease, per-row deadline, AbortSignal on the three fetchFn POSTs). 1's only need here is passing `routedPartnerId` into `runAgentTurn` in the `agent.turn` case — a ~3-line edit 1 applies on rebase after 7 merges. |
| 4 | 7↔3 | `src/lib/reconcile.ts` | 7 owns the `SweepResult`/`OpsSnapshot` shape (adds `staleLocks`, keeps new fields optional so `api/worker/route.ts`'s zero-literal stays assignable). 3 owns the body of the funding-resume branch (cleared → `beginSettlement`, non-cleared → `beginHold` + deduped alert). 7 merges first; 3 rebases onto the widened type. Neither may add a `cleared` predicate to `listAwaitingWithFunding` — that would abandon charged flagged rows. |
| 5 | 1↔3 | `src/db/repos/transfer-repo.ts` | 1 owns the SIGNATURE changes (`listByPhone`/`countByPhone`/`firstTransferAt` gain a `partnerId` predicate); 3, 4, 5 and 10 only ADD methods (`markInReviewIfAwaiting`, `failTransferFromWebhook`, `cancelIfCancellable`, `sumUsdCentsSince`/`countSince`). 1 lands first so nobody writes a new method against a signature that is about to change. |
| 6 | 1↔3 | `src/lib/partner-api-service.ts` | Different functions in the same hot file: 1 owns `createTransaction` (sender.phone bound to `partner.id`, 404-never-403) and the `resolveSenderNames` call sites; 3 owns `confirmTransaction` (the hold decision must sit OUTSIDE `deps.initiatePayment` or the injected test fake bypasses it). Sequential 1 → 3; 9, 10 and 11 rebase later. |
| 7 | 1↔3 | `src/lib/pay-finalize.ts` + `src/app/api/pay/[transferId]/route.ts` | Guard ORDER is the contract, not the file — and there are TWO contracts, one per file, because Task 3 never touches `pay-finalize.ts` (its guard is `refuseUnlessAwaiting` in `route.ts`). **route.ts (`processTransferPayment`):** status guard + blocked (3, `refuseUnlessAwaiting`) → routed-rail fail-closed (3, later 12) → `captureFunding` → `settleOrHold`. **pay-finalize.ts (`finalizeDraftPayment`), all BEFORE `idem.claim`:** kyc gate (existing) → masked-destination (6) → FX unavailable (9) → cap (10) → `idem.claim`. Mechanics: Task 9 inserts its FX block DIRECTLY AFTER the kyc gate and leaves the marker line `// [fix 6 inserts above this line]` immediately above it; Task 6 (which merges before 9 but rebases onto 9's insert point when 9 merges first in wave 2 — see ruling order 9 → 6) inserts its masked-destination block above that marker; Task 10 puts the cap check LAST before the claim and adds the ONE ordering test this ruling promises (a draft that trips several gates at once refuses with the EARLIEST gate's arm: masked+stale-FX+over-cap ⇒ `bank_details_required`; stale-FX+over-cap ⇒ `fx_unavailable`; over-cap alone ⇒ `cap`). Every refusal leaves the single-use draft and its key untouched. |
| 8 | 1↔7 | `src/lib/store.ts`, `src/lib/daily-volume-store.ts`, `src/lib/monthly-volume-store.ts` (velocity/volume Redis keys) | 1 owns the key shape ONCE: `velocity:{partnerId}:{phone}:{date}` and `(partnerId, phone)` for daily/monthly volume. 10 must consume that shape and not rename again — a second rename resets in-flight compliance counters a second time. 1's PR states the TTL dual-read (or low-traffic window) explicitly. |
| 9 | 1↔5 | `src/db/repos/customer-repo.ts`, `src/lib/customer-auth-store.ts`, `src/app/account/*` | Per `.claude/hooks/components.json` these are the customer-portal anchor, not partner-api. Fix 1 therefore holds BOTH the partner-api and customer-portal worktrees for wave 1 (one PR, boundary-hook flag acknowledged), and no other wave-1 fix may touch `src/lib/customer-*`, `src/db/repos/customer-repo.ts` or `src/app/account/`. The `/account` phone-only login decision (partnerId in `SessionRecord`, fail closed on a multi-tenant phone) is settled inside fix 1 before any code is written. |
| 10 | 9↔7 | `src/lib/rate.ts` | 9 OWNS `rate.ts` outright, including the Frankfurter `AbortSignal.timeout(5000)` that fix 7's brief also lists. 7 drops `rate.ts` from scope entirely (its other five fetch sites are untouched by 9). Stated in both PR descriptions so the timeout is not dropped by both. |
| 11 | 9↔1 | `src/lib/tools.ts`, `src/lib/transfer-create.ts`, `src/lib/partner-api-service.ts` (`getFxRates` call sites) | 1 merges in wave 1 and owns the `partnerId` threading through these three files; 9 rebases its 12 `getFxRates` call-site guards onto the post-1 tree. 9's `RateUnavailableError` must NOT subclass `QuoteError` blindly — partner-api-service must map it to 503 and `tools.ts:1114` must not swallow it as "keep the mid quote". |
| 12 | 9↔10 | `src/lib/fx.ts` | 9 owns fx.ts logic: the `usdPivotCrossRate` zero-guard (`!destToUsd` → `destToUsd == null` + positivity), the age/provenance gate, and the `FxRates` widening (fetchedAt/source added as optional-with-default so ~20 test literals do not all break). 10 afterwards changes ONLY the `MAX_USD` constant 999999 → 2999. 9 before 10. |
| 13 | 9↔6 | `src/lib/payout-format.ts` | payout-format.ts is a corridors-fx file, so 6 (whatsapp-agent worktree) is crossing a seam. 9 merges first; 6 then adds `isMaskedDestination` as a purely additive export and does not alter `accountLast4`/`maskAccountDisplay` bodies. Same wave, sequential merge, boundary-hook flag expected. |
| 14 | 6↔2 | `src/lib/tools.ts` (`maskAccount`, `repeat_transfer` needs_edd, `send_approve_picker`) | HARD ORDER: 6 first. 6 stops `send_approve_picker` trusting `args.payout_destination` and rehydrates the real account server-side from `listRecipients(ctx.phone)`. Only then may 2 remove the `payoutMethod === 'upi'` passthrough at `tools.ts:116` and mask the needs_edd surface. Reversed, 2 masks the last real-destination source and manufactures exactly the ctx-01 defect 6 exists to kill (`****9012` becomes the literal payout account). |
| 15 | 6↔2 | `src/lib/agent.ts` (`[RECIPIENT SELECTED]` note) | Same ordering, same reason: 2's masking/enveloping of the recipient-tap note removes the flow's real-destination source. 6 lands the server-side hydration first (or they land in one branch); 2 then asserts the tap note carries no full destination. |
| 16 | 6↔3 | `src/app/api/pay/[transferId]/route.ts`, `src/app/pay/[transferId]/page.tsx` | 3 owns the pre-capture status guard and the `beginHold` transition; 6 owns `hasStoredDest`/`needsBankDetails` treating a masked value as "collect bank details" plus the new `bank_details_required` FinalizeResult arm (400, not 500). 3 merges in wave 1, 6 rebases in wave 2. |
| 17 | 6↔9 | `src/lib/transfer-create.ts` | Both add pre-mint refusals. 9 merges first (FX unavailable propagates as a clean refusal, honor-verbatim quote gains an age check), then 6 adds the masked/empty destination refusal AND the skip of the unconditional `upsertRecipient` at :238 so a cold-start send cannot overwrite a stored real account. Keep both guards adjacent and above the claim. |
| 18 | 3↔11 | `src/lib/settlement.ts` (`beginSettlement` signature) | Two signature changes to the same function: 3 adds the refusal arm to `SettlementResult` and introduces `beginHold()`; 11 DROPS the 4th `waCreds` param and persists `paid.partnerId` in the stage-1 payload instead. Never in the same wave — 3 (wave 1) then 11 (wave 2), and 11 rewrites the four call sites once, on top of 3's arm. Every caller must handle the refusal arm or a charged flagged transfer strands in `awaiting_payment`. |
| 19 | 7↔11 | `src/lib/outbox-worker.ts`, `src/db/repos/outbox-repo.ts` | 7 owns claim/lease/markDone-markFailed compare-and-set and the outbound deadlines; 11 owns the `whatsapp.text`/`whatsapp.template` handler switching to drain-time `partnerContext` creds resolution and the enqueue-side payload shape. 7 first. 11's data-only scrub migration runs AFTER the code deploy and after the backlog is drained (verify with `scripts/outbox-status.ts`) — it is the one migration deliberately ordered last in its wave. |
| 20 | 6↔11 | `src/lib/tools.ts` (enqueue sites 1733/1780) | 6 owns tools.ts in wave 2; 11 rebases its two enqueue-payload edits (billpush:, enqueueSellerLink gains an explicit partnerId) onto the post-6 tree. Disjoint regions, trivial rebase, but merge order fixed: 6 → 11. |
| 21 | 5↔4 | `src/lib/dashboard-ops.ts` + the cancel/refund transaction and dedupeKey `refund:<id>` | INVERTS the briefs' mutual `dependsOn`: 5 lands first. 5 is guard-only (refuse a bare cancel whenever `fundingRef` is set or the row is past unfunded-draft; make the remaining legal cancel an atomic `WHERE status IN ('awaiting_payment','in_review') AND funding_ref IS NULL` update). 5 ships NO shared refund-enqueue helper — `issueRefund` / `rejectTransfer` / `approveRefund` / `reverseB2bSettlement` keep their four inline `enqueue('funding.refund', { transferId }, { dedupeKey: \`refund:${id}\` })` calls. The CONTRACT 4 reuses is therefore the kind + dedupe key, not a function: 4's rail-failure transition enqueues the same `funding.refund` row under the same `refund:<id>` key inline, so a staff refund and a rail failure can never both enqueue (the unique partial index on `dedupe_key` is the guarantee). |
| 22 | 5↔4 | `src/db/repos/transfer-repo.ts` (`paid → X` edge) | 5 adds `cancelIfCancellable` (awaiting_payment only); 4 adds `failTransferFromWebhook` (paid → terminal-failed + refund none→pending in one guarded UPDATE) and must keep `findStuckPaid` from returning rail-failed rows. Landing them out of order risks one guard not covering the other's new state, so 5 → 4 with 4's PR re-asserting 5's cases green. |
| 23 | 7↔4 | `src/lib/providers/http-payment-provider.ts` | Three fixes edit this file. 7 owns the outbound fetch seams (deadline signals) in wave 1; 6 adds the masked/empty destination throw in `buildSettlementInstruction` in wave 2; 4 then owns the semantics (`normalizeRailStatus` mapping failed/returned, the widened `WebhookResult`, `handleWebhook`) in wave 3 and must preserve both earlier edits when it rewrites the module. |
| 24 | 4↔12 | `src/lib/providers/http-payment-provider.ts`, `src/lib/outbox-worker.ts`, `src/lib/reconcile.ts` | 4 merges first in wave 3 (rail-failure semantics + the reconcile no-re-instruct rule), 12 rebases the safe-fetch wrapper onto it. 12 may delete or guard the dead `HttpPaymentProvider.initiateTransfer` path only if 4 has not already taken ownership of it — decided in 4's PR, stated in 12's. |
| 25 | 12↔7 | `src/app/api/worker/route.ts` (`WorkerDeps.fetchFn` wiring) | 7 owns `WorkerDeps` and the route's time-budget logic; 12 afterwards swaps the default `fetchFn: fetch` for `safeFetch` and adds the synchronous scheme/host assertion inside the two instruct handlers. 12 MUST keep the guard DI-able — a DNS-resolving check inside the handler detonates ~7 suites whose fixtures use the non-resolving host `https://rail.example/settle`. |
| 26 | 8↔7 | `src/db/repos/outbox-repo.ts` `claimBatch` + `drizzle/0014_outbox_lease.sql` | Verified: `claimBatch` selects `status IN ('pending','failed')` (`outbox-repo.ts:67`), which is why processing rows strand. 7 owns the lease columns, the widened `outbox_drain` index and the reclaim disjunct; 8 ships NO migration and only consumes them. Without 7's AbortSignal work first, 8's reclaim simply re-hangs on the same stuck fetch — hard dependency, 7 in wave 1, 8 in wave 4. |
| 27 | 8↔11 | `src/lib/outbox-worker.ts`, `src/lib/reconcile.ts`, `src/app/admin-dashboard/ops/page.tsx`, `scripts/outbox-status.ts` | Same component, so same worktree, so strictly sequential: 7 (wave 1) → 11 (wave 2) → 8 (wave 4). 8 is written as DELTAS on the post-7/post-11 tree, never as "replace lines X–Y" of `main`: it keeps 7's `LEASE_MS` (5 min), `claimBatch(limit, workerId, leaseMs)`, owner-CAS `markDone`/`markFailed`, `withRowDeadline` + the `RowSignal` cooperative/abandoned discriminator (`COOP_GRACE_MS`), `stopAfter`/`releaseUnstarted`, `hardStopAt` (a non-idempotent row that cannot finish before `maxDuration` is released, not started), `DrainResult.released`, `START_CUTOFF_MS`, `STALE_LOCK_MINUTES`/`staleLocks` (expired >15 m AND unreclaimed) and 11's per-batch `partner` resolver, and ADDS `reclaimed`, dead-at-claim, `dueSummary`, `listExpiredLeases` → `OpsSnapshot.expiredLeases`, the drain-gap alarm and the self-chain. 8 lands last and owns the final honest cadence claims — the drain-gap ops alert card next to 7's stale-locks card, and the lease-inclusive due backlog in `scripts/outbox-status.ts` (7 already fixed the "reclaimed on the next drain" wording). |
| 28 | 8↔12 | `src/lib/outbox-worker.ts` | 12 merges in wave 3 (fetch guard), 8 in wave 4 (drain loop, per-run budget, self-chain). Disjoint regions; 8 rebases. 8's faster cadence multiplies any duplicate-effect bug, so 8 must not merge until 7's lease-owner compare-and-set and 12's fail-closed refusal are both on main. |
| 29 | 10↔2 | `src/lib/prompt.ts`, `src/lib/tools.ts` | 10 merges FIRST in wave 3 because it carries the wave's only migration (`0017_partner_send_limits`) and `/migrate-prod` must run against a quiet tree. 2 merges LAST in the wave and owns the final shape of `prompt.ts` and the agent message roles — it rebases onto the restored cap constants and must not re-introduce a hardcoded ceiling or an internal token ('blocked', 'sanctions', 'partner') into the new envelope prose, which `tests/bot-content-guard.test.ts` statically scans. |
| 30 | 10↔1 | `src/lib/daily-volume-store.ts`, `src/lib/monthly-volume-store.ts`, `src/lib/store.ts` | 1 scopes the keys by tenant (wave 1); 10 then DELETES the Redis counters entirely (no cache: `addCents` / `incrementTodayTransferCount` are removed and `getTodayCents` / `getMonthCents` / `getTodayTransferCount` become index-backed aggregates over `transfers` — Task 10 design decision 1). One rename only, owned by 1, and 1's transitional legacy dual-read (D9/D10, oldest-row rule) for the velocity/daily/monthly COUNTERS exists ONLY for the wave-1→wave-3 window; after 10 there is no Redis counter and therefore no counter dual-read. Fix 10 removes ONLY those three callers of the helper: the `conv:` (D12, 30-day TTL) and `kyc_audit:` (D10, NO TTL) dual-reads keep `src/lib/legacy-tenant.ts`, `store.legacyTenantOf` and `tests/legacy-tenant.test.ts` after fix 10 — 10 must not delete them. 10's new counter queries carry `partnerId` in the WHERE alongside phone — phone alone is not a tenant key after fix 1. |
| 31 | 10↔6 | `src/lib/pay-finalize.ts`, `src/lib/b2b-pay-finalize.ts`, `src/lib/transfer-create.ts` | 10 moves the cap check to the createTransfer chokepoint, changing the error path of six mint callers that have never seen a cap failure — so it must merge after 6 (masked-destination refusal) and 9 (FX refusal) have settled the pre-claim guard stack. 10 adds its guard to the documented order and ships the env-gated test override in the same PR or the e2e/demo fixtures break the moment `MAX_USD` returns to 2999. |
| 32 | 13↔3 | `src/app/api/pay/[transferId]/route.ts`, `src/app/pay/[transferId]/page.tsx`, `src/app/pay/b2b/[invoiceId]/page.tsx` | 13 merges dead last. Its edit is a headers-based, FAIL-OPEN throttle at the very top of the pay server components (before any `getTransfer`/`getDraft` read) plus collapsing the b2b page's four state-leaking messages into one — purely additive on top of 3's status guard, 6's `needsBankDetails` logic and 12's route changes. Never fail closed: a Redis outage must not 429 a paying customer. |
| 33 | 13↔1 | `src/lib/id.ts` (`newTransferId`, 23 call sites) | No contract change (ids are opaque text PKs; grep shows zero format validators), but the value shape changes for 23 call sites including `partner-api-service`'s `deps.genId` and `pay-finalize`/`b2b-pay-finalize`'s claim-first `candidateId`. 13 goes last so it rebases onto the final mint code, keeps generation exactly once per attempt before `idem.claim`, and the post-deploy smoke exercises one freshly minted 22-char pay link end to end through every wave-1..3 change. |

## Migration Gate

Four migrations, pre-numbered before any branch was cut (journal at idx 13, `0013_glamorous_the_call`, per `drizzle/meta/_journal.json`):

1. `0014_outbox_lease` — task 7, wave 1.
2. `0015_tenant_scoped_customers` — task 1, wave 1.
3. `0016_scrub_outbox_secrets` — task 11, wave 2 (data-only; deliberately run AFTER the code deploy and after the outbox backlog is drained — verify with `scripts/outbox-status.ts` first).
4. `0017_partner_send_limits` — task 10, wave 3.

**Gate procedure — repeat for each migration, never batched:** merge the owning PR → `set -a; source .env.local; set +a; npx drizzle-kit migrate` against prod Neon immediately → verify the post-deploy `smoke.yml` run for that SHA is green (`post-merge-check`) → only then open/merge the next PR in the sequence. Never let two unapplied migrations be in flight at once (drizzle selects explicit column lists, so a queued-but-unapplied migration breaks every query touching the altered table — see the 2026-06-11 dashboard outage in CLAUDE.md). `component/<name>` branches are re-synced to `main` after each merge so the next worktree's rebase starts from applied, not merely merged, state.

## Task Execution Order

Tasks are sequenced 7 → 1 → 3 → 9 → 6 → 5 → 11 → 10 → 4 → 12 → 2 → 8 → 13 (wave order, then the intra-wave merge order fixed by the conflict rulings above). Each task section below is verbatim from its source brief.


### Wave 1

---

### Task 7: Add outbox lock leases and timeouts on every outbound fetch

**Component / branch / model:** `outbox-worker` — cut `fix/outbox-worker/outbox-lease-and-fetch-timeouts` from `origin/component/outbox-worker` in a worktree OUTSIDE iCloud (`git worktree add ~/dev/wt/outbox-worker origin/component/outbox-worker`). Model: **Fable 5.1** (money path + outbox + migration). Wave 1, merged FIRST in the program; migration number pre-assigned **0014** (journal is at idx 13 / `0013_glamorous_the_call`, verified in `drizzle/meta/_journal.json`).

**Findings closed:** vercel-04, neon-04, obs-03, money-03, rail-09, whatsapp-06, bot-03, obs-09, rail-08, bot-04.

**Scope rulings from the sequencing pass (state both in the PR description):**
- `src/lib/rate.ts` (Frankfurter fetch) is **dropped from this task** — fix 9 owns `rate.ts` outright including `AbortSignal.timeout(5000)`. Nothing in this task touches `rate.ts` or `tests/rate.test.ts`.
- This task OWNS `src/lib/outbox-worker.ts`, `src/db/repos/outbox-repo.ts`, the `SweepResult`/`OpsSnapshot` shapes and `WorkerDeps`. Fixes 1, 3, 4, 8, 11, 12 rebase onto it.
- The HttpPaymentProvider test the brief lists under `tests/payment-provider.test.ts` actually lives in **`tests/http-payment-provider.test.ts:77`** (`describe('HttpPaymentProvider.initiateTransfer …')`); `tests/payment-provider.test.ts` covers only `MockPaymentProvider` and only needs its `claimBatch` expectation re-read (line 81: a delayed row is still NOT claimable — unchanged, the reclaim disjunct only matches `status = 'processing'`).
- Free-tier amendment (a): the drain stays on the GitHub Actions 5-minute heartbeat (`.github/workflows/worker-heartbeat.yml:9`). No cron changes here (fix 8). Amendment (b): Ollama/Kimi stays; the LLM budget below is sized for `chatWithRetry`'s one retry (`src/lib/agent.ts:76-87`).

**Ground truth read for this plan (cite in the PR):**
- `src/db/repos/outbox-repo.ts:61-73` — `claimBatch` selects `status IN ('pending','failed')` only; `:89-91` `markDone(id)`; `:97-109` `markFailed(id, attempts, error)`; `:145-150` `retryDead`.
- `src/db/schema.ts:501-528` — `outbox` table; `:524-526` the `outbox_drain` partial index `WHERE status IN ('pending','failed')` (same predicate at `drizzle/0000_workable_giant_girl.sql:236`).
- `src/lib/outbox-worker.ts:167-174` (settlement.instruct POST), `:198-205` (rail.callback POST), `:239-246` (non-custodial reverse POST), `:383-415` `drainOnce`.
- `src/lib/reconcile.ts:28-36` `SweepResult` (new fields optional per the comment at `:32-33`), `:170-193` `OpsSnapshot`/`getOpsSnapshot`.
- `src/app/api/worker/route.ts:27` `maxDuration = 60`, `:36` `TIME_BUDGET_MS = 45_000`, `:77` the `SweepResult` zero-literal, `:99-106` the claim loop.
- `src/lib/ollama.ts:8-20` bare fetch. `src/lib/whatsapp.ts:179-190` `authedJsonInit`, `:203-224` `postWithBackoff` (the only fetch for `sendText`/`sendTemplate`/`sendTemplateWithButton`/`sendAuthTemplate`, at `:211`), `:474` `sendInteractive` fetch, `:528` `sendCtaUrl` fetch. `src/lib/providers/http-payment-provider.ts:195-202` inline instruct fetch. `src/lib/outbox.ts:13-18` self-poke fetch.
- `src/app/admin-dashboard/ops/page.tsx:40-42` platform-only gate, `:45` snapshot, `:57-61` `healthy`, `:76-113` stat-card grid. `src/app/admin-dashboard/ops/actions.ts:44-55` `dismissDeadAction` calls `markDone(id)` with NO lease (owner param must stay optional).
- `scripts/outbox-status.ts:55-59` — the "reclaimed on the next drain" label is currently FALSE; `:83-85` `needsHuman`.
- `src/app/docs/page.tsx:187-216` — §3 Settlement instructions; the ack paragraph at `:211-215`.
- `tests/helpers-db.ts:26` migrates PGlite from `./drizzle` (journal-driven; 0002/0003/0004 ship without snapshots, so a hand-written 0014 needs only the SQL file + journal entry).
- `AbortSignal.timeout(milliseconds)` — `node_modules/typescript/lib/lib.dom.d.ts:2793`; `AbortSignal.any(signals)` — `lib.dom.d.ts:2787` (both re-read against the MATERIALIZED file, TypeScript 5.9.3 — `ls -lO node_modules/typescript/lib/lib.dom.d.ts` shows no `dataless` flag; cite these two lines in the PR, never from memory) (tsconfig `lib` includes `dom`); runtime is Node 26 (`node --version` → v26.8.1), where `fetch` rejects with a `DOMException` whose `name` is `'TimeoutError'` (Node docs, `AbortSignal.timeout(delay)`). Tests simulate it with `Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })`.
- Drizzle `update(...).returning(...)` exists on `PgUpdateBase` (`node_modules/drizzle-orm/pg-core/query-builders/update.d.ts:24-25`); `and`/`inArray` at `node_modules/drizzle-orm/sql/expressions/conditions.d.ts:63,170`.

**Budget constants (single sources, no magic numbers at call sites):**

| constant | value | defined in | rationale |
|---|---|---|---|
| `LEASE_MS` | 300 000 (5 min) | `outbox-repo.ts` | 5× the worker's hard ceiling (`maxDuration = 60`); a live worker can NEVER lose a row it is still allowed to be running |
| `RAIL_TIMEOUT_MS` | 15 000 | `http-payment-provider.ts` (worker imports it) | rail ack budget; documented in the partner contract (rail-08) |
| `META_TIMEOUT_MS` | 10 000 | `whatsapp.ts` | Graph API budget; fresh signal PER attempt inside `postWithBackoff` |
| `OLLAMA_TIMEOUT_MS` | 20 000 | `ollama.ts` | ONE LLM call; `chatWithRetry` (`agent.ts:76-87`) makes up to 2 calls PER TOOL ROUND and `MAX_TOOL_ROUNDS = 6` (`agent.ts:24`), so a legitimate turn's worst case is 6 × 2 × 20 s = 240 s — far past any row budget. The row deadline, not the LLM timeout, is therefore the binding bound on `agent.turn`, and it is enforced by an AbortSignal the agent honours between rounds (see `ROW_DEADLINE_MS`) |
| `ROW_DEADLINE_MS` | 40 000 | `outbox-worker.ts` | hard per-row wall clock = `rounds × (LLM timeout × retries)` truncated to what fits `TIME_BUDGET_MS`: the worker passes `AbortSignal.timeout(rowDeadlineMs)` into `runAgentTurn`, which threads it into every `deps.chat` call and checks `signal.aborted` before each tool round, so an `agent.turn` STOPS at the deadline and answers with the agent's own fallback line. A `RowDeadlineError` is RETRYABLE for every other kind (money handlers are bounded by `RAIL_TIMEOUT_MS` far inside it; `ticket.triage` is one LLM call); for `agent.turn` it is TERMINAL (dead + the deduped `dead:<id>` alert) because a retry would re-run the same inbound message concurrently with an abandoned turn that may still be executing tools |
| `POKE_TIMEOUT_MS` | 10 000 | `outbox.ts` | frees the poking function's `after()` slot; `/api/worker` never reads `req.signal`, so aborting the poke does not stop the drain |
| `STALE_LOCK_MINUTES` | 15 | `reconcile.ts` | a lease expired >15 m and STILL unreclaimed means the drain itself is not running |

**Money-path invariants this task must hold (CLAUDE.md "Architecture spine"):**
1. Durability: the lease changes WHO runs a row and WHEN — never whether the effect is recorded. No enqueue site changes.
2. At-least-once + idempotent handlers: a reclaim re-runs a handler, so the existing guards stay untouched: `dedupe_key` UNIQUE, write-once `setProviderRef` (`outbox-worker.ts:187`), guarded `updateRefund` (`:263-277`), forward-only transfer states, "gone ⇒ no-op" early returns (`:153`, `:214`, `:232`, `:294`).
3. `attempts` still increments on a reclaim (claim = `attempts + 1` regardless of the row's prior status) → a poison row still dies at `MAX_ATTEMPTS = 8` with EXACTLY ONE `dead:<id>` alert. A lease never resets `attempts`.
4. No double execution of a LIVE row: `LEASE_MS` ≫ `maxDuration`, and `markDone`/`markFailed` are compare-and-set on `lease_owner` — a resurrected old worker's outcome is refused (`false` / `'lost'`).
5. A timeout is a RETRYABLE throw riding `2^attempts` backoff — never `markDone`, never an immediate dead letter — with ONE deliberate exception: a `RowDeadlineError` on an `agent.turn` row is TERMINAL (marked dead + the existing deduped `dead:<id>` alert). An agent turn is NOT idempotent by construction — `send_approve_picker` creates a draft + sends a cta_url card, `create_transfer` / `create_schedule` mint fresh ids with no idempotency key, and the final `sendText` has no dedupe key — so a retry that runs concurrently with an abandoned turn would double-mint, double-send and interleave conversation-history writes. The abandoned turn itself is stopped by the AbortSignal (7.2) and its late `sendText` is skipped.
6. The stale-lock alert is itself an outbox row; the ops page and `scripts/outbox-status.ts` stay the out-of-band read.
7. New columns, alert text, ops card and script print ids/kinds/timestamps only — never `payload` (fix 11 scrubs creds from payloads; this task must not widen exposure).
8. The ops page stays platform-staff-only (`page.tsx:40-42`).
9. Migration is MANUAL: `set -a; source .env.local; set +a; npx drizzle-kit migrate` the moment this merges; an unapplied 0014 breaks EVERY outbox query (drizzle selects explicit column lists).

**Files:**
- Create: `drizzle/0014_outbox_lease.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 14)
- Modify: `src/db/schema.ts` (outbox block, lines 501-528)
- Modify: `src/db/repos/outbox-repo.ts` (`LEASE_MS`, `claimBatch`, `markDone`, `markFailed`, `retryDead`, new `releaseUnstarted`, `listStaleProcessing`)
- Modify: `src/lib/outbox-worker.ts` (`ROW_DEADLINE_MS`, `RowDeadlineError`, `DrainOptions`, `DrainResult.released`, three `signal:` additions, lease-aware `drainOnce`, `WorkerDeps.runAgentTurn` gains a trailing options object `{ signal }`, `agent.turn` is terminal on deadline and skips a late `sendText`)
- Modify: `src/lib/agent.ts` (`AgentDeps.chat(messages, tools, opts?: { signal? })`, `runAgentTurn(phone, text, turn, opts?: { signal? })`, `signal.aborted` check before every tool round, abort ⇒ `FALLBACK_REPLY`)
- Modify: `src/lib/reconcile.ts` (`STALE_LOCK_MINUTES`, `SweepResult.staleLocks?`, stale-lock sweep, `OpsSnapshot.staleLocks`)
- Modify: `src/app/api/worker/route.ts` (start cutoff, `stopAfter`, `released` in the response; `runAgentTurn` wiring passes `opts.signal` through)
- Modify: `src/lib/ollama.ts` (`OLLAMA_TIMEOUT_MS`, signal, clear timeout error; `chat(messages, tools, opts?: { signal? })` combines the caller's signal with its own timeout via `AbortSignal.any`)
- Modify: `src/lib/whatsapp.ts` (`META_TIMEOUT_MS`, `graphFetch`, three call sites)
- Modify: `src/lib/providers/http-payment-provider.ts` (`RAIL_TIMEOUT_MS`, signal)
- Modify: `src/lib/outbox.ts` (`POKE_TIMEOUT_MS`, signal)
- Modify: `scripts/outbox-status.ts` (honest stale-lock sections, `needsHuman`)
- Modify: `src/app/admin-dashboard/ops/page.tsx` ("Stale locks" card + table, `healthy`)
- Modify: `src/app/docs/page.tsx` (rail ack-deadline requirement, rail-08)
- Test: `tests/pg-repos.test.ts` (outbox-repo describe: +5 tests)
- Test: `tests/outbox-worker.test.ts` (+2 describes: lease reclaim / outbound deadlines; the reclaim describe includes the two `agent.turn` deadline cases — terminal, and "late resolve never sends")
- Test: `tests/agent.test.ts` (+1 describe: an aborted turn stops between tool rounds and mints nothing twice)
- Test: `tests/reconcile.test.ts` (add `staleLocks: 0` to ALL FIVE whole-shape `toEqual` literals at :62, :78, :87, :109, :128; +1 describe; +assertion in `getOpsSnapshot`)
- Test: `tests/ollama.test.ts` (+3: timeout signal, clear error, caller signal combined)
- Test: `tests/whatsapp.test.ts` (+4)
- Test: `tests/http-payment-provider.test.ts` (+1)

---

#### Step 7.0 — Pre-flight (no code)

1. Worktree + branch:
   ```bash
   git fetch origin
   git worktree add ~/dev/wt/outbox-worker origin/component/outbox-worker
   cd ~/dev/wt/outbox-worker && git checkout -b fix/outbox-worker/outbox-lease-and-fetch-timeouts
   npm ci
   ```
2. Re-verify the two facts the whole task rests on (paste the output into the PR):
   ```bash
   grep -n "status IN ('pending','failed')" src/db/repos/outbox-repo.ts     # expect line 67
   grep -rnE "AbortSignal|AbortController|signal:" src/                      # expect NO matches
   tail -8 drizzle/meta/_journal.json                                        # expect idx 13, tag 0013_glamorous_the_call
   ```
3. Baseline: `npx vitest run tests/pg-repos.test.ts tests/outbox-worker.test.ts tests/reconcile.test.ts tests/ollama.test.ts tests/whatsapp.test.ts tests/http-payment-provider.test.ts tests/payment-provider.test.ts` → all green before any edit.

---

#### Step 7.1 — Repo: lease columns, reclaim, compare-and-set (TDD on real Postgres)

**1. Write the failing tests.** In `tests/pg-repos.test.ts`, ADD one import line (line 2 is `import { freshDb, seedPartner } from './helpers-db';` — keep it; the `sql` import is a NEW line inserted after it, not a rewrite of line 2), change the import at line 14, and append five tests INSIDE `describe('outbox-repo (durability backbone)')` (after the `delayed effects` test at line 261-265):

```ts
// NEW line after line 2 (`import { freshDb, seedPartner } from './helpers-db';` stays as is)
import { sql } from 'drizzle-orm';
// line 14 →
import { createOutboxRepo, MAX_ATTEMPTS, LEASE_MS } from '@/db/repos/outbox-repo';
```

```ts
  // ── Lease reclaim (Phase 1 fix 7: money-03 / neon-04 / vercel-04) ──────────
  // Fixture rule (CLAUDE.md): age leases with SQL-relative time, never a date.

  it('claimBatch RECLAIMS a processing row whose lease has expired and increments attempts', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('settlement.instruct', { transferId: 'tr_1' });
    const [claimed] = await r.claimBatch(1, 'w_dead');
    expect(claimed.attempts).toBe(1);
    expect(claimed.leaseOwner).toBe('w_dead');
    expect(claimed.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 60_000);
    // w_dead was killed by the 60s function ceiling and never comes back.
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '10 minutes' WHERE id = ${claimed.id}`);
    const [reclaimed] = await r.claimBatch(1, 'w_new');
    expect(reclaimed.id).toBe(claimed.id);
    expect(reclaimed.status).toBe('processing');
    expect(reclaimed.attempts).toBe(2); // a reclaim IS a retry — attempts keeps climbing
    expect(reclaimed.leaseOwner).toBe('w_new');
  });

  it('claimBatch does NOT reclaim a processing row whose lease is still live', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('whatsapp.text', { to: 'x' });
    expect(await r.claimBatch(1, 'w_alive')).toHaveLength(1);
    expect(await r.claimBatch(1, 'w_other')).toHaveLength(0);
  });

  it('a reclaimed row still dies at MAX_ATTEMPTS — the lease never resets the death ceiling', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('rail.callback', { reference: 'tr_1' });
    const [row] = await r.claimBatch(1, 'w1');
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, lease_until = now() - interval '1 minute' WHERE id = ${row.id}`,
    );
    const [reclaimed] = await r.claimBatch(1, 'w2');
    expect(reclaimed.attempts).toBe(MAX_ATTEMPTS);
    expect(await r.markFailed(reclaimed.id, reclaimed.attempts, 'still hung', 'w2')).toBe('dead');
    expect(await r.listDead()).toHaveLength(1);
  });

  it("markDone/markFailed from a worker that lost its lease cannot clobber the new owner's claim", async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('settlement.instruct', { transferId: 'tr_1' });
    const [row] = await r.claimBatch(1, 'w_old');
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '1 minute' WHERE id = ${row.id}`);
    const [stolen] = await r.claimBatch(1, 'w_new');
    expect(stolen.leaseOwner).toBe('w_new');
    // The resurrected old worker finishes late: both of its outcomes are refused.
    expect(await r.markDone(row.id, 'w_old')).toBe(false);
    expect(await r.markFailed(row.id, row.attempts, 'late failure', 'w_old')).toBe('lost');
    const res = await db.execute(sql`SELECT status, lease_owner FROM outbox WHERE id = ${row.id}`);
    const [{ status, lease_owner }] = (res as unknown as { rows: Array<{ status: string; lease_owner: string }> }).rows;
    expect(status).toBe('processing');
    expect(lease_owner).toBe('w_new');
    // The live owner's outcome lands and clears the lease.
    expect(await r.markDone(row.id, 'w_new')).toBe(true);
    // An owner-less markDone (staff "dismiss" on a dead row, ops/actions.ts:47) stays legal.
    await db.execute(sql`INSERT INTO outbox (kind, payload, status) VALUES ('whatsapp.text', '{}'::jsonb, 'dead')`);
    const [dead] = await r.listDead();
    expect(await r.markDone(dead.id)).toBe(true);
  });

  it("releaseUnstarted hands back only the OWNER's untouched rows and refunds the claim's attempt", async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('whatsapp.text', { to: 'a' });
    await r.enqueue('whatsapp.text', { to: 'b' });
    const [ra, rb] = await r.claimBatch(2, 'w1');
    expect(await r.releaseUnstarted([ra.id, rb.id], 'w_other')).toBe(0); // not the owner
    expect(await r.releaseUnstarted([ra.id], 'w1')).toBe(1);
    expect(await r.countPending()).toBe(1);
    const [again] = await r.claimBatch(1, 'w2');
    expect(again.id).toBe(ra.id);
    expect(again.attempts).toBe(1); // the release refunded the never-run attempt; this claim re-charges it
  });
```

**2. Run — expect failure:**
```bash
npx vitest run tests/pg-repos.test.ts -t "outbox-repo"
```
Expected: the new tests fail — first with `error: column "lease_until" of relation "outbox" does not exist` (PGlite), then (after the migration lands) `TypeError: r.releaseUnstarted is not a function` and `expected 0 to be 1` on the reclaim.

**3. Implement.**

3a. Create `drizzle/0014_outbox_lease.sql` (statement-breakpoint between EVERY statement — that is how `drizzle-orm/pglite/migrator` and `drizzle-kit migrate` split the file):

```sql
ALTER TABLE "outbox" ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "lease_owner" text;
--> statement-breakpoint
DROP INDEX "outbox_drain";
--> statement-breakpoint
CREATE INDEX "outbox_drain" ON "outbox" USING btree ("status","next_attempt_at") WHERE "outbox"."status" IN ('pending','failed','processing');
--> statement-breakpoint
CREATE INDEX "outbox_lease" ON "outbox" USING btree ("lease_until") WHERE "outbox"."status" = 'processing';
--> statement-breakpoint
UPDATE "outbox" SET "lease_until" = coalesce("locked_at", now()) + interval '5 minutes', "lease_owner" = "locked_by" WHERE "status" = 'processing';
```
The trailing backfill makes `lease_until` total for every `processing` row, so the two rows stranded in prod (ids 154 and 2282, both `agent.turn`) become claimable on the first drain after the migration. The `+ interval '5 minutes'` (= `LEASE_MS`) matters: a bare `coalesce(locked_at, now())` would make a row an OLD worker is processing at migration time reclaimable IMMEDIATELY (a live double-run); the stranded July/September rows are still years past their lease either way. Rows the OLD code claims in the migrate→deploy window get `lease_until` NULL (old code never sets it) and `lease_until < now()` never matches NULL — Step 7.10.3 re-runs this UPDATE once after the deploy is Ready to catch them. `CREATE INDEX CONCURRENTLY` is unavailable inside drizzle's migration transaction; acceptable — `outbox` is ~370 rows.

3b. Append to `drizzle/meta/_journal.json` `entries` (after the idx-13 entry; `when` must exceed 1783009260616):
```json
    {
      "idx": 14,
      "version": "7",
      "when": 1789508339133,
      "tag": "0014_outbox_lease",
      "breakpoints": true
    }
```

3c. `src/db/schema.ts` — replace the `outbox` block (lines 501-528) with:
```ts
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'), // pending|processing|done|failed|dead
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    // Lease (Phase 1 fix 7): a 'processing' row is owned by lease_owner until
    // lease_until; past that, claimBatch may RECLAIM it (the owner died mid-row).
    // markDone/markFailed compare-and-set on lease_owner so a resurrected old
    // worker can never overwrite the new owner's outcome.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbox_dedupe').on(t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
    // 'processing' is IN the predicate now: an expired lease must be reachable
    // by the drain query (the old two-state predicate is exactly why a row
    // interrupted by the 60s ceiling was stranded forever — money-03).
    index('outbox_drain')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending','failed','processing')`),
    index('outbox_lease').on(t.leaseUntil).where(sql`${t.status} = 'processing'`),
  ],
);
```

3d. `src/db/repos/outbox-repo.ts` — imports, constants and the changed/new methods (everything not shown is unchanged):

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
```
```ts
export const MAX_ATTEMPTS = 8;
/**
 * Lease length for a claimed row. 5× the worker's hard ceiling (maxDuration =
 * 60 at src/app/api/worker/route.ts:27): a worker that is still legally
 * running can NEVER have its row stolen. A row whose lease has expired was
 * abandoned (function killed mid-row) and is reclaimed by the next claimBatch —
 * attempts++ as on any retry, so a poison row still dies at MAX_ATTEMPTS.
 */
export const LEASE_MS = 5 * 60_000;
```
```ts
    /**
     * Atomically claim up to `limit` rows (SKIP LOCKED — drain-safe):
     *   • due rows ('pending'/'failed' with next_attempt_at <= now()), and
     *   • ABANDONED rows ('processing' whose lease_until has passed).
     * Both paths charge one attempt and take a fresh lease for `workerId`.
     */
    async claimBatch(limit: number, workerId: string, leaseMs = LEASE_MS): Promise<OutboxRow[]> {
      const leaseSec = Math.ceil(leaseMs / 1000);
      const rows = await db.execute(sql`
        UPDATE outbox SET status = 'processing', locked_at = now(), locked_by = ${workerId},
                          lease_until = now() + make_interval(secs => ${leaseSec}),
                          lease_owner = ${workerId},
                          attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox
          WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
             OR (status = 'processing' AND lease_until < now())
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `);
      return (rows as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
        id: Number(r.id),
        kind: String(r.kind),
        payload: r.payload,
        status: String(r.status),
        attempts: Number(r.attempts),
        nextAttemptAt: new Date(String(r.next_attempt_at)),
        lockedAt: r.locked_at ? new Date(String(r.locked_at)) : null,
        lockedBy: (r.locked_by as string) ?? null,
        leaseUntil: r.lease_until ? new Date(String(r.lease_until)) : null,
        leaseOwner: (r.lease_owner as string) ?? null,
        lastError: (r.last_error as string) ?? null,
        dedupeKey: (r.dedupe_key as string) ?? null,
        createdAt: new Date(String(r.created_at)),
      })) as OutboxRow[];
    },

    /**
     * Terminal success. With `owner`, compare-and-set on lease_owner: a worker
     * whose lease was reclaimed gets `false` and must NOT treat the row as its
     * own. Without `owner` (staff dismiss of a dead row) it is unconditional.
     */
    async markDone(id: number, owner?: string): Promise<boolean> {
      const rows = await db
        .update(outbox)
        .set({ status: 'done', leaseUntil: null, leaseOwner: null })
        .where(owner === undefined ? eq(outbox.id, id) : and(eq(outbox.id, id), eq(outbox.leaseOwner, owner)))
        .returning({ id: outbox.id });
      return rows.length > 0;
    },

    /**
     * Record a failure: backoff-and-retry until MAX_ATTEMPTS, then 'dead'.
     * Returns the resulting status so the worker can fire the ops alert on
     * death — or 'lost' when `owner` no longer holds the lease (the new owner's
     * outcome wins; nothing was written).
     */
    async markFailed(
      id: number,
      attempts: number,
      error: string,
      owner?: string,
    ): Promise<'failed' | 'dead' | 'lost'> {
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      const backoffSec = Math.min(2 ** attempts, 3600);
      const rows = await db
        .update(outbox)
        .set({
          status,
          lastError: error.slice(0, 1000),
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSec})`,
          leaseUntil: null,
          leaseOwner: null,
        })
        .where(owner === undefined ? eq(outbox.id, id) : and(eq(outbox.id, id), eq(outbox.leaseOwner, owner)))
        .returning({ id: outbox.id });
      return rows.length > 0 ? status : 'lost';
    },

    /**
     * OWNER-ONLY: hand back rows this worker claimed but never STARTED (the
     * invocation's start cutoff passed first). The claim's attempt is refunded
     * because the row never ran — this is not a retry. NOTE on reclaims: a row
     * whose claim in THIS batch was a reclaim of an expired lease (its previous
     * owner died mid-row) and that is then released unstarted also gets that
     * reclaim's charge refunded — by design: only GENUINE runs count toward
     * MAX_ATTEMPTS, and this worker never ran it either. The row keeps the
     * attempt its dead owner charged, so a poison row still converges on
     * MAX_ATTEMPTS through real runs. (Task 8's `reclaimed` flag lets a later
     * change exclude reclaimed rows from the refund if that ever proves
     * necessary; it is not required for correctness.)
     */
    async releaseUnstarted(ids: number[], owner: string): Promise<number> {
      if (ids.length === 0) return 0;
      const rows = await db
        .update(outbox)
        .set({
          status: 'pending',
          attempts: sql`greatest(${outbox.attempts} - 1, 0)`,
          leaseUntil: null,
          leaseOwner: null,
          lockedAt: null,
          lockedBy: null,
        })
        .where(and(inArray(outbox.id, ids), eq(outbox.status, 'processing'), eq(outbox.leaseOwner, owner)))
        .returning({ id: outbox.id });
      return rows.length;
    },

    /**
     * 'processing' rows whose lease expired more than `minutes` ago and were
     * STILL not reclaimed. The reclaim lives in claimBatch, so an expired lease
     * normally disappears within one drain; one that survives this long means
     * the drain itself is not running. Ids/kinds/timestamps only — callers must
     * never print `payload` (it may carry creds until fix 11).
     */
    async listStaleProcessing(minutes: number, limit = 100): Promise<OutboxRow[]> {
      return db
        .select()
        .from(outbox)
        .where(
          sql`${outbox.status} = 'processing' AND ${outbox.leaseUntil} < now() - make_interval(mins => ${minutes})`,
        )
        .orderBy(outbox.leaseUntil)
        .limit(limit);
    },
```
and in `retryDead` add the two lease resets:
```ts
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null, leaseUntil: null, leaseOwner: null })
```
Update the header comment block (lines 4-17) to mention the lease: `claimBatch — … also RECLAIMS 'processing' rows whose lease expired (owner died mid-row); attempts increments either way` and `markDone/markFailed — compare-and-set on lease_owner when the caller passes one`.

**Caller check (`grep -rn "markDone\|markFailed\|claimBatch" src tests`):** `src/lib/outbox-worker.ts:389,394,398` (Step 7.2 passes `workerId`); `src/app/admin-dashboard/ops/actions.ts:47` `markDone(id)` — unchanged, the owner param is optional and its `Promise<void>` → `Promise<boolean>` widening is ignored there; `tests/pg-repos.test.ts:230-264` unchanged (owner-less calls stay legal); `tests/payment-provider.test.ts:81` unchanged (a DELAYED pending row is still not claimable — the new disjunct matches only `status = 'processing'`). `OutboxRepo` structural consumers (`src/lib/providers/payment-provider.ts:7,68,117`, `src/lib/tools.ts:820` `Pick<…,'enqueue'>`, `src/app/api/copilot/ops-diagnose/route.ts:71`) only widen — `tsc` proves it.

**4. Run:**
```bash
npx vitest run tests/pg-repos.test.ts tests/payment-provider.test.ts
npx tsc --noEmit
```
Expected: all green (the five new tests pass; the four existing outbox-repo tests unchanged).

**5. Commit:**
```
feat(outbox): lease columns + reclaim of expired 'processing' rows (drizzle 0014)

claimBatch now also claims 'processing' rows whose lease_until has passed
(attempts still increments, so poison rows still die at 8); markDone/markFailed
compare-and-set on lease_owner; releaseUnstarted + listStaleProcessing for the
worker and the sweep. 0014 widens the outbox_drain partial index to include
'processing' and backfills lease_until for stranded rows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.2 — Worker: lease-aware drain, per-row deadline, rail deadline signals

**1. Write the failing tests.** In `tests/outbox-worker.test.ts` extend the `@/lib/outbox-worker` import on line 10 and insert the `RAIL_TIMEOUT_MS` import after line 13 (line 14 is blank on `main`):
```ts
import { drainOnce, ROW_DEADLINE_MS, type WorkerDeps } from '@/lib/outbox-worker';
import { RAIL_TIMEOUT_MS } from '@/lib/providers/http-payment-provider';
```
Append two describes at the end of the file:

```ts
describe('drainOnce — lease reclaim (a worker killed mid-row)', () => {
  it('a row abandoned by a dead worker is re-handled on the next drain and marked done', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    const [row] = await outbox.claimBatch(1, 'w_dead'); // w_dead never comes back
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '10 minutes' WHERE id = ${row.id}`);

    const r = await drainOnce(deps(), 'w_new');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const res = await db.execute(sql`SELECT status, attempts, lease_owner FROM outbox WHERE id = ${row.id}`);
    const [{ status, attempts, lease_owner }] =
      (res as unknown as { rows: Array<{ status: string; attempts: number; lease_owner: string | null }> }).rows;
    expect(status).toBe('done');
    expect(attempts).toBe(2); // the reclaim counted as a retry
    expect(lease_owner).toBeNull();
  });

  it('a LIVE lease is left alone — no double execution', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    await outbox.claimBatch(1, 'w_alive');
    const r = await drainOnce(deps(), 'w_other');
    expect(r.processed + r.failed + r.dead).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a NON-agent row that exceeds the per-row deadline fails RETRYABLY and does not starve the rest of the batch', async () => {
    // A hung Graph POST that ignores its own signal (the deadline is the backstop).
    sendText.mockImplementationOnce(() => new Promise<void>(() => {})); // never resolves
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'slow' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'next' });

    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ failed: 1, processed: 1, dead: 0 });
    const res = await db.execute(sql`SELECT status, last_error FROM outbox WHERE payload->>'body' = 'slow'`);
    const [{ status, last_error }] = (res as unknown as { rows: Array<{ status: string; last_error: string }> }).rows;
    expect(status).toBe('failed');
    expect(last_error).toMatch(/row deadline/);
    expect(ROW_DEADLINE_MS).toBeLessThan(45_000); // under TIME_BUDGET_MS (route.ts:36) and maxDuration
  });

  it('agent.turn receives an AbortSignal that fires BEFORE the row deadline (COOP_GRACE_MS), and a turn that honours it (fallback reply) is marked DONE with its reply SENT', async () => {
    // `runAgentTurn` is declared `vi.fn(async (..._a: unknown[]) => '')` at :39 — an implementation
    // whose 5th parameter is annotated `opts?: { signal?: AbortSignal }` does not type-check under
    // strictFunctionTypes (tsconfig includes tests/), so keep the rest-`unknown[]` shape and cast.
    runAgentTurn.mockImplementation(async (..._a: unknown[]) => {
      const opts = _a[4] as { signal?: AbortSignal } | undefined;
      expect(opts?.signal).toBeInstanceOf(AbortSignal); // 5th argument: (phone, message, turn, waCreds, opts)
      await new Promise((res) => opts!.signal!.addEventListener('abort', res, { once: true }));
      return "Sorry, I'm having trouble right now. Could you send that again?"; // the agent's own FALLBACK_REPLY on abort
    });
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'slow', turn: {} });
    // rowDeadlineMs 200 ⇒ the COOPERATIVE signal fires at max(1, 200 − COOP_GRACE_MS) = 1ms,
    // the hard race timer at 200ms. The agent returns inside that grace, so the row
    // is a normal completion even though `signal.aborted` is true — the worker
    // discriminates on the row's `abandoned` flag (set only by the race timer).
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 200 });
    expect(r).toMatchObject({ processed: 1, failed: 0, dead: 0 });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String((sendText.mock.calls[0] as unknown[])[1])).toMatch(/send that again/);
  });

  it('agent.turn that IGNORES the deadline is TERMINAL (dead + one deduped alert), never retried, and its late reply is never sent', async () => {
    // A tool hung past the signal: the handler promise is abandoned by withRowDeadline…
    let resolveLate!: (v: string) => void;
    runAgentTurn.mockImplementation(() => new Promise<string>((res) => { resolveLate = res; }));
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'slow', turn: {} });

    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1 });
    const res = await db.execute(sql`SELECT status, last_error FROM outbox WHERE kind = 'agent.turn'`);
    const [{ status, last_error }] = (res as unknown as { rows: Array<{ status: string; last_error: string }> }).rows;
    expect(status).toBe('dead'); // NOT 'failed': a retry would re-run the same inbound message beside the abandoned turn
    expect(last_error).toMatch(/row deadline/);
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:/);
    // A second drain does NOT re-run the turn (terminal), and only drains the alert.
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    await drainOnce(deps(), 'w2');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    // …and when the abandoned turn finally resolves, the worker's agent.turn branch sees the row's
    // `abandoned` flag (set by the race timer — NOT `signal.aborted`, which is also true on the
    // cooperative path above) and SKIPS sendText.
    resolveLate('late reply');
    await new Promise((res) => setTimeout(res, 10));
    expect(sendText.mock.calls.map((c) => String((c as unknown[])[1]))).not.toContain('late reply');
  });

  it('an agent.turn that could still be running at hardStopAt is RELEASED unstarted — never started, killed by the platform and re-run beside its ghost — while a money row still starts', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {} });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'fits' });
    // 10s of invocation left, 40s row deadline: the non-idempotent turn cannot fit; the send can.
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 40_000, hardStopAt: Date.now() + 10_000 });
    expect(r).toMatchObject({ processed: 1, released: 1, failed: 0, dead: 0 });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await outbox.countPending()).toBe(1); // the turn waits for the next invocation, attempt refunded
  });

  it('stopAfter RELEASES unstarted rows (owner-only, attempt refunded) instead of parking them under a 5-minute lease', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'a' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'b' });
    const r = await drainOnce(deps(), 'w1', 10, { stopAfter: Date.now() - 1 });
    expect(r).toMatchObject({ released: 2, processed: 0 });
    expect(sendText).not.toHaveBeenCalled();
    expect(await outbox.countPending()).toBe(2);
    const r2 = await drainOnce(deps(), 'w2');
    expect(r2.processed).toBe(2);
  });
});

describe('drainOnce — outbound deadlines (rail-09 / obs-03)', () => {
  const timeoutError = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  beforeEach(async () => {
    await store.saveTransfer(transferFixture());
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('settlement.instruct POSTs with an AbortSignal carrying the rail deadline', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    await drainOnce(deps(), 'w1');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    expect(RAIL_TIMEOUT_MS).toBe(15_000);
  });

  it('an aborted rail POST is a RETRYABLE failure (failed + backoff), not a dead letter on attempt 1', async () => {
    fetchFn.mockRejectedValue(timeoutError());
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0, processed: 0 });
    expect(await outbox.listDead()).toHaveLength(0);
    const res = await db.execute(sql`SELECT status, last_error, next_attempt_at FROM outbox WHERE kind = 'settlement.instruct'`);
    const [{ status, last_error, next_attempt_at }] =
      (res as unknown as { rows: Array<{ status: string; last_error: string; next_attempt_at: string }> }).rows;
    expect(status).toBe('failed');
    expect(last_error).toMatch(/aborted/i);
    expect(new Date(next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // rides the 2^attempts backoff
  });

  it('an aborted settlement.instruct never writes providerRef', async () => {
    fetchFn.mockRejectedValue(timeoutError());
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    await drainOnce(deps(), 'w1');
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBeFalsy();
  });

  it('rail.callback and the non-custodial reverse POST also carry the deadline signal', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme' });
    await store.saveTransfer({
      ...transferFixture(), fundingMethod: 'ach_pull', transferType: 'b2b',
      achTokenRef: 'ach_deadbeef', refundStatus: 'pending',
    } as Transfer);
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const call of fetchFn.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
```

**2. Run — expect failure:**
```bash
npx vitest run tests/outbox-worker.test.ts -t "lease reclaim|outbound deadlines"
```
Expected: `SyntaxError: The requested module '@/lib/outbox-worker' does not provide an export named 'ROW_DEADLINE_MS'` (and `RAIL_TIMEOUT_MS` from the provider); after stubbing the exports: `expected undefined to be an instance of AbortSignal`, `expected { processed: 0, failed: 0, … } to match object { released: 2 }`.

**3. Implement `src/lib/outbox-worker.ts`.**

Imports (lines 10-14 and 21):
```ts
import {
  buildSettlementInstruction,
  buildReverseInstruction,
  signBody,
  RAIL_TIMEOUT_MS,
} from '@/lib/providers/http-payment-provider';
…
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';
```
Right after the `WorkerDeps` interface (after line 80):
```ts
/**
 * Hard per-row wall clock. Money handlers are bounded by RAIL_TIMEOUT_MS (15s)
 * far inside this. It exists for agent.turn and ticket.triage — and the
 * honest budget arithmetic is: an agent turn may run MAX_TOOL_ROUNDS (6) tool
 * rounds, each up to 2 × OLLAMA_TIMEOUT_MS (chatWithRetry) = 40s, i.e. up to
 * 240s for a legitimate long turn. Nothing that long fits a 60s function, so
 * the deadline is enforced COOPERATIVELY: the agent.turn branch hands
 * runAgentTurn an AbortSignal that fires at (rowDeadlineMs − COOP_GRACE_MS);
 * agent.ts threads it into every deps.chat call and checks signal.aborted
 * before each tool round, so the turn ends inside the grace with the agent's
 * own FALLBACK_REPLY ("send that again") and its history saved — BEFORE the
 * race timer below gives up on the row. Must stay under TIME_BUDGET_MS (45s)
 * and maxDuration (60s) in src/app/api/worker/route.ts.
 *
 * A RowDeadlineError is RETRYABLE (markFailed + 2^attempts backoff) for every
 * kind EXCEPT agent.turn, where it is TERMINAL (dead + the deduped dead:<id>
 * alert). Reason: withRowDeadline ABANDONS the handler promise, and an agent
 * turn is not idempotent — send_approve_picker creates a draft + sends a
 * cta_url card, create_transfer/create_schedule mint fresh ids with no
 * idempotency key, sendText has no dedupe key — so a retry running beside a
 * turn that ignored its signal (a hung tool) would double-mint and double-send.
 * The abandoned turn's late reply is dropped by the `abandoned` check in `handle`.
 */
export const ROW_DEADLINE_MS = 40_000;

/**
 * Cooperative grace: the signal a handler receives fires THIS much BEFORE the
 * row's hard deadline. If both fired at the same instant, `signal.aborted`
 * would be true on the cooperative path too (the agent's catch does
 * saveConversation I/O before returning FALLBACK_REPLY), so the fallback would
 * always arrive after the race lost — every deadline terminal, no fallback
 * ever sent. 5s covers the agent's catch path with margin.
 */
export const COOP_GRACE_MS = 5_000;

/**
 * The per-row signal handed to `handle`: an AbortSignal that fires at
 * (deadline − COOP_GRACE_MS) for handlers that can stop cooperatively, plus
 * `abandoned`, set by withRowDeadline ONLY when ITS timer won the race. That
 * flag — never `.aborted` — is the discriminator for dropping a late reply:
 * `.aborted` alone means "stop now; your reply still counts".
 */
export type RowSignal = AbortSignal & { abandoned: boolean };

function newRowSignal(rowDeadlineMs: number): RowSignal {
  const coopMs = Math.max(1, rowDeadlineMs - COOP_GRACE_MS); // tests shrink rowDeadlineMs; never a non-positive timeout
  return Object.assign(AbortSignal.timeout(coopMs), { abandoned: false });
}

export class RowDeadlineError extends Error {
  constructor(ms: number) {
    super(`outbox row deadline exceeded (${ms}ms)`);
    this.name = 'RowDeadlineError';
  }
}

/** Kinds whose handler is NOT idempotent: a deadline is terminal, never a retry. */
const TERMINAL_ON_DEADLINE: ReadonlySet<string> = new Set(['agent.turn']);

/**
 * Race `work` against the row deadline. The handler already holds `signal`
 * (cooperative — it fired COOP_GRACE_MS earlier); the timer here is the
 * backstop for handlers that ignore it, and it marks the row `abandoned` when
 * it fires so a late completion of the abandoned promise can be told apart
 * from a cooperative one that finished inside the grace.
 */
async function withRowDeadline<T>(work: Promise<T>, ms: number, signal: RowSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      signal.abandoned = true;
      reject(new RowDeadlineError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

`WorkerDeps.runAgentTurn` (lines 56-61) gains a trailing OPTIONS object (an object, not a positional, so Task 1 can add `routedPartnerId` to it without another arity change):
```ts
  runAgentTurn: (
    phone: string,
    message: string,
    turn: TurnContext,
    waCreds?: WaCreds,
    /** Cooperative row deadline (fix 7) — the agent stops between tool rounds when it fires. Task 1 adds `routedPartnerId` here. */
    opts?: { signal?: AbortSignal },
  ) => Promise<string>;
```
`handle` gains a third parameter `signal: RowSignal` (drainOnce below creates one per row; every later task that names `handle`'s signature — Task 1's `agent.turn` edit, Task 11's `handle(deps, row, signal, partner)`, Task 8 — keeps this parameter and its `RowSignal` type), and the `agent.turn` case (lines 353-368) becomes:
```ts
    case 'agent.turn': {
      const phone = str(p.phone);
      const routedPartnerId = str(p.routedPartnerId);
      const waCreds = routedPartnerId
        ? (await partnerContext(deps, routedPartnerId)).waCreds
        : undefined;
      const reply = await deps.runAgentTurn(
        phone,
        str(p.messageText),
        (p.turn ?? {}) as TurnContext,
        waCreds,
        { signal },
      );
      // A turn that outlived its HARD deadline was ABANDONED by withRowDeadline
      // and the row is already dead — never send its late reply (a second
      // customer message for the same inbound). The COOPERATIVE path is not
      // abandoned: the agent saw `signal.aborted` at (deadline − COOP_GRACE_MS),
      // returned FALLBACK_REPLY and saved history inside the grace — but
      // `signal.aborted` is true there too, so the discriminator is `abandoned`
      // (set only by the race timer), never `aborted`.
      if (signal.abandoned) {
        logWarn('worker.agent', 'agent.turn reply dropped: row deadline already passed', { id: row.id, kind: row.kind });
        return;
      }
      if (reply.trim()) await deps.sendText(phone, reply, waCreds);
      return;
    }
```
(`logWarn` fields are ids/kinds only — never the phone or the reply.)

`src/app/api/worker/route.ts:56-71` — the `runAgentTurn` wiring becomes `runAgentTurn: async (phone, message, turn, waCreds, opts) => { … return agent.runAgentTurn(phone, message, turn, { signal: opts?.signal }); }`.

`src/lib/agent.ts` — `AgentDeps.chat` becomes `chat: (messages: ChatMessage[], tools: ChatTool[], opts?: { signal?: AbortSignal }) => Promise<ChatMessage>;` (every existing test double `async (messages) => …` / `vi.fn()` keeps compiling — fewer params are assignable). `runAgentTurn(phone, incomingText, turn = { isNewConversation: false }, opts: { signal?: AbortSignal } = {})`; `completeTurn` receives `opts.signal`; `chatWithRetry(messages, tools, signal)` passes `{ signal }` to `deps.chat` and does NOT retry when `signal?.aborted` (the retry would be a second 20s call past the deadline). At the top of every tool round (`for (let round = 0; …)`, line 161) insert:
```ts
      // Cooperative row deadline (fix 7): the worker aborts this signal at
      // ROW_DEADLINE_MS. Stop BEFORE starting another LLM call / tool round so
      // no tool runs after the worker has given up on us; the catch in
      // runAgentTurn turns this into FALLBACK_REPLY with history preserved.
      if (signal?.aborted) throw new Error('agent turn aborted: row deadline');
```
and the same check immediately before `executeTool(...)` inside the tool-calls loop (a round's tool list is executed sequentially; an abort mid-list must not start the next tool). `runAgentTurn`'s existing `catch` (line 102-109) already saves history and returns `FALLBACK_REPLY` — no change. **Test (`tests/agent.test.ts`, new describe `'row deadline (fix 7)'`, appended at the end of the file; uses the file's module-level `db`, `PHONE`, `extraDeps`, `freshScheduleStore` and its `ChatMessage` type import):** two things make this deterministic — (a) the round-0 `create_transfer` call carries FULL legacy explicit args: with no `buttonTap.draftId` the tool takes the explicit-args path (`src/lib/tools.ts:1158-1164`, `:1268-1330`) and REFUSES on a missing `recipient_phone` (the existing test at `tests/agent.test.ts:735-759` passes `{}` and asserts ZERO transfers — the opposite of what this test needs); (b) there is NO timer race against the PGlite mint: the SECOND `chat` double aborts the controller ITSELF and throws the `AbortError`, exactly what `ollama.chat` does when the caller's signal fires mid-fetch. (A `setTimeout(() => ctrl.abort(), 20)` would flake: if round 0 — FX stub + sanctions + insert — took >20 ms the round-1 `if (signal?.aborted) throw` would fire BEFORE the second `chat`, and "chat called exactly twice" would fail.)

```ts
describe('row deadline (fix 7)', () => {
  it('a turn whose second tool round is in flight at the deadline stops, answers with the fallback, and mints nothing twice', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const deps = extraDeps(redis, store);
    const now = new Date().toISOString();
    await deps.customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US',
      partnerId: 'default', optInAt: now, createdAt: now, updatedAt: now,
    });
    const ctrl = new AbortController();
    const chat = vi.fn(async (_messages: ChatMessage[], _tools: unknown, opts?: { signal?: AbortSignal }): Promise<ChatMessage> => {
      if (chat.mock.calls.length === 1) {
        // Round 0: the model mints with FULL legacy explicit args (no buttonTap ⇒
        // the explicit-args path; an empty payload would refuse and mint nothing).
        return {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: {
            name: 'create_transfer',
            arguments: JSON.stringify({
              recipient_name: 'Mom', recipient_phone: '919876543210', amount_usd: 50,
              payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
            }),
          } }],
        };
      }
      // Round 1: the worker's row deadline fires WHILE this LLM call is in flight.
      // Deterministic — no timer: this double aborts the caller's signal itself and
      // throws the same AbortError ollama.chat raises for a caller abort.
      expect(opts?.signal).toBe(ctrl.signal); // the agent threads the signal into every deps.chat call
      ctrl.abort();
      throw Object.assign(new Error('Ollama request aborted by the caller (row deadline)'), { name: 'AbortError' });
    });
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(redis), draftStore: createDraftStore(redis), ...deps, chat,
    });

    const reply = await agent.runAgentTurn(PHONE, 'send $50 to Mom', { isNewConversation: false }, { signal: ctrl.signal });

    expect(reply).toBe("Sorry, I'm having trouble right now. Could you send that again?"); // FALLBACK_REPLY (agent.ts:25-26)
    expect(await store.listTransfers()).toHaveLength(1); // round 0 minted EXACTLY once and is never re-run
    expect(chat).toHaveBeenCalledTimes(2); // no chatWithRetry second call after the abort
    const saved = await store.getConversation(PHONE); // history preserved by runAgentTurn's catch
    expect(saved.some((m) => m.role === 'user' && m.content === 'send $50 to Mom')).toBe(true);
    expect(saved.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0)).toBe(true);
    expect(saved.some((m) => m.role === 'tool')).toBe(true); // the round-0 tool result
  });
});
```
(Task 1 Step 6.1 later rewrites this test's `store.getConversation(PHONE)` to `getConversation('default', PHONE)` — D12.) Run: `npx vitest run tests/agent.test.ts -t "row deadline"` → RED before the agent.ts edit (`runAgentTurn` ignores the 4th argument, `chat` receives no `opts`, so `expect(opts?.signal).toBe(ctrl.signal)` fails), GREEN after.
The three POSTs (lines 167-174, 198-205, 239-246) each gain one line after `body:`:
```ts
        body: rawBody,
        signal: AbortSignal.timeout(RAIL_TIMEOUT_MS), // rail-09: a hung rail is a RETRYABLE failure, never a stuck row
```
(`body: callbackBody,` at :204 gets the same `signal:` line.)

Replace `DrainResult` + `drainOnce` (lines 376-415) with:
```ts
export interface DrainResult {
  processed: number;
  failed: number;
  dead: number;
  /** Rows claimed but handed back unstarted because `stopAfter` passed. */
  released: number;
}

export interface DrainOptions {
  /** Epoch ms after which no further claimed row is STARTED; the rest are released. */
  stopAfter?: number;
  /** Per-row wall clock (tests shrink it); defaults to ROW_DEADLINE_MS. */
  rowDeadlineMs?: number;
  /**
   * Epoch ms when the platform will KILL this invocation (route: started +
   * maxDuration − margin). A NON-idempotent row (TERMINAL_ON_DEADLINE) that
   * could still be running then is released unstarted rather than started:
   * killed mid-turn it would be reclaimed after LEASE_MS and RE-RUN beside its
   * own ghost — the double-mint invariant 5 forbids. Money rows (15s rail
   * deadline) still start; stopAfter bounds them.
   */
  hardStopAt?: number;
}

/** One drain pass: claim → execute → settle. Time-boxed by the caller. */
export async function drainOnce(
  deps: WorkerDeps,
  workerId: string,
  batchSize = 10,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const outbox: OutboxRepo = createOutboxRepo(deps.db);
  const rows = await outbox.claimBatch(batchSize, workerId);
  const rowDeadlineMs = opts.rowDeadlineMs ?? ROW_DEADLINE_MS;
  const result: DrainResult = { processed: 0, failed: 0, dead: 0, released: 0 };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (opts.stopAfter !== undefined && Date.now() >= opts.stopAfter) {
      // Out of budget: give the unstarted remainder back NOW (attempt refunded)
      // rather than parking it under a 5-minute lease.
      result.released += await outbox.releaseUnstarted(rows.slice(i).map((r) => r.id), workerId);
      break;
    }
    if (
      opts.hardStopAt !== undefined &&
      TERMINAL_ON_DEADLINE.has(row.kind) &&
      Date.now() + rowDeadlineMs > opts.hardStopAt
    ) {
      // Cannot finish before the platform kills us: hand the non-idempotent
      // row back unstarted (attempt refunded) for the next invocation.
      result.released += await outbox.releaseUnstarted([row.id], workerId);
      continue;
    }
    // One COOPERATIVE signal per row (fires COOP_GRACE_MS before the hard
    // deadline): handlers that can stop cooperatively (agent.turn) get it; the
    // timer inside withRowDeadline is the backstop for the ones that cannot,
    // and it flags the row `abandoned` when it fires.
    const signal = newRowSignal(rowDeadlineMs);
    try {
      await withRowDeadline(handle(deps, row, signal), rowDeadlineMs, signal);
      if (await outbox.markDone(row.id, workerId)) {
        result.processed++;
      } else {
        // Our lease was reclaimed while we ran (we outlived LEASE_MS): the new
        // owner's outcome wins. Ids/kinds only — never the payload.
        logWarn('worker.lease', 'markDone refused: lease no longer ours', { id: row.id, kind: row.kind });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      // TERMINAL deadline: an abandoned non-idempotent handler (agent.turn) must
      // never be retried beside its own ghost — force the dead ceiling so the
      // ordinary dead-letter path (one deduped dead:<id> alert) handles it.
      const terminal = err instanceof RowDeadlineError && TERMINAL_ON_DEADLINE.has(row.kind);
      const status = await outbox.markFailed(row.id, terminal ? MAX_ATTEMPTS : row.attempts, message, workerId);
      if (status === 'lost') {
        logWarn('worker.lease', 'markFailed refused: lease no longer ours', { id: row.id, kind: row.kind });
        continue;
      }
      if (status === 'dead') {
        result.dead++;
        // Exactly one alert per dead row (dedupe key), never recursive.
        if (row.kind !== 'ops.alert') {
          await outbox.enqueue(
            'ops.alert',
            // A terminal deadline is dead at attempt 1 — say so, or ops goes looking for 8 attempts.
            { message: `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) ${terminal ? 'DEAD (terminal: row deadline exceeded)' : `DEAD after ${row.attempts} attempts`}: ${message.slice(0, 140)}` },
            { dedupeKey: `dead:${row.id}` },
          );
        }
      } else {
        result.failed++;
      }
    }
  }
  return result;
}
```
(`MAX_ATTEMPTS` is imported from `@/db/repos/outbox-repo` next to `createOutboxRepo`.) Update the module header comment (lines 26-34): add "Rows are LEASED (LEASE_MS) at claim; an expired lease is reclaimed by the next drain and the handlers' idempotency makes the re-run safe — except agent.turn, which is terminal on a row deadline. Every outbound fetch carries an AbortSignal deadline."

**Existing-test check:** `tests/outbox-worker.test.ts:87-95,188-193` read only `init.body`/`init.headers` — adding `signal` does not break them. No test does `toEqual` on a whole `DrainResult` (verified: `grep -rn "toEqual({ processed" tests` → none), so the new `released` field breaks nothing — LATER TASKS (8, 11) that write whole-`DrainResult` literals MUST include `released` (or use `toMatchObject`). The existing `runAgentTurn` call assertion at `tests/outbox-worker.test.ts:242-244` gains a 5th matcher: `expect.objectContaining({ signal: expect.any(AbortSignal) })`.

**4. Run:**
```bash
npx vitest run tests/outbox-worker.test.ts tests/payment-provider.test.ts tests/http-payment-provider.test.ts
npx tsc --noEmit
```
Expected: green. (`http-payment-provider.test.ts` is included because the worker now imports `RAIL_TIMEOUT_MS` from that module — see Step 7.6 for the constant; add the one-line export there FIRST if you run this step before 7.6: `export const RAIL_TIMEOUT_MS = 15_000;`.)

**5. Commit:**
```
feat(worker): lease-aware drain, per-row deadline, rail deadline on every POST

drainOnce passes its workerId to markDone/markFailed (compare-and-set), races
each row against ROW_DEADLINE_MS (retryable; terminal for agent.turn, whose
cooperative signal fires COOP_GRACE_MS earlier and whose late reply is dropped
on the row's `abandoned` flag), releases unstarted rows past the caller's
stopAfter and non-idempotent rows that cannot finish before hardStopAt, and
the three rail POSTs carry AbortSignal.timeout(RAIL_TIMEOUT_MS).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.3 — Reconcile sweep + ops snapshot: stale locks

**1. Write the failing tests.** In `tests/reconcile.test.ts`:

- Line 4 → `import { reconcileSweep, getOpsSnapshot, STALE_LOCK_MINUTES } from '@/lib/reconcile';`
- The file has FIVE whole-shape `toEqual` assertions on a `SweepResult` (line 61 is `const first = await reconcileSweep(db);` — the assertion is line 62). Once `reconcileSweep` returns `staleLocks`, every untouched one fails with `expected { …, staleLocks: 0 } to deeply equal { … }`, so ALL FIVE gain `staleLocks: 0`:
  ```ts
  // :62
  expect(first).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
  // :78
  expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
  // :87
  expect(r).toEqual({ stuckPaid: 1, reinstructed: 0, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
  // :109
  expect(r).toEqual({ stuckPaid: 1, reinstructed: 1, staleReviews: 0, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
  // :128
  expect(r).toEqual({ stuckPaid: 0, reinstructed: 0, staleReviews: 1, fundingResumed: 0, stuckRefunds: 0, staleLocks: 0 });
  ```
  (`grep -n "toEqual({ stuckPaid" tests/reconcile.test.ts` → exactly these five lines on `4fc4e6a`; after the edit the same grep must show `staleLocks: 0` on every hit.)
- Append before `describe('getOpsSnapshot')`:
```ts
describe('reconcileSweep — stale processing locks (the drain itself is down)', () => {
  async function claimAndStrand(ageMinutes: number): Promise<number> {
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'x', turn: {} });
    const [row] = await outbox.claimBatch(1, 'w_dead');
    // Age the LEASE with SQL-relative time (CLAUDE.md fixture rule).
    await db.execute(sql`UPDATE outbox SET lease_until = now() - make_interval(mins => ${ageMinutes}) WHERE id = ${row.id}`);
    return row.id;
  }

  it('counts rows whose lease expired >15m and raises EXACTLY ONE deduped ops.alert per row', async () => {
    const id = await claimAndStrand(STALE_LOCK_MINUTES + 1);
    const first = await reconcileSweep(db);
    expect(first.staleLocks).toBe(1);
    expect(await outboxRows()).toEqual([
      { kind: 'agent.turn', dedupe_key: null },
      { kind: 'ops.alert', dedupe_key: `stalelock:${id}` },
    ]);
    const second = await reconcileSweep(db);
    expect(second.staleLocks).toBe(1);
    expect(await outboxRows()).toHaveLength(2); // deduped: nothing added
  });

  it('a live lease raises no alert, and a freshly-expired one is the DRAIN\'s job (reclaim), not the sweep\'s', async () => {
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'live', turn: {} });
    await outbox.claimBatch(1, 'w_alive');
    await claimAndStrand(1); // expired 1 minute ago — claimBatch reclaims it on the next drain
    const r = await reconcileSweep(db);
    expect(r.staleLocks).toBe(0);
    expect((await outboxRows()).filter((o) => o.kind === 'ops.alert')).toHaveLength(0);
  });
});
```
- In `describe('getOpsSnapshot')`, after the dead-row INSERT (line 294) add:
```ts
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, lease_until, lease_owner)
      VALUES ('agent.turn', '{}'::jsonb, 'processing', now() - interval '20 minutes', 'w_dead')`);
```
and after the `refundsFailed` assertion (line 303):
```ts
    expect(snap.pendingOutbox).toBe(1); // 'processing' is not "pending" — unchanged
    expect(snap.staleLocks.map((o) => o.kind)).toEqual(['agent.turn']);
```

**2. Run — expect failure:**
```bash
npx vitest run tests/reconcile.test.ts
```
Expected: `SyntaxError: … does not provide an export named 'STALE_LOCK_MINUTES'`; then `expected undefined to be 1` and the five `toEqual`s at :62/:78/:87/:109/:128 failing on the missing `staleLocks` (they expect it; the pre-change sweep does not return it).

**3. Implement `src/lib/reconcile.ts`.**

After line 26:
```ts
/**
 * A 'processing' row whose lease expired this long ago and is STILL unreclaimed.
 * claimBatch reclaims expired leases on every drain, so a survivor means the
 * drain is not running (heartbeat / poke down) — alert per row, deduped.
 */
export const STALE_LOCK_MINUTES = 15;
```
`SweepResult` (lines 28-36):
```ts
export interface SweepResult {
  stuckPaid: number;
  reinstructed: number;
  staleReviews: number;
  // Optional ONLY so pre-existing zero-literals (the worker route's fallback)
  // stay assignable; reconcileSweep itself always returns all of them.
  fundingResumed?: number;
  stuckRefunds?: number;
  staleLocks?: number;
}
```
Insert before the `return {` at line 159:
```ts
  // STALE LOCKS (fix 7): leases the drain should have reclaimed but has not.
  // The alert is itself an outbox row — if the drain is dead it will not send,
  // which is why the ops page and scripts/outbox-status.ts read this out of
  // band. Ids/kinds only: payloads may still carry creds (fix 11).
  const staleLocks = await outbox.listStaleProcessing(STALE_LOCK_MINUTES);
  for (const row of staleLocks) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) has sat in 'processing' for ` +
          `>${STALE_LOCK_MINUTES}m past its lease and was not reclaimed — the worker drain is not running; ` +
          `check the GitHub Actions heartbeat.`,
      },
      { dedupeKey: `stalelock:${row.id}` },
    );
  }

  return {
    stuckPaid: stuck.length,
    reinstructed,
    staleReviews: stale.length,
    fundingResumed,
    stuckRefunds,
    staleLocks: staleLocks.length,
  };
```
`OpsSnapshot` / `getOpsSnapshot` (lines 170-193):
```ts
export interface OpsSnapshot {
  pendingOutbox: number;
  deadLetters: OutboxRow[];
  /** 'processing' rows whose lease expired >STALE_LOCK_MINUTES ago and were not reclaimed. */
  staleLocks: OutboxRow[];
  stuckPaid: Transfer[];
  …
}

export async function getOpsSnapshot(db: Db): Promise<OpsSnapshot> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  return {
    pendingOutbox: await outbox.countPending(),
    deadLetters: await outbox.listDead(),
    staleLocks: await outbox.listStaleProcessing(STALE_LOCK_MINUTES),
    …
  };
}
```
Update the header comment list (lines 14-19) with a fifth bullet: `• a 'processing' lease expired >15m and still unreclaimed (the drain is down) → alert.`

**Callers:** `src/app/api/worker/route.ts:77` zero-literal stays assignable (new field optional). `tests/reconcile.test.ts` :62, :78, :87, :109, :128 (the five whole-shape literals) updated above; the remaining `SweepResult` reads in that file (:161, :172, :196, :210, :218, :244, :250, :261, :268, :276) read single fields (`.fundingResumed`, `.stuckRefunds`, …) — unaffected. `src/app/admin-dashboard/ops/page.tsx:45` gains `snap.staleLocks` in Step 7.8.

**4. Run:** `npx vitest run tests/reconcile.test.ts && npx tsc --noEmit` → green.

**5. Commit:**
```
feat(reconcile): stale-lock sweep + staleLocks in the ops snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.4 — Worker route: start cutoff and `released`

No unit test exists for the route (nothing under `tests/` imports `api/worker/route`; verified by grep) — it is exercised by the post-deploy smoke and the Chrome walk-through in Step 7.10. The logic it wires (`stopAfter`, `released`) is unit-tested in Step 7.2.

**Implement `src/app/api/worker/route.ts`:**

Line 6 → `import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';` (unchanged) and add after line 15:
```ts
import { RAIL_TIMEOUT_MS } from '@/lib/providers/http-payment-provider';
```
Replace lines 36 and 93-108:
```ts
const TIME_BUDGET_MS = 45_000;
// No row STARTS after this point in the invocation: a money row (bounded by the
// 15s rail deadline + two DB round trips) started at the cutoff still finishes
// inside TIME_BUDGET_MS and well inside maxDuration. Fix 8 owns cadence and
// may retune this.
const START_CUTOFF_MS = TIME_BUDGET_MS - RAIL_TIMEOUT_MS;
// The platform kills the invocation at maxDuration (60s). START_CUTOFF_MS (30s)
// + ROW_DEADLINE_MS (40s) exceeds it, so an agent.turn started at 29s would be
// killed mid-turn, reclaimed after LEASE_MS and RE-RUN — the non-idempotent
// re-run invariant 5 forbids. drainOnce therefore refuses to START a
// TERMINAL_ON_DEADLINE row that could still be running at hardStopAt and
// releases it (attempt refunded) for the next invocation instead.
const HARD_STOP_MARGIN_MS = 2_000;
```
Also make `const invocationStart = Date.now();` the FIRST statement of `run()` (before the auth check, above `reconcileSweep` / `sweepStaleRates`): the platform's kill clock starts at invocation, not after the sweeps, so `hardStopAt` must be derived from `invocationStart` — derived from a `started` taken after the sweeps, a slow sweep (>2s) pushes `hardStopAt` past the real kill time and an agent.turn can still be started and killed mid-turn, the exact double-run this guard exists for.
```ts
  const workerId = `w_${newTransferId()}`;
  const started = Date.now(); // drain-loop budget clock (after the sweeps)
  const stopAfter = started + START_CUTOFF_MS;
  const hardStopAt = invocationStart + maxDuration * 1000 - HARD_STOP_MARGIN_MS; // `export const maxDuration = 60` at route.ts:27; invocationStart = first line of run()
  let processed = 0;
  let failed = 0;
  let dead = 0;
  let released = 0;
  // Keep draining until the queue is empty or the start cutoff passes. A batch
  // is only CLAIMED while a row could still be started — a claim we cannot
  // start would sit under its lease until the next drain reclaimed it.
  for (;;) {
    const r = await drainOnce(deps, workerId, 10, { stopAfter, hardStopAt });
    processed += r.processed;
    failed += r.failed;
    dead += r.dead;
    released += r.released;
    // A release-only pass ends the loop: `released` is deliberately NOT counted.
    // Past (hardStopAt − ROW_DEADLINE_MS) every remaining agent.turn row would
    // otherwise be claimed (attempts+1, lease) and released (attempts−1) on EVERY
    // iteration until stopAfter — ~12s of claim/release churn against Neon that,
    // with ORDER BY id and batch 10, starves higher-id money rows. Released rows
    // are pending again; the next poke/heartbeat picks them up.
    const drainedNothing = r.processed + r.failed + r.dead === 0;
    if (drainedNothing || Date.now() >= stopAfter) break;
  }

  return NextResponse.json({ ok: true, processed, failed, dead, released, sweep, staleRates });
```
The `sweep` zero-literal at line 77 is untouched (`staleLocks` is optional). Update the route header comment (lines 29-34): "Claiming uses FOR UPDATE SKIP LOCKED and a 5-minute LEASE, so overlapping invocations are safe and a killed invocation's rows are reclaimed."

**Run:** `npx tsc --noEmit && npx eslint src/app/api/worker/route.ts` → clean.

**Commit:**
```
feat(worker-route): start cutoff + hardStopAt + released count; claim only while a row can still start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.5 — Ollama: LLM deadline with a clear, catchable error (bot-03 / bot-04)

**1. Write the failing tests.** In `tests/ollama.test.ts` change line 2 to `import { chat, OLLAMA_TIMEOUT_MS } from '@/lib/ollama';` and append inside `describe('chat')`:
```ts
  it('passes AbortSignal.timeout to fetch, sized so chatWithRetry (2 calls) fits ROW_DEADLINE_MS', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'x' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await chat([{ role: 'user', content: 'hi' }], toolSchemas);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(OLLAMA_TIMEOUT_MS * 2).toBeLessThanOrEqual(40_000); // agent.ts chatWithRetry × ROW_DEADLINE_MS
  });

  it('an aborted chat throws a clear, catchable Error (agent.chatWithRetry retries once, then falls back)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }),
    );
    await expect(chat([{ role: 'user', content: 'hi' }], toolSchemas)).rejects.toThrow(
      /Ollama request timed out after 20000ms/,
    );
  });

  it("a caller's AbortSignal (the worker's row deadline) aborts the call too, with a distinct message", async () => {
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal;
      await new Promise((res) => init.signal!.addEventListener('abort', res, { once: true }));
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    await expect(chat([{ role: 'user', content: 'hi' }], toolSchemas, { signal: ctrl.signal })).rejects.toThrow(/aborted by the caller/);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen).not.toBe(ctrl.signal); // combined via AbortSignal.any — the 20s timeout still applies underneath
  });
```
**2. Run:** `npx vitest run tests/ollama.test.ts` → `does not provide an export named 'OLLAMA_TIMEOUT_MS'`, then `expected undefined to be an instance of AbortSignal` and the raw `aborted due to timeout` message not matching.

**3. Implement `src/lib/ollama.ts`** (whole file):
```ts
import { env } from './env';
import type { ChatMessage, ChatTool } from './types';

/**
 * LLM call budget (bot-03). The agent's chatWithRetry (agent.ts) calls chat()
 * up to TWICE per round, so 2 × this must fit the worker's ROW_DEADLINE_MS
 * (40s). Kimi K2.6 on Ollama Cloud runs at a concurrency cap of 1-3; a call
 * that has not answered in 20s is queued behind something, and retrying is
 * cheaper than waiting.
 */
export const OLLAMA_TIMEOUT_MS = 20_000;

function isTimeout(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function chat(
  messages: ChatMessage[],
  tools: ChatTool[],
  opts: { signal?: AbortSignal } = {},
): Promise<ChatMessage> {
  // The caller's signal (the worker's row deadline, fix 7) is combined with
  // this call's own timeout: whichever fires first aborts the fetch.
  // AbortSignal.any — node_modules/typescript/lib/lib.dom.d.ts:2787 (Node ≥20).
  const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${env.ollamaBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.ollamaApiKey}`,
      },
      body: JSON.stringify({
        model: env.ollamaModel,
        messages,
        tools,
        tool_choice: 'auto',
      }),
      signal,
    });
  } catch (err) {
    // A deadline must be a CLEAR, catchable Error: chatWithRetry retries once
    // on OUR timeout, never on the caller's abort (the agent then degrades to
    // its friendly fallback — never a stuck turn, never a call past the row deadline).
    if (opts.signal?.aborted) throw new Error('Ollama request aborted by the caller (row deadline)');
    if (isTimeout(err)) throw new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms`);
    throw err;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
  };
  // Guard the happy-path indexing: a missing/empty `choices` (a momentarily
  // malformed upstream response) must throw a CLEAR, catchable error rather than
  // a bare "cannot read properties of undefined" TypeError — the agent retries
  // chat() once and otherwise degrades to a friendly fallback.
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error('Ollama response missing choices[0].message');
  }
  return message;
}
```
**Callers of `chat()`** (`src/lib/agent.ts` via `deps.chat`, `src/lib/ticket-ai.ts:83,97,114`, `web-chat.ts`, `corridor-brief-ai.ts`, `partner-health-ai.ts`, `kyc-review-ai.ts`, `review-triage-ai.ts`, `ops-diagnosis-ai.ts`, `customer-summary.ts`): the signature is unchanged; the failure surface only gains one more `Error` subtype they already catch as a generic throw (`grep -n "catch" src/lib/ticket-ai.ts` confirms it falls back to defaults). No caller edits.

**4. Run:** `npx vitest run tests/ollama.test.ts tests/agent*.test.ts tests/ticket-ai*.test.ts` → green.

**5. Commit:**
```
feat(ollama): 20s AbortSignal.timeout on chat() with a clear timeout Error

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.6 — WhatsApp Graph deadline (whatsapp-06) — one chokepoint, fresh signal per attempt

**1. Write the failing tests.** Append to `tests/whatsapp.test.ts` (add `META_TIMEOUT_MS` to the import at lines 2-13):
```ts
describe('outbound deadlines (META_TIMEOUT_MS — whatsapp-06)', () => {
  const timeoutError = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  it('sendText and sendTemplate pass a signal on the Graph POST', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    await sendText('15551234567', 'hi');
    await sendTemplate('15551234567', RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG, ['a']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as unknown as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(META_TIMEOUT_MS).toBe(10_000);
  });

  it('sendInteractive and sendCtaUrl pass a signal', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    await sendInteractive('15551234567', 'pick', [{ id: 'recipient:new', title: 'New' }]);
    await sendCtaUrl('15551234567', 'Body', { displayText: 'Go', url: 'https://example.com/x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as unknown as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('an aborted Graph POST throws so the outbox retries — it does not silently fall back to sendText', async () => {
    const fetchMock = vi.fn(async () => { throw timeoutError(); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendText('1', 'hi')).rejects.toThrow(/aborted/);
    await expect(sendInteractive('1', 'pick', [{ id: 'x', title: 'X' }])).rejects.toThrow(/aborted/);
    await expect(sendCtaUrl('1', 'Body', { displayText: 'Go', url: 'https://example.com/x' })).rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // one fetch each: no fallback text attempted
  });

  it('each rate-limit retry gets a FRESH signal (a signal baked into init would be expired by the retry)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = sendText('15551230000', 'hi');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    const [, a] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, b] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(a.signal).toBeInstanceOf(AbortSignal);
    expect(b.signal).toBeInstanceOf(AbortSignal);
    expect(a.signal).not.toBe(b.signal);
    vi.useRealTimers();
  });
});
```
(The existing rate-limit tests at :217-300 use `vi.useFakeTimers()`; `AbortSignal.timeout` uses Node's internal timer, not the faked global `setTimeout`, so those tests neither fire nor hang on the new signal.)

**2. Run:** `npx vitest run tests/whatsapp.test.ts -t "outbound deadlines"` → `does not provide an export named 'META_TIMEOUT_MS'`, then `expected undefined to be an instance of AbortSignal`.

**3. Implement `src/lib/whatsapp.ts`.** After `authedJsonInit` (line 190) add:
```ts
/**
 * Meta Graph budget (whatsapp-06): one send may never hold a worker row longer
 * than this. A timeout THROWS (TimeoutError) so the outbox retries the row —
 * never a silent success, never a silent fallback.
 */
export const META_TIMEOUT_MS = 10_000;

/**
 * The single fetch chokepoint for every Graph POST. The signal is created PER
 * CALL: AbortSignal.timeout starts counting at creation, so a signal baked into
 * `init` and reused across postWithBackoff's retries would already be expired
 * after the first 6.5s rate-limit sleep.
 */
function graphFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(META_TIMEOUT_MS) });
}
```
Line 211 → `const res = await graphFetch(url, init);`
Line 474 → `const res = await graphFetch(` (the `sendInteractive` call; args unchanged)
Line 528 → `const res = await graphFetch(` (the `sendCtaUrl` call; args unchanged)

Public signatures of `sendText`/`sendTemplate`/`sendInteractive`/`sendCtaUrl` are unchanged, so `WorkerDeps` (`outbox-worker.ts:39-46`), the route wiring (`api/worker/route.ts:50-51`), `http-payment-provider.ts:192`, `whatsapp-inbound.ts`, `tools.ts` and the pay routes need no edits. `sendCtaUrl`'s "degrade on ANY non-OK" (`:551-556`) is untouched — it only runs when a Response arrived; an abort throws before that, by design.

**4. Run:** `npx vitest run tests/whatsapp*.test.ts` → green.

**5. Commit:**
```
feat(whatsapp): 10s AbortSignal.timeout on every Graph POST via one graphFetch chokepoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.7 — HttpPaymentProvider inline instruct + self-poke deadlines

**1. Write the failing test.** In `tests/http-payment-provider.test.ts` add `RAIL_TIMEOUT_MS` to the import at lines 14-20 and append inside `describe('HttpPaymentProvider.initiateTransfer …')` (after line 124):
```ts
  it('passes the rail deadline signal and rethrows an abort (stage-1 already sent; providerRef never written)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(fixture());
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }));
    const provider = new HttpPaymentProvider(store, PAYMENT);
    await expect(provider.initiateTransfer(fixture())).rejects.toThrow(/aborted/);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(RAIL_TIMEOUT_MS).toBe(15_000);
    expect((await store.getTransfer('rail_t1'))!.paymentProviderRef).toBeFalsy();
  });
```
**2. Run:** `npx vitest run tests/http-payment-provider.test.ts` → `does not provide an export named 'RAIL_TIMEOUT_MS'` / `expected undefined to be an instance of AbortSignal`.

**3. Implement.**

`src/lib/providers/http-payment-provider.ts` — after the module comment (after line 26) add:
```ts
/**
 * Rail ack budget (rail-09). The partner contract (src/app/docs/page.tsx §3)
 * promises we wait at most this long for a 2xx; a slower rail is a RETRYABLE
 * failure. Single source for the worker's three rail POSTs too.
 */
export const RAIL_TIMEOUT_MS = 15_000;
```
and at line 202 (the inline fetch's init) add after `body: rawBody,`:
```ts
      signal: AbortSignal.timeout(RAIL_TIMEOUT_MS),
```

`src/lib/outbox.ts` — replace lines 11-22:
```ts
/**
 * A hung poke would keep the poking function's after() alive for the whole
 * function ceiling. /api/worker never reads req.signal, so aborting the poke
 * frees THIS function without stopping the drain it triggered.
 */
export const POKE_TIMEOUT_MS = 10_000;

async function fetchWorker(): Promise<void> {
  try {
    await fetch(`${env.appBaseUrl}/api/worker`, {
      method: 'POST',
      headers: env.cronSecret
        ? { authorization: `Bearer ${env.cronSecret}` }
        : {},
      signal: AbortSignal.timeout(POKE_TIMEOUT_MS),
    });
  } catch {
    /* best effort (including a timeout) — the heartbeat will drain */
  }
}
```
`fetchWorker` is private and `after()`-wrapped (untestable in vitest; `pokeWorker` swallows everything). Proof for this one line is `tsc` + the Chrome/ops verification in Step 7.10 (a poke still produces a completed worker run in Vercel runtime logs).

**4. Run:** `npx vitest run tests/http-payment-provider.test.ts tests/outbox-worker.test.ts && npx tsc --noEmit` → green.

**5. Commit:**
```
feat(rail,poke): RAIL_TIMEOUT_MS on the inline instruct POST; POKE_TIMEOUT_MS on the self-poke

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.8 — Ops surfaces: status script, ops page card, partner docs (no unit tests — UI/script; verified in 7.10)

**`scripts/outbox-status.ts`:**
- Line 11 → `import { STUCK_PAID_MINUTES, STALE_REVIEW_HOURS, STUCK_REFUND_MINUTES, STALE_LOCK_MINUTES } from '@/lib/reconcile';`
- Line 32 → append `· stale lock >${STALE_LOCK_MINUTES}m past lease` to the thresholds line.
- Replace lines 55-59 with:
```ts
  const expiredLeases = await q(sql`
    SELECT count(*)::int AS reclaimable, min(lease_until) AS oldest_lease
    FROM outbox WHERE status = 'processing' AND lease_until < now()`);
  section('EXPIRED leases (worker died mid-row — RECLAIMED by the next drain, attempts++)', expiredLeases);

  const staleLocks = await q(sql`
    SELECT id, kind, attempts, lease_owner, lease_until
    FROM outbox
    WHERE status = 'processing' AND lease_until < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
    ORDER BY lease_until LIMIT 20`);
  section(`STALE locks (lease expired >${STALE_LOCK_MINUTES}m and NOT reclaimed — the drain is not running; check worker-heartbeat.yml)`, staleLocks);

  // Rows claimed by PRE-0014 code (never leased): the reclaim disjunct and staleLocks
  // both compare lease_until < now(), which never matches NULL — invisible + unreclaimable
  // until the Step 7.10.3 backfill UPDATE is re-run. Must read 0 after the deploy settles.
  const unleased = await q(sql`
    SELECT id, kind, attempts, locked_by, locked_at
    FROM outbox WHERE status = 'processing' AND lease_until IS NULL
    ORDER BY locked_at LIMIT 20`);
  section('UNLEASED processing rows (claimed by pre-lease code — re-run the 7.10.3 backfill UPDATE)', unleased);
```
- Lines 83-84 → `dead.length + staleLocks.length + unleased.length + stuckPaid.length + staleReview.length + pendingRefunds.length;`
(ids/kinds/timestamps only — no `payload`, per invariant 7.)

**`src/app/admin-dashboard/ops/page.tsx`:**
- Line 7 → `import { getOpsSnapshot, STUCK_PAID_MINUTES, STALE_REVIEW_HOURS, STALE_LOCK_MINUTES } from '@/lib/reconcile';`
- Lines 57-61 →
```tsx
  const healthy =
    snap.deadLetters.length === 0 &&
    snap.staleLocks.length === 0 &&
    snap.stuckPaid.length === 0 &&
    snap.staleReviews.length === 0 &&
    refundsTotal === 0;
```
- Line 76 → `<section className="grid grid-cols-2 gap-4 lg:grid-cols-5 mb-6">` and insert after the "Dead letters" card (after line 94):
```tsx
          <Card className={snap.staleLocks.length ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Stale locks</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{snap.staleLocks.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              lease expired &gt;{STALE_LOCK_MINUTES}m, not reclaimed — drain down?
            </CardContent>
          </Card>
```
- After the dead-letters `Card` block, add a table rendered only when `snap.staleLocks.length > 0` with columns `#`, `Kind`, `Attempts`, `Lease expired` (`age(o.leaseUntil?.toISOString())`), reusing the same `Table*` components — no `payload`, no actions (the reclaim is automatic once the drain runs; the operator's fix is the heartbeat). Keep `sh-main`/`sh-page-head`/`sh-page-title`/`sh-page-sub` and `aside.sh-sidebar` untouched (e2e hooks).

**`src/app/docs/page.tsx`** — replace the paragraph at lines 211-215 with:
```tsx
          <p className="text-sm text-muted-foreground">
            Respond <code>2xx</code> with an optional <code>{`{ "providerRef": "…" }`}</code> —
            stored write-once against the transfer. Use <code>reference</code> to deduplicate: the
            instruction is at-least-once.
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Ack deadline: 15 seconds.</strong> We wait at most 15s for your <code>2xx</code>;
            a slower response is treated as a failure and the SAME instruction (same{' '}
            <code>reference</code>) is retried with exponential backoff. Persist and ack first, then
            process asynchronously — and dedupe on <code>reference</code>, so a retry after a slow
            ack can never pay out twice.
          </p>
```
(The `15` here mirrors `RAIL_TIMEOUT_MS`; the docs page is static JSX, so add a comment `{/* keep in sync with RAIL_TIMEOUT_MS in src/lib/providers/http-payment-provider.ts */}` above it.)

**Run:** `npx tsc --noEmit && npx eslint scripts/outbox-status.ts src/app/admin-dashboard/ops/page.tsx src/app/docs/page.tsx` → clean.

**Commit:**
```
feat(ops): stale-lock card + table, honest outbox-status sections, rail ack-deadline in partner docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7.9 — Full verification (the Stop hook enforces this; quote the output in the PR)

```bash
npx tsc --noEmit
npx eslint . --max-warnings 0
npx vitest run
```
Expected: 0 type errors, 0 lint findings, every suite green (known PGlite parallel flakes pass in isolation — re-run the single file before concluding anything). Then:
```bash
grep -rnE "AbortSignal\.timeout" src/ | sort
```
Expected exactly EIGHT call sites: `outbox-worker.ts` ×4 (three rail POSTs + the per-row deadline signal in `drainOnce`), `ollama.ts` ×1, `whatsapp.ts` ×1 (`graphFetch`), `http-payment-provider.ts` ×1, `outbox.ts` ×1 — i.e. every outbound fetch listed in the brief except `rate.ts` (fix 9), plus the cooperative row deadline. Also `grep -n "signal?.aborted" src/lib/agent.ts` → exactly two hits (top of the tool-round loop; before `executeTool`).

Run `/security-review` (touches money, webhooks-adjacent, outbox). Expected findings to pre-empt in the PR: (a) `releaseUnstarted` is owner-scoped and cannot be reached from any request handler; (b) the stale-lock alert prints id/kind only; (c) no new secret in code or logs (`logWarn` fields are `{ id, kind }`).

---

#### Step 7.10 — PR, merge, MANUAL migration, proof on prod

1. Open the PR from `fix/outbox-worker/outbox-lease-and-fetch-timeouts` → `main`. Description must include: findings closed, the constants table, the scope rulings (rate.ts → fix 9; conflicts with 1/3/4/8/11/12 and who rebases), the pre-flight greps, the EIGHT-site `AbortSignal.timeout` grep from Step 7.9, the vitest/tsc/eslint output, a "behaviour changes" section that lists — next to the new `released` count — that a release-only pass ends the drain loop (Step 7.4), so an `agent.turn` row that arrives late in a heartbeat invocation (past `hardStopAt − ROW_DEADLINE_MS` ≈ 18s) waits for the next poke/heartbeat (up to 5 min) rather than being started; correct by design (invariant 5: never start a non-idempotent row that cannot finish), and the MIGRATION WARNING below. End with:
   ```
   🤖 Generated with [Claude Code](https://claude.com/claude-code)

   https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
   ```
2. Wait for `ci / ci` green; squash-merge (never push to `main` directly).
3. **IMMEDIATELY after merge (before the deploy finishes — drizzle selects explicit column lists, so the new code's first outbox query fails until 0014 is applied):**
   ```bash
   set -a; source .env.local; set +a; npx drizzle-kit migrate
   ```
   Expected: `0014_outbox_lease` applied. Verify:
   ```bash
   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/outbox-status.ts
   ```
   **BEFORE the merge** (so the new reclaim can never pick them up): the two rows already stranded in prod (ids 154 and 2282) are `agent.turn` rows from July and September. Reclaiming them would re-run the agent on a months-old inbound message — it may call `send_approve_picker` or `create_transfer` (non-idempotent, invariant 5's own concern) and message the customer months late. Mark them dead by hand, ids/kinds only, never the payload: `UPDATE outbox SET status = 'dead', last_error = 'ops: stranded pre-lease processing row, dead-lettered by hand before 0014 (PR #<n>)' WHERE id IN (154, 2282) AND status = 'processing';` (via `psql "$DATABASE_URL_UNPOOLED"` or the Neon SQL editor; expect `UPDATE 2`), and state in the PR body that they were dead-lettered by hand rather than reclaimed. (Do NOT wait for the drain to "complete or dead-letter" them.)
   Then, the moment Vercel marks the deploy **Ready**, run the backfill for rows the OLD code claimed in the migrate→deploy window (old code never sets `lease_until`, and `lease_until < now()` never matches NULL — those rows would otherwise be unreclaimable and invisible to `staleLocks`): `UPDATE outbox SET lease_until = coalesce(locked_at, now()) + interval '5 minutes', lease_owner = locked_by WHERE status = 'processing' AND lease_until IS NULL;` (expect 0-2 rows). **Run the same UPDATE a second time at least 60s (= `maxDuration`) after Ready:** an OLD worker invocation that was still inside its drain loop at Ready can claim rows for up to 45-60s afterwards, and those rows would keep a NULL lease forever — a stuck `settlement.instruct` among them could not even be re-enqueued because its `instruct:<id>` dedupe key already exists. The "UNLEASED processing rows" section of `scripts/outbox-status.ts` (Step 7.8) must read `none` after the second run.
   Expected: "EXPIRED leases" / "STALE locks" show only rows from the migrate→deploy window (normally 0 — 154 and 2282 are already `dead`); after the next heartbeat or a manual `curl -X POST -H "authorization: Bearer $CRON_SECRET" https://smartremit.ai/api/worker` any such row is reclaimed (a fresh `whatsapp.text` completes; an `agent.turn` claimed in that window is minutes old, not months, so a late reply is acceptable at-least-once), the "STALE locks" and "UNLEASED" sections return to `none` and `needsHuman` drops accordingly.
4. `/post-merge-check` → smoke.yml green for the merge SHA.
5. Claude-in-Chrome walk-through of `https://smartremit.ai/admin-dashboard/ops` as platform staff: the five stat cards render, "Stale locks" reads 0 after the drain, the "All clear" card appears only when every count including stale locks is zero. Also confirm in Vercel runtime logs that a poke-triggered `/api/worker` run logs completion (`processed/…/released`) after the poking function returned — proof that `POKE_TIMEOUT_MS` frees the poker without cutting the drain.
6. Notify the wave: fixes 1 and 3 can now rebase; the migration number 0015 is free for fix 1.

---

### Task 1: Scope phone-keyed customer state by tenant on the partner API and the WhatsApp webhook (customers keyed by (partner_id, phone) with backfill to current partner)

**Findings:** F44, F45, F47, F50, F52. **Component:** partner-api (this task also holds the customer-portal, whatsapp-agent, money-paths and db-layer files it must touch — one PR, boundary-hook flags acknowledged; see sequencing ruling "1 holds BOTH the partner-api and customer-portal worktrees for wave 1"). **Model:** Fable 5.1. **Wave 1, merges AFTER fix 7** (fix 7 owns `drizzle/0014_outbox_lease.sql`; this task's migration is `0015_tenant_scoped_customers` — generated only after rebasing onto the merged 0014, see Step 2).

#### Decisions settled before any code is written (owner sign-off items are marked ⚠)

Ground truth read for these decisions: `src/db/schema.ts:197-239` (`phone: text('phone').primaryKey()`), `src/db/repos/customer-repo.ts:143-165` (the follow-the-number rewrite, `needsRoute` at :152 and `partnerId: routedPartnerId!` at :158), `src/lib/whatsapp-inbound.ts:100-105`, `src/lib/partner-api-service.ts:252-268` (claim at :254 precedes the sender parse at :266), `src/lib/sender-names.ts:29-32` (`inArray(customers.phone, unique)` — no partner predicate), `src/lib/customer-auth-store.ts:64,71-75,105-107,311-350` (phone-only sessions), `src/lib/types.ts` Draft (no `partnerId` field; `src/app/pay/[transferId]/page.tsx:137` says so explicitly), `src/lib/providers/persona-kyc-provider.ts:47` (`referenceId: input.senderPhone`).

- **D1 — Identity is `(partner_id, phone)`; phone-only reads become a type error.** `CustomerStore` methods take `partnerId: PartnerId` as the REQUIRED first argument. The only phone-alone read is a new, explicitly named `findByPhone(phone): Promise<Customer[]>` used by exactly three callers: portal auth (D6), the platform-staff customer detail page (D8) and the Persona webhook (D7). `listCustomers(partnerId?)` filters at the WHERE.
- **D2 ⚠ — WL2 "the partner owns the channel" becomes "the partner owns its own copy of the customer".** `upsertOnFirstInbound(partnerId, phone)` NEVER moves an existing row; a partner-signed inbound for a phone that exists under another tenant creates a sibling row under the routed partner (`kyc_status not_started`, no PII, no password). The shared `/api/whatsapp` number (`routedPartnerId: null`, `src/app/api/whatsapp/route.ts:42-44`) IS the default tenant's channel: tenant = `routedPartnerId ?? DEFAULT_PARTNER_ID`. Consequence to state to the owner: an acme customer who messages the shared number gets a fresh default-tenant profile (no KYC carry-over) — that is the isolation the fix exists for.
- **D3 — Partner API: no refusal oracle.** The brief lists "refuse 404/422 when the phone exists under another tenant". That refusal would itself be an enumeration oracle (a 422 tells partner B that phone X is someone else's customer — exactly what 404-never-403 forbids). With sibling rows the correct behaviour is: `createTransaction` resolves the sender under `partner.id` ONLY (`ensureCustomer(partner.id, phone)`, no WhatsApp opt-in implied), before the idempotency claim; another tenant's row, address book and counters are structurally unreachable; the response for an out-of-tenant phone is byte-identical in shape to an unknown phone (201, `sender_name: null`). Tests in Step 8 pin "no ledger/recipient/velocity/PII side effect on the other tenant" instead of a status code.
- **D4 — The routed tenant is carried by the turn, not derived from the customer row.** `AgentDeps.partnerId?: PartnerId` (absent ⇒ `DEFAULT_PARTNER_ID`, so the 36+3+1 existing `createAgent` test call sites keep compiling); `ToolContext.partnerId: PartnerId` (required, set by the agent); `WorkerDeps.runAgentTurn`'s 5th argument is the OPTIONS OBJECT fix 7 introduced (`opts?: { signal?: AbortSignal }`) — this task adds `routedPartnerId?: PartnerId | null` to it (`{ signal, routedPartnerId }`), never a new positional; the `agent.turn` payload keeps carrying `routedPartnerId` (never creds — `src/lib/whatsapp-inbound.ts:142-151`). Because that payload value is now an IDENTITY input, the worker ASSERTS it names an existing partner before running the turn (Step 5.3): unknown/inactive ⇒ run under `DEFAULT_PARTNER_ID` and raise one deduped `ops.alert` (`badtenant:<rowId>`) — a malformed or legacy row can never run a turn under a nonexistent tenant. Brand/KYC posture come from the routed partner, not from `customer.partnerId`.
- **D5 — Drafts carry the tenant.** `Draft.partnerId?: PartnerId` (optional ONLY for the 30-minute TTL drain of in-flight legacy drafts; every new draft sets it; readers use `draft.partnerId ?? DEFAULT_PARTNER_ID`). The `draft:<id>` idempotency claim stays under `DEFAULT_PARTNER_ID` (`src/lib/pay-finalize.ts:100-107` explains why — a draftId is globally unique and the expired-draft replay must find it without knowing the tenant).
- **D6 ⚠ — Portal: exactly one account-bearing row per phone; fail closed otherwise.** `SessionRecord` gains `partnerId`; `createSession(phone, partnerId)`; a session without `partnerId` (pre-deploy) resolves to null ⇒ re-login (30-min idle window anyway). `registerCustomer` attaches to the single existing row for the phone, creates under `default` when there is none, and throws `CustomerInputError` when the phone already has rows under >1 tenant. `verifyCustomerPassword`/`setPassword`/`markPhoneVerified` operate on `loadAccountRow(phone)` = the ONE row with `password_hash`; two account-bearing rows ⇒ null (generic login error). `getCurrentCustomer` reads `(partnerId, phone)` from the session.
- **D7 — Persona webhook binds by inquiry id.** `referenceId` stays the phone (in-flight inquiries keep working); the row is chosen by `kycInquiryId === event.inquiryId`, else the single row when the phone is unambiguous, else ignored. Never guesses between tenants.
- **D8 — Admin detail page `/admin-dashboard/customers/[phone]` gains `?partner=`.** Partner-scoped staff are pinned to their tenant at the query (`getCustomer(scope.partnerId, phone)`), regardless of the param. Platform staff: `?partner=` picks the row; without it, `findByPhone` — one row ⇒ it; several ⇒ the most recently updated row plus a "this number also exists under …" sibling list. Every link to the detail page (`sender-cell.tsx:15`, `customers/page.tsx:137`, `kyc/page.tsx:91`, `customers/actions.ts:156`) appends `?partner=<partnerId>`; the three action forms on the page post a hidden `partnerId` which partner staff cannot override (identity pins).
- **D9 — Redis counter keys are renamed ONCE (this PR owns the shape; fix 10 consumes it):** `velocity:{partnerId}:{phone}:{date}`, `daily_volume:{partnerId}:{phone}:{date}`, `monthly_volume:{partnerId}:{phone}:{month}`. Transitional dual-read, **restricted to the phone's PRE-FIX tenant** (the unrestricted version contradicts D3 and leaks compliance data across tenants — a sibling row created post-fix would inherit the other tenant's counters and observe cap refusals that encode that tenant's activity, the enumeration oracle D3 forbids): a read of the tenant key that finds nothing falls back to the legacy phone-only key ONLY when the caller's `partnerId` equals the phone's legacy tenant, where the legacy tenant is the OLDEST `customers` row for the phone (`findByPhone(phone)[0].partnerId` — pre-fix a phone had exactly one row, so a second row is by construction a post-fix sibling and the oldest row is the pre-fix owner; zero rows ⇒ no fallback). **"Oldest row = pre-fix owner" holds ONLY because `customers.createdAt` is never backdated (Step 2.3: `freshCustomer` stamps `createdAt: nowIso` in BOTH branches; a grandfathered row keeps `firstSeenAt = minAt` but NOT `createdAt = minAt`).** Otherwise a row created after deploy could sort BEFORE the real pre-fix owner: before the fix the partner API minted transfers WITHOUT a customers row (`partner-api-service.ts` / `transfer-create.ts` have no customer writes on `4fc4e6a`), so (a) acme's API minted for phone P at T1, the customer registered on the portal under default at T2 > T1, and Step 8's `ensureCustomer('acme', P)` would create a sibling backdated to T1 < T2; (b) with a default row grandfathered at T1 (= the phone-wide MIN over all tenants) the acme sibling would tie at T1 and `findByPhone`'s `asc(partnerId)` tie-break puts `acme` first. Either way `legacyTenantOf(P)` would return `acme`, and acme staff + acme's bot would read default's `kyc_audit:{P}` (NO TTL — a permanent leak), `conv:{P}` and the velocity/daily/monthly counters while the real owner lost them — exactly the cross-tenant oracle D3 forbids. The rule is encoded ONCE in `src/lib/legacy-tenant.ts` (`legacyTenantResolver`, `legacyKeyAllowed`) and shared by the velocity, daily, monthly, conversation (D12) and KYC-audit (D10) stores (Step 3). The counter fallback lasts one TTL window (velocity 48 h, daily 48 h, monthly 35 d); fix 10 deletes the Redis counters and with them ONLY those three callers of the helper — `conv:` (30-day TTL) and `kyc_audit:` (no TTL) keep calling it, so `legacy-tenant.ts`, `store.legacyTenantOf` and `tests/legacy-tenant.test.ts` survive fix 10. Pinned in `tests/tenant-boundary.test.ts` ("an acme sibling created after the rename never reads default's legacy velocity/daily/monthly/kyc_audit" + the createdAt-invariant pin in Step 11). The PR description states this.
- **D10 — KYC audit trail key becomes `kyc_audit:{partnerId}:{phone}`** with a read-only fallback to the legacy `kyc_audit:{phone}` when the scoped hash is empty AND the caller's tenant is the phone's legacy (oldest-row) tenant per the same D9 helper — partner-scoped staff of a post-fix sibling tenant never read another tenant's audit events. Stated in the PR.
- **D11 ⚠ — Routing is identity, so the routing inputs are locked down in the SAME PR.** After this task `routedPartnerId` decides which tenant a customer is resolved/created under, but today the routing it rests on is partner-settable and unverified: `saveWhatsappConfigAction` (`src/app/admin-dashboard/partners/actions.ts:172-190`) is gated by `gatePartnerConfig` = `requireAdmin` + `canSee`, so a PARTNER-SCOPED admin can store ANY `phoneNumberId`; `partner_integrations.wa_phone_number_id` (`src/db/schema.ts:250`) has no unique constraint; `partnerForPhoneNumberId` (`src/db/repos/integrations-repo.ts:84-92`) is `WHERE = $1 LIMIT 1`; and the shared webhook (`src/app/api/whatsapp/route.ts:56`) verifies with `integrations?.whatsapp.appSecret || env.metaAppSecret`. So partner B could set pnid = the platform's `WHATSAPP_PHONE_NUMBER_ID` (or partner A's pnid), leave `appSecret` blank, and every platform-signed inbound for that number would run with `routedPartnerId = B` — resolving those customers under B's tenant, brand, KYC posture, creds and dashboard. Three locks, all in this PR (Step 2 + Step 5A): (a) migration 0015 adds a partial UNIQUE index on `partner_integrations(wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL` (schema.ts too), and `saveWhatsappConfigAction` / `wizardCreatePartnerAction` refuse a pnid equal to `env.whatsappPhoneNumberId` or already held by another partner — with ONE generic error ("That WhatsApp number cannot be used.") so the refusal never discloses who holds it; (b) in `/api/whatsapp/route.ts` a partner-routed event (`routedPartnerId` non-null) is verified with THAT partner's `appSecret` ONLY — no `env.metaAppSecret` fallback — and a routed partner with no `appSecret` configured is a 401 (fail closed), the same posture `/api/whatsapp/[partnerId]` already has; (c) BYO numbers that live under the PLATFORM Meta app (signed with the platform secret) are supported ONLY under variant B (routed + no partner secret ⇒ platform secret, legal solely because lock (a) makes the pnid unique and ≠ the platform's own number); under the default fail-closed variant A a routed partner MUST configure its own app secret or its inbound is 401 — the PR says which variant shipped in one sentence. Tenant-boundary tests cover all three. **Outage guard (Step 2.2 pre-apply query (c)):** lock (b) silently 401s EVERY inbound customer message for any production partner that today has `wa_phone_number_id` set but no `wa_app_secret_enc` (they verify through the `||` fallback at `src/app/api/whatsapp/route.ts:54` right now). Before the branch is cut AND again before merge run `SELECT partner_id FROM partner_integrations WHERE wa_phone_number_id IS NOT NULL AND wa_app_secret_enc IS NULL;` — any row ⇒ STOP: either configure that partner's app secret (and prove a signed test event verifies) or ship variant B (routed + no partner secret ⇒ verify with the platform secret, allowed ONLY because lock (a) guarantees the pnid is unique and ≠ `env.whatsappPhoneNumberId`) as the explicit branch in Step 5A.3 with the owner decision in the PR body. Whichever variant ships, `tests/whatsapp-route.test.ts` pins it and the wave table names it.
- **D12 — Every per-customer Redis key the BOT reads is keyed by `(partnerId, phone)`, not phone.** Verified in code: `conv:${phone}` (`src/lib/store.ts:63-69`, the 30-day conversation history the agent loads at `src/lib/agent.ts:93`), `active_draft:${phone}` (`src/lib/draft-store.ts:19,29`, resolved at `src/lib/tools.ts:3047` on cancel/approve), `lastmsg:${phone}` (`src/lib/store.ts:192-195`, read at `src/lib/whatsapp-inbound.ts:96`) and the web thread `conv:web:<phone>` (`src/lib/web-chat.ts:15-23`). Left phone-keyed, the sibling-row model leaks through the bot itself: a customer of partner A who messages partner B's number gets B's bot primed with A's full conversation (recipients, amounts, tool results), and an approve tap under tenant B can resolve tenant A's draft and mint under A while replying with B's creds. So: `conv:{partnerId}:{phone}`, `conv:{partnerId}:web:{phone}`, `active_draft:{partnerId}:{phone}`, `lastmsg:{partnerId}:{phone}`; `Store.getConversation/saveConversation/getLastInboundAt/recordInboundNow` and `DraftStore.getActiveDraftId` take `partnerId` FIRST; `createDraft` REQUIRES `input.partnerId`; `consumeDraft` derives the pointer key from the stored draft; and the approve / cancel paths carry a hard guard that refuses when `(draft.partnerId ?? DEFAULT_PARTNER_ID) !== ctx.partnerId`. The only legacy dual-read is for `conv:` (a customer mid-conversation at deploy time must not lose their thread) and it follows the D9 oldest-row rule through the same helper. Tenant-boundary tests: "acme turn for a phone with default history starts empty", "approve tap under acme never resolves a default draft".
- **Sanctions, minting, settlement are untouched:** `screenTransfer` stays where it is in `createTransfer` (`src/lib/transfer-create.ts:157-164`); claim-first minting (`partner-api-service.ts:254`, `pay-finalize.ts:105`, `b2b-pay-finalize.ts:181`) and `beginSettlement` are not edited. `customers.full_name_enc` is still only decrypted through `openOptional` (`customer-repo.ts:57`, `sender-names.ts:35`); `resolveSenderNames` narrows its surface, adds no reveal path and therefore no `audit_events` row.

**Files:**

- Create: `drizzle/0015_tenant_scoped_customers.sql`, `drizzle/meta/0015_snapshot.json`, `tests/tenant-boundary.test.ts`, `src/lib/legacy-tenant.ts` (D9/D10/D12 oldest-row rule, one helper)
- Modify: `drizzle/meta/_journal.json` (idx 15, append-only), `src/db/schema.ts` (customers, recipients, AND the `partner_integrations` partial unique index — D11), `src/db/repos/customer-repo.ts`, `src/db/repos/aux-repos.ts`, `src/db/repos/transfer-repo.ts`, `src/lib/customer-store.ts`, `src/lib/store.ts` (conv/lastmsg/velocity keys — D12/D9), `src/lib/draft-store.ts` (`active_draft` key — D12), `src/lib/daily-volume-store.ts`, `src/lib/monthly-volume-store.ts`, `src/lib/sender-names.ts`, `src/lib/whatsapp-inbound.ts`, `src/app/api/whatsapp/route.ts` (per-partner secret, fail closed — D11), `src/app/admin-dashboard/partners/actions.ts` (pnid refusal in `saveWhatsappConfigAction` + `wizardCreatePartnerAction` — D11), `src/lib/outbox-worker.ts`, `src/app/api/worker/route.ts`, `src/lib/agent.ts`, `src/lib/tools.ts`, `src/lib/web-chat.ts`, `src/lib/recent-transfers.ts`, `src/lib/verify-link.ts`, `src/lib/types.ts` (Draft), `src/lib/transfer-create.ts`, `src/lib/pay-finalize.ts`, `src/lib/b2b-pay-finalize.ts`, `src/lib/cron-run.ts`, `src/app/api/cron/route.ts`, `src/app/api/pay/[transferId]/route.ts`, `src/app/api/pay/b2b/[invoiceId]/route.ts`, `src/app/pay/[transferId]/page.tsx`, `src/app/api/persona-webhook/route.ts`, `src/lib/kyc-case-store.ts`, `src/lib/providers/mock-kyc-provider.ts`, `src/lib/customer-summary.ts`, `src/lib/partner-api-service.ts`, `src/lib/partner-api.ts`, `src/lib/customer-auth-store.ts`, `src/lib/customer-auth.ts`, `src/app/account/actions.ts`, `src/app/account/page.tsx`, `src/app/account/verify/actions.ts`, `src/app/account/history/page.tsx`, `src/app/account/support/actions.ts`, `src/app/account/support/new/page.tsx`, `src/lib/scoped-store.ts`, `src/app/admin-dashboard/sender-cell.tsx`, `src/app/admin-dashboard/customers/[phone]/page.tsx`, `src/app/admin-dashboard/customers/actions.ts`, `src/app/admin-dashboard/customers/page.tsx`, `src/app/admin-dashboard/kyc/page.tsx`, `src/app/admin-dashboard/partners/page.tsx`, `src/app/admin-dashboard/partners/[id]/page.tsx`, `src/app/admin-dashboard/page.tsx`, `src/app/admin-dashboard/compliance/page.tsx`, `src/app/admin-dashboard/transactions/page.tsx`, `src/app/admin-dashboard/transactions/[id]/page.tsx`, `src/app/admin-dashboard/ops/page.tsx`, `src/app/admin-dashboard/refunds/page.tsx`, `src/app/api/copilot/kyc-review/route.ts`
- Test (rewritten or extended): `tests/pg-repos.test.ts`, `tests/customer-store.test.ts`, `tests/recipient-store.test.ts`, `tests/store.test.ts`, `tests/draft-store.test.ts` (if present — else the draft cases live in `tests/tools.test.ts`), `tests/partners-actions.test.ts` (pnid refusal), `tests/legacy-tenant.test.ts` (new, pure), `tests/transfer-repo.test.ts`, `tests/daily-volume-store.test.ts`, `tests/monthly-volume-store.test.ts`, `tests/sender-names.test.ts`, `tests/whatsapp-route.test.ts`, `tests/outbox-worker.test.ts`, `tests/agent.test.ts`, `tests/tools.test.ts`, `tests/e2e.test.ts`, `tests/partner-orchestration.test.ts`, `tests/web-chat.test.ts`, `tests/recent-transfers.test.ts`, `tests/verify-link.test.ts`, `tests/transfer-create.test.ts`, `tests/pay-finalize.test.ts`, `tests/b2b-crossborder-pay.test.ts`, `tests/cron-run.test.ts`, `tests/kyc-case-store.test.ts`, `tests/kyc-provider.test.ts`, `tests/persona-webhook-route.test.ts`, `tests/review-kyc-action.test.ts`, `tests/account-verify-action.test.ts`, `tests/account-settings-actions.test.ts`, `tests/customer-auth-store.test.ts`, `tests/account-actions.test.ts`, `tests/partner-api-service.test.ts`, `tests/partner-api-rates.test.ts` (its `harness()` `PartnerApiDeps` literal gains the now-required `customerStore` — Step 8.1), `tests/scoped-store.test.ts`, `tests/customers-actions-scope.test.ts`, `tests/customer-summary.test.ts`

---

#### Step 1 — Worktree, branch, and the two currently-vulnerable tests inverted (RED)

1.1 Cut the branch outside iCloud from the partner-api anchor, after fix 7 has merged to main:

```bash
cd ~/dev/wt 2>/dev/null || mkdir -p ~/dev/wt
git -C "/Users/nagavenkatasai/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" fetch origin
git -C "/Users/nagavenkatasai/Library/Mobile Documents/com~apple~CloudDocs/Desktop/claude-payments" worktree add ~/dev/wt/partner-api origin/component/partner-api
cd ~/dev/wt/partner-api
git checkout -b fix/partner-api/tenant-scope-phone-keyed-customer-state
git merge --no-edit origin/main            # brings fix 7's drizzle/0014_outbox_lease.sql + journal idx 14
ls drizzle | tail -3                        # MUST show 0014_outbox_lease.sql before continuing
npm ci
```

If `ls drizzle` does not show `0014_outbox_lease.sql`, STOP — fix 7 has not merged; generating a migration now would take idx 14 and its journal `when` would sort before fix 7's, which the drizzle migrator would then skip in prod (it applies only entries newer than the last applied `created_at`).

1.2 Invert the two tests that assert the vulnerable behaviour. In `tests/customer-store.test.ts` replace the whole `describe('WL2 follow-the-number routing …')` block (lines 334-368) with:

```ts
describe('tenant-scoped identity (fix 1 / F44): upsertOnFirstInbound never re-homes a customer', () => {
  it('creates a NEW customer under the routed partner', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    const { customer, wasCreated } = await cs.upsertOnFirstInbound('acme', PHONE);
    expect(wasCreated).toBe(true);
    expect(customer.partnerId).toBe('acme');
  });

  it('does NOT re-home a customer owned by "default" — it creates a sibling row under acme', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    const first = await cs.upsertOnFirstInbound('default', PHONE);
    await cs.saveCustomer({ ...first.customer, kycStatus: 'verified', fullName: 'Asha Patel', passwordHash: 'pw-hash' });
    const { customer, wasCreated } = await cs.upsertOnFirstInbound('acme', PHONE);
    expect(wasCreated).toBe(true);
    expect(customer.partnerId).toBe('acme');
    expect(customer.kycStatus).toBe('not_started');
    expect(customer.fullName).toBeUndefined();
    expect(customer.passwordHash).toBeUndefined();
    // the default-tenant row is untouched: partner_id, kyc_status, PII, password all stay
    const dflt = (await cs.getCustomer('default', PHONE))!;
    expect(dflt.partnerId).toBe('default');
    expect(dflt.kycStatus).toBe('verified');
    expect(dflt.fullName).toBe('Asha Patel');
    expect(dflt.passwordHash).toBe('pw-hash');
  });

  it('getCustomer(acme, phone) is null for a phone whose only row belongs to default', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound('default', PHONE);
    expect(await cs.getCustomer('acme', PHONE)).toBeNull();
    expect((await cs.findByPhone(PHONE)).map((c) => c.partnerId)).toEqual(['default']);
  });

  it('kyc_status flipped under acme leaves the default-tenant row untouched', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound('default', PHONE);
    const acme = (await cs.upsertOnFirstInbound('acme', PHONE)).customer;
    await cs.saveCustomer({ ...acme, kycStatus: 'verified' });
    expect((await cs.getCustomer('acme', PHONE))!.kycStatus).toBe('verified');
    expect((await cs.getCustomer('default', PHONE))!.kycStatus).toBe('not_started');
  });

  it('same routedPartnerId ⇒ idempotent (no extra write needed)', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    const first = await cs.upsertOnFirstInbound('acme', PHONE);
    const second = await cs.upsertOnFirstInbound('acme', PHONE);
    expect(second.customer.updatedAt).toBe(first.customer.updatedAt);
  });
});
```

In `tests/pg-repos.test.ts` replace the test at lines 133-151 (`'upsertOnFirstInbound: create → grandfather via firstTransferAt → follow-the-number'`) with:

```ts
  it('upsertOnFirstInbound: create → grandfather via firstTransferAt → sibling row per tenant, never a re-home', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    // grandfathered path: prior transfer exists (under this tenant)
    firstAt.value = '2026-01-01T00:00:00.000Z';
    const g = await r.upsertOnFirstInbound('default', '15550001111');
    expect(g.wasCreated).toBe(false);
    expect(g.customer.kycStatus).toBe('grandfathered');
    expect(g.customer.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    // brand-new path under a routed partner
    firstAt.value = null;
    const n = await r.upsertOnFirstInbound('acme', '15550002222');
    expect(n.wasCreated).toBe(true);
    expect(n.customer.partnerId).toBe('acme');
    // F44: a partner-signed inbound for a phone that already belongs to 'default'
    // creates acme's OWN row and leaves the default row exactly as it was.
    const sibling = await r.upsertOnFirstInbound('acme', '15550001111');
    expect(sibling.wasCreated).toBe(true);
    expect(sibling.customer.partnerId).toBe('acme');
    expect(sibling.customer.kycStatus).toBe('not_started');
    expect((await r.getCustomer('default', '15550001111'))!.partnerId).toBe('default');
    expect((await r.getCustomer('default', '15550001111'))!.kycStatus).toBe('grandfathered');
    expect((await r.findByPhone('15550001111')).map((c) => c.partnerId).sort()).toEqual(['acme', 'default']);
  });

  it('saveCustomer conflicts on (partner_id, phone), so two partners hold the same phone independently', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    const base: Customer = {
      senderPhone: '15550009999', firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US',
      partnerId: 'default', fullName: 'Asha Patel', passwordHash: 'pw', createdAt: now, updatedAt: now,
    };
    await r.saveCustomer(base);
    await r.saveCustomer({ ...base, partnerId: 'acme', kycStatus: 'not_started', fullName: undefined, passwordHash: undefined });
    const d = (await r.getCustomer('default', '15550009999'))!;
    const a = (await r.getCustomer('acme', '15550009999'))!;
    expect([d.kycStatus, d.fullName, d.passwordHash]).toEqual(['verified', 'Asha Patel', 'pw']);
    expect([a.kycStatus, a.fullName, a.passwordHash]).toEqual(['not_started', undefined, undefined]);
    expect(await r.getCustomer('globex', '15550009999')).toBeNull();
    expect((await r.listCustomers('acme')).map((c) => c.partnerId)).toEqual(['acme']);
    expect((await r.listCustomers()).length).toBe(2);
  });

  it('ensureCustomer creates a row WITHOUT WhatsApp opt-in (API-minted senders never consent by side effect)', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    firstAt.value = null;
    const c = await r.ensureCustomer('acme', '15550004444');
    expect(c.partnerId).toBe('acme');
    expect(c.optInAt).toBeUndefined();
    expect((await r.ensureCustomer('acme', '15550004444')).createdAt).toBe(c.createdAt); // idempotent
  });
```

Also in `tests/pg-repos.test.ts` update the consent test (lines 153-167) — every `r.setOptedOut('15550003333')`, `r.clearOptedOut(...)`, `r.recordFundingMethod(...)`, `r.recordKycInquiry(...)`, `r.getCustomer(...)`, `r.upsertOnFirstInbound(...)` call gains `'default', ` as its first argument (7 calls), the PII test at line 128 becomes `r.getCustomer('default', '15551230000')`, and the recipients test (lines 189-196) becomes:

```ts
  it('recipients: encrypted, sorted by lastUsedAt, limited, and TENANT-SCOPED', async () => {
    await seedPartner(db, 'acme');
    const r = createRecipientRepo(db, provider);
    await r.upsertRecipient('default', '15551230000', { name: 'A', recipientPhone: '91A', payoutMethod: 'bank', payoutDestination: '111122223333', lastUsedAt: '2026-06-01T00:00:00.000Z' });
    await r.upsertRecipient('default', '15551230000', { name: 'B', recipientPhone: '91B', payoutMethod: 'bank', payoutDestination: '444455556666', lastUsedAt: '2026-06-05T00:00:00.000Z' });
    const list = await r.listRecipients('default', '15551230000', 1);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('B');
    expect(list[0].payoutDestination).toBe('444455556666');
    // F45/F47: partner B cannot overwrite or read partner A's saved destination for the same sender + recipient.
    await r.upsertRecipient('acme', '15551230000', { name: 'B', recipientPhone: '91B', payoutMethod: 'bank', payoutDestination: '999999999999', lastUsedAt: '2026-06-06T00:00:00.000Z' });
    expect((await r.listRecipients('default', '15551230000', 5)).find((x) => x.recipientPhone === '91B')!.payoutDestination).toBe('444455556666');
    expect((await r.listRecipients('acme', '15551230000', 5)).map((x) => x.payoutDestination)).toEqual(['999999999999']);
    expect(await r.listRecipients('globex', '15551230000', 5)).toEqual([]);
  });
```

1.3 Run and expect failure:

```bash
npx vitest run tests/pg-repos.test.ts tests/customer-store.test.ts
```

Expected: TypeScript-level failures such as `Expected 1-2 arguments, but got 2` / `Property 'findByPhone' does not exist` (vitest transpiles without typecheck, so at runtime the calls run against the OLD signature: `getCustomer('default', PHONE)` queries `phone = 'default'` ⇒ `null`, and the sibling assertion `expect(dflt.partnerId).toBe('default')` fails with `expected 'acme' to be 'default'` — the F44 re-home reproduced).

1.4 Commit the red state:

```
test(customers): invert the follow-the-number tests — a partner-signed inbound must never re-home another tenant's customer (F44)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 2 — Schema, migration 0015, customer repo, recipient repo (GREEN for Step 1)

2.1 `src/db/schema.ts` — replace lines 197-239 (`customers`) and 396-406 (`recipients`). `primaryKey` and `index` are already imported (used at :75 and :239 respectively); `partners` is declared above `customers` (customers already references it at :201).

```ts
export const customers = pgTable(
  'customers',
  {
    // Tenant-scoped identity (fix 1 / F44): a phone is NOT a global key. The same
    // number can be a customer of several partners, each with its OWN row (own
    // kyc_status, own encrypted PII, own password). PK (partner_id, phone).
    phone: text('phone').notNull(), // senderPhone
    partnerId: text('partner_id').notNull().references(() => partners.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    senderCountry: text('sender_country').notNull(),
    kycStatus: text('kyc_status').notNull().default('not_started'),
    kycReviewState: text('kyc_review_state'),
    kycInquiryId: text('kyc_inquiry_id'),
    kycProviderRef: text('kyc_provider_ref'),
    kycRejectedReason: text('kyc_rejected_reason'),
    kycVerifiedAt: timestamp('kyc_verified_at', { withTimezone: true }),
    kycSubmittedAt: timestamp('kyc_submitted_at', { withTimezone: true }),
    kycApprovedBy: text('kyc_approved_by'),
    kycApprovedAt: timestamp('kyc_approved_at', { withTimezone: true }),
    kycRejectedAt: timestamp('kyc_rejected_at', { withTimezone: true }),
    fullNameEnc: text('full_name_enc'), // ENCRYPTED
    dateOfBirthEnc: text('date_of_birth_enc'), // ENCRYPTED
    residentialAddressEnc: text('residential_address_enc'), // ENCRYPTED
    emailEnc: text('email_enc'), // ENCRYPTED
    govIdNumberEnc: text('gov_id_number_enc'), // ENCRYPTED
    govIdType: text('gov_id_type'),
    idLast4: text('id_last4'),
    idDocType: text('id_doc_type'),
    nationality: text('nationality'),
    pepDeclared: boolean('pep_declared'),
    watchlistHit: boolean('watchlist_hit'),
    pepHit: boolean('pep_hit'),
    sourceOfFunds: text('source_of_funds'),
    occupation: text('occupation'),
    eddCapturedAt: timestamp('edd_captured_at', { withTimezone: true }),
    lastFundingMethod: text('last_funding_method'),
    lastFundingMethodAt: timestamp('last_funding_method_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    optInAt: timestamp('opt_in_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.partnerId, t.phone] }),
    index('customers_partner_created').on(t.partnerId, t.createdAt.desc()),
    // The three legitimate phone-alone lookups (portal login, platform-staff
    // detail page, Persona webhook) go through customer-repo.findByPhone — indexed.
    index('customers_phone').on(t.phone),
  ],
);
```

```ts
// Per-sender saved recipients. Holds full bank accounts → encrypted. The
// address book is per (TENANT, sender): partner B can never read or overwrite
// partner A's saved payout destinations for the same phone (fix 1 / F45, F47).
export const recipients = pgTable(
  'recipients',
  {
    partnerId: text('partner_id').notNull().references(() => partners.id),
    senderPhone: text('sender_phone').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    name: text('name').notNull(),
    payoutMethod: text('payout_method').notNull(),
    payoutDestinationEnc: text('payout_destination_enc').notNull(), // ENCRYPTED
    payoutDestinationLast4: text('payout_destination_last4').notNull().default(''),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.partnerId, t.senderPhone, t.recipientPhone] })],
);
```

And `partnerIntegrations` (schema.ts:242-255, currently a two-argument `pgTable` with no index list) gains a third argument — D11, the routing lock:

```ts
  (t) => [
    // D11 (fix 1): a WhatsApp phone_number_id routes inbound traffic to ONE
    // tenant, so it may be held by ONE partner. Partial: partners without a
    // BYO number keep NULL. The write-time refusal lives in partners/actions.ts;
    // this index is the last line against a race or a hand-edited row.
    uniqueIndex('partner_integrations_wa_pnid')
      .on(t.waPhoneNumberId)
      .where(sql`${t.waPhoneNumberId} IS NOT NULL`),
  ],
```
(`uniqueIndex` and `sql` are already imported — used by the `outbox` block.)

2.2 Generate the migration (journal is at idx 14 after Step 1.1; `drizzle.config.ts` points `out` at `./drizzle`). **Snapshot chain — read before running the generator:** `drizzle-kit generate` diffs the schema against the NEWEST `drizzle/meta/*_snapshot.json`, which is `0013_snapshot.json` — fix 7's `0014_outbox_lease` was hand-written with NO snapshot. The generated 0015 SQL will therefore ALSO contain fix 7's already-applied outbox DDL (`lease_until`, `lease_owner`, the two index changes). That is expected: you overwrite the SQL below anyway, and `0015_snapshot.json` (which you keep) correctly describes the full target schema INCLUDING the outbox columns, which is exactly why Task 10's later `0017` generates cleanly against `0015_snapshot.json` (Task 11's 0016 is data-only, no snapshot) with exactly one ALTER. Do NOT "fix" the chain by hand-adding a 0014 or 0016 snapshot. Gate: after overwriting, `git diff --stat drizzle/` must list exactly three files — `drizzle/0015_tenant_scoped_customers.sql`, `drizzle/meta/0015_snapshot.json`, `drizzle/meta/_journal.json`.

`npx drizzle-kit generate` needs NO `DATABASE_URL` (it diffs `src/db/schema.ts` against the snapshot; `drizzle.config.ts` tolerates an empty `dbCredentials.url`) and must show NO interactive "created or renamed?" prompt — no column is dropped in `customers`, `recipients` or `outbox`, only added/re-keyed. If a rename prompt appears, abort (Ctrl-C), re-read the schema diff and fix it: a wrong "renamed" answer corrupts `0015_snapshot.json`, which Task 10's `0017` generates against.

```bash
cd ~/dev/wt/partner-api && npx drizzle-kit generate --name tenant_scoped_customers
ls drizzle | tail -2          # expect 0014_outbox_lease.sql  0015_tenant_scoped_customers.sql
tail -8 drizzle/meta/_journal.json   # expect "idx": 15, "tag": "0015_tenant_scoped_customers"
cat drizzle/0015_tenant_scoped_customers.sql
```

Journal ordering gate: fix 7's hand-written 0014 entry carries a LITERAL `when` (1789508339133 ≈ 2026-09-16T02:32Z), and drizzle's migrator applies only entries whose `when` exceeds the last applied `created_at`; `drizzle-kit generate` stamps 0015 with `Date.now()`, which is later than that literal on any run after that instant (true in practice) — verify it in the `tail -8` output (`0015.when > 1789508339133`) before continuing, exactly like the "idx 14 must exist" gate in Step 1.1.

drizzle-kit emits `ALTER TABLE "recipients" ADD COLUMN "partner_id" text NOT NULL;` which FAILS on a populated table, and it cannot know the backfill. Overwrite the generated `drizzle/0015_tenant_scoped_customers.sql` with exactly this (keep `--> statement-breakpoint` between statements — the migrator splits on it; leave `drizzle/meta/0015_snapshot.json` as generated, it describes the target schema, not the path):

```sql
ALTER TABLE "customers" DROP CONSTRAINT "customers_pkey";--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_partner_id_phone_pk" PRIMARY KEY("partner_id","phone");--> statement-breakpoint
CREATE INDEX "customers_phone" ON "customers" USING btree ("phone");--> statement-breakpoint
ALTER TABLE "recipients" ADD COLUMN "partner_id" text;--> statement-breakpoint
UPDATE "recipients" r SET "partner_id" = COALESCE((SELECT t."partner_id" FROM "transfers" t WHERE t."phone" = r."sender_phone" AND t."recipient_phone" = r."recipient_phone" ORDER BY t."created_at" DESC LIMIT 1), (SELECT c."partner_id" FROM "customers" c WHERE c."phone" = r."sender_phone" ORDER BY c."created_at" LIMIT 1), 'default');--> statement-breakpoint
ALTER TABLE "recipients" ALTER COLUMN "partner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recipients" DROP CONSTRAINT "recipients_sender_phone_recipient_phone_pk";--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_partner_id_sender_phone_recipient_phone_pk" PRIMARY KEY("partner_id","sender_phone","recipient_phone");--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_integrations_wa_pnid" ON "partner_integrations" USING btree ("wa_phone_number_id") WHERE "partner_integrations"."wa_phone_number_id" IS NOT NULL;
```

Data move to state in the PR (Step 12.3): the recipients backfill attributes every existing address-book row **by the ledger first** — the tenant of the LATEST transfer from that sender to that recipient phone — and only for a (sender, recipient) pair with no transfer at all falls back to the phone's oldest `customers` row, else `'default'`. The ledger comes first, unconditionally (no query-dependent switch), because the pre-fix partner API minted and called `upsertRecipient` unconditionally (`transfer-create.ts:238`) WITHOUT writing a `customers` row: for such a sender a customers-first rule would file every acme-supplied payout destination (full encrypted bank accounts) under `'default'`, where the default bot's recipient picker would mint against them (the F45/F47 shape, baked in by the backfill) and acme would lose them. Every recipient row `createTransfer` ever wrote has a matching transfer (same `phone` + `recipient_phone`, written in the same call), so the ledger branch covers every API-minted row; the customers branch only ever decides rows the bot saved without a completed send. Pre-apply query (d) — run against prod Neon before the branch is cut AND immediately before merge, record its output in the PR — counts the rows whose ledger tenant differs from what the old customers-first rule would have chosen, INCLUDING senders with no customers row at all (a `JOIN customers` would hide exactly those): `SELECT count(*) FROM recipients r JOIN transfers t ON t.phone = r.sender_phone AND t.recipient_phone = r.recipient_phone WHERE t.partner_id <> COALESCE((SELECT c.partner_id FROM customers c WHERE c.phone = r.sender_phone ORDER BY c.created_at LIMIT 1), 'default');` — a non-zero count is the number of address-book rows the ledger-first rule saves from mis-filing; zero means the two rules agree on today's data and the ledger-first UPDATE stays anyway (it is the correct rule, not a contingency). Step 2.6 runs 0015 on PGlite, which proves the correlated-subquery UPDATE applies.

**Pre-apply checks (read-only against prod Neon — run BEFORE cutting the branch AND repeat immediately before merge; record the outputs in the PR):**
(a) `SELECT wa_phone_number_id, count(*) FROM partner_integrations WHERE wa_phone_number_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;` must return zero rows;
(b) `SELECT partner_id FROM partner_integrations WHERE wa_phone_number_id = '<the value of WHATSAPP_PHONE_NUMBER_ID, read from the runtime env, never pasted into the PR>'` must return zero rows. If (a) or (b) returns rows, that is the D11 attack shape already present in prod — STOP, clear the offending row(s) with the owner, then apply;
(c) `SELECT partner_id FROM partner_integrations WHERE wa_phone_number_id IS NOT NULL AND wa_app_secret_enc IS NULL;` — any row is a production partner whose inbound traffic Step 5A's fail-closed webhook would 401 from the moment it deploys (a customer-channel outage on a security-critical change). Any row ⇒ STOP: configure that partner's app secret in its WhatsApp tab and prove a signed test event verifies (200), OR ship Step 5A.3's variant B and record the owner decision in the PR body. Never merge with (c) non-empty and the fail-closed variant.

**Constraint-name verification (done for this plan; re-check on the branch and cite in the PR):** no foreign key references `customers.phone` — the only FK on `customers` is `customers → partners` (`drizzle/meta/0013_snapshot.json`), so `ALTER TABLE "customers" DROP CONSTRAINT "customers_pkey"` cannot cascade; and the recipients composite PK is named `recipients_sender_phone_recipient_phone_pk` (`drizzle/0000_workable_giant_girl.sql:160`), so the DROP CONSTRAINT above matches. This is the "grep before overwriting" the plan asks for — paste both greps.

Verify the constraint names the generator chose match (`grep -n "pk\|pkey" drizzle/0015_tenant_scoped_customers.sql` before overwriting; the customers column-level PK was created as `"phone" text PRIMARY KEY NOT NULL` in `drizzle/0000_workable_giant_girl.sql`, which Postgres names `customers_pkey`; the recipients composite PK name is in `drizzle/meta/0013_snapshot.json` → `recipients_sender_phone_recipient_phone_pk`). The customers backfill is a no-op: `partner_id` is already NOT NULL on every row (schema.ts:201). PGlite (`tests/helpers-db.ts:26` runs `migrate(db, { migrationsFolder: './drizzle' })`) proves the file applies in Step 2.6.

2.3 `src/db/repos/customer-repo.ts` — imports become:

```ts
import { and, asc, eq, sql } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { openOptional, sealOptional } from './mappers';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import { countryForPhone } from '@/lib/partner-currency';
import type {
  CountryCode,
  Customer,
  FundingMethod,
  GovIdType,
  KycReviewState,
  KycStatus,
  Occupation,
  PartnerId,
  SourceOfFunds,
} from '@/lib/types';
```

Replace the header comment (lines 19-30) with:

```ts
// customer-repo — mirrors customer-store's surface. PII at rest: fullName, DOB,
// residentialAddress, govIdNumber are envelope-encrypted into *_enc columns and
// DECRYPTED BY DEFAULT on read — the agent's hot path screens sanctions against
// customer.fullName, so masked reads here would break compliance. (`email` is
// special: the domain value is ALREADY a field-crypto blob written by
// customer-auth-store, so it passes through email_enc verbatim — no double
// encryption.)
//
// TENANT IDENTITY (fix 1 / F44): the key is (partner_id, phone). Every read and
// write takes partnerId FIRST and carries it in the WHERE; a phone alone never
// selects a row. The one cross-tenant read is findByPhone, used by portal auth,
// the platform-staff detail page and the Persona webhook only. upsertOnFirstInbound
// NEVER moves a row between tenants — a partner-signed inbound for a phone that
// exists under another partner creates that partner's OWN sibling row. The
// grandfather check is the indexed MIN(created_at) for (partner, phone).
```

Replace the factory signature (line 36-40) and everything from `return {` (line 132) to the end of the factory with (rowToCustomer and customerToRow are unchanged):

```ts
export function createCustomerRepo(
  db: DbOrTx,
  firstTransferAt: (partnerId: PartnerId, phone: string) => Promise<string | null>,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  function rowToCustomer(row: CustomerRow): Customer { /* unchanged */ }
  function customerToRow(c: Customer): typeof customers.$inferInsert { /* unchanged */ }

  // The tenant key — the WHERE of every scoped read/write below.
  const tenantKey = (partnerId: PartnerId, phone: string) =>
    and(eq(customers.partnerId, partnerId), eq(customers.phone, phone));

  function freshCustomer(
    partnerId: PartnerId,
    senderPhone: string,
    nowIso: string,
    minAt: string | null,
    optIn: boolean,
  ): Customer {
    const inferredCountry = countryForPhone(senderPhone) ?? DEFAULT_SENDER_COUNTRY;
    // createdAt is NEVER backdated (D9 invariant): the grandfather branch keeps
    // firstSeenAt = minAt (the tenant's earliest transfer) but stamps
    // createdAt = nowIso, so every row created after fix 1 sorts strictly AFTER
    // every pre-fix row in findByPhone — legacy-tenant.ts's "oldest row is the
    // pre-fix owner" rule depends on it. (Pre-fix the partner API minted without
    // a customers row, so a sibling backdated to its first transfer could sort
    // before — or tie with — the real pre-fix owner and inherit its legacy
    // kyc_audit / conv / counters.) Safe: tier-rules, kyc-gate, compliance and
    // customer-summary never read createdAt, and no test asserts a grandfathered
    // row's createdAt.
    const base: Customer = minAt
      ? {
          senderPhone,
          firstSeenAt: minAt,
          kycStatus: 'grandfathered',
          kycVerifiedAt: nowIso,
          senderCountry: inferredCountry,
          partnerId,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      : {
          senderPhone,
          firstSeenAt: nowIso,
          kycStatus: 'not_started',
          senderCountry: inferredCountry,
          partnerId,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
    return optIn ? { ...base, optInAt: nowIso } : base;
  }

  return {
    async getCustomer(partnerId: PartnerId, senderPhone: string): Promise<Customer | null> {
      const rows = await db.select().from(customers).where(tenantKey(partnerId, senderPhone)).limit(1);
      return rows[0] ? rowToCustomer(rows[0]) : null;
    },

    /**
     * Every tenant's row for a phone (oldest first). The ONLY phone-alone read;
     * callers must resolve exactly one row themselves and fail closed otherwise.
     */
    async findByPhone(senderPhone: string): Promise<Customer[]> {
      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, senderPhone))
        .orderBy(asc(customers.createdAt), asc(customers.partnerId));
      return rows.map(rowToCustomer);
    },

    async saveCustomer(customer: Customer): Promise<void> {
      const row = customerToRow(customer);
      await db
        .insert(customers)
        .values(row)
        .onConflictDoUpdate({ target: [customers.partnerId, customers.phone], set: row });
    },

    /**
     * Resolve-or-create WITHOUT implying WhatsApp consent (no optInAt). The
     * partner API mints for senders who never messaged anyone; opt-in is a
     * channel fact recorded only by the inbound webhook (upsertOnFirstInbound).
     */
    async ensureCustomer(partnerId: PartnerId, senderPhone: string): Promise<Customer> {
      const existing = await this.getCustomer(partnerId, senderPhone);
      if (existing) return existing;
      const nowIso = new Date().toISOString();
      const minAt = await firstTransferAt(partnerId, senderPhone);
      const customer = freshCustomer(partnerId, senderPhone, nowIso, minAt, false);
      await db.insert(customers).values(customerToRow(customer)).onConflictDoNothing();
      return (await this.getCustomer(partnerId, senderPhone)) ?? customer;
    },

    async upsertOnFirstInbound(
      partnerId: PartnerId,
      senderPhone: string,
    ): Promise<{ customer: Customer; wasCreated: boolean }> {
      const existing = await this.getCustomer(partnerId, senderPhone);
      if (existing) {
        // Opt-in backfill (first-contact-wins). NO partner_id rewrite: the
        // tenant is fixed by the key; another tenant's row is invisible here.
        if (!existing.optInAt) {
          const nowIso = new Date().toISOString();
          const updated: Customer = { ...existing, optInAt: nowIso, updatedAt: nowIso };
          await this.saveCustomer(updated);
          return { customer: updated, wasCreated: false };
        }
        return { customer: existing, wasCreated: false };
      }
      const nowIso = new Date().toISOString();
      // Grandfathering is per tenant: only THIS partner's ledger history counts.
      const minAt = await firstTransferAt(partnerId, senderPhone);
      const customer = freshCustomer(partnerId, senderPhone, nowIso, minAt, true);
      await this.saveCustomer(customer);
      return { customer, wasCreated: !minAt };
    },

    async setOptedIn(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optInAt: sql`COALESCE(${customers.optInAt}, now())`, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async setOptedOut(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: new Date(), updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async clearOptedOut(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: null, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async recordFundingMethod(partnerId: PartnerId, senderPhone: string, method: FundingMethod): Promise<void> {
      await db
        .update(customers)
        .set({ lastFundingMethod: method, lastFundingMethodAt: new Date(), updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async recordKycInquiry(partnerId: PartnerId, senderPhone: string, inquiryId: string): Promise<void> {
      await db
        .update(customers)
        .set({
          kycInquiryId: inquiryId,
          kycProviderRef: inquiryId,
          kycSubmittedAt: sql`COALESCE(${customers.kycSubmittedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(tenantKey(partnerId, senderPhone));
    },

    /** Platform-wide when partnerId is absent; tenant-scoped at the WHERE otherwise. */
    async listCustomers(partnerId?: PartnerId): Promise<Customer[]> {
      const rows = partnerId
        ? await db.select().from(customers).where(eq(customers.partnerId, partnerId)).orderBy(asc(customers.createdAt))
        : await db.select().from(customers).orderBy(asc(customers.createdAt));
      return rows.map(rowToCustomer);
    },
  };
}
```

`DEFAULT_PARTNER_ID` stays imported (still used by `customerToRow` at line 92).

2.4 `src/lib/customer-store.ts` line 16 becomes:

```ts
export function createCustomerStore(db: DbOrTx, store: Store) {
  return createCustomerRepo(db, (partnerId, phone) => store.firstTransferAt(partnerId, phone));
}
```

and the header comment's "WL2 follow-the-number" clause (lines 10-12) becomes `upsertOnFirstInbound keeps grandfathering + opt-in backfill; the key is (partnerId, phone) and rows never move between tenants (fix 1).`

2.5 `src/db/repos/aux-repos.ts` lines 39-80 — `createRecipientRepo` becomes:

```ts
// ── Saved recipients (per-TENANT, per-sender address book) ──────────────────
export function createRecipientRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  return {
    async upsertRecipient(partnerId: PartnerId, senderPhone: string, r: Recipient): Promise<void> {
      const row = {
        partnerId,
        senderPhone,
        recipientPhone: r.recipientPhone,
        name: r.name,
        payoutMethod: r.payoutMethod,
        payoutDestinationEnc: r.payoutDestination ? encryptField(r.payoutDestination, provider) : '',
        payoutDestinationLast4: last4(r.payoutDestination ?? ''),
        lastUsedAt: new Date(r.lastUsedAt),
      };
      await db
        .insert(recipients)
        .values(row)
        .onConflictDoUpdate({
          target: [recipients.partnerId, recipients.senderPhone, recipients.recipientPhone],
          set: row,
        });
    },

    async listRecipients(partnerId: PartnerId, senderPhone: string, limit: number): Promise<Recipient[]> {
      const rows = await db
        .select()
        .from(recipients)
        .where(and(eq(recipients.partnerId, partnerId), eq(recipients.senderPhone, senderPhone)))
        .orderBy(desc(recipients.lastUsedAt))
        .limit(limit);
      return rows.map((row) => ({
        name: row.name,
        recipientPhone: row.recipientPhone,
        payoutMethod: row.payoutMethod as PayoutMethod,
        payoutDestination: openOptional(row.payoutDestinationEnc, provider) ?? '',
        lastUsedAt: row.lastUsedAt.toISOString(),
      }));
    },
  };
}
```

Line 1 import becomes `import { and, desc, eq, sql } from 'drizzle-orm';` (`PartnerId` is already in the type import at :26).

2.6 Run:

```bash
npx vitest run tests/pg-repos.test.ts tests/customer-store.test.ts
```

Expected: `pg-repos.test.ts` green (the migration applied in PGlite, composite PK honoured). `customer-store.test.ts`: the new describe is green; the other ~40 calls in that file still use the old one-argument shape and fail at runtime (`getCustomer(PHONE)` ⇒ null). Fix them mechanically — every call on `cs` in that file gains `'default', ` as first argument:

```bash
sed -i '' -E "s/cs\.(getCustomer|upsertOnFirstInbound|setOptedIn|setOptedOut|clearOptedOut|recordFundingMethod|recordKycInquiry)\(('15550008888'|PHONE)/cs.\1('default', \2/g" tests/customer-store.test.ts
grep -n "cs\.\(getCustomer\|upsertOnFirstInbound\|setOpted\|clearOpted\|record\)(" tests/customer-store.test.ts | grep -v "'default'\|'acme'"   # must print nothing
npx vitest run tests/pg-repos.test.ts tests/customer-store.test.ts
```

Expected: both files green (`Tests  N passed`).

2.7 Commit:

```
feat(db): key customers and recipients by (partner_id, phone) — migration 0015, sibling rows instead of follow-the-number (F44, F45, F47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 3 — Ledger reads and the Redis counters keyed by tenant (store, transfer-repo, daily/monthly volume)

3.1 Failing tests. `tests/store.test.ts` — replace the `describe('firstTransferAt')` and `describe('store velocity counter')` blocks (lines 100-136) with:

```ts
describe('firstTransferAt (tenant-scoped)', () => {
  it('returns null when the phone has no transfers under this tenant', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.firstTransferAt('default', 'p')).toBeNull();
  });

  it('returns the earliest createdAt for (partner, phone) — another tenant\'s rows do not grandfather', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('t2', '2026-05-21T02:00:00.000Z', 'p'));
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p'));
    expect(await store.firstTransferAt('default', 'p')).toBe('2026-05-21T01:00:00.000Z');
    expect(await store.firstTransferAt('acme', 'p')).toBeNull();
    expect(await store.getTransferCount('default', 'p')).toBe(2);
    expect(await store.getTransferCount('acme', 'p')).toBe(0);
    expect((await store.listTransfersByPhone('default', 'p')).map((t) => t.id)).toEqual(['t2', 't1']);
    expect(await store.listTransfersByPhone('acme', 'p')).toEqual([]);
  });
});

describe('store velocity counter (tenant-scoped)', () => {
  it('defaults today count to 0 and increments', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.getTodayTransferCount('default', 'p')).toBe(0);
    await store.incrementTodayTransferCount('default', 'p');
    await store.incrementTodayTransferCount('default', 'p');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(2);
  });

  it('velocity is isolated per (partner, phone) — a partner-API mint never inflates another tenant\'s counter', async () => {
    const store = createStore(fakeRedis(), db);
    await store.incrementTodayTransferCount('default', 'p1');
    expect(await store.getTodayTransferCount('default', 'p1')).toBe(1);
    expect(await store.getTodayTransferCount('acme', 'p1')).toBe(0);
    expect(await store.getTodayTransferCount('default', 'p2')).toBe(0);
  });

  it('uses velocity:{partnerId}:{phone}:{easternDate}', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.incrementTodayTransferCount('default', 'p');
    expect(redis.dump.has(`velocity:default:p:${easternDate(Date.now())}`)).toBe(true);
  });

  it('TRANSITIONAL: reads fall back to the legacy phone-only key for one window — ONLY for the phone\'s pre-fix (oldest-row) tenant; the first increment absorbs it', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    // Pre-fix state: the phone has exactly ONE customer row, under default.
    await createCustomerStore(db, store).upsertOnFirstInbound('default', 'p');
    await redis.set(`velocity:p:${easternDate(Date.now())}`, '3');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(3);
    await store.incrementTodayTransferCount('default', 'p');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(4);
  });

  it('TRANSITIONAL: a post-fix sibling tenant NEVER reads the legacy key (D3 — no cross-tenant compliance oracle)', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const cs = createCustomerStore(db, store);
    // The pre-fix owner is seeded with an EXPLICIT createdAt one minute in the past: two
    // upsertOnFirstInbound calls can land in the same millisecond, and findByPhone's
    // asc(partnerId) tie-break would then make 'acme' the "oldest" row (flake).
    const T0 = new Date(Date.now() - 60_000).toISOString();
    await cs.saveCustomer({ senderPhone: 'p', firstSeenAt: T0, kycStatus: 'not_started', senderCountry: 'US', partnerId: 'default', optInAt: T0, createdAt: T0, updatedAt: T0 }); // pre-fix owner
    await cs.upsertOnFirstInbound('acme', 'p');    // post-fix sibling (createdAt = now, strictly later)
    await redis.set(`velocity:p:${easternDate(Date.now())}`, '3');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(3);
    expect(await store.getTodayTransferCount('acme', 'p')).toBe(0);
    // No customer row at all ⇒ no legacy read either (fail closed).
    await redis.set(`velocity:q:${easternDate(Date.now())}`, '9');
    expect(await store.getTodayTransferCount('default', 'q')).toBe(0);
  });
});
```

(`import { createCustomerStore } from '@/lib/customer-store';` at the top of `tests/store.test.ts`.)

The same rule lives in ONE helper. Create `tests/legacy-tenant.test.ts` (pure, no DB):

```ts
import { describe, it, expect } from 'vitest';
import { legacyTenantResolver, legacyKeyAllowed } from '@/lib/legacy-tenant';
import type { Customer } from '@/lib/types';

const row = (partnerId: string, createdAt: string) =>
  ({ senderPhone: 'p', partnerId, createdAt, updatedAt: createdAt, firstSeenAt: createdAt, kycStatus: 'not_started', senderCountry: 'US' }) as Customer;

describe('legacy-tenant (fix 1 D9/D10/D12): the pre-fix tenant is the OLDEST row', () => {
  it('resolves the oldest row\'s partner; null when the phone has no row', async () => {
    const resolve = legacyTenantResolver({ findByPhone: async () => [row('default', '2026-01-01T00:00:00Z'), row('acme', '2026-09-20T00:00:00Z')] });
    expect(await resolve('p')).toBe('default');
    expect(await legacyTenantResolver({ findByPhone: async () => [] })('p')).toBeNull();
  });
  it('legacyKeyAllowed is true only for that tenant, and false with no resolver (fail closed)', async () => {
    const resolve = legacyTenantResolver({ findByPhone: async () => [row('default', '2026-01-01T00:00:00Z'), row('acme', '2026-09-20T00:00:00Z')] });
    expect(await legacyKeyAllowed('default', 'p', resolve)).toBe(true);
    expect(await legacyKeyAllowed('acme', 'p', resolve)).toBe(false);
    expect(await legacyKeyAllowed('default', 'p', undefined)).toBe(false);
  });
});
```

`tests/transfer-repo.test.ts` lines 179-181 become `repo.firstTransferAt('default', '15551230000')`, `repo.firstTransferAt('default', '19990000000')`, `repo.countByPhone('default', '15551230000')`.

`tests/recipient-store.test.ts`: every `store.upsertRecipient(SENDER,` / `store.upsertRecipient(OTHER,` / `store.listRecipients(SENDER,` / `store.listRecipients(OTHER,` gains `'default', ` first (`sed -i '' -E "s/store\.(upsertRecipient|listRecipients)\((SENDER|OTHER),/store.\1('default', \2,/g" tests/recipient-store.test.ts`; also any `createTransfer(...)` call in that file already passes `partnerId: 'default'`), and add inside `describe('recipient store')`:

```ts
  it('is partner-scoped: partner B cannot overwrite or read partner A\'s saved recipient for the same sender phone', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    const store = createStore(fakeRedis(), db);
    await store.upsertRecipient('default', SENDER, mom('2026-05-23T12:00:00.000Z'));
    await store.upsertRecipient('acme', SENDER, { ...mom('2026-05-24T12:00:00.000Z'), payoutDestination: 'evil@upi' });
    expect((await store.listRecipients('default', SENDER, 3))[0].payoutDestination).toBe('mom@upi');
    expect((await store.listRecipients('acme', SENDER, 3))[0].payoutDestination).toBe('evil@upi');
    expect(await store.listRecipients('globex', SENDER, 3)).toEqual([]);
  });
```

`tests/daily-volume-store.test.ts` and `tests/monthly-volume-store.test.ts`: every `dvs.addCents(PHONE,` / `dvs.getTodayCents(PHONE)` / `dvs.getTodayCents(OTHER)` (and `mvs.addCents(PHONE,` / `mvs.getMonthCents(...)`) gains `'default', ` first (`sed -i '' -E "s/\.(addCents|getTodayCents|getMonthCents)\((PHONE|OTHER)/.\1('default', \2/g" tests/daily-volume-store.test.ts tests/monthly-volume-store.test.ts`), and each file gains two tests:

```ts
  it('keys on (partnerId, phone): the same phone under two tenants has two counters', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents('default', PHONE, 30_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(0);
    await dvs.addCents('acme', PHONE, 5_000);
    expect(await dvs.getTodayCents('default', PHONE)).toBe(30_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(5_000);
  });

  it('TRANSITIONAL: the legacy phone-only key is read (and absorbed on the next add) so an in-flight cap is not reset — for the pre-fix tenant only', async () => {
    const redis = fakeRedis();
    await redis.set(`daily_volume:${PHONE}:2026-05-24`, '12000');
    // The store is handed the D9 resolver; here the phone's oldest row belongs to default.
    const dvs = createDailyVolumeStore(redis, async () => 'default');
    expect(await dvs.getTodayCents('default', PHONE)).toBe(12_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(0); // a post-fix sibling never inherits it
    await dvs.addCents('default', PHONE, 1_000);
    expect(await dvs.getTodayCents('default', PHONE)).toBe(13_000);
    // Without a resolver (the constructor default) there is NO fallback — fail closed.
    expect(await createDailyVolumeStore(redis).getTodayCents('default', '15550009999')).toBe(0);
  });
```

(the monthly copy uses `monthly_volume:${PHONE}:2026-05` and `getMonthCents`; the pinned clock is `2026-05-24T18:00:00Z` = 2 pm ET in both files, lines 9-12).

3.2 Run and expect failure:

```bash
npx vitest run tests/store.test.ts tests/transfer-repo.test.ts tests/recipient-store.test.ts tests/daily-volume-store.test.ts tests/monthly-volume-store.test.ts
```

Expected: `store.test.ts` velocity key assertion fails (`expected false to be true` — key is `velocity:default:p:…` vs actual `velocity:default:…`), the isolation tests fail (`expected 1 to be 0`), `transfer-repo` `expected 0 to be 2`, volume isolation `expected 30000 to be 0`.

3.3 Implement. First the shared rule — create `src/lib/legacy-tenant.ts`:

```ts
import type { Customer, PartnerId } from './types';

// legacy-tenant (fix 1, D9/D10/D12) — the ONE encoding of "which tenant may
// read a pre-fix, phone-only Redis key". Before fix 1 a phone had exactly one
// customers row, so the OLDEST row for a phone is its pre-fix owner and any
// later row is a post-fix sibling that must never inherit the other tenant's
// counters, KYC audit trail or conversation (D3: no cross-tenant oracle).
// Zero rows ⇒ no fallback (fail closed).
//
// INVARIANT THIS DEPENDS ON: customers.createdAt is NEVER backdated.
// customer-repo.freshCustomer stamps createdAt = now in BOTH branches (a
// grandfathered row backdates firstSeenAt only), so a row created after the
// fix always sorts after every pre-fix row. If any writer ever backdates
// createdAt, a post-fix sibling can become "the oldest row" and read the real
// owner's kyc_audit (no TTL — permanent), conv and counters.
//
// Lifetime: fix 10 removes the velocity/daily/monthly callers (the counters
// go away). The conv: (30-day TTL) and kyc_audit: (no TTL) fallbacks keep
// calling this helper after fix 10 — do not delete it with the counters.

export type LegacyTenantOf = (phone: string) => Promise<PartnerId | null>;

/** findByPhone is oldest-first (customer-repo orders by created_at, partner_id). */
export function legacyTenantResolver(customers: { findByPhone(phone: string): Promise<Customer[]> }): LegacyTenantOf {
  return async (phone) => (await customers.findByPhone(phone))[0]?.partnerId ?? null;
}

export async function legacyKeyAllowed(partnerId: PartnerId, phone: string, legacyTenantOf: LegacyTenantOf | undefined): Promise<boolean> {
  if (!legacyTenantOf) return false;
  return (await legacyTenantOf(phone)) === partnerId;
}
```

`createStore(redis, db)` builds the resolver once (`store.ts`, after the repo factories): `const legacyTenantOf = legacyTenantResolver(createCustomerRepo(db, (p, ph) => transfersRepo.firstTransferAt(p, ph)));` (no import cycle — `customer-repo` is a `db/repos` module the store already imports its siblings from) and EXPOSES it as `legacyTenantOf` on the returned object so `getDailyVolumeStore()` / `getMonthlyVolumeStore()` (`createDailyVolumeStore(getRedis(), getStore().legacyTenantOf)`) and `kyc-case-store` can share it. The volume-store factories gain an OPTIONAL second parameter `legacyTenantOf?: LegacyTenantOf` — absent ⇒ no fallback — so the ~40 existing `createDailyVolumeStore(fakeRedis())` test call sites keep compiling and fail closed.

Then `src/db/repos/transfer-repo.ts` lines 350-352, 364-370, 380-386:

```ts
    /** Indexed per-(tenant, customer) page — a phone alone is not an identity (fix 1). */
    listByPhone(partnerId: PartnerId, phone: string, req: PageReq): Promise<Page<Transfer>> {
      return page(and(eq(transfers.partnerId, partnerId), eq(transfers.phone, phone)), req);
    },
```

```ts
    /** Replaces the full-ledger scan in upsertOnFirstInbound (grandfathering, per tenant). */
    async firstTransferAt(partnerId: PartnerId, phone: string): Promise<string | null> {
      const rows = await db
        .select({ min: sql<string | null>`min(${transfers.createdAt})` })
        .from(transfers)
        .where(and(eq(transfers.partnerId, partnerId), eq(transfers.phone, phone)));
      const v = rows[0]?.min;
      return v ? new Date(v).toISOString() : null;
    },
```

```ts
    async countByPhone(partnerId: PartnerId, phone: string): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(transfers)
        .where(
          and(
            eq(transfers.partnerId, partnerId),
            eq(transfers.phone, phone),
            sql`${transfers.status} != 'blocked'`,
          ),
        );
      return rows[0]?.n ?? 0;
    },
```

`src/lib/store.ts` — line 6 becomes `import type { ChatMessage, PartnerId, Transfer, TransferStatus } from './types';`; lines 96-99, 124-140 and 198-210 become:

```ts
    /** Indexed per-(tenant, customer) list (Stage 4 + fix 1). */
    async listTransfersByPhone(partnerId: PartnerId, phone: string, limit = 50): Promise<Transfer[]> {
      return (await transfersRepo.listByPhone(partnerId, phone, { limit })).items;
    },
```

```ts
    async getTransferCount(partnerId: PartnerId, phone: string): Promise<number> {
      // Derived (blocked rows excluded) — the count:{phone} counter is gone.
      return transfersRepo.countByPhone(partnerId, phone);
    },
    /** MIN(created_at) for grandfathering — indexed, per tenant. */
    async firstTransferAt(partnerId: PartnerId, phone: string): Promise<string | null> {
      return transfersRepo.firstTransferAt(partnerId, phone);
    },

    // ── Today-velocity (Redis counters — date-bucketed, tenant-scoped) ────
    // Key shape is OWNED HERE (fix 1) and consumed by fix 10; never rename again.
    // TRANSITIONAL (delete in fix 10): a tenant key that does not exist yet reads
    // through to the pre-fix phone-only key ONLY for the phone's pre-fix tenant
    // (legacyKeyAllowed — the oldest customers row), and the first increment
    // absorbs it, so an in-flight day's count is never reset to zero by the
    // rename and a post-fix sibling tenant never inherits another tenant's count.
    async incrementTodayTransferCount(partnerId: PartnerId, phone: string): Promise<void> {
      const k = `velocity:${partnerId}:${phone}:${easternDate(Date.now())}`;
      if ((await redis.exists(k)) === 0 && (await legacyKeyAllowed(partnerId, phone, legacyTenantOf))) {
        const legacy = Number((await redis.get(`velocity:${phone}:${easternDate(Date.now())}`)) ?? '0');
        if (legacy > 0) await redis.set(k, String(legacy), { ex: 48 * 3600 });
      }
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 48 * 3600);
    },
    async getTodayTransferCount(partnerId: PartnerId, phone: string): Promise<number> {
      const raw = await redis.get(`velocity:${partnerId}:${phone}:${easternDate(Date.now())}`);
      if (raw !== null) return Number(raw);
      if (!(await legacyKeyAllowed(partnerId, phone, legacyTenantOf))) return 0;
      const legacy = await redis.get(`velocity:${phone}:${easternDate(Date.now())}`);
      return legacy ? Number(legacy) : 0;
    },
```

and the conversation + last-inbound keys (D12 — `store.ts:63-69` and `:192-195`) become tenant-keyed with the same rule:

```ts
    // ── Conversations (Redis — hot, trimmed, ephemeral; keyed by TENANT + phone, fix 1 D12) ──
    // TRANSITIONAL (one 30-day window): a tenant key that does not exist reads
    // through to the pre-fix `conv:{phone}` ONLY for the phone's pre-fix tenant,
    // so a customer mid-conversation at deploy time keeps their thread and a
    // post-fix sibling tenant never sees another tenant's history. Saves always
    // write the tenant key, so the legacy key is read at most once per thread.
    async getConversation(partnerId: PartnerId, phone: string): Promise<ChatMessage[]> {
      const raw = await redis.get(`conv:${partnerId}:${phone}`);
      if (raw !== null) return JSON.parse(raw) as ChatMessage[];
      if (!(await legacyKeyAllowed(partnerId, phone, legacyTenantOf))) return [];
      const legacy = await redis.get(`conv:${phone}`);
      return legacy ? (JSON.parse(legacy) as ChatMessage[]) : [];
    },
    async saveConversation(partnerId: PartnerId, phone: string, messages: ChatMessage[]): Promise<void> {
      await redis.set(`conv:${partnerId}:${phone}`, JSON.stringify(trimHistory(messages)), { ex: 30 * 24 * 3600 });
    },
```
```ts
    async getLastInboundAt(partnerId: PartnerId, senderPhone: string): Promise<string | null> {
      return redis.get(`lastmsg:${partnerId}:${senderPhone}`); // no legacy read: a stale null only means "treat as a new conversation" once
    },
    async recordInboundNow(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await redis.set(`lastmsg:${partnerId}:${senderPhone}`, new Date().toISOString(), { ex: 86400 });
    },
```

`src/lib/draft-store.ts` (D12): `createDraft(input: Omit<Draft, 'createdAt'> & { partnerId: PartnerId })` writes the pointer at `active_draft:${input.partnerId}:${input.senderPhone}`; `getActiveDraftId(partnerId: PartnerId, phone: string)` reads `active_draft:${partnerId}:${phone}`; `consumeDraft(draftId)` clears `active_draft:${draft.partnerId ?? DEFAULT_PARTNER_ID}:${draft.senderPhone}` (a legacy in-flight draft has no `partnerId` and its pointer was phone-only — it simply expires with its 30-min TTL; nothing reads the old pointer key after deploy). Tests for these key shapes go next to the store tests (`tests/store.test.ts`: 'conv is keyed (partnerId, phone) and a sibling tenant starts empty'; `tests/tools.test.ts` Step 6: the draft cases).

```ts
    // ── Saved recipients (Postgres, encrypted, per (tenant, sender)) ─────
    async upsertRecipient(
      partnerId: PartnerId,
      senderPhone: string,
      recipient: import('./types').Recipient,
    ): Promise<void> {
      await recipientsRepo.upsertRecipient(partnerId, senderPhone, recipient);
    },
    async listRecipients(
      partnerId: PartnerId,
      senderPhone: string,
      limit: number,
    ): Promise<import('./types').Recipient[]> {
      return recipientsRepo.listRecipients(partnerId, senderPhone, limit);
    },
```

`RedisLike` already declares `exists` and `expire` (store.ts:36-37; fakeRedis implements both, tests/helpers.ts:79-86).

`src/lib/daily-volume-store.ts` (whole file):

```ts
import { getRedis } from './redis';
import { getStore } from './store';
import { easternDate } from './dates';
import { legacyKeyAllowed, type LegacyTenantOf } from './legacy-tenant';
import type { RedisLike } from './store';
import type { PartnerId } from './types';

const DAY_TTL_SECONDS = 48 * 60 * 60; // keep yesterday around for one day for late audits

// Keyed by (tenant, phone) since fix 1 — a phone is not a global identity, so a
// partner-API send for a number can never move another tenant's daily cap.
// TRANSITIONAL (delete in fix 10): an absent tenant key reads through to the
// pre-fix phone-only key ONLY for the phone's pre-fix tenant (legacyKeyAllowed,
// D9 oldest-row rule) and the next add absorbs it, so no in-flight cap resets
// and a post-fix sibling tenant never inherits another tenant's spend. With no
// resolver (tests, or a caller that has none) there is no fallback at all.
export function createDailyVolumeStore(redis: RedisLike, legacyTenantOf?: LegacyTenantOf) {
  function key(partnerId: PartnerId, senderPhone: string): string {
    return `daily_volume:${partnerId}:${senderPhone}:${easternDate(Date.now())}`;
  }
  function legacyKey(senderPhone: string): string {
    return `daily_volume:${senderPhone}:${easternDate(Date.now())}`;
  }
  async function read(partnerId: PartnerId, senderPhone: string): Promise<number> {
    const raw = await redis.get(key(partnerId, senderPhone));
    if (raw !== null) return Number(raw);
    if (!(await legacyKeyAllowed(partnerId, senderPhone, legacyTenantOf))) return 0;
    const legacy = await redis.get(legacyKey(senderPhone));
    return legacy ? Number(legacy) : 0;
  }

  return {
    async getTodayCents(partnerId: PartnerId, senderPhone: string): Promise<number> {
      return read(partnerId, senderPhone);
    },

    async addCents(partnerId: PartnerId, senderPhone: string, cents: number): Promise<void> {
      const current = await read(partnerId, senderPhone);
      await redis.set(key(partnerId, senderPhone), String(current + cents), { ex: DAY_TTL_SECONDS });
    },
  };
}

export type DailyVolumeStore = ReturnType<typeof createDailyVolumeStore>;

let cached: DailyVolumeStore | null = null;

export function getDailyVolumeStore(): DailyVolumeStore {
  if (!cached) {
    cached = createDailyVolumeStore(getRedis(), getStore().legacyTenantOf); // D9: the store owns the resolver
  }
  return cached;
}
```

(`store.ts` must not import `daily-volume-store.ts` back — it does not today; `grep -n "volume-store" src/lib/store.ts` → nothing.)

`src/lib/monthly-volume-store.ts` (whole file) — identical structure with `easternMonth`, `MONTH_TTL_SECONDS = 35 * 24 * 60 * 60`, keys `monthly_volume:${partnerId}:${senderPhone}:${easternMonth(Date.now())}` / legacy `monthly_volume:${senderPhone}:${easternMonth(Date.now())}`, the same optional `legacyTenantOf` second parameter, and methods `getMonthCents(partnerId, senderPhone)` / `addCents(partnerId, senderPhone, cents)`.

3.4 Run:

```bash
npx vitest run tests/store.test.ts tests/transfer-repo.test.ts tests/recipient-store.test.ts tests/daily-volume-store.test.ts tests/monthly-volume-store.test.ts
```

Expected: all five green.

3.5 Commit:

```
feat(store): tenant-scope listTransfersByPhone/countByPhone/firstTransferAt, recipients, and the velocity/daily/monthly Redis keys (one rename, legacy dual-read for one TTL window)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 4 — `resolveSenderNames` takes tenant keys (the F50/F52 sink)

4.1 Failing tests — replace `tests/sender-names.test.ts` describe body with:

```ts
describe('resolveSenderNames (tenant-keyed — fix 1 / F50, F52)', () => {
  it('returns the DECRYPTED name for senders that have one under the caller tenant; absent otherwise', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230001', fullName: 'Asha Patel' }));
    await repo.saveCustomer(customer({ senderPhone: '15551230002' })); // pre-KYC, no name
    // 15551230003 has NO customer row at all.
    const map = await resolveSenderNames(
      db,
      [
        { partnerId: 'default', phone: '15551230001' },
        { partnerId: 'default', phone: '15551230002' },
        { partnerId: 'default', phone: '15551230003' },
      ],
      { provider },
    );
    expect(map.get(senderNameKey('default', '15551230001'))).toBe('Asha Patel');
    expect(map.has(senderNameKey('default', '15551230002'))).toBe(false);
    expect(map.has(senderNameKey('default', '15551230003'))).toBe(false);
  });

  it('omits customers belonging to another partner', async () => {
    await seedPartner(db, 'acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230001', fullName: 'Asha Patel' })); // default's
    const map = await resolveSenderNames(db, [{ partnerId: 'acme', phone: '15551230001' }], { provider });
    expect(map.size).toBe(0);
  });

  it('a phone with rows under two partners resolves ONLY the caller tenant name', async () => {
    await seedPartner(db, 'acme');
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230007', fullName: 'Default Name' }));
    await repo.saveCustomer(customer({ senderPhone: '15551230007', partnerId: 'acme', fullName: 'Acme Name' }));
    const map = await resolveSenderNames(db, [{ partnerId: 'acme', phone: '15551230007' }], { provider });
    expect([...map.entries()]).toEqual([[senderNameKey('acme', '15551230007'), 'Acme Name']]);
  });

  it('empty input → empty map; repeated keys dedupe into one entry', async () => {
    const repo = createCustomerRepo(db, async () => null, provider);
    await repo.saveCustomer(customer({ senderPhone: '15551230009', fullName: 'Mo Khan' }));
    expect((await resolveSenderNames(db, [], { provider })).size).toBe(0);
    const map = await resolveSenderNames(
      db,
      [{ partnerId: 'default', phone: '15551230009' }, { partnerId: 'default', phone: '15551230009' }],
      { provider },
    );
    expect(map.get(senderNameKey('default', '15551230009'))).toBe('Mo Khan');
    expect(map.size).toBe(1);
  });
});
```

Imports in that file become `import { freshDb, seedPartner } from './helpers-db';` and `import { resolveSenderNames, senderNameKey } from '@/lib/sender-names';`. (The "no partner scope is a type error" guard is the type signature itself — `SenderKey[]` — verified by `tsc` in Step 12; a phone-only string array no longer compiles.)

4.2 Run and expect failure: `npx vitest run tests/sender-names.test.ts` → `senderNameKey is not a function` / `TypeError`.

4.3 Implement `src/lib/sender-names.ts` (whole file):

```ts
import { and, eq, inArray, or } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { openOptional } from '@/db/repos/mappers';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import type { PartnerId } from '@/lib/types';

// sender-names — batch-resolve the DECRYPTED legal name for a set of senders, in
// ONE query, so a transfer list can show "who is sending" without an N+1 of
// per-row customer reads. The name lives ENCRYPTED on the customer record
// (customers.full_name_enc) and is only present after KYC.
//
// TENANT-KEYED (fix 1 / F50, F52): the lookup is by (partner_id, phone), never
// by phone alone — a partner can only ever see the legal name of ITS OWN row for
// a number, never another tenant's. Callers pass the transfer rows themselves
// (a Transfer carries partnerId + phone) and read back with senderNameKey(t).
// Reuses the exact customer-repo decryption path (openOptional + the field-crypto
// provider): same key boundary, never logs the plaintext, no new reveal surface.

export interface SenderKey {
  partnerId: PartnerId;
  phone: string;
}

/** The map key for a (tenant, phone) pair. */
export function senderNameKey(partnerId: PartnerId, phone: string): string {
  return `${partnerId}:${phone}`;
}

/**
 * Map senderNameKey(partnerId, phone) → decrypted full name, for the pairs that
 * have one. Empty input or no matches ⇒ an empty map (callers fall back to the phone).
 */
export async function resolveSenderNames(
  db: DbOrTx,
  keys: readonly SenderKey[],
  opts: { provider?: EncryptionKeyProvider } = {},
): Promise<Map<string, string>> {
  const provider = opts.provider ?? defaultProvider();
  const out = new Map<string, string>();

  const byPartner = new Map<PartnerId, Set<string>>();
  for (const k of keys) {
    if (!k.partnerId || !k.phone) continue;
    const set = byPartner.get(k.partnerId) ?? new Set<string>();
    set.add(k.phone);
    byPartner.set(k.partnerId, set);
  }
  if (byPartner.size === 0) return out;

  const conds = [...byPartner].map(([partnerId, phones]) =>
    and(eq(customers.partnerId, partnerId), inArray(customers.phone, [...phones])),
  );
  const rows = await db
    .select({ partnerId: customers.partnerId, phone: customers.phone, fullNameEnc: customers.fullNameEnc })
    .from(customers)
    .where(conds.length === 1 ? conds[0] : or(...conds));

  for (const r of rows) {
    const name = openOptional(r.fullNameEnc, provider);
    if (name) out.set(senderNameKey(r.partnerId, r.phone), name);
  }
  return out;
}
```

(`and`/`or`/`eq`/`inArray` are the same drizzle-orm exports already used in `src/db/repos/transfer-repo.ts:1` and the old `sender-names.ts:1`.)

4.4 Update the nine callers now so `tsc` stays green at the end of the step:

- `src/lib/partner-api-service.ts:100-103`:
  ```ts
  async function transferViewWithName(deps: PartnerApiDeps, t: Transfer) {
    // Tenant-keyed (F50/F52): only the caller's OWN customer row can supply a name.
    const names = await resolveSenderNames(deps.db, [t]);
    return transferView(t, names.get(senderNameKey(t.partnerId, t.phone)) ?? null);
  }
  ```
  and `:344-348`:
  ```ts
    const names = await resolveSenderNames(deps.db, page.items);
    return ok(200, {
      transactions: page.items.map((t) => transferView(t, names.get(senderNameKey(t.partnerId, t.phone)) ?? null)),
      next_cursor: page.nextCursor ?? null,
    });
  ```
  and the import at :31 becomes `import { resolveSenderNames, senderNameKey } from './sender-names';`.
- `src/app/admin-dashboard/page.tsx:70` → `const senderNames = await resolveSenderNames(getDb(), recent);` and every `senderNames.get(t.phone)` in that file → `senderNames.get(senderNameKey(t.partnerId, t.phone))` (grep `senderNames.get(` in each page below; add `senderNameKey` to each import from `@/lib/sender-names`).
- `src/app/admin-dashboard/compliance/page.tsx:103-106` → `resolveSenderNames(getDb(), [...inReview, ...flagged, ...blocked])`.
- `src/app/admin-dashboard/transactions/[id]/page.tsx:60` → `resolveSenderNames(getDb(), [t])` and `:62` → `senderNames.get(senderNameKey(t.partnerId, t.phone))`.
- `src/app/admin-dashboard/partners/[id]/page.tsx:154` → `resolveSenderNames(getDb(), recents)`.
- `src/app/admin-dashboard/ops/page.tsx:46-49` → pass the transfer objects instead of `.map((t) => t.phone)` (keep the same spread of snapshot arrays, drop the `.phone` projection).
- `src/app/admin-dashboard/refunds/page.tsx:55` → `resolveSenderNames(getDb(), all)`.

For each page: `grep -n "senderNames.get(" <file>` and rewrite every hit to `senderNames.get(senderNameKey(<row>.partnerId, <row>.phone))`.

4.5 Run: `npx vitest run tests/sender-names.test.ts tests/partner-api-service.test.ts` → sender-names green; partner-api-service still has the pre-existing sender_name tests green (names seeded under `'acme'` at `tests/partner-api-service.test.ts:53-62` match the acme-owned transfers).

4.6 Commit:

```
fix(sender-names): resolve legal names by (partner_id, phone) — a partner can never read another tenant's decrypted name (F50, F52)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 5 — WhatsApp inbound, outbox worker and the worker route carry the routed tenant

5.1 Failing tests. `tests/whatsapp-route.test.ts` — the mocks are per-method (`vi.hoisted` at lines 26-53), so the pin is on call arguments. Add to the `'POST /api/whatsapp — optInAt backfill on normal inbound (Fix 5)'` describe (line 323):

```ts
  it('the shared number is the DEFAULT tenant: every customer read/write is keyed (default, phone) and the turn carries routedPartnerId null', async () => {
    const res = await post(textBody('hi', 'wamid.TENANT1'));
    expect(res.status).toBe(200);
    expect(getCustomer).toHaveBeenCalledWith('default', '15551230000');
    expect(upsertOnFirstInbound).toHaveBeenCalledWith('default', '15551230000');
    expect(enqueue).toHaveBeenCalledWith(
      'agent.turn',
      expect.objectContaining({ phone: '15551230000', routedPartnerId: null }),
      expect.objectContaining({ dedupeKey: 'wamid:wamid.TENANT1' }),
    );
  });

  it('STOP / START consent writes are tenant-scoped too', async () => {
    await post(textBody('STOP', 'wamid.STOPT'));
    expect(setOptedOut).toHaveBeenCalledWith('default', '15551230000');
    await post(textBody('START', 'wamid.STARTT'));
    expect(clearOptedOut).toHaveBeenCalledWith('default', '15551230000');
  });
```

The existing assertion at line 335 `expect(setOptedIn).toHaveBeenCalledWith('15551230000')` becomes `toHaveBeenCalledWith('default', '15551230000')`; grep the file for other `toHaveBeenCalledWith('15551230000')` on `setOptedOut`/`clearOptedOut`/`setOptedIn`/`upsertOnFirstInbound` and prefix `'default', ` (the `sendText` assertions keep the phone first — they are not customer-store calls).

The inbound pipeline's own Redis reads are tenant-keyed too (D12): the file ALREADY declares `getLastInboundAt` / `recordInboundNow` as module-level `vi.fn`s (`tests/whatsapp-route.test.ts:15-16`, wired through the `@/lib/store` mock at :17-19 and cleared in `beforeEach`) — add to the first new test `expect(getLastInboundAt).toHaveBeenCalledWith('default', '15551230000'); expect(recordInboundNow).toHaveBeenCalledWith('default', '15551230000');`. These two tests are UNROUTED and UNSIGNED, exactly like the existing consent tests (no `metadata.phone_number_id`, `META_APP_SECRET` unset ⇒ warn-and-skip), so they need only the mocks the file already has plus Step 5A.1's two routing doubles at their `null` default.

`tests/outbox-worker.test.ts` line 242-244 becomes (fix 7 made the 5th argument an options object carrying `signal`; this task adds `routedPartnerId` to it — never a new positional):

```ts
    expect(runAgentTurn).toHaveBeenCalledWith(
      '15551230000', 'send $200 to mom', { isNewConversation: true }, undefined,
      expect.objectContaining({ routedPartnerId: null, signal: expect.any(AbortSignal) }),
    );
```

and in the "resolves the ROUTED partner's creds" test (line 247) add after line 262:

```ts
    expect(((runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string }).routedPartnerId).toBe('acme'); // the routed tenant reaches the agent
```

and append a new case to that describe — the identity input is asserted (D4):

```ts
  it('a routedPartnerId that names NO partner runs the turn under DEFAULT and raises one deduped ops alert (a malformed/legacy row never runs under a nonexistent tenant)', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'ghost_partner' }, { dedupeKey: 'wamid:ghost1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const opts = (runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string | null };
    expect(opts.routedPartnerId).toBeNull(); // ⇒ DEFAULT_PARTNER_ID in the route wiring
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(/^badtenant:\d+$/)]);
  });

  it('a routedPartnerId naming a SUSPENDED partner is treated the same: default tenant + one deduped badtenant alert (a suspended tenant must not keep serving customers through the shared number / its BYO pnid)', async () => {
    await seedPartner(db, 'dormant');
    const repo = createPartnerRepo(db);
    await repo.savePartner({ ...(await repo.getPartner('dormant'))!, status: 'suspended', updatedAt: new Date().toISOString() }); // the non-active value Partner['status'] allows — check src/lib/types.ts
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'dormant' }, { dedupeKey: 'wamid:dormant1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const opts = (runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string | null };
    expect(opts.routedPartnerId).toBeNull();
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(/^badtenant:\d+$/)]);
  });
```
(`seedPartner` from `./helpers-db`, `createPartnerRepo` from `@/db/repos/partner-repo` — add both imports.)

5.2 Run and expect failure: `npx vitest run tests/whatsapp-route.test.ts tests/outbox-worker.test.ts` → `expected "getCustomer" to be called with arguments: [ 'default', '15551230000' ]` / `Received: [ '15551230000' ]`; worker: the options object lacks `routedPartnerId` (`expected … objectContaining { routedPartnerId: null }`), and the ghost-partner case runs under `'ghost_partner'` with no alert.

5.3 Implement. `src/lib/whatsapp-inbound.ts` — add `import { DEFAULT_PARTNER_ID } from '@/lib/defaults';` after line 16; replace the header comment lines 19-26 with:

```ts
// whatsapp-inbound — the shared post-signature inbound pipeline (WL2). Both the
// legacy shared webhook (/api/whatsapp) and the per-partner webhook
// (/api/whatsapp/[partnerId]) run THIS after their own signature gate:
//   status events → parse → dedup → consent → customer resolve/create UNDER THE
//   ROUTED TENANT → agent turn ENQUEUED (durable outbox).
// A tenant-signed webhook proves the TENANT, not the sender (fix 1 / F44): every
// customer read/write below is keyed (tenant, phone), where tenant is the partner
// that OWNS the receiving number and the shared/default number IS the default
// tenant. An existing row under another partner is never touched or moved.
// `waCreds` are that partner's outbound credentials so every reply leaves FROM
// the number the customer messaged.
```

and lines 75-109 with:

```ts
  const customerStore = getCustomerStore(store);
  // The shared number (routedPartnerId null) is the default tenant's channel.
  const tenantId: PartnerId = routedPartnerId ?? DEFAULT_PARTNER_ID;

  // STOP / START consent short-circuit (order intentional — see consent.ts).
  if (incoming.kind === 'text') {
    if (isResumeKeyword(incoming.text)) {
      await customerStore.clearOptedOut(tenantId, incoming.from);
      await sendText(incoming.from, OPT_IN_REPLY, waCreds);
      return { ok: true };
    }
    if (isOptOutKeyword(incoming.text)) {
      await customerStore.setOptedOut(tenantId, incoming.from);
      await sendText(incoming.from, OPT_OUT_REPLY, waCreds);
      return { ok: true };
    }
    const existing = await customerStore.getCustomer(tenantId, incoming.from);
    if (existing?.optedOutAt) {
      await sendText(incoming.from, OPT_OUT_REMINDER, waCreds);
      return { ok: true };
    }
  }

  // D12: the "is this a new conversation" marker is per (tenant, phone) too —
  // a customer of another tenant messaging THIS number starts fresh here.
  const lastInboundAt = await store.getLastInboundAt(tenantId, incoming.from);
  const isNewConversation = lastInboundAt === null;
  await store.recordInboundNow(tenantId, incoming.from);

  // Resolve/create the customer under the ROUTED tenant only — never re-home.
  const { customer, wasCreated } = await customerStore.upsertOnFirstInbound(tenantId, incoming.from);

  if (!customer.optInAt) {
    await customerStore.setOptedIn(tenantId, incoming.from);
  }
```

The enqueue at lines 147-151 is unchanged (payload keeps `routedPartnerId`, null on the shared number).

`src/lib/outbox-worker.ts` — the `runAgentTurn` member of `WorkerDeps` (post-fix-7 shape, the trailing options object) becomes:

```ts
  runAgentTurn: (
    phone: string,
    message: string,
    turn: TurnContext,
    waCreds?: WaCreds,
    opts?: {
      /** Cooperative row deadline (fix 7). */
      signal?: AbortSignal;
      /** The tenant that owns the receiving number (null ⇒ the shared/default number) — fix 1. */
      routedPartnerId?: PartnerId | null;
    },
  ) => Promise<string>;
```

(add `PartnerId` to the `@/lib/types` type import at the top of the file — `grep -n "from '@/lib/types'" src/lib/outbox-worker.ts`), and the `agent.turn` case (fix 7's version, which already passes `{ signal }` and skips a late reply) becomes:

```ts
    case 'agent.turn': {
      const phone = str(p.phone);
      const requested = str(p.routedPartnerId);
      // The payload's routedPartnerId is an IDENTITY input (fix 1, D4): assert
      // it names an existing AND ACTIVE partner before a turn runs under it.
      // /api/whatsapp/[partnerId] already refuses a suspended partner; the
      // shared number + a BYO pnid must not keep serving a suspended tenant's
      // customers through this path either. A malformed, legacy or inactive
      // row falls back to the default tenant and raises ONE deduped ops alert
      // — never a turn under a nonexistent or suspended tenant.
      let routedPartnerId: PartnerId | null = null;
      if (requested) {
        const known = await createPartnerRepo(deps.db).getPartner(requested);
        if (known && known.status === 'active') {
          routedPartnerId = requested;
        } else {
          logWarn('worker.agent', 'agent.turn routedPartnerId names no ACTIVE partner — running under default', { id: row.id, kind: row.kind });
          await createOutboxRepo(deps.db).enqueue(
            'ops.alert',
            { message: `⚠️ SmartRemit ops: outbox #${row.id} (agent.turn) carried an unknown or inactive routedPartnerId; the turn ran under the default tenant. Check the inbound routing config.` },
            { dedupeKey: `badtenant:${row.id}` },
          );
        }
      }
      // Re-resolve the routing partner's outbound creds at RUN time (the
      // payload never carries tokens; rotation is picked up automatically).
      const waCreds = routedPartnerId
        ? (await partnerContext(deps, routedPartnerId)).waCreds
        : undefined;
      const reply = await deps.runAgentTurn(
        phone,
        str(p.messageText),
        (p.turn ?? {}) as TurnContext,
        waCreds,
        { signal, routedPartnerId }, // the tenant the turn runs under (fix 1) + fix 7's cooperative deadline
      );
      if (signal.abandoned) { // fix 7's discriminator (the race timer's flag) — never `signal.aborted`
        logWarn('worker.agent', 'agent.turn reply dropped: row deadline already passed', { id: row.id, kind: row.kind });
        return;
      }
      if (reply.trim()) await deps.sendText(phone, reply, waCreds);
      return;
    }
```

(`createPartnerRepo` is already imported by `partnerContext`. The code above + the SUSPENDED-partner test in 5.1 are the contract: only an existing AND `'active'` partner routes; anything else runs under default with one `badtenant:<rowId>` alert. Note the alert keys on the ROW id, so a bad row alerts once however many times it is retried.)

`src/app/api/worker/route.ts` lines 56-71 become (add `import { DEFAULT_PARTNER_ID } from '@/lib/defaults';` to the imports):

```ts
    runAgentTurn: async (phone, message, turn, waCreds, opts) => {
      const routedPartnerId = opts?.routedPartnerId ?? null;
      const customerStore = getCustomerStore(store);
      const agent = createAgent({
        chat,
        store,
        scheduleStore: getScheduleStore(),
        draftStore: getDraftStore(),
        customerStore,
        dailyVolumeStore: getDailyVolumeStore(),
        monthlyVolumeStore: getMonthlyVolumeStore(),
        kycProvider: getKycProvider(customerStore, env.appBaseUrl),
        partnerStore: getPartnerStore(),
        waCreds, // WL2: interactive sends + replies leave from the partner's number
        partnerId: routedPartnerId ?? DEFAULT_PARTNER_ID, // fix 1: the turn runs under the routed tenant
      });
      return agent.runAgentTurn(phone, message, turn, { signal: opts?.signal }); // fix 7's cooperative deadline stays threaded
    },
```

5.4 Run: `npx vitest run tests/whatsapp-route.test.ts tests/outbox-worker.test.ts` → green. (`createAgent` does not accept `partnerId` until Step 6 — vitest does not typecheck; Step 6 lands before `tsc` runs.)

5.5 Commit:

```
fix(whatsapp): resolve inbound customers under the routed tenant only and carry it to the agent turn — a tenant-signed webhook proves the tenant, not the sender (F44)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 5A — Routing is identity: one partner per phone_number_id, per-partner secret fail-closed (D11)

Ground truth (re-read on the branch): `src/app/admin-dashboard/partners/actions.ts:172-190` (`saveWhatsappConfigAction`, gated by `gatePartnerConfig` = `requireAdmin` + `canSee` ⇒ a partner-scoped admin reaches it), `:362-420` (`wizardCreatePartnerAction` stores `wa.phoneNumberId` at `:418`), `src/db/repos/integrations-repo.ts:84-92` (`partnerForPhoneNumberId`, `LIMIT 1`), `src/app/api/whatsapp/route.ts:41-63` (routing + the `integrations?.whatsapp.appSecret || env.metaAppSecret` precedence), `src/lib/env.ts` (`whatsappPhoneNumberId`, `metaAppSecret` — confirm the property names with `grep -n "whatsappPhoneNumberId\|metaAppSecret" src/lib/env.ts`).

5A.1 Failing tests.

`tests/partners-actions.test.ts` (the file Task 12 also extends; if it does not exist yet, create it with the same mocks Task 12 Step 12.19 lists — `@/lib/auth`, `@/db/client`, `next/cache`, `next/navigation`) — add a describe:

```ts
describe('WhatsApp number routing is identity (fix 1, D11)', () => {
  it('a partner-scoped admin cannot store the PLATFORM phone_number_id', async () => {
    currentStaff = staff({ role: 'admin', partnerId: 'acme' });
    const fd = form({ id: 'acme', phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'pn_platform' });
    await expect(saveWhatsappConfigAction(fd)).rejects.toThrow('That WhatsApp number cannot be used.');
    expect((await integrations.getIntegrations('acme')).whatsapp.phoneNumberId).toBeUndefined();
  });

  it('a phone_number_id already held by ANOTHER partner is refused with the SAME generic message (no disclosure)', async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } });
    currentStaff = staff({ role: 'admin', partnerId: 'beta' });
    await expect(saveWhatsappConfigAction(form({ id: 'beta', phoneNumberId: 'pn_acme' }))).rejects.toThrow('That WhatsApp number cannot be used.');
    expect((await integrations.getIntegrations('beta')).whatsapp.phoneNumberId).toBeUndefined();
    // Re-saving your OWN number is fine (idempotent edit of the same row).
    currentStaff = staff({ role: 'admin', partnerId: 'acme' });
    await expect(saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: 'pn_acme' }))).resolves.toBeUndefined();
  });

  it('the wizard applies the same refusal', async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } });
    currentStaff = staff({ role: 'admin' }); // platform staff
    await expect(wizardCreatePartnerAction({ id: 'gamma', name: 'Gamma', countries: ['US'], whatsapp: { phoneNumberId: 'pn_acme', token: 'x' } } as Parameters<typeof wizardCreatePartnerAction>[0]))
      .rejects.toThrow('That WhatsApp number cannot be used.');
  });

  it('the unique partial index is the last line: a raw duplicate insert fails', async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_dup', token: 't' } });
    await expect(
      db.execute(sql`INSERT INTO partner_integrations (partner_id, wa_phone_number_id) VALUES ('beta', 'pn_dup')`),
    ).rejects.toThrow(/partner_integrations_wa_pnid|unique/i);
  });
});
```

The file's harness on `4fc4e6a` has `currentStaff` (a `let`, reset to a platform admin in `beforeEach`), `db` (a `let`, `freshDb()` per test) and `ps`, and it ALREADY mocks `@/lib/partner-integrations-store` with `...actual` + a PGlite-backed `getPartnerIntegrationsStore` (`:35-38`) — so the REAL `partnerForPhoneNumberId` inside `assertPhoneNumberIdFree` reads the same PGlite. It has NO `staff()`, `form()` or `integrations` helper and seeds NO partners (`partner_integrations.partner_id` has an FK to `partners`, and `gatePartnerConfig` throws `Partner not found.` for an unseeded id — the raw-duplicate test would otherwise fail on the FK, which does not match `/unique/`). Add to the describe, and add `saveWhatsappConfigAction` to the file's action import and `import { seedPartner } from './helpers-db';` / `import { sql } from 'drizzle-orm';` / `import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';` to its imports:

```ts
  const staff = (o: { role: 'admin' | 'agent'; partnerId?: string }) => ({ username: 'u', ...o });
  const form = (values: Record<string, string>): FormData => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    return fd;
  };
  let integrations: ReturnType<typeof createPartnerIntegrationsStore>;
  beforeEach(async () => {
    await seedPartner(db, 'acme');
    await seedPartner(db, 'beta'); // 'gamma' is never seeded: the wizard mints its own id and must refuse BEFORE savePartner
    integrations = createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))); // same key as the mocked getPartnerIntegrationsStore
  });
```

(`wizardCreatePartnerAction`'s input type is at `partners/actions.ts:340-350` — the `id: 'gamma'` in the test is ignored by the action (it mints its own id) and exists only to satisfy the cast; drop it if `tsc` objects to the excess property.) This describe RELIES on `freshDb()` returning the same PGlite handle per worker (`tests/helpers-db.ts:21-28`): the REAL `partnerForPhoneNumberId` inside `assertPhoneNumberIdFree` reads through the mocked `getPartnerIntegrationsStore`'s cached store, which stays bound to the live engine only because the handle never changes — nobody may later switch this file to per-test PGlite instances.

`tests/whatsapp-route.test.ts` — what the file on `4fc4e6a` actually has (re-read before editing): the `vi.hoisted` block at :26-53 holds ONLY `sendText`/`setOptedOut`/`clearOptedOut`/`setOptedIn`/`getCustomer`/`upsertOnFirstInbound`/`enqueue`; it mocks `@/db/client` (`getDb: () => ({})`), `@/db/repos/outbox-repo`, `@/lib/customer-store`, `@/lib/outbox`, `@/lib/tier-rules` and `@/lib/whatsapp` (with `...real`) — it does NOT mock `verifyMetaSignature`, `partnerForPhoneNumberId` or `getIntegrations`; its signature describe verifies REAL HMACs via `sign(body, SECRET)` with `SECRET = 'meta-app-secret'` and `process.env.META_APP_SECRET = SECRET` set per test (the `afterEach` at ~:164 deletes it, so it is UNSET by default); and `textBody(text, id = 'wamid.TXT', from = '15551230000')` takes `from` as its THIRD positional. So: (1) do NOT mock `verifyMetaSignature` — a mock would break the existing HMAC describe; keep real signatures and sign routed bodies with the partner secret; (2) add two routing doubles to the hoisted block, defaulting to UNROUTED so every existing test is unchanged (their bodies carry no `metadata.phone_number_id`, so the real `partnerForPhoneNumberId` — which would hit the `{}` db stub — is never reached today either); (3) extend `textBody` with a FOURTH parameter, never a third-positional object.

Hoisted block (:26-53) — add two names:
```ts
const {
  sendText, setOptedOut, clearOptedOut, setOptedIn, getCustomer, upsertOnFirstInbound, enqueue,
  partnerForPhoneNumberId, getIntegrations,
} = vi.hoisted(() => ({
  … (the seven existing doubles, unchanged) …,
  // Fix 1 D11 routing doubles. Default: UNROUTED (null) ⇒ every pre-existing test is untouched.
  partnerForPhoneNumberId: vi.fn(async (_pnid: string): Promise<string | null> => null),
  getIntegrations: vi.fn(async (_partnerId: string) => ({
    kyc: {}, payment: {},
    whatsapp: {} as { phoneNumberId?: string; token?: string; appSecret?: string },
  })),
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  partnerForPhoneNumberId,
  getPartnerIntegrationsStore: () => ({ getIntegrations }),
}));
```
`beforeEach` (after `enqueue.mockClear();`): `partnerForPhoneNumberId.mockClear().mockResolvedValue(null); getIntegrations.mockClear().mockResolvedValue({ kyc: {}, payment: {}, whatsapp: {} });`

Body builder (replace the `textBody` at ~:125) — `parsePhoneNumberId` (`src/lib/whatsapp.ts`) reads `entry[].changes[].value.metadata.phone_number_id`:
```ts
function textBody(text: string, id = 'wamid.TXT', from = '15551230000', opts: { phoneNumberId?: string } = {}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      ...(opts.phoneNumberId ? { metadata: { phone_number_id: opts.phoneNumberId } } : {}),
      messages: [{ from, id, type: 'text', text: { body: text } }],
    } }] }],
  });
}
```

New describe (append after the signature describe). Assertions are on status + `enqueue` / `markMessageSeen` — the signature gate sits above `markMessageSeen`, so "reached markMessageSeen" ⇔ "verified":
```ts
describe('shared webhook: a ROUTED event is verified with THAT partner\'s secret only (fix 1, D11 — variant A, fail closed)', () => {
  const ACME_WITH_SECRET = { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't', appSecret: 'acme_secret' } };
  const ACME_NO_SECRET = { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } };
  beforeEach(() => { process.env.META_APP_SECRET = SECRET; }); // the file's afterEach deletes it again

  it('routed + partner has an appSecret ⇒ the partner secret verifies (200, turn enqueued under acme); the PLATFORM secret is refused (401)', async () => {
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue(ACME_WITH_SECRET);
    const body = textBody('hi', 'wamid.R1', '15551230000', { phoneNumberId: 'pn_acme' });
    expect((await post(body, sign(body, SECRET))).status).toBe(401); // platform-signed ⇒ never the partner's event
    expect(markMessageSeen).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const res = await post(body, sign(body, 'acme_secret'));
    expect(res.status).toBe(200);
    expect(markMessageSeen).toHaveBeenCalledWith('wamid.R1');
    expect(enqueue).toHaveBeenCalledWith(
      'agent.turn',
      expect.objectContaining({ phone: '15551230000', routedPartnerId: 'acme' }),
      expect.objectContaining({ dedupeKey: 'wamid:wamid.R1' }),
    );
  });

  it('routed + partner has NO appSecret ⇒ 401 fail closed even when signed with the platform secret — no fallback for a routed event', async () => {
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue(ACME_NO_SECRET);
    const body = textBody('hi', 'wamid.R2', '15551230000', { phoneNumberId: 'pn_acme' });
    expect((await post(body, sign(body, SECRET))).status).toBe(401);
    expect((await post(body, sign(body, 'acme_secret'))).status).toBe(401);
    expect(markMessageSeen).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('unrouted (the shared number) keeps the platform secret', async () => {
    const body = textBody('hi', 'wamid.R3'); // no metadata ⇒ partnerForPhoneNumberId is never consulted
    expect((await post(body, sign(body, 'acme_secret'))).status).toBe(401);
    const res = await post(body, sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(partnerForPhoneNumberId).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('agent.turn', expect.objectContaining({ routedPartnerId: null }), expect.anything());
  });
});
```
(If a spy on the verifier is still wanted, wrap the REAL one rather than stubbing it: `vi.mock('@/lib/providers/meta-signature-verify', async (orig) => { const real = await orig<typeof import('@/lib/providers/meta-signature-verify')>(); return { ...real, verifyMetaSignature: vi.fn(real.verifyMetaSignature) }; })` — confirm the module path with `grep -rn "export function verifyMetaSignature" src/`. Not required: the status assertions above already prove which secret verified.)

5A.2 Run and expect failure: `npx vitest run tests/partners-actions.test.ts tests/whatsapp-route.test.ts` → the actions resolve instead of throwing (`promise resolved instead of rejecting`), the raw duplicate insert succeeds, and the no-appSecret routed event returns 200 (verified with the platform secret).

5A.3 Implement.

`src/app/admin-dashboard/partners/actions.ts` — add one helper above `saveWhatsappConfigAction` and call it from both writers:

```ts
/**
 * D11 (fix 1): a WhatsApp phone_number_id routes inbound traffic to ONE tenant,
 * so it is REFUSED when it is the platform's own number or already held by a
 * different partner. One generic message for both cases — the refusal must not
 * tell a partner who holds a number. The partial unique index
 * partner_integrations_wa_pnid is the race-proof last line.
 */
async function assertPhoneNumberIdFree(partnerId: string, pnid: string | undefined): Promise<void> {
  if (!pnid) return;
  const holder = await partnerForPhoneNumberId(pnid);
  if (pnid === env.whatsappPhoneNumberId || (holder && holder !== partnerId)) {
    throw new Error('That WhatsApp number cannot be used.');
  }
}
```

`env.whatsappPhoneNumberId` is read through `required()`: if `WHATSAPP_PHONE_NUMBER_ID` is missing the helper THROWS and the save is refused — that is the intended posture (fail CLOSED; `tests/setup.ts:5` pins the var so tests never hit it). NEVER wrap the read in a `catch` that allows the save: with no platform pnid to compare against, lock (a) cannot be evaluated, so the write must not happen.

In `saveWhatsappConfigAction`, after `const newPnid = …` insert `await assertPhoneNumberIdFree(id, newPnid || undefined);`. In `wizardCreatePartnerAction`, insert `await assertPhoneNumberIdFree(id, clean((input.whatsapp ?? {}).phoneNumberId));` ABOVE `await getPartnerStore().savePartner(partner);` (`:395`) — i.e. right after the `partner` object is built and BEFORE any write. It must NOT sit just before the `saveIntegrations` call (`:413-420`): a refused pnid (or a 23505 race loss there) would leave an orphan ACTIVE partner with no integrations and no API key. Task 12's pre-write validation block lands in the same spot — keep this call and the wrap below verbatim when it does. Imports: `partnerForPhoneNumberId` from `@/lib/partner-integrations-store` (already exported — the shared webhook imports it) and `env` from `@/lib/env`. Wrap BOTH `saveIntegrations` calls so the partial unique index's race-loss reads exactly like the pre-check — one generic message, no separate text that discloses a race:

```ts
  try {
    await store.saveIntegrations(id, { …unchanged… });
  } catch (e) {
    // The partial unique index partner_integrations_wa_pnid is the race-proof
    // last line (two admins saving the same number at once). SAME generic
    // message as assertPhoneNumberIdFree — never who holds it, never "race".
    if ((e as { code?: string } | null)?.code === '23505') throw new Error('That WhatsApp number cannot be used.');
    throw e;
  }
```
(Postgres unique_violation is SQLSTATE `23505`; drizzle/neon surfaces it as `err.code` — confirm on PGlite with the Step 5A.1 raw-duplicate test, which already asserts the index name.)

`src/app/api/whatsapp/route.ts` lines 55-63 become:

```ts
  // Signature gate, ABOVE markMessageSeen, so a forged body can't touch the
  // dedup set or any downstream processing.
  //   routed (a partner's BYO number)  ⇒ THAT partner's app secret, and ONLY
  //     that — no platform fallback. A routed partner with no app secret is
  //     401: after fix 1 routing IS tenant identity, so an event that cannot be
  //     verified as that partner's must never be processed as that partner's.
  //     (Variant A: a routed partner MUST configure its own Meta app secret; a
  //     BYO number that lives under the PLATFORM Meta app is supported only by
  //     variant B below, which is not this code. Pre-apply query (c) in Step
  //     2.2 is what decides which variant ships.)
  //   unrouted (the shared number)     ⇒ the platform META_APP_SECRET; warn-and-
  //     proceed only when none is configured (dev/test — unchanged legacy).
  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (routedPartnerId) {
    const partnerSecret = integrations?.whatsapp.appSecret ?? '';
    if (!partnerSecret || !verifyMetaSignature(raw, signature, partnerSecret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  } else if (env.metaAppSecret === '') {
    console.warn('META_APP_SECRET unset — skipping X-Hub-Signature-256 verification');
  } else if (!verifyMetaSignature(raw, signature, env.metaAppSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }
```

**Variant B (⚠ owner decision, forced by Step 2.2 pre-apply query (c)):** if that query lists any production partner — a pnid with no app secret that cannot be configured before merge — the fail-closed block above would 401 that partner's entire customer channel on deploy. The ONLY acceptable alternative is: routed event + partner has NO appSecret ⇒ verify with the platform secret, allowed solely because lock (a) guarantees the pnid maps to exactly one partner and can never be the platform's own number. Ship it as an explicit branch:

```ts
  if (routedPartnerId) {
    const partnerSecret = integrations?.whatsapp.appSecret ?? '';
    // D11 variant B: a routed partner with NO app secret is a BYO number under
    // the PLATFORM Meta app. Verifying it with the platform secret is legal
    // ONLY because lock (a) (partial unique index + write-time refusal) makes
    // the pnid unique and never the platform's own — the event can therefore
    // belong to exactly this partner. A partner WITH a secret is still
    // verified with that secret ONLY.
    const secret = partnerSecret || env.metaAppSecret;
    if (!secret || !verifyMetaSignature(raw, signature, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  } else if …
```
and flip the SECOND test in 5A.1 (rename it `'… variant B: routed + NO appSecret ⇒ the platform secret verifies, only because the pnid is unique'`): `expect((await post(body, sign(body, SECRET))).status).toBe(200)` with `markMessageSeen` called and `enqueue` called with `routedPartnerId: 'acme'`; keep `expect((await post(body, sign(body, 'acme_secret'))).status).toBe(401)` (a wrong secret is still refused) — real signatures, no verifier mock. Whichever variant ships: `tests/whatsapp-route.test.ts` pins it, the PR body states it with the query (c) output, and the wave table's Task 1 row names it.

5A.4 Run: `npx vitest run tests/partners-actions.test.ts tests/whatsapp-route.test.ts tests/pg-repos.test.ts` → green (PGlite proves the partial unique index from 0015).

5A.5 Commit:

```
fix(partner-api): one partner per WhatsApp phone_number_id (partial unique index + write-time refusal); routed inbound verified with the partner secret only (F44, D11)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 6 — Agent, tools, web chat, drafts, verify-link and recent-transfers run under a tenant

6.1 Failing tests. `tests/tools.test.ts` — extend `buildCtx` (lines 41-78) with a `partnerId` parameter and return it:

```ts
async function buildCtx(redis: ReturnType<typeof fakeRedis>, phone: string = PHONE, partnerId = 'default') {
  …
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  return {
    phone,
    partnerId,
    store,
    …
```

and add a describe at the end of the file:

```ts
describe('tools are tenant-scoped (fix 1)', () => {
  it('list_saved_recipients / resolve_recipient under acme never see the default tenant address book for the same phone', async () => {
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const dflt = await buildCtx(redis);
    await dflt.store.upsertRecipient('default', PHONE, {
      name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
      lastUsedAt: new Date().toISOString(),
    });
    const acme = await buildCtx(redis, PHONE, 'acme');
    expect(await executeTool('list_saved_recipients', {}, acme)).toEqual({ recipients: [] });
    // `{ match: 'none' }` is exactly what resolve_recipient returns today for an empty book
    // (src/lib/tools.ts:2647-2681, both the empty-list and the zero-candidates arms); pin
    // it with toEqual so a later copy change to that shape is caught here, not in prod.
    expect(await executeTool('resolve_recipient', { name: 'Mom' }, acme)).toEqual({ match: 'none' });
    expect((await executeTool('list_saved_recipients', {}, dflt)).recipients).toHaveLength(1);
  });

  it('list_schedules / cancel_schedule under acme never see or cancel a default-tenant schedule for the same phone (F44 via the signed-inbound forgery)', async () => {
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const dflt = await buildCtx(redis);
    const nowIso = new Date().toISOString();
    await dflt.scheduleStore.saveSchedule({
      id: 'sch_default_1', phone: PHONE, partnerId: 'default', amountUsd: 200, amountSource: 200, sourceCurrency: 'USD',
      recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 1, status: 'active', createdAt: nowIso,
    });
    const acme = await buildCtx(redis, PHONE, 'acme');
    expect(await executeTool('list_schedules', {}, acme)).toEqual({ schedules: [] });
    expect(await executeTool('cancel_schedule', { schedule_id: 'sch_default_1' }, acme)).toEqual({ error: 'Schedule not found.' });
    expect((await dflt.scheduleStore.getSchedule('sch_default_1'))?.status).toBe('active'); // untouched
    expect((await executeTool('list_schedules', {}, dflt)).schedules).toHaveLength(1);      // the owner still sees it
  });

  it('check_payment_status / update_recipient_phone under acme treat a default-tenant transfer id as not found and leave the row unchanged', async () => {
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const dflt = await buildCtx(redis);
    const created = await executeTool('create_transfer', {
      amount_usd: 500, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, dflt);
    expect(created.error).toBeUndefined();
    const id = created.transfer_id as string;
    const before = (await dflt.store.getTransfer(id))!;
    const acme = await buildCtx(redis, PHONE, 'acme');
    expect(await executeTool('check_payment_status', { transfer_id: id }, acme)).toEqual({ error: 'Transfer not found.' });
    expect(await executeTool('update_recipient_phone', { transfer_id: id, recipient_phone: '919999999999' }, acme)).toEqual({ error: 'Transfer not found.' });
    const after = (await dflt.store.getTransfer(id))!;
    expect([after.recipientPhone, after.status, after.partnerId]).toEqual([before.recipientPhone, before.status, 'default']);
    // The owner's own turn still resolves it (same phone, right tenant).
    expect((await executeTool('check_payment_status', { transfer_id: id }, dflt)).error).toBeUndefined();
  });

  it('send_approve_picker writes the draft under ctx.partnerId and the active-draft pointer under (partnerId, phone)', async () => {
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const acme = await buildCtx(redis, PHONE, 'acme');
    await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Anita',
      recipient_phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890', destination_country: 'IN',
    }, acme);
    const draftKey = [...redis.dump.keys()].find((k) => k.startsWith('recipient_draft:'))!;
    expect(JSON.parse(redis.dump.get(draftKey)!).partnerId).toBe('acme');
    expect(redis.dump.has(`active_draft:acme:${PHONE}`)).toBe(true);   // D12
    expect(redis.dump.has(`active_draft:${PHONE}`)).toBe(false);
    expect(await acme.draftStore.getActiveDraftId('default', PHONE)).toBeNull();
  });

  it('an approve tap under acme NEVER resolves a default-tenant draft for the same phone (hard guard, D12)', async () => {
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const dflt = await buildCtx(redis);
    const draftId = await dflt.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    });
    const acme = await buildCtx(redis, PHONE, 'acme');
    const r = await executeTool('create_transfer', {}, { ...acme, turn: { isNewConversation: false, buttonTap: { kind: 'approve', draftId } } });
    expect(r.error).toBeDefined();
    expect(r.transfer_id).toBeUndefined();
    expect(await acme.store.listTransfers()).toHaveLength(0);            // nothing minted under acme
    expect(await dflt.draftStore.getDraft(draftId)).not.toBeNull();      // and default's draft was not consumed
    // Cancel is guarded the same way: acme's "cancel" cannot see default's pointer.
    expect(await executeTool('cancel_draft', {}, acme)).toEqual({ cancelled: false, reason: 'no_active_draft' });
    expect(await dflt.draftStore.getDraft(draftId)).not.toBeNull();
  });
});
```

(Check the exact `buttonTap` shape the approve tap uses — `grep -n "kind: 'approve'" src/lib/tools.ts src/lib/types.ts` — and which tool the agent dispatches it to (`tools.ts:1160-1170`, `consumeDraft(ctxDraftId)`); the test drives that tool.)

`tests/agent.test.ts` — the conversation store is tenant-keyed (D12); add:

```ts
  it('conversation history is per (tenant, phone): an acme turn for a phone with default history starts EMPTY', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.saveConversation('default', PHONE, [{ role: 'user', content: 'send $900 to Zubeida' }, { role: 'assistant', content: 'Sure — Zubeida it is.' }]);
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store, scheduleStore: freshScheduleStore(), draftStore: createDraftStore(fakeRedis()), ...extraDeps(redis, store),
      partnerId: 'acme',
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'hi' }; },
    });
    await agent.runAgentTurn(PHONE, 'hello');
    expect(JSON.stringify(seen[0])).not.toContain('Zubeida');
    expect(await store.getConversation('acme', PHONE)).toHaveLength(2); // its OWN thread: user + assistant
    expect((await store.getConversation('default', PHONE))[0].content).toBe('send $900 to Zubeida'); // untouched
  });
```

(`seedPartner` import: `import { freshDb, seedPartner } from './helpers-db';` — check the existing import line; `executeTool` is already imported.)

`tests/recent-transfers.test.ts` line 41 stub becomes `listTransfersByPhone: async (_tenantId: string, phone: string, limit: number) =>` and every `getRecentTransfersNote('+15551230000', …)` becomes `getRecentTransfersNote('default', '+15551230000', …)` (`sed -i '' "s/getRecentTransfersNote('+15551230000', /getRecentTransfersNote('default', '+15551230000', /g" tests/recent-transfers.test.ts`). `tests/bot-content-guard.test.ts:121` → `getRecentTransfersNote('default', '+1555', store)` (this file is not otherwise edited; its `:92-95` SOURCE scan of `recent-transfers.ts` is why the new parameter is named `tenantId` in 6.3).

`tests/verify-link.test.ts`: the three `issueVerifyLink({ phone: PHONE, …` calls (lines 108, 133, 152) and the object at line 79 gain `partnerId: 'default', `; `customerStore.getCustomer(PHONE)` at lines 86 and 137 → `getCustomer('default', PHONE)`.

`tests/partner-orchestration.test.ts`: `buildHarness(redis: FakeRedis, partnerId = 'default')` and pass `partnerId` into `createAgent({ …, partnerId, … })` at line 53; the two acme tests (lines 92 and 144) call `buildHarness(redis, 'acme')`. (Brand and gate come from the routed tenant now — D4.)

`tests/e2e.test.ts` line 166 → `store.upsertRecipient('default', PHONE, {…})`, line 290 → `store.listRecipients('default', PHONE, 3)`, line 140 `getTransferCount(PHONE)` → `getTransferCount('default', PHONE)`, and grep the file for `getCustomer(PHONE` / `addCents(PHONE` / `getTodayCents(PHONE` → prefix `'default', `.

`tests/agent.test.ts`: `store.upsertRecipient(PHONE,` (3) → `store.upsertRecipient('default', PHONE,`, and every `store.getConversation(PHONE)` (including fix 7's `'row deadline (fix 7)'` describe at the end of the file) → `store.getConversation('default', PHONE)` (D12); `tests/web-chat.test.ts` lines 115/120 → `web.upsertRecipient('default', PHONE, …)` / `store.listRecipients('default', PHONE, 5)`.

6.2 Run and expect failure: `npx vitest run tests/tools.test.ts tests/recent-transfers.test.ts tests/verify-link.test.ts tests/partner-orchestration.test.ts` → tools: `expected { recipients: [ { name: 'Mom', … } ] } to deeply equal { recipients: [] }` (the acme context reads default's book — F45 reproduced), `expected { schedules: [ { schedule_id: 'sch_default_1', … } ] } to deeply equal { schedules: [] }` and `expected 'cancelled' to be 'active'` (acme lists + cancels default's schedule), `expected { transfer_id: …, recipient_phone: '919999999999' } to deeply equal { error: 'Transfer not found.' }` (acme rewrites default's transfer — F44 at the tool layer); orchestration: `expected '…SmartRemit…' to contain 'Acme Pay'`.

6.3 Implement.

`src/lib/types.ts` — in `interface Draft` (after `senderPhone: string;`):

```ts
  // The tenant the draft was created under (fix 1). Optional ONLY so in-flight
  // legacy drafts drain their 30-min TTL; every new draft sets it and readers
  // use `draft.partnerId ?? DEFAULT_PARTNER_ID`.
  partnerId?: PartnerId;
```

`src/lib/agent.ts` — add `import { DEFAULT_PARTNER_ID } from './defaults';` and `PartnerId` to the `./types` type import; in `AgentDeps` after `waCreds?` (line 38):

```ts
  // The tenant this agent runs under (fix 1): the partner that owns the WhatsApp
  // number the turn arrived on, or the portal customer's partner for web chat.
  // Absent ⇒ DEFAULT_PARTNER_ID (the shared number). Every customer, recipient,
  // ledger and counter read inside the turn is keyed by (partnerId, phone).
  partnerId?: PartnerId;
```

In `createAgent`, first line: `const partnerId: PartnerId = deps.partnerId ?? DEFAULT_PARTNER_ID;`. Every conversation read/write in `agent.ts` (D12: `:93` `getConversation`, `:105`, `:386`, `:392` `saveConversation`) gains `partnerId` as the first argument. In `completeTurn` lines 125-128 become:

```ts
    const noteCustomer = await deps.customerStore.getCustomer(partnerId, phone);
    // The ROUTED tenant decides brand + KYC posture — not the customer row (D4).
    const notePartner =
      (await deps.partnerStore.getPartner(partnerId)) ?? (await deps.partnerStore.ensureDefaultPartner());
```

line 145 → `const recentNote = await getRecentTransfersNote(partnerId, phone, deps.store);`; line 185 → `const found = (await deps.store.listRecipients(partnerId, phone, 25)).find(`; the `executeTool` context (lines 276-292) gains `partnerId,` right after `phone,`; the `issueVerifyLink({ … })` call at lines 367-372 gains `partnerId,` as its first property.

`src/lib/recent-transfers.ts:88` → `export async function getRecentTransfersNote(tenantId: string, phone: string, store: Store): Promise<string> {` and `:89` → `const top = await store.listTransfersByPhone(tenantId, phone, MAX_RECENT); // keyed by the customer's own tenant`. **NAMING RULE (shared with Task 2 Step 8, which rewrites this file):** the parameter is `tenantId: string` — NOT `partnerId: PartnerId` — with no `PartnerId` type import and no comment containing the word "partner", because `tests/bot-content-guard.test.ts:92-95` lowercases this file's SOURCE and asserts it contains none of `partner` / `corridor` / `watchlist` / `sanctions` / `compliance`. The `agent.ts` call site passes its `partnerId` (agent.ts is not scanned).

`src/lib/verify-link.ts` — `IssueVerifyLinkDeps` gains `partnerId: PartnerId;` as its first field (import `type { Customer, KycReviewState, PartnerId } from './types'`), and line 75 → `await deps.customerStore.recordKycInquiry(deps.partnerId, deps.phone, start.providerRef);`.

`src/lib/tools.ts` — `ToolContext` (line 784) gains, right after `phone: string;`:

```ts
  // The tenant the turn runs under (fix 1). Every customer / recipient / ledger /
  // velocity read in a tool is keyed (partnerId, phone); a phone alone is not an identity.
  partnerId: PartnerId;
```

(`PartnerId` — check `grep -n "PartnerId" src/lib/tools.ts | head -1`; add to the `./types` type import if absent.) Then the mechanical call-site rewrite, verified by grep afterwards:

```bash
sed -i '' -E \
  -e 's/ctx\.customerStore\.(getCustomer|upsertOnFirstInbound)\(ctx\.phone\)/ctx.customerStore.\1(ctx.partnerId, ctx.phone)/g' \
  -e 's/ctx\.customerStore\.recordFundingMethod\(ctx\.phone,/ctx.customerStore.recordFundingMethod(ctx.partnerId, ctx.phone,/g' \
  -e 's/ctx\.store\.(listRecipients|listTransfersByPhone)\(ctx\.phone,/ctx.store.\1(ctx.partnerId, ctx.phone,/g' \
  -e 's/ctx\.store\.(getTransferCount|getTodayTransferCount)\(ctx\.phone\)/ctx.store.\1(ctx.partnerId, ctx.phone)/g' \
  -e 's/ctx\.dailyVolumeStore\.getTodayCents\(ctx\.phone\)/ctx.dailyVolumeStore.getTodayCents(ctx.partnerId, ctx.phone)/g' \
  -e 's/ctx\.dailyVolumeStore\.addCents\(ctx\.phone,/ctx.dailyVolumeStore.addCents(ctx.partnerId, ctx.phone,/g' \
  -e 's/ctx\.monthlyVolumeStore\.getMonthCents\(ctx\.phone\)/ctx.monthlyVolumeStore.getMonthCents(ctx.partnerId, ctx.phone)/g' \
  src/lib/tools.ts
grep -nE "\((ctx\.phone)[,)]" src/lib/tools.ts | grep -E "customerStore|listRecipients|listTransfersByPhone|TransferCount|VolumeStore"   # must print nothing
```

**Then, by hand, the six per-transfer / per-schedule OWNERSHIP checks the sed does not touch — they compare the phone alone, which is no longer an identity (F44 threat: partner acme holds its own app secret, so it can sign an inbound for its `phone_number_id` with `from` = a default-tenant customer's phone; after this task that turn runs under acme, and with only the phone check every reply below would act on the DEFAULT tenant's rows and go out from acme's number).** On `main` (`grep -nE "\.phone (!==|===) ctx\.phone" src/lib/tools.ts`) the hits are:

- `:1827` `generatePaymentLinkTool`, `:1843` `checkPaymentStatusTool`, `:2506` `updateRecipientPhoneTool` (this one MUTATES the transfer) — each `if (!transfer || transfer.phone !== ctx.phone) return { error: 'Transfer not found.' };` becomes
  `if (!transfer || transfer.phone !== ctx.phone || transfer.partnerId !== ctx.partnerId) return { error: 'Transfer not found.' };`
- `:1943` `resolveRefundTarget` (used by `request_refund` :1977 and the recall tool :2124) — `if (!transfer || transfer.phone !== ctx.phone) return { transfer: null, notFound: true };` becomes
  `if (!transfer || transfer.phone !== ctx.phone || transfer.partnerId !== ctx.partnerId) return { transfer: null, notFound: true };`
- `:2595` `listSchedulesTool` — `const mine = all.filter((s) => s.phone === ctx.phone);` becomes `const mine = all.filter((s) => s.phone === ctx.phone && s.partnerId === ctx.partnerId);`
- `:2613` `cancelScheduleTool` — `if (!schedule || schedule.phone !== ctx.phone) {` becomes `if (!schedule || schedule.phone !== ctx.phone || schedule.partnerId !== ctx.partnerId) {`

Keep the SAME arms (`'Transfer not found.'` / `{ transfer: null, notFound: true }` / `'Schedule not found.'`) so it stays 404-never-403 — another tenant's row is indistinguishable from a missing one. `Schedule.partnerId` is already required (`src/lib/types.ts:229`); `Transfer.partnerId` likewise. `:2357` (`active.phone === ctx.phone` in the active-draft check) is NOT changed — its list is already tenant-scoped by the `getActiveDraftId(ctx.partnerId, …)` rewrite above. Gate (also in Step 12.1): `grep -nE "\.phone (!==|===) ctx\.phone" src/lib/tools.ts` must show `partnerId !== ctx.partnerId` or `partnerId === ctx.partnerId` on every hit except `:2357`.

Then by hand: line 1223 `partnerId: customer.partnerId ?? DEFAULT_PARTNER_ID,` → `partnerId: ctx.partnerId,` and line 1316 `partnerId: legacyCustomer.partnerId ?? DEFAULT_PARTNER_ID,` → `partnerId: ctx.partnerId,` (the customer row was loaded under `ctx.partnerId`, so these are equal by construction — the explicit form is the one `tsc` can prove); ALSO every remaining `customer?.partnerId ?? DEFAULT_PARTNER_ID` at `tools.ts:1382, 1440, 1594, 2274` (`resolveBuyerPartnerId`) and `2550` → `ctx.partnerId` (or use `ctx.partnerId` directly): with the sed above those `customer` reads are tenant-scoped, so a MISSING row under acme would otherwise fall back to `DEFAULT` and read default's invoices/sellers during an acme turn — `grep -n "partnerId ?? DEFAULT_PARTNER_ID" src/lib/tools.ts` must print nothing afterwards; the `createDraft({` at line 2840 gains `partnerId: ctx.partnerId,` right after `senderPhone: ctx.phone,` (now REQUIRED by the `createDraft` input type — D12); line 3047 `ctx.draftStore.getActiveDraftId(ctx.phone)` → `getActiveDraftId(ctx.partnerId, ctx.phone)`. **Hard tenant guard on every draft resolution (D12):** immediately after the approve-tap `consumeDraft(ctxDraftId)` at `:1165` — BEFORE any quote/mint — and after the `consumeDraft(draftId)` in `cancelDraftTool` (`:3051`), insert:

```ts
    // D12 (fix 1): a draft id is a capability the model can echo; it must only
    // ever act under the tenant that created it. A mismatch is refused (and the
    // draft is put back untouched) — never minted under this tenant.
    if (draft && (draft.partnerId ?? DEFAULT_PARTNER_ID) !== ctx.partnerId) {
      await ctx.draftStore.restoreDraft(draft, ctxDraftId); // re-set the row + pointer under ITS tenant with the remaining TTL
      logWarn('draft.tenant_mismatch', 'draft resolved under another tenant', { draftId: ctxDraftId });
      return { error: 'That approval is not valid here. Ask the customer to start the send again.' };
    }
```

(In `cancelDraftTool` the local is named `draftId`, not `ctxDraftId`, and the refusal returns `{ cancelled: false, reason: 'no_active_draft' }` instead of an `error` — the same shape the existing "no pointer" arm returns, so the model learns nothing about another tenant's draft.) `DraftStore.restoreDraft(draft, draftId)` is a small additive method (re-`set` `recipient_draft:<id>` and `active_draft:{tenant}:{phone}` with `ex: DRAFT_TTL_SECONDS`) so a refused tap never destroys the legitimate tenant's draft. `pay-finalize.ts` needs no guard: it resolves the tenant FROM the draft (Step 7), which is the draft's own tenant by definition. If `DEFAULT_PARTNER_ID` becomes unused in tools.ts, drop it from the import (eslint `--max-warnings 0`).

`src/lib/web-chat.ts` lines 42-59 become:

```ts
export type WebChatDeps = Omit<AgentDeps, 'channel' | 'waCreds' | 'partnerId'>;

/**
 * Build the web-channel chat over injected deps (tests bind PGlite/fakeRedis;
 * production uses runWebChatTurn below). isNewConversation is derived from web
 * thread emptiness — there is no 24h-gap heuristic and no buttonTap on web.
 * The agent runs under the PORTAL customer's tenant (fix 1): the session
 * resolved exactly one (partnerId, phone) row, and that is the tenant whose
 * ledger, recipients and counters the tools may read.
 */
export function createWebChat(deps: WebChatDeps) {
  const store = webThreadStore(deps.store);
  return {
    async runTurn(customer: Customer, text: string): Promise<string> {
      const agent = createAgent({ ...deps, store, channel: 'web', partnerId: customer.partnerId });
      const phone = customer.senderPhone;
      const isNewConversation = (await store.getConversation(customer.partnerId, phone)).length === 0;
      return agent.runAgentTurn(phone, text, { isNewConversation });
    },
  };
}
```

and `webThreadStore` (lines 33-40) follows the tenant-keyed store contract (D12) — the web thread lands at `conv:{partnerId}:web:{phone}`:

```ts
export function webThreadStore(base: Store): Store {
  return {
    ...base,
    getConversation: (partnerId, phone) => base.getConversation(partnerId, webThreadPhone(phone)),
    saveConversation: (partnerId, phone, messages) =>
      base.saveConversation(partnerId, webThreadPhone(phone), messages),
  };
}
```

(`tests/web-chat.test.ts` — the key assertion, if any, becomes `conv:default:web:<phone>`; a web thread has no legacy dual-read to worry about because `legacyKeyAllowed` is evaluated on `web:<phone>`, which has no customers row ⇒ never falls back.)

6.4 Run:

```bash
npx vitest run tests/tools.test.ts tests/agent.test.ts tests/e2e.test.ts tests/partner-orchestration.test.ts tests/web-chat.test.ts tests/recent-transfers.test.ts tests/verify-link.test.ts
```

Expected: all green.

6.5 Commit:

```
feat(agent): run every turn under the routed tenant — ToolContext.partnerId, tenant-keyed recipients/ledger/counters, drafts carry partnerId

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7 — Money-path callers: createTransfer accruals, pay-finalize, B2B finalize, cron, pay route/page, Persona webhook, KYC case store, mock KYC, customer summary

Money-path invariants that apply here (CLAUDE.md): sanctions screening stays structurally untoggleable — `screenTransfer` at `transfer-create.ts:157-164` is not moved or gated; claim-first minting and the single-transaction paid flip are untouched; every change below is to WHICH tenant a counter/recipient/customer read is keyed under, never to whether a guard runs.

7.1 Failing tests. `tests/transfer-create.test.ts` — add to `describe('createTransfer')`:

```ts
  it('upserts the recipient and bumps velocity + monthly volume under input.partnerId only (F45/F47)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(await store.listRecipients('acme', base.phone, 5)).toHaveLength(1);
    expect(await store.listRecipients('default', base.phone, 5)).toEqual([]);
    expect(await store.getTodayTransferCount('acme', base.phone)).toBe(1);
    expect(await store.getTodayTransferCount('default', base.phone)).toBe(0);
    expect(await mvs.getMonthCents('acme', base.phone)).toBe(20_000);
    expect(await mvs.getMonthCents('default', base.phone)).toBe(0);
    expect(await store.getTransferCount('acme', base.phone)).toBe(1);
    expect(await store.getTransferCount('default', base.phone)).toBe(0);
  });
```

Also prefix `'default', ` on the existing `store.getTransferCount(`, `store.getTodayTransferCount(`, `mvs.getMonthCents(`, `store.listRecipients(` calls in that file (`sed -i '' -E "s/(store\.getTransferCount|store\.getTodayTransferCount|mvs\.getMonthCents|store\.listRecipients|mvs\.addCents)\((base\.phone|blockedInput\.phone|'15551234567')/\1('default', \2/g" tests/transfer-create.test.ts`, then grep for stragglers).

`tests/pay-finalize.test.ts`: `stores.customerStore.upsertOnFirstInbound(PHONE)` (5) → `upsertOnFirstInbound('default', PHONE)`; `getCustomer(PHONE)` (2) → `('default', PHONE)`; `getTransferCount(PHONE)` (4) → `('default', PHONE)`; `addCents(PHONE,`/`getTodayCents(PHONE)` → `('default', PHONE…`; and the `createDraft({ senderPhone: PHONE,` in `makeDraft` gains `partnerId: 'default',`. Add:

```ts
  it('mints under the DRAFT tenant, not the default one (fix 1)', async () => {
    const stores = await buildStores();
    await seedPartner(stores.db, 'acme');
    const { customer } = await stores.customerStore.upsertOnFirstInbound('acme', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified' });
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'acme',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    });
    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await stores.store.getTransfer(result.transferId))!.partnerId).toBe('acme');
    expect(await stores.store.listRecipients('acme', PHONE, 5)).toHaveLength(1);
    expect(await stores.store.listRecipients('default', PHONE, 5)).toEqual([]);
    expect((await stores.customerStore.getCustomer('acme', PHONE))!.lastFundingMethod).toBe('bank_transfer');
  });
```

`tests/b2b-crossborder-pay.test.ts` lines 77 and 244 → `upsertOnFirstInbound(DEFAULT_PARTNER_ID, BUYER_PHONE)`. `tests/cron-run.test.ts`: no call-site change (seedVerified uses saveCustomer). `tests/kyc-case-store.test.ts`: every `store.applyDelta(PHONE,` → `store.applyDelta('default', PHONE,`; `store.review(PHONE,` → `store.review('default', PHONE,`; `store.getAudit(PHONE)` → `store.getAudit('default', PHONE)`; `cs.getCustomer(PHONE)` → `cs.getCustomer('default', PHONE)`, plus:

```ts
  it('applyDelta / review / audit are tenant-scoped: acme cannot move the default row and audit trails never cross tenants', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme'); // the file's own handle, exactly as the D10 test below — never a second freshDb() (it re-truncates the singleton the beforeEach just seeded)
    await seed();
    expect(await store.applyDelta('acme', PHONE, { kycReviewState: 'approved' }, { actor: 'x', action: 'a' })).toBeNull();
    expect((await cs.getCustomer('default', PHONE))!.kycReviewState).toBeUndefined();
    await store.review('default', PHONE, 'approve', 'staff-1', 'ok');
    expect((await store.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['review.approve']);
    expect(await store.getAudit('acme', PHONE)).toEqual([]);
  });

  it('D10: a legacy phone-only audit trail is visible to the pre-fix (oldest-row) tenant and to NO sibling', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    await seed(); // the default row (older)
    await cs.upsertOnFirstInbound('acme', PHONE); // the post-fix sibling
    await redis.hset(`kyc_audit:${PHONE}`, { '1': JSON.stringify({ at: '2026-01-01T00:00:00Z', actor: 'persona', action: 'legacy.event' }) });
    expect((await store.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['legacy.event']);
    expect(await store.getAudit('acme', PHONE)).toEqual([]);
  });
```

(Both tests seed `acme` on the file's `db` handle BEFORE `seed()`, as written above; there is no double-`freshDb` trick anywhere in this file.)

`tests/kyc-provider.test.ts` lines 25/29, `tests/persona-webhook-route.test.ts` lines 63/71/82/86, `tests/review-kyc-action.test.ts` 56/67/77, `tests/account-verify-action.test.ts` 58/69, `tests/account-settings-actions.test.ts` 109/117: `getCustomer(PHONE)`/`getCustomer(NORM)`/`upsertOnFirstInbound(PHONE)` → prefix `'default', `. `tests/customer-summary.test.ts`: `deps.getCustomerSummary(PHONE)` calls → `getCustomerSummary('default', PHONE)` (grep `getCustomerSummary(` in the file; the fake deps at lines 84-85 need no change — fewer-parameter fakes are assignable). `tests/review-kyc-action.test.ts` forms gain `partnerId: 'default'` (the action reads it; partner staff are pinned regardless — Step 10).

7.2 Run and expect failure: `npx vitest run tests/transfer-create.test.ts tests/pay-finalize.test.ts` → `expected [ { name: 'Mom', … } ] to deeply equal []` (recipient written under default for an acme transfer — F45) and `expected 1 to be 0` (counters).

7.3 Implement.

`src/lib/transfer-create.ts` — line 150 → `const transferCount = await store.getTransferCount(input.partnerId, input.phone);`; line 157 → `const transfersToday = await store.getTodayTransferCount(input.partnerId, input.phone);`; line 162 → `const monthUsedCents = await monthlyVolumeStore.getMonthCents(input.partnerId, input.phone);   // NEW (KYC)`; lines 232-247 become:

```ts
  await store.saveTransfer(transfer);
  // (transfer count is now DERIVED from the ledger — no counter to bump)
  // Accruals and the address book are keyed by the transfer's TENANT (fix 1 /
  // F45, F47): a partner-API mint for a number can never touch another tenant's
  // saved destinations or compliance counters for that same number.
  await store.incrementTodayTransferCount(input.partnerId, input.phone);
  await monthlyVolumeStore.addCents(input.partnerId, input.phone, Math.round(transfer.amountUsd * 100));   // NEW (KYC)

  try {
    await store.upsertRecipient(input.partnerId, input.phone, {
      name: input.recipientName,
      recipientPhone: input.recipientPhone,
      payoutMethod: input.payoutMethod,
      payoutDestination: input.payoutDestination,
      lastUsedAt: new Date().toISOString(),
    });
  } catch (err) {
    logWarn('transfer.upsert_recipient', err, { transferId: transfer.id });
  }
```

(Whether an API mint should skip `upsertRecipient` entirely is fix 6's call — it owns this region in wave 2; leave the behaviour, note it in the PR.)

`src/lib/pay-finalize.ts` — lines 78-84 become:

```ts
  // The draft's tenant (fix 1). Legacy in-flight drafts (no partnerId) drain
  // under the default tenant for their 30-min TTL.
  const partnerId = draft.partnerId ?? DEFAULT_PARTNER_ID;
  const customer =
    (await customerStore.getCustomer(partnerId, draft.senderPhone)) ??
    (await customerStore.upsertOnFirstInbound(partnerId, draft.senderPhone)).customer;
  // WL1: resolve the owning partner — drives the gate toggle + requiresKyc.
  const partner =
    (await partnerStore.getPartner(partnerId)) ??
    (await partnerStore.ensureDefaultPartner());
```

line 95 → `const todayUsedCents = await dailyVolumeStore.getTodayCents(partnerId, draft.senderPhone);`; line 161 → `partnerId,`; ~line 197 `await dailyVolumeStore.addCents(draft.senderPhone, …)` → `addCents(partnerId, draft.senderPhone, …)`; line 208 → `await customerStore.recordFundingMethod(partnerId, draft.senderPhone, draft.fundingMethod);`. (`DEFAULT_PARTNER_ID` is already imported at :4; the `draft:<id>` claim at :105 keeps `DEFAULT_PARTNER_ID` — D5.) Then `grep -rn "addCents(\|getTodayCents(\|getMonthCents(" src` — every hit must carry a tenant as its first argument (tsc catches stragglers, but find them now, not at Step 12).

`src/lib/b2b-pay-finalize.ts` lines 151-153 → `(await customerStore.getCustomer(partnerId, invoice.buyerPhone)) ?? (await customerStore.upsertOnFirstInbound(partnerId, invoice.buyerPhone)).customer;` (`partnerId` is `invoice.partnerId`, :82).

`src/lib/cron-run.ts:54` → `const owner = await deps.customerStore.getCustomer(schedule.partnerId, schedule.phone);`. `src/app/api/cron/route.ts:78` → `(await customerStore.getCustomer(schedule.partnerId, schedule.phone))?.fullName ?? 'there'`.

`src/app/api/pay/[transferId]/route.ts` — add `import { DEFAULT_PARTNER_ID } from '@/lib/defaults';`; lines 252-254 become:

```ts
          const otpPartnerId = otpDraft
            ? (otpDraft.partnerId ?? DEFAULT_PARTNER_ID)
            : (await store.getTransfer(transferId))?.partnerId;
```

line 312 → `const owner = await getCustomerStore(store).getCustomer(transfer.partnerId, transfer.phone);`.

`src/app/api/pay/b2b/[invoiceId]/route.ts:170` → `const owner = await customerStore.getCustomer(invoice.partnerId, buyerPhone);`.

`src/app/pay/[transferId]/page.tsx` lines 137-139 become (drop the now-unused `getCustomerStore`/`getStore` imports if nothing else in the file uses them — `grep -n "getCustomerStore\|getStore()" src/app/pay/\[transferId\]/page.tsx`):

```ts
      // The draft carries its tenant (fix 1); legacy in-flight drafts brand as default.
      brandPartnerId = draft.partnerId ?? DEFAULT_PARTNER_ID;
```

`src/app/api/persona-webhook/route.ts` lines 49-53 and 57 become:

```ts
  const phone = event.referenceId;
  if (!phone) return NextResponse.json({ ok: true, ignored: true });

  // Tenant resolution (fix 1, D7): the Persona reference-id is the phone
  // (persona-kyc-provider.ts:47) and a phone may have a row under several
  // partners. Bind by the inquiry id the row recorded when verification started;
  // fall back to the single row only when the phone is unambiguous. Never guess.
  const rows = await getCustomerStore(getStore()).findByPhone(phone);
  const customer =
    rows.find((c) => Boolean(event.inquiryId) && c.kycInquiryId === event.inquiryId) ??
    (rows.length === 1 ? rows[0] : null);
  if (!customer) return NextResponse.json({ ok: true, ignored: true });

  const delta = applyKycEvent(customer, event);
  let nextState = customer.kycReviewState;
  if (Object.keys(delta).length > 0) {
    const updated = await cases.applyDelta(customer.partnerId, phone, delta, { actor: 'persona', action: event.name });
    nextState = updated?.kycReviewState ?? nextState;
  }
```

`src/lib/kyc-case-store.ts` — line 20 → `const auditKey = (partnerId: PartnerId, phone: string) => \`kyc_audit:${partnerId}:${phone}\`;` plus `const legacyAuditKey = (phone: string) => \`kyc_audit:${phone}\`;` (import `type { Customer, PartnerId } from './types'`); `appendAudit(partnerId, phone, entry)` uses `auditKey(partnerId, phone)` in both places; `applyDelta(partnerId: PartnerId, phone: string, delta, meta)` reads `customers.getCustomer(partnerId, phone)` and calls `appendAudit(partnerId, phone, …)`; `review(partnerId: PartnerId, phone, decision, reviewer, reason)` likewise; `getAudit(partnerId: PartnerId, phone: string)`:

```ts
    async getAudit(partnerId: PartnerId, phone: string): Promise<AuditEntry[]> {
      // Tenant-scoped since fix 1. TRANSITIONAL (D10): an empty scoped trail
      // falls back to the pre-fix phone-only key ONLY for the phone's pre-fix
      // (oldest-row) tenant — legacyKeyAllowed, the same D9 helper — so a
      // post-fix sibling tenant's staff never read another tenant's KYC events.
      let raw = await redis.hgetall(auditKey(partnerId, phone));
      const empty = !raw || (Array.isArray(raw) ? raw.length === 0 : Object.keys(raw).length === 0);
      if (empty && (await legacyKeyAllowed(partnerId, phone, legacyTenantResolver(customers)))) {
        raw = await redis.hgetall(legacyAuditKey(phone));
      }
      if (!raw) return [];
      … (the existing pairs/sort/parse body, unchanged)
```

and `listNeedsReview(partnerId?: PartnerId)` → `const all = await customers.listCustomers(partnerId);`.

`src/lib/providers/mock-kyc-provider.ts:26-35`:

```ts
  async getStatus(providerRef: string): Promise<KycStatus> {
    // providerRef is "mock-<phone>". A phone may have a row per tenant (fix 1):
    // bind by the ref the row recorded, else the single unambiguous row.
    const phone = providerRef.startsWith('mock-') ? providerRef.slice('mock-'.length) : null;
    if (!phone) return 'pending';
    const rows = await this.customerStore.findByPhone(phone);
    const customer = rows.find((c) => c.kycProviderRef === providerRef) ?? (rows.length === 1 ? rows[0] : null);
    if (!customer) return 'pending';
    if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'verified';
    if (customer.kycStatus === 'rejected') return 'rejected';
    return 'pending';
  }
```

`src/lib/customer-summary.ts` — deps (lines 182-187): `store: { listTransfersByPhone(partnerId: PartnerId, phone: string, limit?: number): Promise<Transfer[]> }`, `customers: { getCustomer(partnerId: PartnerId, phone: string): Promise<Customer | null> }`, `dailyVolume: { getTodayCents(partnerId: PartnerId, phone: string): Promise<number> }`; `getCustomerSummary(partnerId: PartnerId, phone: string)` with `cacheKey(partnerId, phone)` = `summary:${partnerId}:${phone}` (find `cacheKey` above line 176 and give it the second parameter) and the three reads at lines 210-212 pass `partnerId, phone`; line 267 → `export function getCustomerSummary(partnerId: PartnerId, phone: string)`.

`src/app/api/copilot/kyc-review/route.ts:69-71` → `.getAudit(customer.partnerId, phone)`.

7.4 Run:

```bash
npx vitest run tests/transfer-create.test.ts tests/transfer-create-gate.test.ts tests/pay-finalize.test.ts tests/b2b-crossborder-pay.test.ts tests/cron-run.test.ts tests/kyc-case-store.test.ts tests/kyc-provider.test.ts tests/persona-webhook-route.test.ts tests/review-kyc-action.test.ts tests/account-verify-action.test.ts tests/customer-summary.test.ts tests/pay-route-bank-details.test.ts tests/pay-route-otp.test.ts tests/pay-route-funding.test.ts tests/pay-route-ach-pull.test.ts tests/pay-route-delayed-poke.test.ts tests/pay-route-in-review.test.ts
```

Expected: green. (`review-kyc-action` and `account-verify-action` may still fail on the action signatures until Steps 9/10 land — note which and re-run there.)

7.5 Commit:

```
fix(money-paths): key accruals, recipients and customer reads by the transfer/draft/invoice tenant; Persona + mock KYC bind by inquiry id; KYC audit trail scoped

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 8 — Partner API: bind `sender.phone` to `partner.id` before the idempotency claim (F45/F47/F50/F52 at the API)

8.1 Failing tests — `tests/partner-api-service.test.ts`: the harness (lines 20-51) adds `customerStore` to `deps`:

```ts
  const customerStore = createCustomerStore(db, store);
  const deps: PartnerApiDeps = {
    store,
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(redis),
    integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
    customerStore,
    db,
    now: () => NOW,
    genId: () => `b${n++}`,
    initiatePayment: async (t) => { … unchanged … },
  };
  return { redis, store, deps, db, customerStore };
```

**In the same step, `tests/partner-api-rates.test.ts` `harness()` (lines 20-33)** — it builds a FULL `PartnerApiDeps` literal (`store, partnerStore, monthlyVolumeStore, integrationsStore, db, now, genId`) and `tsconfig.json` `include: ["**/*.ts", "**/*.tsx"]` type-checks `tests/`, so once `customerStore` is a REQUIRED field (8.3) this file — which the plan only RUNS in 8.4 — turns `npx tsc --noEmit` (Step 12.1 and the Stop hook) red; vitest hides it because it does not typecheck. Add `import { createCustomerStore } from '@/lib/customer-store';` to its imports, bind the store once and pass it:

```ts
  let n = 0;
  const store = createStore(redis, db);
  const deps: PartnerApiDeps = {
    store,
    customerStore: createCustomerStore(db, store),
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(redis),
    integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
    db,
    now: () => NOW,
    genId: () => `r${n++}`,
  };
```

(The tenant-boundary `apiDeps()` in Step 11 already carries `customerStore`; `src/lib/partner-api.ts` is the third literal and is edited in 8.3.)

and a new describe:

```ts
describe('partner-api-service: sender.phone is bound to the calling tenant (fix 1)', () => {
  const OTHER_TENANT_PHONE = '15551230000';

  async function seedDefaultTenantCustomer(customerStore: ReturnType<typeof createCustomerStore>, store: ReturnType<typeof createStore>) {
    // The same number is a fully KYC'd DEFAULT-tenant customer with a saved payout destination.
    await customerStore.saveCustomer({
      senderPhone: OTHER_TENANT_PHONE, fullName: 'Default Owner', firstSeenAt: NOW, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', passwordHash: 'pw', createdAt: NOW, updatedAt: NOW,
    } as Parameters<typeof customerStore.saveCustomer>[0]);
    await store.upsertRecipient('default', OTHER_TENANT_PHONE, {
      name: 'Anita', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: 'REAL-ACCOUNT-0001', lastUsedAt: NOW,
    });
  }

  it('minting for an unknown phone creates the customer under the CALLING partner, not default, with no WhatsApp opt-in', async () => {
    const { deps, customerStore } = await harness();
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-t1', txBody({ sender: { phone: '15557770000', kyc_status: 'not_started' } }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    const acme = await customerStore.getCustomer('acme', '15557770000');
    expect(acme).not.toBeNull();
    expect(acme!.optInAt).toBeUndefined();
    expect(await customerStore.getCustomer('default', '15557770000')).toBeNull();
  });

  it('a phone owned by another tenant: no ledger/recipient/velocity/PII side effect on that tenant, and the response is shaped exactly like an unknown phone', async () => {
    const { deps, store, customerStore } = await harness();
    await seedDefaultTenantCustomer(customerStore, store);
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-t2', txBody({
      beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: 'PLANTED-9999' },
    }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (!r.ok) throw new Error('unexpected');
    expect((r.data as { sender_name: string | null }).sender_name).toBeNull(); // F50/F52: default's decrypted name never leaves
    // F45/F47: default's address book + counters untouched; acme has its own.
    expect((await store.listRecipients('default', OTHER_TENANT_PHONE, 5))[0].payoutDestination).toBe('REAL-ACCOUNT-0001');
    expect((await store.listRecipients('acme', OTHER_TENANT_PHONE, 5))[0].payoutDestination).toBe('PLANTED-9999');
    expect(await store.getTodayTransferCount('default', OTHER_TENANT_PHONE)).toBe(0);
    expect(await store.getTodayTransferCount('acme', OTHER_TENANT_PHONE)).toBe(1);
    expect(await deps.monthlyVolumeStore.getMonthCents('default', OTHER_TENANT_PHONE)).toBe(0);
    // F44 at the API: the default row is byte-identical (partner_id, kyc, PII, password).
    const dflt = (await customerStore.getCustomer('default', OTHER_TENANT_PHONE))!;
    expect([dflt.partnerId, dflt.kycStatus, dflt.fullName, dflt.passwordHash]).toEqual(['default', 'verified', 'Default Owner', 'pw']);
    const acmeRow = (await customerStore.getCustomer('acme', OTHER_TENANT_PHONE))!;
    expect([acmeRow.kycStatus, acmeRow.fullName, acmeRow.passwordHash]).toEqual(['not_started', undefined, undefined]);
    // Every transfer for this key belongs to acme.
    expect((await store.listTransfers()).every((t) => t.partnerId === 'acme')).toBe(true);
  });

  it('GET /transactions and GET /transactions/:id never return another tenant\'s sender_name', async () => {
    const { deps, store, customerStore } = await harness();
    await seedDefaultTenantCustomer(customerStore, store);
    const created = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-t3', txBody());
    if (!created.ok) throw new Error('unexpected');
    const id = (created.data as { id: string }).id;
    const got = await getTransaction(deps, 'acme', id);
    expect(got.ok && (got.data as { sender_name: string | null }).sender_name).toBeNull();
    const page = await listTransactions(deps, 'acme', { limit: '10', cursor: null });
    expect(page.ok && (page.data as { transactions: { sender_name: string | null }[] }).transactions[0].sender_name).toBeNull();
    // …and acme's OWN captured name does resolve.
    await seedNamedCustomer(customerStore, '15551230000', 'Acme Owner');
    const again = await getTransaction(deps, 'acme', id);
    expect(again.ok && (again.data as { sender_name: string | null }).sender_name).toBe('Acme Owner');
  });

  it('the customer is resolved BEFORE the idempotency claim and AFTER every body check: a 400/404 never binds the key and never writes a customer row', async () => {
    const { deps, customerStore } = await harness();
    const bad = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-t4', txBody({ amount_source: -1 }));
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    // The key is bound only by the claim; the claim runs after every body check and the sender resolution.
    expect(await createIdempotencyRepo(deps.db).find('acme', 'idem-t4')).toBeNull();
    // A rejected BENEFICIARY (404) must not have created the sender row either —
    // otherwise an API-keyed caller could mint unbounded customer rows under its
    // tenant with rejected bodies (the beneficiary block runs ABOVE ensureCustomer).
    const missing = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-t5', txBody({ sender: { phone: '15557770001', kyc_status: 'not_started' }, beneficiary_id: 'ben_nope' }));
    expect(missing).toMatchObject({ ok: false, status: 404 });
    expect(await createIdempotencyRepo(deps.db).find('acme', 'idem-t5')).toBeNull();
    expect(await customerStore.getCustomer('acme', '15557770001')).toBeNull();
  });
});
```

`seedNamedCustomer` (line 54) already saves under `'acme'`.

8.2 Run and expect failure: `npx vitest run tests/partner-api-service.test.ts` → `expected 'Default Owner' to be null` (F50/F52 reproduced) and `expected 'PLANTED-9999' to be 'REAL-ACCOUNT-0001'` (F45/F47 reproduced) and `expected 'b0' to be null` (key bound before validation).

8.3 Implement `src/lib/partner-api-service.ts`.

`PartnerApiDeps` (line 46) gains `customerStore: CustomerStore; // fix 1 — sender rows are per tenant` (add `import type { CustomerStore } from './customer-store';`). `createTransaction` lines 246-268 become:

```ts
  if (!idempotencyKey) return err(400, 'Idempotency-Key header is required.');

  // Body validation + TENANT BINDING run BEFORE the idempotency claim (fix 1):
  // a refusal here never binds the key to a half-minted id. sender.phone is
  // resolved under partner.id ONLY — another tenant's row for the same number
  // is structurally unreachable, so the response for "someone else's customer"
  // is identical to "unknown phone" (no enumeration oracle; 404-never-403 spirit).
  const amount = num(body.amount_source ?? body.amount);
  if (amount === null || amount <= 0) return err(400, 'amount_source must be a positive number.');

  const sender = (body.sender && typeof body.sender === 'object' ? body.sender : {}) as Record<string, unknown>;
  const senderPhone = str(sender.phone);
  if (!senderPhone) return err(400, 'sender.phone is required.');

  // Beneficiary: by reference (partner-scoped) or inline. MOVED ABOVE the
  // customer write and the claim (on main it sits below both, :269-284): a
  // 404 / 400 here must leave NO customer row behind, or an API-keyed caller
  // could create unbounded customer rows under its tenant with rejected bodies.
  let benName = '', benPhone = '', payoutMethod: PayoutMethod = 'bank', payoutDestination = '';
  const benId = str(body.beneficiary_id);
  if (benId) {
    const stored = await getStoredBeneficiary(deps, partner.id, benId);
    if (!stored) return err(404, 'Beneficiary not found.');
    benName = stored.name; benPhone = stored.recipientPhone ?? '';
    payoutMethod = stored.payoutMethod; payoutDestination = stored.payoutDestination;
  } else {
    const ben = (body.beneficiary && typeof body.beneficiary === 'object' ? body.beneficiary : {}) as Record<string, unknown>;
    benName = str(ben.name);
    if (!benName) return err(400, 'beneficiary.name (or beneficiary_id) is required.');
    benPhone = str(ben.phone);
    payoutMethod = (str(ben.payout_method) as PayoutMethod) || 'bank';
    payoutDestination = str(ben.payout_destination);
  }

  // The LAST step before the claim, AFTER every body check (Task 2 Step 28
  // later inserts its beneficiary name / destination edge validation ABOVE this
  // line — never below it). No WhatsApp opt-in is implied by an API mint
  // (ensureCustomer, not upsertOnFirstInbound).
  await deps.customerStore.ensureCustomer(partner.id, senderPhone);

  // CLAIM-FIRST idempotency (Stage 2c): pre-generate the transfer id and bind
  // the key BEFORE minting. PK(partner_id, key) means exactly one id can ever
  // own this key — a concurrent duplicate or crash-replay deterministically
  // converges on the winner, and a crash after the claim re-mints the SAME id.
  const idem = createIdempotencyRepo(deps.db);
  const candidateId = (deps.genId ?? newTransferId)();
  const reservedId = await idem.claim(partner.id, idempotencyKey, candidateId);
  if (reservedId !== candidateId) {
    // The key was already bound — replay. (A bound-but-unminted id means a
    // prior attempt crashed mid-mint; fall through and mint THAT id.)
    const t = await deps.store.getTransfer(reservedId);
    if (t && t.partnerId === partner.id) return ok(200, await transferViewWithName(deps, t));
  }
```

(the original `amount`/`sender` blocks at :262-268 AND the beneficiary block at :269-284 are deleted — all three now live above the claim, beneficiary before `ensureCustomer`; everything from `// senderPhone is required here` (:286) on is unchanged.) State in the PR: a POST-claim refusal — `createTransfer`'s `kyc_required` 422 or a `QuoteError` 400 — still leaves the freshly created tenant customer row behind; acceptable (the row is the partner's own, carries no opt-in and no PII), and the "a 400/404 never writes a customer row" test deliberately covers only PRE-mint refusals.

`src/lib/partner-api.ts` deps (line 50-56) gain `customerStore: getCustomerStore(getStore()),` with `import { getCustomerStore } from './customer-store';` — bind `const store = getStore();` once and pass it to both.

8.4 Gate first: `grep -rn "PartnerApiDeps = {" tests src` must list exactly three literals — `tests/partner-api-rates.test.ts`, `tests/partner-api-service.test.ts`, `src/lib/partner-api.ts` (plus `tests/tenant-boundary.test.ts` once Step 11 lands) — and every one of them must carry `customerStore` (`grep -A12 "PartnerApiDeps = {" <file> | grep customerStore` per file); then `npx tsc --noEmit` must be clean BEFORE the vitest run (vitest does not typecheck). Then run: `npx vitest run tests/partner-api-service.test.ts tests/partner-api-auth.test.ts tests/partner-api-key.test.ts tests/partner-api-rates.test.ts` → green, including the pre-existing idempotency/replay tests at lines 157-192 (a replayed valid body still hits the claim and returns 200).

8.5 Commit:

```
fix(partner-api): bind sender.phone to the calling tenant before the idempotency claim; sender_name only ever from the caller's own row (F45, F47, F50, F52)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 9 — Customer portal: sessions carry the tenant; one account-bearing row per phone; fail closed

9.1 Failing tests — `tests/customer-auth-store.test.ts`: every `s.createSession(NORM)` / `s.createSession('19998887777')` gains `, 'default'` as second argument; `customers.getCustomer(NORM)` (2) → `getCustomer('default', NORM)`; add:

```ts
describe('tenant binding (fix 1, D6)', () => {
  it('a session carries the tenant and resolveSession returns THAT row', async () => {
    const { s, customers } = await mkAuth();
    const { seedPartner, freshDb } = await import('./helpers-db');
    await seedPartner(await freshDb(), 'acme');
    await s.registerCustomer({ phone: PHONE, email: 'a@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto });
    // a sibling acme row for the same number (bot-only, no account)
    await customers.upsertOnFirstInbound('acme', NORM);
    const token = await s.createSession(NORM, 'default');
    expect(await s.getSession(token)).toBe(NORM);
    expect((await s.resolveSession(token))?.partnerId).toBe('default');
    expect((await s.resolveSession(token))?.passwordHash).toBeTruthy();
  });

  it('a pre-fix session record without partnerId resolves to nothing (forces re-login)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = 'a'.repeat(64);
    const { createHash } = await import('node:crypto');
    await redis.set(`sr_sess:${createHash('sha256').update(token).digest('hex')}`, JSON.stringify({ phone: NORM, createdAtMs: Date.now(), lastSeenMs: Date.now() }));
    expect(await s.resolveSession(token)).toBeNull();
  });

  it('login resolves exactly one account-bearing row and fails CLOSED when the phone has accounts under two partners', async () => {
    const { s, customers } = await mkAuth();
    const { seedPartner, freshDb } = await import('./helpers-db');
    await seedPartner(await freshDb(), 'acme');
    const c = await s.registerCustomer({ phone: PHONE, email: 'a@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto });
    expect(c.partnerId).toBe('default');
    expect((await s.verifyCustomerPassword(PHONE, 'correct horse battery'))?.partnerId).toBe('default');
    // A second account-bearing row appears under acme (e.g. an admin import) ⇒ ambiguous ⇒ null, never a guess.
    await customers.saveCustomer({ ...c, partnerId: 'acme' });
    expect(await s.verifyCustomerPassword(PHONE, 'correct horse battery')).toBeNull();
    expect(await s.markPhoneVerified(PHONE)).toBeNull();
    expect(await s.setPassword(PHONE, 'another good one!!', { pwnedCheck: neverPwned() })).toBeNull();
  });

  it('registerCustomer attaches to the single existing row (any tenant) and refuses when the phone exists under two', async () => {
    const { s, customers } = await mkAuth();
    const { seedPartner, freshDb } = await import('./helpers-db');
    await seedPartner(await freshDb(), 'acme');
    await customers.upsertOnFirstInbound('acme', NORM); // bot-only acme customer registers on the portal
    const c = await s.registerCustomer({ phone: PHONE, email: 'a@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto });
    expect(c.partnerId).toBe('acme');
    expect(await customers.getCustomer('default', NORM)).toBeNull(); // no stray default row
    await customers.upsertOnFirstInbound('default', '15550102031');
    await customers.upsertOnFirstInbound('acme', '15550102031');
    await expect(
      s.registerCustomer({ phone: '15550102031', email: 'b@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto }),
    ).rejects.toBeInstanceOf(CustomerInputError);
  });
});
```

(`CustomerInputError` import: `import { createCustomerAuthStore, CustomerInputError } from '@/lib/customer-auth-store';`. `mkAuth` calls `freshDb()` itself — the helper's second `freshDb()` call truncates and reseeds; call `seedPartner` BEFORE `registerCustomer`/`upsert` as written, and move `mkAuth()` after the seed if the truncate order bites: `const { s, customers } = await mkAuth(); await seedPartner(db, 'acme')` — expose `db` from `mkAuth` (`return { s, customers, db }`) and use it instead of a second `freshDb()`.)

`tests/account-actions.test.ts` — the two `authStore.getSession(token)` asserts (166, 290) are unchanged in meaning; add one test after the login describe:

```ts
  it('login mints the session under the account row tenant', async () => {
    // register + verify as the existing flow does (see the tests above), then:
    const res = await loginAction(null, form({ phone: PHONE, password: PASSWORD })).catch((e: Error) => e.message);
    expect(res).toBe('REDIRECT:/account');
    const token = cookieJar.get(CUSTOMER_SESSION_COOKIE)!;
    expect((await authStore.resolveSession(token))?.partnerId).toBe('default');
  });
```

(reuse whatever register+OTP helper the file already has above line 166 to get to a verified account first.)

9.2 Run and expect failure: `npx vitest run tests/customer-auth-store.test.ts` → `s.resolveSession is not a function` / `createSession` ignores the second argument / ambiguity test `expected { … } to be null`.

9.3 Implement `src/lib/customer-auth-store.ts`.

Imports: add `PartnerId` to the `./types` type import. Lines 71-75 and the helper block 105-111 become:

```ts
interface SessionRecord {
  phone: string;
  partnerId?: PartnerId; // absent only on pre-fix-1 records ⇒ resolves to nothing (re-login)
  createdAtMs: number;
  lastSeenMs: number;
}

export interface SessionIdentity {
  phone: string;
  partnerId: PartnerId;
}
```

```ts
  // Customer RECORDS live in Postgres. A phone may have a row per tenant (fix 1);
  // the portal binds to the ONE account-bearing row (the row holding
  // password_hash). Two account-bearing rows ⇒ ambiguous ⇒ null: the portal
  // fails CLOSED rather than logging someone into the wrong tenant's history.
  async function loadAccountRow(phone: string): Promise<Customer | null> {
    const rows = await customers.findByPhone(phone);
    const withAccount = rows.filter((c) => Boolean(c.passwordHash));
    return withAccount.length === 1 ? withAccount[0] : null;
  }

  async function saveCustomer(customer: Customer): Promise<void> {
    await customers.saveCustomer(customer);
  }
```

`getCustomer(phoneRaw)` (line 115) → `return loadAccountRow(normalizePhone(phoneRaw));` with the doc comment `/** The account-bearing Customer for a phone, or null (missing OR ambiguous). Used by password reset. */`.

Add at module scope (and `import { logWarn } from './log';`):
```ts
/** The ONE register refusal shown to the browser (D6): never says whether the number exists or under how many tenants. */
const REGISTER_UNAVAILABLE =
  "We can't set up an account for this number. If you already have one, sign in or reset your password; otherwise contact support.";
```
`grep -rn "An account already exists for this number" src tests` — update every test that asserted the old string (`tests/customer-auth-store.test.ts`, `tests/account-actions.test.ts` if present) to `REGISTER_UNAVAILABLE`'s text; the UI renders `CustomerInputError.message` as-is, so no page change.

`registerCustomer` lines 133-139 and 170-195 become:

```ts
      // Collision-before-create: never silently overwrite/hijack an existing
      // account. saveCustomer is an unconditional upsert, so this guard is mandatory.
      const rows = await customers.findByPhone(phone);
      // ONE generic message for BOTH refusals below. This is an unauthenticated
      // form: "an account already exists" is an existence oracle for any phone
      // and "linked to more than one service" is a multi-tenancy oracle (it
      // tells a caller the number is a customer of >1 partner). The distinction
      // lives only in a logWarn field — ids/reasons, never the phone — exactly
      // like the login / reset / verify ambiguity paths, which return a generic
      // null already.
      if (rows.some((c) => c.passwordHash)) {
        logWarn('portal.register_refused', 'account exists', { reason: 'exists' });
        throw new CustomerInputError(REGISTER_UNAVAILABLE);
      }
      // Fail closed on an ambiguous phone (a row under more than one tenant, none
      // with an account): the portal never picks a tenant on the customer's behalf.
      if (rows.length > 1) {
        logWarn('portal.register_refused', 'ambiguous tenant', { reason: 'ambiguous', tenants: rows.length });
        throw new CustomerInputError(REGISTER_UNAVAILABLE);
      }
      const existing = rows[0] ?? null;
```

(the `password`/pwned/hash/email block in between is unchanged) and

```ts
      let customer: Customer;
      if (existing) {
        // Attach to the existing record (whatever tenant it is under) without
        // clobbering its KYC/consent fields.
        customer = { ...existing, email: encryptedEmail, passwordHash, passwordUpdatedAt: nowIso, updatedAt: nowIso };
      } else {
        // Lazy-create a fresh Customer under the default tenant (mirrors customer-store defaults).
        const senderCountry = countryForPhone(phone) ?? DEFAULT_SENDER_COUNTRY;
        customer = {
          senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'not_started', senderCountry,
          partnerId: DEFAULT_PARTNER_ID, email: encryptedEmail, passwordHash, passwordUpdatedAt: nowIso,
          createdAt: nowIso, updatedAt: nowIso,
        };
      }
```

`verifyCustomerPassword` line 212 → `const customer = await loadAccountRow(phone);`; `setPassword` line 245 → `const customer = await loadAccountRow(phone);`; `markPhoneVerified` line 296 → `const customer = await loadAccountRow(phone);`.

Sessions (lines 311-350):

```ts
    async createSession(phone: string, partnerId: PartnerId): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const ts = now();
      const record: SessionRecord = { phone, partnerId, createdAtMs: ts, lastSeenMs: ts };
      await redis.set(sessionKey(sha256hex(token)), JSON.stringify(record), { ex: SESSION_IDLE_SECONDS });
      await redis.sadd(sessionIndexKey(phone), token);
      return token;
    },

    /**
     * Resolve a session token to its (phone, tenant), enforcing the AAL2 lifetimes
     * in code (Redis TTL is only a belt-and-suspenders backstop). On a live
     * session, refresh `lastSeenMs` (sliding idle window) and re-arm the TTL.
     * A record without a tenant (pre-fix-1) is treated as expired.
     */
    async getSessionIdentity(token: string): Promise<SessionIdentity | null> {
      const keyHash = sha256hex(token);
      const raw = await redis.get(sessionKey(keyHash));
      if (!raw) return null;
      let record: SessionRecord;
      try {
        record = JSON.parse(raw) as SessionRecord;
      } catch {
        return null;
      }
      if (!record.partnerId) return null;
      const ts = now();
      if (ts - record.createdAtMs > ABSOLUTE_MS) return null; // 12-h absolute
      if (ts - record.lastSeenMs > IDLE_MS) return null; //      30-min idle
      record.lastSeenMs = ts;
      await redis.set(sessionKey(keyHash), JSON.stringify(record), { ex: SESSION_IDLE_SECONDS });
      return { phone: record.phone, partnerId: record.partnerId };
    },

    /** Phone-only view of getSessionIdentity (kept for existing callers/tests). */
    async getSession(token: string): Promise<string | null> {
      return (await this.getSessionIdentity(token))?.phone ?? null;
    },

    /** The Customer a live session belongs to — the (tenant, phone) row, never a phone-only guess. */
    async resolveSession(token: string): Promise<Customer | null> {
      const identity = await this.getSessionIdentity(token);
      if (!identity) return null;
      return customers.getCustomer(identity.partnerId, identity.phone);
    },
```

`src/lib/customer-auth.ts` lines 12-21:

```ts
export async function getCurrentCustomer(): Promise<Customer | null> {
  const token = (await cookies()).get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) return null;
  // The session carries (tenant, phone) — fix 1: a phone alone is not an identity.
  return getCustomerAuthStore().resolveSession(token);
}
```

`src/app/account/actions.ts` line 213 → `const token = await auth.createSession(phone, customer.partnerId);`; line 255 → `const token = await authStore.createSession(phone, customer.partnerId);`; line 366 → `const fresh = await customers.getCustomer(customer.partnerId, customer.senderPhone);`.

`src/app/account/page.tsx` line 94 → `getCustomerSummary(customer.partnerId, phone)` — `SmartSummaryCard` must receive the customer (change its props to `{ customer }: { customer: Customer }` and derive `phone = customer.senderPhone`, `partnerId = customer.partnerId`; adjust its one render site); lines 118-120 → `getCustomerStore(store).getCustomer(customer.partnerId, phone)`, `store.listTransfersByPhone(customer.partnerId, phone, 5)`, `getDailyVolumeStore().getTodayCents(customer.partnerId, phone)`; lines 178-180 → `store.listTransfersByPhone(customer.partnerId, customer.senderPhone, 200)`, `getDailyVolumeStore().getTodayCents(customer.partnerId, customer.senderPhone)`, `store.listRecipients(customer.partnerId, customer.senderPhone, 6)`.

`src/app/account/history/page.tsx:40` → `listTransfersByPhone(customer.partnerId, customer.senderPhone, 50)`; `src/app/account/support/actions.ts:73` → `listTransfersByPhone(customer.partnerId, customer.senderPhone, 10)`; `src/app/account/support/new/page.tsx:61` → same shape; `src/app/account/verify/actions.ts:42` → `applyDelta(customer.partnerId, customer.senderPhone, { … }, { … })`.

The portal's three PER-TRANSFER ownership checks are still phone-only and must carry the session's tenant too (a portal session bound to tenant `default` could otherwise view, refund or recall an acme transfer for the same phone): `src/app/account/receipt/[transferId]/page.tsx:99` `if (!t || t.phone !== customer.senderPhone) notFound();` → `if (!t || t.phone !== customer.senderPhone || t.partnerId !== customer.partnerId) notFound();`; `src/app/account/receipt/recall-actions.ts:98` `if (!transfer || transfer.phone !== customer.senderPhone) back('ineligible');` → `… || transfer.partnerId !== customer.partnerId) back('ineligible');`; `src/app/account/receipt/refund-actions.ts:41` `if (!transfer || transfer.phone !== customer.senderPhone) refuse();` → `… || transfer.partnerId !== customer.partnerId) refuse();`. Same arms (404 / ineligible / refuse) — 404-never-403. `tests/recall-actions.test.ts` and `tests/refund-actions.test.ts` already seed matching `partnerId`s on customer and transfer (`'p1'` / `'default'`), so they stay green; add `|| t.partnerId !== customer.partnerId` to the Step 12.3 PR-body list next to the `/account/support` ticket exception, which remains the ONLY phone-only portal read.

9.4 Run: `npx vitest run tests/customer-auth-store.test.ts tests/account-actions.test.ts tests/account-settings-actions.test.ts tests/account-support-actions.test.ts tests/account-verify-action.test.ts tests/customer-auth.test.ts tests/recall-actions.test.ts` → green.

9.5 Commit:

```
fix(customer-portal): sessions carry the tenant; exactly one account-bearing row per phone; login/reset/verify fail closed on an ambiguous number

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 10 — Scoped store and the admin dashboard

10.1 Failing tests — `tests/scoped-store.test.ts`: in `seedTwoPartnersData` the transfers are created with `partnerId: 'default'` and then re-homed via `customerStore.getCustomer(t.phone)` (lines 62-84). Replace that with creating each transfer under its customer's tenant directly (`partnerId` in the `createTransfer` input) and delete the re-save loop. Extend the pinned test at line 134:

```ts
  it('partner staff getCustomer is PINNED at the query: null for another partner\'s customer, even when that phone also exists under their own tenant after a forged inbound', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getCustomer('15553333333')).toBeNull();   // beta's
    expect(await scoped.getCustomer('15551111111')).not.toBeNull(); // acme's
    // A partner-B-signed inbound created acme's OWN row for beta's phone: acme sees ITS row, never beta's.
    await env.customerStore.upsertOnFirstInbound('acme', '15553333333');
    const seen = await scoped.getCustomer('15553333333', { partnerId: 'beta' }); // hostile hint is ignored
    expect(seen?.partnerId).toBe('acme');
    expect(seen?.kycStatus).toBe('not_started');
    expect((await env.customerStore.getCustomer('beta', '15553333333'))!.kycStatus).toBe('verified'); // beta untouched
  });

  it('platform staff getCustomer: explicit partner hint wins; without it a multi-tenant phone resolves to the newest row and lists siblings', async () => {
    const env = await seedTwoPartnersData();
    await env.customerStore.upsertOnFirstInbound('acme', '15553333333');
    const scoped = createScopedStore(platformAdmin(), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect((await scoped.getCustomer('15553333333', { partnerId: 'beta' }))?.partnerId).toBe('beta');
    expect((await scoped.getCustomer('15553333333', { partnerId: 'acme' }))?.partnerId).toBe('acme');
    expect(await scoped.getCustomer('15553333333', { partnerId: 'ghost' })).toBeNull();
    const siblings = await scoped.customerTenants('15553333333');
    expect(siblings.sort()).toEqual(['acme', 'beta']);
  });
```

`tests/customers-actions-scope.test.ts`: forms posted to `markCustomerVerifiedAction`/`markCustomerRejectedAction` gain `partnerId` (the tenant of the seeded customer); add:

```ts
  it('a partner-admin is PINNED to their tenant: a hostile partnerId field cannot reach another tenant\'s row', async () => {
    await seedPartner(db, 'acme'); await seedPartner(db, 'beta');
    await cs.saveCustomer(makeCustomer('15559990000', 'beta'));
    currentStaff = staff({ partnerId: 'acme' });
    await expect(markCustomerVerifiedAction(form({ phone: '15559990000', partnerId: 'beta' }))).rejects.toThrow(/not found/i);
    expect((await cs.getCustomer('beta', '15559990000'))!.kycStatus).toBe('not_started');
  });
```

(`db` must be reachable in that test — the file's `beforeEach` builds `store`/`cs` from `freshDb()`; capture the db handle in a module-level `let db` there.)

10.2 Run and expect failure: `npx vitest run tests/scoped-store.test.ts tests/customers-actions-scope.test.ts` → `customerTenants is not a function`, `expected 'beta' to be 'acme'`.

10.3 Implement.

`src/lib/scoped-store.ts` lines 72-77 and 95-99 become (import `type { PartnerId, Staff } from './types'`):

```ts
    async listCustomers() {
      // Tenant-scoped at the WHERE (fix 1); platform staff see every tenant.
      return customerStore.listCustomers(scope.kind === 'partner' ? scope.partnerId : undefined);
    },
```

```ts
    /**
     * A customer by phone under ONE tenant. Partner staff are PINNED to their
     * own tenant at the query — the hint is ignored. Platform staff pass the
     * tenant explicitly (`?partner=` on the detail page); without a hint a phone
     * that exists under several tenants resolves to the most recently updated
     * row (callers list the siblings via customerTenants). canSee stays as
     * defence-in-depth on the row that comes back.
     */
    async getCustomer(phone: string, opts: { partnerId?: PartnerId } = {}) {
      let c: import('./types').Customer | null;
      if (scope.kind === 'partner') {
        c = await customerStore.getCustomer(scope.partnerId, phone);
      } else if (opts.partnerId) {
        c = await customerStore.getCustomer(opts.partnerId, phone);
      } else {
        const rows = await customerStore.findByPhone(phone);
        c = rows.length === 0 ? null : rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      }
      if (!c || !canSee(scope, c.partnerId)) return null;
      return c;
    },
    /** The tenants a phone exists under, filtered to what this viewer may see. */
    async customerTenants(phone: string): Promise<PartnerId[]> {
      const rows = await customerStore.findByPhone(phone);
      return rows.map((c) => c.partnerId).filter((id) => canSee(scope, id));
    },
```

`src/app/admin-dashboard/sender-cell.tsx:14-15`:

```ts
export function SenderCell({ name, phone, partnerId }: { name?: string; phone: string; partnerId?: string }) {
  const href = `/admin-dashboard/customers/${phone}${partnerId ? `?partner=${encodeURIComponent(partnerId)}` : ''}`;
```

and every `<SenderCell … />` render site passes `partnerId={t.partnerId}` (`grep -rn "<SenderCell" src/app/admin-dashboard`).

`src/app/admin-dashboard/customers/[phone]/page.tsx` — props gain `searchParams: Promise<{ partner?: string }>`; lines 38-49 become:

```ts
  const { phone } = await params;
  const { partner: partnerHint } = await searchParams;

  const scoped = createScopedStore(staff);
  const dailyVolumeStore = getDailyVolumeStore();
  const customer = await scoped.getCustomer(phone, { partnerId: partnerHint || undefined });
  if (!customer) notFound();
  const siblingTenants = (await scoped.customerTenants(phone)).filter((id) => id !== customer.partnerId);

  const [mine, todayUsedCents, partner, kycAudit] = await Promise.all([
    // Indexed WHERE partner_id = $1 AND phone = $2 (newest-first) — the F44 read sink is tenant-keyed.
    getStore().listTransfersByPhone(customer.partnerId, phone, 50),
    dailyVolumeStore.getTodayCents(customer.partnerId, phone),
    scoped.getPartner(customer.partnerId),
    getKycCaseStore(getStore())
      .getAudit(customer.partnerId, phone)
      .catch(() => [] as Awaited<ReturnType<ReturnType<typeof getKycCaseStore>['getAudit']>>),
  ]);
```

Each of the three forms (lines 109, 115, 128) gains `<input type="hidden" name="partnerId" value={customer.partnerId} />` under the existing phone input, and, when `siblingTenants.length > 0`, render under the page title: `<p className="sh-page-sub">This number also exists under: {siblingTenants.map((id) => <Link key={id} href={\`/admin-dashboard/customers/${phone}?partner=${encodeURIComponent(id)}\`}>{id}</Link>)}</p>` (import `Link` from `next/link`; keep `.sh-page-sub` — it is an e2e hook).

`src/app/admin-dashboard/customers/actions.ts` — add a helper above the actions:

```ts
/**
 * The tenant an admin action targets: partner staff are PINNED to their own
 * (the form field is ignored — an identity pin, never an input); platform
 * staff MUST name one. No silent default: a stale or hand-crafted form without
 * a partnerId must never act on the default tenant's row for a multi-tenant
 * phone (the detail page always posts the hidden field — Step 10.3).
 */
function targetPartnerId(staff: { partnerId?: string }, formData: FormData): PartnerId {
  if (staff.partnerId) return staff.partnerId;
  const requested = String(formData.get('partnerId') ?? '').trim();
  if (!requested) throw new Error('Partner is required.');
  return requested;
}
```

(`tests/customers-actions-scope.test.ts` gains one case: platform staff posting a form WITHOUT `partnerId` ⇒ `rejects.toThrow('Partner is required.')` and the default-tenant row is untouched.)

and lines 25-30 / 61-64 / 166-170 become `const partnerId = targetPartnerId(staff, formData); const cs = getCustomerStore(getStore()); const customer = await cs.getCustomer(partnerId, phone); if (!customer || !canSee(scopeOf(staff), customer.partnerId)) { throw new Error('Customer not found.'); }`; line 70 → `await getKycCaseStore(getStore()).review(partnerId, phone, decision, reviewer, reason);` (compute `partnerId` there too); in `createCustomerAction` move the "Partner scope" block (lines 113-124) ABOVE the collision check and make the check `if (await cs.getCustomer(partnerId, normalized))`; line 156 → `redirect(\`/admin-dashboard/customers/${normalized}?partner=${encodeURIComponent(partnerId)}\`);`.

`src/app/admin-dashboard/customers/page.tsx:137` → `href={\`/admin-dashboard/customers/${c.senderPhone}?partner=${encodeURIComponent(c.partnerId)}\`}`; `src/app/admin-dashboard/kyc/page.tsx:91` → same shape, and `:25` → `getKycCaseStore(getStore()).listNeedsReview(scoped.scope.kind === 'partner' ? scoped.scope.partnerId : undefined)` (keep the `canSee` filter — defence-in-depth). `src/app/admin-dashboard/partners/page.tsx:40` unchanged (`listCustomers()` platform-wide is what that page is; `requirePlatformAdmin` already gates it — check line 20-27).

`src/app/admin-dashboard/transactions/page.tsx` lines 57-78 become:

```ts
  const customerStore = getCustomerStore(getStore());
  // Badge maps for ONLY the senders on this page, keyed by (tenant, phone) — the
  // transfer's own tenant, so a row never borrows another tenant's KYC/tier/name.
  const senderKeys = [...new Map(transfers.map((t) => [senderNameKey(t.partnerId, t.phone), t])).values()];
  const customers = (
    await Promise.all(senderKeys.map((t) => customerStore.getCustomer(t.partnerId, t.phone)))
  ).filter((c): c is NonNullable<typeof c> => c !== null);
  const now = new Date();
  const tierByKey: Record<string, Tier> = {};
  const kycByKey: Record<string, KycInfo> = {};
  const senderNames: Record<string, string> = {};
  for (const c of customers) {
    const k = senderNameKey(c.partnerId, c.senderPhone);
    tierByKey[k] = deriveTier(c, now, sendGateActive(partnerById[c.partnerId]));
    kycByKey[k] = { kycStatus: c.kycStatus, kycReviewState: c.kycReviewState, watchlistHit: c.watchlistHit, pepHit: c.pepHit };
    if (c.fullName) senderNames[k] = c.fullName;
  }
```

and every downstream `tierByPhone[t.phone]` / `kycByPhone[t.phone]` / `senderNames[t.phone]` in the JSX → `[senderNameKey(t.partnerId, t.phone)]` (import `senderNameKey` from `@/lib/sender-names`).

10.4 Run: `npx vitest run tests/scoped-store.test.ts tests/customers-actions-scope.test.ts tests/review-kyc-action.test.ts tests/admin-actions-scope.test.ts` → green.

10.5 Commit:

```
fix(admin): partner staff pinned to their tenant at the customer query; detail page, links and actions carry ?partner=; transactions badges keyed by (tenant, phone)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 11 — `tests/tenant-boundary.test.ts`: one PGlite spec that reproduces every finding end to end (the regression pin)

11.1 Create `tests/tenant-boundary.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo'; // the D11 case below
import { EnvKeyProvider } from '@/lib/field-crypto';
import { resetRateCacheForTests } from '@/lib/rate';
import { createTransaction, getTransaction, type PartnerApiDeps } from '@/lib/partner-api-service';
import type { Db } from '@/db/client';
import type { Partner } from '@/lib/types';

// tenant-boundary — the end-to-end pin for fix 1 (F44, F45, F47, F50, F52).
// Two tenants ('default' and 'acme') share ONE phone number. Nothing a
// partner-signed webhook or the partner API does under acme may read or move
// anything the default tenant holds for that number, and vice versa.

const PHONE = '15551230000';
const NOW = '2026-06-08T00:00:00Z';

// The inbound pipeline reads its singletons; bind them to the test engine.
let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendText: vi.fn(async () => {}),
}));

import { processInboundWebhook } from '@/lib/whatsapp-inbound';

function metaBody(from: string, text: string, id: string): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from, id, type: 'text', text: { body: text } }] } }] }],
  };
}

const partner = (over: Partial<Partner>): Partner => ({
  id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW, ...over,
});
const ACME = partner({ id: 'acme', kycMode: 'delegated', requireKycBeforeSend: false });

beforeEach(async () => {
  resetRateCacheForTests();
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'acme');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '' }));
});
afterEach(() => vi.restoreAllMocks());

async function seedDefaultOwner() {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: NOW, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
    fullName: 'Default Owner', govIdNumber: 'P1234567', passwordHash: 'pw-hash', optInAt: NOW,
    createdAt: NOW, updatedAt: NOW,
  });
  await store.upsertRecipient('default', PHONE, {
    name: 'Anita', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: 'REAL-0001', lastUsedAt: NOW,
  });
  await store.incrementTodayTransferCount('default', PHONE);
  return { store, customerStore };
}

describe('F44: a forged partner-signed webhook cannot re-home another tenant customer', () => {
  it('creates acme\'s own row, leaves default\'s partner_id/kyc/PII/password intact, and enqueues the turn under acme', async () => {
    const { customerStore } = await seedDefaultOwner();
    const res = await processInboundWebhook(metaBody(PHONE, 'hi', 'wamid.FORGED1'), { routedPartnerId: 'acme' });
    expect(res).toEqual({ ok: true });
    const dflt = (await customerStore.getCustomer('default', PHONE))!;
    expect([dflt.partnerId, dflt.kycStatus, dflt.fullName, dflt.govIdNumber, dflt.passwordHash]).toEqual(
      ['default', 'verified', 'Default Owner', 'P1234567', 'pw-hash'],
    );
    const acme = (await customerStore.getCustomer('acme', PHONE))!;
    expect([acme.partnerId, acme.kycStatus, acme.fullName, acme.passwordHash]).toEqual(['acme', 'not_started', undefined, undefined]);
    // The durable effect: exactly one agent.turn row, carrying the ROUTED tenant (never creds).
    const raw = await db.execute(`SELECT payload FROM outbox WHERE kind = 'agent.turn'`);
    const payloads = (raw as unknown as { rows: { payload: { routedPartnerId: string | null; phone: string } }[] }).rows;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload).toMatchObject({ phone: PHONE, routedPartnerId: 'acme' });
  });

  it('STOP under acme never opts the default-tenant row out', async () => {
    const { customerStore } = await seedDefaultOwner();
    await processInboundWebhook(metaBody(PHONE, 'STOP', 'wamid.STOP1'), { routedPartnerId: 'acme' });
    expect((await customerStore.getCustomer('default', PHONE))!.optedOutAt).toBeUndefined();
  });
});

describe('F45/F47: the partner API cannot plant a payout destination in another tenant address book or bump its counters', () => {
  async function apiDeps() {
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    const deps: PartnerApiDeps = {
      store, partnerStore: createPartnerStore(db), monthlyVolumeStore: createMonthlyVolumeStore(redis),
      integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
      customerStore, db, now: () => NOW,
    };
    return { deps, store, customerStore };
  }

  it('acme mint for default\'s number: default recipients/velocity/monthly untouched; acme gets its own', async () => {
    await seedDefaultOwner();
    const { deps, store } = await apiDeps();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-tb-1', {
      amount_source: 200,
      sender: { phone: PHONE, kyc_status: 'not_started' },
      beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: 'PLANTED-9999' },
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect((await store.listRecipients('default', PHONE, 5))[0].payoutDestination).toBe('REAL-0001');
    expect((await store.listRecipients('acme', PHONE, 5))[0].payoutDestination).toBe('PLANTED-9999');
    expect(await store.getTodayTransferCount('default', PHONE)).toBe(1); // the seeded one, unchanged
    expect(await store.getTodayTransferCount('acme', PHONE)).toBe(1);
    expect(await deps.monthlyVolumeStore.getMonthCents('default', PHONE)).toBe(0);
    expect(await deps.monthlyVolumeStore.getMonthCents('acme', PHONE)).toBe(20_000);
  });

  it('F50/F52: the partner API never returns another tenant decrypted legal name', async () => {
    await seedDefaultOwner();
    const { deps } = await apiDeps();
    const r = await createTransaction(deps, ACME, 'pk_1', 'idem-tb-2', {
      amount_source: 100, sender: { phone: PHONE, kyc_status: 'not_started' },
      beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
    });
    if (!r.ok) throw new Error('unexpected');
    expect((r.data as { sender_name: string | null }).sender_name).toBeNull();
    const got = await getTransaction(deps, 'acme', (r.data as { id: string }).id);
    expect(got.ok && (got.data as { sender_name: string | null }).sender_name).toBeNull();
    expect(JSON.stringify(r.data)).not.toContain('Default Owner');
  });
});

describe('D9/D10 transitional fallback: legacy phone-only keys belong to the PRE-FIX tenant only', () => {
  it('an acme sibling created after the rename never reads default\'s legacy velocity/daily/monthly/kyc_audit', async () => {
    const { store, customerStore } = await seedDefaultOwner(); // default is the oldest row
    const day = easternDate(Date.now());
    const month = easternMonth(Date.now());
    await redis.set(`velocity:${PHONE}:${day}`, '4');
    await redis.set(`daily_volume:${PHONE}:${day}`, '250000');
    await redis.set(`monthly_volume:${PHONE}:${month}`, '290000');
    await redis.hset(`kyc_audit:${PHONE}`, { '1': JSON.stringify({ at: NOW, actor: 'persona', action: 'legacy.event' }) });
    await customerStore.upsertOnFirstInbound('acme', PHONE); // the post-fix sibling
    const daily = createDailyVolumeStore(redis, store.legacyTenantOf);
    const monthly = createMonthlyVolumeStore(redis, store.legacyTenantOf);
    const kyc = createKycCaseStore(redis, customerStore); // (redis, customers, now?) — src/lib/kyc-case-store.ts:31-35
    // The pre-fix owner still sees its in-flight window…
    expect(await store.getTodayTransferCount('default', PHONE)).toBe(4);
    expect(await daily.getTodayCents('default', PHONE)).toBe(250_000);
    expect(await monthly.getMonthCents('default', PHONE)).toBe(290_000);
    expect((await kyc.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['legacy.event']);
    // …and the sibling sees NOTHING of it (no cap oracle, no audit leak).
    expect(await store.getTodayTransferCount('acme', PHONE)).toBe(0);
    expect(await daily.getTodayCents('acme', PHONE)).toBe(0);
    expect(await monthly.getMonthCents('acme', PHONE)).toBe(0);
    expect(await kyc.getAudit('acme', PHONE)).toEqual([]);
    expect(await store.getConversation('acme', PHONE)).toEqual([]);
  });

  // The D9 rule ("oldest customers row = pre-fix owner") is only true because
  // customer-repo.freshCustomer never backdates createdAt. Pre-fix, the partner
  // API minted transfers WITHOUT a customers row, so an acme sibling created
  // after deploy for a phone with old acme ledger history is GRANDFATHERED
  // (firstSeenAt = its first transfer) — but must still sort AFTER the real
  // pre-fix owner, whether that owner registered later on the portal (T2 > T1)
  // or was itself grandfathered at the phone-wide minimum (a tie at T1, where
  // findByPhone's asc(partnerId) tie-break would otherwise put 'acme' first).
  it.each([
    ['the default row was portal-registered at T2 > T1', '2026-04-01T00:00:00.000Z'],
    ['the default row was grandfathered at T1 (a tie with acme\'s first transfer)', '2026-03-01T00:00:00.000Z'],
  ])('createdAt is never backdated: acme\'s post-fix sibling never becomes the legacy tenant when %s', async (_label, defaultCreatedAt) => {
    const T1 = '2026-03-01T00:00:00.000Z';
    const store = createStore(redis, db);
    const customerStore = createCustomerStore(db, store);
    // acme's API minted for PHONE at T1 — no customers row existed for it pre-fix.
    await store.saveTransfer({
      id: 'tb_legacy1', phone: PHONE, amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85, amountInr: 8500,
      recipientName: 'Anita', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'anita@upi',
      fundingMethod: 'bank_transfer', status: 'delivered', complianceStatus: 'cleared', complianceReasons: [],
      createdAt: T1, partnerId: 'acme', sourceCountry: 'US', sourceCurrency: 'USD',
      destinationCountry: 'IN', destinationCurrency: 'INR', amountSource: 100, feeSource: 0, totalChargeSource: 100,
    } as Transfer);
    // The real pre-fix owner: default's row (created pre-fix at defaultCreatedAt, later than or equal to T1).
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: defaultCreatedAt, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
      passwordHash: 'pw-hash', createdAt: defaultCreatedAt, updatedAt: defaultCreatedAt,
    });
    await redis.hset(`kyc_audit:${PHONE}`, { '1': JSON.stringify({ at: NOW, actor: 'persona', action: 'legacy.event' }) });

    // Both post-fix creation paths for the sibling: the partner API (Step 8) and the inbound webhook (Step 5).
    const viaApi = await customerStore.ensureCustomer('acme', PHONE);
    await customerStore.upsertOnFirstInbound('acme', PHONE);
    expect(viaApi.kycStatus).toBe('grandfathered'); // acme's OWN ledger history grandfathers it…
    expect(viaApi.firstSeenAt).toBe(T1);
    expect(viaApi.createdAt > defaultCreatedAt).toBe(true); // …but createdAt is "now", never T1

    expect(await store.legacyTenantOf(PHONE)).toBe('default');
    const kyc = createKycCaseStore(redis, customerStore);
    expect(await kyc.getAudit('acme', PHONE)).toEqual([]); // the no-TTL legacy trail never reaches the sibling
    expect((await kyc.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['legacy.event']);
  });
});

describe('D11: routing is identity — the routing inputs are locked', () => {
  it('the platform phone_number_id and another partner\'s phone_number_id are both refused at write time, and the index refuses a raw duplicate', async () => {
    const integ = createIntegrationsRepo(db);
    await integ.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } });
    await expect(db.execute(sql`INSERT INTO partner_integrations (partner_id, wa_phone_number_id) VALUES ('default', 'pn_acme')`)).rejects.toThrow(/partner_integrations_wa_pnid|unique/i);
    // The write-time refusals are pinned in tests/partners-actions.test.ts (Step 5A); the webhook secret rule in tests/whatsapp-route.test.ts.
  });
});

describe('D12: the bot\'s own state is per tenant', () => {
  it('a customer of default who messages acme\'s number starts a FRESH conversation there and acme\'s replies never see default\'s thread', async () => {
    const { store } = await seedDefaultOwner();
    await store.saveConversation('default', PHONE, [{ role: 'user', content: 'send $900 to Zubeida' }]);
    await processInboundWebhook(metaBody(PHONE, 'hi', 'wamid.CONV1'), { routedPartnerId: 'acme' });
    const raw = await db.execute(`SELECT payload FROM outbox WHERE kind = 'agent.turn'`);
    const [{ payload }] = (raw as unknown as { rows: { payload: { routedPartnerId: string; turn: { isNewConversation: boolean } } }[] }).rows;
    expect(payload.routedPartnerId).toBe('acme');
    expect(payload.turn.isNewConversation).toBe(true); // lastmsg is per tenant too
    expect(await store.getConversation('acme', PHONE)).toEqual([]);
  });
});
```

(Add `import { easternDate, easternMonth } from '@/lib/dates';`, `import { createDailyVolumeStore } from '@/lib/daily-volume-store';`, `import { createKycCaseStore } from '@/lib/kyc-case-store';` and `import { sql } from 'drizzle-orm';` to the file's imports, and widen the type import to `import type { Partner, Transfer } from '@/lib/types';` for the createdAt-invariant pin.)

`createOutboxRepo` is imported only to type-check the enqueue path; drop the import if eslint flags it unused. `getCustomerStore` (used inside `processInboundWebhook`) caches a store over `getDb()`; `freshDb()` returns the same PGlite instance per worker (`tests/helpers-db.ts:21-28`), so the cached store stays bound to the live engine.

11.2 Run: `npx vitest run tests/tenant-boundary.test.ts` → green on the post-fix tree. Prove it is a real pin: `git stash -- src/db/repos/customer-repo.ts` is not possible now (the composite PK exists), so instead temporarily re-add the deleted rewrite in `upsertOnFirstInbound` (`if (existing && existing.partnerId !== partnerId)` cannot even be expressed against the tenant key — the F44 sink is gone structurally); confirm instead by reverting `src/lib/transfer-create.ts` accrual lines to `input.phone`-only for one run: `git stash push src/lib/transfer-create.ts && npx vitest run tests/tenant-boundary.test.ts; git stash pop` → expect a compile-time/arity failure or `expected 'PLANTED-9999' to be 'REAL-0001'`.

11.3 Commit:

```
test(tenant-boundary): end-to-end regression pin for F44/F45/F47/F50/F52 on PGlite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 12 — Proof, security review, PR, migrate prod

12.1 Full verification (the Stop hook `.claude/hooks/verify-on-stop.sh` runs the same three legs; run them explicitly and quote the tails in the PR):

```bash
cd ~/dev/wt/partner-api
npx tsc --noEmit                                  # expect: no output, exit 0 — every phone-only CustomerStore/store/volume/resolveSenderNames call is a compile error now
npx eslint . --max-warnings 0                     # expect: exit 0 (drop any now-unused DEFAULT_PARTNER_ID / getCustomerStore imports it flags)
npx vitest run                                    # expect: "Test Files  N passed", "Tests  M passed", 0 failed
grep -rnE "\.(getCustomer|upsertOnFirstInbound|setOptedIn|setOptedOut|clearOptedOut|recordFundingMethod|recordKycInquiry)\(([a-zA-Z_.]+)\)" src | grep -v "findByPhone\|ensureCustomer\|resolveSession\|auth\.getCustomer(\|scoped\.getCustomer(\|customer-auth"   # expect: nothing — a one-argument CustomerStore read no longer exists in src. The exclusions are the two DELIBERATELY phone-only readers that are not CustomerStore: customer-auth-store's account-row `auth.getCustomer(phone)` (src/app/account/actions.ts:292, = loadAccountRow, D6) and scoped-store's pinned `scoped.getCustomer(phone)` (customers/[phone]/page.tsx:42, copilot/kyc-review/route.ts:64 — Step 10 pins the tenant inside it).
grep -nE "\.phone (!==|===) ctx\.phone" src/lib/tools.ts | grep -vE "partnerId (!==|===) ctx\.partnerId" # expect: exactly ONE line, the active-draft check (`active.phone === ctx.phone`, :2357 on main, already tenant-scoped by getActiveDraftId) — every per-transfer / per-schedule ownership check carries the tenant (Step 6.3)
grep -rnE "(getConversation|saveConversation|getLastInboundAt|recordInboundNow|getActiveDraftId)\(" src | grep -vE "partnerId|tenantId|customer\.partnerId|\(partnerId, "   # expect: nothing — every bot-state key is tenant-keyed (D12)
grep -rn "passwordHash" src --include='*.ts' --include='*.tsx' | grep -v "^src/lib/customer-auth-store.ts\|^src/lib/types.ts\|^src/db/repos/customer-repo.ts\|^src/db/schema.ts\|\.passwordHash)\|passwordHash ?\|!c\.passwordHash\|Boolean(c\.passwordHash)"   # expect: nothing — the ONLY writers of password_hash are customer-auth-store's register/setPassword (which go through loadAccountRow). D6's fail-closed ambiguity rule is a customer LOCK-OUT vector if any other path (an admin import, a seed script, a repo helper) ever writes a hash onto a second tenant's row; the PR states that admin imports must never set it.
```

12.2 `/security-review` on the branch (auth, money, webhooks, crypto and compliance are all touched). Points the reviewer must confirm: no decryption surface widened (`openOptional` is still the only path; `resolveSenderNames` narrowed); the `ensureCustomer` call sits before `idem.claim`; `findByPhone` has exactly the three callers named in D1 plus the mock KYC provider; partner staff pinning in `scoped-store.getCustomer` and `customers/actions.ts targetPartnerId` ignores form/query input; the Persona binding never chooses between two matching rows.

12.3 Open the PR (`gh pr create --base main`), body must state: the D2 product decision ("the partner owns its own copy of the customer" — sibling rows, never re-home) and D3 (no refusal oracle); migration `0015_tenant_scoped_customers` re-PKs `customers` and backfills `recipients.partner_id` — apply in a low-traffic window; the Redis key rename with one-window legacy dual-read for `velocity:*`, `daily_volume:*`, `monthly_volume:*`, `kyc_audit:*` (fix 10 removes the fallback; the key shape is final — fix 10 must not rename again); pre-deploy portal sessions are invalidated (records lack `partnerId`); `resolveSenderNames` is now tenant-keyed (`SenderKey[]`, options object — no positional insertion); fix 6 owns whether API mints keep calling `upsertRecipient`; the D9 resolver cost (`createStore` builds a full PII-decrypting `createCustomerRepo` just to read `partnerId`, and every legacy-key MISS on velocity/daily/monthly/conv costs one `findByPhone` round trip for one TTL window — accepted for the wave-1→wave-3 window; a lean `partnerIdsByPhone(phone)` select is the follow-up if it shows in Neon latency); the recipients backfill data move from Step 2.2 (with query (d)'s output); and the `/account/support` exception: ticket listing/reads (`ticket-repo.listByCustomer`, `support/[ticketId]/page.tsx`, `support/actions.ts:109`) still key on `customerPhone` only, so tickets a customer opened under another tenant appear in the one portal account — same phone owner, not a cross-person leak, but it breaks the "portal is bound to one tenant" contract; either add `eq(tickets.partnerId, customer.partnerId)` + the matching check in this PR or record it as a known exception. Attach the tails of 12.1. End the description with the attribution block:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

12.4 After `ci / ci` is green and the PR is squash-merged (fix 7 must already be on main and its 0014 applied — `npx tsx scripts/migration-status.ts` shows exactly one pending file, 0015): watch the Vercel production deploy and run the migration **the moment Vercel marks it Ready — not at merge time**. Unlike 0014 (additive), 0015 breaks BOTH builds in whichever order it is applied: the OLD code's `onConflictDoUpdate({ target: customers.phone })` matches no unique constraint once the PK is `(partner_id, phone)` and its `recipients` insert omits the NOT NULL `partner_id`, so every inbound customer upsert 500s until the new build is live; the NEW code fails every `customers`/`recipients` query until 0015 is applied. The window is unavoidable; running migrate at Ready makes it seconds instead of a multi-minute build. Expect Meta webhook retries for events in that window (Meta retries non-2xx; dedupe on `wamid:` makes the retries harmless).

```bash
cd ~/dev/wt/partner-api && git checkout main && git pull
# WAIT for the production deployment of the merge SHA to be Ready (Vercel dashboard / `vercel ls`), then within seconds:
set -a; source .env.local; set +a; npx drizzle-kit migrate      # applies 0015 to prod Neon (DDL over DATABASE_URL_UNPOOLED per drizzle.config.ts)
```

then `/post-merge-check` and confirm the post-deploy `smoke.yml` run for the merge SHA is green. Drizzle selects explicit column lists, so until 0015 is applied every `customers` and `recipients` query on prod fails — do not leave the merge unapplied. Then `/sync-branches`.

---

### Task 3: Enforce the compliance hold on every settlement path, including partner-API confirm and the pay page

**Findings:** F51 (partner-API `confirmTransaction` settles a FLAGGED transfer straight through), F53 (the pay route never checks `transfer.status` before `captureFunding`, so a sender with a valid OTP can re-charge / resurrect a staff-cancelled or admin-rejected transfer). Same class, unlisted in the audit: the B2B pay route refuses only `blocked` (`src/lib/b2b-pay-finalize.ts:245-247`), and the reconcile funding-resume sweep (`src/lib/reconcile.ts:105-117`) re-settles every charged `awaiting_payment` row regardless of compliance.

**Component:** money-paths. **Model:** Fable 5.1 (money path + compliance). **Migration:** none (see "Why no migration" at the end). **Wave:** 1, merged after fix 7 and fix 1; every later fix that touches `settlement.ts`, the pay route, `partner-api-service.ts` or `reconcile.ts` rebases onto this.

**Branch:** `git worktree add ~/dev/wt/money-paths origin/component/money-paths && cd ~/dev/wt/money-paths && git checkout -b fix/money-paths/compliance-hold-on-every-settlement-path`, then `git merge --no-edit origin/main` — fix 7 AND fix 1 must both be on `main` with 0014 and 0015 applied to prod (wave table + ruling 6): `ls drizzle | tail -2` must show `0014_outbox_lease.sql 0015_tenant_scoped_customers.sql` before any code. 7 widens `SweepResult` in `src/lib/reconcile.ts:28-36` (this task deliberately adds NO field to it, so that rebase is a no-op); 1 changes the `partner-api-service` harness (`customerStore` in deps, `customerStore.ensureCustomer` before the claim) and the tenant-keyed store signatures that this task's `tests/partner-api-service.test.ts` / pay-route tests assume — the tests below are written against the post-1 tree.

**Design in one paragraph (read before step 1).** The gate moves INTO the ledger claim: `markPaidIfAwaiting` (`src/db/repos/transfer-repo.ts:283-290`) gains `AND compliance_status = 'cleared'` in its `WHERE`, so `beginSettlement` (`src/lib/settlement.ts:34-72`) can never mint a `settlement.instruct` / `mock.settle` row for a non-cleared transfer no matter which of its four callers passes a stale in-memory `Transfer`. `beginSettlement` re-reads the row inside the same transaction when the claim returns null and reports a new `{ kind: 'refused', complianceStatus }` arm. A new `beginHold()` commits the atomic `awaiting_payment -> in_review` claim (`markInReviewIfAwaiting`, `paid_at = COALESCE(paid_at, now())`) plus the held stage-1 message as an outbox row (dedupe `stage1:<id>`) in ONE transaction. A new `settleOrHold()` is the single decision function the pay route, the B2B route, the sweep and the partner-API default `initiatePayment` call; its result union has NO arm a caller can mistake for success (`started | held | already | refused(blocked)`), and TypeScript's exhaustive `switch` forces every caller to handle each. In `confirmTransaction` the hold decision sits BEFORE the injectable `deps.initiatePayment` seam (`src/lib/partner-api-service.ts:54`), because the test harness injects a fake that flips straight to `paid` (`tests/partner-api-service.test.ts:41-44`). The pay route additionally refuses any non-`awaiting_payment` transfer BEFORE `captureFunding` and before any `saveTransfer` of bank details / ACH token, returning current truth (`200 { ok: true, status }`, the same shape the B2B route already uses at `src/app/api/pay/b2b/[invoiceId]/route.ts:231-233`). **Release is a settlement, not a status flip.** Today `dashboard-ops.releaseTransfer` (`src/lib/dashboard-ops.ts:104-113`) → `payment.completePaymentStage2` (`:151-197`) just `saveTransfer({ status: 'delivered' })` and never enqueues `settlement.instruct` — a latent defect (the rail is never told to pay out, or to debit a B2B buyer). Once the ledger claim carries the `cleared` predicate that defect would become structurally permanent: a released transfer keeps `compliance_status = 'flagged'` and could never pass `markPaidIfAwaiting`. So this task adds `releaseHold(db, transfer, railIntegrations)` in `settlement.ts`: in ONE transaction it claims `in_review -> paid` through a new `markPaidIfInReview` (NO compliance predicate — the staff release IS the compliance decision, and it is audited) and enqueues the SAME rail effect `beginSettlement` does (`instruct:<id>` for a webhook-driven rail, the delayed `mocksettle:<id>` + write-once `mock-<id>` providerRef for the mock rail). `releaseTransfer` calls it; the delivered message then arrives exactly as it does for a cleared transfer (rail callback → `delivered`, or the `mock.settle` handler). Step 5's B2B `settleOrHold` 'held' arm and the reconcile `fundhold:` arm are only correct because release can actually instruct.

**Money-path invariants from CLAUDE.md that apply, and where:**
- *Money paths are transactional* → step 2 (`beginHold` = one `db.transaction` with the claim + the outbox row; no `completePaymentStage1` + re-read + `saveTransfer` read-modify-write).
- *Every external effect is an outbox row written transactionally with the state change* → step 2 (the held message leaves the route's direct `sendText` at `route.ts:140` and becomes `whatsapp.text` dedupe `stage1:<id>` inside the hold transaction).
- *Sanctions screening always runs / KYC may be delegated, sanctions may not* → step 4 (a `delegated` partner key holds exactly like an `ours` key; the check is on `complianceStatus`, never on `kycMode`).
- *Tenant isolation is app-level, 404-never-403* → step 4 (the ownership check at `partner-api-service.ts:371-372` stays first; the hold path never reads or mutates before it).
- *Encryption at rest / masked reads* → steps 2, 3 (`markInReviewIfAwaiting` RETURNING goes through `toDomain(row)` = masked; `buildStage1Message` (`src/lib/payment.ts:78-95`) never names the destination; the outbox payload is `{ to, body, creds }` only).
- *Idempotency* → steps 2, 3, 4 (dedupe keys `stage1:`, `instruct:`, `mocksettle:` unchanged; a replayed POST/confirm returns current truth and enqueues nothing).
- *Capture-before-effect ordering* (funding-provider contract, `route.ts:35-45`) → step 3 (the status guard is a REFUSAL gate and therefore sits above `captureFunding`; the hold is an EFFECT and therefore sits below it).

**Files:**
- Modify: `src/db/repos/transfer-repo.ts` (`markPaidIfAwaiting` gains the cleared predicate; new `markInReviewIfAwaiting`, `markPaidIfInReview`, `findCancelledCharged`)
- Modify: `src/lib/settlement.ts` (refusal arm on `SettlementResult`; new `beginHold`, `HoldResult`, `settleOrHold`, `SettleOrHoldResult`, `releaseHold`, `ReleaseResult`; the rail-effect enqueue extracted into one private `enqueueRailEffect`)
- Modify: `src/lib/dashboard-ops.ts` (`releaseTransfer(store, db, id)` → `releaseHold`; `completePaymentStage2` import dropped)
- Modify: `src/app/admin-dashboard/actions.ts` (`releaseTransferAction` passes `getDb()` and pokes the worker, mirroring `rejectTransferAction`; ADDS `import { pokeWorker } from '@/lib/outbox';` — on `4fc4e6a` the file imports only `getDb` at :22, NOT `pokeWorker`)
- Modify: `src/app/api/pay/[transferId]/route.ts` (pre-capture status guard; flagged branch replaced by `settleOrHold`; `completePaymentStage1` and `sendText` imports dropped)
- Modify: `src/lib/partner-api-service.ts` (`confirmTransaction` holds outside the seam; default `initiatePayment` uses `settleOrHold`)
- Modify: `src/app/api/pay/b2b/[invoiceId]/route.ts` (`settleOrHold` with exhaustive result handling)
- Modify: `src/lib/reconcile.ts` (funding-resume branch: `settleOrHold`, held/blocked alerts with their own dedupe keys)
- Modify: `src/lib/payment.ts` (doc comment on `buildStage1Message` only — no code change)
- Modify: `src/app/docs/page.tsx` (`/confirm` endpoint description), `docs/SYSTEM-ARCHITECTURE.md` (§5 compliance outcomes, crash-resume sweep, reconciliation sweep)
- Test: `tests/settlement.test.ts` (new describes: repo hold claim, refusal arm, `beginHold`, `settleOrHold`)
- Test: `tests/partner-api-service.test.ts` (F51 repro + regression)
- Test: `tests/pay-route-funding.test.ts` (wrapper now observes `settleOrHold`; F53 repros; flagged branch rewritten)
- Test: `tests/pay-route-in-review.test.ts` (first test replaced by the atomic-hold test)
- Test: `tests/pay-route-ach-pull.test.ts` (wrapper now observes `settleOrHold`; flagged ach_pull hold test)
- Test: `tests/pay-route-delayed-poke.test.ts` (the paid-replay test no longer expects a poke: the status guard returns before `pokeWorker()`)
- Test: `tests/reconcile.test.ts` (flagged victim is held; cleared victim regression; charged-but-cancelled alert)
- Test: `tests/dashboard-ops.test.ts` (the existing `'delivers an in_review transfer (sets status delivered, deliveredAt)'` test at :171-177 is REWRITTEN — release now ends `paid` + a `mocksettle:` row, not `delivered`; the other three `releaseTransfer(store, …)` calls at :182, :188, :194 gain the `db` argument; + release/reject on a `beginHold`-held transfer)
- Test: `tests/review-actions.test.ts` (`releaseTransferAction` now reaches the DB through `getDb()` — the file must mock `@/db/client` onto the test PGlite, and its first assertion becomes `'paid'`)

---

#### Step 1 — Ledger claims: `markPaidIfAwaiting` gated on `cleared`, new `markInReviewIfAwaiting`

Read first: `src/db/repos/transfer-repo.ts:277-290` (`markPaidIfAwaiting` — the pattern), `:331-344` (`findInReviewOlderThan` selects on `paidAt` — why the hold MUST set `paid_at`), `:136-171` (`updateTransferFromWebhook` already treats `in_review` as terminal for callbacks, so a held row can never be flipped by a rail callback), `src/db/schema.ts:120` (`transfers_status_check` already allows `'in_review'`).

1. Write the failing tests. Append to `tests/settlement.test.ts` (after the existing `describe('beginSettlement — mock rail …')` block, before EOF). Add the import `import { createTransferRepo } from '@/db/repos/transfer-repo';` next to the existing `createOutboxRepo` import on line 5.

```ts
describe('transfer-repo — hold claim + ledger-gated paid claim (Phase 1 Task 3)', () => {
  it('markInReviewIfAwaiting: ONE guarded UPDATE flips awaiting_payment → in_review and sets paidAt', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const held = await createTransferRepo(db).markInReviewIfAwaiting('st_t1');
    // The RETURNING row IS the post-claim state: in_review with paidAt, in one statement —
    // there is no intermediate 'paid' state for anyone to observe.
    expect(held?.status).toBe('in_review');
    expect(held?.paidAt).toBeTruthy();
    expect((await store.getTransfer('st_t1'))?.status).toBe('in_review');
  });

  it('markInReviewIfAwaiting is a no-op (null) once the row is not awaiting_payment — never resurrects', async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await repo.markInReviewIfAwaiting('st_t1')).not.toBeNull();
    expect(await repo.markInReviewIfAwaiting('st_t1')).toBeNull(); // already held
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled' });
    expect(await repo.markInReviewIfAwaiting('st_c1')).toBeNull();
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
    await store.saveTransfer({ ...fixture(), id: 'st_p1', status: 'paid' });
    expect(await repo.markInReviewIfAwaiting('st_p1')).toBeNull();
    expect((await store.getTransfer('st_p1'))?.status).toBe('paid');
  });

  it('markPaidIfAwaiting REFUSES (null, row untouched) unless compliance_status is cleared — the ledger decides', async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await repo.markPaidIfAwaiting('st_t1')).toBeNull();
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    await store.saveTransfer({ ...fixture(), id: 'st_b1', complianceStatus: 'blocked' });
    expect(await repo.markPaidIfAwaiting('st_b1')).toBeNull();
    expect((await store.getTransfer('st_b1'))?.status).toBe('awaiting_payment');
    // Regression: a cleared row still flips.
    await store.saveTransfer({ ...fixture(), id: 'st_ok' });
    expect((await repo.markPaidIfAwaiting('st_ok'))?.status).toBe('paid');
  });

  it('a BLOCKED row is never held and never released: markInReviewIfAwaiting and markPaidIfInReview both refuse it (sanctions-blocked money is structurally unreleasable, even if a future writer puts a blocked row in in_review)', async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), id: 'st_bh', complianceStatus: 'blocked' });
    expect(await repo.markInReviewIfAwaiting('st_bh')).toBeNull();
    expect((await store.getTransfer('st_bh'))?.status).toBe('awaiting_payment');
    await store.saveTransfer({ ...fixture(), id: 'st_br', status: 'in_review', complianceStatus: 'blocked' });
    expect(await repo.markPaidIfInReview('st_br')).toBeNull();
    expect((await store.getTransfer('st_br'))?.status).toBe('in_review');
  });

  it("markPaidIfInReview: ONE guarded UPDATE flips in_review → paid with NO 'cleared' predicate (the staff release IS the decision — a released row stays flagged) but NEVER for a blocked row; a no-op from any other status", async () => {
    const repo = createTransferRepo(db);
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await repo.markPaidIfInReview('st_t1')).toBeNull(); // awaiting_payment is NOT releasable
    expect((await repo.markInReviewIfAwaiting('st_t1'))?.status).toBe('in_review');
    const paidAtHeld = (await store.getTransfer('st_t1'))?.paidAt;
    const released = await repo.markPaidIfInReview('st_t1');
    expect(released?.status).toBe('paid');
    expect(released?.complianceStatus).toBe('flagged'); // never rewritten
    expect(released?.paidAt).toBe(paidAtHeld);          // COALESCE — the charge time is kept
    expect(await repo.markPaidIfInReview('st_t1')).toBeNull(); // idempotent
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled' });
    expect(await repo.markPaidIfInReview('st_c1')).toBeNull();
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
  });
});
```

2. Run: `npx vitest run tests/settlement.test.ts`
   Expected: 5 failures — `TypeError: createTransferRepo(...).markInReviewIfAwaiting is not a function` (three times), `AssertionError: expected { …status: 'paid'… } to be null` (today `markPaidIfAwaiting` flips a flagged row), and `markPaidIfInReview is not a function`.

3. Implement. In `src/db/repos/transfer-repo.ts` replace lines 277-290 (`markPaidIfAwaiting` and its doc comment) with:

```ts
    /**
     * Atomically claim the awaiting_payment → paid transition (Stage 2c). Used
     * inside the settlement transaction so the status flip + outbox rows commit
     * together. COMPLIANCE GATE (Phase 1 Task 3): only a 'cleared' row can ever
     * flip to paid — the predicate lives IN the UPDATE so the ledger, not the
     * caller's possibly-stale Transfer object, decides. Null ⇒ either already
     * past awaiting_payment (double submit / replay) OR not cleared; the caller
     * re-reads inside the same transaction to tell the two apart.
     */
    async markPaidIfAwaiting(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'paid', paidAt: sql`COALESCE(${transfers.paidAt}, now())` })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'awaiting_payment'),
          eq(transfers.complianceStatus, 'cleared'),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * Atomically claim the awaiting_payment → in_review transition — the
     * COMPLIANCE HOLD. Mirrors markPaidIfAwaiting: one guarded UPDATE inside
     * the hold transaction (settlement.beginHold), so the status flip and the
     * held stage-1 outbox row commit together. paid_at marks WHEN THE HOLD
     * BEGAN (COALESCE): for a card/bank_transfer hold the customer was charged
     * at that moment; for a partner-pulled (ach_pull / bank_pull) hold nothing
     * has been pulled yet, but findInReviewOlderThan selects on paid_at, so a
     * NULL here would silently disable the >24h stale-review ops alert for
     * every held transfer. BLOCKED is excluded structurally: a sanctions hit
     * always lands as status 'blocked' today, but beginHold is directly
     * callable (partner-API confirmTransaction, reconcile fundhold) and the
     * predicate belongs in the UPDATE, not in the caller. Null ⇒ not
     * awaiting_payment anymore (already held / paid / cancelled) or blocked —
     * an idempotent no-op that never resurrects a terminal row.
     */
    async markInReviewIfAwaiting(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'in_review', paidAt: sql`COALESCE(${transfers.paidAt}, now())` })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'awaiting_payment'),
          ne(transfers.complianceStatus, 'blocked'),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * Atomically claim the in_review → paid transition — the STAFF RELEASE.
     * Deliberately NO 'cleared' predicate: a released transfer keeps
     * compliance_status = 'flagged' forever (the evidence is never rewritten),
     * and the admin-gated, audited release action IS the compliance decision.
     * BLOCKED is still excluded: the release path is reachable by a
     * PARTNER-scoped admin (releaseTransferAction = requireAdmin + canSee), so
     * sanctions-blocked money must be unreleasable in the UPDATE itself, even
     * if a future writer ever puts a blocked row in in_review. Used only
     * inside settlement.releaseHold, which enqueues the rail effect in the
     * same transaction — a release is a settlement, never a bare flip. Null ⇒
     * not in_review (never held / already released / rejected) or blocked —
     * an idempotent no-op that never resurrects a cancelled row.
     */
    async markPaidIfInReview(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'paid', paidAt: sql`COALESCE(${transfers.paidAt}, now())` })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'in_review'),
          ne(transfers.complianceStatus, 'blocked'),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },
```

   (`transfers.complianceStatus` is the existing column used at `transfer-repo.ts:298`; `toDomain` is the masked mapper at `:46-47` — the returned row carries `****last4`, never the raw destination. Add `ne` to the `drizzle-orm` import on line 1 — verify the export: `grep -n "export declare function ne\b" node_modules/drizzle-orm/sql/expressions/conditions.d.ts`, cite the line in the PR.)

4. Run: `npx vitest run tests/settlement.test.ts` — expect all green (the five new tests plus the four existing ones; the existing `beginSettlement` tests still pass because `fixture()` is `cleared`).

5. Commit:
```
feat(money-paths): ledger-gated markPaidIfAwaiting + markInReviewIfAwaiting hold claim

markPaidIfAwaiting now requires compliance_status = 'cleared' inside the
UPDATE itself, so no caller can flip a flagged/blocked row to paid with a
stale in-memory Transfer. markInReviewIfAwaiting is the mirror claim for the
compliance hold (awaiting_payment -> in_review, paid_at COALESCEd so the
>24h stale-review sweep keeps seeing held rows); it and markPaidIfInReview
both carry compliance_status <> 'blocked', so sanctions-blocked money is
structurally unholdable and unreleasable.

Refs F51, F53.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 2 — `beginSettlement` refusal arm, `beginHold`, `settleOrHold`

Read first: `src/lib/settlement.ts:1-72` (whole file), `src/lib/payment.ts:78-95` (`buildStage1Message(transfer, { held })` — pure, the held copy says "under a quick review"), `src/db/repos/outbox-repo.ts:42-58` (`enqueue(kind, payload, { delayMs?, dedupeKey? })` returns `true` only for a fresh row), `src/lib/outbox-worker.ts:99-103` (the `whatsapp.text` handler reads `{ to, body, creds }`).

1. Write the failing tests. In `tests/settlement.test.ts` change line 4 to `import { beginSettlement, beginHold, settleOrHold, releaseHold } from '@/lib/settlement';` and append:

```ts
async function stage1Body(id: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT payload->>'body' AS body FROM outbox WHERE dedupe_key = ${'stage1:' + id}`);
  return (r as unknown as { rows: Array<{ body: string }> }).rows[0]?.body ?? null;
}

describe('beginSettlement — compliance gate (only cleared money reaches a rail)', () => {
  it('REFUSES a flagged transfer: status stays awaiting_payment, ZERO outbox rows (no stage1, no settlement.instruct)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const r = await beginSettlement(db, { ...fixture(), complianceStatus: 'flagged' }, SIMULATOR);
    expect(r).toEqual({ kind: 'refused', complianceStatus: 'flagged' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('REFUSES a blocked transfer (defence in depth — callers 400/422 first)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'blocked' });
    const r = await beginSettlement(db, { ...fixture(), complianceStatus: 'blocked' }, MOCK);
    expect(r).toEqual({ kind: 'refused', complianceStatus: 'blocked' });
    expect(await outboxRows()).toHaveLength(0);
    expect((await store.getTransfer('st_t1'))?.paymentProviderRef).toBeUndefined();
  });

  it('the LEDGER decides, not the passed object: a stale "cleared" Transfer over a flagged row is refused', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const r = await beginSettlement(db, fixture() /* claims cleared */, SIMULATOR);
    expect(r).toEqual({ kind: 'refused', complianceStatus: 'flagged' });
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('beginHold — the transactional compliance hold', () => {
  it('ONE transaction: flips awaiting_payment → in_review, sets paidAt, enqueues exactly one stage1:<id> row and NO rail effect', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    const r = await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    expect(r).toEqual({ kind: 'held' });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    expect(after?.complianceStatus).toBe('flagged'); // the hold never rewrites compliance
    expect(after?.paymentProviderRef).toBeUndefined(); // no mock ref — no rail was touched
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' }]);
    const body = await stage1Body('st_t1');
    expect(body).toContain('quick review');
    expect(body).not.toContain('within ~10 minutes');
    expect(body).not.toContain('123456789012'); // PII: the destination never enters the payload
  });

  it('carries the OWNER partner WhatsApp creds on the held message (same payload shape as the paid stage-1)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' }, { phoneNumberId: 'pn_acme', token: 'tok_acme' });
    const r = await db.execute(sql`SELECT payload->'creds'->>'phoneNumberId' AS pn, payload->>'to' AS "to" FROM outbox WHERE dedupe_key = 'stage1:st_t1'`);
    const row = (r as unknown as { rows: Array<{ pn: string; to: string }> }).rows[0];
    expect(row).toEqual({ pn: 'pn_acme', to: '15551230000' });
  });

  it("is idempotent: a second call returns { kind: 'already' } and enqueues nothing", async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const second = await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    expect(second).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("on a cancelled / already-paid transfer is a no-op ('already') — never resurrects the row", async () => {
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled', complianceStatus: 'flagged' });
    expect(await beginHold(db, { ...fixture(), id: 'st_c1', status: 'cancelled' })).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
    await store.saveTransfer({ ...fixture(), id: 'st_p1', status: 'paid' });
    expect(await beginHold(db, { ...fixture(), id: 'st_p1', status: 'paid' })).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_p1'))?.status).toBe('paid');
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('settleOrHold — the ONE decision every settlement caller goes through', () => {
  it('cleared → started (settlement, rail effect enqueued)', async () => {
    await store.saveTransfer(fixture());
    expect(await settleOrHold(db, fixture(), SIMULATOR)).toEqual({ kind: 'started', webhookDriven: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1', 'instruct:st_t1']);
  });

  it('flagged → held (in_review, held message, NO rail effect)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await settleOrHold(db, { ...fixture(), complianceStatus: 'flagged' }, SIMULATOR)).toEqual({ kind: 'held' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('in_review');
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:st_t1' }]);
  });

  it('blocked → refused, nothing enqueued, status untouched', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'blocked' });
    expect(await settleOrHold(db, { ...fixture(), complianceStatus: 'blocked' }, MOCK)).toEqual({ kind: 'refused', complianceStatus: 'blocked' });
    expect((await store.getTransfer('st_t1'))?.status).toBe('awaiting_payment');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('stale in-memory "cleared" over a ledger-flagged row → held (DB truth wins, no instruct)', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    expect(await settleOrHold(db, fixture(), SIMULATOR)).toEqual({ kind: 'held' });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['stage1:st_t1']);
  });

  it("not awaiting_payment → already (replay), nothing enqueued", async () => {
    await store.saveTransfer({ ...fixture(), status: 'delivered' });
    expect(await settleOrHold(db, fixture(), SIMULATOR)).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('releaseHold — the staff release IS a settlement (in_review → paid + the rail effect, one transaction)', () => {
  it('webhook-driven rail: flips in_review → paid, keeps complianceStatus flagged + paidAt, enqueues instruct:<id> and NO second stage-1 message', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const held = (await store.getTransfer('st_t1'))!;
    const r = await releaseHold(db, held, SIMULATOR);
    expect(r).toEqual({ kind: 'released', webhookDriven: true });
    const after = await store.getTransfer('st_t1');
    expect(after?.status).toBe('paid');
    expect(after?.complianceStatus).toBe('flagged'); // release never rewrites compliance
    expect(after?.paidAt).toBe(held.paidAt);
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:st_t1', 'instruct:st_t1']); // stage1 deduped, the rail IS told
  });

  it('mock rail: the same delayed mocksettle:<id> effect + write-once mock providerRef beginSettlement uses', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    const r = await releaseHold(db, (await store.getTransfer('st_t1'))!, MOCK);
    expect(r).toEqual({ kind: 'released', webhookDriven: false });
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:st_t1', 'mocksettle:st_t1']);
    expect((await store.getTransfer('st_t1'))?.paymentProviderRef).toBe('mock-st_t1');
  });

  it('is idempotent and never resurrects: a second release, or a release of a cancelled/awaiting row, is { kind: "already" } with nothing enqueued', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR);
    expect(await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR)).toEqual({ kind: 'already' });
    expect(await outboxRows()).toHaveLength(2);
    await store.saveTransfer({ ...fixture(), id: 'st_c1', status: 'cancelled', complianceStatus: 'flagged' });
    expect(await releaseHold(db, { ...fixture(), id: 'st_c1', status: 'cancelled' }, SIMULATOR)).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_c1'))?.status).toBe('cancelled');
    await store.saveTransfer({ ...fixture(), id: 'st_a1', complianceStatus: 'flagged' }); // awaiting, never held
    expect(await releaseHold(db, { ...fixture(), id: 'st_a1' }, SIMULATOR)).toEqual({ kind: 'already' });
    expect((await store.getTransfer('st_a1'))?.status).toBe('awaiting_payment');
  });

  it('a released flagged transfer then completes exactly like a cleared one: the rail callback delivers it', async () => {
    await store.saveTransfer({ ...fixture(), complianceStatus: 'flagged' });
    await beginHold(db, { ...fixture(), complianceStatus: 'flagged' });
    await releaseHold(db, (await store.getTransfer('st_t1'))!, SIMULATOR);
    expect((await store.updateTransferFromWebhook('st_t1', 'delivered'))?.status).toBe('delivered');
  });
});
```

2. Run: `npx vitest run tests/settlement.test.ts`
   Expected: the `beginSettlement — compliance gate` tests fail with `AssertionError: expected { kind: 'already' } to deeply equal { kind: 'refused', complianceStatus: 'flagged' }` (after step 1 the claim returns null and today's code maps every null to `'already'`); the `beginHold` / `settleOrHold` / `releaseHold` tests fail at import: `TypeError: beginHold is not a function` / `settleOrHold is not a function` / `releaseHold is not a function`.

3. Implement. Replace `src/lib/settlement.ts` lines 30-72 with:

```ts
export type SettlementResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'already' } // not awaiting_payment anymore — idempotent no-op
  | { kind: 'refused'; complianceStatus: 'flagged' | 'blocked' }; // NOT cleared — never instructed

export type HoldResult =
  | { kind: 'held' } // awaiting_payment → in_review committed (+ held stage-1 row)
  | { kind: 'already' }; // not awaiting_payment anymore — idempotent no-op

/**
 * The union every settlement CALLER must handle exhaustively (switch on
 * `kind` — TypeScript refuses a missing arm). There is deliberately no arm a
 * caller can mistake for success: 'held' is a compliance hold (in_review,
 * staff release is the only way forward), 'refused' is a blocked transfer that
 * moved nothing. A caller that reaches 'refused' after charging must surface
 * it (ops alert / 4xx) — never swallow it.
 */
export type SettleOrHoldResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'held' }
  | { kind: 'already' }
  | { kind: 'refused'; complianceStatus: 'blocked' };

export type ReleaseResult =
  | { kind: 'released'; webhookDriven: boolean } // in_review → paid committed + the rail effect enqueued
  | { kind: 'already' }; // not in_review anymore — idempotent no-op, never resurrects

/**
 * The ONE rail-effect enqueue, shared by beginSettlement (cleared money) and
 * releaseHold (staff-released money) so the two can never drift: a webhook-
 * driven rail gets the signed instruction (`instruct:<id>`), the mock rail gets
 * the delayed simulated settlement (`mocksettle:<id>`) plus the deterministic
 * write-once providerRef. Both keys are forever; a replay enqueues nothing.
 */
async function enqueueRailEffect(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  paid: Transfer,
  integrations: PartnerIntegrations,
): Promise<{ webhookDriven: boolean }> {
  const providerType = integrations.payment.providerType;
  const webhookDriven = providerType === 'http' || providerType === 'simulator';
  const outbox = createOutboxRepo(tx);
  if (webhookDriven) {
    await outbox.enqueue('settlement.instruct', { transferId: paid.id }, { dedupeKey: `instruct:${paid.id}` });
  } else {
    await outbox.enqueue(
      'mock.settle',
      { transferId: paid.id, partnerId: paid.partnerId },
      { delayMs: DELIVERY_DELAY_MS, dedupeKey: `mocksettle:${paid.id}` },
    );
    // Parity with the old mock provider's deterministic ref (write-once).
    await createTransferRepo(tx).setProviderRef(paid.id, `mock-${paid.id}`);
  }
  return { webhookDriven };
}

/**
 * COMPLIANCE GATE: only 'cleared' money reaches a rail. The gate is the
 * ledger claim itself (markPaidIfAwaiting requires compliance_status =
 * 'cleared' in its WHERE), so a caller holding a stale Transfer object cannot
 * bypass it; when the claim returns null we re-read INSIDE the same
 * transaction to distinguish "already past awaiting_payment" (replay, no-op)
 * from "not cleared" (refused). Callers should normally go through
 * settleOrHold(); this stays exported for the reconcile sweep's cleared path
 * and for tests.
 */
export async function beginSettlement(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
  waCreds?: WaCreds,
): Promise<SettlementResult> {
  const providerType = integrations.payment.providerType;
  const webhookDriven = providerType === 'http' || providerType === 'simulator';

  return db.transaction(async (tx): Promise<SettlementResult> => {
    const repo = createTransferRepo(tx);
    const paid = await repo.markPaidIfAwaiting(transfer.id);
    if (!paid) {
      // Classify from the LEDGER, inside the same transaction. A cleared +
      // awaiting row here is unreachable (the UPDATE would have matched), so
      // it maps to the harmless no-op rather than a spurious refusal.
      const row = await repo.getTransfer(transfer.id);
      if (!row || row.status !== 'awaiting_payment' || row.complianceStatus === 'cleared') {
        return { kind: 'already' };
      }
      return { kind: 'refused', complianceStatus: row.complianceStatus };
    }

    const outbox = createOutboxRepo(tx);
    await outbox.enqueue(
      'whatsapp.text',
      { to: paid.phone, body: buildStage1Message(paid), creds: waCreds },
      { dedupeKey: `stage1:${paid.id}` },
    );
    const { webhookDriven: wd } = await enqueueRailEffect(tx, paid, integrations);
    return { kind: 'started', webhookDriven: wd };
  });
}
```
(`webhookDriven` computed at the top of `beginSettlement` is now only used for the type; drop the two lines there and use the value `enqueueRailEffect` returns.)

```ts
/**
 * THE transactional compliance HOLD (Phase 1 Task 3). One Postgres
 * transaction commits, together:
 *   • the awaiting_payment → in_review status flip (atomic claim —
 *     markInReviewIfAwaiting; a replay / crash-retry flips nothing),
 *   • paid_at (the customer WAS charged; the >24h stale-review sweep keys on it),
 *   • the customer's held "payment received — under review" message as a
 *     durable outbox row (dedupe stage1:<id> — the SAME key the paid path
 *     uses, so a transfer gets exactly one stage-1 message however it got here).
 * NO rail effect is enqueued HERE: the rail is told only when staff RELEASE
 * the transfer — releaseHold below — which is itself a settlement (in_review →
 * paid + the same rail effect). A released transfer keeps complianceStatus
 * 'flagged' forever: the release is the audited compliance decision, the
 * ledger evidence is never rewritten, and NO compliance predicate may ever be
 * added to markPaidIfInReview / releaseHold.
 *
 * Replaces the pay route's old completePaymentStage1 + re-read + saveTransfer
 * + direct sendText sequence, which had an observable intermediate 'paid'
 * state and a non-durable message.
 */
export async function beginHold(
  db: Db,
  transfer: Transfer,
  waCreds?: WaCreds,
): Promise<HoldResult> {
  return db.transaction(async (tx): Promise<HoldResult> => {
    const held = await createTransferRepo(tx).markInReviewIfAwaiting(transfer.id);
    if (!held) return { kind: 'already' };
    // `held` is the masked RETURNING row; buildStage1Message never names the
    // destination, so no payout field can reach the outbox payload.
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      { to: held.phone, body: buildStage1Message(held, { held: true }), creds: waCreds },
      { dedupeKey: `stage1:${held.id}` },
    );
    return { kind: 'held' };
  });
}

/**
 * The ONE decision function for "money was captured (or the partner pulls
 * it) — what happens now?". Every settlement call site (pay route, B2B pay
 * route, partner-API confirm, reconcile funding-resume sweep) goes through
 * here so the compliance branching exists in exactly one place:
 *   blocked → refused (nothing moves; callers already 4xx/422 before charging)
 *   cleared → beginSettlement (and if the LEDGER disagrees — re-screened to
 *             flagged since the caller's read — fall through to the hold)
 *   flagged → beginHold
 */
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

/**
 * THE staff RELEASE of a held transfer (Phase 1 Task 3). A release is a
 * SETTLEMENT, not a status flip: one Postgres transaction commits, together,
 *   • the in_review → paid claim (markPaidIfInReview — NO compliance predicate:
 *     the admin-gated, audited release action IS the compliance decision, and
 *     complianceStatus stays 'flagged' as evidence),
 *   • the SAME rail effect beginSettlement enqueues (instruct:<id> for a
 *     webhook-driven rail; the delayed mocksettle:<id> + mock providerRef for
 *     the mock rail) — so the partner rail is actually told to pay out (and to
 *     debit a B2B ach_pull/bank_pull buyer), exactly as for cleared money.
 * No stage-1 message here (stage1:<id> was sent by the hold). The delivered
 * message then arrives through the ordinary paid → delivered path (rail
 * callback / mock.settle handler). Null claim ⇒ 'already': never held, already
 * released, or rejected — nothing moves, nothing is enqueued.
 * Callers hand this the RAIL partner's integrations (settlementPartnerId ??
 * partnerId), the same rule as every other settlement caller.
 */
export async function releaseHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<ReleaseResult> {
  return db.transaction(async (tx): Promise<ReleaseResult> => {
    const paid = await createTransferRepo(tx).markPaidIfInReview(transfer.id);
    if (!paid) return { kind: 'already' };
    const { webhookDriven } = await enqueueRailEffect(tx, paid, integrations);
    return { kind: 'released', webhookDriven };
  });
}
```

   Known edge to DOCUMENT in the PR (not fixed here): `settleOrHold` with an in-memory `flagged` Transfer over a ledger row that is `blocked` returns `{ kind: 'already' }` (`markInReviewIfAwaiting`'s `<> 'blocked'` predicate yields null and `beginHold` maps every null to `'already'`) although nothing moved and the row is still `awaiting_payment`; the reconcile `fundblocked:` arm and the pay route's 400 therefore only fire when the CALLER's object already says `blocked`. Practically unreachable — nothing re-screens a row after mint, and a sanctions hit lands as status `blocked` before any charge — so the honest fix (re-read inside `beginHold` on a null claim, as `beginSettlement` does, and surface `refused/blocked`) is a follow-up, stated in the PR body.

   Also update the file header comment (`settlement.ts:10-28`): append one line after "each effect is dedupe-keyed so retries can never double-send.": `// COMPLIANCE: only 'cleared' money reaches a rail — see beginSettlement / beginHold / settleOrHold below — and a staff RELEASE (releaseHold) is the one other path to the rail, audited, never a bare status flip.`

   Doc-only touch in `src/lib/payment.ts:69-77`: change "the transactional settlement path (Stage 2c) can enqueue the EXACT text" to "the transactional settlement AND hold paths (settlement.ts beginSettlement / beginHold) can enqueue the EXACT text".

4. Run: `npx vitest run tests/settlement.test.ts` — all green. Also `npx vitest run tests/reconcile.test.ts tests/pay-route-funding.test.ts tests/pay-route-ach-pull.test.ts tests/pay-route-delayed-poke.test.ts tests/partner-api-service.test.ts` — still green (the additive arm changes nothing for cleared fixtures; the flagged pay-route test at `tests/pay-route-funding.test.ts:252` still passes because the route still uses its old branch until step 3).

5. Commit:
```
feat(money-paths): beginSettlement refusal arm, beginHold, settleOrHold and releaseHold

beginSettlement now reports { kind: 'refused', complianceStatus } when the
ledger claim refuses a non-cleared row (re-read inside the same transaction
to tell replay from refusal). beginHold commits the atomic
awaiting_payment -> in_review claim plus the held stage-1 message as a
dedupe-keyed outbox row in ONE transaction — no rail effect. settleOrHold is
the single decision function all settlement callers will route through.
releaseHold is the staff release as a SETTLEMENT: in_review -> paid
(markPaidIfInReview, no compliance predicate) + the same rail effect
beginSettlement enqueues, one transaction — the rail is actually told.

Refs F51, F53.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 3 — Pay route: refuse non-awaiting transfers BEFORE capture (F53); hold via `settleOrHold`

Read first: `src/app/api/pay/[transferId]/route.ts:69-170` (`processTransferPayment`: blocked gate `:73`, routed-rail gate `:102-113`, capture `:126-133`, the flagged branch to delete `:135-148`, the settlement call `:154-169`), `:306-383` (existing-transfer branch — note `store.saveTransfer` at `:349` and `:378` happen BEFORE `processTransferPayment`, so the status guard must also sit at the top of that branch or a cancelled row gets an ACH token / payout destination written onto it), `tests/pay-route-funding.test.ts:110-126` (the `vi.mock('@/lib/settlement')` wrapper that observes the exported `beginSettlement` — once the route calls `settleOrHold`, the wrapper must wrap `settleOrHold` or the `'settle'` ordering entries disappear and the existing happy-path test at `:181-207` fails), `tests/pay-route-delayed-poke.test.ts:197-211` (the paid-replay test asserts one immediate poke; the new guard returns BEFORE `pokeWorker()`, which is the more honest behaviour the route's own comment at `route.ts:166` describes — "replays ('already') changed nothing to drain").

1. Write the failing tests.

   1a. `tests/pay-route-funding.test.ts`: replace the wrapper at lines 110-126 with

```ts
// Wrap settleOrHold (the route's ONE settlement entry point) to observe what
// the LEDGER says at the moment settlement/hold starts — the fundingRef must
// already be durable by then. beginSettlement/beginHold stay real underneath.
const observed = vi.hoisted(() => ({ fundingRefAtSettle: undefined as string | undefined,
  statusAtSettle: undefined as string | undefined }));
vi.mock('@/lib/settlement', async (orig) => {
  const real = await orig<typeof import('@/lib/settlement')>();
  return {
    ...real,
    settleOrHold: async (...args: Parameters<typeof real.settleOrHold>) => {
      captured.order.push('settle');
      const t = await store.getTransfer(args[1].id);
      observed.fundingRefAtSettle = t?.fundingRef;
      observed.statusAtSettle = t?.status;
      return real.settleOrHold(...args);
    },
  };
});
```

   Add next to `outboxCount` (line 149):

```ts
const outboxRows = async () => {
  const rows = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
    rows: Array<{ kind: string; dedupe_key: string | null }>;
  };
  return rows.rows;
};
```

   Replace the whole `describe('pay route — funds capture ordering (flagged/held branch)', …)` block (lines 251-279) with:

```ts
describe('pay route — funds capture ordering (flagged/held branch)', () => {
  it('flagged transfer: capture runs BEFORE the hold; ends in_review with paidAt set, exactly one stage1 outbox row and ZERO rail-effect rows (held message is an outbox row, not a direct sendText)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f5', complianceStatus: 'flagged' }));
    const res = await post('f5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'in_review' });

    expect(capture).toHaveBeenCalledTimes(1);
    // Capture-before-effect: the hold (via settleOrHold) ran AFTER the charge succeeded,
    // and the ledger already carried the fundingRef at that moment.
    expect(captured.order.indexOf('capture')).toBeLessThan(captured.order.indexOf('settle'));
    expect(observed.fundingRefAtSettle).toBe('fund-abc');
    expect(observed.statusAtSettle).toBe('awaiting_payment');

    const after = await store.getTransfer('f5');
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    expect(after?.fundingRef).toBe('fund-abc');

    // Durable held message, NO rail effect, NO direct send.
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:f5' }]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('flagged + capture throw → 402; still awaiting_payment; NO held message enqueued', async () => {
    capture.mockRejectedValue(new Error('card declined'));
    await store.saveTransfer(makeTransfer({ id: 'f6', complianceStatus: 'flagged' }));
    const res = await post('f6');
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: 'payment_failed' });

    const after = await store.getTransfer('f6');
    expect(after?.status).toBe('awaiting_payment');
    expect(after?.fundingRef).toBeUndefined();
    expect(await outboxCount()).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('pay route — status guard BEFORE capture (F53: no resurrection, no re-charge)', () => {
  it('cancelled transfer: POST returns current status and captureFunding is NEVER called', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f7', status: 'cancelled', adminNote: 'rejected in review' }));
    const res = await post('f7');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'cancelled' });
    expect(capture).not.toHaveBeenCalled();
    expect(captured.order).not.toContain('settle');
    const after = await store.getTransfer('f7');
    expect(after?.status).toBe('cancelled');
    expect(after?.fundingRef).toBeUndefined();
    expect(await outboxCount()).toBe(0);
  });

  it('in_review transfer: a re-POST does not re-charge, does not re-send the held message and does not re-enter review', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f8', complianceStatus: 'flagged' }));
    await post('f8'); // first submit: charged + held
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:f8' }]);
    const paidAt = (await store.getTransfer('f8'))?.paidAt;

    const replay = await post('f8');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, status: 'in_review' });
    expect(capture).toHaveBeenCalledTimes(1); // no second charge
    expect(await outboxRows()).toHaveLength(1); // no second held message
    expect((await store.getTransfer('f8'))?.paidAt).toBe(paidAt); // no re-entry into review
    expect(sendText).not.toHaveBeenCalled();
  });

  it('paid / delivered transfer: replay POST returns current truth with no second capture', async () => {
    await store.saveTransfer(makeTransfer({ id: 'f9', status: 'paid', fundingRef: 'fund-old' }));
    expect(await (await post('f9')).json()).toEqual({ ok: true, status: 'paid' });
    await store.saveTransfer(makeTransfer({ id: 'f10', status: 'delivered', fundingRef: 'fund-old' }));
    expect(await (await post('f10')).json()).toEqual({ ok: true, status: 'delivered' });
    expect(capture).not.toHaveBeenCalled();
    expect(await outboxCount()).toBe(0);
    expect((await store.getTransfer('f9'))?.fundingRef).toBe('fund-old');
  });
});
```

   1b. `tests/pay-route-ach-pull.test.ts`: replace the wrapper at lines 108-124 with the same shape (observing `settleOrHold`, keeping `statusAtSettle` / `achTokenRefAtSettle`):

```ts
const observed = vi.hoisted(() => ({
  statusAtSettle: undefined as string | undefined,
  achTokenRefAtSettle: undefined as string | undefined,
}));
vi.mock('@/lib/settlement', async (orig) => {
  const real = await orig<typeof import('@/lib/settlement')>();
  return {
    ...real,
    settleOrHold: async (...args: Parameters<typeof real.settleOrHold>) => {
      captured.order.push('settle');
      const t = await store.getTransfer(args[1].id);
      observed.statusAtSettle = t?.status;
      observed.achTokenRefAtSettle = t?.achTokenRef;
      return real.settleOrHold(...args);
    },
  };
});
```

   Add an `outboxRows` helper (identical to 1a) next to `outboxCount` (line 154) and append inside the existing `describe('pay route — B2B ACH-pull …')`:

```ts
  it('flagged B2B ach_pull bill payment is HELD, not instructed (no signed dual-leg instruction enqueued)', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'b7', complianceStatus: 'flagged' }));
    const res = await postAch('b7');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'in_review' });

    expect(capture).not.toHaveBeenCalled(); // still non-custodial
    const after = await store.getTransfer('b7');
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    expect(after?.achTokenRef).toMatch(/^ach_[0-9a-f]+$/); // mandate bound, unused until release
    expect(await outboxRows()).toEqual([{ kind: 'whatsapp.text', dedupe_key: 'stage1:b7' }]);
    expect(sendText).not.toHaveBeenCalled();
  });
```

   1c. `tests/pay-route-in-review.test.ts`: add after line 27 (`import { completePaymentStage1 } …`):

```ts
import { sql } from 'drizzle-orm';
import { beginHold } from '@/lib/settlement';
import { sendText } from '@/lib/whatsapp';
```

   and replace the first test (lines 59-75, `'flagged: completePaymentStage1(held=true) sets status=paid; route then saves in_review'`) with:

```ts
  it('flagged: the hold is ONE atomic transition — no intermediate paid state is ever observable, the held message is an outbox row', async () => {
    const db = await freshDb();
    const store = createStore(fakeRedis(), db);
    const t = makeTransfer({ id: 'f1', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
    await store.saveTransfer(t);

    // What the route does for flagged now: ONE transaction via beginHold.
    const r = await beginHold(db, t);
    expect(r).toEqual({ kind: 'held' });

    const final = await store.getTransfer('f1');
    expect(final?.status).toBe('in_review');
    expect(final?.paidAt).toBeTruthy(); // the >24h stale-review sweep keys on it
    // No direct send — the held message is durable (dedupe stage1:<id>), and
    // there is no rail effect of any kind.
    expect(sendText).not.toHaveBeenCalled();
    const rows = (await db.execute(sql`SELECT kind, dedupe_key, payload->>'body' AS body FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ kind: string; dedupe_key: string; body: string }>;
    };
    expect(rows.rows.map((x) => [x.kind, x.dedupe_key])).toEqual([['whatsapp.text', 'stage1:f1']]);
    expect(rows.rows[0].body).toContain('quick review');
    expect(rows.rows[0].body).not.toContain('within ~10 minutes');
  });
```

   (The other two tests in that file exercise `completePaymentStage1`'s held copy and stay as-is — `completePaymentStage1` is unchanged and still used by `src/lib/providers/payment-provider.ts:75`, `src/lib/providers/http-payment-provider.ts:188`, `tests/payment.test.ts`, `tests/e2e.test.ts:143`, `tests/partner-orchestration.test.ts:136`.)

   1d. `tests/pay-route-delayed-poke.test.ts` lines 197-211: the paid-replay test becomes

```ts
  it("'already' replay (double submit): NO poke at all is scheduled — the status guard returns before any effect", async () => {
    // Not awaiting_payment anymore ⇒ the pre-capture status guard reports
    // current truth; nothing was enqueued, so there is nothing to drain.
    await store.saveTransfer(makeTransfer({ id: 'd3', status: 'paid' }));
    const res = await post('d3');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });

    expect(captured.afterCallbacks).toHaveLength(0);

    vi.useFakeTimers();
    const settled = startCallbacks();
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS + 60_000);
    await settled;
    expect(workerCalls()).toBe(0);
  });
```

   The routed paid-replay test at `:273-283` (`d8`) needs no change (it asserts only `200 { status: 'paid' }`).

2. Run: `npx vitest run tests/pay-route-funding.test.ts tests/pay-route-ach-pull.test.ts tests/pay-route-in-review.test.ts tests/pay-route-delayed-poke.test.ts`
   Expected failures: funding — the happy-path test (`captured.order.indexOf('settle')` is `-1` because the route still calls `beginSettlement`, not the wrapped `settleOrHold`), `f5` (`sendText` WAS called; outbox has 0 rows), `f7` (`expected "spy" to not have been called` — today the cancelled row IS charged; `beginSettlement` then returns `'already'` and the body happens to read `{ ok: true, status: 'cancelled' }`, which is precisely the "charged but silent" strand F53 describes), `f8` (`capture` called twice, and a second held message via direct `sendText`), `f9/f10` (`already` branch still pokes / `capture` called). ach-pull — happy-path test loses `'settle'`; `b7` gets `sendText` called + 0 outbox rows. in-review — `TypeError: beginHold is not a function` does NOT happen (step 2 shipped it) — it passes already; that is fine, it locks the contract. delayed-poke `d3` — `expected [ [Function] ] to have a length of 0`.

3. Implement `src/app/api/pay/[transferId]/route.ts`.

   3a. Imports (lines 19-23): replace

```ts
import { beginSettlement } from '@/lib/settlement';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { completePaymentStage1 } from '@/lib/payment';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendText, sendTransactionOtp, type WaCreds } from '@/lib/whatsapp';
```
   with
```ts
import { settleOrHold } from '@/lib/settlement';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp, type WaCreds } from '@/lib/whatsapp';
```

   3b. Add above `processTransferPayment` (after `captureFunding`, line 49):

```ts
/**
 * F53 refusal gate — the FIRST thing both the existing-transfer branch and
 * processTransferPayment run, BEFORE any saveTransfer, any capture and any
 * effect. A sender holding a valid per-transaction OTP must not be able to
 * (a) re-charge or re-hold a transfer that already moved (paid / delivered /
 * in_review), or (b) resurrect one staff cancelled / admin rejected. Anything
 * that is not a live awaiting_payment row reports CURRENT TRUTH in the same
 * shape the settlement replay branch uses (200 + status) — never a second
 * capture, a second stage-1 message or a second review entry. Blocked keeps
 * its 400 (a blocked transfer is never charged). Null ⇒ proceed.
 */
function refuseUnlessAwaiting(transfer: Transfer): NextResponse | null {
  if (transfer.complianceStatus === 'blocked' || transfer.status === 'blocked') {
    return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
  }
  if (transfer.status !== 'awaiting_payment') {
    return NextResponse.json({ ok: true, status: transfer.status });
  }
  return null;
}
```

   3c. Replace the `processTransferPayment` doc comment + body (lines 51-170) with:

```ts
/**
 * Process payment for a resolved, LIVE (awaiting_payment) transfer.
 *
 * REFUSAL GATES — every one returns BEFORE captureFunding. THE ORDER IS THE
 * CONTRACT (ruling 7, route.ts half); every gate refuses before any charge:
 *   1. status guard + blocked (refuseUnlessAwaiting — F53)
 *   2. rail fail-closed (routed rail must be webhook-driven; fix 12 adds the
 *      settlement-URL predicate for the routed AND owner rail)
 * The masked-destination (fix 6), FX-unavailable (fix 9) and send-cap (fix 10)
 * guards do NOT live here: they are pay-finalize.ts's pre-claim contract
 * (kyc → masked destination → FX → cap → idem.claim) and run before a draft is
 * ever minted into the transfer this function receives. Never add a second
 * copy of any of them to this list.
 * Then: capture (skipped for partner-pulled B2B) → settleOrHold, which is the
 * ONE compliance decision (settlement.ts):
 *  - cleared  → beginSettlement: ONE transaction flips paid + enqueues the
 *               stage-1 message and the rail effect (Stage 2c — atomic).
 *  - flagged  → beginHold: ONE transaction flips in_review (paidAt set) +
 *               enqueues the held "under review" message; NO rail effect.
 *               Staff release (admin dashboard) is the only way forward.
 * Both charging branches capture funds FIRST — nothing messages "payment
 * received" or flips status before the charge succeeds.
 *
 * NON-CUSTODIAL B2B ACH-pull (`fundingMethod === 'ach_pull'`): SmartRemit
 * captures NO funds — the licensed partner ACH-debits the payer's business bank
 * via the signed settlement instruction (which already carries the opaque
 * `achTokenRef` mandate). The capture step is SKIPPED entirely; the compliance
 * branching is otherwise identical. The skip is derived from the TRANSFER
 * (`fundingMethod === 'ach_pull'`), NOT a caller flag — so the non-custodial
 * invariant holds no matter which call site reaches here.
 */
async function processTransferPayment(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
): Promise<NextResponse> {
  const refused = refuseUnlessAwaiting(transfer);
  if (refused) return refused;

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

  // Fail-closed: a ROUTED transfer must settle on the settlement partner's
  // webhook-driven rail. Routing eligibility was checked at quote time — if
  // their config was removed or downgraded since (providerType OR the
  // settlement endpoint: the same pair quote-time eligibility requires),
  // refuse BEFORE any charge rather than silently falling into the mock
  // branch (a fake delivery the owning partner never opted into) or charging
  // into an instruct that can only dead-letter. (The status guard above
  // already returned current truth for a replay, so this only ever sees
  // money that can still be charged.)
  if (transfer.settlementPartnerId) {
    const railProviderType = railIntegrations.payment.providerType;
    const railWebhookDriven = railProviderType === 'http' || railProviderType === 'simulator';
    if (!railWebhookDriven || !railIntegrations.payment.credentials?.settlementUrl) {
      logError(
        'pay.routed-rail-unavailable',
        new Error('routed settlement partner has no usable webhook-driven rail'),
        { transferId: transfer.id },
      );
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
  }

  // ── FUNDS CAPTURE — after every refusal gate, before any effect ──────────
  // Every gate above returns BEFORE this point (those transfers are never
  // charged). A capture failure mutates nothing: no status change, no charge
  // recorded, no message — a clean 402 and the link stays retryable.
  // Idempotent capture + write-once setFundingRef make a crash-retry harmless
  // (and the reconcile sweep resumes a charged-but-unsettled row).
  //
  // NON-CUSTODIAL B2B pull (ach_pull / bank_pull): SmartRemit captures NOTHING —
  // the partner pulls via the signed instruction. Skip the funding provider
  // entirely (derived from the transfer, so this holds for EVERY call site).
  if (!isPartnerPulled(transfer.fundingMethod)) {
    try {
      await captureFunding(transfer);
    } catch (err) {
      logError('pay.capture', err, { transferId: transfer.id });
      return NextResponse.json({ ok: false, error: 'payment_failed' }, { status: 402 });
    }
  }

  // The ONE compliance decision: settle (cleared) or hold (flagged) — each an
  // atomic transaction whose effects are dedupe-keyed outbox rows. settleOrHold
  // decides the rail purely from the PASSED integrations — hand it the RAIL
  // partner's config, message with the OWNER's creds.
  const result = await settleOrHold(getDb(), transfer, railIntegrations, waCreds);
  pokeWorker(); // fast-path drain (the stage-1 / held message is READY now)
  switch (result.kind) {
    case 'held':
      return NextResponse.json({ ok: true, status: 'in_review' });
    case 'already': {
      // Double submit / replay — the first settlement won; report current truth.
      const current = await store.getTransfer(transfer.id);
      // A charged row that is NOT awaiting_payment and NOT paid/in_review is the
      // capture↔cancel race (captureFunding = provider.capture THEN
      // setFundingRef; Task 5's cancelIfCancellable guard is `funding_ref IS
      // NULL`, so a cancel landing between those two calls leaves a cancelled
      // row that WAS charged). Say so loudly — the reconcile sweep's
      // cancelcharged:<id> alert is the durable signal; this log is the fast one.
      if (current?.fundingRef && current.status === 'cancelled' && (current.refundStatus ?? 'none') === 'none') {
        logError('pay.charged-but-cancelled', new Error('customer charged on a cancelled transfer'), { transferId: transfer.id });
      }
      return NextResponse.json({ ok: true, status: current?.status ?? 'paid' });
    }
    case 'refused':
      // Unreachable after refuseUnlessAwaiting (kept exhaustive on purpose: a
      // refusal must never read as success). The charge, if any, is visible
      // on the ledger via fundingRef; the reconcile sweep raises the
      // fundblocked:<id> alert, whose remedy is a change-ticket ledger edit
      // (no dashboard action applies to a charged blocked row).
      logError('pay.settle-refused', new Error('settlement refused by compliance after capture'), {
        transferId: transfer.id,
      });
      return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
    case 'started':
      if (!result.webhookDriven) {
        // Mock rail: the delivered confirmation is a DELAYED outbox row
        // (DELIVERY_DELAY_MS) that the immediate poke above can't see — schedule
        // a best-effort second poke for just after the delay elapses so the
        // customer isn't waiting on the 5-minute heartbeat. Real rails are
        // webhook-driven (the callback pokes).
        pokeWorkerDelayed(DELIVERY_DELAY_MS + 10_000);
      }
      return NextResponse.json({ ok: true, status: result.webhookDriven ? 'processing' : 'paid' });
  }
}
```

   3d. In `POST`, at the top of the existing-transfer branch — immediately after `if (transfer) {` (line 308) and before the `owner` lookup — insert:

```ts
      // F53: refuse BEFORE the KYC gate and before any saveTransfer below can
      // write bank details / an ACH mandate token onto a row that already
      // moved or was cancelled. Same gate runs again inside
      // processTransferPayment (chokepoint for the draft branch too).
      const refused = refuseUnlessAwaiting(transfer);
      if (refused) return refused;
```

   3e. Update the `captureFunding` doc comment (`route.ts:35-45`): "OTP → payout validation → compliance → capture → setFundingRef → stage-1 message / beginSettlement" becomes "OTP → payout validation → status guard + compliance → capture → setFundingRef → settleOrHold (settle or hold)". Update the comments at `route.ts:339-344` ("… until beginSettlement commits … (achTokenRef already bound ⇒ beginSettlement resumes cleanly)") to say `settleOrHold`.

4. Run: `npx vitest run tests/pay-route-funding.test.ts tests/pay-route-ach-pull.test.ts tests/pay-route-in-review.test.ts tests/pay-route-delayed-poke.test.ts tests/pay-route-otp.test.ts tests/pay-route-bank-details.test.ts tests/settlement.test.ts` — all green. Then `npx tsc --noEmit && npx eslint "src/app/api/pay/[transferId]/route.ts" src/lib/settlement.ts` — clean (an unused `sendText` / `completePaymentStage1` import is an eslint error, hence the import edit in 3a).

5. Commit:
```
fix(money-paths): pay route refuses non-awaiting transfers before capture and holds via settleOrHold (F53)

refuseUnlessAwaiting runs before any saveTransfer, capture or effect: a
cancelled / rejected / paid / delivered / in_review transfer now reports
current truth instead of being re-charged or resurrected by a sender with a
valid OTP. The non-atomic flagged branch (completePaymentStage1 + re-read +
saveTransfer + direct sendText) is replaced by settleOrHold -> beginHold, so
the in_review flip and the held message commit in one transaction with no
observable intermediate paid state.

Refs F53.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 4 — Partner API: `confirmTransaction` holds a flagged transfer OUTSIDE the `initiatePayment` seam (F51)

Read first: `src/lib/partner-api-service.ts:46-57` (`PartnerApiDeps.initiatePayment` is optional and injectable), `:365-395` (`confirmTransaction`: ownership 404 at `:371-372`, blocked 422 at `:373`, replay 200 at `:374`, 409 at `:375`, the default `initiate` at `:377-390` calling `beginSettlement`), `tests/partner-api-service.test.ts:20-51` (`harness()` injects `initiatePayment` that flips to `paid` via `getTransferDecrypted` + `saveTransfer`), `:330-340` (the existing confirm test expects `paid`), `src/lib/compliance.ts:46-54` (a `flagged` verdict comes from `largeAmountUsd` / `velocityLimit`; the existing `txBody()` amount of 200 is cleared, so the test flags the row explicitly after minting).

1. Write the failing tests. In `tests/partner-api-service.test.ts` add `import { sql } from 'drizzle-orm';` to the imports, add `vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));` next to the file's other `vi.mock`s (the hold path calls `pokeWorker()` inside `confirmTransaction`; the poke must be ASSERTABLE, not merely tolerated because `after()` throws outside a request context), import the two doubles (`import { pokeWorker } from '@/lib/outbox';`) and append a new describe:

```ts
describe('partner-api-service: confirmTransaction enforces the compliance hold (F51)', () => {
  async function outboxRows(db: Awaited<ReturnType<typeof harness>>['db']) {
    const r = await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`);
    return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null }> }).rows;
  }
  /** Mint a cleared transfer, then flag it on the ledger (the way the velocity /
   *  large-amount rules would at createTransfer time). Decrypted read → save,
   *  so the stored payout destination is not clobbered by the mask. */
  async function mintFlagged(h: Awaited<ReturnType<typeof harness>>, p: Partner, idem: string) {
    const created = await createTransaction(h.deps, p, 'pk_1', idem, txBody());
    if (!created.ok) throw new Error('unexpected: ' + created.error);
    const id = (created.data as { id: string }).id;
    const cur = await h.store.getTransferDecrypted(id);
    await h.store.saveTransfer({ ...cur!, complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
    return id;
  }

  it('on a FLAGGED transfer returns 200 with status in_review and enqueues NO settlement.instruct / mock.settle row', async () => {
    const h = await harness();
    const id = await mintFlagged(h, DELEGATED, 'idem-hold-1');

    const r = await confirmTransaction(h.deps, DELEGATED, 'pk_1', id);
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (r.ok) expect((r.data as { status: string; compliance_status: string })).toMatchObject({ status: 'in_review', compliance_status: 'flagged' });

    const after = await h.store.getTransfer(id);
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    const rows = await outboxRows(h.db);
    expect(rows.map((x) => x.kind)).not.toContain('settlement.instruct');
    expect(rows.map((x) => x.kind)).not.toContain('mock.settle');
    expect(rows.filter((x) => x.dedupe_key === `stage1:${id}`)).toEqual([{ kind: 'whatsapp.text', dedupe_key: `stage1:${id}` }]);
    expect(pokeWorker).toHaveBeenCalled(); // the held stage-1 message is READY now — fast-path drain requested
  });

  it('on a flagged transfer NEVER calls deps.initiatePayment (the hold is decided before the injection seam)', async () => {
    const h = await harness();
    const initiatePayment = vi.fn(h.deps.initiatePayment!); // the harness fake flips straight to paid
    h.deps.initiatePayment = initiatePayment;
    const id = await mintFlagged(h, DELEGATED, 'idem-hold-2');

    await confirmTransaction(h.deps, DELEGATED, 'pk_1', id);
    expect(initiatePayment).not.toHaveBeenCalled();
    expect((await h.store.getTransfer(id))?.status).toBe('in_review');
  });

  it('a DELEGATED-KYC key holds exactly like an OURS key (sanctions/compliance is untoggleable)', async () => {
    const h = await harness();
    await h.deps.partnerStore.savePartner(OURS);
    // Mint under OURS with the gate off for the mint only (kyc_required would 422 the mint); the HOLD must not care.
    const id = await mintFlagged(h, { ...OURS, kycMode: 'delegated', requireKycBeforeSend: false }, 'idem-hold-3');
    const r = await confirmTransaction(h.deps, OURS, 'pk_2', id);
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (r.ok) expect((r.data as { status: string }).status).toBe('in_review');
  });

  it('a replayed confirm on a held transfer is idempotent: 200 in_review, no second message, no review re-entry, no second audit row', async () => {
    const h = await harness();
    const id = await mintFlagged(h, DELEGATED, 'idem-hold-4');
    await confirmTransaction(h.deps, DELEGATED, 'pk_1', id);
    const paidAt = (await h.store.getTransfer(id))?.paidAt;
    const before = (await outboxRows(h.db)).length;
    const auditsBefore = (await h.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'transaction.confirm'`)) as unknown as { rows: Array<{ n: number }> };
    expect(auditsBefore.rows[0].n).toBe(1);

    const replay = await confirmTransaction(h.deps, DELEGATED, 'pk_1', id);
    expect(replay).toMatchObject({ ok: true, status: 200 });
    if (replay.ok) expect((replay.data as { status: string }).status).toBe('in_review');
    expect((await outboxRows(h.db)).length).toBe(before);
    expect((await h.store.getTransfer(id))?.paidAt).toBe(paidAt);
    const auditsAfter = (await h.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'transaction.confirm'`)) as unknown as { rows: Array<{ n: number }> };
    expect(auditsAfter.rows[0].n).toBe(1); // the replay short-circuits above the hold; a hold that loses the race audits nothing either
  });

  it('still 422s a blocked transfer and still settles a cleared one to paid (regression)', async () => {
    const h = await harness();
    const created = await createTransaction(h.deps, DELEGATED, 'pk_1', 'idem-reg-1', txBody());
    const id = created.ok ? (created.data as { id: string }).id : '';
    const cur = await h.store.getTransferDecrypted(id);
    await h.store.saveTransfer({ ...cur!, complianceStatus: 'blocked' });
    expect(await confirmTransaction(h.deps, DELEGATED, 'pk_1', id)).toMatchObject({ ok: false, status: 422 });
    expect((await h.store.getTransfer(id))?.status).toBe('awaiting_payment');

    const okc = await createTransaction(h.deps, DELEGATED, 'pk_1', 'idem-reg-2', txBody());
    const okId = okc.ok ? (okc.data as { id: string }).id : '';
    const r = await confirmTransaction(h.deps, DELEGATED, 'pk_1', okId);
    if (r.ok) expect((r.data as { status: string }).status).toBe('paid');
  });

  it('rival partner still gets 404 for a flagged transfer (ownership before any hold read/mutation)', async () => {
    const h = await harness();
    const id = await mintFlagged(h, DELEGATED, 'idem-hold-5');
    expect(await confirmTransaction(h.deps, partner({ id: 'rival' }), 'pk_r', id)).toMatchObject({ ok: false, status: 404 });
    expect((await h.store.getTransfer(id))?.status).toBe('awaiting_payment');
    expect(await outboxRows(h.db)).toHaveLength(0);
  });
});
```

2. Run: `npx vitest run tests/partner-api-service.test.ts`
   Expected: the first, second, third and fourth new tests fail — today `confirmTransaction` runs the injected `initiatePayment`, so the status is `paid` (`expected 'paid' to be 'in_review'`; `expected "spy" to not be called`), and the replay test gets `409 Cannot confirm a transfer in status in_review`. The regression and 404 tests already pass.

3. Implement. In `src/lib/partner-api-service.ts` change line 25 to `import { beginHold, settleOrHold } from './settlement';` and replace `confirmTransaction` (lines 364-395) with:

```ts
// ── POST /transactions/:id/confirm (ownership-scoped) ─────────────────────
//
// COMPLIANCE HOLD (F51): the hold is decided HERE — before, and independent
// of, the injectable `deps.initiatePayment` seam — so neither a test double
// nor any partner configuration can route a flagged transfer to a rail.
// Sanctions/compliance screening is structurally untoggleable and applies in
// BOTH KYC modes: a delegated-KYC key holds exactly like an 'ours' key (the
// check is on complianceStatus, never on kycMode).
export async function confirmTransaction(
  deps: PartnerApiDeps,
  partner: Partner,
  keyId: string,
  id: string,
): Promise<SvcResult<unknown>> {
  const t = await deps.store.getTransfer(id);
  // 404 (never 403) BEFORE any read or mutation of another tenant's row.
  if (!t || t.partnerId !== partner.id) return err(404, 'Transaction not found.');
  if (t.complianceStatus === 'blocked' || t.status === 'blocked') return err(422, 'This transfer was blocked by compliance screening.');
  // Idempotent replay: already settled OR already held → current truth, no second effect.
  if (t.status === 'paid' || t.status === 'delivered' || t.status === 'in_review') {
    return ok(200, await transferViewWithName(deps, t));
  }
  if (t.status !== 'awaiting_payment') return err(409, `Cannot confirm a transfer in status ${t.status}.`);

  if (t.complianceStatus !== 'cleared') {
    // FLAGGED: hold, never settle. beginHold is ONE transaction (in_review
    // flip + held stage-1 outbox row, dedupe stage1:<id>); NO rail effect.
    // Partner-scoped: ownership was checked above; creds are the OWNER's.
    const integrations = await deps.integrationsStore.getIntegrations(partner.id);
    const hold = await beginHold(deps.db as Db, t, waCredsFrom(integrations));
    if (hold.kind === 'held') {
      pokeWorker(); // the held "payment received / under review" message is READY now
      // Audit ONLY a real transition (mirrors the settle path below): on the
      // 'already' race a concurrent confirm/pay won and audited it — a second
      // transaction.confirm row here would record a no-op as an action.
      await appendAudit(deps, partner.id, keyId, 'transaction.confirm', t.id);
    }
    const held = await deps.store.getTransfer(id);
    return ok(200, await transferViewWithName(deps, held ?? t));
  }

  const initiate = deps.initiatePayment ?? (async (tr: Transfer) => {
    // Stage 2c: the atomic settlement transaction — paid flip + stage-1 message
    // + rail effect (signed instruct / delayed mock settle) commit together,
    // with the partner's WhatsApp creds on the customer message. settleOrHold
    // re-checks the LEDGER: if the row was re-screened to flagged since the
    // read above, it is held instead of instructed.
    const integrations = await deps.integrationsStore.getIntegrations(partner.id);
    const result = await settleOrHold(deps.db as Db, tr, integrations, waCredsFrom(integrations));
    // Fast-path drains, mirroring the pay route: the stage-1 message is READY
    // now; the mock rail's delivered message only becomes ready after its
    // simulated DELIVERY_DELAY_MS. The 5-min heartbeat stays the guarantee.
    pokeWorker();
    if (result.kind === 'started' && !result.webhookDriven) {
      pokeWorkerDelayed(DELIVERY_DELAY_MS + 10_000);
    }
    // 'held' / 'already' / 'refused' need no further effect here: the re-read
    // below returns the ledger's current truth (in_review / paid / awaiting).
  });
  await initiate(t);
  await appendAudit(deps, partner.id, keyId, 'transaction.confirm', t.id);
  const after = await deps.store.getTransfer(id);
  return ok(200, await transferViewWithName(deps, after ?? t));
}
```

   (`Db` is already imported as a type at `partner-api-service.ts:28`; `waCredsFrom`, `pokeWorker`, `pokeWorkerDelayed`, `DELIVERY_DELAY_MS`, `appendAudit` are already in scope. The route adapter `src/app/api/partner/v1/transactions/[id]/confirm/route.ts:11` needs no change. Behaviour change to document in the PR: a confirm replay on an `in_review` transfer now returns `200` with the view instead of `409`. Test-harness note: the hold path calls `pokeWorker()` inside `confirmTransaction`; step 1 above mocks `@/lib/outbox` in `tests/partner-api-service.test.ts` exactly as `tests/whatsapp-route.test.ts` does, so the poke is asserted (`expect(pokeWorker).toHaveBeenCalled()`) rather than tolerated through `after()` throwing outside a request context (`src/lib/outbox.ts:24-30`). Add `vi.mocked(pokeWorker).mockClear()` to the file's `beforeEach` if one exists (else the assertion is per-test and needs no reset).)

4. Run: `npx vitest run tests/partner-api-service.test.ts tests/settlement.test.ts` — all green.

5. Commit:
```
fix(partner-api): confirmTransaction holds a flagged transfer outside the initiatePayment seam (F51)

A flagged transfer confirmed via the partner API was handed straight to
beginSettlement. The hold (beginHold: in_review + held stage-1 outbox row,
one transaction, no rail effect) is now decided before the injectable
initiatePayment seam, so no test double or partner config can bypass it, and
it applies identically to delegated-KYC and ours-KYC keys. A confirm replay
on a held transfer is idempotent (200, current truth) instead of 409.

Refs F51.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 5 — B2B pay route and the reconcile funding-resume sweep route through `settleOrHold`

Read first: `src/app/api/pay/b2b/[invoiceId]/route.ts:226-251` (the replay guard at `:231-233` already exists; the `beginSettlement` call at `:245`; `b2b-pay-finalize.ts:245-247` refuses only `blocked`, so a flagged mint reaches `:245`), `src/lib/reconcile.ts:99-128` (the victims loop), `src/db/repos/transfer-repo.ts:258-275` (`listAwaitingWithFunding` — DO NOT add a compliance predicate: charged flagged rows must be held, not abandoned), `tests/reconcile.test.ts:135-222` (the crash-resume describe: `victim()` fixture, the `outboxRows()` helper, the simulator integrations seed). No unit harness exists for the B2B route (`grep -rn "api/pay/b2b" tests/` is empty); its change is a mechanical caller update whose exhaustiveness `tsc` proves, and the post-deploy Playwright smoke exercises the page.

1. Write the failing tests. Append inside `describe('reconcileSweep — crash-resume (charged but never settled)', …)` in `tests/reconcile.test.ts` (after the `'an old awaiting_payment row that was NEVER charged is not a victim'` test):

```ts
  it('a FLAGGED charged victim is HELD (in_review + stage1 row + its own deduped ops alert) and NO settlement.instruct is enqueued', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(victim({ complianceStatus: 'flagged' }));

    const first = await reconcileSweep(db);
    expect(first.fundingResumed).toBe(1); // resumed to its CORRECT next state (held)
    const after = await store.getTransfer('rc_fund1');
    expect(after?.status).toBe('in_review');
    expect(after?.paidAt).toBeTruthy();
    expect(after?.fundingRef).toBe('mockfund-rc_fund1'); // the charge is not lost
    expect(await outboxRows()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:rc_fund1' },
      { kind: 'ops.alert', dedupe_key: 'fundhold:rc_fund1' },
    ]);
    const alert = (await db.execute(
      sql`SELECT payload->>'message' AS message FROM outbox WHERE dedupe_key = 'fundhold:rc_fund1'`,
    )) as unknown as { rows: Array<{ message: string }> };
    expect(alert.rows[0].message).toContain('HELD for compliance review');

    // The stale-review sweep now owns it (>24h) — and re-sweeping adds nothing.
    const second = await reconcileSweep(db);
    expect(second.fundingResumed).toBe(0);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('a cleared charged victim still resumes to paid with the instruct row (regression)', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
    await store.saveTransfer(victim());
    const r = await reconcileSweep(db);
    expect(r.fundingResumed).toBe(1);
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('paid');
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual([
      'stage1:rc_fund1', 'instruct:rc_fund1', 'fundresume:rc_fund1',
    ]);
  });

  it('a CANCELLED row that was CHARGED and never refunded (the capture↔cancel race) raises ONE deduped cancelcharged:<id> alert and moves nothing', async () => {
    // captureFunding = provider.capture THEN setFundingRef; Task 5's cancel guard is
    // funding_ref IS NULL, so a cancel that lands between those two calls leaves
    // exactly this row. No sweep watched it before.
    await store.saveTransfer(victim({ status: 'cancelled', refundStatus: 'none' }));
    const first = await reconcileSweep(db);
    expect(first.fundingResumed).toBe(0);
    expect(await outboxRows()).toEqual([{ kind: 'ops.alert', dedupe_key: 'cancelcharged:rc_fund1' }]);
    expect((await store.getTransfer('rc_fund1'))?.status).toBe('cancelled');
    await reconcileSweep(db);
    expect(await outboxRows()).toHaveLength(1);
    // A cancelled row whose refund is already in flight is NOT alerted by THIS arm (that is Task 5's
    // reject/refund path doing its job). Seed its funding.refund effect row first: without one, the
    // PRE-EXISTING stuck-refund sweep in the same reconcileSweep call selects rc_fund2 too
    // (listByRefundStatus('pending') → zero recent effect rows → `refundstuck:rc_fund2`, exactly as
    // 'a pending refund with NO effect row at all (lost effect) alerts immediately' pins), and the
    // whole-outbox assertion would read ['cancelcharged:rc_fund1', 'refundstuck:rc_fund2'].
    await store.saveTransfer(victim({ id: 'rc_fund2', status: 'cancelled', refundStatus: 'pending' }));
    await createOutboxRepo(db).enqueue('funding.refund', { transferId: 'rc_fund2' }, { dedupeKey: 'refund:rc_fund2' });
    await reconcileSweep(db);
    expect((await outboxRows()).map((x) => x.dedupe_key).filter((k) => k?.startsWith('cancelcharged:'))).toEqual(['cancelcharged:rc_fund1']);
    expect((await outboxRows()).map((x) => x.dedupe_key)).not.toContain('refundstuck:rc_fund2'); // fresh effect row ⇒ not stuck either
  });
```

2. Run: `npx vitest run tests/reconcile.test.ts`
   Expected: the flagged test fails — after step 1 `beginSettlement` refuses, so `fundingResumed` is `0`, status stays `awaiting_payment`, and the outbox has only `fundresume:rc_fund1` (`expected [ { kind: 'ops.alert', dedupe_key: 'fundresume:rc_fund1' } ] to deeply equal [ whatsapp.text stage1…, ops.alert fundhold… ]`). This is exactly the "charged but silent" strand the risk section warns about — the assertion pins it closed. The regression test passes already.

3. Implement.

   3a. `src/lib/reconcile.ts`: change line 6 to `import { settleOrHold } from '@/lib/settlement';` and replace the victims loop (lines 99-128) with:

```ts
  // CRASH-RESUME: the customer was CHARGED (fundingRef is write-once, set
  // before settlement) but the process died before settlement/hold committed —
  // the one state the funds-capture seam can strand. Resume it through
  // settleOrHold, the same atomic claims the pay route uses, so the sweep
  // firing every minute moves each victim EXACTLY once and a victim racing its
  // own resurrected pay request is still a clean no-op. COMPLIANCE: a charged
  // FLAGGED victim is HELD (in_review + held stage-1 message, one transaction)
  // and never instructed; a charged BLOCKED victim (should not exist — blocked
  // rows are never charged) is left untouched with its own alert for ops to
  // refund. Both count as "resumed": the charged row reached its correct next
  // state. NEVER add a compliance predicate to listAwaitingWithFunding — that
  // would abandon charged flagged rows instead of holding them.
  const victims = await transfers.listAwaitingWithFunding(FUNDING_RESUME_MINUTES * 60_000);
  let fundingResumed = 0;
  for (const t of victims) {
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
    const prefix = `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was charged (${t.fundingRef}) but never settled — `;
    switch (result.kind) {
      case 'started':
        fundingResumed++;
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'resumed settlement from the sweep.' },
          { dedupeKey: `fundresume:${t.id}` },
        );
        break;
      case 'held':
        // Correct ONLY because a staff release actually instructs the rail
        // (settlement.releaseHold, Step 2) — otherwise "held" would be a
        // charged row the rail is never told about.
        fundingResumed++;
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'flagged by compliance, so it was HELD for compliance review (in_review), not instructed. Release or reject it in the dashboard.' },
          { dedupeKey: `fundhold:${t.id}` },
        );
        break;
      case 'refused':
        // Charged AND blocked: nothing may move. Practically unreachable (a
        // sanctions hit lands as status 'blocked' at mint, before any charge,
        // and nothing re-screens a row after mint) — but the tests construct
        // it, so name the escalation honestly: there is NO in-app remedy for a
        // charged blocked row (fix 5's Cancel refuses a charged row, Refund
        // accepts only paid|delivered), so it is a change-ticket: refund at the
        // funding provider, then record the outcome with a direct ledger edit
        // (status 'cancelled', refund_status 'completed', refund_ref).
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'it is BLOCKED by compliance and was CHARGED. NOT settled. No dashboard action applies — refund at the funding provider and close it with a direct ledger edit under a change ticket.' },
          { dedupeKey: `fundblocked:${t.id}` },
        );
        break;
      case 'already':
        // Lost the race to a resurrected pay request / a concurrent sweep —
        // the row already moved; keep today's alert (deduped) for the record.
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'resumed settlement from the sweep.' },
          { dedupeKey: `fundresume:${t.id}` },
        );
        break;
    }
  }
```

   Directly after the victims loop add the charged-but-cancelled watch (no `SweepResult` field — an alert count is not a resume; the test pins it through the outbox):

```ts
  // CHARGED-BUT-CANCELLED (the capture↔cancel race): captureFunding is
  // provider.capture THEN setFundingRef, and the staff cancel guard (Task 5,
  // cancelIfCancellable) is `funding_ref IS NULL`, so a cancel landing between
  // those two calls leaves a cancelled row the customer paid for and nothing
  // refunds. No sweep watched that state. Alert once per row; ops refund it by
  // hand (issueRefund accepts paid|delivered only — by design, the remedy is a
  // human decision). Rows already refunding are Task 5's reject path at work.
  for (const t of await transfers.findCancelledCharged()) {
    await outbox.enqueue(
      'ops.alert',
      { message: `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) is CANCELLED but was CHARGED (${t.fundingRef}) and has no refund in flight — refund it by hand.` },
      { dedupeKey: `cancelcharged:${t.id}` },
    );
  }
```

   with, in `src/db/repos/transfer-repo.ts` (next to `findStuckPaid`):

```ts
    /** cancelled + funding_ref set + refund_status 'none' — the capture↔cancel race; alert-only. */
    async findCancelledCharged(limit = 100): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(eq(transfers.status, 'cancelled'), isNotNull(transfers.fundingRef), eq(transfers.refundStatus, 'none')))
        .orderBy(transfers.createdAt)
        .limit(limit);
      return rows.map(toDomain);
    },
```
   (`isNotNull` — `node_modules/drizzle-orm/sql/expressions/conditions.d.ts`, `grep -n "export declare function isNotNull"`; check whether `refund_status` defaults to `'none'` or NULL in `schema.ts` and use `sql\`coalesce(${transfers.refundStatus}, 'none') = 'none'\`` if the latter.)

   `SweepResult` is NOT widened (fix 7 owns its shape); held victims count in `fundingResumed`, which the doc comment states. Update the file header (`reconcile.ts:17-18`): "→ resume settlement + alert" becomes "→ resume settlement (cleared) or HOLD for review (flagged) + alert" and add a bullet "• cancelled + charged + unrefunded → alert (`cancelcharged:`)".

   3b. `src/app/api/pay/b2b/[invoiceId]/route.ts`: change line 13 to `import { settleOrHold } from '@/lib/settlement';` and replace lines 235-251 with:

```ts
    // ── NON-CUSTODIAL settlement: ONE signed dual-leg instruction; NO capture ─
    // settleOrHold is the ONE compliance decision: cleared → beginSettlement
    // (signed instruct); flagged → beginHold (in_review + held message, NO
    // instruction — the partner never debits the buyer until staff release).
    const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
    const integrationsStore = getPartnerIntegrationsStore();
    const railIntegrations = await integrationsStore.getIntegrations(railPartnerId);
    const brandIntegrations =
      railPartnerId === transfer.partnerId
        ? railIntegrations
        : await integrationsStore.getIntegrations(transfer.partnerId);
    const waCreds = waCredsFrom(brandIntegrations);

    const result = await settleOrHold(getDb(), transfer, railIntegrations, waCreds);
    pokeWorker();
    switch (result.kind) {
      case 'held':
        return NextResponse.json({ ok: true, status: 'in_review' });
      case 'already': {
        const current = await store.getTransfer(transfer.id);
        return NextResponse.json({ ok: true, status: current?.status ?? 'paid' });
      }
      case 'refused':
        // b2b-pay-finalize already returns { error: 'blocked' } for a blocked
        // mint (handled above) — kept exhaustive so a refusal never reads as
        // success. Same generic copy as the blocked mint: no compliance leak.
        return NextResponse.json({ ok: false, error: "We can't process this payment." }, { status: 400 });
      case 'started':
        return NextResponse.json({ ok: true, status: 'processing' });
    }
```

4. Run: `npx vitest run tests/reconcile.test.ts tests/settlement.test.ts && npx tsc --noEmit && npx eslint src/lib/reconcile.ts "src/app/api/pay/b2b/[invoiceId]/route.ts"` — green/clean. (`tsc` is the proof for the B2B route: a missing `switch` arm would be a compile error because the function's return type is `Promise<NextResponse>` and the switch is the last statement.)

5. Commit:
```
fix(money-paths): B2B pay route and reconcile sweep hold flagged charged transfers instead of instructing

The B2B bill route refused only blocked mints, and the funding-resume sweep
re-settled every charged awaiting_payment row regardless of compliance. Both
now go through settleOrHold: cleared -> settle, flagged -> beginHold (with a
fundhold:<id> ops alert from the sweep), blocked -> refused with a
fundblocked:<id> alert. listAwaitingWithFunding is unchanged on purpose so
charged flagged rows are held, never abandoned.

Refs F51.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 6 — Staff release is a settlement (`releaseHold`); reject regression on a `beginHold`-held transfer; docs

Read first: `src/lib/dashboard-ops.ts:99-154` (`releaseTransfer(store, id)` → `completePaymentStage2` — today a bare `saveTransfer({ status: 'delivered' })` with NO rail instruction: the latent defect this step fixes; `rejectTransfer(store, db, id)` → cancel + auto-refund when `fundingRef` set), `src/app/admin-dashboard/actions.ts:107-113` (`releaseTransferAction` — the ONLY caller of `releaseTransfer`; `rejectTransferAction` at `:121-126` already passes `getDb()`), `src/lib/payment.ts:151-197` (`completePaymentStage2` stays — the `mock.settle` worker handler at `outbox-worker.ts:120` is its remaining caller), `tests/dashboard-ops.test.ts:170-244` (existing release/reject tests seed `in_review` rows directly via `saveTransfer`; the new tests seed via `beginHold` so the real held shape — `paidAt` set, `complianceStatus` still `flagged`, a `stage1:` outbox row present — is what release/reject see).

1. Write the failing tests.

   1a. `tests/dashboard-ops.test.ts` — add `import { beginHold } from '@/lib/settlement';` and `import { createIntegrationsRepo } from '@/db/repos/integrations-repo';`. In the existing `describe('releaseTransfer')` (:170-196): the three refusal tests' calls at :182, :188, :194 become `releaseTransfer(store, db, 'missing')` / `(store, db, 'rel2')` / `(store, db, 'rel3')` (arity only). The first test at :171-177 (`'delivers an in_review transfer (sets status delivered, deliveredAt)'`) cannot survive an arity change alone — after `releaseHold` the row is `paid` with a `mocksettle:rel1` row (the `'default'` partner has no integrations row ⇒ mock rail) and `paymentProviderRef 'mock-rel1'`, so `expect(loaded?.status).toBe('delivered')` / `deliveredAt` fail. REPLACE it with:

```ts
  it('release is a SETTLEMENT, not a status flip: in_review → paid + the mock-rail effect (delivery arrives via the mock.settle handler, never here)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rel1', status: 'in_review', paidAt: '2026-05-30T00:00:00Z' }));
    await releaseTransfer(store, db, 'rel1');
    const loaded = await store.getTransfer('rel1');
    expect(loaded?.status).toBe('paid');
    expect(loaded?.deliveredAt).toBeUndefined();
    expect(loaded?.paymentProviderRef).toBe('mock-rel1');
    expect(await outboxRows()).toEqual([{ kind: 'mock.settle', dedupe_key: 'mocksettle:rel1' }]);
  });
```

   1b. `tests/review-actions.test.ts` — on `4fc4e6a` the file mocks ONLY `@/lib/auth`, `@/lib/store` and `next/cache`, NOT `@/db/client`; `rejectTransferAction` gets away with `getDb()` because its uncharged path never touches `db`, but the new `releaseTransfer(store, getDb(), id)` → `createIntegrationsRepo(db).getIntegrations(...)` would dial the dud test `DATABASE_URL`. Bind `getDb()` to the test PGlite (pattern: `tests/partners-actions.test.ts:18-24`): add `import type { Db } from '@/db/client';`, a module-level `let db: Db;`, change the `beforeEach` to `db = await freshDb(); store = createStore(fakeRedis(), db);`, and add

```ts
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getDb: () => db,
}));
```

   next to the other `vi.mock`s (the factory closes over the `let` lazily — same as the `getStore` mock). Then the first test (:70-77, `'delivers an in_review transfer when admin calls it'`) becomes `'releases an in_review transfer to paid (a settlement) when admin calls it'` with `expect(loaded?.status).toBe('paid');`. The `not in_review` / auth tests are unchanged.

   1c. Append to `tests/dashboard-ops.test.ts`:

```ts
describe('release / reject on a transfer HELD by beginHold (release is a SETTLEMENT — the rail is told; reject refunds)', () => {
  const simulatorRail = () =>
    createIntegrationsRepo(db).saveIntegrations('default', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' }, webhookSecret: 'w' },
      whatsapp: {},
    });

  it('releaseTransfer on a webhook-driven rail: in_review → paid, complianceStatus stays flagged, paidAt kept, and instruct:<id> is ENQUEUED (the rail is told to pay out)', async () => {
    await simulatorRail();
    const store = createStore(fakeRedis(), db);
    const t = makeTransfer({ id: 'rel_hold', complianceStatus: 'flagged', fundingRef: 'mockfund-rel_hold' });
    await store.saveTransfer(t);
    expect(await beginHold(db, t)).toEqual({ kind: 'held' });
    const held = await store.getTransfer('rel_hold');
    expect(held?.status).toBe('in_review');

    await releaseTransfer(store, db, 'rel_hold');
    const loaded = await store.getTransfer('rel_hold');
    expect(loaded?.status).toBe('paid');                 // NOT delivered: delivery is the rail's callback, as for cleared money
    expect(loaded?.deliveredAt).toBeUndefined();
    expect(loaded?.paidAt).toBe(held?.paidAt);
    expect(loaded?.complianceStatus).toBe('flagged');    // release never rewrites compliance
    expect(await outboxRows()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:rel_hold' },
      { kind: 'settlement.instruct', dedupe_key: 'instruct:rel_hold' },
    ]);
    // The rail's callback then delivers it exactly like a cleared transfer.
    expect((await store.updateTransferFromWebhook('rel_hold', 'delivered'))?.status).toBe('delivered');
  });

  it('releaseTransfer on the MOCK rail: in_review → paid + the delayed mocksettle:<id> row (the worker delivers after DELIVERY_DELAY_MS)', async () => {
    const store = createStore(fakeRedis(), db); // 'default' has no integrations row ⇒ mock rail
    const t = makeTransfer({ id: 'rel_mock', complianceStatus: 'flagged', fundingRef: 'mockfund-rel_mock' });
    await store.saveTransfer(t);
    await beginHold(db, t);
    await releaseTransfer(store, db, 'rel_mock');
    expect((await store.getTransfer('rel_mock'))?.status).toBe('paid');
    expect((await store.getTransfer('rel_mock'))?.paymentProviderRef).toBe('mock-rel_mock');
    expect((await outboxRows()).map((x) => x.dedupe_key)).toEqual(['stage1:rel_mock', 'mocksettle:rel_mock']);
  });

  it('releaseTransfer on a B2B ach_pull hold instructs the dual-leg pull (the buyer is only debited on release)', async () => {
    await simulatorRail();
    const store = createStore(fakeRedis(), db);
    const t = makeTransfer({ id: 'rel_b2b', complianceStatus: 'flagged', fundingMethod: 'ach_pull', transferType: 'b2b', achTokenRef: 'ach_deadbeef' });
    await store.saveTransfer(t);
    await beginHold(db, t);
    await releaseTransfer(store, db, 'rel_b2b');
    expect((await store.getTransfer('rel_b2b'))?.status).toBe('paid');
    expect((await outboxRows()).map((x) => x.dedupe_key)).toContain('instruct:rel_b2b');
  });

  it('releaseTransfer still refuses a row that is not in_review, and a double release enqueues nothing twice', async () => {
    await simulatorRail();
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(makeTransfer({ id: 'rel_x', status: 'awaiting_payment' }));
    await expect(releaseTransfer(store, db, 'rel_x')).rejects.toThrow(/not in_review/);
    const t = makeTransfer({ id: 'rel_twice', complianceStatus: 'flagged', fundingRef: 'f' });
    await store.saveTransfer(t);
    await beginHold(db, t);
    await releaseTransfer(store, db, 'rel_twice');
    await expect(releaseTransfer(store, db, 'rel_twice')).rejects.toThrow(/not in_review/);
    expect((await outboxRows()).filter((x) => x.dedupe_key === 'instruct:rel_twice')).toHaveLength(1);
  });

  it('rejectTransfer auto-refunds a beginHold-held CHARGED transfer (cancelled + refund pending + funding.refund row)', async () => {
    const store = createStore(fakeRedis(), db);
    const t = makeTransfer({ id: 'rej_hold', complianceStatus: 'flagged', fundingRef: 'mockfund-rej_hold' });
    await store.saveTransfer(t);
    await beginHold(db, t);

    await rejectTransfer(store, db, 'rej_hold');
    const loaded = await store.getTransfer('rej_hold');
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.refundStatus).toBe('pending');
    expect(loaded?.adminNote).toContain('rejected in review');
    expect(await outboxRows()).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'stage1:rej_hold' },
      { kind: 'funding.refund', dedupe_key: 'refund:rej_hold' },
    ]);
  });

  it('a rejected (cancelled) transfer can never be re-held: beginHold is a no-op afterwards', async () => {
    const store = createStore(fakeRedis(), db);
    const t = makeTransfer({ id: 'rej_again', complianceStatus: 'flagged', fundingRef: 'mockfund-rej_again' });
    await store.saveTransfer(t);
    await beginHold(db, t);
    await rejectTransfer(store, db, 'rej_again');
    expect(await beginHold(db, t)).toEqual({ kind: 'already' });
    expect((await store.getTransfer('rej_again'))?.status).toBe('cancelled');
  });
});
```

2. Run: `npx vitest run tests/dashboard-ops.test.ts tests/review-actions.test.ts` — expected: the rewritten `rel1` test and the four new release tests FAIL (`releaseTransfer(store, db, id)` arity — today's `releaseTransfer(store, id)` treats `db` as the id: `Transfer not found`; after fixing the call, `expected 'delivered' to be 'paid'` and the outbox has no `instruct:`/`mocksettle:` row — the latent defect reproduced); `review-actions` first test fails with `expected 'delivered' to be 'paid'`; the reject tests pass already (contract locks — state that in the PR).

3. Implement.

   `src/lib/dashboard-ops.ts` — replace `releaseTransfer` (`:99-113`); drop the `completePaymentStage2` import if it has no other use in the file (`grep -n completePaymentStage2 src/lib/dashboard-ops.ts`); add `import { releaseHold } from './settlement';`, `import { createIntegrationsRepo } from '@/db/repos/integrations-repo';` and `import type { Db } from '@/db/client';`:

```ts
/**
 * Release a held (in_review) transfer — a SETTLEMENT, not a status flip:
 * settlement.releaseHold commits in_review → paid AND the rail effect (signed
 * instruct / delayed mock settle) in ONE transaction, so the partner rail is
 * actually told to pay out (and to debit a B2B buyer). Rail config follows
 * the same rule as every settlement caller: the SETTLEMENT partner's when
 * routed, else the owner's. Throws if the transfer is not exactly in_review
 * (guards double-release / wrong status) — the status check is re-done by the
 * guarded claim inside releaseHold, so a race can never release twice.
 * Called by the compliance dashboard "Release" action (admin-gated, audited).
 */
export async function releaseTransfer(store: Store, db: Db, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot release: transfer is not in_review (current status: ${transfer.status})`);
  }
  const railIntegrations = await createIntegrationsRepo(db).getIntegrations(transfer.settlementPartnerId ?? transfer.partnerId);
  const r = await releaseHold(db, transfer, railIntegrations);
  if (r.kind === 'already') {
    throw new Error('Cannot release: transfer is not in_review (it moved concurrently)');
  }
}
```

   `src/app/admin-dashboard/actions.ts:107-113` — `releaseTransferAction` becomes `await releaseTransfer(store, getDb(), id); pokeWorker();` (fast-path drain of the instruct row). `getDb` is already imported (`:22`, for `rejectTransferAction`) but `pokeWorker` is NOT — `rejectTransfer` pokes from inside `dashboard-ops.ts:160`, not from the action — so add `import { pokeWorker } from '@/lib/outbox';` to the imports (or poke inside `releaseTransfer` after `releaseHold` returns `'released'`, exactly as `rejectTransfer` does; pick one, never both). The existing audit row for the release action (if any — `grep -n "transfer.release" src/app/admin-dashboard/actions.ts`) stays; it is the compliance decision's record. If the release action currently sends `completePaymentStage2`'s delivered message itself, delete that send: the delivered message now comes from the rail callback / `mock.settle` handler, exactly as for cleared money.

   Run: `npx vitest run tests/dashboard-ops.test.ts tests/review-actions.test.ts tests/settlement.test.ts tests/admin-actions-scope.test.ts && npx tsc --noEmit` → green (the `releaseTransfer` arity change has exactly one src caller; `tsc` proves it).

4. Docs (no code):
   - `src/app/docs/page.tsx:93`: `desc="Confirm funds captured → settlement begins"` → `desc="Confirm funds captured → settlement begins (a flagged transfer is held in_review for compliance release; a blocked one is 422)"`.
   - `docs/SYSTEM-ARCHITECTURE.md:184-186`: replace the paragraph with: "Compliance outcomes branch at step 5/6: a watchlist hit records a `blocked` row (never charged, auditable); a `flagged` transfer charges but is **held** as `in_review` for staff release/reject. The hold is enforced in ONE place — `settleOrHold` → `beginHold` in `src/lib/settlement.ts` — and the ledger claim itself (`markPaidIfAwaiting … AND compliance_status = 'cleared'`) refuses to flip a non-cleared row, so every settlement caller (pay page, B2B bill page, partner-API `/confirm`, the reconcile sweep) inherits it. `beginHold` commits the `awaiting_payment → in_review` flip (with `paid_at`) and the held 'payment received — under review' message (outbox, dedupe `stage1:{id}`) in one transaction; no rail effect exists until staff release. A staff **release is a settlement**: `releaseHold` commits `in_review → paid` (`markPaidIfInReview`, deliberately no compliance predicate — the audited release IS the decision) together with the same rail effect cleared money gets (`instruct:{id}` / `mocksettle:{id}`), so the rail is told to pay out and delivery arrives through the ordinary callback path. A released transfer keeps `compliance_status = 'flagged'` as evidence."
   - `docs/SYSTEM-ARCHITECTURE.md:270-274`: after "…resumes settlement: a charged customer's transfer is never lost." append: " A charged **flagged** row is resumed into the hold (`in_review` + held message + a `fundhold:{id}` ops alert), never instructed; `listAwaitingWithFunding` carries no compliance predicate on purpose."
   - `docs/SYSTEM-ARCHITECTURE.md:373-374`: "`in_review` >24h → ops alert" stays; add "; charged-but-flagged rows → held (`fundhold:`)".
   - `src/app/api/pay/[transferId]/route.ts` and `settlement.ts` comments were updated in steps 2-3.

5. Run the full gate (the Stop hook enforces it anyway): `npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run` — quote the summary lines in the PR. Expect every suite green; the only suites whose assertions changed are the nine listed under **Test:** above. If `Duplicate identifier` appears in `.next/types/* 2.ts`, that is the iCloud duplicate-file gotcha (delete the ` 2` file, `rm -rf .next`), not a regression.

6. Commit:
```
fix(admin-dashboard): staff release is a settlement — releaseHold instructs the rail; reject regression on a beginHold-held transfer; docs

releaseTransfer(store, db, id) now goes through settlement.releaseHold:
in_review -> paid (no compliance predicate; the audited release IS the
decision) + the same rail effect cleared money gets, one transaction. Before
this, release was a bare saveTransfer({status:'delivered'}) that never told
the rail to pay out. rejectTransfer on a beginHold-held transfer (in_review,
paidAt set, complianceStatus still flagged) still cancels + auto-refunds.
Documents settleOrHold / beginHold / releaseHold in SYSTEM-ARCHITECTURE and
the /confirm endpoint description.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNekw1dojfutKUR3XDoDxw
```

---

#### Step 7 — Review, PR, merge, verify

1. Run `/security-review` on the branch (touches money, compliance and a partner-API endpoint). Expected focus points and the answers the diff must give: (a) no new input crosses the edge unvalidated — the only new input is the existing transfer row's `status` / `complianceStatus`; (b) tenant scope — `confirmTransaction` still 404s before any read/mutation, `beginHold` receives the owner's creds only; (c) PII — the held outbox payload is `{ to, body, creds }` built from a masked RETURNING row; (d) idempotency — `stage1:` shared between paid and held paths is intentional (one stage-1 message per transfer, whichever path it took).
2. Dispatch a Fable 5.1 final review with this checklist (each item maps to an invariant in the brief):
   - `grep -n "instruct\|mock.settle" src/lib/settlement.ts` — both enqueues live in ONE helper (`enqueueRailEffect`) reachable from exactly two places: after a non-null `markPaidIfAwaiting` (whose `WHERE` carries `compliance_status = 'cleared'`) and after a non-null `markPaidIfInReview` (the audited staff release).
   - `grep -rn "beginSettlement(" src` — only `settlement.ts` (inside `settleOrHold`) remains; all four former call sites use `settleOrHold` / `beginHold`. (`tests/settlement.test.ts` calls `beginSettlement` directly by design.)
   - `grep -rn "releaseHold\|markPaidIfInReview\|complianceStatus" src/lib/settlement.ts src/lib/dashboard-ops.ts src/db/repos/transfer-repo.ts` — no `complianceStatus` predicate on the release path; `releaseTransfer` is the only caller of `releaseHold`; `completePaymentStage2` is no longer imported by `dashboard-ops.ts`.
   - `tests/dashboard-ops.test.ts` proves the release enqueues `instruct:<id>` on a webhook-driven rail (including a B2B `ach_pull` hold) and `mocksettle:<id>` on the mock rail.
   - `listAwaitingWithFunding` body is byte-identical to `main`.
   - The pay route's `refuseUnlessAwaiting` is above `captureFunding` AND above both `store.saveTransfer` writes in the existing-transfer branch.
   - No `SweepResult` field was added (fix 7 owns the shape).
3. Open the PR from `fix/money-paths/compliance-hold-on-every-settlement-path` → `main`. Body: findings F51/F53 + the B2B/sweep siblings, the design paragraph above, the two documented behaviour changes (confirm replay on `in_review` → 200 instead of 409; a replay POST to the pay route no longer pokes the worker), a note that `refuseUnlessAwaiting` sits BELOW the per-transaction OTP gate (`route.ts:262-269` on main) so a caller still needs a valid OTP before learning a transfer's status — the guard is a refusal gate, not an unauthenticated status oracle — the `settleOrHold` blocked/`'already'` edge from Step 2, an OWNER DECISION recorded in the body: `releaseTransferAction` stays `requireAdmin` + `canSee`, so after this PR a PARTNER-scoped admin's "Release" actually instructs the rail for a transfer that SmartRemit's OWN screening flagged (`kycMode 'ours'`) — before, it was a bare status flip; the `ne(complianceStatus, 'blocked')` predicate keeps sanctions-blocked money out, but whether a flagged (non-blocked) release for an `'ours'`-mode partner should require PLATFORM staff is the owner's call — state the decision (or that it is deferred to a follow-up with the ticket id), the quoted `tsc` / `eslint` / `vitest` output, the security-review summary, and a note that `tests/dashboard-ops.test.ts` additions are contract locks (green on first run). End with the required attribution lines. Wait for `ci / ci`.
4. Squash-merge (after fix 7 and fix 1 have merged and their `/migrate-prod` runs are done — this PR ships no migration, so no `drizzle-kit migrate` step). Then `/post-merge-check` and confirm the post-deploy `smoke.yml` run is green; the smoke's pay-link flow exercises the cleared path end to end.
5. Manual Claude-in-Chrome walk-through against production, one flagged case: mint a transfer that trips the large-amount rule in the demo partner, open its pay link, submit with OTP, confirm the page reports "under review", confirm the transfer shows in `/admin-dashboard/compliance` in-review queue with a paid timestamp, confirm the outbox (`/outbox-status`) shows one `whatsapp.text` `stage1:<id>` and NO `settlement.instruct` / `mock.settle` for that id, then Release it and confirm the outbox now shows `instruct:<id>` (simulator partner) or `mocksettle:<id>` (mock partner), the transfer reads `paid`, and delivery arrives through the rail callback / mock settle — the 🎉 delivered message must NOT appear before the rail effect drains. Then re-POST the pay link (replay) and confirm `{ ok: true, status: 'paid' }` (or `delivered` once settled) with no second message.
6. `/sync-branches` so `component/money-paths` equals `main` again.

**Why no migration.** `transfers_status_check` (`src/db/schema.ts:120`) already allows `'in_review'`, and the `(status, paid_at)` index (`schema.ts:128`) already serves `findInReviewOlderThan`. The only DB-layer change is the new repo method `markInReviewIfAwaiting` and the extra `AND compliance_status = 'cleared'` predicate on `markPaidIfAwaiting` — plain DML inside the existing transactions, no DDL, so no `drizzle/` file, no `_journal.json` edit and no `npx drizzle-kit migrate` step. `tests/helpers-db.ts` migrates PGlite from the checked-in `drizzle/` folder, so the PGlite suites prove the SQL against the real schema.

**Rebase notes for the fixes that land after this one.** Fix 11 rewrites `beginSettlement`'s signature (drops the `waCreds` param): it must apply the same change to `beginHold` and `settleOrHold` and re-thread the five post-3 call sites (pay route, B2B route, reconcile, partner-API default `initiatePayment` → `settleOrHold`, and `confirmTransaction` → `beginHold`); `releaseHold` never had a `waCreds` param. Fix 5's `cancelIfCancellable` admits an UNCHARGED `in_review` row; after this task a released row is `paid` (instructed), which fix 5 refuses — consistent. Fixes 6, 9 and 10 do NOT touch `processTransferPayment`'s gate list: per ruling 7 their guards (masked destination, FX unavailable, send cap) go into `pay-finalize.ts` BEFORE `idem.claim` (fix 6 Step 6.4, fix 9 Step 17, fix 10 10.11) — an executor must never add a second copy of any of them to `route.ts`; fix 12 is the only later task that edits this gate list (the rail predicate). Fix 4's rail-failure transition must keep `updateTransferFromWebhook`'s `in_review` exclusion (`transfer-repo.ts:156`) so a held row is never flipped by a callback.

