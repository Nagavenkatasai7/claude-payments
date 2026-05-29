# P5: Per-corridor Compliance — Design

**Status:** design approved 2026-05-29. Awaiting spec review → implementation plan.

**Sub-project:** Platform-5 of the SendHome platform reshape (see memory `sendhome-platform-reshape`). Follows P1 (country/currency data model), P2 (partner entity), P3 (per-partner sub-admin auth, PR #10), P4 (multi-currency quote/transfer, `spec/p4-multi-currency`).

---

## Goal

Make compliance screening **per-corridor** (per source-country → IN) and **pluggable**. Today `screenTransfer` applies one global hardcoded ruleset — a single watchlist (`WATCHLIST`), one large-amount threshold (`LARGE_AMOUNT_USD = 1000`), one velocity limit (`VELOCITY_LIMIT = 3`) — to every transfer regardless of where the money originates. A US→IN corridor and a future GB→IN or AE→IN corridor have different sanctions lists, different reporting thresholds, and different velocity tolerances. P5 builds the capability for each corridor to carry its own rules, sourced from code-defined per-corridor **defaults** merged with an optional typed `Partner.corridorCompliance` override, and routes sanctions screening through a swappable `SanctionsScreener` interface (mirroring the existing `KycProvider` seam). Ship it **dormant**: every transfer today is US-source under the `default` partner, which has no override, so the resolved ruleset is byte-for-byte today's globals. When a real multi-corridor partner is onboarded, an admin (or future API) sets `corridorCompliance` — configuration only, no code change.

## The dormancy invariant (the thing every task protects)

> A US-source transfer under the `default` partner — i.e. every transfer in production today — is screened with the **exact** global rules of today's `compliance.ts`: `WATCHLIST = ['john doe', 'jane roe', 'test blocked']`, `LARGE_AMOUNT_USD = 1000`, `VELOCITY_LIMIT = 3`, same `ComplianceStatus` precedence (blocked > flagged > cleared), same `ComplianceResult.reasons` strings. Corridor rules apply **only** when a partner has an explicit `corridorCompliance[sourceCountry]` entry. The existing 425-test suite staying green is the executable proof.

This mirrors how P1–P4 shipped: working infrastructure, zero live customer-facing change by default.

## Locked design decisions (2026-05-29)

1. **P5 = per-corridor compliance config.** A corridor is a (source-country → `IN`) pair. Each corridor may carry its own watchlist, large-amount threshold (USD), velocity limit, and optional KYC-cap hints. The destination is always `IN` in v1, so a corridor is keyed by `CountryCode` source.
2. **Dormancy invariant (above).** US-only / `default` partner keeps today's GLOBAL hardcoded rules byte-for-byte. Corridor rules apply only when explicitly configured for a partner+corridor.
3. **Pluggable `SanctionsScreener` interface** (`src/lib/sanctions-provider.ts`) with a `MockSanctionsScreener` that wraps today's `WATCHLIST`. This is the seam a real provider (ComplyAdvantage / Sanctions.io) swaps into later. `screenTransfer` routes name screening through it. Mirrors the `KycProvider` / `MockKycProvider` pattern in `src/lib/providers/`.
4. **`screenTransfer` becomes corridor-aware:** it resolves the source country (from `sourceCurrency` via `countryForCurrency`, already exists from P4) and merges global defaults with any `partner.corridorCompliance[sourceCountry]` override.
5. **Rule management = code-defined per-corridor DEFAULTS + a typed `Partner.corridorCompliance` field for overrides** (set manually / via future API). Dashboard `/dashboard/compliance` gets a **READ-ONLY** per-corridor rules display. A full admin rule-creation UI is **DEFERRED** (out of scope).
6. **Migration: sentinel-guarded cron backfill** following the established pattern (`claimMigrationFlag`, sentinel `'corridor-compliance-backfill-v1'`), lazy-fill on read, NO write on read paths. The `default` partner is preserved byte-for-byte (no `corridorCompliance` written).
7. **KYC tiered data-capture is the NEXT batch, not P5** — but P5's `SanctionsScreener` interface is what that batch reuses (Core-ID / Travel-Rule screening will call the same seam). Stated in Sequencing / Out-of-scope.
8. **Conventions honored:** server-action security checklist; USD-equivalent accounting for all amount thresholds; bot stays partner-blind (`bot-content-guard`); no `as any`; defensive `?? ''` on any Redis-resident sort; `fakeRedis()` in tests; TDD per task; ISO country/currency codes.

---

## Architecture

```
createTransfer(store, input)            input already carries (P4):
  src/lib/transfer-create.ts              • sourceCurrency: CurrencyCode
        │                                  • partnerId: PartnerId
        │  sourceCountry = countryForCurrency(input.sourceCurrency)   ← P4 symbol
        │  partner       = partnerStore.getPartner(input.partnerId)   ← threaded in (P4)
        ▼
  resolveCorridorRules(partner, sourceCountry)      src/lib/compliance-config.ts
        │   CORRIDOR_DEFAULTS[sourceCountry] ?? GLOBAL_DEFAULTS        ← code-defined
        │   merged with  partner.corridorCompliance?.[sourceCountry]  ← optional override
        │   default partner + US-source + no override  →  GLOBAL_DEFAULTS (today's values)
        ▼   { watchlistExtra, largeAmountUsd, velocityLimit, ... }: ResolvedCorridorRules
        │
        ▼
  screenTransfer({ amountUsd, recipientName, transfersToday,          src/lib/compliance.ts
                   rules, screener })
        │
        ├── screener.screen({ name, sourceCountry })  ─────────────►  SanctionsScreener
        │       MockSanctionsScreener: WATCHLIST ∪ rules.watchlistExtra   (sanctions-provider.ts)
        │       → hit ⇒ status 'blocked'   (real provider swaps in here later)
        │
        ├── amountUsd >= rules.largeAmountUsd     → reason 'Large transfer amount.'
        └── transfersToday >= rules.velocityLimit → reason 'High transfer velocity.'
                                                   → 'flagged' | 'cleared'
        ▼
  ComplianceResult { status: ComplianceStatus, reasons: string[] }   ← unchanged shape

Dashboard (read-only):
  /dashboard/compliance/page.tsx ── lists each partner's resolved corridor rules
                                     (GLOBAL_DEFAULTS for default; merged for others)
```

For the dormant path (`default` partner, `sourceCurrency === 'USD'`, no `corridorCompliance`), `resolveCorridorRules` returns `GLOBAL_DEFAULTS` whose values are the literal constants from today's `compliance.ts`, and `MockSanctionsScreener` screens against exactly today's `WATCHLIST` — the math and the result collapse to today's.

---

## Components

### 1. The corridor-rule type + `Partner.corridorCompliance` — `src/lib/types.ts`

A typed, partner-resident override map keyed by source `CountryCode`. All fields optional so an override can tweak just one dimension (e.g. only the velocity limit on AE→IN).

```ts
// A single corridor's compliance configuration. Destination is always IN in v1,
// so the corridor is identified by its source country (the map key).
export interface CorridorComplianceRule {
  watchlistExtra?: string[];   // names appended to the screener's base list (lowercased on read)
  largeAmountUsd?: number;     // USD-equivalent flag threshold; overrides LARGE_AMOUNT_USD
  velocityLimit?: number;      // transfers/day before 'High transfer velocity.'; overrides VELOCITY_LIMIT
  kycCapHintUsd?: number;      // OPTIONAL advisory cap hint for the future KYC batch; NOT enforced in P5
}

export interface Partner {
  // ...existing fields (id, name, countries, status, brand*, createdAt, updatedAt)
  corridorCompliance?: Partial<Record<CountryCode, CorridorComplianceRule>>;  // NEW (P5) — optional override map
}
```

Notes:
- `corridorCompliance` is **optional**; `default` partner never gets it (dormancy).
- `kycCapHintUsd` is carried but **not read by `screenTransfer`** — it is the hook the next batch (KYC tiered capture) will consume. Documented as advisory-only.
- Keyed by `CountryCode` (ISO 3166-1 alpha-2). `IN` would be a no-op key (payout-side); resolver ignores `IN`.

### 2. Compliance-config resolver — `src/lib/compliance-config.ts` (new, pure, TDD'd)

The single authority that merges code-defined defaults with the partner override into a fully-resolved ruleset. No I/O — caller passes the already-loaded `Partner`.

```ts
import type { CountryCode, Partner } from './types';
import { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from './compliance';

export interface ResolvedCorridorRules {
  baseWatchlist: string[];     // the screener's base list (today's WATCHLIST)
  watchlistExtra: string[];    // corridor-specific additions (possibly empty)
  largeAmountUsd: number;      // USD-equivalent threshold
  velocityLimit: number;
  kycCapHintUsd?: number;      // advisory only (next batch)
}

// Today's globals, named so the dormant path is provably equal to current behavior.
export const GLOBAL_DEFAULTS: ResolvedCorridorRules = {
  baseWatchlist: WATCHLIST,
  watchlistExtra: [],
  largeAmountUsd: LARGE_AMOUNT_USD,   // 1000
  velocityLimit: VELOCITY_LIMIT,      // 3
};

// Code-defined per-corridor DEFAULTS. EMPTY at ship time (every entry === GLOBAL_DEFAULTS
// implicitly). Populated later as real corridors are calibrated. US is intentionally absent
// → falls through to GLOBAL_DEFAULTS → byte-for-byte today.
export const CORRIDOR_DEFAULTS: Partial<Record<CountryCode, Partial<ResolvedCorridorRules>>> = {};

export function resolveCorridorRules(
  partner: Partner | null,
  sourceCountry: CountryCode,
): ResolvedCorridorRules;
```

Merge order (later wins, field-by-field; `watchlistExtra` is concatenated, not replaced):
1. `GLOBAL_DEFAULTS`
2. `CORRIDOR_DEFAULTS[sourceCountry]` (code-defined corridor calibration)
3. `partner?.corridorCompliance?.[sourceCountry]` (partner override)

Notes:
- A `null` partner or a partner with no entry for `sourceCountry` ⇒ returns `GLOBAL_DEFAULTS` (or the corridor default if one exists). The `default` partner with `US` source ⇒ `GLOBAL_DEFAULTS`.
- Each numeric field uses `override.field ?? corridorDefault.field ?? GLOBAL_DEFAULTS.field`.
- `watchlistExtra` = `(corridorDefault.watchlistExtra ?? []).concat(override.watchlistExtra ?? [])`, defensively defaulting (`?? []`) since override data is Redis-resident.
- Pure function, no Redis, no `as any` — unit-tested with plain `Partner` literals.

### 3. `SanctionsScreener` interface + mock — `src/lib/sanctions-provider.ts` (new)

The pluggable seam, mirroring `src/lib/providers/kyc-provider.ts` + `mock-kyc-provider.ts`. A real provider (ComplyAdvantage / Sanctions.io) implements the same interface and is swapped in by changing one factory.

```ts
import type { CountryCode } from './types';

export interface SanctionsHit {
  matched: boolean;
  matchedName?: string;
  listSource?: string;   // e.g. 'mock-watchlist' | 'OFAC-SDN' (future)
}

export interface SanctionsScreener {
  // Synchronous-friendly contract: returns a Promise so a real (network) provider
  // can implement it without changing call sites. The mock resolves immediately.
  screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit>;
}
```

```ts
// src/lib/sanctions-provider.ts (same file or a providers/ sibling — plan chooses)
export class MockSanctionsScreener implements SanctionsScreener {
  // Wraps TODAY's logic: case-insensitive exact-match against a base list plus
  // any corridor watchlistExtra. Default base list = WATCHLIST.
  constructor(private readonly baseList: string[]) {}

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    const name = (input.name ?? '').trim().toLowerCase();   // defensive ?? '' (untrusted)
    const list = this.baseList.map((n) => n.trim().toLowerCase());
    const matched = list.includes(name);
    return matched
      ? { matched: true, matchedName: name, listSource: 'mock-watchlist' }
      : { matched: false };
  }
}

// Factory parallel to a future getKycProvider(); lets a real provider swap in later.
export function getSanctionsScreener(baseList: string[]): SanctionsScreener {
  return new MockSanctionsScreener(baseList);
}
```

Notes:
- The mock reproduces today's exact-match-lowercased-trim semantics, so the dormant blocked-name behavior is identical.
- `sourceCountry` is passed through (unused by the mock) so a real provider can scope its list by jurisdiction without a future signature change.
- Lives at `src/lib/sanctions-provider.ts` (top-level `lib`, like `kyc-provider`'s home under `providers/`); the plan may place it under `src/lib/providers/` to sit beside `kyc-provider.ts` — either is fine, follow whichever the plan picks consistently.

### 4. Corridor-aware `screenTransfer` — `src/lib/compliance.ts`

`screenTransfer` keeps its exported name and `ComplianceResult` return shape, but takes the resolved rules + a screener. To preserve the dormancy invariant **and** every existing test, the new parameters are **optional with today's defaults**: omitting them screens exactly as today.

```ts
export function screenTransfer(input: {
  amountUsd: number;          // USD-equivalent (unchanged; fed by quote.amountUsd)
  recipientName: string;
  transfersToday: number;
  rules?: ResolvedCorridorRules;     // NEW (P5) — defaults to GLOBAL_DEFAULTS
  screener?: SanctionsScreener;      // NEW (P5) — defaults to MockSanctionsScreener(rules.baseWatchlist ∪ extra)
}): Promise<ComplianceResult>;       // CHANGED: now async (screener.screen is a Promise)
```

Behavior:
- Resolve `rules = input.rules ?? GLOBAL_DEFAULTS`.
- Resolve `screener = input.screener ?? getSanctionsScreener([...rules.baseWatchlist, ...rules.watchlistExtra])`.
- `const hit = await screener.screen({ name: input.recipientName, sourceCountry })` — name screening goes through the seam. On `hit.matched` ⇒ `{ status: 'blocked', reasons: ['Recipient is on the compliance watchlist.'] }` (string unchanged).
- `amountUsd >= rules.largeAmountUsd` ⇒ push `'Large transfer amount.'`.
- `transfersToday >= rules.velocityLimit` ⇒ push `'High transfer velocity.'`.
- Reasons present ⇒ `'flagged'`, else `'cleared'`. Same precedence (blocked beats flagged beats cleared).

Async migration note: `screenTransfer` becoming `async` is the one breaking change. Its **only** caller is `transfer-create.ts` (`grep` confirms), which already `await`s in an async function — a one-line `await` addition. Existing `compliance.test.ts` cases call it directly; they get a mechanical `await` (the test-count delta below accounts for the rewrite). `sourceCountry` is passed in alongside `rules` (added to the input object) so the screener can scope.

### 5. Wiring through `transfer-create.ts` (the only call site)

`createTransfer` already has `input.sourceCurrency` and `input.partnerId` (P4). P5 threads the partner + resolved rules in:

```ts
// inside createTransfer, before screenTransfer:
const sourceCountry = countryForCurrency(input.sourceCurrency);              // P4 symbol, already used L52
const partner = await partnerStore.getPartner(input.partnerId);             // partnerStore threaded in (P4 pattern)
const rules = resolveCorridorRules(partner, sourceCountry);
const compliance = await screenTransfer({
  amountUsd: q.amountUsd,            // USD-equivalent — unchanged
  recipientName: input.recipientName,
  transfersToday,
  sourceCountry,
  rules,
});
```

Notes:
- `partnerStore` is added to `createTransfer`'s dependencies (it already receives `store`; P4 threaded `partnerStore` through the agent/tool context per the recent commits, so the wiring exists). If `createTransfer` does not yet take `partnerStore`, add it as a parameter — the cron path (`cron-run.ts`) and tool path both already have a `partnerStore` in scope.
- For the **dormant** path (`default` partner, USD source): `partner.corridorCompliance` is `undefined`, `CORRIDOR_DEFAULTS['US']` is absent ⇒ `rules === GLOBAL_DEFAULTS` ⇒ identical screening.
- Compliance still receives the **USD-equivalent** amount (`q.amountUsd`), honoring the USD-accounting convention.

### 6. Sentinel-guarded migration — `src/lib/migration.ts` + `src/app/api/cron/route.ts`

New sentinel `'corridor-compliance-backfill-v1'`, claimed via `store.claimMigrationFlag`, wired into the cron chain after `backfillSourceAmountsOnce`.

```ts
const CORRIDOR_COMPLIANCE_SENTINEL_KEY = 'corridor-compliance-backfill-v1';

export async function backfillCorridorComplianceOnce(
  store: Store,
  partnerStore: PartnerStore,
): Promise<{ partnersTouched: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(CORRIDOR_COMPLIANCE_SENTINEL_KEY);
  if (!claimed) return { partnersTouched: 0, skippedSentinel: true };

  // corridorCompliance is OPTIONAL — there is nothing to fill on the dormant path.
  // listPartners() returns lazy-filled records; re-saving persists any lazy fill
  // WITHOUT introducing a value (the spread preserves undefined). The 'default'
  // partner is re-saved byte-for-byte: no corridorCompliance key is added.
  let partnersTouched = 0;
  for (const p of await partnerStore.listPartners()) {
    await partnerStore.savePartner({ ...p, updatedAt: new Date().toISOString() });
    partnersTouched++;
  }
  return { partnersTouched, skippedSentinel: false };
}
```

- **No write on read paths.** The cron pass is the only writer. `partnerStore.getPartner` may lazy-tolerate a missing `corridorCompliance` (it is optional — no fill needed; reads simply treat `undefined` as "no override").
- **`default` preserved byte-for-byte:** since `corridorCompliance` is never set, the spread leaves the record identical except `updatedAt`. (If even `updatedAt` churn is undesirable for `default`, the plan may skip re-saving partners with no corridor data — the field being optional means there is literally nothing to backfill, so this migration is essentially a no-op placeholder that reserves the sentinel slot and the pattern.)
- Wire into `cron/route.ts`: add `const corridorComplianceBackfill = await backfillCorridorComplianceOnce(store, partnerStore);` and include it in the JSON response (`corridorComplianceBackfill // NEW (P5)`).

### 7. Read-only per-corridor rules display — `src/app/dashboard/compliance/page.tsx`

Add a card that, for each in-scope partner, renders its **resolved** corridor rules so staff can see what is actually enforced. Read-only; no mutation, no server action.

- The page already calls `requireScope()` and `createScopedStore(staff)`. Add `partnerStore.listPartners()` (scoped: a sub-admin sees only their partner; a global admin sees all — mirror existing scope handling).
- For each partner, for each of its `countries` that is a send-side country (skip `IN`), compute `resolveCorridorRules(partner, country)` and render a row: corridor (`US → IN`), large-amount threshold (USD), velocity limit, watchlist size (`baseWatchlist.length + watchlistExtra.length`), and any `watchlistExtra` names as `sh-pill sh-pill-danger` pills (reusing the existing watchlist pill styling).
- The existing global Watchlist card stays (it shows `GLOBAL_DEFAULTS`'s base list). The new card layers corridor-specific additions on top.
- Sub: "Resolved compliance rules per corridor (read-only). Full rule-creation UI is deferred." — sets expectation that this is display-only.
- Defensive `?? ''` / `?? []` on any Redis-resident value used in a `.sort()` or `.map()` (override data is partner-resident JSON).

---

## Security notes

- **Override data is untrusted at rest.** `corridorCompliance` arrives via a future API / manual Redis edit, not the bot — but the resolver and screener still treat its strings defensively (`?? ''`, `?? []`, lowercased/trimmed before compare). No `corridorCompliance` value ever reaches the bot.
- **Server-side enforcement only.** `resolveCorridorRules` + `screenTransfer` run inside `createTransfer` on the server; the LLM never sees or sets a threshold. The recipient name fed to the screener is the same server-validated value used today. A partner can only ever *tighten or document* its own corridors via its own `Partner` record — `partnerId` comes from the route/owning-customer (P4), never a body field, per the server-action security checklist.
- **Bot stays partner-blind.** P5 adds no bot-facing surface. Corridor rules, thresholds, and partner identity never enter the prompt or tool output. Add a `bot-content-guard` test asserting no P5 string (e.g. a corridor watchlist name, the word `corridor`) can leak into bot content — same guard P2/P4 extended.
- **Read-only dashboard.** The compliance display has no server action; there is no public POST to harden in P5. When the rule-creation UI lands (deferred), each mutating action must follow the full server-action security checklist (own `requirePlatformAdmin`/`requireScope`, entity-in-scope check, collision check before `savePartner`'s unconditional SET, route-authoritative `partnerId`).

## Testing strategy

Per-component focus (TDD, `fakeRedis()` where Redis is involved):

- **`compliance-config.test.ts` (new, ~10 cases):** `resolveCorridorRules(null, 'US') === GLOBAL_DEFAULTS`; default partner + US ⇒ `GLOBAL_DEFAULTS`; partner override replaces a single numeric field while inheriting the rest; `watchlistExtra` is concatenated not replaced; `CORRIDOR_DEFAULTS` layered under a partner override; `IN` key ignored; missing/`undefined` `corridorCompliance` ⇒ globals; numeric `0` override honored (use `??` not `||`).
- **`sanctions-provider.test.ts` (new, ~6 cases):** mock matches a base-list name case-insensitively/trimmed; no match ⇒ `{ matched: false }`; `watchlistExtra` name matches; empty/whitespace name ⇒ no match (defensive `?? ''`); `listSource` populated on hit; `sourceCountry` accepted and ignored without error.
- **`compliance.test.ts` (rewrite to async, ~8 cases):** **dormant proof** — `screenTransfer` with no `rules`/`screener` reproduces today's blocked/flagged/cleared exactly for `WATCHLIST` names, `>= 1000`, `>= 3`; corridor override raises `largeAmountUsd` so a $1,200 transfer that is flagged-today becomes cleared under the override; corridor `watchlistExtra` blocks a name not in the global list; `velocityLimit` override changes the flag boundary.
- **`transfer-create.test.ts` (extend):** `default`/USD path still produces today's `complianceStatus`/`complianceReasons` (regression); a partner with a corridor override produces the overridden screening; compliance still fed `q.amountUsd` (USD-equivalent); `await screenTransfer` wired.
- **`migration.test.ts` (extend):** sentinel claimed once (idempotent); `default` partner re-saved with **no** `corridorCompliance` key (byte-for-byte except `updatedAt`); a partner with an existing override is preserved by the spread.
- **`bot-content-guard.test.ts` (extend):** corridor data / `corridor` / a watchlist name never appears in bot content.
- **Dashboard:** not unit-tested (UI page convention); covered by the prod Playwright smoke.
- **Full existing suite stays green — the dormancy proof.**

Rough test-count delta from **425**: `compliance.test.ts` is rewritten (existing cases preserved as `await`, plus ~4 corridor cases), two new files add ~16 cases, extensions add ~10. Net **+~30 → ~455**. (The brainstorm budgeted ~30; the dormant rewrite is the bulk.)

## Acceptance criteria

- [ ] `CorridorComplianceRule` type + optional `Partner.corridorCompliance` added to `types.ts`; no `as any`.
- [ ] `src/lib/compliance-config.ts` exports `GLOBAL_DEFAULTS`, `CORRIDOR_DEFAULTS` (empty), `resolveCorridorRules`; pure, unit-tested.
- [ ] `src/lib/sanctions-provider.ts` exports `SanctionsScreener` + `MockSanctionsScreener` + `getSanctionsScreener`; mock reproduces today's `WATCHLIST` match semantics.
- [ ] `screenTransfer` is corridor-aware (optional `rules`/`screener`/`sourceCountry`), async, routes name screening through `SanctionsScreener`; default args reproduce today's behavior.
- [ ] `transfer-create.ts` resolves source country (`countryForCurrency`) + partner (`partnerStore.getPartner`) + rules and `await`s `screenTransfer`; compliance still receives `q.amountUsd`.
- [ ] Sentinel `'corridor-compliance-backfill-v1'` added to `migration.ts` and wired into the cron chain in `cron/route.ts`; idempotent; `default` partner preserved byte-for-byte (no `corridorCompliance` written).
- [ ] `/dashboard/compliance` shows a read-only resolved per-corridor rules card, scope-aware; sub-line notes rule-creation is deferred.
- [ ] `bot-content-guard` extended; no corridor/partner data leaks to bot content.
- [ ] The full pre-P5 suite passes (every prior test green) — the executable dormancy proof.

## Open questions

1. **File location for the screener:** `src/lib/sanctions-provider.ts` (top-level, matches the spec brief) vs `src/lib/providers/sanctions-provider.ts` (beside `kyc-provider.ts`). Recommend `providers/` for symmetry; brief says top-level — plan to confirm.
2. **`updatedAt` churn on `default` in the backfill:** re-save with a fresh `updatedAt`, or skip partners with no corridor data entirely (truly byte-for-byte)? Recommend skipping the write for partners with no `corridorCompliance` to keep `default` literally untouched, while still claiming the sentinel.
3. **`screenTransfer` async ripple:** any non-production caller (scripts, future direct importers)? `grep` shows the only caller is `transfer-create.ts`; confirm no dynamic importer before flipping to async.
4. **`CORRIDOR_DEFAULTS` seed:** ship empty (everything inherits globals) per the locked decision — confirm we do NOT pre-calibrate GB/AE corridors in P5 (calibration is partner-interest-driven, like P4's fee/cap deferral).
5. **`kycCapHintUsd` placement:** keep it on `CorridorComplianceRule` (carried, unused) vs defer the field entirely to the KYC batch. Recommend keeping it as a documented advisory hook so the next batch finds the seam pre-shaped.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `screenTransfer` going async breaks a hidden caller | Low | High | `grep` confirms single caller (`transfer-create.ts`, already async); add a compile-time check; full suite is the net. |
| Resolver accidentally diverges from today's globals (dormancy break) | Low | High | `GLOBAL_DEFAULTS` re-exports the literal `WATCHLIST`/`LARGE_AMOUNT_USD`/`VELOCITY_LIMIT`; explicit dormant-proof tests; whole suite must stay green. |
| `||` vs `??` swallows a legitimate `0`/`''` override | Medium | Medium | Mandate `??` for every numeric/string merge; unit test a `0`-threshold and empty-extra override. |
| Untrusted `corridorCompliance` JSON (malformed/huge list) | Low | Medium | Defensive `?? []`/`?? ''`, lowercase/trim before compare; no eval; mock screener treats list as plain strings. |
| Migration re-write mutates `default` partner | Low | High | Skip-on-no-corridor-data (open question 2); test asserts `default` unchanged except `updatedAt` (or untouched). |
| Dashboard scope leak (sub-admin sees another partner's rules) | Low | Medium | Reuse `requireScope` + scoped partner listing exactly as existing compliance page; no new fetch outside scope. |
| Real provider's async/latency model differs from the mock | Medium | Low | Interface already returns `Promise`; `sourceCountry` already plumbed; swap is a factory change only. |

## Out of scope (deferred)

- **KYC tiered data-capture (the NEXT batch):** Core-ID capture, Travel-Rule counterparty fields, the $3k EDD threshold, and cumulative (multi-day) velocity. P5 deliberately does **not** add these; it ships the `SanctionsScreener` interface + `kycCapHintUsd` hook that the KYC batch reuses (Core-ID / Travel-Rule screening calls the same seam, and EDD thresholds layer onto `ResolvedCorridorRules`).
- **Admin rule-creation UI.** P5 ships a **read-only** corridor display. The CRUD screen to create/edit `corridorCompliance` (and any server action behind it, which must follow the full server-action security checklist) is deferred.
- **Pre-calibrated non-US corridors.** `CORRIDOR_DEFAULTS` ships empty; per-corridor threshold calibration is partner-interest-driven (same posture as P4's deferred per-currency cap/fee tables).
- **Real sanctions provider integration** (ComplyAdvantage / Sanctions.io). P5 ships the seam + mock only.
- **Per-currency cap & fee tables** (still deferred from P4).
- **Payout countries beyond `IN`** (`IN` remains the only destination in v1; corridors are source-keyed accordingly).

## Sequencing note

P5 stacks on **P4** (`spec/p4-multi-currency`): it depends on `countryForCurrency` (`partner-currency.ts`), `Transfer.sourceCurrency`, the `partnerStore` threaded into `createTransfer`/tool context, and the P4 cron backfill chain — all introduced or wired in the recent P4 commits. Branch P5 (`spec/p5-per-corridor-compliance`) **off the merged P4 base** (P4 merged to `main` 2026-05-29 as PR #12, so this prerequisite is already satisfied). The spec and plan can be written now. P5's `SanctionsScreener` is a prerequisite for the **next** batch (KYC tiered data-capture), so it should merge before that batch begins.
