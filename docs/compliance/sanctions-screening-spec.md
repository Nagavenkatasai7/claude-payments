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
- **flagged** (held for review): a possible match (`POSSIBLE_MATCH`), the list unavailable (`LIST_UNAVAILABLE`, section 4), a large amount (`LARGE_AMOUNT`, $1,000 or more in USD), velocity (`VELOCITY`, the sender already sent 5 or more times today), plus the EDD and AML holds applied elsewhere.
- **cleared**: none of the above.

Every screen writes one `sanctions.screen` audit row (actor `system:sanctions`) with the evidence (`src/lib/sanctions/evidence.ts`): the decision, the list source, version and hash, `listFitness`, `listCheckedAt`, `listBaseHash`, the time, and for each party its role, matched / possible flags, score, list entry id and a keyed `inputHash` of the screened name. **Evidence never holds a name**, a phone number or an amount. A party is identified only by role and keyed hash, and a list entry only by its id (`sdn:<uid>`, `mock:<i>`, `extra:<i>`).

Hold reasons are fixed generic strings (section 5). They never name the list, the entry or the person, and never use the word "sanctions". Customers see only the fixed texts of `src/lib/hold-replies.ts`.

## 3. Which list

`SANCTIONS_LIST` picks WHICH list is screened, never WHETHER:

- unset or `mock`: the mock screener (demo names only);
- `ofac-sdn`: the OFAC SDN list stored in Postgres by the daily loader (`src/lib/sanctions/list-loader.ts`), plus the extra names;
- any other value: the mock, and one warning in the log.

Switching production to `ofac-sdn` is an **owner step**. Fix pack 2 does not set `SANCTIONS_LIST`. Until the owner sets it, every real-money screen holds with `LIST_UNAVAILABLE` (the mock is never a live list), and the daily list health alert says so.

## 4. Fail-closed rules on real-money rails

**Real money** (`realMoneyRail`, `src/lib/live-gate.ts`): the rail partner (`railPartnerOf`: the settlement partner, else the owner) has payment provider type `http`, and the transfer environment is not `test`. A rail read that fails counts as real money. A sandbox (`test`) transfer is never real money. A non-http rail (simulator, mock, none) POSTs only to the hosted reference rail in this app (`settlementTargetUrl`), never to a partner's stored URL, so a demo rail cannot move money out.

**Live list** (`listFitness`, `src/lib/sanctions/list-policy.ts`): the screen used source `ofac-sdn`, a loaded version (not `unavailable` / `unloaded`), a non-empty hash, and a `checkedAt` no more than 36 hours old (`SANCTIONS_LIST_MAX_AGE_MS`). A `checkedAt` more than 5 minutes in the future (`LIST_CLOCK_SKEW_MS`) or missing counts as stale. Anything else is `stale` or `not_live`.

Rules:

1. **Mint and pay-time screens** (mint, pay, confirm, resume, payee, and the list re-screen) pass `requireLiveList` on real money. A screen that is not on a live list does not clear: it is `flagged` with `LIST_UNAVAILABLE`. The throw branch (the list cannot load at all) does the same. `LIST_UNAVAILABLE` keeps the `POSSIBLE_MATCH`, `LARGE_AMOUNT` and `VELOCITY` reasons next to it. A block still blocks.
2. **Settle-time backstop** (`settleOrHold`, `src/lib/settlement.ts`): on real money, if the newest `sanctions.screen` evidence for the transfer is not `liveFresh` (live, and screened within 36 h plus skew), the transfer is held with `LIST_UNAVAILABLE` instead of settling.
3. **Instruct gate** (`settlement.instruct` in `src/lib/outbox-worker.ts`, rule `instructGateRefuses` in `evidence-read.ts`): on real money, an instruct whose newest evidence carries a `listFitness` and is not `liveFresh` (or is a match) is not sent: one deduped `instructnotlive:<id>` ops alert, and an `InstructNotLiveError`, which is NOT a rail failure (no `railfail:` alert, no change to rail health or best-rate routing). The row stays retryable under the `settlement.instruct` policy. The reconcile stuck-paid sweep heals it (`healPaidRowScreen`, `src/lib/list-hold-rescreen.ts`): once a live list is served it re-screens the paid row on file and records a clear screen (the next attempt is sent), records a match with its block notices (the gate keeps refusing), or, for a possible match or a name it cannot screen again, records nothing and raises one `instructrescreen:<id>` alert. Evidence without `listFitness` (before pack 2), or no evidence, passes. It only ever stops a POST.
3a. **Staff release** (`releaseTransfer`, `src/lib/dashboard-ops.ts`): on real money, a hold whose newest evidence is not `liveFresh` (including no evidence, or evidence without `listFitness`) is re-screened on file first (`settlement.releaseHoldAfterRescreen`, one transaction). It is released only on a live, fresh, clear, fully covered screen that adds no reason. Otherwise it stays held (with `LIST_UNAVAILABLE` when the list is not live, so the automatic sweep owns it) or is blocked with its notices, and the caller gets one fixed text (`RESCREEN_RELEASE_REFUSAL`) that names no one and does not say which.
4. **Coverage rule** (`uncoveredRoles`, `src/lib/sanctions/evidence-read.ts`): a real-money re-screen must screen again every name screened before, in the same role (matched by keyed `inputHash`). A role that cannot be screened again is never cleared or released: it holds with `SENDER_IDENTITY_MISSING` (sender) or `POSSIBLE_MATCH` (recipient).
5. **Lifting a list hold**: `LIST_UNAVAILABLE` is lifted only by the worker's automatic re-screen (`sweepListUnavailableHolds`, `src/lib/list-hold-rescreen.ts`, actor `system:list-rescreen`) once a live list is served. No person can release it (`isRescreenOnlyHold`; `releaseTransfer` refuses). Staff can still reject it.
6. The **mint and pay gates are authoritative**. Any go-live or readiness view of the list is advisory only.

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

A sender whose customer row has a watchlist or PEP hit, or a stamped `screeningFlaggedAt`, and no later `screeningClearedAt`, has an active hold (`senderScreeningHoldActive`; a tie counts as held). A KYC watchlist or PEP match stamps the flag in the same transaction (`kyc-case-store.ts`). A later match re-arms a cleared hold.

It applies on real-money rails only:

- the WhatsApp card refuses the send with the neutral text `cap_unavailable` (`sender_unavailable`), and the portal answers `portal.send.cannot_complete`;
- the mint and `settleOrHold` add `SENDER_SCREENING` to the hold (also on a row already flagged for another reason);
- the automatic list re-screen does not release the row;
- platform staff cannot release the transfer while the sender hold is active (`Cannot release: clear the sender screening hold first.`).

Only SmartRemit platform admins clear it (`clearSenderScreeningHoldAction`, `src/app/admin-dashboard/customers/actions.ts`), with a typed reason, under either `kycMode` (`platform` or delegated) and in any KYC status. One transaction writes the clear time and the `customer.screening_hold.clear` audit row. The Persona flags stay as evidence. Clearing does not release held transfers: staff release them afterwards.

## 6. Block notices (R04)

Every block writes one `sanctions.block` audit row in the same transaction as the block (`enqueueSanctionsBlockNotices`, `src/lib/sanctions/notices.ts`). Stages: `card`, `mint`, `pay`, `confirm`, `resume`, `hold_rescreen`, `payee`, `seller`.

- **Quiet** = not real money AND (a sandbox row OR every matched entry is a demo `WATCHLIST` name). A quiet block writes the audit row only.
- **Not quiet**: one deduped `ops.alert` (`sanctionsblock:<id>`) and one `email.send` (`sanctionsblockmail:<id>:<partner>`) to each distinct non-default partner among the owner and the rail partner that has an address (`complianceAlertEmail`, else `alertEmail`). The licensed rail partner carries the blocking-report duty, so a routed block on the default owner still emails the rail partner.
- Ids only: no name, phone, amount or list entry id in a payload or in the audit meta.

## 7. List archive (R07)

Every list version is archived before its entries leave the database (`archivePending`, `src/lib/sanctions/list-archive.ts`, run from the list cron):

- Path: `sanctions-archive/<source>/<version>-<hash>.jsonl.gz` in the PRIVATE Blob store (content-addressed, no suffix, no overwrite).
- Two hashes: the **list hash** is the sha256 of the canonical lines (`canonicalLines`), which must equal the version's stored hash before upload and after a read-back; **`archive_sha256`** is the sha256 of the stored gzip bytes, stamped on the version row with the path and `archived_at`.
- The row is stamped only after a verified read-back. A put that fails because the object exists goes to the read-back: a verified object heals a crashed run.
- `KEEP_INACTIVE_VERSIONS = 2`: the entries (never the version row) of inactive versions older than the newest two are pruned, and only once that version has a stamped archive. Re-activating a pruned version re-inserts its entries.
- A version stored from a list with a repeated uid (its stored entries do not hash to the version hash): never archived, never pruned, and one ops alert per source per day. This fails safe: the entries stay in the database.
- Manual restore: `readArchivedVersion(path)` returns the gunzipped canonical lines (or null for a path outside `sanctions-archive/`).
- The Blob put is the documented exception to the outbox rule: it is idempotent, verified by read-back, and healed by the next run.

## 8. Retention

Proposed: keep screening evidence (`sanctions.screen`, `sanctions.block` audit rows) and every archived list version for 5 years. Counsel to confirm. Nothing deletes `sanctions-archive/` objects today.

## 9. Known gaps

Recorded on purpose. Owner question 2 accepts the match gaps for now; R08 (fix pack 5) tunes matching.

- **Match quality** (fixture cases tagged `known_gap`): a vowel change in a short first token misses review (fixture: Mohammed / Muhammad Samir, 0.864); an added middle name misses review (fixture: 0.883); Cyrillic against a Latin listing (or the reverse) never matches, because nothing is transliterated (fixture: 0.383). Scores depend on the other tokens of the name: the same pair with a different given name can land on either side of 0.90.
- **False positive**: a short name one letter off a listed short name reaches review (fixture: Testo / Testa, 0.920).
- **Partner-API sender names** in the request body are not stored (R03, pack 4). A later real-money re-screen cannot screen that name again, so it goes to a person (`SENDER_IDENTITY_MISSING`), never a silent clear.
- **B2B pay** has no pay-time re-screen. Only the settle-time evidence backstop (section 4, rule 2) applies.
- **Pre-PR2 rows**: an in-flight instruct of a row screened before fix pack 2 (no `listFitness` in its evidence, or no evidence at all) is not list-gated by the instruct gate.
- **Velocity** of a `LIST_UNAVAILABLE` row held before the deploy cannot be re-derived by the re-screen.
- **One list only**: OFAC SDN. No UN, EU, UK or other list yet (R08, pack 5).
