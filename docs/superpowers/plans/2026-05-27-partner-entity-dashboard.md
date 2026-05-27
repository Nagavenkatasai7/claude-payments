# Partner Entity + Dashboard Implementation Plan (P2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Partner` entity + multi-tenant boundary to SendHome — every `Customer` and `Transfer` gains required `partnerId`; `Staff` gains optional `partnerId`. Default Partner seeded via sentinel-guarded cron migration. Admin-only CRUD `/dashboard/partners` (list + detail + new + actions). Partner column + URL filter on Customers/Transactions tables. **Hard rule: WhatsApp bot never mentions partner.**

**Architecture:** New `src/lib/partner-store.ts` mirrors B1's `customer-store.ts` pattern (factory + cached singleton + `partner:<id>` JSON records + `partners:ids` set). New `DEFAULT_PARTNER_ID = 'default'` in `defaults.ts`. Write paths (`upsertOnFirstInbound`, `createTransfer`) hardcode `'default'` (P4 will swap for routing). Read paths (`getCustomer`, `getTransfer`) lazy-fill missing `partnerId` with `'default'` **in memory only** — same pattern P1 established. Third sentinel-guarded migration (`backfillPartnersOnce`) seeds Default Partner + re-saves existing records, runs from existing daily cron. Dashboard surfaces partners as new nav section + URL-driven `?partner=<id>` filter on existing pages.

**Tech Stack:** TypeScript, Next.js 16 App Router on Vercel, Upstash Redis (`SET NX` sentinel + `hash`/`set` ops via `RedisLike`), Vitest, Playwright (smoke extension).

**Spec:** [docs/superpowers/specs/2026-05-27-partner-entity-dashboard-design.md](../specs/2026-05-27-partner-entity-dashboard-design.md)

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `PartnerId`, `PartnerStatus`, `Partner`. Extend `Customer` + `Transfer` with required `partnerId`; `Staff` with optional `partnerId`. |
| `src/lib/defaults.ts` | Modify | Add `DEFAULT_PARTNER_ID: PartnerId = 'default'`. |
| `src/lib/partner-store.ts` | **Create** | `getPartner`, `savePartner`, `listPartners`, `ensureDefaultPartner` + cached singleton. |
| `src/lib/customer-store.ts` | Modify | `upsertOnFirstInbound` writes `partnerId: 'default'` on new records. `getCustomer` lazy-fills `partnerId` if missing (in-memory). |
| `src/lib/transfer-create.ts` | Modify | `createTransfer` populates `partnerId: 'default'`. |
| `src/lib/store.ts` | Modify | `getTransfer` lazy-fills `partnerId` if missing (in-memory). |
| `src/lib/migration.ts` | Modify | Add `backfillPartnersOnce(store, customerStore, partnerStore)` — seeds Default Partner + re-saves customers/transfers. Sentinel `partner-backfill-v1`. |
| `src/app/api/cron/route.ts` | Modify | Call `backfillPartnersOnce` alongside B1 + P1 migrations. JSON includes `partnerBackfill`. |
| `src/app/dashboard/sidebar.tsx` | Modify | Add `Partners` nav item; extend `SidebarActive` with `'partners'`. |
| `src/app/dashboard/partners/page.tsx` | **Create** | Read-only list table with admin-gated `[+ New partner]` button. |
| `src/app/dashboard/partners/[id]/page.tsx` | **Create** | Three panels — Identity, Activity stats, Recent transfers. Admin sees Edit / Suspend / Reactivate buttons. |
| `src/app/dashboard/partners/new/page.tsx` | **Create** | Admin-only create form. |
| `src/app/dashboard/partners/actions.ts` | **Create** | `createPartnerAction`, `updatePartnerAction`, `setPartnerStatusAction` — all `requireAdmin`. |
| `src/app/dashboard/transactions/page.tsx` | Modify | Read `?partner=<id>`, build `partnerById` lookup, filter transfers, pass map through to explorer. |
| `src/app/dashboard/transactions-explorer.tsx` | Modify | Pass `partnerById` through to tabs. |
| `src/app/dashboard/transactions-tabs.tsx` | Modify | Add `Partner` column between `Phone` and `Country`. Add filter dropdown at top. |
| `src/app/dashboard/customers/page.tsx` | Modify | Read `?partner=<id>`, build `partnerById`, filter, add `Partner` column + dropdown. |
| `src/app/dashboard/customers/[phone]/page.tsx` | Modify | Add `Partner` row to Identity panel after `Country`. |
| `src/app/globals.css` | Modify | Add `.sh-tag-partner-active`, `.sh-tag-partner-suspended` color variants. |
| `tests/partner-store.test.ts` | **Create** | CRUD round-trips + `ensureDefaultPartner` idempotency. |
| `tests/partners-actions.test.ts` | **Create** | Create/update/suspend actions + admin-only throws. |
| `tests/customer-store.test.ts` | Modify | 3 new partnerId tests. |
| `tests/transfer-create.test.ts` | Modify | 1 new partnerId test. |
| `tests/store-getTransfer.test.ts` | Modify | 2 new partnerId lazy-fill tests. |
| `tests/migration.test.ts` | Modify | 4 new `backfillPartnersOnce` tests. |
| `tests/bot-content-guard.test.ts` | **Create** | Hard-rule guard: scan all bot-content strings; assert none contain "partner". |
| `tests/e2e/dashboard-smoke.spec.ts` | Modify | Navigate to `/dashboard/partners`; assert table renders. |
| Test-fixture sweep on ~9 files | Modify | Add `partnerId: 'default' as const` to every Customer + Transfer literal. |

---

## Task 1: Types + defaults extension

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/defaults.ts`

Foundation. Pure types + one constant. Compiler is the test. Later tasks won't compile without these.

- [ ] **Step 1: Append new types to `src/lib/types.ts`**

At the end of `src/lib/types.ts` (after the existing `DEFAULT_CURRENCY_FOR_COUNTRY` map from P1), append:

```ts
// ── Partner entity (P2) ───────────────────────────────────────────────
//
// `partnerId` introduces the multi-tenant boundary. Every Customer and
// Transfer belongs to a Partner. Staff `partnerId` is optional — undefined
// means global admin (sees all partners' data). P3 will enforce sub-admin
// auth scoping; P2 just establishes the data field.

export type PartnerId = string;  // 'default' or newTransferId() output

export type PartnerStatus = 'active' | 'suspended';

export interface Partner {
  id: PartnerId;
  name: string;                       // staff-facing display name
  countries: CountryCode[];           // which Phase-1 countries this partner operates in
  status: PartnerStatus;
  // Whitelabel placeholders — optional until a real partner needs them.
  brandName?: string;                 // end-customer-facing brand (NOT used in P2; future whitelabel)
  primaryColor?: string;              // hex string e.g. '#1a73e8'
  logoUrl?: string;                   // CDN URL
  adminNote?: string;                 // internal staff annotation
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Extend `Customer`, `Transfer`, and `Staff` in `src/lib/types.ts`**

Find the existing `Customer` interface. Add `partnerId: PartnerId;` as a required field. The final shape:

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
  senderCountry: CountryCode;   // (P1) the routing field
  partnerId: PartnerId;         // NEW (P2) — required; multi-tenant boundary
  createdAt: string;
  updatedAt: string;
}
```

Find the existing `Transfer` interface. Add `partnerId: PartnerId;` at the end:

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
  sourceCountry: CountryCode;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  partnerId: PartnerId;         // NEW (P2) — required; multi-tenant boundary
}
```

Find the existing `Staff` interface. Add `partnerId?: PartnerId;` as an OPTIONAL field:

```ts
export interface Staff {
  username: string;
  name: string;
  role: StaffRole;
  permissions: StaffPermissions;
  passwordHash: string;
  createdAt: string;
  partnerId?: PartnerId;        // NEW (P2) — OPTIONAL: undefined = global admin; set = scoped (P3 enforces)
}
```

- [ ] **Step 3: Add `DEFAULT_PARTNER_ID` to `src/lib/defaults.ts`**

The existing file has 5 country/currency constants. Add a `PartnerId` import and one more constant:

```ts
import type { CountryCode, CurrencyCode, PartnerId } from './types';

export const DEFAULT_SENDER_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_CURRENCY: CurrencyCode = 'USD';
export const DEFAULT_DESTINATION_COUNTRY: CountryCode = 'IN';
export const DEFAULT_DESTINATION_CURRENCY: CurrencyCode = 'INR';
export const DEFAULT_PARTNER_ID: PartnerId = 'default';   // NEW (P2)
```

- [ ] **Step 4: Run typecheck — expect failures only at call sites**

Run: `npm run typecheck`
Expected: FAIL — `customer-store.ts`, `transfer-create.ts`, `migration.ts`, and ~9 test files will be missing the new required `partnerId` field. That's intentional; Tasks 2-7 fix them. **No errors should be inside `types.ts` or `defaults.ts`.**

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/p2-partner-entity
git add src/lib/types.ts src/lib/defaults.ts
git commit -m "types: add Partner entity + DEFAULT_PARTNER_ID (P2)

Adds PartnerId/PartnerStatus/Partner types. Extends Customer + Transfer
with required partnerId; Staff with optional partnerId (null = global
admin). DEFAULT_PARTNER_ID = 'default' added to defaults.ts.

Typecheck red at call sites until later tasks land."
```

---

## Task 2: Test-fixture sweep for `partnerId: 'default'`

**Files:** (modify only)
- `tests/agent.test.ts`
- `tests/analytics.test.ts`
- `tests/dashboard-ops.test.ts`
- `tests/dashboard.test.ts`
- `tests/payment.test.ts`
- `tests/store.test.ts`
- `tests/tier-rules.test.ts`
- `tests/tools.test.ts`
- `tests/migration.test.ts`
- `tests/customer-store.test.ts`
- `tests/transfer-create.test.ts`
- `tests/store-getTransfer.test.ts`

Same sweep pattern P1 used for `senderCountry`. Every Customer/Transfer literal needs `partnerId: 'default' as const,` added (or `partnerId: 'default'` if the surrounding object is typed via factory annotation).

- [ ] **Step 1: Run typecheck to discover exact line numbers**

```bash
npm run typecheck 2>&1 | grep "Property 'partnerId' is missing"
```

This lists every test file + line number that needs sweeping. Each error refers to a Customer or Transfer literal that needs the new field.

- [ ] **Step 2: Sweep each file**

For each `Customer` literal, add `partnerId: 'default'` (or `'default' as const`) at the end of the object before the closing brace. Example (existing `customer()` helper in `tests/tier-rules.test.ts`):

```ts
function customer(overrides: Partial<Customer> & { firstSeenAt: string }): Customer {
  return {
    senderPhone: '15551234567',
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId: 'default',          // NEW (P2)
    createdAt: overrides.firstSeenAt,
    updatedAt: overrides.firstSeenAt,
    ...overrides,
  };
}
```

For each `Transfer` literal, add the new field:

```ts
// Add at the end of the Transfer object literal, before the closing brace
partnerId: 'default',          // NEW (P2)
```

Many test files use a `makeTransfer()` / `awaitingTransfer()` / `sampleTransfer()` helper — fix the helper once and it covers all callers.

For inline `saveCustomer({...})` or `saveTransfer({...})` literals (e.g. in `tests/migration.test.ts`), add `partnerId: 'default' as const,` to the literal.

- [ ] **Step 3: Run typecheck — confirm clean**

```bash
npm run typecheck
```
Expected: ALL the "Property 'partnerId' is missing" errors gone. Remaining errors should be only the production-code sites that Tasks 3-7 fix (`customer-store.ts`, `transfer-create.ts`, `migration.ts`).

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all 325 existing tests pass. No new tests added in this task — just fixing fixture shape.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "tests: sweep Customer/Transfer literals to include partnerId: 'default' (P2)

Test-fixture sweep across 12 test files in preparation for P2's Partner
entity. Same pattern P1 used for senderCountry. No production code changes;
no behavior changes."
```

---

## Task 3: `partner-store.ts` + tests

**Files:**
- Create: `src/lib/partner-store.ts`
- Create: `tests/partner-store.test.ts`

Mirror the `customer-store.ts` pattern: factory + cached singleton + JSON record per id + set of ids for listing.

- [ ] **Step 1: Write the failing tests**

Create `tests/partner-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';

const DEFAULT_ID = 'default';

function buildPartner(id: string, overrides: Partial<{ name: string; countries: ('US'|'CA'|'GB'|'AE'|'SG'|'AU'|'NZ'|'IN')[]; status: 'active'|'suspended' }> = {}) {
  const now = '2026-05-27T12:00:00Z';
  return {
    id,
    name: overrides.name ?? 'Test Partner',
    countries: overrides.countries ?? (['US'] as const),
    status: overrides.status ?? ('active' as const),
    createdAt: now,
    updatedAt: now,
  };
}

describe('partner store', () => {
  it('getPartner returns null when no record', async () => {
    const ps = createPartnerStore(fakeRedis());
    expect(await ps.getPartner(DEFAULT_ID)).toBeNull();
  });

  it('savePartner + getPartner round-trips', async () => {
    const ps = createPartnerStore(fakeRedis());
    const p = buildPartner('acme', { name: 'Acme Remit', countries: ['CA'] });
    await ps.savePartner(p);
    expect(await ps.getPartner('acme')).toEqual(p);
  });

  it('listPartners returns every saved partner', async () => {
    const ps = createPartnerStore(fakeRedis());
    await ps.savePartner(buildPartner('a'));
    await ps.savePartner(buildPartner('b'));
    const all = await ps.listPartners();
    expect(all.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('listPartners returns [] when no partners exist', async () => {
    expect(await createPartnerStore(fakeRedis()).listPartners()).toEqual([]);
  });

  it('ensureDefaultPartner creates the default record when missing', async () => {
    const ps = createPartnerStore(fakeRedis());
    const p = await ps.ensureDefaultPartner();
    expect(p.id).toBe('default');
    expect(p.name).toBe('SendHome Default');
    expect(p.countries).toEqual(['US']);
    expect(p.status).toBe('active');
    expect(await ps.getPartner('default')).toEqual(p);
  });

  it('ensureDefaultPartner is idempotent — second call returns existing record unchanged', async () => {
    const ps = createPartnerStore(fakeRedis());
    const first = await ps.ensureDefaultPartner();
    // Simulate admin renaming the default
    await ps.savePartner({ ...first, name: 'Renamed Default', updatedAt: '2026-05-28T00:00:00Z' });
    const second = await ps.ensureDefaultPartner();
    expect(second.name).toBe('Renamed Default');  // NOT overwritten
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('returns null on JSON corruption rather than throwing', async () => {
    const redis = fakeRedis();
    await redis.set('partner:bad', 'not-json');
    const ps = createPartnerStore(redis);
    expect(await ps.getPartner('bad')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- partner-store`
Expected: FAIL — `Cannot find module '@/lib/partner-store'`.

- [ ] **Step 3: Create `src/lib/partner-store.ts`**

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { Partner, PartnerId } from './types';

export function createPartnerStore(redis: RedisLike) {
  return {
    async getPartner(id: PartnerId): Promise<Partner | null> {
      const raw = await redis.get(`partner:${id}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Partner;
      } catch {
        return null;
      }
    },

    async savePartner(partner: Partner): Promise<void> {
      await redis.set(`partner:${partner.id}`, JSON.stringify(partner));
      await redis.sadd('partners:ids', partner.id);
    },

    async listPartners(): Promise<Partner[]> {
      const ids = await redis.smembers('partners:ids');
      const all = await Promise.all(ids.map((id) => this.getPartner(id)));
      return all.filter((p): p is Partner => p !== null);
    },

    async ensureDefaultPartner(): Promise<Partner> {
      const existing = await this.getPartner('default');
      if (existing) return existing;
      const now = new Date().toISOString();
      const fresh: Partner = {
        id: 'default',
        name: 'SendHome Default',
        countries: ['US'],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      await this.savePartner(fresh);
      return fresh;
    },
  };
}

export type PartnerStore = ReturnType<typeof createPartnerStore>;

let cached: PartnerStore | null = null;

export function getPartnerStore(): PartnerStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createPartnerStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- partner-store`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/partner-store.ts tests/partner-store.test.ts
git commit -m "partner-store: factory + cached singleton + ensureDefaultPartner (P2)"
```

---

## Task 4: `customer-store` writes + lazy-fills `partnerId`

**Files:**
- Modify: `src/lib/customer-store.ts`
- Modify: `tests/customer-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/customer-store.test.ts`:

```ts
describe('customer-store P2: partnerId', () => {
  it('upsertOnFirstInbound writes partnerId: default on a brand-new customer', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550009999');
    expect(customer.partnerId).toBe('default');
  });

  it('upsertOnFirstInbound writes partnerId: default on a grandfathered customer', async () => {
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
    expect(customer.partnerId).toBe('default');
    expect(customer.kycStatus).toBe('grandfathered');
  });

  it('getCustomer fills missing partnerId in-memory without persisting', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    // Manually write a customer record missing partnerId (simulating pre-P2 data)
    await redis.set('customer:15550007777', JSON.stringify({
      senderPhone: '15550007777',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    const cs = createCustomerStore(redis, store);
    const c = await cs.getCustomer('15550007777');
    expect(c?.partnerId).toBe('default');
    // Verify NO persist happened
    const raw = await redis.get('customer:15550007777');
    expect(JSON.parse(raw!).partnerId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- customer-store`
Expected: FAIL on the 3 new tests — `partnerId` is undefined.

- [ ] **Step 3: Modify `src/lib/customer-store.ts`**

Add an import at the top:

```ts
import { DEFAULT_SENDER_COUNTRY, DEFAULT_PARTNER_ID } from './defaults';
```

In `getCustomer`, extend the lazy fill block (currently only fills `senderCountry`):

```ts
    async getCustomer(senderPhone: string): Promise<Customer | null> {
      const raw = await redis.get(`customer:${senderPhone}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Customer;
        // Lazy fill for pre-P1/P2 records missing required fields (in-memory only;
        // cron pass is the only writer for backfilled records)
        if (!parsed.senderCountry) {
          parsed.senderCountry = DEFAULT_SENDER_COUNTRY;
        }
        if (!parsed.partnerId) {
          parsed.partnerId = DEFAULT_PARTNER_ID;
        }
        return parsed;
      } catch {
        return null;
      }
    },
```

In `upsertOnFirstInbound`, add `partnerId: DEFAULT_PARTNER_ID,` to both Customer literals (grandfathered branch + brand-new branch). Final shape:

```ts
      const customer: Customer = minAt
        ? {
            senderPhone,
            firstSeenAt: minAt,
            kycStatus: 'grandfathered',
            kycVerifiedAt: nowIso,
            senderCountry: DEFAULT_SENDER_COUNTRY,
            partnerId: DEFAULT_PARTNER_ID,            // NEW (P2)
            createdAt: minAt,
            updatedAt: nowIso,
          }
        : {
            senderPhone,
            firstSeenAt: nowIso,
            kycStatus: 'not_started',
            senderCountry: DEFAULT_SENDER_COUNTRY,
            partnerId: DEFAULT_PARTNER_ID,            // NEW (P2)
            createdAt: nowIso,
            updatedAt: nowIso,
          };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- customer-store`
Expected: PASS — all existing tests + 3 new.

- [ ] **Step 5: Commit**

```bash
git add src/lib/customer-store.ts tests/customer-store.test.ts
git commit -m "customer-store: partnerId on new records + lazy fill on read (P2)"
```

---

## Task 5: `transfer-create` + `store.getTransfer` write/lazy-fill `partnerId`

**Files:**
- Modify: `src/lib/transfer-create.ts`
- Modify: `src/lib/store.ts`
- Modify: `tests/transfer-create.test.ts`
- Modify: `tests/store-getTransfer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/transfer-create.test.ts`:

```ts
describe('createTransfer P2: partnerId', () => {
  it('populates partnerId: default on new transfers', async () => {
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
    expect(t.partnerId).toBe('default');
  });
});
```

Append to `tests/store-getTransfer.test.ts`:

```ts
describe('store.getTransfer P2: partnerId lazy fill', () => {
  it('returns partnerId: default for old records missing it', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:OLDP2A', JSON.stringify({
      id: 'OLDP2A',
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
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    const store = createStore(redis);
    const t = await store.getTransfer('OLDP2A');
    expect(t?.partnerId).toBe('default');
  });

  it('does NOT persist the partnerId lazy fill', async () => {
    const redis = fakeRedis();
    await redis.set('transfer:OLDP2B', JSON.stringify({
      id: 'OLDP2B',
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
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    const store = createStore(redis);
    await store.getTransfer('OLDP2B');
    const raw = await redis.get('transfer:OLDP2B');
    expect(JSON.parse(raw!).partnerId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- transfer-create store-getTransfer`
Expected: FAIL on the 3 new tests — `partnerId` undefined.

- [ ] **Step 3: Modify `src/lib/transfer-create.ts`**

Add `DEFAULT_PARTNER_ID` to the existing defaults import:

```ts
import {
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
  DEFAULT_PARTNER_ID,
} from './defaults';
```

Inside the `transfer` literal in `createTransfer`, add the new field at the end (after `destinationCurrency`):

```ts
  const transfer: Transfer = {
    // ... all existing fields unchanged ...
    sourceCountry: DEFAULT_SOURCE_COUNTRY,
    sourceCurrency: DEFAULT_SOURCE_CURRENCY,
    destinationCountry: DEFAULT_DESTINATION_COUNTRY,
    destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
    partnerId: DEFAULT_PARTNER_ID,        // NEW (P2)
  };
```

- [ ] **Step 4: Modify `src/lib/store.ts` — lazy fill `partnerId` in `getTransfer`**

Add `DEFAULT_PARTNER_ID` to the existing defaults import:

```ts
import {
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
  DEFAULT_PARTNER_ID,
} from './defaults';
```

Extend the existing lazy-fill block in `getTransfer`:

```ts
    async getTransfer(id: string): Promise<Transfer | null> {
      const raw = await redis.get(`transfer:${id}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Transfer;
      // Lazy fill for pre-P1/P2 records (in-memory only; cron pass is the only writer)
      if (!parsed.sourceCountry) {
        parsed.sourceCountry = DEFAULT_SOURCE_COUNTRY;
        parsed.sourceCurrency = DEFAULT_SOURCE_CURRENCY;
        parsed.destinationCountry = DEFAULT_DESTINATION_COUNTRY;
        parsed.destinationCurrency = DEFAULT_DESTINATION_CURRENCY;
      }
      if (!parsed.partnerId) {
        parsed.partnerId = DEFAULT_PARTNER_ID;
      }
      return parsed;
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- transfer-create store-getTransfer`
Expected: PASS (1 + 2 new tests).

Also run full `npm test` and confirm no regression (the test-fixture sweep from Task 2 should keep everything else green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/transfer-create.ts src/lib/store.ts tests/transfer-create.test.ts tests/store-getTransfer.test.ts
git commit -m "transfer + store: partnerId on new transfers + lazy fill on read (P2)"
```

---

## Task 6: Migration `backfillPartnersOnce` + cron wiring

**Files:**
- Modify: `src/lib/migration.ts`
- Modify: `src/app/api/cron/route.ts`
- Modify: `tests/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/migration.test.ts`:

```ts
import { backfillPartnersOnce } from '@/lib/migration';
import { createPartnerStore } from '@/lib/partner-store';

describe('backfillPartnersOnce', () => {
  it('seeds the Default Partner when no partner exists', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);
    const result = await backfillPartnersOnce(store, cs, ps);
    expect(result.defaultPartnerCreated).toBe(true);
    expect(result.skippedSentinel).toBe(false);
    const p = await ps.getPartner('default');
    expect(p?.name).toBe('SendHome Default');
    expect(p?.countries).toEqual(['US']);
    expect(p?.status).toBe('active');
  });

  it('does NOT recreate Default Partner if it already exists (preserves edits)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);
    // Pre-existing default with a custom name
    await ps.savePartner({
      id: 'default',
      name: 'Custom Renamed Default',
      countries: ['US', 'CA'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const result = await backfillPartnersOnce(store, cs, ps);
    expect(result.defaultPartnerCreated).toBe(false);
    const p = await ps.getPartner('default');
    expect(p?.name).toBe('Custom Renamed Default');  // unchanged
  });

  it('backfills partnerId on existing customers + transfers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);

    // Pre-P2 customer (missing partnerId)
    await redis.set('customer:15551111111', JSON.stringify({
      senderPhone: '15551111111',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15551111111');

    // Pre-P2 transfer
    await redis.set('transfer:OLDPART1', JSON.stringify({
      id: 'OLDPART1',
      phone: '15551111111',
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
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    await redis.sadd('transfers:ids', 'OLDPART1');

    const result = await backfillPartnersOnce(store, cs, ps);
    expect(result.customersBackfilled).toBe(1);
    expect(result.transfersBackfilled).toBe(1);

    const rawC = JSON.parse((await redis.get('customer:15551111111'))!);
    expect(rawC.partnerId).toBe('default');
    const rawT = JSON.parse((await redis.get('transfer:OLDPART1'))!);
    expect(rawT.partnerId).toBe('default');
  });

  it('is idempotent — second call returns skippedSentinel: true and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);
    const first = await backfillPartnersOnce(store, cs, ps);
    const second = await backfillPartnersOnce(store, cs, ps);
    expect(first.skippedSentinel).toBe(false);
    expect(second.skippedSentinel).toBe(true);
    expect(second.defaultPartnerCreated).toBe(false);
    expect(second.customersBackfilled).toBe(0);
    expect(second.transfersBackfilled).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- migration`
Expected: FAIL — `backfillPartnersOnce` not exported.

- [ ] **Step 3: Extend `src/lib/migration.ts`**

Add imports at the top:

```ts
import type { PartnerStore } from './partner-store';
```

Add the sentinel constant near the others:

```ts
const PARTNER_SENTINEL_KEY = 'partner-backfill-v1';
```

Append the new function at the bottom of `src/lib/migration.ts`:

```ts
export async function backfillPartnersOnce(
  store: Store,
  customerStore: CustomerStore,
  partnerStore: PartnerStore,
): Promise<{
  defaultPartnerCreated: boolean;
  customersBackfilled: number;
  transfersBackfilled: number;
  skippedSentinel: boolean;
}> {
  const claimed = await store.claimMigrationFlag(PARTNER_SENTINEL_KEY);
  if (!claimed) {
    return {
      defaultPartnerCreated: false,
      customersBackfilled: 0,
      transfersBackfilled: 0,
      skippedSentinel: true,
    };
  }

  // Step 1: seed Default Partner if missing
  const existing = await partnerStore.getPartner('default');
  const defaultPartnerCreated = existing === null;
  if (defaultPartnerCreated) {
    const now = new Date().toISOString();
    await partnerStore.savePartner({
      id: 'default',
      name: 'SendHome Default',
      countries: ['US'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Step 2: backfill customers — lazy fill populated partnerId; re-save persists
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    await customerStore.saveCustomer({ ...c, updatedAt: new Date().toISOString() });
    customersBackfilled++;
  }

  // Step 3: backfill transfers
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({ ...t });
    transfersBackfilled++;
  }

  // Staff records NOT backfilled — partnerId stays optional (= global access).
  return { defaultPartnerCreated, customersBackfilled, transfersBackfilled, skippedSentinel: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- migration`
Expected: PASS — all existing + 4 new.

- [ ] **Step 5: Modify `src/app/api/cron/route.ts`**

Add imports at the top:

```ts
import { getPartnerStore } from '@/lib/partner-store';
import { backfillCustomersOnce, backfillCountryCurrencyOnce, backfillPartnersOnce } from '@/lib/migration';
```

Inside the GET handler, after the existing `customerStore` instantiation, add:

```ts
  const partnerStore = getPartnerStore();
```

After the existing two backfill calls, add:

```ts
  const partnerBackfill = await backfillPartnersOnce(store, customerStore, partnerStore);
```

Update the JSON response:

```ts
  return NextResponse.json({
    ok: true,
    fired: result.fired,
    backfill,
    countryCurrencyBackfill,
    partnerBackfill,          // NEW (P2)
  });
```

- [ ] **Step 6: Run full pipeline**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. Test count: 325 → ~333 (+8 new across this task's tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/migration.ts src/app/api/cron/route.ts tests/migration.test.ts
git commit -m "migration: backfillPartnersOnce + cron wiring (P2)

Sentinel-guarded third migration alongside B1's grandfather + P1's
country/currency backfills. Seeds Default Partner + re-saves existing
customers/transfers. Cron response now includes partnerBackfill field."
```

---

## Task 7: Dashboard `/dashboard/partners` section (CRUD + sidebar + CSS)

**Files:**
- Modify: `src/app/dashboard/sidebar.tsx`
- Create: `src/app/dashboard/partners/page.tsx`
- Create: `src/app/dashboard/partners/[id]/page.tsx`
- Create: `src/app/dashboard/partners/new/page.tsx`
- Create: `src/app/dashboard/partners/actions.ts`
- Create: `tests/partners-actions.test.ts`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Extend the sidebar**

In `src/app/dashboard/sidebar.tsx`, find the existing `SidebarActive` union. Add `'partners'`:

```ts
export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'customers'
  | 'partners'
  | 'compliance'
  | 'analytics'
  | 'team';
```

In the same file, find the `Customers` nav link. Immediately after it, add:

```tsx
      <Link
        href="/dashboard/partners"
        className={`sh-nav-item ${active === 'partners' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">◆</span> Partners
      </Link>
```

(If `◆` is already used by another nav item, pick another free unicode shape — `▣`, `▤`, `◈`. Check the existing icon set first.)

- [ ] **Step 2: Add partner-status badge CSS**

In `src/app/globals.css`, append:

```css
.sh-tag-partner-active {
  background: #dcfce7;
  color: #166534;
}
.sh-tag-partner-suspended {
  background: #fee2e2;
  color: #991b1b;
}
```

- [ ] **Step 3: Create `src/app/dashboard/partners/actions.ts`**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getPartnerStore } from '@/lib/partner-store';
import { newTransferId } from '@/lib/id';
import type { Partner, PartnerStatus } from '@/lib/types';

export async function createPartnerAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('Partner name is required.');

  const countries = formData.getAll('countries').map(String) as Partner['countries'];
  if (countries.length === 0) throw new Error('At least one country is required.');

  const id = newTransferId();
  const now = new Date().toISOString();
  const partner: Partner = {
    id,
    name,
    countries,
    status: 'active',
    brandName: String(formData.get('brandName') ?? '').trim() || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || undefined,
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await getPartnerStore().savePartner(partner);
  revalidatePath('/dashboard/partners');
  redirect(`/dashboard/partners/${id}`);
}

export async function updatePartnerAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Partner id is required.');

  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.');

  const updated: Partner = {
    ...existing,
    name: String(formData.get('name') ?? existing.name).trim() || existing.name,
    countries: (formData.getAll('countries').map(String) as Partner['countries']) || existing.countries,
    brandName: String(formData.get('brandName') ?? '').trim() || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || undefined,
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  await ps.savePartner(updated);
  revalidatePath('/dashboard/partners');
  revalidatePath(`/dashboard/partners/${id}`);
}

export async function setPartnerStatusAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  const status = String(formData.get('status') ?? '') as PartnerStatus;
  if (status !== 'active' && status !== 'suspended') {
    throw new Error('Status must be active or suspended.');
  }
  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.');
  await ps.savePartner({ ...existing, status, updatedAt: new Date().toISOString() });
  revalidatePath('/dashboard/partners');
  revalidatePath(`/dashboard/partners/${id}`);
}
```

- [ ] **Step 4: Write the actions tests**

Create `tests/partners-actions.test.ts`. Since these are server actions that call `requireAdmin()` (which reads cookies), tests need to mock the auth layer. Use the existing `vi.mock` pattern from other actions tests in the codebase. If you find the existing patterns hard to wire, a minimal approach:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

// Mock the auth layer so requireAdmin() always succeeds in tests
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ username: 'admin', role: 'admin' }),
  requireStaff: async () => ({ username: 'admin', role: 'admin' }),
}));

// Wire getPartnerStore to a fakeRedis instance
const sharedRedis = fakeRedis();
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => actual.createPartnerStore(sharedRedis),
  };
});

// Mock next/navigation.redirect since it throws in server-action context
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

// Mock next/cache.revalidatePath
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

beforeEach(() => sharedRedis.dump.clear());
afterEach(() => vi.clearAllMocks());

import { createPartnerAction, updatePartnerAction, setPartnerStatusAction } from '@/app/dashboard/partners/actions';
import { createPartnerStore } from '@/lib/partner-store';

const ps = createPartnerStore(sharedRedis);

describe('createPartnerAction', () => {
  it('creates a Partner with status active and a fresh id', async () => {
    const fd = new FormData();
    fd.set('name', 'Acme Remit');
    fd.append('countries', 'CA');
    await createPartnerAction(fd);
    const all = await ps.listPartners();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Acme Remit');
    expect(all[0].countries).toEqual(['CA']);
    expect(all[0].status).toBe('active');
    expect(all[0].id).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it('throws when name is empty', async () => {
    const fd = new FormData();
    fd.set('name', '');
    fd.append('countries', 'CA');
    await expect(createPartnerAction(fd)).rejects.toThrow(/name/i);
  });

  it('throws when no countries selected', async () => {
    const fd = new FormData();
    fd.set('name', 'X');
    await expect(createPartnerAction(fd)).rejects.toThrow(/country/i);
  });
});

describe('updatePartnerAction', () => {
  it('updates name + countries; preserves id/createdAt; bumps updatedAt', async () => {
    await ps.savePartner({
      id: 'p1', name: 'Old', countries: ['CA'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('name', 'Renamed');
    fd.append('countries', 'GB');
    await updatePartnerAction(fd);
    const got = await ps.getPartner('p1');
    expect(got?.name).toBe('Renamed');
    expect(got?.countries).toEqual(['GB']);
    expect(got?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(got?.updatedAt).not.toBe('2026-01-01T00:00:00Z');
  });
});

describe('setPartnerStatusAction', () => {
  it('flips active to suspended', async () => {
    await ps.savePartner({
      id: 'p1', name: 'X', countries: ['CA'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('status', 'suspended');
    await setPartnerStatusAction(fd);
    expect((await ps.getPartner('p1'))?.status).toBe('suspended');
  });

  it('flips suspended back to active', async () => {
    await ps.savePartner({
      id: 'p1', name: 'X', countries: ['CA'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    const fd = new FormData();
    fd.set('id', 'p1');
    fd.set('status', 'active');
    await setPartnerStatusAction(fd);
    expect((await ps.getPartner('p1'))?.status).toBe('active');
  });
});
```

NOTE: if the `vi.mock` for `@/lib/auth` doesn't take effect because of how the actions file imports it, fall back to testing only business logic (skip the admin-vs-not enforcement test — `requireAdmin` has its own test coverage elsewhere).

- [ ] **Step 5: Run actions tests**

Run: `npm test -- partners-actions`
Expected: PASS (6 cases) — or, if mocks don't work cleanly, simplify the file to just check the business logic of each action via the store directly.

- [ ] **Step 6: Create `src/app/dashboard/partners/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../sidebar';
import type { Partner, PartnerStatus } from '@/lib/types';

function statusBadge(s: PartnerStatus): string {
  return s === 'active' ? 'sh-tag sh-tag-partner-active' : 'sh-tag sh-tag-partner-suspended';
}

export default async function PartnersPage() {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';

  const store = getStore();
  const customerStore = getCustomerStore(store);
  const partnerStore = getPartnerStore();

  const [partners, customers, transfers] = await Promise.all([
    partnerStore.listPartners(),
    customerStore.listCustomers(),
    store.listTransfers(),
  ]);

  // Counts per partner
  const counts = new Map<string, { customers: number; transfers: number }>();
  for (const c of customers) {
    const e = counts.get(c.partnerId) ?? { customers: 0, transfers: 0 };
    e.customers++;
    counts.set(c.partnerId, e);
  }
  for (const t of transfers) {
    const e = counts.get(t.partnerId) ?? { customers: 0, transfers: 0 };
    e.transfers++;
    counts.set(t.partnerId, e);
  }

  // Sort: default first, then alphabetical by name
  const rows = partners.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Partners</div>
            <div className="sh-page-sub">{partners.length} total</div>
          </div>
          {isAdmin && (
            <Link href="/dashboard/partners/new" className="sh-btn-primary">
              + New partner
            </Link>
          )}
        </div>

        <div className="sh-card">
          <div className="sh-ledger-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Countries</th>
                  <th>Customers</th>
                  <th>Transfers</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="sh-empty">No partners yet.</td></tr>
                )}
                {rows.map((p: Partner) => {
                  const c = counts.get(p.id) ?? { customers: 0, transfers: 0 };
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/dashboard/partners/${p.id}`}>{p.name}</Link>
                      </td>
                      <td><span className={statusBadge(p.status)}>{p.status}</span></td>
                      <td>{p.countries.join(', ')}</td>
                      <td>{c.customers}</td>
                      <td>{c.transfers}</td>
                      <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 7: Create `src/app/dashboard/partners/[id]/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../../sidebar';
import { updatePartnerAction, setPartnerStatusAction } from '../actions';
import type { Partner } from '@/lib/types';

const ALL_COUNTRIES: Partner['countries'] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';
  const { id } = await params;

  const store = getStore();
  const partnerStore = getPartnerStore();
  const partner = await partnerStore.getPartner(id);
  if (!partner) notFound();

  const transfers = (await store.listTransfers()).filter((t) => t.partnerId === id);
  const totalVolumeCents = transfers.reduce((acc, t) => acc + Math.round(t.amountUsd * 100), 0);

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{partner.name}</div>
            <div className="sh-page-sub">Partner · {partner.id}</div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head"><h3>Identity</h3></div>
          <div className="sh-card-body">
            <dl className="sh-dl">
              <dt>ID</dt><dd>{partner.id}</dd>
              <dt>Status</dt><dd>{partner.status}</dd>
              <dt>Countries</dt><dd>{partner.countries.join(', ')}</dd>
              <dt>Brand name</dt><dd>{partner.brandName ?? '—'}</dd>
              <dt>Primary color</dt><dd>{partner.primaryColor ?? '—'}</dd>
              <dt>Logo URL</dt><dd>{partner.logoUrl ?? '—'}</dd>
              <dt>Admin note</dt><dd>{partner.adminNote ?? '—'}</dd>
              <dt>Created</dt><dd>{new Date(partner.createdAt).toLocaleString()}</dd>
              <dt>Updated</dt><dd>{new Date(partner.updatedAt).toLocaleString()}</dd>
            </dl>
            {isAdmin && (
              <details className="sh-inline-form">
                <summary>Edit</summary>
                <form action={updatePartnerAction} className="sh-inline-form">
                  <input type="hidden" name="id" value={partner.id} />
                  <label>Name <input name="name" defaultValue={partner.name} className="sh-input" /></label>
                  <div>
                    Countries:
                    {ALL_COUNTRIES.map((c) => (
                      <label key={c}>
                        <input
                          type="checkbox"
                          name="countries"
                          value={c}
                          defaultChecked={partner.countries.includes(c)}
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                  <label>Brand name <input name="brandName" defaultValue={partner.brandName ?? ''} className="sh-input" /></label>
                  <label>Primary color <input type="color" name="primaryColor" defaultValue={partner.primaryColor ?? '#000000'} /></label>
                  <label>Logo URL <input name="logoUrl" defaultValue={partner.logoUrl ?? ''} className="sh-input" /></label>
                  <label>Admin note <input name="adminNote" defaultValue={partner.adminNote ?? ''} className="sh-input" /></label>
                  <button type="submit" className="sh-btn-primary">Save</button>
                </form>
              </details>
            )}
            {isAdmin && (
              <form action={setPartnerStatusAction} className="sh-inline-form">
                <input type="hidden" name="id" value={partner.id} />
                <input type="hidden" name="status" value={partner.status === 'active' ? 'suspended' : 'active'} />
                <button type="submit" className="sh-btn-secondary">
                  {partner.status === 'active' ? 'Suspend' : 'Reactivate'}
                </button>
              </form>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head"><h3>Activity</h3></div>
          <div className="sh-card-body">
            <dl className="sh-dl">
              <dt>Transfer count</dt><dd>{transfers.length}</dd>
              <dt>Lifetime volume</dt><dd>${(totalVolumeCents / 100).toFixed(2)}</dd>
            </dl>
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head"><h3>Recent transfers</h3></div>
          <div className="sh-card-body">
            <table className="sh-table">
              <thead>
                <tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {transfers.length === 0 && (
                  <tr><td colSpan={4} className="sh-empty">No transfers for this partner yet.</td></tr>
                )}
                {transfers.slice(0, 50).map((t) => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td>${t.amountUsd.toFixed(2)}</td>
                    <td>{t.status}</td>
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 8: Create `src/app/dashboard/partners/new/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { requireAdmin } from '@/lib/auth';
import { Sidebar } from '../../sidebar';
import { createPartnerAction } from '../actions';
import type { Partner } from '@/lib/types';

const ALL_COUNTRIES: Partner['countries'] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

export default async function NewPartnerPage() {
  await requireAdmin();

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">New partner</div>
            <div className="sh-page-sub">Create a new tenant. Customers and transfers can be assigned to this partner later.</div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-body">
            <form action={createPartnerAction} className="sh-inline-form">
              <label>Name <input name="name" required className="sh-input" /></label>
              <div>
                Countries (select at least one):
                {ALL_COUNTRIES.map((c) => (
                  <label key={c}><input type="checkbox" name="countries" value={c} /> {c}</label>
                ))}
              </div>
              <label>Brand name (optional) <input name="brandName" className="sh-input" /></label>
              <label>Primary color (optional) <input type="color" name="primaryColor" /></label>
              <label>Logo URL (optional) <input name="logoUrl" className="sh-input" /></label>
              <label>Admin note (optional) <input name="adminNote" className="sh-input" /></label>
              <button type="submit" className="sh-btn-primary">Create partner</button>
            </form>
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 9: Run typecheck + lint + tests + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. Test count: ~339 (+6 actions tests).

- [ ] **Step 10: Commit**

```bash
git add src/app/dashboard/sidebar.tsx src/app/dashboard/partners/ src/app/globals.css tests/partners-actions.test.ts
git commit -m "dashboard: /dashboard/partners section (list + detail + new + actions) (P2)

Read-only list for all staff; admin-only Create/Edit/Suspend buttons.
Three panels on detail page (Identity, Activity, Recent transfers).
Sidebar nav + tier badge CSS."
```

---

## Task 8: Partner column + URL filter on existing pages + Identity row

**Files:**
- Modify: `src/app/dashboard/transactions/page.tsx`
- Modify: `src/app/dashboard/transactions-explorer.tsx`
- Modify: `src/app/dashboard/transactions-tabs.tsx`
- Modify: `src/app/dashboard/customers/page.tsx`
- Modify: `src/app/dashboard/customers/[phone]/page.tsx`

- [ ] **Step 1: Read each file end-to-end**

Use Read tool on each. Note current column ordering, existing prop plumbing, and where `?searchParams` is consumed.

- [ ] **Step 2: Modify `src/app/dashboard/transactions/page.tsx`**

Add imports:

```tsx
import { getPartnerStore } from '@/lib/partner-store';
import type { Partner } from '@/lib/types';
```

In the data fetch:

```tsx
const store = getStore();
const customerStore = getCustomerStore(store);
const partnerStore = getPartnerStore();
const [transfers, customers, partners] = await Promise.all([
  store.listTransfers(),
  customerStore.listCustomers(),
  partnerStore.listPartners(),
]);
const now = new Date();
const tierByPhone: Record<string, Tier> = {};
for (const c of customers) tierByPhone[c.senderPhone] = deriveTier(c, now);

// Build partnerById map for display
const partnerById: Record<string, Partner> = {};
for (const p of partners) partnerById[p.id] = p;

// URL filter
const params = await searchParams;
const partnerFilter = String(params.partner ?? '');
const filteredTransfers = partnerFilter
  ? transfers.filter((t) => t.partnerId === partnerFilter)
  : transfers;
```

Pass `partnerById` AND `partnerFilter` to the explorer.

- [ ] **Step 3: Modify `src/app/dashboard/transactions-explorer.tsx`**

Add `partnerById: Record<string, Partner>` and `currentPartner: string` to props. Pass `partnerById` through to `<TransactionsTabs>`.

Add a partner filter dropdown at the top of the explorer (before the tabs). If `transactions-explorer.tsx` is a server component, use a plain HTML GET form (auto-submits on change isn't possible without client JS — use a Submit button or convert the component to client):

```tsx
<form className="sh-filter-form" method="get">
  <label>Partner: </label>
  <select name="partner" defaultValue={currentPartner ?? ''}>
    <option value="">All partners</option>
    {Object.values(partnerById).map((p) => (
      <option key={p.id} value={p.id}>{p.name}</option>
    ))}
  </select>
  <button type="submit" className="sh-btn-secondary">Apply</button>
</form>
```

If the explorer is already a client component (`'use client'`), use the URL-update pattern:

```tsx
onChange={(e) => {
  const url = new URL(window.location.href);
  if (e.target.value) url.searchParams.set('partner', e.target.value);
  else url.searchParams.delete('partner');
  window.location.href = url.toString();
}}
```

Match the existing component's client/server boundary.

- [ ] **Step 4: Modify `src/app/dashboard/transactions-tabs.tsx`**

Add `partnerById: Record<string, Partner>` to props. In the table headers, add `<th>Partner</th>` between `Phone` and `Tier`:

```tsx
                <th>Partner</th>
```

In the row body, render the partner name:

```tsx
<td>{partnerById[t.partnerId]?.name ?? t.partnerId}</td>
```

If there's an empty-state `colSpan`, increment by 1.

- [ ] **Step 5: Modify `src/app/dashboard/customers/page.tsx`**

Same pattern: fetch `partnerStore.listPartners()`, build `partnerById`, read `?partner=` from `searchParams`, filter. Add a `<th>Partner</th>` column header between Phone and Country; render `{partnerById[c.partnerId]?.name ?? c.partnerId}` in the cell. Add the filter dropdown at the top.

- [ ] **Step 6: Modify `src/app/dashboard/customers/[phone]/page.tsx`**

In the Identity panel `<dl>`, add a row after the existing Country row:

```tsx
<dt>Partner</dt>
<dd>{partner ? partner.name : customer.partnerId}</dd>
```

Where `partner` is loaded at the top via:

```tsx
const partnerStore = getPartnerStore();
const partner = await partnerStore.getPartner(customer.partnerId);
```

- [ ] **Step 7: Run typecheck + lint + tests + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green.

- [ ] **Step 8: Commit**

```bash
git add src/app/dashboard/transactions/page.tsx src/app/dashboard/transactions-explorer.tsx \
        src/app/dashboard/transactions-tabs.tsx src/app/dashboard/customers/page.tsx \
        src/app/dashboard/customers/[phone]/page.tsx
git commit -m "dashboard: Partner column + ?partner=<id> filter on customers/transactions + Identity row (P2)"
```

---

## Task 9: "Bot never mentions partner" guard + Playwright smoke + CI + PR + merge + verification

**Files:**
- Create: `tests/bot-content-guard.test.ts`
- Modify: `tests/e2e/dashboard-smoke.spec.ts`

Final delivery task — bake in the bot-hard-rule guard, extend the Playwright smoke, ship through CI/CD.

- [ ] **Step 1: Create the bot-content guard test**

Create `tests/bot-content-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Hard rule (P2): no string assigned to a chat-message `content` field
// anywhere in the bot code path may contain the word "partner".
// This guards against accidentally surfacing tenant-internal terminology
// to end-customers via the WhatsApp bot.
describe('P2 hard rule: bot never mentions partner in any chat content', () => {
  const filesToScan = [
    'src/lib/prompt.ts',
    'src/lib/agent.ts',
    'src/lib/tools.ts',
    'tests/agent.test.ts',
    'tests/e2e.test.ts',
  ];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content containing "partner"`, () => {
      const full = resolve(process.cwd(), rel);
      const contents = readFileSync(full, 'utf-8');
      // Find every `content: '...'` or `content: "..."` literal and assert
      // none of the captured strings contain 'partner' (case-insensitive).
      // matchAll iterates all matches without using exec().
      const pattern = /content:\s*['"`]([^'"`]*?)['"`]/g;
      const matches = [...contents.matchAll(pattern)];
      for (const m of matches) {
        const text = m[1];
        expect(text.toLowerCase()).not.toContain('partner');
      }
    });
  }
});
```

NOTE: this regex-based scan is a heuristic. If a string value legitimately needs the word "partner" in a non-bot-output context (e.g., a system-prompt instruction about partners that the bot should NEVER repeat verbatim), the spec hard rule still applies — the bot should never echo it. Narrow the file list or the regex if you hit a false positive.

- [ ] **Step 2: Run the guard test**

```bash
npm test -- bot-content-guard
```
Expected: PASS — none of the scanned files contain "partner" in any `content:` string.

- [ ] **Step 3: Extend the Playwright smoke**

In `tests/e2e/dashboard-smoke.spec.ts`, after the existing `/dashboard/customers` assertion, add:

```ts
  await page.getByRole('link', { name: /partners/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/partners/);
  await expect(
    page.getByRole('table').or(page.getByText(/no partners yet/i)),
  ).toBeVisible();
```

- [ ] **Step 4: Full local CI pipeline**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. Test count: ~345 (+~5 from this task including the guard's 5 file-scoped assertions).

- [ ] **Step 5: Push the branch**

```bash
git add tests/bot-content-guard.test.ts tests/e2e/dashboard-smoke.spec.ts
git commit -m "ci(smoke): assert /dashboard/partners renders + bot-content guard for 'partner' (P2)"
git push -u origin feat/p2-partner-entity
```

- [ ] **Step 6: Open PR #8**

```bash
gh pr create --base main --head feat/p2-partner-entity \
  --title "feat(P2): Partner entity + dashboard partner filter + CRUD" \
  --body "$(cat <<'EOF'
Implements [docs/superpowers/specs/2026-05-27-partner-entity-dashboard-design.md](docs/superpowers/specs/2026-05-27-partner-entity-dashboard-design.md) via the 9-task plan at [docs/superpowers/plans/2026-05-27-partner-entity-dashboard.md](docs/superpowers/plans/2026-05-27-partner-entity-dashboard.md).

**Sub-project 2 of 5 of the multi-country platform reshape.**

## Summary
- New \`Partner\` Redis entity + types (\`PartnerId\`, \`PartnerStatus\`).
- Every Customer/Transfer gains required \`partnerId\`; Staff gains optional \`partnerId\` (null = global admin).
- New \`/dashboard/partners\` section: list + detail + admin-only create form + actions (create, update, suspend/reactivate).
- New Partner column + \`?partner=<id>\` URL filter on \`/dashboard/customers\` and \`/dashboard/transactions\`.
- Partner row added to customer detail Identity panel.
- Third sentinel-guarded migration (\`backfillPartnersOnce\`) seeds Default Partner + backfills existing records. Cron response includes \`partnerBackfill\`.
- \`DEFAULT_PARTNER_ID = 'default'\` added to \`defaults.ts\`.
- **Hard rule: bot never mentions partner in chat** — enforced by guard test scanning bot-content strings.

## Reliability
- Lazy fill on read paths is side-effect-free (no Redis writes on get).
- Migration sentinel-guarded — idempotent forever.
- \`ensureDefaultPartner\` doesn't overwrite admin-edited records.
- Old records render correctly without waiting for the cron.

## Test plan
- [x] \`npm run typecheck\` / \`npm run lint\` / \`npm test\` / \`npm run build\` — all green
- [x] ~345 tests pass (was 325 before P2)
- [ ] Post-merge: \`/api/cron\` triggers \`partnerBackfill\` on first call
- [ ] Post-merge: \`/dashboard/partners\` lists Default Partner with correct counts
- [ ] Post-merge: \`/dashboard/customers\` + \`/dashboard/transactions\` show Partner column
- [ ] Post-merge: Playwright smoke navigates to \`/dashboard/partners\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Watch CI**

```bash
gh pr checks --watch
```
Expected: `ci` green in ~40s; `Vercel` preview green.

- [ ] **Step 8: Merge through branch protection**

```bash
gh pr merge --squash --delete-branch
git checkout main && git pull --ff-only
```

- [ ] **Step 9: Verify Vercel prod deploy + Playwright smoke**

```bash
sleep 90
vercel ls claude-payments --yes | head -5
gh run list --workflow smoke.yml --limit 1 --branch main
```
Expected: latest prod deploy from merge commit is Ready; latest smoke run on main is success.

- [ ] **Step 10: Trigger the cron for the new partner backfill**

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
  "countryCurrencyBackfill": { "skippedSentinel": true },
  "partnerBackfill": {
    "defaultPartnerCreated": true,
    "customersBackfilled": N,
    "transfersBackfilled": M,
    "skippedSentinel": false
  }
}
```

Second call returns `"partnerBackfill": { ..., "skippedSentinel": true }`.

- [ ] **Step 11: Manual production verification**

In the live dashboard logged in as admin:
- [ ] `/dashboard/partners` lists `SendHome Default` with `status: active`, `countries: US`, and accurate customer/transfer counts.
- [ ] Click `SendHome Default` → detail page renders Identity, Activity, Recent transfers panels.
- [ ] `[+ New partner]` button visible; submitting the create form lands a new Partner with status `active`.
- [ ] `/dashboard/customers` shows Partner column with `SendHome Default` for every row.
- [ ] `?partner=default` filter narrows to default-partner customers only.
- [ ] `/dashboard/transactions` same.
- [ ] `/dashboard/customers/[phone]` detail Identity panel shows a Partner row.
- [ ] Send a WhatsApp message → bot acts identically; reply contains NO mention of partner.

---

## Self-review

### Spec coverage

| Spec section | Task |
|---|---|
| `PartnerId` + `PartnerStatus` + `Partner` types | Task 1 |
| `Customer.partnerId` required | Task 1 |
| `Transfer.partnerId` required | Task 1 |
| `Staff.partnerId` optional | Task 1 |
| `DEFAULT_PARTNER_ID` constant | Task 1 |
| `partner-store.ts` factory + singleton | Task 3 |
| `partner:<id>` + `partners:ids` Redis schema | Task 3 |
| `ensureDefaultPartner` idempotent | Task 3 |
| `customer-store` writes `partnerId` on new records | Task 4 |
| `customer-store.getCustomer` lazy-fills | Task 4 |
| `transfer-create` populates `partnerId` | Task 5 |
| `store.getTransfer` lazy-fills | Task 5 |
| `backfillPartnersOnce` migration | Task 6 |
| Cron route includes `partnerBackfill` | Task 6 |
| Sidebar nav `Partners` | Task 7 |
| `/dashboard/partners` list page | Task 7 |
| `/dashboard/partners/[id]` detail | Task 7 |
| `/dashboard/partners/new` form | Task 7 |
| `partners/actions.ts` (createPartnerAction, updatePartnerAction, setPartnerStatusAction) | Task 7 |
| Tier badge CSS for partner status | Task 7 |
| Partner column on `/dashboard/transactions` + filter | Task 8 |
| Partner column on `/dashboard/customers` + filter | Task 8 |
| Partner row on customer detail Identity | Task 8 |
| Hard rule: bot never mentions partner (content guard) | Task 9 |
| Playwright smoke navigates to `/dashboard/partners` | Task 9 |
| Local CI + PR + merge + cron trigger + manual verification | Task 9 |

All spec sections traced to tasks. No gaps.

### Placeholder scan

Searched for TBD / TODO / "fill in" / "implement later" — none present in the plan body. Notes about client/server boundary choices (Task 8 step 3) and `vi.mock` fallback (Task 7 step 4) are real implementation choices, not placeholders.

### Type consistency

- `PartnerId`, `PartnerStatus`, `Partner` defined in Task 1, used in Tasks 3, 4, 5, 6, 7, 8.
- `DEFAULT_PARTNER_ID` defined in Task 1, imported in Tasks 4, 5, 6.
- `PartnerStore` type defined in Task 3, used in Tasks 6 (migration), 7 (dashboard), 8 (filter pages).
- `partnerBackfill` JSON field defined in Task 6, surfaced in Task 9 verification.
- `getPartnerStore()` singleton defined in Task 3, called in Tasks 6, 7, 8.
- Server actions (`createPartnerAction` etc.) defined in Task 7, invoked from create + detail pages in Task 7 and tested in Task 7's actions test.
- All Customer + Transfer literal sweeps from Task 2 carry through to subsequent tasks.

No type drift.

### Dependency order

- Task 1 → foundation
- Task 2 → sweep (after types; before any code that uses Customer/Transfer fixtures)
- Tasks 3, 4, 5 → can run after Task 2 (parallelizable in concept; serialize per skill)
- Task 6 → after 3 (needs PartnerStore)
- Tasks 7, 8 → after 6 (need partner data + types wired)
- Task 9 → after all (verification + ship)

Subagent-driven execution: dispatch in 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 order.
