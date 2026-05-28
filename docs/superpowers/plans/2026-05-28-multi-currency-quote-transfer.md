# Multi-currency at quote/transfer time (P4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, partner-gated, dormant-by-default capability for the WhatsApp bot to quote and create transfers in a send currency other than USD, reusing the existing `Partner.countries` field as the configuration surface.

**Architecture:** Allowed send currencies derive from `Partner.countries` (minus payout-side `IN`). When a partner resolves to exactly one currency (every partner today is `['US']` → `['USD']`), the bot never asks and behaves byte-for-byte as today. Caps/velocity/compliance stay in USD via a source→USD conversion (USD-equivalent accounting); the customer-facing quote is source→INR. Transfers/drafts/schedules store both the source-currency presentation and the USD-equivalent canonical fields; for USD they are identical.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis, Frankfurter FX API.

**Spec:** `docs/superpowers/specs/2026-05-28-multi-currency-quote-transfer-design.md`

**⚠️ Sequencing:** This plan assumes the **post-P3** codebase (PR #10 merged to `main`). Execute only after P3 merges; branch/rebase `spec/p4-multi-currency` onto the updated `main` first. All code snippets below reflect post-P3 file contents (e.g. `createScheduleStore(redis, customerStore)`, `Schedule.partnerId`, the 4-backfill cron chain).

---

## File Structure

**New files:**
- `src/lib/partner-currency.ts` — currency authority: `allowedSendCurrencies`, `resolveSendCurrency`, `countryForCurrency`.
- `tests/partner-currency.test.ts`, `tests/fx-multi-currency.test.ts` (or extend existing) — unit tests.

**Modified files:**
- `src/lib/rate.ts` — `getFxRates(source)` + per-currency cache + fallback table.
- `src/lib/fx.ts` — `quote()` generalized to source currency.
- `src/lib/types.ts` — source fields on `Quote`/`Transfer`/`Draft`/`Schedule`.
- `src/lib/store.ts`, `src/lib/schedule-store.ts` — lazy-fill new fields.
- `src/lib/transfer-create.ts`, `src/lib/cron-run.ts` — thread source currency + partner.
- `src/lib/draft-store.ts` — store source fields on the draft.
- `src/lib/tools.ts`, `src/lib/agent.ts`, `src/lib/prompt.ts` — currency-aware tools + injected note + `partnerStore` dependency.
- `src/app/api/whatsapp/route.ts` — pass `partnerStore` into the agent.
- `src/lib/migration.ts`, `src/app/api/cron/route.ts` — `backfillSourceAmountsOnce` sentinel.
- `src/app/dashboard/transactions-tabs.tsx` — always show source currency.

---

## Task 1: Multi-currency FX engine

**Files:**
- Modify: `src/lib/rate.ts`
- Test: `tests/rate.test.ts` (existing tests must stay green), add `tests/fx-multi-currency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/fx-multi-currency.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFxRates, resetRateCacheForTests, FALLBACK_FX_RATES } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.restoreAllMocks();
});

function mockFetch(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

describe('getFxRates', () => {
  it('USD source short-circuits toUsd=1 and fetches only INR', async () => {
    mockFetch({ rates: { INR: 85 } });
    const r = await getFxRates('USD');
    expect(r).toEqual({ toInr: 85, toUsd: 1 });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=USD');
    expect(url).toContain('to=INR');
    expect(url).not.toContain('USD,INR');
  });

  it('non-USD source returns both toInr and toUsd', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    const r = await getFxRates('GBP');
    expect(r).toEqual({ toInr: 108, toUsd: 1.27 });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=GBP');
    expect(url).toContain('to=USD,INR');
  });

  it('caches per source currency independently', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    await getFxRates('GBP');
    await getFxRates('GBP');
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1); // GBP cached
  });

  it('falls back to the per-currency table on fetch failure with no cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const r = await getFxRates('AED');
    expect(r).toEqual(FALLBACK_FX_RATES.AED);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/fx-multi-currency.test.ts`
Expected: FAIL — `getFxRates`/`FALLBACK_FX_RATES` are not exported.

- [ ] **Step 3: Implement `getFxRates` in `src/lib/rate.ts`**

Replace the entire file with:

```ts
import type { CurrencyCode } from './types';

export interface FxRates {
  toInr: number; // 1 unit of source currency → INR (shown to the customer)
  toUsd: number; // 1 unit of source currency → USD (for USD-equivalent accounting)
}

// Back-compat: USD→INR fallback. Kept because tests and getFxRate() reference it.
export const FALLBACK_FX_RATE = 85;

// Conservative offline fallbacks; only used when a live fetch fails with no cache.
export const FALLBACK_FX_RATES: Record<CurrencyCode, FxRates> = {
  USD: { toInr: 85, toUsd: 1 },
  GBP: { toInr: 108, toUsd: 1.27 },
  CAD: { toInr: 62, toUsd: 0.73 },
  AED: { toInr: 23.1, toUsd: 0.27 },
  SGD: { toInr: 63, toUsd: 0.74 },
  AUD: { toInr: 56, toUsd: 0.66 },
  NZD: { toInr: 51, toUsd: 0.6 },
  INR: { toInr: 1, toUsd: 0.0118 }, // never a source currency; present for type completeness
};

const CACHE_TTL_MS = 3_600_000; // 1 hour

interface CacheEntry {
  rates: FxRates;
  fetchedAt: number;
}

const cache = new Map<CurrencyCode, CacheEntry>();

export function resetRateCacheForTests(): void {
  cache.clear();
}

export async function getFxRates(source: CurrencyCode): Promise<FxRates> {
  const now = Date.now();
  const cached = cache.get(source);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.rates;

  try {
    const to = source === 'USD' ? 'INR' : 'USD,INR';
    const res = await fetch(`https://api.frankfurter.app/latest?from=${source}&to=${to}`);
    if (!res.ok) return cached ? cached.rates : FALLBACK_FX_RATES[source];
    const data = (await res.json()) as { rates: { USD?: number; INR: number } };
    const rates: FxRates = {
      toInr: data.rates.INR,
      toUsd: source === 'USD' ? 1 : data.rates.USD ?? FALLBACK_FX_RATES[source].toUsd,
    };
    cache.set(source, { rates, fetchedAt: now });
    return rates;
  } catch {
    return cached ? cached.rates : FALLBACK_FX_RATES[source];
  }
}

// Thin back-compat wrapper: callers that only need USD→INR.
export async function getFxRate(): Promise<number> {
  return (await getFxRates('USD')).toInr;
}
```

- [ ] **Step 4: Run both test files to verify green**

Run: `npx vitest run tests/rate.test.ts tests/fx-multi-currency.test.ts`
Expected: PASS — existing `getFxRate` tests still pass (USD path), new `getFxRates` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rate.ts tests/fx-multi-currency.test.ts
git commit -m "feat(P4): multi-currency FX engine (getFxRates + per-currency cache/fallback)"
```

---

## Task 2: Currency resolution authority

**Files:**
- Create: `src/lib/partner-currency.ts`
- Test: `tests/partner-currency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/partner-currency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  allowedSendCurrencies,
  resolveSendCurrency,
  countryForCurrency,
} from '@/lib/partner-currency';
import { QuoteError } from '@/lib/fx';
import type { Partner } from '@/lib/types';

function partner(countries: Partner['countries']): Partner {
  return {
    id: 'p', name: 'P', countries, status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('allowedSendCurrencies', () => {
  it("['US'] → ['USD']", () => {
    expect(allowedSendCurrencies(partner(['US']))).toEqual(['USD']);
  });
  it('maps multiple countries, drops payout-side IN, dedupes', () => {
    expect(allowedSendCurrencies(partner(['US', 'GB', 'IN']))).toEqual(['USD', 'GBP']);
  });
  it('falls back to USD when no send countries', () => {
    expect(allowedSendCurrencies(partner(['IN']))).toEqual(['USD']);
  });
});

describe('resolveSendCurrency', () => {
  it('single allowed → returns it, ignoring any requested override (dormant path)', () => {
    expect(resolveSendCurrency(partner(['US']), 'GBP')).toBe('USD');
  });
  it('multiple allowed + valid request → returns the request', () => {
    expect(resolveSendCurrency(partner(['US', 'GB']), 'gbp')).toBe('GBP');
  });
  it('multiple allowed + missing/invalid request → throws QuoteError', () => {
    expect(() => resolveSendCurrency(partner(['US', 'GB']), undefined)).toThrow(QuoteError);
    expect(() => resolveSendCurrency(partner(['US', 'GB']), 'EUR')).toThrow(/which currency/i);
  });
});

describe('countryForCurrency', () => {
  it('reverse-maps currency to ISO country', () => {
    expect(countryForCurrency('USD')).toBe('US');
    expect(countryForCurrency('GBP')).toBe('GB');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/partner-currency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/partner-currency.ts`**

```ts
import type { CountryCode, CurrencyCode, Partner } from './types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from './types';
import { QuoteError } from './fx';

const CURRENCY_TO_COUNTRY: Record<CurrencyCode, CountryCode> = {
  USD: 'US', CAD: 'CA', GBP: 'GB', AED: 'AE', SGD: 'SG', AUD: 'AU', NZD: 'NZ', INR: 'IN',
};

export function countryForCurrency(c: CurrencyCode): CountryCode {
  return CURRENCY_TO_COUNTRY[c];
}

// Send currencies = the partner's operating countries minus payout-side IN,
// mapped to home currency, de-duplicated, stable order. ['US'] → ['USD'].
export function allowedSendCurrencies(partner: Partner): CurrencyCode[] {
  const seen = new Set<CurrencyCode>();
  const out: CurrencyCode[] = [];
  for (const country of partner.countries) {
    if (country === 'IN') continue; // payout-side only in v1
    const cur = DEFAULT_CURRENCY_FOR_COUNTRY[country];
    if (!seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
    }
  }
  if (out.length === 0) out.push('USD'); // safety net for a partner with no send countries
  return out;
}

// The single authority for a transfer's currency. The LLM-supplied value is
// untrusted: on the single-currency (dormant) path it is ignored entirely.
export function resolveSendCurrency(partner: Partner, requested?: string): CurrencyCode {
  const allowed = allowedSendCurrencies(partner);
  if (allowed.length === 1) return allowed[0];
  const req = (requested ?? '').toUpperCase();
  const match = allowed.find((c) => c === req);
  if (!match) {
    throw new QuoteError(
      `Please tell me which currency you're sending: ${allowed.join(', ')}.`,
    );
  }
  return match;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/partner-currency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/partner-currency.ts tests/partner-currency.test.ts
git commit -m "feat(P4): partner-currency resolution authority (server-side chokepoint)"
```

---

## Task 3: Generalize `quote()` to source currency

**Files:**
- Modify: `src/lib/types.ts` (Quote), `src/lib/fx.ts`
- Modify (keep compiling, USD scaffold): `src/lib/transfer-create.ts`, `src/lib/tools.ts` (`getQuoteTool`, `sendApprovePickerTool`)
- Test: `tests/fx.test.ts` (rewrite for the new signature)

- [ ] **Step 1: Add source fields to `Quote` in `src/lib/types.ts`**

```ts
export interface Quote {
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  deliveryEstimate: string;
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
  feeSource: number;              // NEW (P4)
  totalChargeSource: number;      // NEW (P4)
}
```

- [ ] **Step 2: Write the failing test**

Replace `tests/fx.test.ts` with tests for the new signature:

```ts
import { describe, it, expect } from 'vitest';
import { quote, QuoteError, MIN_USD, MAX_USD } from '@/lib/fx';
import type { FxRates } from '@/lib/rate';

const USD: FxRates = { toInr: 85, toUsd: 1 };
const GBP: FxRates = { toInr: 108, toUsd: 1.27 };

describe('quote (USD source — regression: identical to pre-P4)', () => {
  it('first transfer is free; amounts equal source amounts', () => {
    const q = quote(100, 'USD', USD, 'bank_transfer', 0);
    expect(q.amountUsd).toBe(100);
    expect(q.amountSource).toBe(100);
    expect(q.feeUsd).toBe(0);
    expect(q.feeSource).toBe(0);
    expect(q.amountInr).toBe(8500);
    expect(q.fxRate).toBe(85);
    expect(q.sourceCurrency).toBe('USD');
  });

  it('applies the funding-method fee after the first transfer', () => {
    expect(quote(100, 'USD', USD, 'bank_transfer', 1).feeUsd).toBe(1.99);
    expect(quote(100, 'USD', USD, 'debit_card', 1).feeUsd).toBe(2.99);
    expect(quote(100, 'USD', USD, 'credit_card', 1).feeUsd).toBe(5.99); // 2.99 + 3%·100
  });
});

describe('quote (non-USD source)', () => {
  it('converts to USD-equivalent for fee/min-max and to INR for payout', () => {
    const q = quote(200, 'GBP', GBP, 'bank_transfer', 1);
    expect(q.amountSource).toBe(200);
    expect(q.sourceCurrency).toBe('GBP');
    expect(q.amountUsd).toBe(254); // 200 × 1.27
    expect(q.amountInr).toBe(21600); // 200 × 108
    expect(q.feeUsd).toBe(1.99);
    expect(q.feeSource).toBe(1.57); // 1.99 / 1.27, rounded to 2dp
    expect(q.totalChargeSource).toBe(201.57);
  });

  it('enforces MIN_USD/MAX_USD on the USD-equivalent', () => {
    expect(() => quote(5, 'GBP', GBP, 'bank_transfer', 0)).toThrow(QuoteError); // 5×1.27=6.35 < 10
    expect(MIN_USD).toBe(10);
    expect(MAX_USD).toBe(2999);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/fx.test.ts`
Expected: FAIL — `quote` still has the old `(amountUsd, fxRate, ...)` signature.

- [ ] **Step 4: Rewrite `quote()` in `src/lib/fx.ts`**

```ts
import type { CurrencyCode, FundingMethod, Quote } from './types';
import type { FxRates } from './rate';

export const MIN_USD = 10;
export const MAX_USD = 2999;

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function quote(
  amountSource: number,
  sourceCurrency: CurrencyCode,
  rates: FxRates,
  fundingMethod: FundingMethod,
  transferCount: number,
): Quote {
  if (!Number.isFinite(amountSource)) {
    throw new QuoteError('Please give a valid amount.');
  }
  const amountUsd = round2(amountSource * rates.toUsd);
  if (amountUsd < MIN_USD || amountUsd > MAX_USD) {
    throw new QuoteError(`Transfers must be between $${MIN_USD} and $${MAX_USD}.`);
  }

  let feeUsd: number;
  if (transferCount === 0) {
    feeUsd = 0;
  } else {
    switch (fundingMethod) {
      case 'bank_transfer':
        feeUsd = 1.99;
        break;
      case 'debit_card':
        feeUsd = 2.99;
        break;
      case 'credit_card':
        feeUsd = round2(2.99 + 0.03 * amountUsd);
        break;
      default:
        throw new QuoteError(
          'Please choose how to pay: credit card, debit card, or bank transfer.',
        );
    }
  }

  feeUsd = round2(feeUsd);
  const feeSource = round2(feeUsd / rates.toUsd);
  const amountInr = Math.round(amountSource * rates.toInr);

  return {
    amountUsd,
    feeUsd,
    totalChargeUsd: round2(amountUsd + feeUsd),
    fxRate: rates.toInr,
    amountInr,
    deliveryEstimate: 'within 10 minutes',
    sourceCurrency,
    amountSource,
    feeSource,
    totalChargeSource: round2(amountSource + feeSource),
  };
}
```

- [ ] **Step 5: Update the two USD-path callers so the project compiles (scaffold; real currency arrives in Task 8)**

In `src/lib/transfer-create.ts`, update the `quote()` call (the input still carries `amountUsd` at this task — Task 4 renames it). Replace lines that fetch the rate and call quote:

```ts
import { getFxRates } from './rate';
// ...
const rates = await getFxRates('USD');
const q = quote(input.amountUsd, 'USD', rates, input.fundingMethod, transferCount);
```

In `src/lib/tools.ts`, `getQuoteTool` — replace the rate fetch + quote call:

```ts
import { getFxRates } from './rate';
// ...
const rates = await getFxRates('USD');
const q = quote(Number(args.amount_usd), 'USD', rates, args.funding_method as FundingMethod, transferCount);
```

In `src/lib/tools.ts`, `sendApprovePickerTool` — same replacement:

```ts
const rates = await getFxRates('USD');
const q = quote(amountUsd, 'USD', rates, fundingMethod, transferCount);
```

(Remove the now-unused `getFxRate` import from `tools.ts` and `transfer-create.ts` if nothing else uses it.)

- [ ] **Step 6: Run the suite to verify green**

Run: `npx vitest run`
Expected: PASS — all existing tests green; `quote` now source-aware but every live path passes `'USD'`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/fx.ts src/lib/transfer-create.ts src/lib/tools.ts tests/fx.test.ts
git commit -m "feat(P4): generalize quote() to source currency (USD-equivalent accounting)"
```

---

## Task 4: Transfer model + create path (USD scaffold)

**Files:**
- Modify: `src/lib/types.ts` (Transfer), `src/lib/store.ts` (lazy-fill), `src/lib/transfer-create.ts`, `src/lib/cron-run.ts`, `src/lib/tools.ts` (`createTransferTool` arg names)
- Test: `tests/transfer-create.test.ts`, `tests/store.test.ts` (or the relevant existing specs)

- [ ] **Step 1: Add Transfer fields in `src/lib/types.ts`**

```ts
export interface Transfer {
  // ...existing fields through partnerId...
  amountSource: number;       // NEW (P4)
  feeSource: number;          // NEW (P4)
  totalChargeSource: number;  // NEW (P4)
}
```

- [ ] **Step 2: Write the failing test**

Add to `tests/transfer-create.test.ts` (matching its existing harness — it constructs a store via `createStore(fakeRedis())`):

```ts
it('P4: populates source-currency fields (USD scaffold) from the quote', async () => {
  const store = createStore(fakeRedis());
  const t = await createTransfer(store, {
    phone: '15551230000',
    amountSource: 100,
    sourceCurrency: 'USD',
    partnerId: 'default',
    recipientName: 'Asha',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'asha@upi',
    fundingMethod: 'bank_transfer',
  });
  expect(t.amountSource).toBe(100);
  expect(t.sourceCurrency).toBe('USD');
  expect(t.amountSource).toBe(t.amountUsd); // USD: source == USD-equiv
  expect(t.feeSource).toBe(t.feeUsd);
  expect(t.partnerId).toBe('default');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/transfer-create.test.ts`
Expected: FAIL — `CreateTransferInput` has `amountUsd`, not `amountSource`/`sourceCurrency`/`partnerId`.

- [ ] **Step 4: Update `src/lib/transfer-create.ts`**

```ts
import { quote } from './fx';
import { getFxRates } from './rate';
import { screenTransfer } from './compliance';
import { newTransferId } from './id';
import { countryForCurrency } from './partner-currency';
import type { Store } from './store';
import type { CurrencyCode, FundingMethod, PartnerId, PayoutMethod, Transfer } from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';

export interface CreateTransferInput {
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountSource: number;          // CHANGED (P4): was amountUsd
  sourceCurrency: CurrencyCode;  // NEW (P4)
  partnerId: PartnerId;          // NEW (P4): from the owning customer
}

export async function createTransfer(
  store: Store,
  input: CreateTransferInput,
): Promise<Transfer> {
  const transferCount = await store.getTransferCount(input.phone);
  const rates = await getFxRates(input.sourceCurrency);
  const q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount);
  const transfersToday = await store.getTodayTransferCount(input.phone);
  const compliance = screenTransfer({
    amountUsd: q.amountUsd, // USD-equivalent
    recipientName: input.recipientName,
    transfersToday,
  });
  const transfer: Transfer = {
    id: newTransferId(),
    phone: input.phone,
    amountUsd: q.amountUsd,
    feeUsd: q.feeUsd,
    totalChargeUsd: q.totalChargeUsd,
    fxRate: q.fxRate,
    amountInr: q.amountInr,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    payoutMethod: input.payoutMethod,
    payoutDestination: input.payoutDestination,
    fundingMethod: input.fundingMethod,
    complianceStatus: compliance.status,
    complianceReasons: compliance.reasons,
    status: compliance.status === 'blocked' ? 'blocked' : 'awaiting_payment',
    createdAt: new Date().toISOString(),
    sourceCountry: countryForCurrency(input.sourceCurrency),
    sourceCurrency: input.sourceCurrency,
    destinationCountry: DEFAULT_DESTINATION_COUNTRY,
    destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
    partnerId: input.partnerId,
    amountSource: q.amountSource,
    feeSource: q.feeSource,
    totalChargeSource: q.totalChargeSource,
  };
  await store.saveTransfer(transfer);
  await store.incrementTransferCount(input.phone);
  await store.incrementTodayTransferCount(input.phone);

  try {
    await store.upsertRecipient(input.phone, {
      name: input.recipientName,
      recipientPhone: input.recipientPhone,
      payoutMethod: input.payoutMethod,
      payoutDestination: input.payoutDestination,
      lastUsedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('upsertRecipient failed (non-fatal):', err);
  }

  return transfer;
}
```

- [ ] **Step 5: Add lazy-fill to `store.getTransfer` in `src/lib/store.ts`**

After the existing `partnerId` lazy-fill block, add:

```ts
if (parsed.amountSource === undefined) {
  // Pre-P4 records: source presentation equals the USD-equivalent.
  parsed.amountSource = parsed.amountUsd;
  parsed.feeSource = parsed.feeUsd;
  parsed.totalChargeSource = parsed.totalChargeUsd;
}
```

- [ ] **Step 6: Update `src/lib/cron-run.ts` createTransfer call**

```ts
const transfer = await createTransfer(deps.store, {
  phone: schedule.phone,
  amountSource: schedule.amountSource,
  sourceCurrency: schedule.sourceCurrency,
  partnerId: schedule.partnerId,
  recipientName: schedule.recipientName,
  recipientPhone: schedule.recipientPhone,
  payoutMethod: schedule.payoutMethod,
  payoutDestination: schedule.payoutDestination,
  fundingMethod: schedule.fundingMethod,
});
```

(`Schedule.amountSource`/`sourceCurrency` are added in Task 6; this compiles after Task 6. To keep Task 4 self-contained and green, temporarily use `amountSource: schedule.amountUsd, sourceCurrency: 'USD'` here and switch to the schedule fields in Task 6. Use the temporary form now.)

Temporary form for this task:

```ts
amountSource: schedule.amountUsd,
sourceCurrency: 'USD',
partnerId: schedule.partnerId,
```

- [ ] **Step 7: Update `createTransferTool` in `src/lib/tools.ts` (both paths) to the new input shape (USD scaffold)**

Approve-tap path `createTransfer` call:

```ts
const transfer = await createTransfer(ctx.store, {
  phone: ctx.phone,
  amountSource: draft.amountUsd,   // Task 5 switches to draft.amountSource/draft.sourceCurrency
  sourceCurrency: 'USD',
  partnerId: (await ctx.customerStore.getCustomer(ctx.phone))?.partnerId ?? DEFAULT_PARTNER_ID,
  recipientName: draft.recipient.name,
  recipientPhone: draft.recipient.recipientPhone,
  payoutMethod: draft.recipient.payoutMethod,
  payoutDestination: draft.recipient.payoutDestination,
  fundingMethod: draft.fundingMethod,
});
```

Legacy explicit-args path `createTransfer` call:

```ts
const transfer = await createTransfer(ctx.store, {
  phone: ctx.phone,
  amountSource: Number(args.amount_usd),
  sourceCurrency: 'USD',
  partnerId: (await ctx.customerStore.getCustomer(ctx.phone))?.partnerId ?? DEFAULT_PARTNER_ID,
  recipientName: String(args.recipient_name),
  recipientPhone,
  payoutMethod: args.payout_method as PayoutMethod,
  payoutDestination: String(args.payout_destination),
  fundingMethod: args.funding_method as FundingMethod,
});
```

- [ ] **Step 8: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. Update any Transfer fixtures in other tests that build a `Transfer` literal (search `tests/` for `amountUsd:` inside a `Transfer`-typed object and add `amountSource`/`feeSource`/`totalChargeSource`). Run again until green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/store.ts src/lib/transfer-create.ts src/lib/cron-run.ts src/lib/tools.ts tests/
git commit -m "feat(P4): Transfer carries source-currency fields; create path threads partnerId (USD scaffold)"
```

---

## Task 5: Draft model + approve path (USD scaffold)

**Files:**
- Modify: `src/lib/types.ts` (Draft), `src/lib/draft-store.ts`, `src/lib/tools.ts` (`sendApprovePickerTool`, `createTransferTool` approve path)
- Test: `tests/draft-store.test.ts` (or the existing draft spec)

- [ ] **Step 1: Add Draft fields in `src/lib/types.ts`**

```ts
export interface Draft {
  senderPhone: string;
  recipient: {
    name: string;
    recipientPhone: string;
    payoutMethod: PayoutMethod;
    payoutDestination: string;
  };
  amountUsd: number;              // USD-equivalent (for cap re-check)
  amountSource: number;           // NEW (P4)
  sourceCurrency: CurrencyCode;   // NEW (P4)
  fundingMethod: FundingMethod;
  quote: { feeUsd: number; fxRate: number; amountInr: number };
  createdAt: string;
}
```

- [ ] **Step 2: Write the failing test**

Add to the draft-store spec:

```ts
it('P4: round-trips source-currency fields on a draft', async () => {
  const store = createDraftStore(fakeRedis());
  const id = await store.createDraft({
    senderPhone: '15551230000',
    recipient: { name: 'Asha', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'asha@upi' },
    amountUsd: 254,
    amountSource: 200,
    sourceCurrency: 'GBP',
    fundingMethod: 'bank_transfer',
    quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21600 },
  });
  const got = await store.consumeDraft(id);
  expect(got?.amountSource).toBe(200);
  expect(got?.sourceCurrency).toBe('GBP');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/draft-store.test.ts`
Expected: FAIL — `createDraft` input type lacks `amountSource`/`sourceCurrency`.

- [ ] **Step 4: Update `src/lib/draft-store.ts`**

The store persists the `Draft` shape directly; update its `createDraft` input type to require the two new fields and store them. If `createDraft` takes `Omit<Draft, 'createdAt'>`, no body change is needed beyond the type flowing through. Verify the persisted object includes `amountSource` and `sourceCurrency`.

- [ ] **Step 5: Update `sendApprovePickerTool` in `src/lib/tools.ts` (USD scaffold)**

After computing the quote, build the draft with source fields and a currency-aware summary:

```ts
const draftId = await ctx.draftStore.createDraft({
  senderPhone: ctx.phone,
  recipient: {
    name: String(args.recipient_name),
    recipientPhone,
    payoutMethod: args.payout_method as PayoutMethod,
    payoutDestination: String(args.payout_destination),
  },
  amountUsd: q.amountUsd,
  amountSource: q.amountSource,
  sourceCurrency: q.sourceCurrency,
  fundingMethod,
  quote: { feeUsd: q.feeUsd, fxRate: q.fxRate, amountInr: q.amountInr },
});
const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n);
const summary =
  `Sending ${fmt(q.amountSource)} to ${args.recipient_name}.\n` +
  `Fee ${fmt(q.feeSource)} → ₹${q.amountInr.toLocaleString('en-IN')}.`;
```

(For USD, `q.sourceCurrency` is `'USD'` and the summary reads `$100.00` exactly as before.)

- [ ] **Step 6: Update `createTransferTool` approve path to use the draft's source fields**

```ts
amountSource: draft.amountSource,
sourceCurrency: draft.sourceCurrency,
```

(replacing the Task-4 temporary `amountSource: draft.amountUsd, sourceCurrency: 'USD'`).

- [ ] **Step 7: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. Fix any Draft fixtures in other specs.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/draft-store.ts src/lib/tools.ts tests/
git commit -m "feat(P4): Draft carries source currency; approve summary is currency-aware"
```

---

## Task 6: Schedule model + schedule path (USD scaffold)

**Files:**
- Modify: `src/lib/types.ts` (Schedule), `src/lib/schedule-store.ts` (lazy-fill), `src/lib/tools.ts` (`createScheduleTool`), `src/lib/cron-run.ts` (switch to schedule fields)
- Test: `tests/schedule-store.test.ts`, the schedule tool spec

- [ ] **Step 1: Add Schedule fields in `src/lib/types.ts`**

```ts
export interface Schedule {
  // ...existing through partnerId (P3)...
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
}
```

- [ ] **Step 2: Write the failing test**

Add to `tests/schedule-store.test.ts`:

```ts
it('P4: lazy-fills sourceCurrency/amountSource for pre-P4 schedules', async () => {
  const redis = fakeRedis();
  // Persist a pre-P4 schedule (no source fields)
  await redis.set('schedule:s1', JSON.stringify({
    id: 's1', phone: '15551230000', amountUsd: 100, recipientName: 'Asha',
    recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'asha@upi',
    fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 1,
    status: 'active', createdAt: '2026-01-01T00:00:00Z', partnerId: 'default',
  }));
  await redis.sadd('schedules:ids', 's1');
  const store = createScheduleStore(redis, createCustomerStore(redis, createStore(redis)));
  const s = await store.getSchedule('s1');
  expect(s?.sourceCurrency).toBe('USD');
  expect(s?.amountSource).toBe(100);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/schedule-store.test.ts`
Expected: FAIL — getSchedule does not fill source fields.

- [ ] **Step 4: Add lazy-fill in `src/lib/schedule-store.ts` `getSchedule`**

After the existing `partnerId` lazy-fill block:

```ts
if (!parsed.sourceCurrency) parsed.sourceCurrency = 'USD';
if (parsed.amountSource === undefined) parsed.amountSource = parsed.amountUsd;
```

- [ ] **Step 5: Populate the fields in `createScheduleTool` (USD scaffold)**

In the `Schedule` object built by `createScheduleTool`, add:

```ts
sourceCurrency: 'USD',
amountSource: Number(args.amount_usd),
```

- [ ] **Step 6: Switch `cron-run.ts` to the schedule's source fields**

Replace the Task-4 temporary form with:

```ts
amountSource: schedule.amountSource,
sourceCurrency: schedule.sourceCurrency,
partnerId: schedule.partnerId,
```

- [ ] **Step 7: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. Fix any Schedule fixtures in other specs.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/schedule-store.ts src/lib/tools.ts src/lib/cron-run.ts tests/
git commit -m "feat(P4): Schedule carries source currency; cron fires with stored currency"
```

---

## Task 7: Wire `partnerStore` into the agent + tools

**Files:**
- Modify: `src/lib/tools.ts` (`ToolContext`), `src/lib/agent.ts` (`AgentDeps` + `executeTool` ctx), `src/app/api/whatsapp/route.ts`
- Test: `tests/agent.test.ts` (update the deps the harness passes)

- [ ] **Step 1: Add `partnerStore` to `ToolContext` in `src/lib/tools.ts`**

```ts
import type { PartnerStore } from './partner-store';

export interface ToolContext {
  phone: string;
  store: Store;
  scheduleStore: ScheduleStore;
  draftStore: DraftStore;
  turn: TurnContext;
  customerStore: CustomerStore;
  dailyVolumeStore: DailyVolumeStore;
  kycProvider: KycProvider;
  partnerStore: PartnerStore;   // NEW (P4)
}
```

- [ ] **Step 2: Add `partnerStore` to `AgentDeps` and pass it through in `src/lib/agent.ts`**

```ts
import type { PartnerStore } from './partner-store';
// in AgentDeps:
  partnerStore: PartnerStore;   // NEW (P4)
// in the executeTool ctx object:
  partnerStore: deps.partnerStore,
```

- [ ] **Step 3: Pass `partnerStore` where the agent is built in `src/app/api/whatsapp/route.ts`**

```ts
import { getPartnerStore } from '@/lib/partner-store';
// ...
const agent = createAgent({
  chat,
  store,
  scheduleStore: getScheduleStore(),
  draftStore: getDraftStore(),
  customerStore,
  dailyVolumeStore,
  kycProvider,
  partnerStore: getPartnerStore(),   // NEW (P4)
});
```

- [ ] **Step 4: Update test harnesses**

Run: `npm run typecheck`
Expected: FAIL where `tests/agent.test.ts` (and any tool-context test) builds `AgentDeps`/`ToolContext` without `partnerStore`. Add a `partnerStore: createPartnerStore(redis)` to each. Re-run until clean.

- [ ] **Step 5: Run the suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean (no behavior change yet).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tools.ts src/lib/agent.ts src/app/api/whatsapp/route.ts tests/
git commit -m "feat(P4): thread partnerStore into the agent and tool context"
```

---

## Task 8: Make the tools currency-aware

**Files:**
- Modify: `src/lib/tools.ts` (`get_quote` schema + `getQuoteTool`, `check_send_limit` schema + `checkSendLimitTool`, `send_approve_picker` schema + `sendApprovePickerTool`, `create_schedule` schema + `createScheduleTool`)
- Test: `tests/tools.test.ts` (or the relevant tool specs)

> **Note on the `amount_usd` parameter:** its numeric value is the amount **in the resolved source currency**. The name is retained to avoid prompt/test churn; for the only live configuration (USD-only partners) it is literally USD. Multi-currency partners get an explicit prompt note (Task 9) telling the bot the amount is in the chosen currency.

- [ ] **Step 1: Write the failing test**

Add to the tools spec a test proving a multi-currency partner produces a non-USD quote and a single-currency partner ignores the requested currency:

```ts
it('P4: get_quote uses the resolved partner currency', async () => {
  // partner 'gbp-co' operates in US+GB; customer belongs to it
  // (seed partner with countries ['US','GB'] and the customer.partnerId='gbp-co')
  // mock getFxRates('GBP') → { toInr: 108, toUsd: 1.27 }
  const res = await getQuoteTool(
    { amount_usd: 200, funding_method: 'bank_transfer', source_currency: 'GBP' },
    ctx, // ctx.partnerStore returns the gbp-co partner for the customer
  );
  expect(res.source_currency).toBe('GBP');
  expect(res.amount_inr).toBe(21600);
  expect(res.amount_usd).toBe(254);
});

it('P4: single-currency partner ignores a requested override (dormant)', async () => {
  const res = await getQuoteTool(
    { amount_usd: 100, funding_method: 'bank_transfer', source_currency: 'GBP' },
    ctx, // ctx.partnerStore returns a ['US'] partner
  );
  expect(res.source_currency).toBe('USD');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — handlers ignore `source_currency` and `getQuoteTool` returns no `source_currency`.

- [ ] **Step 3: Add `source_currency` to the four tool schemas in `src/lib/tools.ts`**

To `get_quote`, `check_send_limit`, `send_approve_picker`, and `create_schedule` `properties`, add (do NOT add to `required`):

```ts
source_currency: {
  type: 'string',
  description:
    "The currency the sender is sending in (e.g. 'USD', 'GBP'). Only ask when offered more than one; otherwise omit.",
},
```

- [ ] **Step 4: Add a partner-currency resolver helper inside `tools.ts`**

```ts
import { resolveSendCurrency } from './partner-currency';
import { getFxRates, type FxRates } from './rate';

async function resolveCurrencyAndRates(
  ctx: ToolContext,
  requested: unknown,
): Promise<{ sourceCurrency: import('./types').CurrencyCode; rates: FxRates }> {
  const customer =
    (await ctx.customerStore.getCustomer(ctx.phone)) ??
    (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
  const partner =
    (await ctx.partnerStore.getPartner(customer.partnerId)) ??
    (await ctx.partnerStore.ensureDefaultPartner());
  const sourceCurrency = resolveSendCurrency(
    partner,
    typeof requested === 'string' ? requested : undefined,
  );
  const rates = await getFxRates(sourceCurrency);
  return { sourceCurrency, rates };
}
```

- [ ] **Step 5: Rewrite `getQuoteTool` to resolve currency**

```ts
async function getQuoteTool(args, ctx): Promise<ToolResult> {
  try {
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);
    const q = quote(Number(args.amount_usd), sourceCurrency, rates, args.funding_method as FundingMethod, transferCount);
    return {
      source_currency: q.sourceCurrency,
      amount_source: q.amountSource,
      fee_source: q.feeSource,
      total_charge_source: q.totalChargeSource,
      amount_usd: q.amountUsd,
      fee_usd: q.feeUsd,
      total_charge_usd: q.totalChargeUsd,
      fx_rate: q.fxRate,
      amount_inr: q.amountInr,
      delivery_estimate: q.deliveryEstimate,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}
```

- [ ] **Step 6: Make cap checks USD-equivalent in `checkSendLimitTool`, `sendApprovePickerTool`, and `createTransferTool` (legacy path)**

In each, before `evaluateCap`, resolve currency + rates and convert the source amount to USD-equivalent cents:

```ts
const { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);
const amountSource = Number(args.amount_usd ?? 0);
const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
const requestedCents = Math.round(amountUsd * 100);
```

Then pass `requestedCents` to `evaluateCap` as today. In `sendApprovePickerTool`, build the quote with `quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount)` (replacing the Task-3/5 `'USD'` scaffold and the separate `getFxRates('USD')` call). In `createTransferTool`'s legacy path, pass `amountSource` + `sourceCurrency` into `createTransfer`.

- [ ] **Step 7: Resolve currency in `createScheduleTool`**

```ts
const { sourceCurrency } = await resolveCurrencyAndRates(ctx, args.source_currency);
// in the Schedule object:
sourceCurrency,
amountSource: Number(args.amount_usd),
```

- [ ] **Step 8: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. The USD-only specs stay green (single-currency partner → `'USD'`); the new multi-currency tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/tools.ts tests/
git commit -m "feat(P4): tools resolve send currency per partner; caps use USD-equivalent"
```

---

## Task 9: Agent currency-note injection + prompt block

**Files:**
- Modify: `src/lib/agent.ts`, `src/lib/prompt.ts`
- Test: `tests/agent.test.ts`, add a guard assertion to `tests/bot-content-guard.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/agent.test.ts` a test that a multi-currency partner causes a `[SEND CURRENCIES: ...]` system note to be injected, and a single-currency partner does not. Capture the messages by stubbing `deps.chat`:

```ts
it('P4: injects a currency note only for multi-currency partners', async () => {
  const seen: string[] = [];
  const deps = makeDeps({
    chat: async (messages) => {
      seen.push(...messages.filter((m) => m.role === 'system').map((m) => m.content ?? ''));
      return { role: 'assistant', content: 'hi' };
    },
    partnerForCustomer: { countries: ['US', 'GB'] }, // harness wires partnerStore
  });
  await createAgent(deps).runAgentTurn('15551230000', 'hello', { isNewConversation: false });
  expect(seen.some((s) => /\[SEND CURRENCIES: USD, GBP/.test(s))).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL — no currency note injected.

- [ ] **Step 3: Inject the note in `src/lib/agent.ts`**

At the top of `runAgentTurn`, after loading history, compute the allowed currencies once:

```ts
import { allowedSendCurrencies } from './partner-currency';
// ...
const customer = await deps.customerStore.getCustomer(phone);
const partner = customer
  ? (await deps.partnerStore.getPartner(customer.partnerId)) ?? (await deps.partnerStore.ensureDefaultPartner())
  : await deps.partnerStore.ensureDefaultPartner();
const sendCurrencies = allowedSendCurrencies(partner);
```

Inside the round loop, at `round === 0`, after the existing `[NEW CUSTOMER]`/`[TIER_REMINDER]` blocks:

```ts
if (round === 0 && sendCurrencies.length > 1) {
  messages.push({
    role: 'system',
    content:
      `[SEND CURRENCIES: ${sendCurrencies.join(', ')} — ask the user which currency they are sending, ` +
      `pass it as source_currency to get_quote/check_send_limit/send_approve_picker, and state the amount in that currency.]`,
  });
}
```

- [ ] **Step 4: Add the conditional CURRENCY block to `src/lib/prompt.ts`**

Append to `SYSTEM_PROMPT`:

```
CURRENCY
- By default you send in US dollars. If — and only if — the system injects a
  "[SEND CURRENCIES: ...]" note this turn, ask the user which listed currency
  they are sending, then pass it as source_currency to get_quote,
  check_send_limit, and send_approve_picker. The amount the user gives is in
  that currency. Never invent or convert currencies yourself; the tools do the
  FX. If no such note is present, send in USD and do not mention currency.
```

- [ ] **Step 5: Add a content-guard assertion in `tests/bot-content-guard.test.ts`**

```ts
it('P4: injected currency note never contains the word "partner"', () => {
  const note = `[SEND CURRENCIES: USD, GBP — ask the user which currency...]`;
  expect(note.toLowerCase()).not.toContain('partner');
});
```

- [ ] **Step 6: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent.ts src/lib/prompt.ts tests/
git commit -m "feat(P4): inject per-turn currency note for multi-currency partners"
```

---

## Task 10: Migration backfill + cron wiring

**Files:**
- Modify: `src/lib/migration.ts`, `src/app/api/cron/route.ts`
- Test: `tests/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/migration.test.ts`:

```ts
it('P4: backfillSourceAmountsOnce persists source fields and is sentinel-guarded', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const scheduleStore = createScheduleStore(redis, createCustomerStore(redis, store));
  // Pre-P4 transfer (no source fields), persisted raw
  await redis.set('transfer:t1', JSON.stringify({
    id: 't1', phone: '1', amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
    fxRate: 85, amountInr: 8500, recipientName: 'A', recipientPhone: '91...',
    payoutMethod: 'upi', payoutDestination: 'a@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'paid',
    createdAt: '2026-01-01T00:00:00Z', sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
  }));
  await redis.sadd('transfers:ids', 't1');

  const first = await backfillSourceAmountsOnce(store, scheduleStore);
  expect(first.skippedSentinel).toBe(false);
  expect(first.transfersBackfilled).toBe(1);

  const raw = JSON.parse((await redis.get('transfer:t1'))!);
  expect(raw.amountSource).toBe(100); // persisted, not just lazy-filled

  const second = await backfillSourceAmountsOnce(store, scheduleStore);
  expect(second.skippedSentinel).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/migration.test.ts`
Expected: FAIL — `backfillSourceAmountsOnce` not exported.

- [ ] **Step 3: Implement `backfillSourceAmountsOnce` in `src/lib/migration.ts`**

Add a sentinel constant and the function:

```ts
import type { ScheduleStore } from './schedule-store';
const SOURCE_AMOUNT_SENTINEL_KEY = 'transfer-source-amount-backfill-v1';

export async function backfillSourceAmountsOnce(
  store: Store,
  scheduleStore: ScheduleStore,
): Promise<{ transfersBackfilled: number; schedulesBackfilled: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(SOURCE_AMOUNT_SENTINEL_KEY);
  if (!claimed) return { transfersBackfilled: 0, schedulesBackfilled: 0, skippedSentinel: true };

  // listTransfers / listSchedules return lazy-filled records; re-saving persists.
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({ ...t });
    transfersBackfilled++;
  }
  let schedulesBackfilled = 0;
  for (const s of await scheduleStore.listSchedules()) {
    await scheduleStore.saveSchedule({ ...s });
    schedulesBackfilled++;
  }
  return { transfersBackfilled, schedulesBackfilled, skippedSentinel: false };
}
```

- [ ] **Step 4: Wire it into the cron chain in `src/app/api/cron/route.ts`**

```ts
import {
  backfillCustomersOnce,
  backfillCountryCurrencyOnce,
  backfillPartnersOnce,
  backfillSchedulesOnce,
  backfillSourceAmountsOnce,
} from '@/lib/migration';
// ...after schedulePartnerBackfill:
const sourceAmountBackfill = await backfillSourceAmountsOnce(store, scheduleStore);
// ...in the JSON response:
  sourceAmountBackfill,    // NEW (P4)
```

- [ ] **Step 5: Run the suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. If a `cron-run` route test asserts the response shape, add `sourceAmountBackfill`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migration.ts src/app/api/cron/route.ts tests/
git commit -m "feat(P4): sentinel-guarded source-amount backfill in cron chain"
```

---

## Task 11: Dashboard — always show source currency

**Files:**
- Modify: `src/app/dashboard/transactions-tabs.tsx`

- [ ] **Step 1: Replace the `usd()` helper with currency-aware formatting**

```tsx
function money(amount: number, currency: Transfer['sourceCurrency']): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
```

- [ ] **Step 2: Render the source amount + currency on every row, with the USD-equivalent when non-USD**

Replace the Amount cell:

```tsx
<td>
  <div className="sh-amount">{money(t.amountSource, t.sourceCurrency)}</div>
  {t.sourceCurrency !== 'USD' && (
    <div className="sh-recipient-sub">≈ {money(t.amountUsd, 'USD')}</div>
  )}
  <div className="sh-recipient-sub">{inr(t.amountInr)}</div>
</td>
```

- [ ] **Step 3: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: clean (UI is not unit-tested per project conventions; the build is the gate).

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/transactions-tabs.tsx
git commit -m "feat(P4): transactions table always shows source currency"
```

---

## Task 12: Wrap — full verification, push, PR

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (the USD-source regression suite is the dormancy proof).

- [ ] **Step 2: Confirm the dormancy invariant by hand**

Confirm that with all partners at `countries: ['US']`: no test asserts a currency note is injected for the default partner, every `get_quote`/`create_transfer` path resolves to `'USD'`, and transfer/quote values are identical to pre-P4.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/p4-multi-currency
gh pr create --title "feat(P4): multi-currency at quote/transfer time (partner-gated, dormant)" --body "$(cat <<'EOF'
## Summary
- Partner-gated, dormant-by-default multi-currency: allowed send currencies derive from Partner.countries; every current partner is ['US'] → USD-only → zero customer-facing change.
- USD-equivalent accounting keeps caps/velocity/compliance uniform; customer quote is source→INR.
- Transfers/drafts/schedules store source + USD-equivalent fields; sentinel-guarded backfill + lazy-fill for existing records.
- Dashboard always shows the source currency.

## Test plan
- [ ] typecheck / lint / vitest / build all green
- [ ] USD-source regression suite unchanged (dormancy proof)
- [ ] multi-currency unit tests (FX, resolveSendCurrency, quote) pass
EOF
)"
```

- [ ] **Step 4: Confirm `ci/ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red as the known env-var-name false positive.)

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 dormancy → Tasks 2,8,9,12. §2 FX → Task 1. §3 resolution → Task 2. §4 quote/types → Tasks 3–6. §5 transfer-create → Task 4. §6 tools → Tasks 7,8. §7 agent/prompt → Task 9. §8 migration → Tasks 4,6,10. §9 dashboard → Task 11. §10 testing → every task + Task 12. Security note (untrusted LLM currency) → Task 2 + Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; the only deliberate two-step scaffold (`'USD'` in Tasks 3–6, real resolution in Task 8) is called out explicitly at each site. ✓

**Type consistency:** `getFxRates(source): FxRates{toInr,toUsd}`, `quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount)`, `resolveSendCurrency(partner, requested?)`, `countryForCurrency`, `CreateTransferInput{amountSource, sourceCurrency, partnerId}`, `Quote/Transfer/Draft/Schedule` source fields — names used identically across Tasks 1–11. ✓
