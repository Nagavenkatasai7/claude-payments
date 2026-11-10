# Sanctions screening spec (internal)

Internal only. This file is not published on the docs site (it is not in `src/content/docs/registry.ts`). It describes what the code does on 2026-11-10, after fix pack 2 ("Sanctions fail closed on real-money rails"). The code is the source of truth. When this file and the code disagree, fix one of them in the same PR.

The match-quality fixture `tests/fixtures/sanctions-match-quality-2026-11.json` (dated `asOf` 2026-11-10) records today's outcome for a set of invented names. `tests/sanctions-match-quality.test.ts` checks every case against the real screener and checks that this file names the fixture and the 0.90 threshold. A change that moves any outcome must update the fixture and this file together.

Screening always runs. No switch, flag, partner setting or KYC mode turns it off. KYC may be delegated to the partner; sanctions screening may not.

## 1. Normalisation and matching

Normalisation (`src/lib/sanctions/normalize.ts`) is applied to the query and to every list name:

1. lowercase first, then Unicode NFKD, then strip combining marks (so `á` becomes `a`, and `İ` does not leave a stray mark);
2. every run of characters that is not a letter or digit (any script) becomes one space; trim;
3. `tokenKey`: split on spaces, sort the tokens, join with one space. Word order, commas, hyphens, case and extra spacing therefore never change the key (`HUSAIN, Zayn` = `Zayn Husain`).

Letters of every script are kept: a Cyrillic or Arabic name is never reduced to an empty key. Nothing is transliterated.

Matching (`ListSanctionsScreener.screen`, `src/lib/sanctions/list-screener.ts`), in order:

| Step | Rule | Outcome |
|---|---|---|
| 1 | empty key | no match |
| 2 | exact token key of a STRONG name (primary name or strong a.k.a.), or of a configured extra name (partner / corridor watchlist) | matched, score 1: **block** |
| 3 | exact token key of a WEAK a.k.a. (OFAC category `weak`) | possible match, score 1: **review**, never a block |
| 4 | best Jaro-Winkler of the token keys against every strong name and extra name, at least `FUZZY_THRESHOLD = 0.9` (0.90) | possible match, score rounded to 3 places: **review** |
| 5 | otherwise | no match: **clear** for this party |

Step 4 skips keys whose length is less than half the query's (or the reverse): such a pair can never reach 0.90, so nothing is lost. Jaro-Winkler is computed on the WHOLE token key, so the same spelling pair scores differently next to other tokens. Each score in the fixture holds for that exact pair only.

The mock screener (`MockSanctionsScreener`, `src/lib/providers/sanctions-provider.ts`) matches exact token keys only: no weak names and no fuzzy step. Its list is the demo `WATCHLIST` (`src/lib/compliance-config.ts`) plus the partner's corridor `watchlistExtra`.

## 2. Verdicts and evidence

`screenTransfer` (`src/lib/compliance.ts`) screens every party (recipient, sender, and any `alsoRecipientNames`, each as a further recipient party) and returns:

- **blocked**: any party matched. Reason `RECIPIENT_WATCHLIST` or `SENDER_WATCHLIST`. A block returns first: no other reason can soften it.
- **flagged** (held for review): a possible match (`POSSIBLE_MATCH`), the list unavailable (`LIST_UNAVAILABLE`, section 4), a large amount (`LARGE_AMOUNT`: by default $1,000 or more in USD, `LARGE_AMOUNT_USD`), velocity (`VELOCITY`: by default the sender already sent 5 or more times today, `VELOCITY_LIMIT`), plus the EDD and AML holds applied elsewhere. A partner corridor rule can override either threshold (`resolveCorridorRules`, `src/lib/compliance-config.ts`), so a partner's own figures may be lower or higher than these defaults.
- **cleared**: none of the above.

**Which screens store evidence.** One `sanctions.screen` audit row (actor `system:sanctions`) is written by:

- every mint, in the mint's transaction (a cleared, flagged or blocked mint commits it with its transfer row; a refusal after the screen, such as the send cap, rolls both back);
- the pay, confirm and crash-resume re-screens (`rescreenBeforePay`), with the status they set;
- the automatic list-hold re-screen and the staff or partner release re-screen (section 4, rules 3a and 5), in the decision's transaction;
- the paid-row heal (section 4, rule 3), only when it clears or finds a match;
- every payee screen (add, approve, and each payment-link payment) and every seller screen (the seller one is best-effort, after the seller row is committed, section 6);
- the WhatsApp card (quote-time) screen, only when it blocks (section 6).

Not stored: a card screen that clears or flags (the mint screens the transfer again, and the mint's row is the evidence of record); a re-screen that loses its guard (`moved`: the row changed concurrently, nothing is written); a list-hold re-screen that still finds no live list; a release re-screen of a row that is no longer in review; a paid-row heal that ends in review or is skipped.

The evidence (`src/lib/sanctions/evidence.ts`) holds the decision, the list source, version and hash, `listFitness`, `listCheckedAt`, `listBaseHash`, the time, and for each party its role, matched / possible flags, score, list entry id and a keyed `inputHash` of the screened name. **Evidence never holds a name**, a phone number or an amount. A party is identified only by role and keyed hash, and a list entry only by its id (`sdn:<uid>`, `mock:<i>`, `extra:<i>`).

Hold reasons are fixed generic strings (section 4, hold-reason registry). They never name the list, the entry or the person, and never use the word "sanctions". Customers see only the fixed texts of `src/lib/hold-replies.ts`.

## 3. Which list

`SANCTIONS_LIST` picks WHICH list is screened, never WHETHER:

- unset or `mock`: the mock screener (demo names only);
- `ofac-sdn`: the OFAC SDN list stored in Postgres by the daily loader (`src/lib/sanctions/list-loader.ts`), plus the extra names;
- any other value: the mock, and one warning in the log.

The list health check (`sanctionsListStatus`, `src/lib/sanctions/list-health.ts`, behind the compliance page card and the daily list health alert) also reports the list as not live when the active version's stored entries do not match its `entry_count` (screens cannot load it). The loader's next load of the same content re-inserts them (review R4, E5).

Switching production to `ofac-sdn` is an **owner step**. Fix pack 2 does not set `SANCTIONS_LIST`. Until the owner sets it, every real-money screen holds with `LIST_UNAVAILABLE` (the mock is never a live list), and the daily list health alert says so.

## 4. Fail-closed rules on real-money rails

**Real money** (`realMoneyRail`, `src/lib/live-gate.ts`): the rail partner (`railPartnerOf`: the settlement partner, else the owner) has payment provider type `http`, and the transfer environment is not `test`. A rail read that fails counts as real money. A sandbox (`test`) transfer is never real money. A non-http rail (simulator, mock, none) POSTs only to the hosted reference rail in this app (`settlementTargetUrl`), never to a partner's stored URL, so a demo rail cannot move money out.

**Live list** (`listFitness`, `src/lib/sanctions/list-policy.ts`): the screen used source `ofac-sdn`, a loaded version (not `unavailable` / `unloaded`), a non-empty hash, and a `checkedAt` no more than 36 hours old (`SANCTIONS_LIST_MAX_AGE_MS`). A `checkedAt` more than 5 minutes in the future (`LIST_CLOCK_SKEW_MS`) or missing counts as stale. Anything else is `stale` or `not_live`.

Rules:

1. **Mint and pay-time screens** (mint, pay, confirm, resume, payee, the list re-screen, the release re-screen and the paid-row heal) pass `requireLiveList` on real money. A screen that is not on a live list does not clear: it is `flagged` with `LIST_UNAVAILABLE`. The throw branch (the list cannot load at all) does the same. `LIST_UNAVAILABLE` keeps the `POSSIBLE_MATCH`, `LARGE_AMOUNT` and `VELOCITY` reasons next to it. A block still blocks.
2. **Settle-time backstop** (`settleOrHold`, `src/lib/settlement.ts`): on real money, if the newest `sanctions.screen` evidence for the transfer is not `liveFresh` (live, and screened within 36 h plus skew), the transfer is held with `LIST_UNAVAILABLE` instead of settling.
3. **Instruct gate** (`settlement.instruct` in `src/lib/outbox-worker.ts`, rule `instructGateRefuses` in `evidence-read.ts`): on real money, an instruct whose newest evidence carries a `listFitness` and is not `liveFresh` (or is a match) is not sent: one deduped `instructnotlive:<id>` ops alert, and an `InstructNotLiveError`, which is NOT a rail failure (no `railfail:` alert, no change to rail health or best-rate routing). The row stays retryable under the `settlement.instruct` policy (about a day: 56 attempts); when that runs out it is dead-lettered with the usual deduped `dead:` ops alert, and the stuck-paid sweep's one recovery re-instruction (`reinstruct:<id>`) passes the same gate. The reconcile stuck-paid sweep (paid for more than 15 minutes, a webhook-driven real-money rail, not under `settlement.paused`) heals it (`healPaidRowScreen`, `src/lib/list-hold-rescreen.ts`): once a live list is served it re-screens the paid row on file and records a clear screen (the next attempt is sent), records a match with its block notices, and in the same transaction, on the locked row still paid with no refund started, sets `compliance_status` to `blocked` with the matched reasons and raises one `paidmatch:<id>` alert that says the transfer is paid and charged, not instructed, and must follow the block and refund procedure; a row possibly instructed gets `paidmatchinstructed:<id>` instead, which says to recall it with the rail and confirm no payout before any refund (section 6) (either way the row stays `paid`, is listed as blocked on the compliance page, is never instructed or re-instructed on any rail, and the staff refund paths still claim it), or, for a possible match or a name it cannot screen again, records nothing and raises one `instructrescreen:<id>` alert (that row is not screened again; a person decides). While the list is not live the heal writes nothing and the gate keeps refusing. Evidence without `listFitness` (before pack 2), or no evidence, passes. The gate also refuses while the sender's screening hold is active (section 5), or when the flags cannot be read: one deduped `instructsenderhold:<id>` alert (ids only: the transfer is paid, the sender was charged, nothing was sent to the rail; a platform person clears the hold or refunds it) and an `InstructNotLiveError`; the ledger stays `paid` and the row stays retryable. This covers a row made paid without `settleOrHold` (a signed rail `funded` callback), the reinstruct and a dead-letter Retry. Before these checks, on every rail, an instruct for a row whose compliance status is `blocked` (the paid-row heal's match) finishes without a POST (a log line, no alert, no retry: its `paidmatch:<id>` alert owns the row), and the stuck-paid sweep never re-instructs such a row. It only ever stops a POST.
3a. **Staff or partner release** (`releaseTransfer`, `src/lib/dashboard-ops.ts`, for platform staff and for a delegated partner's admin, tenant-pinned): on real money, a hold whose newest evidence is not `liveFresh` (including no evidence, or evidence without `listFitness`) is re-screened on file first (`settlement.releaseHoldAfterRescreen`, one transaction with the row locked). It is released only on a live, fresh, clear, fully covered screen that adds no reason. Otherwise it stays held (with `LIST_UNAVAILABLE` when the list is not live, so the automatic sweep owns it, and a staff `transfer.rescreen` audit row) or is blocked with its notices. Partner staff get one fixed text for every outcome of this re-screen (`RESCREEN_RELEASE_REFUSAL`, "Cannot release: the sanctions re-screen at release did not clear this transfer."): it names no one and does not say which, so a match, a list outage, an uncovered name and a possible match look the same. Platform staff get a text per outcome class (`PLATFORM_RESCREEN_REFUSALS`), which says what to do and names no person and no list entry:
   - list not live: "Cannot release: the sanctions list is not live, so the re-screen at release could not clear this transfer. The system re-screens it automatically once the list is live again; it then returns to the review queue for a platform release." (the row now carries `LIST_UNAVAILABLE`, so a person's release is refused, rule 5; the row also keeps the reason it was held for, so the automatic re-screen drops `LIST_UNAVAILABLE` but does not release it, and a platform person releases it after that re-screen, review round 3, K2);
   - a review reason was added (a possible match, or a name that could not be screened again): "Cannot release yet: the sanctions re-screen at release added a review reason. Read the reasons on the compliance page, and release again only after that review.";
   - blocked: "Cannot release: the sanctions re-screen at release blocked this transfer." (never released). A later release click on a row whose compliance status is `blocked` is refused with the same text before any write (partner staff: the one partner text), review round 3, M3.

   A possible match or an uncovered name found here is never released automatically. Its new screen is live and fresh, so a second platform release takes the ordinary claim below without a new screen, and that click is the human review (owner decision for review R2, J2, listed in the PR). The rescreen-only check (rule 5) refuses before any screen. The sender hold (section 5) refuses platform staff before the re-screen, and again inside the release transaction, with the customer row locked right before the claim (a stamp that commits in between refuses); for partner staff the release action's pre-check refuses it, and the release claim checks it again inside the transaction. A hold whose newest evidence is already `liveFresh` is released by the ordinary claim without a new screen. Not real money: no re-screen.
4. **Coverage rule** (`uncoveredRoles`, `src/lib/sanctions/evidence-read.ts`): a real-money re-screen must screen again every name screened before, in the same role (matched by keyed `inputHash`). A role that cannot be screened again is never cleared or released automatically: it holds with `SENDER_IDENTITY_MISSING` (sender) or `POSSIBLE_MATCH` (recipient) for a platform person to decide (rule 3a: a platform release after that review may release it; partner staff cannot, as both reasons are platform-only).
5. **Lifting a list hold**: `LIST_UNAVAILABLE` is lifted only by the worker's automatic re-screen (`sweepListUnavailableHolds`, `src/lib/list-hold-rescreen.ts`, actor `system:list-rescreen`) once a live list is served. No person can release it (`isRescreenOnlyHold`; `releaseTransfer` refuses). Staff can still reject it. While the list is not live, the sweep re-screens only rows that need no live list (sandbox rows and non-http rails).
6. The **mint and pay gates are authoritative**. Any go-live or readiness view of the list is advisory only.
7. **Time budgets** (review F3). The re-screens inside `reconcileSweep` run on every full worker run, before the drain, so each is time-boxed by wall clock and never starts a row once its budget is spent; the rows left wait for the next run, unchanged:
   - the list-hold sweep: `LIST_RESCREEN_BUDGET_MS = 5_000`, and at most 25 decided rows (`LIST_RESCREEN_BATCH`) over at most 4 pages (`MAX_PAGES`) per run; when the budget stops it, it logs the count left (no names);
   - the paid-row heal (rule 3) and the crash-resume re-screen share one `RESCREEN_BUDGET_MS = 5_000` (`src/lib/reconcile.ts`). Only the time spent inside those re-screens (`healPaidRowScreen`, `rescreenOnFile`) counts against it, so the stuck-paid bookkeeping, however many rows, never spends it (review R2, E4). A paid row already blocked by the heal is not healed again (no read), and the heal's checks of whether a row needs a heal at all (`paidRowNeedsHeal`: the evidence read and the `instructrescreen:` check) run outside the budget too (review round 3, K3). Past it the heal is not started (the gate keeps refusing that row), and a charged row that needs a re-screen before it can settle is left untouched until the next run; a run that leaves any logs the counts (`reconcile.rescreen-deferred`, no id, no name).
   A slow run therefore delays a release or a heal; it never clears a row without a screen.

### Hold-reason registry (`HOLD_REASONS`, `src/lib/compliance-config.ts`)

| Reason constant | Class | Released by | Customer text |
|---|---|---|---|
| `POSSIBLE_MATCH_REASON` | screening | platform | hold |
| `LIST_UNAVAILABLE_REASON` | screening | rescreen (no person) | hold |
| `RECIPIENT_WATCHLIST_REASON` | screening | platform | block |
| `SENDER_WATCHLIST_REASON` | screening | platform | block |
| `SENDER_IDENTITY_MISSING_REASON` | screening | platform | hold |
| `SENDER_SCREENING_REASON` | screening | platform | hold |
| `LARGE_AMOUNT_REASON` | kyc | partner | hold |
| `VELOCITY_REASON` | kyc | partner | hold |
| `EDD_REQUIRED_REASON` | kyc | partner | hold |
| `AML_HOLD_REASON` | aml | platform | hold |

The strictest reason wins (rescreen, then platform, then partner). An empty list or a reason outside the registry counts as platform-only. "Partner" means a delegated partner's admin, and platform staff too.

## 5. Sender screening hold (R06)

A sender whose customer row has a watchlist or PEP hit, or a stamped `screeningFlaggedAt`, and no later `screeningClearedAt`, has an active hold (`senderScreeningHoldActive`; a tie counts as held). A KYC watchlist or PEP match stamps the flag in the same transaction (`kyc-case-store.ts`). A later match re-arms a cleared hold: the stamp time is read after the row lock, and the writer (`customer-repo.ts` `stampScreeningFlagged`) keeps it at least 1 ms after any clear on the locked row, so a match committed after a clear always sorts later.

On real-money rails only:

- the WhatsApp card refuses the send with the neutral text `cap_unavailable` (`sender_unavailable`), and the portal answers `portal.send.cannot_complete`;
- the mint and `settleOrHold` add `SENDER_SCREENING` to the hold (also on a row already flagged for another reason); the Partner-API confirm holds a flagged row through `settleOrHold` too. `settleOrHold`'s read is unlocked; the settle transaction (`beginSettlement`) then locks the transfer row and the customer row (in that order) and re-reads the flags before the paid flip, so a stamp that committed after the first read holds the row (`in_review`, `SENDER_SCREENING`, no instruct) instead of paying it (review round 3, M1);
- the instruct gate does not send a paid row of such a sender (section 4, rule 3). Its read is unlocked: it is the backstop for a row made paid without these checks, not a locked re-read;
- the automatic list re-screen does not release the row; its release transaction re-reads the flags with the customer row locked after the transfer row (review round 3, M1);
- platform staff cannot release the transfer while the sender hold is active (`Cannot release: clear the sender screening hold first.`); the release transaction re-reads the flags with the customer row locked before the claim.

On every rail, partner staff (a delegated partner's admin) can neither release nor reject a held transfer of such a sender, nor decide the sender's KYC (`isScreeningCustomerHold`, `src/lib/compliance-config.ts`). For them the hold is: a watchlist or PEP hit, OR a stamped `screeningFlaggedAt` that no later `screeningClearedAt` covers (a tie counts as held). The stamp counts even when a stale whole-row save has nulled the booleans. The release and reject claims check the same rule inside their transaction (`senderClearForPartnerRelease`, `src/db/repos/transfer-repo.ts`; a test runs the TypeScript and SQL rules on the same cases), so a flag raised after the page loaded still refuses. A platform clear lifts the stamp only: while a PEP or watchlist boolean is still set, partner staff stay refused and platform staff decide.

Only SmartRemit platform admins clear it (`clearSenderScreeningHoldAction`, `src/app/admin-dashboard/customers/actions.ts`), with a typed reason, under either `kycMode` (`platform` or delegated) and in any KYC status. One transaction writes the clear time and the `customer.screening_hold.clear` audit row. The form posts the flag time the page showed; under the row lock the action refuses ("The screening for this customer changed since this page loaded. Reload the page and review it again.", nothing written, no audit row) unless the locked flag time is that one, so only the match the admin reviewed is cleared. The clear time is taken after the lock and kept at least 1 ms after the locked flag time (`clearScreeningHold`). The Persona flags stay as evidence. Clearing does not release held transfers: staff release them afterwards. The customer page's Screening row and the advisory KYC prompt read the same rule (`senderScreeningLabel`): a stamped, uncleared hold whose booleans are null shows as a screening hold, never as clear.

## 6. Block notices (R04)

A block writes one `sanctions.block` audit row and its notices (`enqueueSanctionsBlockNotices`, `src/lib/sanctions/notices.ts`). Stages: `card`, `mint`, `pay`, `confirm`, `resume`, `hold_rescreen`, `payee`, `seller`.

Atomic with the block: for `mint`, `pay`, `confirm`, `resume` (the crash-resume re-screen), `hold_rescreen` (the list-hold sweep and the release re-screen), `card` (when the blocked row is recorded) and the payee add, the audit row and the notices commit in the same transaction as the blocked status (or the refusal) and its evidence. The exceptions:

- **seller**: the seller row is committed first, already in review (`needs_review`). The evidence, the audit row and the notices follow in a second, best-effort transaction. If that one fails, only a `sanctions.evidence-lost` log line remains (no audit row, no ops alert, no email); the seller stays in review.
- **payee approve**: the evidence and the notices commit in their own transaction BEFORE the rejection is written in a second one. If the payee changed concurrently, the approval answers `not_allowed` and the notices stand for a payee this call did not reject. At a payment-link payment the evidence and notices commit together and the payment is then refused (no status to change).
- **card**: two attempts, each its own transaction (blocked row, evidence and notices together). If both fail, nothing is recorded: one `sanctions-block-unrecorded:<partner>:<hour>` ops alert is raised (ids only; if that also fails, a log line). The customer is refused either way.
- **paid-row heal** (stage `resume`, section 4 rule 3): the evidence, the notices (their text says the recipient was not paid and the sender was charged) and, when the locked row is still paid with no refund started, `compliance_status` `blocked` and the `paidmatch:<id>` alert commit together. The status stays `paid` (the sender was charged): the instruct never sends it and staff refund it. A row that moved meanwhile (cancelled, refunding) gets the evidence and notices only. Review round 3 (K1): the heal decides on the locked row whether the transfer was possibly instructed: it has a rail reference (`payment_provider_ref`), or a `settlement.instruct` row for it (the first `instruct:` or the `reinstruct:`) was claimed at least once (`attempts > 0`, which also counts a POST that timed out without a reference) or is done. Such a row is blocked too (never instructed again), but it gets one `paidmatchinstructed:<id>` alert instead of `paidmatch:<id>`, and notices that say the payout may be in progress with the rail; nothing it sends says the recipient was not paid. Ops contact the rail to stop or recall the payout and confirm with the rail that no payout happened before any refund, then follow the block procedure. Nothing a customer sees changes.
- The list-hold sweep's block also raises a second, older ops alert (`listrescreenblock:<id>`); its copy says whether the sender was charged (section 11).
- **Charged copy** (review round 3, M2): the crash-resume re-screen (`resume`), the release re-screen and the list-hold sweep (`hold_rescreen`) pass `charged` from the row (`senderWasCharged`, `src/lib/funding-method.ts`: a charge reference and not a partner-pulled `ach_pull` / `bank_pull` method), so a charged row's ops alert and partner email say the sender was charged and to follow the block and refund procedure; an uncharged row keeps "nothing paid out".

Who is told:

- **Quiet** = not real money AND (a sandbox row OR every matched entry is a demo `WATCHLIST` name). A quiet block writes the audit row only.
- **Not quiet**: one deduped `ops.alert` (`sanctionsblock:<id>`) and one `email.send` (`sanctionsblockmail:<id>:<partner>`) to each distinct non-default partner among the owner and the rail partner that has an address (`complianceAlertEmail`, else `alertEmail`). The licensed rail partner carries the blocking-report duty, so a routed block on the default owner still emails the rail partner.
- Ids only: no name, phone, amount or list entry id in a payload or in the audit meta.

## 7. List archive (R07)

Every list version is archived before its entries leave the database (`archivePending`, `src/lib/sanctions/list-archive.ts`).

Where it runs: the daily cron (`src/app/api/cron/route.ts`), only while `SANCTIONS_LOADER_ENABLED` is on, in this order: the list load, then the list health check (always, loader on or off), then the archive, then the worker poke. The archive is time-boxed: a total budget of at most `ARCHIVE_BUDGET_MS = 150_000` (less when the function's `maxDuration` of 300 s, minus a 20 s tail and a 10 s grace, leaves less), and no version is started with less than twice `OBJECT_TIMEOUT_MS` (60 s, `src/lib/blob.ts`) left. The route stops waiting at the budget plus the grace and logs it, so a hung store or database never costs the health check or the poke. Versions left over (`deferred`) are archived by a later run; until then they keep their entries.

The rules:

- Path: `sanctions-archive/<source>/<version>-<hash>.jsonl.gz` in the PRIVATE Blob store (content-addressed, no suffix, no overwrite).
- Two hashes: the **list hash** is the sha256 of the canonical lines (`canonicalLines`), which must equal the version's stored hash before upload and after a read-back; **`archive_sha256`** is the sha256 of the stored gzip bytes, stamped on the version row with the path and `archived_at`.
- The row is stamped only after a verified read-back. A put that fails because the object exists goes to the read-back: a verified object heals a crashed run.
- `KEEP_INACTIVE_VERSIONS = 2`: the entries (never the version row) of inactive versions older than the newest two are pruned, and only once that version has a stamped archive. Re-activating a pruned version re-inserts its entries.
- A version stored from a list with a repeated uid (its stored entries do not hash to the version hash): never archived, never pruned, and one `sanctions-archive-mismatch:<source>:<day>` ops alert per source per day, which says a person must act (the next run will not repair it). It does not hold the oldest-first queue: the run reads past it and still attempts up to `MAX_ARCHIVES_PER_RUN` (3) other versions (review R4, H3). This fails safe: the entries stay in the database. Other failures (a put or read-back that does not verify) raise `sanctions-archive-failed:<source>:<day>` and are retried by the next run.
- Manual restore: `readArchivedVersion(path)` returns the gunzipped canonical lines (or null for a path outside `sanctions-archive/`).
- The Blob put is the documented exception to the outbox rule: it is idempotent, verified by read-back, and healed by the next run.

## 8. Retention

Proposed: keep screening evidence (`sanctions.screen`, `sanctions.block` audit rows) and every archived list version for 5 years. Counsel to confirm. Nothing deletes `sanctions-archive/` objects today.

## 9. Known gaps

Recorded on purpose. Owner question 2 accepts the match gaps for now; R08 (fix pack 5) tunes matching.

- **Match quality** (fixture cases tagged `known_gap`): a vowel change in a short first token misses review (fixture: Mohammed / Muhammad Samir, 0.864); a split article on a two-token listing misses review (fixture `abdul-rahman-bare`: Abd al-Rahman against a listed Abdul Rahman, 0.870, cleared today; the same spelling pair reaches review only next to an extra shared given name, fixture `abdul-rahman`, 0.927); an added middle name misses review (fixture: 0.883); Cyrillic against a Latin listing (or the reverse) never matches, because nothing is transliterated (fixture: 0.383). Scores depend on the other tokens of the name: the same pair with a different given name can land on either side of 0.90.
- **False positive**: a short name one letter off a listed short name reaches review (fixture: Testo / Testa, 0.920).
- **Partner-API sender names** in the request body are not stored (R03, pack 4). A later real-money re-screen cannot screen that name again, so it goes to a person (`SENDER_IDENTITY_MISSING`), never a silent clear.
- **B2B pay** has no pay-time re-screen. Only the settle-time evidence backstop (section 4, rule 2) applies.
- **Pre-PR2 rows**: an in-flight instruct of a row screened before fix pack 2 (no `listFitness` in its evidence, or no evidence at all) is not list-gated by the instruct gate. A staff or partner release of such a held row on real money does re-screen it (section 4, rule 3a).
- **Velocity** of a `LIST_UNAVAILABLE` row held before the deploy cannot be re-derived by the re-screen.
- **List-hold sweep order**: the sweep always starts at the oldest held rows, so rows behind enough rows whose re-screen throws on every run wait; each run that has such a row raises one `listsweeperror:<hour>` ops alert with the count only, so a person can fix the cause (review R4, E6).
- **One list only**: OFAC SDN. No UN, EU, UK or other list yet (R08, pack 5).

## 10. Changes after independent review (fix pack 2)

An independent review of fix pack 2 confirmed these findings (D4 was refuted); each confirmed one is fixed in the pack, as described above:

- **A1**: the instruct gate refuses a screen that carries a `listFitness` and is not live or is older than 36 h (no evidence, or evidence written before pack 2, still passes: section 4 rule 3, section 9); a staff or partner release re-screens unless the newest screen is live and under 36 h old (section 4, rule 3a); the stuck-paid sweep heals a refused paid row.
- **A2 / B1**: an uncleared screening stamp now refuses partner staff (release, reject, KYC decisions), in the pre-checks and inside the claim (section 5).
- **A4**: the evidence reader reads the transfer's `sanctions.screen` rows through their own query, with no row cap and no other audit action in it, so the newest screen is the one checked.
- **C1**: a not-live instruct refusal is an `InstructNotLiveError`, not a rail failure: no `railfail:` alert, no change to rail health or routing (section 4, rule 3).
- **C2**: the list-hold sweep and the reconcile re-screens are time-boxed (section 4, rule 7).
- **C3**: the cron runs the list health check before the archive, and the archive is time-boxed (section 7).
- **C4**: `docs/ROLLBACK.md` says what a rollback past pack 2 after a prune needs, and what rolling forward does and does not repair.
- **D1**: section 6 names the block paths whose audit row and notices are not atomic with the block (seller, payee approve, an unrecorded card block, the paid-row heal).
- **D2**: section 2 lists which screens store evidence and which do not.
- **D3**: the split-article miss is a `known_gap` fixture case (`abdul-rahman-bare`, 0.870) and is named in section 9.
- **D4**: refuted by the second reviewer (the hosted rail refuses a non-simulator partner); no change.
- **D5**: the component map (`.claude/hooks/components.json`) gives `live-gate.ts`, `list-hold-rescreen.ts` and `sanctions/` to compliance-kyc; `docs/compliance/` stays shared.
- **D6**: section 2 gives the LARGE_AMOUNT and VELOCITY figures as defaults a corridor rule can override.

### Changes after review round 2

A second independent review confirmed more findings (E6 was rated uncertain and fixed anyway; E1 and E3 were refuted). Each confirmed one is fixed in the pack, as described above:

- **E1**: refuted, no change of its own. A second platform release after a release re-screen that added `POSSIBLE_MATCH` or `SENDER_IDENTITY_MISSING` is the human review of an ordinary platform-only hold, the same state as a possible match found at mint; partner staff stay refused (section 4, rules 3a and 4; the refusal texts came with J2).
- **E2**: a paid-row heal that finds a match blocks the row (`compliance_status` `blocked`, status still `paid`) and raises `paidmatch:<id>`; its notices say the sender was charged; the instruct and the reinstruct never send a blocked row (section 4, rule 3; section 6).
- **E3**: refuted, no change. A paid row whose heal re-screen is a possible match or an uncovered name gets no evidence and one `instructrescreen:<id>` alert, is not screened again, and leaves only by a refund. That is the chosen fail-closed outcome: fresh live evidence of an unreviewed possible match would let the gate send it, and money never moves on an old or unreviewed screen (section 4, rule 3). A later feature may route such a row back to review.
- **E4**: the reconcile re-screen budget counts only the time spent inside the paid-row heal and the crash-resume re-screen, so the stuck-paid bookkeeping never spends it; a run that defers a re-screen logs the counts (section 4, rule 7).
- **E5**: an active version whose stored entries do not match its `entry_count` is not live on the list health check, and the same content's next load re-inserts the entries (section 3; `docs/ROLLBACK.md`).
- **E6**: re-screens that throw in the list-hold sweep raise one hourly `listsweeperror:<hour>` alert with the count; the oldest-first order stays (section 9).
- **G1**: the instruct gate refuses a paid row whose sender has an active screening hold, or whose flags cannot be read (section 4, rule 3).
- **G2**: the Partner-API confirm holds a flagged row through `settleOrHold`, with the same added reasons as every other entry point (section 5).
- **H1**: the platform clear posts the flag time the page showed and refuses under the row lock unless it is the locked flag time; the stamp and the clear take their order from the locked row (each kept at least 1 ms after the other), not from a clock; the customer page and the KYC prompt show a stamp-only hold (section 5).
- **H2**: the platform release re-checks the sender hold inside its transaction, with the customer row locked right before the claim (section 4, rule 3a; section 5).
- **H3**: a version that cannot archive (a mismatch) no longer holds the archive queue; it has its own alert, which says a person must act (section 7).
- **J1**: tests only: a partner release through the re-screen claim (a stamp-only sender is refused by the claim; another tenant's id changes nothing).
- **J2**: owner decision taken as the recommended answer (listed in the PR): a possible match or an uncovered name found by the release re-screen holds for a platform person; partner staff keep one refusal text for every outcome, platform staff get one text per outcome class; a second platform release is the human review (section 4, rules 3a and 4).
- **J3**: the A1 line above states the instruct gate's pass-through for rows screened before pack 2; `tests/sanctions-spec-truth.test.ts` pins that line, this list and the alert table (section 11).
- **J4**: tests only: a second sweep does not block a heal match twice; the heal does not run off real money (simulator, sandbox); the `instructrescreen` payload is ids only; a gate refusal at the instruct's attempt ceiling is dead-lettered with no `railfail:` alert; a release re-screen's possible match holds, and a second platform release releases it.
- **J5**: tests only: the archive alert test checks the names of both stored versions, and a store error that carries only an entry name is shown not to reach the alert.
- **J6**: tests only: the two Partner-API confirm tests assert that the confirm succeeded before they check what it settled.
- **J7**: tests only: the poke-coverage test lists `releaseHoldAfterRescreen` as a settlement helper, so its callers are checked for a worker poke.

## 11. Ops alerts and notices added by fix pack 2

Every alert below is one `ops.alert` outbox row with the payload `{ message }`, deduplicated on its key (a second enqueue with the same key adds nothing). Each text carries ids, counts, a reason class or the list version only: never a name, phone, amount or list entry id, and none reaches a customer. `<hour>` is the UTC hour number (milliseconds since the epoch divided by 3,600,000, rounded down); `<day>` is the Eastern calendar day. Keys of alerts that existed before the pack (`railfail:`, `dead:`, `recon:`, `fundblocked:`) are not listed.

| Key | Raised by | Text | Meaning, and what a person does |
|---|---|---|---|
| `instructnotlive:<id>` | the instruct gate (`outbox-worker.ts`), real money | «`transfer <id> (rail <rail>) is paid but was not instructed: <why> The reconcile sweep re-screens it once a live list is served; otherwise refund it.`» `<why>` is one of «`Last screen was a sanctions match.`», «`Last screen not on a live list.`», «`Last screen older than the list age limit.`» | A paid row was not sent: its newest screen is not live, is older than 36 h, or is a match (section 4, rule 3). Check the sanctions list card. Once the list is live the stuck-paid heal re-screens it: a clear sends it; otherwise `instructrescreen:` or `paidmatch:` follows. If the list stays down, refund it. |
| `instructsenderhold:<id>` | the instruct gate, real money | «`⚠️ SmartRemit ops: transfer <id> (partner <partner>, rail <rail>) is PAID (the sender was charged) but nothing was sent to the rail: <why> A platform person must clear the sender screening hold or refund the transfer.`» `<why>` is «`Sender under an active screening hold.`» or «`Sender screening hold could not be checked.`» | A paid row of a sender under a screening hold (or whose flags could not be read) was not sent (section 4, rule 3; section 5). A platform admin reviews the customer page and clears the hold (the instruct's next attempt sends it; once it is dead-lettered, a dead-letter Retry does) or refunds the transfer. For "could not be checked", check the database and the logs. |
| `instructrescreen:<id>` | the paid-row heal (`healPaidRowScreen`) | «`⚠️ SmartRemit ops: transfer <id> (partner <partner>) is paid but not instructed: its re-screen on a live list did not clear (a possible match or a name that cannot be screened again). It stays uninstructed; review it on the compliance page and refund it.`» | The heal found a possible match or a name it cannot screen again. The row is not screened again and is never sent (review E3). Review it on the compliance page and refund it. |
| `paidmatch:<id>` | the paid-row heal | «`⚠️ SmartRemit ops: transfer <id> (partner <partner>) is PAID and the sender was CHARGED, but it was not instructed: its re-screen on a live list is a sanctions match. It is now blocked and is never sent to the rail. Follow the block and refund procedure; evidence on the compliance page.`» | A charged, uninstructed paid row matched (section 6). It is blocked and listed as blocked on the compliance page. Follow the block and refund procedure (a staff refund still claims it). |
| `paidmatchinstructed:<id>` | the paid-row heal, for a row possibly instructed (review round 3, K1) | «`⚠️ SmartRemit ops: transfer <id> (partner <partner>) is PAID and the sender was CHARGED, and its re-screen on a live list is a sanctions match. An instruction was sent, or may have been sent, to the rail. Contact the rail now to stop or recall the payout, and confirm with the rail that no payout happened BEFORE any refund. It is now blocked, so it will never be instructed again; then follow the block procedure; evidence on the compliance page.`» | A charged paid row matched after it had a rail reference or a claimed or done instruct (section 6). It is blocked and never instructed again, but the rail may be paying it out. Contact the rail to stop or recall it; refund only after the rail confirms no payout happened; then follow the block procedure. |
| `sanctionsblock:<id>` | every block that is not quiet (`enqueueSanctionsBlockNotices`) | «`⚠️ SmartRemit ops: sanctions block (<stage>) on <id>, partner <partner>, <environment>. Nothing paid out; evidence on the compliance page.`» For a charged row (the paid-row heal; and, review round 3 M2, the crash-resume re-screen, the release re-screen and the list-hold sweep when `senderWasCharged` holds for the row: a charge reference and not a partner-pulled method): «`⚠️ SmartRemit ops: sanctions block (<stage>) on <id>, partner <partner>, <environment>. The recipient was not paid, but the sender was charged: follow the block and refund procedure; evidence on the compliance page.`» For the paid-row heal of a row possibly instructed: «`⚠️ SmartRemit ops: sanctions block (<stage>) on <id>, partner <partner>, <environment>. The sender was charged and the payout may be in progress with the rail: contact the rail to stop or recall it, and confirm with the rail that no payout happened before any refund; evidence on the compliance page.`» | A transfer, payee or seller was blocked at `<stage>` (section 6). Follow the block procedure: reject and refund a charged held row; the licensed partner files its blocking report. Never tell the customer. |
| `sanctionsblockmail:<id>:<partner>` | the same, an `email.send` row (not an ops alert) to each non-default owner or rail partner with an address | Subject «`SmartRemit: a transfer was stopped by sanctions screening`». Body «`Reference <id> (<stage>, <environment>) was stopped by sanctions screening; nothing was paid out. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.`» For a charged row (the same cases as above): «`Reference <id> (<stage>, <environment>) was stopped by sanctions screening after the sender was charged; nothing was paid out to the recipient. Follow your block and refund procedure. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.`» For the paid-row heal of a row possibly instructed: «`Reference <id> (<stage>, <environment>) was stopped by sanctions screening after the sender was charged. An instruction was sent, or may have been sent, to the rail, so the payout may be in progress with the rail: contact the rail now to stop or recall it, and confirm no payout happened before any refund. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.`» | The partner's notice of the same block. The partner follows its own procedure. |
| `sanctions-block-unrecorded:<partner>:<hour>` | the WhatsApp card screen (`tools.ts`) | «`⚠️ SmartRemit ops: a sanctions block for partner <partner> could not be recorded (no blocked row, evidence or notice). The customer was refused; check the database and the logs.`» | Both attempts to record a card-time block failed (section 6). The customer was refused. Check the database and the logs. |
| `sanctions-list-not-live:<day>` | the daily list health check (`checkSanctionsListHealth`), only while a partner is on an http rail; and a real-money mint held on a list that is not live (`transfer-create.ts`). The two share the key: the first that day wins | Daily: «`⚠️ SmartRemit ops: the sanctions list is not live (<fitness>; setting <setting>; OFAC SDN version <version>, last checked <age>). <n> partner(s) on a real-money rail hold every new transfer until it is. Check the sanctions list card on the compliance page and the loader.`» Mint: «`⚠️ SmartRemit ops: a real-money transfer was held because the sanctions list is not live (partner <partner>). Check the sanctions list card on the compliance page and the loader.`» | The list is not live (not set to `ofac-sdn`, not loaded, older than 36 h, or its stored entries do not match its count: section 3), so real-money screens hold with `LIST_UNAVAILABLE`. Fix the loader or the setting; the list-hold sweep releases what then clears. |
| `listrescreenblock:<id>` | the list-hold sweep (`releaseRescreenedHold`) | Sender charged (a charge reference and not a partner-pulled method, `senderWasCharged`, review round 3, M6): «`⚠️ SmartRemit ops: transfer <id> (partner <partner>) was held because the sanctions list was not live; the automatic re-screen on a fresh list found a sanctions match. It is charged, blocked by the re-screen, not paid out; reject and refund it.`» Otherwise: «`⚠️ SmartRemit ops: transfer <id> (partner <partner>) was held because the sanctions list was not live; the automatic re-screen on a fresh list found a sanctions match. It is blocked by the re-screen. Nothing was charged or paid out; reject it.`» | A `LIST_UNAVAILABLE` hold matched on its re-screen (it also gets `sanctionsblock:`). Reject it (Reject refunds a charged row). |
| `listsweeperror:<hour>` | the list-hold sweep | «`⚠️ SmartRemit ops: the sanctions list-hold re-screen failed for <n> held transfer(s) this run. They stay held (LIST_UNAVAILABLE), and transfers held behind them can wait too. Read the list-rescreen warnings in the logs and fix the cause; the sweep retries every worker run.`» | Re-screens threw this hour (section 9). Read the `list-rescreen` warnings and fix the cause. |
| `sanctions-archive-failed:<source>:<day>` | the list archive (`archivePending`) | «`⚠️ SmartRemit ops: the sanctions list archive failed for <n> <source> version(s) on <day>. Those versions keep their entries (nothing unarchived is pruned); the next daily cron retries. Check the sanctions list card on the compliance page and the logs.`» | A put or read-back did not verify (section 7). Nothing is pruned; the next run retries. Check the private Blob store and the logs if it repeats. |
| `sanctions-archive-mismatch:<source>:<day>` | the list archive | «`⚠️ SmartRemit ops: <n> <source> version(s) cannot be archived on <day>: their stored entries do not hash to the version hash. A person must act: the next run will not repair them. They keep their entries (never pruned) and later versions are still archived. Check the sanctions list card on the compliance page and the logs.`» | A stored version cannot be archived (section 7). Its entries stay. A person inspects that version and repairs or retires it; each daily run raises the alert again until then. |
| `sanctions-archive-unconfigured:<day>` | the list archive, when the private Blob store is not configured and a version waits | «`⚠️ SmartRemit ops: the sanctions list archive cannot run: the private partner-docs Blob store is not configured. <source> list versions are kept in the database (none is pruned) until it is.`» | Configure the private partner-docs Blob store. Until then nothing is archived or pruned. |
