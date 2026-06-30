# Cross-border B2B invoicing — Phase 1, Plan 1: Foundation (HKD corridor + sellers data layer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hong Kong / HKD as the 9th supported corridor across the type system, and create the encrypted, tenant-scoped `sellers` data layer that the rest of cross-border B2B builds on.

**Architecture:** Two independent foundations. (1) Extend the closed `CountryCode`/`CurrencyCode` unions + every dependent map so HKD is first-class — TypeScript's exhaustive `Record<CountryCode, …>` types make the compiler enumerate every map that must gain an HK entry. (2) A new `sellers` table + repo storing a registered seller's identity and **envelope-encrypted** payout destination, partner-scoped for tenant isolation, mirroring the existing `b2b_invoices` table + `createB2bInvoiceRepo` patterns.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM (Neon/PGlite), Vitest + PGlite (`freshDb()`) + `fakeRedis`, `field-crypto` (AES-256-GCM envelope).

## Global Constraints (apply to every task)

- **Non-custodial:** no code path where SmartRemit holds/captures funds. (No funds logic in this plan, but keep it true.)
- **Sanctions screening always runs** and is structurally untoggleable. Sellers carry a `sanctionsStatus`; this plan only stores the field (screening wired in Plan 2).
- **Encryption at rest:** payout destinations are envelope-encrypted (`field-crypto`); default reads are masked (`****last4`); decrypted reads are explicit + audited.
- **Tenant isolation is app-level:** every seller query carries `partnerId` in the WHERE; a seller is resolved by `(partnerId, phone)`.
- **Phone discipline:** seller/buyer phones are stored digits-only (`normalizePhone`) and validated (`isValidPhone`) at the write boundary.
- **Currency set:** exactly 9 corridors after this plan — `USD, CAD, GBP, AED, SGD, AUD, NZD, INR, HKD`.
- **Migrations are MANUAL in prod:** after the migration PR merges, run `set -a; source .env.local; set +a; npx drizzle-kit migrate` against prod Neon (CLAUDE.md gotcha).
- **No direct pushes to `main`:** each task commits to the working branch; the branch is PR'd + `ci/ci`-checked before merge.

> **Plan 1 of 5 for Phase 1.** Subsequent plans (written when reached): **2** seller onboarding (WhatsApp-start + web-finish), **3** cross-border invoice + live-at-payment quote, **4** buyer pay path + non-custodial dual-leg `bank_pull` settlement, **5** `create_invoice` tool + delivery. Spec: `docs/superpowers/specs/2026-06-30-crossborder-b2b-invoicing-design.md`.

---

### Task 1: Add Hong Kong / HKD as the 9th corridor

**Files:**
- Modify: `src/lib/types.ts` (`CountryCode`, `CurrencyCode`, `DEFAULT_CURRENCY_FOR_COUNTRY`)
- Modify: `src/lib/rate.ts` (`FALLBACK_FX_RATES`)
- Modify: `src/lib/partner-currency.ts` (`CALLING_CODE_TO_COUNTRY`)
- Modify: `src/lib/payout-format.ts` (`BANK_FIELDS_BY_COUNTRY`)
- Modify: `src/lib/defaults.ts` (`DEFAULT_PARTNER_COUNTRIES`)
- Test: `tests/hkd-corridor.test.ts` (new)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `'HK'` is a valid `CountryCode`, `'HKD'` a valid `CurrencyCode`; `DEFAULT_CURRENCY_FOR_COUNTRY.HK === 'HKD'`; `currencyForPhone('852…') === 'HKD'`; `countryForCurrency('HKD') === 'HK'`; `FALLBACK_FX_RATES.HKD`; `BANK_FIELDS_BY_COUNTRY.HK`.

- [ ] **Step 1: Write the failing test**

Create `tests/hkd-corridor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';
import { FALLBACK_FX_RATES } from '@/lib/rate';
import { BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';
import { currencyForPhone, countryForPhone, countryForCurrency } from '@/lib/partner-currency';

describe('HKD / Hong Kong is a first-class corridor', () => {
  it('maps the country to its home currency', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.HK).toBe('HKD');
  });

  it('resolves a +852 phone to HK / HKD', () => {
    expect(countryForPhone('85291234567')).toBe('HK');
    expect(currencyForPhone('85291234567')).toBe('HKD');
  });

  it('resolves HKD back to its country', () => {
    expect(countryForCurrency('HKD')).toBe('HK');
  });

  it('has an offline fallback rate (HKD is USD-pegged ≈ 7.8/USD)', () => {
    expect(FALLBACK_FX_RATES.HKD).toBeDefined();
    expect(FALLBACK_FX_RATES.HKD.toUsd).toBeCloseTo(0.128, 2);
  });

  it('defines HK bank fields (bank code + branch code + account)', () => {
    const keys = BANK_FIELDS_BY_COUNTRY.HK.map((f) => f.key);
    expect(keys).toEqual(['bankCode', 'branchCode', 'accountNumber']);
  });

  it('the default tenant serves HK (unambiguous +852 calling code)', () => {
    expect(DEFAULT_PARTNER_COUNTRIES).toContain('HK');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/hkd-corridor.test.ts`
Expected: FAIL — and `npx tsc --noEmit` reports errors like *"Property 'HK' is missing in type … DEFAULT_CURRENCY_FOR_COUNTRY"* / *"… FALLBACK_FX_RATES"* / *"… BANK_FIELDS_BY_COUNTRY"*. (That enumeration IS the to-do list — every `Record<CountryCode, …>` must gain HK.)

- [ ] **Step 3: Add HK/HKD to the unions + country→currency map**

In `src/lib/types.ts`, extend the two unions and the map (keep the existing alignment/comments):

```ts
export type CountryCode =
  | 'US' | 'CA' | 'GB' | 'AE' | 'SG' | 'AU' | 'NZ' | 'IN' | 'HK';

export type CurrencyCode =
  | 'USD' | 'CAD' | 'GBP' | 'AED' | 'SGD' | 'AUD' | 'NZD' | 'INR' | 'HKD';

export const DEFAULT_CURRENCY_FOR_COUNTRY: Record<CountryCode, CurrencyCode> = {
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AE: 'AED',
  SG: 'SGD',
  AU: 'AUD',
  NZ: 'NZD',
  IN: 'INR',
  HK: 'HKD',
};
```

- [ ] **Step 4: Add the HKD offline fallback rate**

In `src/lib/rate.ts`, add to `FALLBACK_FX_RATES` (HKD is pegged ≈ 7.8 HKD/USD ⇒ `toUsd ≈ 0.128`; `toInr ≈ 85 × 0.128 ≈ 10.9`):

```ts
  INR: { toInr: 1, toUsd: 0.0118 }, // ≈ 1/85; any-to-any offline fallback for an INR SOURCE (e.g. India → US)
  HKD: { toInr: 10.9, toUsd: 0.128 }, // HKD is USD-pegged ≈ 7.8/USD; Frankfurter serves it live
};
```

- [ ] **Step 5: Map the +852 calling code**

In `src/lib/partner-currency.ts`, add `'852'` to `CALLING_CODE_TO_COUNTRY`:

```ts
const CALLING_CODE_TO_COUNTRY: Record<string, CountryCode> = {
  '1': 'US', '44': 'GB', '971': 'AE', '61': 'AU', '64': 'NZ', '65': 'SG', '91': 'IN', '852': 'HK',
};
```

- [ ] **Step 6: Add the HK bank-field schema**

In `src/lib/payout-format.ts`, add an `HK` entry to `BANK_FIELDS_BY_COUNTRY` (HK domestic transfer = 3-digit bank code + 3-digit branch code + account number):

```ts
  HK: [
    { key: 'bankCode', label: 'Bank code', digits: 3 },
    { key: 'branchCode', label: 'Branch code', digits: 3 },
    { ...ACCOUNT_FIELD },
  ],
};
```

- [ ] **Step 7: Add HK to the default tenant's countries**

In `src/lib/defaults.ts`, append `'HK'` (its `+852` code is unambiguous, so phone detection works):

```ts
export const DEFAULT_PARTNER_COUNTRIES: CountryCode[] = ['US', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN', 'HK'];
```

- [ ] **Step 8: Update any human-facing "8 countries" copy**

Run: `grep -rn "8 supported\|eight supported\|8 countries\|eight countries" src/lib src/app | grep -v node_modules`
For each hit (e.g. a `capture_corridor_request` tool description / system-prompt corridor list), change the count to 9 and add **Hong Kong (HKD)** to the enumerated list. If there are no hits, skip.

- [ ] **Step 9: Run the test + full typecheck to verify it passes**

Run: `npx vitest run tests/hkd-corridor.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc clean (every `Record<CountryCode, …>` now has HK).

- [ ] **Step 10: Commit**

```bash
git add src/lib/types.ts src/lib/rate.ts src/lib/partner-currency.ts src/lib/payout-format.ts src/lib/defaults.ts tests/hkd-corridor.test.ts src/app
git commit -m "feat(corridors): add Hong Kong / HKD as the 9th supported corridor"
```

---

### Task 2: `sellers` table + `Seller` type + migration

**Files:**
- Modify: `src/db/schema.ts` (add the `sellers` pgTable after `b2bInvoices`)
- Modify: `src/lib/types.ts` (add `SellerStatus` + `Seller` interfaces)
- Create: `drizzle/00NN_*.sql` (drizzle-kit generates the filename)
- Test: `tests/seller-schema.test.ts` (new) — column/shape assertion

**Interfaces:**
- Consumes: `CountryCode`, `CurrencyCode` from Task 1.
- Produces: the `sellers` table export from `@/db/schema`; `Seller` (masked domain shape) + `SellerStatus` from `@/lib/types`:
  - `type SellerStatus = 'pending' | 'active' | 'suspended'`
  - `interface Seller { id; partnerId: PartnerId; phone; businessName; country: CountryCode; currency: CurrencyCode; payoutLast4?: string; status: SellerStatus; kycReviewState: KycReviewState; createdAt: string; updatedAt: string }`

- [ ] **Step 1: Add the `Seller` + `SellerStatus` types**

In `src/lib/types.ts` (near the other B2B types, e.g. after `B2bInvoice`), add. `KycReviewState` already exists in this file:

```ts
export type SellerStatus = 'pending' | 'active' | 'suspended';

/**
 * A registered cross-border seller (a business that issues bills and receives
 * payouts). MASKED domain shape: the payout destination is encrypted at rest and
 * never present here — only payoutLast4. Decrypted reads are a separate, audited path.
 */
export interface Seller {
  id: string;
  partnerId: PartnerId;
  phone: string;          // digits-only WhatsApp wa_id
  businessName: string;   // plaintext — shown to buyers on the bill
  country: CountryCode;
  currency: CurrencyCode;
  payoutLast4?: string;   // masked tail of the encrypted payout destination
  status: SellerStatus;   // 'pending' until onboarding completes (payout + sanctions clear)
  kycReviewState: KycReviewState;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Write the failing schema test**

Create `tests/seller-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sellers } from '@/db/schema';

describe('sellers table', () => {
  it('exposes the expected columns', () => {
    const cols = Object.keys(sellers);
    for (const c of [
      'id', 'partnerId', 'phone', 'businessName', 'country', 'currency',
      'payoutDestinationEnc', 'payoutLast4', 'status', 'kycReviewState',
      'createdAt', 'updatedAt',
    ]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/seller-schema.test.ts`
Expected: FAIL — `sellers` is not exported from `@/db/schema`.

- [ ] **Step 4: Add the `sellers` table**

In `src/db/schema.ts`, after the `b2bInvoices` table (mirror its imports — `pgTable, text, timestamp, numeric, jsonb, index, uniqueIndex, check, sql` are already used in this file; add `uniqueIndex` to the drizzle import if not already present):

```ts
// Registered cross-border B2B sellers — a business that issues bills and receives
// payouts in its own currency. The payout destination is envelope-encrypted at rest
// (field-crypto); only the masked last4 is stored in the clear. Partner-scoped.
export const sellers = pgTable(
  'sellers',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    phone: text('phone').notNull(), // digits-only WhatsApp wa_id
    businessName: text('business_name').notNull(),
    country: text('country').notNull(),
    currency: text('currency').notNull(),
    payoutDestinationEnc: text('payout_destination_enc'), // null until onboarding completes
    payoutLast4: text('payout_last4'),
    status: text('status').notNull().default('pending'), // 'pending' | 'active' | 'suspended'
    kycReviewState: text('kyc_review_state').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sellers_status_check', sql`${t.status} IN ('pending','active','suspended')`),
    uniqueIndex('sellers_partner_phone').on(t.partnerId, t.phone),
    index('sellers_partner_created').on(t.partnerId, t.createdAt.desc()),
  ],
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/seller-schema.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new file `drizzle/00NN_<name>.sql` containing roughly:

```sql
CREATE TABLE "sellers" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"phone" text NOT NULL,
	"business_name" text NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"payout_destination_enc" text,
	"payout_last4" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"kyc_review_state" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sellers_status_check" CHECK ("status" IN ('pending','active','suspended'))
);
--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_partner_phone" ON "sellers" ("partner_id","phone");
--> statement-breakpoint
CREATE INDEX "sellers_partner_created" ON "sellers" ("partner_id","created_at" DESC);
```

(Filename is auto-assigned — do not rename it. **Prod migrate is manual after merge**, per Global Constraints.)

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/lib/types.ts drizzle/
git commit -m "feat(b2b): sellers table + Seller type + migration"
```

---

### Task 3: `createSellerRepo` — encrypted payout, tenant-scoped, tested

**Files:**
- Modify: `src/db/repos/aux-repos.ts` (add `createSellerRepo` after `createB2bInvoiceRepo`)
- Test: `tests/seller-repo.test.ts` (new, PGlite)

**Interfaces:**
- Consumes: `sellers` table (Task 2), `Seller`/`SellerStatus` (Task 2), `encryptField`/`decryptField` from `@/lib/field-crypto`, `normalizePhone`/`isValidPhone` from `@/lib/phone`.
- Produces: `createSellerRepo(db)` →
  - `createSeller(input: { id; partnerId; phone; businessName; country: CountryCode; currency: CurrencyCode }): Promise<Seller>` — inserts a `pending` seller (no payout yet).
  - `getSeller(phone: string, partnerId: PartnerId): Promise<Seller | null>` — masked.
  - `getSellerDecrypted(phone: string, partnerId: PartnerId): Promise<(Seller & { payoutDestination: string }) | null>` — explicit decrypt.
  - `setPayoutDestination(phone: string, partnerId: PartnerId, payoutDestination: string): Promise<Seller | null>` — encrypts + stores last4.
  - `setStatus(phone: string, partnerId: PartnerId, status: SellerStatus): Promise<Seller | null>`.

- [ ] **Step 1: Write the failing repo test**

Create `tests/seller-repo.test.ts` (mirrors the existing PGlite repo suites; `freshDb()` seeds the `default` partner via migration 0001):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers/fresh-db';
import { createSellerRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { db = await freshDb(); });

const base = {
  id: 's_hk1', partnerId: DEFAULT_PARTNER_ID, phone: '85291234567',
  businessName: 'Kowloon Design Co', country: 'HK' as const, currency: 'HKD' as const,
};

describe('createSellerRepo', () => {
  it('creates a pending seller and reads it back masked', async () => {
    const repo = createSellerRepo(db);
    const created = await repo.createSeller(base);
    expect(created.status).toBe('pending');
    expect(created.payoutLast4).toBeUndefined();

    const got = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
    expect(got?.businessName).toBe('Kowloon Design Co');
    expect(got?.currency).toBe('HKD');
    // masked shape never carries the raw payout
    expect((got as unknown as Record<string, unknown>).payoutDestination).toBeUndefined();
  });

  it('normalizes + validates the seller phone on write', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller({ ...base, phone: '+852 9123 4567' });
    const got = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
    expect(got).not.toBeNull();
    await expect(repo.createSeller({ ...base, id: 's_bad', phone: '12' })).rejects.toThrow();
  });

  it('encrypts the payout destination; masked read shows only last4; decrypt round-trips', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const updated = await repo.setPayoutDestination('85291234567', DEFAULT_PARTNER_ID, 'HK|024|388|123456789');
    expect(updated?.payoutLast4).toBe('6789');

    const masked = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
    expect(masked?.payoutLast4).toBe('6789');

    const decrypted = await repo.getSellerDecrypted('85291234567', DEFAULT_PARTNER_ID);
    expect(decrypted?.payoutDestination).toBe('HK|024|388|123456789');
  });

  it('is tenant-scoped: another partner cannot read the seller', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const cross = await repo.getSeller('85291234567', 'some_other_partner');
    expect(cross).toBeNull();
  });

  it('activates a seller via setStatus', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const active = await repo.setStatus('85291234567', DEFAULT_PARTNER_ID, 'active');
    expect(active?.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/seller-repo.test.ts`
Expected: FAIL — `createSellerRepo` is not exported.

- [ ] **Step 3: Implement `createSellerRepo`**

In `src/db/repos/aux-repos.ts`, add (mirrors `createB2bInvoiceRepo`'s structure; the file already imports `eq`, `desc`, `sql`, `normalizePhone`, `isValidPhone`; add `sellers` to the schema import and `encryptField`/`decryptField` from `@/lib/field-crypto`, and the `Seller`/`SellerStatus`/`CountryCode`/`CurrencyCode` types):

```ts
// ── Registered cross-border B2B sellers ──────────────────────────────────────
export function createSellerRepo(db: DbOrTx) {
  const toDomain = (row: typeof sellers.$inferSelect): Seller => {
    const s: Seller = {
      id: row.id,
      partnerId: row.partnerId,
      phone: row.phone,
      businessName: row.businessName,
      country: row.country as CountryCode,
      currency: row.currency as CurrencyCode,
      status: row.status as SellerStatus,
      kycReviewState: row.kycReviewState as Seller['kycReviewState'],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    if (row.payoutLast4) s.payoutLast4 = row.payoutLast4;
    return s;
  };

  const requireValidPhone = (raw: string): string => {
    const phone = normalizePhone(raw);
    if (!isValidPhone(phone)) {
      throw new Error('Seller phone must be a valid phone (country code + number, digits only).');
    }
    return phone;
  };

  const fetchRow = async (phone: string, partnerId: PartnerId) => {
    const rows = await db
      .select()
      .from(sellers)
      .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalizePhone(phone)}`)
      .limit(1);
    return rows[0] ?? null;
  };

  return {
    async createSeller(input: {
      id: string; partnerId: PartnerId; phone: string; businessName: string;
      country: CountryCode; currency: CurrencyCode;
    }): Promise<Seller> {
      const phone = requireValidPhone(input.phone);
      await db.insert(sellers).values({
        id: input.id,
        partnerId: input.partnerId,
        phone,
        businessName: input.businessName,
        country: input.country,
        currency: input.currency,
        status: 'pending',
        kycReviewState: 'none',
      });
      const row = await fetchRow(phone, input.partnerId);
      return toDomain(row!);
    },

    async getSeller(phone: string, partnerId: PartnerId): Promise<Seller | null> {
      const row = await fetchRow(phone, partnerId);
      return row ? toDomain(row) : null;
    },

    async getSellerDecrypted(
      phone: string, partnerId: PartnerId,
    ): Promise<(Seller & { payoutDestination: string }) | null> {
      const row = await fetchRow(phone, partnerId);
      if (!row) return null;
      const payoutDestination = row.payoutDestinationEnc ? decryptField(row.payoutDestinationEnc) : '';
      return { ...toDomain(row), payoutDestination };
    },

    async setPayoutDestination(
      phone: string, partnerId: PartnerId, payoutDestination: string,
    ): Promise<Seller | null> {
      const normalized = normalizePhone(phone);
      const enc = encryptField(payoutDestination);
      const last4 = payoutDestination.replace(/\s+/g, '').slice(-4);
      const updated = await db
        .update(sellers)
        .set({ payoutDestinationEnc: enc, payoutLast4: last4, updatedAt: new Date() })
        .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalized}`)
        .returning();
      return updated[0] ? toDomain(updated[0]) : null;
    },

    async setStatus(
      phone: string, partnerId: PartnerId, status: SellerStatus,
    ): Promise<Seller | null> {
      const normalized = normalizePhone(phone);
      const updated = await db
        .update(sellers)
        .set({ status, updatedAt: new Date() })
        .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalized}`)
        .returning();
      return updated[0] ? toDomain(updated[0]) : null;
    },
  };
}
export type SellerRepo = ReturnType<typeof createSellerRepo>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/seller-repo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full gate**

Run: `find . -name '* 2.ts' -not -path './node_modules/*' -delete; rm -rf .next; npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/aux-repos.ts tests/seller-repo.test.ts
git commit -m "feat(b2b): createSellerRepo — encrypted payout, tenant-scoped"
```

---

## Self-review

- **Spec coverage (Plan 1 scope):** Unit 1 (currency expansion / HKD) → Task 1 ✓. Unit 2 (sellers table + repo) → Tasks 2–3 ✓. Encryption-at-rest invariant → Task 3 (encrypt on write, masked default read, explicit decrypt) ✓. Tenant isolation → repo `(partnerId, phone)` WHERE + cross-partner test ✓. Phone discipline → `requireValidPhone` + test ✓. Other spec units (onboarding, invoice, quote, pay, settlement, create-tool, delivery) are **out of scope for Plan 1** — covered by Plans 2–5.
- **Placeholder scan:** every code step contains real code; the only deliberately-open step is Task 1 Step 8 (grep-and-edit copy), which gives the exact command and the concrete edit. No TBD/TODO.
- **Type consistency:** `Seller`/`SellerStatus` defined in Task 2 and consumed verbatim in Task 3; `createSeller`/`getSeller`/`getSellerDecrypted`/`setPayoutDestination`/`setStatus` names match between the Interfaces block and the implementation; `payoutDestinationEnc`/`payoutLast4` column names match between schema (Task 2), the test (Task 2 Step 2), and the repo (Task 3).
