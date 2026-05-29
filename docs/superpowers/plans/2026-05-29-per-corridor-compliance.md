# P5: Per-corridor Compliance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make compliance screening **per-corridor** (per source-country → `IN`) and **pluggable**, while shipping it fully **dormant**: every transfer today is US-source under the `default` partner with no override, so the resolved ruleset and the screened result are byte-for-byte today's `compliance.ts` globals. A real multi-corridor partner is later enabled by *configuration only* (a typed `Partner.corridorCompliance` override), no code change.

**Architecture:** `createTransfer` already resolves `sourceCountry` (via `countryForCurrency(input.sourceCurrency)`) and loads the owning customer's `partnerId` (P4). P5 adds a pure resolver `resolveCorridorRules(partner, sourceCountry)` that merges code-defined `GLOBAL_DEFAULTS` ← `CORRIDOR_DEFAULTS[sourceCountry]` ← `partner.corridorCompliance?.[sourceCountry]`, and routes name screening through a pluggable `SanctionsScreener` (mirroring the existing `KycProvider`/`MockKycProvider` seam in `src/lib/providers/`). `screenTransfer` becomes corridor-aware and `async`; its only caller (`transfer-create.ts`) gains a one-line `await`. A sentinel-guarded cron backfill reserves the migration slot following the established pattern, preserving the `default` partner byte-for-byte (nothing is written, since `corridorCompliance` is optional). The dashboard gets a read-only resolved-rules card.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis.

**Spec:** `docs/superpowers/specs/2026-05-29-per-corridor-compliance-design.md`

**Branch:** `spec/p5-per-corridor-compliance` (branch off the merged P4 base; P4 — `getFxRates`, `countryForCurrency`, `Transfer.sourceCurrency`, `partnerStore`-in-`createTransfer`, the 5-backfill cron chain — is already present on `spec/p4-multi-currency`, which is the working base here).

**Test count delta:** from **425**. `compliance.test.ts` is rewritten async (6 existing cases preserved as `await` + ~4 corridor cases), two new files add ~16 (`compliance-config.test.ts` ~10, `sanctions-provider.test.ts` ~6), extensions to `transfer-create.test.ts` / `migration.test.ts` / `bot-content-guard.test.ts` add ~10. Net **+~30 → ~455**. The full pre-P5 suite staying green is the executable **dormancy proof**.

**Patterns to reuse (do not reinvent):**
- **Pluggable provider seam:** mirror `src/lib/providers/kyc-provider.ts` (interface) + `mock-kyc-provider.ts` (impl). `SanctionsScreener` lives beside them in `src/lib/providers/` for symmetry (resolves spec open question 1).
- **Sentinel migration:** `store.claimMigrationFlag(KEY)` returns `true` once; `migration.ts` already has five `backfill*Once` functions (`backfillCustomersOnce` … `backfillSourceAmountsOnce`) and one `*_SENTINEL_KEY` constant each — copy that shape exactly.
- **Lazy-fill on read, never write on read paths:** `corridorCompliance` is **optional**, so a missing value needs no fill — reads treat `undefined` as "no override". The cron pass is the only writer.
- **Server-action security checklist:** P5 adds **no** server action (read-only dashboard). The deferred rule-creation UI must follow the full checklist; note it.
- **USD-equivalent accounting:** `screenTransfer` keeps receiving `q.amountUsd` (USD-equivalent); corridor `largeAmountUsd` thresholds are USD-equivalent.
- **Dormancy invariant:** `GLOBAL_DEFAULTS` re-exports the literal `WATCHLIST` / `LARGE_AMOUNT_USD` / `VELOCITY_LIMIT` from `compliance.ts`; the dormant path resolves to exactly those.
- **`fakeRedis()` in tests; defensive `?? ''` / `?? []` on Redis-resident strings/lists; no `as any`; ISO country/currency codes; TDD per task.**

**CI reminders:**
- `main` branch protection requires the `ci / ci` status check; no direct pushes. Open a PR; Vercel auto-deploys on merge; Playwright smoke runs against prod.
- The full local gate is `npm run typecheck && npm run lint && npx vitest run && npm run build`.
- GitGuardian may red on the known env-var-name false positive; `ci` is the required check.

---

## File Map

**New files:**
- `src/lib/compliance-config.ts` — `GLOBAL_DEFAULTS`, `CORRIDOR_DEFAULTS` (empty), `resolveCorridorRules`, `ResolvedCorridorRules` type. Pure, TDD'd.
- `src/lib/providers/sanctions-provider.ts` — `SanctionsScreener` interface, `SanctionsHit`, `MockSanctionsScreener`, `getSanctionsScreener` factory. Mirrors `kyc-provider.ts` + `mock-kyc-provider.ts`.
- `tests/compliance-config.test.ts` — resolver unit tests (~10).
- `tests/sanctions-provider.test.ts` — mock screener unit tests (~6).

**Modified files:**
- `src/lib/types.ts` — `CorridorComplianceRule` interface + optional `Partner.corridorCompliance`.
- `src/lib/compliance.ts` — `screenTransfer` becomes corridor-aware + async, routes through `SanctionsScreener`; globals unchanged and re-exported.
- `src/lib/transfer-create.ts` — load `partner`, resolve `rules`, `await screenTransfer({ …, sourceCountry, rules })`.
- `src/lib/migration.ts` — `CORRIDOR_COMPLIANCE_SENTINEL_KEY` + `backfillCorridorComplianceOnce`.
- `src/app/api/cron/route.ts` — wire `backfillCorridorComplianceOnce` into the chain + JSON response.
- `src/app/dashboard/compliance/page.tsx` — read-only resolved per-corridor rules card (scope-aware).
- `tests/compliance.test.ts` — rewritten async + corridor cases.
- `tests/transfer-create.test.ts` — dormant regression + override + `await` wiring.
- `tests/migration.test.ts` — sentinel idempotency + `default` preserved.
- `tests/bot-content-guard.test.ts` — corridor data never leaks to bot content.

---

## Task 1: Corridor-rule type + optional `Partner.corridorCompliance`

**Goal:** Add the typed, optional partner-resident override surface — no behavior change, just the shape every later task references.

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add the `CorridorComplianceRule` interface and the optional `Partner` field**

In `src/lib/types.ts`, immediately after the `Partner` interface (it ends at the closing `}` of the block that starts `export interface Partner {` around line 252–264), add the rule interface, and add the optional field to `Partner` itself:

```ts
// ── Per-corridor compliance (P5) ──────────────────────────────────────
//
// A corridor is a (source-country → IN) pair; destination is always IN in v1,
// so a corridor is identified by its SOURCE CountryCode (the map key). All
// fields optional so an override can tweak a single dimension. This data is
// untrusted at rest (set manually / via a future API) — readers must treat
// its strings/lists defensively (?? '' / ?? [], lowercase/trim before compare).
export interface CorridorComplianceRule {
  watchlistExtra?: string[];   // names appended to the screener's base list (lowercased on read)
  largeAmountUsd?: number;     // USD-equivalent flag threshold; overrides LARGE_AMOUNT_USD
  velocityLimit?: number;      // transfers/day before 'High transfer velocity.'; overrides VELOCITY_LIMIT
  kycCapHintUsd?: number;      // ADVISORY ONLY — hook for the NEXT (KYC) batch; NOT read by screenTransfer in P5
}
```

Then add the optional field inside `Partner` (after `adminNote?: string;`, before `createdAt`):

```ts
  corridorCompliance?: Partial<Record<CountryCode, CorridorComplianceRule>>;  // NEW (P5) — optional override map (default partner never gets it)
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. The field is optional, so no existing `Partner` literal (the `default` seed in `partner-store.ts` / `migration.ts`) needs updating, and no test fixture breaks.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(P5): add CorridorComplianceRule type + optional Partner.corridorCompliance"
```

---

## Task 2: Pluggable `SanctionsScreener` interface + mock

**Goal:** Introduce the swappable name-screening seam (mirroring `KycProvider`/`MockKycProvider`), with a `MockSanctionsScreener` that reproduces today's exact `WATCHLIST` match semantics (case-insensitive, trimmed, exact-match). No call-site change yet — `compliance.ts` adopts it in Task 4.

**Files:**
- Create: `src/lib/providers/sanctions-provider.ts`
- Test: `tests/sanctions-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sanctions-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockSanctionsScreener, getSanctionsScreener } from '@/lib/providers/sanctions-provider';

describe('MockSanctionsScreener', () => {
  it('matches a base-list name case-insensitively and trimmed', async () => {
    const s = new MockSanctionsScreener(['John Doe', 'jane roe']);
    const hit = await s.screen({ name: '  JOHN DOE ', sourceCountry: 'US' });
    expect(hit.matched).toBe(true);
    expect(hit.matchedName).toBe('john doe');
    expect(hit.listSource).toBe('mock-watchlist');
  });

  it('returns { matched: false } for an unlisted name', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    const hit = await s.screen({ name: 'Mom', sourceCountry: 'US' });
    expect(hit).toEqual({ matched: false });
  });

  it('matches a corridor watchlistExtra name folded into the base list', async () => {
    const s = new MockSanctionsScreener(['john doe', 'corridor villain']);
    const hit = await s.screen({ name: 'Corridor Villain', sourceCountry: 'GB' });
    expect(hit.matched).toBe(true);
  });

  it('empty / whitespace name never matches (defensive ?? \'\')', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    expect((await s.screen({ name: '', sourceCountry: 'US' })).matched).toBe(false);
    expect((await s.screen({ name: '   ', sourceCountry: 'US' })).matched).toBe(false);
  });

  it('accepts and ignores sourceCountry without error', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    await expect(s.screen({ name: 'john doe', sourceCountry: 'AE' })).resolves.toMatchObject({ matched: true });
  });
});

describe('getSanctionsScreener', () => {
  it('builds a MockSanctionsScreener over the supplied base list', async () => {
    const s = getSanctionsScreener(['test blocked']);
    expect((await s.screen({ name: 'Test Blocked', sourceCountry: 'US' })).matched).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/sanctions-provider.test.ts`
Expected: FAIL — module `@/lib/providers/sanctions-provider` not found.

- [ ] **Step 3: Implement `src/lib/providers/sanctions-provider.ts`**

Mirror the shape of `src/lib/providers/kyc-provider.ts` (interface) + `mock-kyc-provider.ts` (class implementation):

```ts
import type { CountryCode } from '../types';

export interface SanctionsHit {
  matched: boolean;
  matchedName?: string;
  listSource?: string;   // e.g. 'mock-watchlist' | future 'OFAC-SDN'
}

/**
 * The pluggable sanctions-screening seam (P5), mirroring KycProvider. A real
 * provider (ComplyAdvantage / Sanctions.io) implements the same interface and
 * is swapped in by changing getSanctionsScreener — no call-site change.
 * The contract returns a Promise so a network-backed provider needs no
 * signature change; the mock resolves immediately.
 */
export interface SanctionsScreener {
  screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit>;
}

/**
 * MockSanctionsScreener: P5 stand-in. Reproduces TODAY's compliance.ts logic —
 * case-insensitive, trimmed, exact-match against a base list (WATCHLIST plus
 * any corridor watchlistExtra). sourceCountry is accepted (so a real provider
 * can scope by jurisdiction) but unused here.
 */
export class MockSanctionsScreener implements SanctionsScreener {
  constructor(private readonly baseList: string[]) {}

  async screen(input: { name: string; sourceCountry: CountryCode }): Promise<SanctionsHit> {
    const name = (input.name ?? '').trim().toLowerCase();          // defensive ?? '' (untrusted)
    if (name === '') return { matched: false };
    const list = (this.baseList ?? []).map((n) => (n ?? '').trim().toLowerCase());
    return list.includes(name)
      ? { matched: true, matchedName: name, listSource: 'mock-watchlist' }
      : { matched: false };
  }
}

// Factory parallel to a future getKycProvider(); lets a real provider swap in.
export function getSanctionsScreener(baseList: string[]): SanctionsScreener {
  return new MockSanctionsScreener(baseList);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sanctions-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/sanctions-provider.ts tests/sanctions-provider.test.ts
git commit -m "feat(P5): pluggable SanctionsScreener seam + MockSanctionsScreener (mirrors KycProvider)"
```

---

## Task 3: Compliance-config resolver (`resolveCorridorRules`)

**Goal:** The single pure authority that merges `GLOBAL_DEFAULTS` ← `CORRIDOR_DEFAULTS[sourceCountry]` ← `partner.corridorCompliance?.[sourceCountry]` into a fully-resolved ruleset. `GLOBAL_DEFAULTS` re-exports the literal globals so the dormant path is provably today's. No I/O. This is the early dormancy proof: `resolveCorridorRules(null, 'US') === GLOBAL_DEFAULTS`.

**Files:**
- Create: `src/lib/compliance-config.ts`
- Test: `tests/compliance-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/compliance-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  resolveCorridorRules,
  GLOBAL_DEFAULTS,
  CORRIDOR_DEFAULTS,
} from '@/lib/compliance-config';
import { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from '@/lib/compliance';
import type { Partner } from '@/lib/types';

function partner(corridorCompliance?: Partner['corridorCompliance']): Partner {
  return {
    id: 'p', name: 'P', countries: ['US'], status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    corridorCompliance,
  };
}

describe('GLOBAL_DEFAULTS (dormancy anchor)', () => {
  it('re-exports today\'s literal globals', () => {
    expect(GLOBAL_DEFAULTS.baseWatchlist).toBe(WATCHLIST);
    expect(GLOBAL_DEFAULTS.largeAmountUsd).toBe(LARGE_AMOUNT_USD); // 1000
    expect(GLOBAL_DEFAULTS.velocityLimit).toBe(VELOCITY_LIMIT);    // 3
    expect(GLOBAL_DEFAULTS.watchlistExtra).toEqual([]);
  });
  it('ships CORRIDOR_DEFAULTS empty (everything inherits globals)', () => {
    expect(CORRIDOR_DEFAULTS).toEqual({});
  });
});

describe('resolveCorridorRules — dormant path', () => {
  it('null partner + US → GLOBAL_DEFAULTS', () => {
    expect(resolveCorridorRules(null, 'US')).toEqual(GLOBAL_DEFAULTS);
  });
  it('default-shaped partner (no corridorCompliance) + US → GLOBAL_DEFAULTS', () => {
    expect(resolveCorridorRules(partner(), 'US')).toEqual(GLOBAL_DEFAULTS);
  });
  it('undefined corridorCompliance for a configured-elsewhere partner still → globals for that corridor', () => {
    expect(resolveCorridorRules(partner({ GB: { velocityLimit: 9 } }), 'US')).toEqual(GLOBAL_DEFAULTS);
  });
});

describe('resolveCorridorRules — override merge', () => {
  it('override replaces a single numeric field, inherits the rest', () => {
    const r = resolveCorridorRules(partner({ GB: { largeAmountUsd: 5000 } }), 'GB');
    expect(r.largeAmountUsd).toBe(5000);
    expect(r.velocityLimit).toBe(VELOCITY_LIMIT); // inherited
    expect(r.baseWatchlist).toBe(WATCHLIST);      // inherited
  });
  it('watchlistExtra is concatenated, not replaced', () => {
    const r = resolveCorridorRules(partner({ GB: { watchlistExtra: ['corridor villain'] } }), 'GB');
    expect(r.watchlistExtra).toEqual(['corridor villain']);
    expect(r.baseWatchlist).toBe(WATCHLIST); // base intact
  });
  it('honors a numeric 0 override (uses ?? not ||)', () => {
    const r = resolveCorridorRules(partner({ GB: { velocityLimit: 0 } }), 'GB');
    expect(r.velocityLimit).toBe(0);
  });
  it('ignores an IN (payout-side) key', () => {
    const r = resolveCorridorRules(partner({ IN: { velocityLimit: 1 } }), 'IN');
    expect(r).toEqual(GLOBAL_DEFAULTS);
  });
  it('carries kycCapHintUsd through (advisory only)', () => {
    const r = resolveCorridorRules(partner({ GB: { kycCapHintUsd: 3000 } }), 'GB');
    expect(r.kycCapHintUsd).toBe(3000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/compliance-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/compliance-config.ts`**

```ts
import type { CountryCode, Partner } from './types';
import { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from './compliance';

export interface ResolvedCorridorRules {
  baseWatchlist: string[];     // the screener's base list (today's WATCHLIST)
  watchlistExtra: string[];    // corridor-specific additions (possibly empty)
  largeAmountUsd: number;      // USD-equivalent flag threshold
  velocityLimit: number;       // transfers/day before flagging
  kycCapHintUsd?: number;      // ADVISORY ONLY — consumed by the NEXT (KYC) batch
}

// Today's globals, named so the dormant path is PROVABLY equal to current
// behavior. baseWatchlist/largeAmountUsd/velocityLimit ARE the literal
// compliance.ts constants — do not fork their values here.
export const GLOBAL_DEFAULTS: ResolvedCorridorRules = {
  baseWatchlist: WATCHLIST,
  watchlistExtra: [],
  largeAmountUsd: LARGE_AMOUNT_USD,   // 1000
  velocityLimit: VELOCITY_LIMIT,      // 3
};

// Code-defined per-corridor DEFAULTS. EMPTY at ship time — every corridor
// inherits GLOBAL_DEFAULTS. Populated later as real corridors are calibrated
// (partner-interest-driven, like P4's deferred per-currency cap/fee tables).
// US is intentionally absent → falls through to GLOBAL_DEFAULTS → byte-for-byte.
export const CORRIDOR_DEFAULTS: Partial<Record<CountryCode, Partial<ResolvedCorridorRules>>> = {};

export function resolveCorridorRules(
  partner: Partner | null,
  sourceCountry: CountryCode,
): ResolvedCorridorRules {
  // IN is the payout side; it is never a corridor source. Ignore it.
  if (sourceCountry === 'IN') return GLOBAL_DEFAULTS;

  const corridorDefault = CORRIDOR_DEFAULTS[sourceCountry] ?? {};
  const override = partner?.corridorCompliance?.[sourceCountry] ?? {};

  // Each numeric field: override ?? corridorDefault ?? GLOBAL_DEFAULTS (?? so a
  // legitimate 0 is honored). watchlistExtra is CONCATENATED, not replaced.
  const watchlistExtra = (corridorDefault.watchlistExtra ?? []).concat(override.watchlistExtra ?? []);

  // Fast path: nothing configured for this corridor → return the shared
  // GLOBAL_DEFAULTS object so the dormant equality (=== GLOBAL_DEFAULTS) holds.
  const hasCorridorDefault = CORRIDOR_DEFAULTS[sourceCountry] !== undefined;
  const hasOverride = partner?.corridorCompliance?.[sourceCountry] !== undefined;
  if (!hasCorridorDefault && !hasOverride) return GLOBAL_DEFAULTS;

  return {
    baseWatchlist: GLOBAL_DEFAULTS.baseWatchlist,
    watchlistExtra,
    largeAmountUsd: override.largeAmountUsd ?? corridorDefault.largeAmountUsd ?? GLOBAL_DEFAULTS.largeAmountUsd,
    velocityLimit: override.velocityLimit ?? corridorDefault.velocityLimit ?? GLOBAL_DEFAULTS.velocityLimit,
    kycCapHintUsd: override.kycCapHintUsd ?? corridorDefault.kycCapHintUsd,
  };
}
```

> **Note on the dormant equality:** the `null`/`default`/no-config tests assert `toEqual(GLOBAL_DEFAULTS)` *and* the `=== GLOBAL_DEFAULTS` identity matters only for the fast path — the explicit `return GLOBAL_DEFAULTS` guarantees both. (`CorridorComplianceRule` has no `baseWatchlist` field, so a partner can never replace the base list, only append to it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compliance-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/compliance-config.ts tests/compliance-config.test.ts
git commit -m "feat(P5): pure resolveCorridorRules merging globals/corridor-defaults/partner override"
```

---

## Task 4: Corridor-aware, async `screenTransfer`

**Goal:** Make `screenTransfer` take optional `rules` / `screener` / `sourceCountry`, route name screening through `SanctionsScreener`, and become `async` — while keeping its exported name, `ComplianceResult` shape, exact reason strings, and `blocked > flagged > cleared` precedence. With no extra args it reproduces today's behavior exactly (default args = `GLOBAL_DEFAULTS` + a mock over today's `WATCHLIST`). This is the executable dormancy proof at the screening layer.

**Files:**
- Modify: `src/lib/compliance.ts`
- Test: `tests/compliance.test.ts` (rewrite to async)

- [ ] **Step 1: Rewrite `tests/compliance.test.ts` to the async signature + add corridor cases**

Replace the whole file. The first six cases are today's, mechanically `await`ed (the dormancy proof); the rest exercise the corridor seam:

```ts
import { describe, it, expect } from 'vitest';
import { screenTransfer } from '@/lib/compliance';
import { GLOBAL_DEFAULTS } from '@/lib/compliance-config';
import { MockSanctionsScreener } from '@/lib/providers/sanctions-provider';

describe('screenTransfer — dormant (no rules/screener) reproduces today', () => {
  it('clears an ordinary transfer', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
  });
  it('blocks a recipient on the watchlist (case-insensitive)', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: '  John Doe ', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/watchlist/i);
  });
  it('flags a large amount', async () => {
    const r = await screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /amount/i.test(x))).toBe(true);
  });
  it('flags high velocity', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 3, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /velocity/i.test(x))).toBe(true);
  });
  it('records both reasons when amount and velocity both trip', async () => {
    const r = await screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 4, sourceCountry: 'US' });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toHaveLength(2);
  });
  it('blocked takes precedence over flagged', async () => {
    const r = await screenTransfer({ amountUsd: 2000, recipientName: 'John Doe', transfersToday: 9, sourceCountry: 'US' });
    expect(r.status).toBe('blocked');
  });
});

describe('screenTransfer — corridor overrides', () => {
  it('a raised largeAmountUsd clears a transfer that is flagged-today', async () => {
    const rules = { ...GLOBAL_DEFAULTS, largeAmountUsd: 5000 };
    const r = await screenTransfer({ amountUsd: 1200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'GB', rules });
    expect(r.status).toBe('cleared'); // 1200 < 5000
  });
  it('watchlistExtra blocks a name absent from the global list', async () => {
    const rules = { ...GLOBAL_DEFAULTS, watchlistExtra: ['corridor villain'] };
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Corridor Villain', transfersToday: 0, sourceCountry: 'GB', rules });
    expect(r.status).toBe('blocked');
  });
  it('a lowered velocityLimit moves the flag boundary', async () => {
    const rules = { ...GLOBAL_DEFAULTS, velocityLimit: 1 };
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 1, sourceCountry: 'GB', rules });
    expect(r.status).toBe('flagged');
  });
  it('an injected screener is used in place of the default', async () => {
    const screener = new MockSanctionsScreener(['only this name']);
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'only this name', transfersToday: 0, sourceCountry: 'GB', screener });
    expect(r.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/compliance.test.ts`
Expected: FAIL — `screenTransfer` is synchronous, has no `rules`/`screener`/`sourceCountry` params, and does not route through a screener.

- [ ] **Step 3: Rewrite `screenTransfer` in `src/lib/compliance.ts`**

Keep the global constants and `ComplianceResult` exactly as-is (lines 1–11 of the current file are unchanged). Replace the function (current lines 13–34) with the corridor-aware async version:

```ts
import type { ComplianceStatus, CountryCode } from './types';
import type { ResolvedCorridorRules } from './compliance-config';
import { GLOBAL_DEFAULTS } from './compliance-config';
import {
  type SanctionsScreener,
  getSanctionsScreener,
} from './providers/sanctions-provider';

// Mock sanctions/watchlist — clearly fake names for the prototype. UNCHANGED.
export const WATCHLIST = ['john doe', 'jane roe', 'test blocked'];
export const LARGE_AMOUNT_USD = 1000;
export const VELOCITY_LIMIT = 3;

export interface ComplianceResult {
  status: ComplianceStatus;
  reasons: string[];
}

export async function screenTransfer(input: {
  amountUsd: number;                 // USD-equivalent (unchanged; fed by quote.amountUsd)
  recipientName: string;
  transfersToday: number;
  sourceCountry?: CountryCode;       // NEW (P5) — passed to the screener for jurisdiction scoping
  rules?: ResolvedCorridorRules;     // NEW (P5) — defaults to GLOBAL_DEFAULTS (today's values)
  screener?: SanctionsScreener;      // NEW (P5) — defaults to a mock over rules' base ∪ extra
}): Promise<ComplianceResult> {
  const rules = input.rules ?? GLOBAL_DEFAULTS;
  const screener =
    input.screener ??
    getSanctionsScreener([...rules.baseWatchlist, ...rules.watchlistExtra]);

  const hit = await screener.screen({
    name: input.recipientName,
    sourceCountry: input.sourceCountry ?? 'US',
  });
  if (hit.matched) {
    return {
      status: 'blocked',
      reasons: ['Recipient is on the compliance watchlist.'],
    };
  }

  const reasons: string[] = [];
  if (input.amountUsd >= rules.largeAmountUsd) {
    reasons.push('Large transfer amount.');
  }
  if (input.transfersToday >= rules.velocityLimit) {
    reasons.push('High transfer velocity.');
  }
  if (reasons.length > 0) return { status: 'flagged', reasons };
  return { status: 'cleared', reasons: [] };
}
```

> **Why default `sourceCountry ?? 'US'`:** keeps the parameter optional (no churn for callers that omit it) while the mock ignores `sourceCountry` anyway — the value only matters when a real provider scopes by jurisdiction.

- [ ] **Step 4: Run the compliance test to verify green**

Run: `npx vitest run tests/compliance.test.ts`
Expected: PASS — dormant cases reproduce today exactly; corridor cases pass.

- [ ] **Step 5: Typecheck (expect the one caller to break)**

Run: `npm run typecheck`
Expected: FAIL at `src/lib/transfer-create.ts:30` — `screenTransfer(...)` now returns `Promise<ComplianceResult>` but is consumed synchronously. Task 5 fixes the single caller. (Do not fix it here; this red is the proof the only caller is `transfer-create.ts`, per spec risk #1.)

- [ ] **Step 6: Commit (compliance layer only; caller fixed in Task 5)**

```bash
git add src/lib/compliance.ts tests/compliance.test.ts
git commit -m "feat(P5): corridor-aware async screenTransfer routed through SanctionsScreener"
```

---

## Task 5: Wire the resolver + async screening through `transfer-create.ts`

**Goal:** `createTransfer` (the **only** caller of `screenTransfer`) loads the owning `partner`, resolves the corridor rules, and `await`s the now-async screening — still feeding `q.amountUsd` (USD-equivalent). The dormant path (`default` partner, USD source) resolves to `GLOBAL_DEFAULTS`, so `complianceStatus`/`complianceReasons` are byte-for-byte today's.

**Files:**
- Modify: `src/lib/transfer-create.ts`
- Test: `tests/transfer-create.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/transfer-create.test.ts` (it already builds `createStore(fakeRedis())`; `createTransfer` already takes `partnerStore` per P4 — confirm the existing harness, and add a `partnerStore` arg if the current signature is `createTransfer(store, partnerStore, input)`; otherwise thread it as in Step 3):

```ts
it('P5 regression: default/USD path produces today\'s compliance result', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  await partnerStore.ensureDefaultPartner(); // countries: ['US'], no corridorCompliance
  const t = await createTransfer(store, partnerStore, {
    phone: '15551230000',
    amountSource: 1500, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
  });
  expect(t.complianceStatus).toBe('flagged');              // >= 1000 today
  expect(t.complianceReasons).toContain('Large transfer amount.');
});

it('P5: a corridor override raises the threshold so a flagged-today amount clears', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  await partnerStore.savePartner({
    id: 'gb-co', name: 'GB Co', countries: ['US', 'GB'], status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    corridorCompliance: { GB: { largeAmountUsd: 5000 } },
  });
  const t = await createTransfer(store, partnerStore, {
    phone: '15551239999',
    amountSource: 1200, sourceCurrency: 'GBP', partnerId: 'gb-co',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
  });
  // 1200 GBP → USD-equivalent is below the 5000 override → not flagged for amount.
  expect(t.complianceReasons).not.toContain('Large transfer amount.');
});
```

> If the existing tests call `createTransfer(store, input)` (P4 may have threaded `partnerStore` only into the tool/cron context, not the function signature), update those existing calls to the new 3-arg form in this step — the typecheck in Step 4 will flag every one.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/transfer-create.test.ts`
Expected: FAIL — `createTransfer` does not yet take `partnerStore` / resolve rules / `await` screening.

- [ ] **Step 3: Update `src/lib/transfer-create.ts`**

Add `partnerStore` as a parameter, resolve the partner + rules, and `await` the screening. Replace the imports and the screening block (current lines 1–34):

```ts
import { quote } from './fx';
import { getFxRates } from './rate';
import { screenTransfer } from './compliance';
import { resolveCorridorRules } from './compliance-config';
import { newTransferId } from './id';
import { countryForCurrency } from './partner-currency';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type { CurrencyCode, FundingMethod, PartnerId, PayoutMethod, Transfer } from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';

// CreateTransferInput is UNCHANGED (P4 fields: amountSource, sourceCurrency, partnerId).

export async function createTransfer(
  store: Store,
  partnerStore: PartnerStore,           // NEW (P5) — to resolve corridor rules
  input: CreateTransferInput,
): Promise<Transfer> {
  const transferCount = await store.getTransferCount(input.phone);
  const rates = await getFxRates(input.sourceCurrency);
  const q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount);
  const transfersToday = await store.getTodayTransferCount(input.phone);

  const sourceCountry = countryForCurrency(input.sourceCurrency);   // P4 symbol (was already used L52)
  const partner = await partnerStore.getPartner(input.partnerId);   // NEW (P5)
  const rules = resolveCorridorRules(partner, sourceCountry);        // NEW (P5)
  const compliance = await screenTransfer({                         // CHANGED (P5): await
    amountUsd: q.amountUsd,            // USD-equivalent — UNCHANGED
    recipientName: input.recipientName,
    transfersToday,
    sourceCountry,                     // NEW (P5)
    rules,                             // NEW (P5)
  });
  // ...remainder of the function (the `const transfer: Transfer = {...}` block,
  //    saveTransfer, increments, upsertRecipient) is UNCHANGED.
```

- [ ] **Step 4: Fix every caller of `createTransfer` to the 3-arg form**

Run: `npm run typecheck`
Expected: FAIL at each `createTransfer(store, {...})` call. Update them to pass `partnerStore`:
- `src/lib/cron-run.ts` — it already has `partnerStore` available (P4 threaded it into the cron path / `getPartnerStore()` is in `cron/route.ts`). Pass it: `createTransfer(deps.store, deps.partnerStore, {...})` (add `partnerStore` to the cron deps object if not already present — check `runDueSchedules`/`RunDueSchedulesDeps`).
- `src/lib/tools.ts` — `createTransferTool` (both the approve-tap path and the legacy explicit-args path) already has `ctx.partnerStore` (P4 added it to `ToolContext`). Pass `ctx.partnerStore`: `createTransfer(ctx.store, ctx.partnerStore, {...})`.

Re-run `npm run typecheck` until clean.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. The dormant-path regression tests (default/USD) match today; the override test clears.

- [ ] **Step 6: Commit**

```bash
git add src/lib/transfer-create.ts src/lib/cron-run.ts src/lib/tools.ts tests/transfer-create.test.ts
git commit -m "feat(P5): transfer-create resolves corridor rules + awaits async screenTransfer"
```

---

## Task 6: Sentinel-guarded corridor-compliance backfill + cron wiring

**Goal:** Reserve the migration slot following the established pattern — `backfillCorridorComplianceOnce` claims sentinel `'corridor-compliance-backfill-v1'`, and the `default` partner is preserved **byte-for-byte** (nothing is written, since `corridorCompliance` is optional). Per spec open question 2, we **skip the write entirely for partners with no `corridorCompliance`**, so `default` is literally untouched while the sentinel slot + pattern are reserved for when a real corridor partner needs a re-persist.

**Files:**
- Modify: `src/lib/migration.ts`, `src/app/api/cron/route.ts`
- Test: `tests/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/migration.test.ts`:

```ts
it('P5: backfillCorridorComplianceOnce is sentinel-guarded and leaves default untouched', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const def = await partnerStore.ensureDefaultPartner();
  const before = JSON.stringify(await redis.get('partner:default'));

  const first = await backfillCorridorComplianceOnce(store, partnerStore);
  expect(first.skippedSentinel).toBe(false);

  // default has no corridorCompliance → not re-saved → byte-for-byte identical
  const after = JSON.stringify(await redis.get('partner:default'));
  expect(after).toBe(before);
  const reloaded = await partnerStore.getPartner('default');
  expect(reloaded).toEqual(def);
  expect(reloaded?.corridorCompliance).toBeUndefined();

  // second pass is a no-op (sentinel already claimed)
  const second = await backfillCorridorComplianceOnce(store, partnerStore);
  expect(second.skippedSentinel).toBe(true);
});

it('P5: a partner WITH corridorCompliance is preserved by the re-save (spread)', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  await partnerStore.savePartner({
    id: 'gb-co', name: 'GB Co', countries: ['US', 'GB'], status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    corridorCompliance: { GB: { velocityLimit: 9 } },
  });
  await backfillCorridorComplianceOnce(store, partnerStore);
  const reloaded = await partnerStore.getPartner('gb-co');
  expect(reloaded?.corridorCompliance?.GB?.velocityLimit).toBe(9);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/migration.test.ts`
Expected: FAIL — `backfillCorridorComplianceOnce` not exported.

- [ ] **Step 3: Implement `backfillCorridorComplianceOnce` in `src/lib/migration.ts`**

Add the sentinel constant beside the existing five (after `SOURCE_AMOUNT_SENTINEL_KEY` on line 11):

```ts
const CORRIDOR_COMPLIANCE_SENTINEL_KEY = 'corridor-compliance-backfill-v1';
```

Add the function (mirrors `backfillSchedulesOnce`'s shape):

```ts
export async function backfillCorridorComplianceOnce(
  store: Store,
  partnerStore: PartnerStore,
): Promise<{ partnersTouched: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(CORRIDOR_COMPLIANCE_SENTINEL_KEY);
  if (!claimed) return { partnersTouched: 0, skippedSentinel: true };

  // corridorCompliance is OPTIONAL — the dormant path has nothing to fill.
  // Skip the write for partners with no corridor data so 'default' stays
  // byte-for-byte (spec open question 2). Partners that already carry an
  // override are re-saved via the spread, preserving the field exactly.
  let partnersTouched = 0;
  for (const p of await partnerStore.listPartners()) {
    if (p.corridorCompliance === undefined) continue; // skip → default untouched
    await partnerStore.savePartner({ ...p });
    partnersTouched++;
  }
  return { partnersTouched, skippedSentinel: false };
}
```

(`PartnerStore` is already imported at the top of `migration.ts` — line 3.)

- [ ] **Step 4: Wire it into the cron chain in `src/app/api/cron/route.ts`**

Add to the import block (after `backfillSourceAmountsOnce`):

```ts
  backfillCorridorComplianceOnce,
```

After `const sourceAmountBackfill = ...` (line in the backfill section):

```ts
const corridorComplianceBackfill = await backfillCorridorComplianceOnce(store, partnerStore); // NEW (P5)
```

In the `NextResponse.json({...})` block, after `sourceAmountBackfill,`:

```ts
    corridorComplianceBackfill,  // NEW (P5)
```

- [ ] **Step 5: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. If a cron route-shape test asserts the JSON keys, add `corridorComplianceBackfill`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migration.ts src/app/api/cron/route.ts tests/migration.test.ts
git commit -m "feat(P5): sentinel-guarded corridor-compliance backfill (default preserved byte-for-byte)"
```

---

## Task 7: Read-only resolved per-corridor rules card on `/dashboard/compliance`

**Goal:** Add a scope-aware, **read-only** card that, for each in-scope partner, renders its **resolved** corridor rules so staff see what is actually enforced. No mutation, no server action. The existing global Watchlist card stays.

**Files:**
- Modify: `src/app/dashboard/compliance/page.tsx`

- [ ] **Step 1: Compute resolved rules per partner-corridor in the page body**

The page already calls `requireScope()` + `createScopedStore(staff)` (lines 38–39). `createScopedStore` exposes `listPartners()` (already scope-filtered: a sub-admin sees only their partner, a global admin sees all — confirmed in `scoped-store.ts`). Add the imports and the computation. After `const topVel = topVelocityToday(...)` (line 43):

```tsx
import { resolveCorridorRules } from '@/lib/compliance-config';
import { countryForCurrency } from '@/lib/partner-currency';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';
// ...
const partners = await scoped.listPartners();
const corridorRows = partners.flatMap((p) =>
  (p.countries ?? [])                        // defensive ?? [] (Redis-resident)
    .filter((c) => c !== 'IN')               // send-side only; IN is payout
    .map((country) => {
      const rules = resolveCorridorRules(p, country);
      return {
        partnerName: p.name ?? '',           // defensive ?? '' (Redis-resident)
        corridor: `${country} → IN`,
        largeAmountUsd: rules.largeAmountUsd,
        velocityLimit: rules.velocityLimit,
        watchlistSize: rules.baseWatchlist.length + rules.watchlistExtra.length,
        watchlistExtra: rules.watchlistExtra,
      };
    }),
);
corridorRows.sort((a, b) => (a.partnerName + a.corridor).localeCompare(b.partnerName + b.corridor));
```

- [ ] **Step 2: Render the card (after the Watchlist `<section>`, before "Top velocity today")**

```tsx
<section className="sh-card">
  <div className="sh-card-head">
    <div>
      <div className="sh-card-title">Corridor rules</div>
      <div className="sh-card-sub">
        Resolved compliance rules per corridor (read-only). Full rule-creation UI is deferred.
      </div>
    </div>
  </div>
  <div className="sh-ledger-wrap">
    {corridorRows.length === 0 ? (
      <div className="sh-empty">No corridors configured.</div>
    ) : (
      <table className="sh-table">
        <thead><tr>
          <th>Partner</th><th>Corridor</th><th>Large-amount (USD)</th>
          <th>Velocity / day</th><th>Watchlist</th>
        </tr></thead>
        <tbody>
          {corridorRows.map((r) => (
            <tr key={r.partnerName + r.corridor}>
              <td>{r.partnerName}</td>
              <td>{r.corridor}</td>
              <td className="sh-amount">{usd(r.largeAmountUsd)}</td>
              <td className="sh-amount">{r.velocityLimit}</td>
              <td>
                {r.watchlistSize}
                {r.watchlistExtra.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                    {r.watchlistExtra.map((name) => (
                      <span key={name} className="sh-pill sh-pill-danger">
                        <span className="sh-pill-dot"></span>{name}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
</section>
```

(`usd()` already exists in this file — line 10. `DEFAULT_CURRENCY_FOR_COUNTRY` import is optional and may be dropped if not used for display; the rows above key off `country` directly via `countryForCurrency` symmetry — keep only the imports you actually reference to satisfy lint.)

- [ ] **Step 3: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: clean (UI pages are not unit-tested per project conventions; the build is the gate). The card is read-only — no server action, nothing to harden in the security checklist this batch.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/compliance/page.tsx
git commit -m "feat(P5): read-only resolved per-corridor rules card on compliance page"
```

---

## Task 8: Bot-content-guard — corridor data never leaks to bot content

**Goal:** Extend the existing `bot-content-guard.test.ts` so the bot stays partner/corridor-blind: no corridor watchlist name, the word `corridor`, or partner-internal terminology can appear in any chat-message `content` literal in the bot code path. P5 adds no bot-facing surface; this is the executable assertion of that.

**Files:**
- Modify: `tests/bot-content-guard.test.ts`

- [ ] **Step 1: Add the P5 guard assertions**

Append a describe block (the file already scans `prompt.ts`/`agent.ts`/`tools.ts` for `content:` literals containing `'partner'` — extend the forbidden-term set):

```ts
describe('P5 corridor guards: bot never surfaces corridor/compliance config', () => {
  const filesToScan = ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts'];
  const forbidden = ['corridor', 'watchlist', 'corridorcompliance', 'sanctions'];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content mentioning corridor/compliance internals`, () => {
      const contents = readFileSync(resolve(process.cwd(), rel), 'utf-8');
      const matches = [...contents.matchAll(/content:\s*['"`]([^'"`]*?)['"`]/g)];
      for (const m of matches) {
        const text = m[1].toLowerCase();
        for (const term of forbidden) expect(text).not.toContain(term);
      }
    });
  }

  it('P5: a corridor watchlistExtra name never appears verbatim in bot content', () => {
    // The mock corridor name used in tests must not be hard-coded into any prompt/tool string.
    const sample = 'corridor villain';
    for (const rel of ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts']) {
      const contents = readFileSync(resolve(process.cwd(), rel), 'utf-8').toLowerCase();
      expect(contents).not.toContain(sample);
    }
  });
});
```

- [ ] **Step 2: Run it to verify green**

Run: `npx vitest run tests/bot-content-guard.test.ts`
Expected: PASS — P5 touched no bot-facing string, so nothing forbidden is present.

- [ ] **Step 3: Commit**

```bash
git add tests/bot-content-guard.test.ts
git commit -m "feat(P5): bot-content-guard extended — no corridor/compliance leakage to bot"
```

---

## Task 9: Wrap — full verification, PR, post-merge runbook

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (~455 tests). The pre-P5 suite staying green is the dormancy proof.

- [ ] **Step 2: Confirm the dormancy invariant by hand**

Verify, with all partners at `countries: ['US']` and no `corridorCompliance`:
- `resolveCorridorRules(<default>, 'US')` returns `GLOBAL_DEFAULTS` (Task 3 tests).
- `screenTransfer({...})` with no `rules`/`screener` reproduces today's `blocked`/`flagged`/`cleared` (Task 4 dormant cases).
- The default/USD `createTransfer` path produces today's `complianceStatus`/`complianceReasons` (Task 5 regression).
- `default` partner is byte-for-byte unchanged after the backfill (Task 6).
- No bot string mentions corridor/compliance internals (Task 8).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/p5-per-corridor-compliance
gh pr create --title "feat(P5): per-corridor compliance (pluggable, partner-gated, dormant)" --body "$(cat <<'EOF'
## Summary
- Compliance screening is now per-corridor (per source-country → IN) and pluggable, shipped fully DORMANT: every transfer today is US-source under the `default` partner with no override, so the resolved ruleset and screened result are byte-for-byte today's `compliance.ts` globals.
- New pure `resolveCorridorRules(partner, sourceCountry)` merges `GLOBAL_DEFAULTS` ← `CORRIDOR_DEFAULTS` (empty) ← `Partner.corridorCompliance` override.
- New pluggable `SanctionsScreener` seam + `MockSanctionsScreener` (mirrors the `KycProvider`/`MockKycProvider` pattern) — the seam a real provider (ComplyAdvantage/Sanctions.io) and the NEXT KYC batch reuse.
- `screenTransfer` is corridor-aware + async; its only caller (`transfer-create.ts`) gains a one-line `await`. Compliance still receives `q.amountUsd` (USD-equivalent).
- Sentinel-guarded cron backfill (`corridor-compliance-backfill-v1`) reserves the migration slot; `default` partner preserved byte-for-byte (no `corridorCompliance` written).
- Read-only resolved per-corridor rules card on `/dashboard/compliance` (scope-aware). Rule-creation UI deferred.

## Test plan
- [ ] typecheck / lint / vitest / build all green (~455 tests)
- [ ] Pre-P5 suite unchanged (dormancy proof): default/USD compliance result byte-for-byte today
- [ ] New unit tests: `resolveCorridorRules`, `MockSanctionsScreener`, corridor-override `screenTransfer`
- [ ] `bot-content-guard` extended — no corridor/compliance leakage to bot

## Out of scope (deferred)
- KYC tiered data-capture (NEXT batch — reuses this `SanctionsScreener` seam + `kycCapHintUsd` hook)
- Admin rule-creation UI (read-only display only this batch)
- Pre-calibrated non-US corridors (`CORRIDOR_DEFAULTS` ships empty), real sanctions provider integration
EOF
)"
```

- [ ] **Step 4: Confirm `ci / ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red on the known env-var-name false positive.)

- [ ] **Step 5: Post-merge runbook**

After merge → Vercel auto-deploys → Playwright smoke runs against prod. The corridor-compliance backfill is **claimed by the daily cron**: on the first `/api/cron` run after deploy, `backfillCorridorComplianceOnce` claims `'corridor-compliance-backfill-v1'`, finds the `default` partner has no `corridorCompliance`, **skips its write** (default untouched), and returns `{ partnersTouched: 0, skippedSentinel: false }`. Subsequent runs return `skippedSentinel: true`. No manual step. To enable a real corridor later: set `corridorCompliance` on that partner's Redis record (or via the future API) — no code change.

---

## Self-Review (completed by plan author)

**Spec coverage (tasks → spec sections):**
- §Component 1 (`CorridorComplianceRule` + `Partner.corridorCompliance`) → **Task 1**.
- §Component 2 (`compliance-config.ts` resolver, `GLOBAL_DEFAULTS`, empty `CORRIDOR_DEFAULTS`, `??`-merge, IN-key ignored, watchlist concat) → **Task 3**.
- §Component 3 (`SanctionsScreener` + `MockSanctionsScreener` + `getSanctionsScreener`, today's match semantics, `sourceCountry` plumbed-but-ignored) → **Task 2**.
- §Component 4 (corridor-aware async `screenTransfer`, optional `rules`/`screener`/`sourceCountry`, unchanged reason strings + precedence) → **Task 4**.
- §Component 5 (wiring through `transfer-create.ts`, only call site, `q.amountUsd`) → **Task 5**.
- §Component 6 (sentinel `'corridor-compliance-backfill-v1'`, cron wiring, default byte-for-byte) → **Task 6**.
- §Component 7 (read-only per-corridor dashboard card, scope-aware, deferred-UI note) → **Task 7**.
- §Security notes (bot stays partner/corridor-blind; read-only = no server action to harden) → **Task 8** + noted in Tasks 6/7.
- §Dormancy invariant → proven early (Task 3 `=== GLOBAL_DEFAULTS`), at the screen layer (Task 4), at the create layer (Task 5), at migration (Task 6); whole-suite-green gate (Task 9).
- §Testing strategy → every task's TDD steps + the new files `compliance-config.test.ts` / `sanctions-provider.test.ts` + the rewritten `compliance.test.ts`.
- §Open questions resolved: (1) screener under `src/lib/providers/` for symmetry — Task 2; (2) skip the write for no-corridor partners so `default` is literally untouched — Task 6; (3) async ripple confirmed single caller — Task 4 Step 5 / Task 5; (4) `CORRIDOR_DEFAULTS` ships empty — Task 3; (5) `kycCapHintUsd` kept as documented advisory hook — Task 1 + carried through Task 3.

**Placeholder scan:** No TBD/TODO. Every code step shows real, copy-pasteable code citing real symbols (`claimMigrationFlag`, `listPartners`, `createScopedStore`, `countryForCurrency`, `WATCHLIST`/`LARGE_AMOUNT_USD`/`VELOCITY_LIMIT`, the `KycProvider`/`MockKycProvider` files mirrored). The one deliberate red (Task 4 Step 5 typecheck failing at the single caller) is called out as the executable proof of spec risk #1 and fixed in Task 5.

**Type consistency:** `ResolvedCorridorRules { baseWatchlist, watchlistExtra, largeAmountUsd, velocityLimit, kycCapHintUsd? }`, `CorridorComplianceRule { watchlistExtra?, largeAmountUsd?, velocityLimit?, kycCapHintUsd? }`, `Partner.corridorCompliance?: Partial<Record<CountryCode, CorridorComplianceRule>>`, `SanctionsScreener.screen({ name, sourceCountry }): Promise<SanctionsHit>`, `SanctionsHit { matched, matchedName?, listSource? }`, `getSanctionsScreener(baseList: string[])`, `resolveCorridorRules(partner: Partner | null, sourceCountry: CountryCode): ResolvedCorridorRules`, `screenTransfer({ amountUsd, recipientName, transfersToday, sourceCountry?, rules?, screener? }): Promise<ComplianceResult>`, `createTransfer(store, partnerStore, input)`, `backfillCorridorComplianceOnce(store, partnerStore): { partnersTouched, skippedSentinel }` — names used identically across Tasks 1–9 and matching the spec's Architecture/Components blocks. No `as any`; `??` (never `||`) for every numeric/string merge; defensive `?? ''` / `?? []` on all Redis-resident strings/lists. ✓
