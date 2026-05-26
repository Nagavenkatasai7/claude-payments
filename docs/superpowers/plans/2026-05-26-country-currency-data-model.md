# Country + Currency Data Model Implementation Plan (P1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `senderCountry` to `Customer` and 4 country/currency fields to `Transfer` (all defaulting to US/USD/IN/INR for v1), plus sentinel-guarded backfill migration + dashboard surfacing. Foundational sub-project (1 of 5) of the multi-country platform reshape. Zero bot behavior change.

**Architecture:** Two new TypeScript literal-union types (`CountryCode`, `CurrencyCode`) feed every read + write path. A `src/lib/defaults.ts` module is the single source of truth for "what country/currency does the bot assume when nothing else is known?" Write paths (`customer-store.upsertOnFirstInbound`, `transfer-create.createTransfer`) populate defaults on every new record. Read paths (`customer-store.getCustomer`, `store.getTransfer`) lazy-fill missing fields **in memory only** so old records render correctly without a Redis write on read. A second sentinel-guarded migration (alongside B1's `backfillCustomersOnce`) runs from the existing daily cron and persistently backfills every pre-existing record.

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, Upstash Redis (`SET NX` sentinel pattern), Vitest, Playwright (smoke test extension).

**Spec:** [docs/superpowers/specs/2026-05-25-country-currency-data-model-design.md](../specs/2026-05-25-country-currency-data-model-design.md)

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `CountryCode`, `CurrencyCode` literal-union types + `DEFAULT_CURRENCY_FOR_COUNTRY` map. Extend `Customer` with `senderCountry: CountryCode`. Extend `Transfer` with 4 new fields. |
| `src/lib/defaults.ts` | **Create** | Five exported default constants. Pure module, no I/O. |
| `src/lib/customer-store.ts` | Modify | `upsertOnFirstInbound` writes `senderCountry: 'US'` on every new record. `getCustomer` lazy-fills `senderCountry` if missing (in-memory only). |
| `src/lib/transfer-create.ts` | Modify | `createTransfer` populates all 4 new Transfer fields from defaults. |
| `src/lib/store.ts` | Modify | `getTransfer` lazy-fills the 4 new fields if missing (in-memory only). |
| `src/lib/migration.ts` | Modify | Add `backfillCountryCurrencyOnce(store, customerStore)`. Sentinel key: `country-currency-backfill-v1`. Two passes (customers + transfers). |
| `src/app/api/cron/route.ts` | Modify | Call the new migration alongside `backfillCustomersOnce`. Add `countryCurrencyBackfill` field to JSON response. |
| `src/app/dashboard/customers/page.tsx` | Modify | Add `Country` column after `Phone`. |
| `src/app/dashboard/customers/[phone]/page.tsx` | Modify | Add `Country` row to Identity panel. |
| `src/app/dashboard/transactions/page.tsx` | Modify (if needed) | Confirm `tierByPhone`-style plumbing already passes the full transfer through — the new column reads `t.sourceCountry` directly. |
| `src/app/dashboard/transactions-tabs.tsx` | Modify | Add `Country` column after `Phone`, before `Tier`. |
| `tests/defaults.test.ts` | **Create** | Assert the 5 constants. |
| `tests/customer-store.test.ts` | Modify | 2 new tests: `upsertOnFirstInbound` writes `senderCountry: 'US'`; `getCustomer` fills missing `senderCountry` on read without persisting. |
| `tests/store-getTransfer.test.ts` | **Create** | Assert `store.getTransfer` returns 4 new fields filled for old records missing them; assert no Redis write on read. |
| `tests/transfer-create.test.ts` | Modify (or create if absent — check first) | Assert `createTransfer` returns Transfer with all 4 new fields set to defaults. |
| `tests/migration.test.ts` | Modify | 3 new tests: backfill writes `senderCountry` to customers; backfill writes 4 fields to transfers; idempotent via sentinel. |
| `tests/e2e/dashboard-smoke.spec.ts` | Modify | Assert `Country` column header on `/dashboard/customers`. |

---

## Task 1: Types + defaults module

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/defaults.ts`
- Create: `tests/defaults.test.ts`

Foundation task. Pure types + constants. Compiler is the test. Later tasks won't compile without these.

- [ ] **Step 1: Append new types to `src/lib/types.ts`**

At the end of `src/lib/types.ts` (after the existing `CapEvaluation` interface from B1), append:

```ts
// ── Phase 1 country + currency types (P1) ─────────────────────────────
//
// `country?: string` on Customer (B1) is reserved for free-text KYC-provider
// values (Persona may return "United States" as text). The NEW strictly-typed
// `senderCountry: CountryCode` below is our routing field. Two different
// concerns, two different fields. Routing code never reads `country`.

// ISO 3166-1 alpha-2. Note: UAE = 'AE' (not 'UAE').
export type CountryCode =
  | 'US' | 'CA' | 'GB' | 'AE' | 'SG' | 'AU' | 'NZ'  // send-side (Phase 1)
  | 'IN';                                              // payout-side (v1 only)

// ISO 4217 currency codes corresponding to the supported countries.
export type CurrencyCode =
  | 'USD' | 'CAD' | 'GBP' | 'AED' | 'SGD' | 'AUD' | 'NZD'  // send-side
  | 'INR';                                                    // payout-side

// Single source of truth for "what's the home currency of country X?"
// Consumed by the migration + bot defaults.
export const DEFAULT_CURRENCY_FOR_COUNTRY: Record<CountryCode, CurrencyCode> = {
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AE: 'AED',
  SG: 'SGD',
  AU: 'AUD',
  NZ: 'NZD',
  IN: 'INR',
};
```

- [ ] **Step 2: Extend `Customer` and `Transfer` in `src/lib/types.ts`**

Find the existing `Customer` interface (added in B1). Replace it with:

```ts
export interface Customer {
  senderPhone: string;
  firstSeenAt: string;
  kycStatus: KycStatus;
  kycVerifiedAt?: string;
  kycProviderRef?: string;
  kycRejectedReason?: string;
  fullName?: string;
  dateOfBirth?: string;
  country?: string;             // legacy KYC-provider free-text — DO NOT use for routing
  senderCountry: CountryCode;   // NEW (P1) — required; the routing field
  createdAt: string;
  updatedAt: string;
}
```

Find the existing `Transfer` interface. Add 4 new required fields. Replace with:

```ts
export interface Transfer {
  id: string;
  phone: string;
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  complianceStatus: ComplianceStatus;
  complianceReasons: string[];
  status: TransferStatus;
  createdAt: string;
  paidAt?: string;
  deliveredAt?: string;
  assignedTo?: string;
  adminNote?: string;
  // NEW (P1) — required after migration
  sourceCountry: CountryCode;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
}
```

- [ ] **Step 3: Create `src/lib/defaults.ts`**

```ts
import type { CountryCode, CurrencyCode } from './types';

export const DEFAULT_SENDER_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_CURRENCY: CurrencyCode = 'USD';
export const DEFAULT_DESTINATION_COUNTRY: CountryCode = 'IN';
export const DEFAULT_DESTINATION_CURRENCY: CurrencyCode = 'INR';
```

- [ ] **Step 4: Create `tests/defaults.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SENDER_COUNTRY,
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
} from '@/lib/defaults';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';

describe('P1 default constants', () => {
  it('senderCountry / source defaults are US / USD', () => {
    expect(DEFAULT_SENDER_COUNTRY).toBe('US');
    expect(DEFAULT_SOURCE_COUNTRY).toBe('US');
    expect(DEFAULT_SOURCE_CURRENCY).toBe('USD');
  });

  it('destination defaults are IN / INR (v1 payout is India only)', () => {
    expect(DEFAULT_DESTINATION_COUNTRY).toBe('IN');
    expect(DEFAULT_DESTINATION_CURRENCY).toBe('INR');
  });

  it('DEFAULT_CURRENCY_FOR_COUNTRY maps every supported country to its ISO 4217 currency', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.US).toBe('USD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.CA).toBe('CAD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.GB).toBe('GBP');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.AE).toBe('AED');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.SG).toBe('SGD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.AU).toBe('AUD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.NZ).toBe('NZD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.IN).toBe('INR');
  });

  it('every default sender/source country has an entry in DEFAULT_CURRENCY_FOR_COUNTRY', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY[DEFAULT_SENDER_COUNTRY]).toBe(DEFAULT_SOURCE_CURRENCY);
    expect(DEFAULT_CURRENCY_FOR_COUNTRY[DEFAULT_DESTINATION_COUNTRY]).toBe(DEFAULT_DESTINATION_CURRENCY);
  });
});
```

- [ ] **Step 5: Run typecheck — expect failures only at call sites**

Run: `npm run typecheck`
Expected: FAIL — `customer-store.ts`, `transfer-create.ts`, and tests that construct `Customer`/`Transfer` literals will be missing the new required fields. That's intentional; subsequent tasks fix each one. **No errors should be inside `types.ts`, `defaults.ts`, or `defaults.test.ts`.**

- [ ] **Step 6: Run the defaults test in isolation**

Run: `npm test -- defaults`
Expected: PASS (4 cases).

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/p1-country-currency
git add src/lib/types.ts src/lib/defaults.ts tests/defaults.test.ts
git commit -m "types: add CountryCode, CurrencyCode + defaults.ts module (P1)

Foundation for P1. Adds two literal-union types covering Phase-1 supported
countries (US/CA/GB/AE/SG/AU/NZ + IN), ISO 4217 currency map, and required
senderCountry/sourceCountry/sourceCurrency/destinationCountry/
destinationCurrency fields on Customer/Transfer.

Typecheck red at call sites until later tasks land; defaults.test.ts (4
cases) passes in isolation."
```

---

## Task 2: customer-store — write default on new records, lazy-fill on read

**Files:**
- Modify: `src/lib/customer-store.ts`
- Modify: `tests/customer-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/customer-store.test.ts`:

```ts
describe('customer-store P1: senderCountry', () => {
  it('upsertOnFirstInbound writes senderCountry: US on a brand-new customer', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550009999');
    expect(customer.senderCountry).toBe('US');
  });

  it('upsertOnFirstInbound writes senderCountry: US on a grandfathered customer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    await createTransfer(store, {
      phone: '15550008888',
      amountUsd: 50,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550008888');
    expect(customer.senderCountry).toBe('US');
    expect(customer.kycStatus).toBe('grandfathered');
  });

  it('getCustomer fills missing senderCountry in-memory without persisting', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    // Manually write a customer record missing senderCountry (simulating pre-P1 data)
    await redis.set('customer:15550007777', JSON.stringify({
      senderPhone: '15550007777',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    const cs = createCustomerStore(redis, store);
    const c1 = await cs.getCustomer('15550007777');
    expect(c1?.senderCountry).toBe('US');
    // Verify NO persist happened — raw value in Redis still missing the field
    const raw = await redis.get('customer:15550007777');
    expect(JSON.parse(raw!).senderCountry).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- customer-store`
Expected: FAIL on the 3 new tests — `senderCountry` is undefined.

- [ ] **Step 3: Modify `src/lib/customer-store.ts`**

Add an import at the top:

```ts
import { DEFAULT_SENDER_COUNTRY } from './defaults';
```

Find the `getCustomer` method. Replace it with:

```ts
    async getCustomer(senderPhone: string): Promise<Customer | null> {
      const raw = await redis.get(`customer:${senderPhone}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Customer;
        // Lazy fill for pre-P1 records missing senderCountry (in-memory only;
        // the cron pass is the only writer for backfilled records)
        if (!parsed.senderCountry) {
          parsed.senderCountry = DEFAULT_SENDER_COUNTRY;
        }
        return parsed;
      } catch {
        return null;
      }
    },
```

Find the `upsertOnFirstInbound` method. Inside both branches where a `Customer` object literal is constructed (the grandfathered branch and the brand-new branch), add `senderCountry: DEFAULT_SENDER_COUNTRY,`:

```ts
      const customer: Customer = minAt
        ? {
            senderPhone,
            firstSeenAt: minAt,
            kycStatus: 'grandfathered',
            kycVerifiedAt: nowIso,
            senderCountry: DEFAULT_SENDER_COUNTRY,  // NEW (P1)
            createdAt: minAt,
            updatedAt: nowIso,
          }
        : {
            senderPhone,
            firstSeenAt: nowIso,
            kycStatus: 'not_started',
            senderCountry: DEFAULT_SENDER_COUNTRY,  // NEW (P1)
            createdAt: nowIso,
            updatedAt: nowIso,
          };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- customer-store`
Expected: PASS — all 7 existing tests + 3 new.

- [ ] **Step 5: Commit**

```bash
git add src/lib/customer-store.ts tests/customer-store.test.ts
git commit -m "customer-store: senderCountry on new records + lazy fill on read (P1)"
```

---

## Task 3: transfer-create + store.getTransfer — write 4 fields, lazy fill on read

**Files:**
- Modify: `src/lib/transfer-create.ts`
- Modify: `src/lib/store.ts`
- Create: `tests/store-getTransfer.test.ts`
- Create: `tests/transfer-create.test.ts` (check if exists first; if so, modify)

- [ ] **Step 1: Write the failing test for transfer-create**

Create `tests/transfer-create.test.ts` (or append a new describe block if the file already exists):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('createTransfer P1: country + currency fields', () => {
  it('populates all 4 new fields with defaults', async () => {
    const store = createStore(fakeRedis());
    const t = await createTransfer(store, {
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    expect(t.sourceCountry).toBe('US');
    expect(t.sourceCurrency).toBe('USD');
    expect(t.destinationCountry).toBe('IN');
    expect(t.destinationCurrency).toBe('INR');
  });
});
```

- [ ] **Step 2: Write the failing test for store.getTransfer**

Create `tests/store-getTransfer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

describe('store.getTransfer P1: lazy fill', () => {
  it('returns the 4 new fields with defaults for an old record missing them', async () => {
    const redis = fakeRedis();
    // Manually write a Transfer record from before P1 (missing the 4 new fields)
    await redis.set('transfer:OLD12345', JSON.stringify({
      id: 'OLD12345',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('OLD12345');
    expect(t?.sourceCountry).toBe('US');
    expect(t?.sourceCurrency).toBe('USD');
    expect(t?.destinationCountry).toBe('IN');
    expect(t?.destinationCurrency).toBe('INR');
  });

  it('does NOT persist the lazy fill (read paths are side-effect-free)', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:OLD99999', JSON.stringify({
      id: 'OLD99999',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    const store = createStore(redis);
    await store.getTransfer('OLD99999');
    const raw = await redis.get('transfer:OLD99999');
    const parsed = JSON.parse(raw!);
    expect(parsed.sourceCountry).toBeUndefined();
    expect(parsed.sourceCurrency).toBeUndefined();
    expect(parsed.destinationCountry).toBeUndefined();
    expect(parsed.destinationCurrency).toBeUndefined();
  });

  it('returns null for a missing key (unchanged behavior)', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTransfer('NONE')).toBeNull();
  });

  it('returns the 4 new fields untouched when they are already present', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:NEW12345', JSON.stringify({
      id: 'NEW12345',
      phone: '15551234567',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-05-26T00:00:00Z',
      sourceCountry: 'CA',
      sourceCurrency: 'CAD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('NEW12345');
    expect(t?.sourceCountry).toBe('CA');  // NOT overwritten by 'US' default
    expect(t?.sourceCurrency).toBe('CAD');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- transfer-create store-getTransfer`
Expected: FAIL on the new tests — the fields are undefined.

- [ ] **Step 4: Modify `src/lib/transfer-create.ts`**

Add the import at the top:

```ts
import {
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
} from './defaults';
```

Find the `Transfer` object literal inside `createTransfer`. Insert the 4 fields BEFORE the `await store.saveTransfer(transfer);` line — extend the existing object literal:

```ts
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
    // NEW (P1) — defaults until P4 unlocks bot-collected values
    sourceCountry: DEFAULT_SOURCE_COUNTRY,
    sourceCurrency: DEFAULT_SOURCE_CURRENCY,
    destinationCountry: DEFAULT_DESTINATION_COUNTRY,
    destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
  };
```

- [ ] **Step 5: Modify `src/lib/store.ts` — lazy fill in `getTransfer`**

Find the existing `getTransfer` method inside `createStore`. Replace with:

```ts
    async getTransfer(id: string): Promise<Transfer | null> {
      const raw = await redis.get(`transfer:${id}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Transfer;
      // Lazy fill for pre-P1 records missing the 4 new fields (in-memory only;
      // the cron pass is the only writer for backfilled records)
      if (!parsed.sourceCountry) {
        parsed.sourceCountry = DEFAULT_SOURCE_COUNTRY;
        parsed.sourceCurrency = DEFAULT_SOURCE_CURRENCY;
        parsed.destinationCountry = DEFAULT_DESTINATION_COUNTRY;
        parsed.destinationCurrency = DEFAULT_DESTINATION_CURRENCY;
      }
      return parsed;
    },
```

Add the imports at the top of `src/lib/store.ts`:

```ts
import {
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
} from './defaults';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- transfer-create store-getTransfer`
Expected: PASS — 1 new test in transfer-create + 4 new tests in store-getTransfer.

Then run the full suite — `npm test` — and confirm no regression in customer-store (Task 2), tier-rules, daily-volume, recipient-store, e2e, etc. Existing tests that construct `Transfer` literals may now fail typecheck if they don't include the 4 new fields. Fix those — add the 4 fields to every `Transfer` literal in the test suite. Pattern:

```ts
sourceCountry: 'US',
sourceCurrency: 'USD',
destinationCountry: 'IN',
destinationCurrency: 'INR',
```

Search for `Transfer` literals via `grep -rn "as const" tests/ | head -10` and `grep -rn "complianceStatus" tests/`. Update each.

- [ ] **Step 7: Commit**

```bash
git add src/lib/transfer-create.ts src/lib/store.ts tests/transfer-create.test.ts tests/store-getTransfer.test.ts tests/
git commit -m "transfer + store: 4 country/currency fields on new transfers + lazy fill on read (P1)"
```

---

## Task 4: Migration — backfillCountryCurrencyOnce + cron wiring

**Files:**
- Modify: `src/lib/migration.ts`
- Modify: `src/app/api/cron/route.ts`
- Modify: `tests/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/migration.test.ts`:

```ts
import { backfillCountryCurrencyOnce } from '@/lib/migration';

describe('backfillCountryCurrencyOnce', () => {
  it('writes senderCountry to every customer missing it', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    // Pre-P1 customers (missing senderCountry)
    await redis.set('customer:15551111111', JSON.stringify({
      senderPhone: '15551111111',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15551111111');
    await redis.set('customer:15552222222', JSON.stringify({
      senderPhone: '15552222222',
      firstSeenAt: '2026-01-02T00:00:00Z',
      kycStatus: 'grandfathered',
      kycVerifiedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15552222222');

    const result = await backfillCountryCurrencyOnce(store, cs);
    expect(result.customersBackfilled).toBe(2);
    expect(result.skippedSentinel).toBe(false);

    // Verify Redis raw values now have senderCountry
    const raw1 = JSON.parse((await redis.get('customer:15551111111'))!);
    const raw2 = JSON.parse((await redis.get('customer:15552222222'))!);
    expect(raw1.senderCountry).toBe('US');
    expect(raw2.senderCountry).toBe('US');
  });

  it('writes 4 fields to every transfer missing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);

    // Manually write pre-P1 transfers
    await redis.set('transfer:OLDAAA', JSON.stringify({
      id: 'OLDAAA',
      phone: '15551111111',
      amountUsd: 50,
      feeUsd: 1.99,
      totalChargeUsd: 51.99,
      fxRate: 85.2,
      amountInr: 4260,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('transfers:ids', 'OLDAAA');

    const result = await backfillCountryCurrencyOnce(store, cs);
    expect(result.transfersBackfilled).toBe(1);

    const raw = JSON.parse((await redis.get('transfer:OLDAAA'))!);
    expect(raw.sourceCountry).toBe('US');
    expect(raw.sourceCurrency).toBe('USD');
    expect(raw.destinationCountry).toBe('IN');
    expect(raw.destinationCurrency).toBe('INR');
  });

  it('is idempotent — second call returns skippedSentinel: true and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await redis.set('customer:15553333333', JSON.stringify({
      senderPhone: '15553333333',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15553333333');

    const first = await backfillCountryCurrencyOnce(store, cs);
    const second = await backfillCountryCurrencyOnce(store, cs);
    expect(first.customersBackfilled).toBe(1);
    expect(first.skippedSentinel).toBe(false);
    expect(second.customersBackfilled).toBe(0);
    expect(second.transfersBackfilled).toBe(0);
    expect(second.skippedSentinel).toBe(true);
  });

  it('skips customers/transfers that already have the fields (does not overwrite)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    // Customer already has senderCountry: 'CA'
    await redis.set('customer:15554444444', JSON.stringify({
      senderPhone: '15554444444',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'CA',  // already set
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15554444444');

    await backfillCountryCurrencyOnce(store, cs);
    const raw = JSON.parse((await redis.get('customer:15554444444'))!);
    expect(raw.senderCountry).toBe('CA'); // unchanged
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- migration`
Expected: FAIL — `backfillCountryCurrencyOnce` not exported.

- [ ] **Step 3: Extend `src/lib/migration.ts`**

Add imports at the top:

```ts
import {
  DEFAULT_SENDER_COUNTRY,
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
} from './defaults';
```

Add a second sentinel constant alongside the existing one:

```ts
const COUNTRY_CURRENCY_SENTINEL_KEY = 'country-currency-backfill-v1';
```

Append the new function at the bottom of the file:

```ts
export async function backfillCountryCurrencyOnce(
  store: Store,
  customerStore: CustomerStore,
): Promise<{
  customersBackfilled: number;
  transfersBackfilled: number;
  skippedSentinel: boolean;
}> {
  const claimed = await store.claimMigrationFlag(COUNTRY_CURRENCY_SENTINEL_KEY);
  if (!claimed) {
    return { customersBackfilled: 0, transfersBackfilled: 0, skippedSentinel: true };
  }

  // Pass 1: customers
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    if (c.senderCountry) continue;
    await customerStore.saveCustomer({
      ...c,
      senderCountry: DEFAULT_SENDER_COUNTRY,
      updatedAt: new Date().toISOString(),
    });
    customersBackfilled++;
  }

  // Pass 2: transfers
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    if (t.sourceCountry) continue;
    await store.saveTransfer({
      ...t,
      sourceCountry: DEFAULT_SOURCE_COUNTRY,
      sourceCurrency: DEFAULT_SOURCE_CURRENCY,
      destinationCountry: DEFAULT_DESTINATION_COUNTRY,
      destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
    });
    transfersBackfilled++;
  }

  return { customersBackfilled, transfersBackfilled, skippedSentinel: false };
}
```

**Note:** `customerStore.listCustomers()` calls `getCustomer` for each phone (per the existing implementation), which means each loaded record goes through the LAZY-FILL path from Task 2. So `c.senderCountry` will ALWAYS be populated in memory after the lazy fill. The `if (c.senderCountry) continue;` check would always skip if we relied only on the parsed value. To detect a true pre-P1 record, we need to check the RAW Redis value.

Revise the customers pass to peek the raw JSON:

```ts
  // Pass 1: customers — peek raw Redis to detect pre-P1 records that bypass lazy fill
  const phones = await store.listCustomerPhones?.() ?? [];
  // Fallback if listCustomerPhones is not available — list via customerStore
  const allCustomers = phones.length === 0 ? await customerStore.listCustomers() : null;
  // ... actually, simplest approach: rely on customerStore.listCustomers which now
  // returns fully-lazy-filled records, and skip the `if` check. Always re-save
  // (idempotent — same value).
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    // c.senderCountry is ALWAYS populated thanks to Task 2's lazy fill.
    // The cron's job is to persist the default. Always-save is safe because
    // saving the same value is idempotent.
    await customerStore.saveCustomer({
      ...c,
      updatedAt: new Date().toISOString(),
    });
    customersBackfilled++;
  }
```

Hmm, this would inflate `customersBackfilled` count on subsequent (non-skipped) runs. Better: check the RAW Redis value directly. Add a helper to `CustomerStore` if needed, OR check via a fresh read that bypasses the lazy-fill:

Actually the cleanest fix: keep the `if (c.senderCountry) continue;` check BUT make the lazy fill in `customer-store.getCustomer` write a `_lazyFilled: true` flag (no, that pollutes the type).

The cleanest cleanest fix: have the migration use `redis.get` directly on each customer key, parse the raw JSON, and check for `senderCountry`. Pass redis into the migration:

Revise the function signature to accept the raw Redis. But that breaks the abstraction. Alternatively, add a method to `Store` or `CustomerStore` for "list raw customers" — but that's API bloat.

**Pragmatic solution:** the migration's idempotency is already guaranteed by the sentinel. After the FIRST run, the sentinel blocks any further runs. So the "always re-save" approach is fine — it inflates the FIRST run's count slightly (counts customers who already had senderCountry, e.g. brand-new senders created post-deploy but before cron). The count is informational; the operation is idempotent. Accept this.

Revised function (final form):

```ts
export async function backfillCountryCurrencyOnce(
  store: Store,
  customerStore: CustomerStore,
): Promise<{
  customersBackfilled: number;
  transfersBackfilled: number;
  skippedSentinel: boolean;
}> {
  const claimed = await store.claimMigrationFlag(COUNTRY_CURRENCY_SENTINEL_KEY);
  if (!claimed) {
    return { customersBackfilled: 0, transfersBackfilled: 0, skippedSentinel: true };
  }

  // Pass 1: customers.
  // customerStore.listCustomers() returns fully lazy-filled records (Task 2), so
  // every customer's senderCountry is already populated in memory. We re-save
  // each one to persist the default to Redis. This is idempotent. The sentinel
  // guarantees we only run this once.
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    await customerStore.saveCustomer({
      ...c,
      updatedAt: new Date().toISOString(),
    });
    customersBackfilled++;
  }

  // Pass 2: transfers. Same pattern — store.getTransfer (called by listTransfers)
  // returns lazy-filled values. Re-save each to persist.
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({
      ...t,
      // Lazy fill in getTransfer guarantees the 4 fields are present in `t`;
      // re-save persists them.
    });
    transfersBackfilled++;
  }

  return { customersBackfilled, transfersBackfilled, skippedSentinel: false };
}
```

Update the tests to match — the count includes all customers/transfers, not just the ones that were missing the field. The "skips customers that already have the fields" test needs to verify the VALUE wasn't overwritten (which it isn't — we spread `...c`), not that backfilled stayed at 0.

Revised test:

```ts
  it('does NOT overwrite existing field values (preserves CA)', async () => {
    // ...same setup...
    await backfillCountryCurrencyOnce(store, cs);
    const raw = JSON.parse((await redis.get('customer:15554444444'))!);
    expect(raw.senderCountry).toBe('CA'); // unchanged
  });
```

Drop the "skips" framing; rename to "preserves existing values".

- [ ] **Step 4: Modify `src/app/api/cron/route.ts`**

Replace the file:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getCustomerStore } from '@/lib/customer-store';
import { runDueSchedules } from '@/lib/cron-run';
import { backfillCustomersOnce, backfillCountryCurrencyOnce } from '@/lib/migration';
import { sendText } from '@/lib/whatsapp';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const store = getStore();
  const customerStore = getCustomerStore(store);

  // Idempotent backfills — sentinel-guarded.
  const backfill = await backfillCustomersOnce(store, customerStore);
  const countryCurrencyBackfill = await backfillCountryCurrencyOnce(store, customerStore);

  const result = await runDueSchedules({
    store,
    scheduleStore: getScheduleStore(),
    now: Date.now(),
    sendScheduledLink: async (schedule, _transfer, url) => {
      const text =
        `Your scheduled SendHome transfer of $${schedule.amountUsd.toFixed(2)} ` +
        `to ${schedule.recipientName} is ready. Tap to pay: ${url}`;
      try { await sendText(schedule.phone, text); }
      catch (err) { console.error('Scheduled-link send failed:', schedule.id, err); }
    },
  });

  return NextResponse.json({
    ok: true,
    fired: result.fired,
    backfill,
    countryCurrencyBackfill,
  });
}
```

- [ ] **Step 5: Run all tests + typecheck + lint + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. Test count: ~316 (309 before + 7 new from this task).

- [ ] **Step 6: Commit**

```bash
git add src/lib/migration.ts src/app/api/cron/route.ts tests/migration.test.ts
git commit -m "migration: backfillCountryCurrencyOnce + cron wiring (P1)"
```

---

## Task 5: Dashboard — Country columns + Identity row

**Files:**
- Modify: `src/app/dashboard/customers/page.tsx`
- Modify: `src/app/dashboard/customers/[phone]/page.tsx`
- Modify: `src/app/dashboard/transactions-tabs.tsx`

- [ ] **Step 1: Modify `src/app/dashboard/customers/page.tsx`**

In the existing table, find the `<th>` row in the header. Add a `Country` header immediately after `Phone`:

```tsx
            <thead>
              <tr>
                <th>Phone</th>
                <th>Country</th>
                <th>First seen</th>
                <th>Tier</th>
                <th>KYC</th>
                <th>Lifetime sent</th>
                <th>Last activity</th>
              </tr>
            </thead>
```

In the row body, find the `<td>` cells. Add a Country cell immediately after the Phone cell:

```tsx
                  <tr key={c.senderPhone}>
                    <td>
                      <Link href={`/dashboard/customers/${c.senderPhone}`}>+{c.senderPhone}</Link>
                    </td>
                    <td>{c.senderCountry}</td>
                    <td>{new Date(c.firstSeenAt).toLocaleDateString()}</td>
                    {/* ... rest unchanged ... */}
```

Update the empty-state `colSpan` from 6 to 7:

```tsx
                <tr><td colSpan={7} className="sh-empty">No customers yet.</td></tr>
```

- [ ] **Step 2: Modify `src/app/dashboard/customers/[phone]/page.tsx`**

In the Identity panel's `<dl>`, add a Country row. Insert before or after the `Verified at` row:

```tsx
            <dt>Country</dt><dd>{customer.senderCountry}</dd>
```

- [ ] **Step 3: Modify `src/app/dashboard/transactions-tabs.tsx`**

In the existing table, find the `<th>` row and add a Country header. The exact position: between the existing `Phone`-related column and the `Tier` column (added in B1). Read the current file to find the precise spot.

Add the header:

```tsx
                <th>Country</th>
```

In the row body, add a cell that reads `t.sourceCountry`:

```tsx
                  <td>{t.sourceCountry}</td>
```

Update any `colSpan` empty-state rows that span the table width — increment by 1.

- [ ] **Step 4: Run typecheck + lint + tests + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/customers/page.tsx src/app/dashboard/customers/[phone]/page.tsx src/app/dashboard/transactions-tabs.tsx
git commit -m "dashboard: Country columns on customers + transactions, Country row on detail (P1)"
```

---

## Task 6: Playwright smoke + local CI + PR + merge + verification

**Files:**
- Modify: `tests/e2e/dashboard-smoke.spec.ts`

This is the delivery task. Extend the smoke, run the full local pipeline, push the branch, open PR #7, merge through branch protection, verify the prod deploy, trigger the cron, confirm the dashboard renders.

- [ ] **Step 1: Extend the Playwright smoke**

Open `tests/e2e/dashboard-smoke.spec.ts`. After the existing `/dashboard/customers` assertion (added in PR #6 Task 14), add a header assertion:

```ts
  await page.getByRole('link', { name: /customers/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/customers/);
  await expect(
    page.getByRole('table').or(page.getByText(/no customers yet/i)),
  ).toBeVisible();
  // P1: assert the new Country column header exists
  await expect(page.getByRole('columnheader', { name: /country/i })).toBeVisible();
```

- [ ] **Step 2: Full local CI pipeline**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. Test count ~316.

- [ ] **Step 3: Local Playwright smoke against current prod (sanity)**

```bash
BASE_URL=https://claude-payments.vercel.app npm run e2e
```
Expected: **MAY FAIL** on the new `Country` column header assertion because prod hasn't been deployed yet. That's fine — the assertion will pass after the post-merge deploy. If you want a clean local run, temporarily comment out the new line, run, uncomment, commit.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/p1-country-currency
```

- [ ] **Step 5: Open PR #7**

```bash
gh pr create --base main --head feat/p1-country-currency \
  --title "feat(P1): country + currency data model" \
  --body "$(cat <<'EOF'
Implements [docs/superpowers/specs/2026-05-25-country-currency-data-model-design.md](docs/superpowers/specs/2026-05-25-country-currency-data-model-design.md).

Foundational sub-project (1 of 5) of the multi-country platform reshape.

## Summary
- New \`CountryCode\` + \`CurrencyCode\` literal-union types (ISO 3166-1 alpha-2 + ISO 4217).
- \`senderCountry: CountryCode\` on \`Customer\`. Four new fields on \`Transfer\` (\`sourceCountry\`, \`sourceCurrency\`, \`destinationCountry\`, \`destinationCurrency\`).
- New \`src/lib/defaults.ts\` module — single source of truth for default country/currency until P4 unlocks bot collection.
- Write paths (\`upsertOnFirstInbound\`, \`createTransfer\`) populate defaults on every new record.
- Read paths (\`getCustomer\`, \`getTransfer\`) lazy-fill missing fields in-memory only (no Redis write on read).
- New sentinel-guarded \`backfillCountryCurrencyOnce\` migration in \`migration.ts\`, called from the existing daily cron alongside B1's \`backfillCustomersOnce\`.
- Dashboard: \`Country\` column on \`/dashboard/customers\` and \`/dashboard/transactions\`, \`Country\` row on \`/dashboard/customers/[phone]\` Identity panel.

## Reliability
- Lazy fill on read paths is side-effect-free (no Redis writes on \`getTransfer\` / \`getCustomer\`).
- Migration sentinel-guarded via Redis \`SET NX\` — idempotent forever.
- Old transfer records and old customer records render correctly without waiting for the cron.
- Zero bot behaviour change. Bot still hardcoded to US/USD for sends; P4 owns multi-currency at quote time.

## Test plan
- [x] \`npm run typecheck\` / \`npm run lint\` / \`npm test\` / \`npm run build\` — all green
- [x] ~316 tests pass (was 309 before P1)
- [ ] Post-merge: \`/api/cron\` triggers \`countryCurrencyBackfill\` on first call
- [ ] Post-merge: \`/dashboard/customers\` and \`/dashboard/transactions\` show \`US\` in the new Country column
- [ ] Post-merge: Playwright smoke asserts the Country column header

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI**

```bash
gh pr checks --watch
```
Expected: `ci` green in ~40s; `Vercel` preview green.

- [ ] **Step 7: Merge through branch protection**

```bash
gh pr merge --squash --delete-branch
git checkout main && git pull --ff-only
```

- [ ] **Step 8: Verify Vercel prod deploy + Playwright smoke**

```bash
sleep 90
vercel ls claude-payments --yes | head -5
gh run list --workflow smoke.yml --limit 1 --branch main
```
Expected: most recent prod deploy from the merge commit is Ready; most recent smoke run on main is success.

- [ ] **Step 9: Trigger the cron to run the new backfill**

If `CRON_SECRET` is set in production:

```bash
curl -s "https://claude-payments.vercel.app/api/cron" \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Expected JSON:
```json
{
  "ok": true,
  "fired": 0,
  "backfill": { "backfilled": 0, "skippedSentinel": true },
  "countryCurrencyBackfill": {
    "customersBackfilled": N,
    "transfersBackfilled": M,
    "skippedSentinel": false
  }
}
```

Second call returns `"countryCurrencyBackfill": { ..., "skippedSentinel": true }`.

- [ ] **Step 10: Manual production verification**

In the live dashboard logged in as admin:
- [ ] `/dashboard/customers` table shows `Country` column with `US` for every existing sender.
- [ ] `/dashboard/transactions` table shows `Country` column with `US` for every existing transfer.
- [ ] Click any customer phone → detail page Identity panel shows `Country: US`.
- [ ] Send a WhatsApp message → bot acts identically to before (zero behavior change).
- [ ] New transfer that lands shows `Country: US` in the dashboard table without manual intervention.

---

## Self-review

### Spec coverage

| Spec section | Task |
|---|---|
| `CountryCode` + `CurrencyCode` types + `DEFAULT_CURRENCY_FOR_COUNTRY` map | Task 1 |
| `Customer.senderCountry` field | Task 1 |
| `Transfer` 4 new fields | Task 1 |
| `src/lib/defaults.ts` module | Task 1 |
| `customer-store.upsertOnFirstInbound` writes default | Task 2 |
| `customer-store.getCustomer` lazy-fill on read | Task 2 |
| `transfer-create.createTransfer` writes 4 defaults | Task 3 |
| `store.getTransfer` lazy-fill on read | Task 3 |
| `backfillCountryCurrencyOnce` in `migration.ts` | Task 4 |
| Cron route calls new migration + adds `countryCurrencyBackfill` to JSON | Task 4 |
| Dashboard customers index Country column | Task 5 |
| Dashboard customer detail Country row | Task 5 |
| Dashboard transactions Country column | Task 5 |
| Playwright smoke extension | Task 6 |
| Local CI + PR + merge + verification | Task 6 |
| Acceptance criteria checklist (12 items) | Task 6 manual verification list |

All spec sections traced.

### Placeholder scan

Searched for `TBD` / `TODO` / `fill in` / "implement later" — none present in the plan.

### Type consistency

- `CountryCode`, `CurrencyCode`, `DEFAULT_CURRENCY_FOR_COUNTRY` declared in Task 1, consumed in Tasks 2, 3, 4 (via `defaults.ts` re-exports).
- `Customer.senderCountry`, `Transfer.sourceCountry`/`.sourceCurrency`/`.destinationCountry`/`.destinationCurrency` declared in Task 1, used in Tasks 2-5.
- `backfillCountryCurrencyOnce` defined in Task 4 step 3, imported in Task 4 step 4 (cron route).
- `DEFAULT_SENDER_COUNTRY` / `DEFAULT_SOURCE_COUNTRY` / `DEFAULT_SOURCE_CURRENCY` / `DEFAULT_DESTINATION_COUNTRY` / `DEFAULT_DESTINATION_CURRENCY` declared in Task 1, used in Tasks 2 (one), 3 (four), 4 (five).
- Migration return type `{ customersBackfilled, transfersBackfilled, skippedSentinel }` consistent across Task 4 step 3, step 4, and step 9's JSON shape.

No type drift.

### Dependency order

- Task 1: foundation (types + defaults + their test). Must run first.
- Tasks 2, 3 in either order after Task 1 — both touch different write/read paths.
- Task 4 depends on Tasks 1, 2, 3 (uses defaults, calls customerStore + store with new schemas).
- Task 5 depends on Task 1 (reads `senderCountry`, `sourceCountry`).
- Task 6 depends on all of Tasks 1-5.

Subagent-driven execution: dispatch in 1 → 2 → 3 → 4 → 5 → 6 order.
