# Country + Currency Data Model (P1) — Design

**Date:** 2026-05-25
**Status:** Awaiting review
**Owner:** SendHome
**Batch:** Platform Phase 1, sub-project 1 of 5 (Country + Currency data model)

## Why

SendHome today is hardcoded to one corridor: US senders, INR payouts. Raj has asked us to evolve into a Phase-1 multi-country platform (US, CA, GB, AE/UAE, SG, AU, NZ as send-side; India as the only payout-side for v1). That's a multi-week reshape decomposed into five sub-projects (P1–P5). **This spec covers P1 only** — the foundational data-model change.

P1 ships with **zero customer-visible behaviour change**: bot still talks to senders the same way, generates the same quote, sends the same payment link. The only visible deltas are two new "Country" columns on the dashboard. What P1 actually does is make every `Customer` and `Transfer` record carry country + currency fields, so P2 (Partner), P3 (per-partner sub-admin), P4 (multi-currency at quote), and P5 (per-corridor compliance) can drop in without rewriting the data layer.

This is the smallest, safest, highest-leverage move in the platform reshape.

## Scope

**In:**

1. Two new TypeScript literal-union types (`CountryCode`, `CurrencyCode`) covering Phase-1 send countries + India as the payout destination.
2. One new field on `Customer` (`senderCountry`) and four new fields on `Transfer` (`sourceCountry`, `sourceCurrency`, `destinationCountry`, `destinationCurrency`).
3. A `src/lib/defaults.ts` module exporting the five default constants used at every write site until P4 unlocks bot-collected values.
4. Modified write paths: `customer-store.upsertOnFirstInbound` and `transfer-create.createTransfer` populate the new fields on every new record from the defaults.
5. Modified read paths: `customer-store.getCustomer` and `store.getTransfer` lazy-fill missing fields in-memory (no persistence on read).
6. New sentinel-guarded migration `backfillCountryCurrencyOnce(store, customerStore)` in `src/lib/migration.ts`, called from the existing daily cron alongside B1's `backfillCustomersOnce`. Backfills all pre-existing customer + transfer records.
7. Dashboard: `Country` column on `/dashboard/customers` and `/dashboard/transactions` tables; `Country` row on the `/dashboard/customers/[phone]` detail page Identity panel.

**Out:**

- Any bot behaviour change. The agent still hardcodes US/USD source on every new transfer; P4 owns bot-collected country.
- Any FX / quote / compliance change. P4 / P5 own those.
- A `Currency` column on any dashboard table (currency only matters once senders can pick something other than USD — P4).
- Country picker / manual override UI. None until needed.
- Runtime validation of the literal-union types on writes (TypeScript handles compile-time; runtime guards arrive in P4 when bot inputs flow into these fields).
- Per-country flag emoji, locale-aware formatting, or country names. Code-only display for P1.
- The `country?: string` field added to `Customer` in B1 (reserved for free-text KYC-provider-supplied values). That stays as-is; we add `senderCountry: CountryCode` as a separate, strictly-typed field.

## User-visible behaviour

### WhatsApp side
**Zero change.** Senders see identical bot behaviour. No new questions, no new prompts, no new fields collected in chat. New transfers persist with `sourceCountry: 'US'`, `sourceCurrency: 'USD'`, `destinationCountry: 'IN'`, `destinationCurrency: 'INR'` — populated from defaults, invisible to the sender.

### Dashboard
- **`/dashboard/customers`** — new `Country` column placed immediately after `Phone`. Cell renders the 2-letter ISO code (e.g. `US`, `CA`, `IN`). All existing senders show `US` after the migration runs.
- **`/dashboard/transactions`** — new `Country` column placed immediately after `Phone`, before `Tier`. Cell renders the source-country code.
- **`/dashboard/customers/[phone]`** — Identity panel gains a `Country` row showing the customer's `senderCountry`.

No tier-badge, no styling change, no row layout shift beyond the new column.

### Production data
The migration runs once via the existing Vercel Cron (sentinel-guarded). Every existing `Customer` gets `senderCountry: 'US'`. Every existing `Transfer` gets `sourceCountry: 'US'`, `sourceCurrency: 'USD'`, `destinationCountry: 'IN'`, `destinationCurrency: 'INR'`. Subsequent cron firings are no-ops.

Any record created between deploy and the first cron run goes through the modified write paths, which always populate the defaults. Old records loaded between deploy and cron get the same defaults *in memory* via the read-path lazy fill — no Redis write on the read path.

## Data model

### New types in `src/lib/types.ts`

```ts
// Phase 1 supported countries — Raj's list + India as payout destination.
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

### Extended `Customer` interface

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
  country?: string;             // legacy KYC-provider free-text — stays as-is
  senderCountry: CountryCode;   // NEW — required after migration
  createdAt: string;
  updatedAt: string;
}
```

The pre-existing `country?: string` field (B1) was reserved for KYC-provider-supplied values (Persona may return "United States" or "USA" as free text). We keep it for KYC payload concerns and add `senderCountry: CountryCode` for our internal routing — two different concerns, two different fields. They will hold equivalent information for any sender, but only one is strictly typed and only one drives routing logic.

### Extended `Transfer` interface

```ts
export interface Transfer {
  // ... existing 17 fields unchanged ...
  sourceCountry: CountryCode;        // NEW — required after migration
  sourceCurrency: CurrencyCode;      // NEW
  destinationCountry: CountryCode;   // NEW — always 'IN' for v1
  destinationCurrency: CurrencyCode; // NEW — always 'INR' for v1
}
```

### `src/lib/defaults.ts` (new module)

```ts
import type { CountryCode, CurrencyCode } from './types';

export const DEFAULT_SENDER_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_CURRENCY: CurrencyCode = 'USD';
export const DEFAULT_DESTINATION_COUNTRY: CountryCode = 'IN';
export const DEFAULT_DESTINATION_CURRENCY: CurrencyCode = 'INR';
```

Pure module, no I/O. Single source of truth for "what country/currency does the bot assume when nothing else is known?" P4 will replace most consumers; the constants stay as fallbacks for cron-fired scheduled transfers.

### Redis schema

**No new Redis keys.** All new fields live inside the existing `customer:<phone>` and `transfer:<id>` JSON blobs. The migration adds fields to existing JSON; the read-path lazy fill handles records that haven't been migrated yet.

**Sentinel key:** `flag:country-currency-backfill-v1` — separate from B1's `flag:customer-backfill-v1`. One sentinel per migration; both use the same `claimMigrationFlag` SETNX pattern.

## Architecture

```
inbound webhook (UNCHANGED from B1)
       │
       ▼
customer-store.upsertOnFirstInbound(phone)
   │  NEW: writes senderCountry: 'US' on new records
   │  NEW: lazy-fills senderCountry on existing records missing it
   ▼
agent + tools (UNCHANGED — bot still hardcoded to US for P1)
   │
   ▼
transfer-create.createTransfer(input)
   │  NEW: writes sourceCountry, sourceCurrency,
   │       destinationCountry, destinationCurrency from defaults
   ▼
store.saveTransfer + recipient upsert + daily-volume incr (UNCHANGED)


/api/cron (MODIFIED)
   ├─ backfillCustomersOnce(...)            (B1 — UNCHANGED)
   ├─ backfillCountryCurrencyOnce(...)      (NEW — sentinel: country-currency-backfill-v1)
   └─ runDueSchedules(...)                  (UNCHANGED)


store.getTransfer(id) (MODIFIED)
   └─ If loaded JSON missing the 4 transfer fields, fill in-memory with
      defaults (DON'T persist). Cron pass is the only writer.

customer-store.getCustomer(phone) (MODIFIED)
   └─ Same pattern: lazy-fill senderCountry if missing.


Dashboard reads (MODIFIED):
   /dashboard/customers            → reads senderCountry, renders Country column
   /dashboard/customers/[phone]    → renders Country row in Identity panel
   /dashboard/transactions         → reads sourceCountry, renders Country column
```

### Migration function shape

```ts
// src/lib/migration.ts (extended)

export async function backfillCountryCurrencyOnce(
  store: Store,
  customerStore: CustomerStore,
): Promise<{
  customersBackfilled: number;
  transfersBackfilled: number;
  skippedSentinel: boolean;
}> {
  const claimed = await store.claimMigrationFlag('country-currency-backfill-v1');
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

## File-level plan

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `CountryCode`, `CurrencyCode`, `DEFAULT_CURRENCY_FOR_COUNTRY`. Extend `Customer` with `senderCountry: CountryCode`. Extend `Transfer` with 4 new fields. |
| `src/lib/defaults.ts` | **Create** | Five exported constants. Pure module, no I/O. |
| `src/lib/customer-store.ts` | Modify | `upsertOnFirstInbound`: include `senderCountry: DEFAULT_SENDER_COUNTRY` on new records. `getCustomer`: lazy-fill `senderCountry` if missing (in-memory, no persistence). |
| `src/lib/transfer-create.ts` | Modify | Set all 4 new fields on the persisted `Transfer` using defaults. |
| `src/lib/store.ts` | Modify | `getTransfer`: lazy-fill the 4 new fields if missing (in-memory, no persistence). |
| `src/lib/migration.ts` | Modify | Add `backfillCountryCurrencyOnce(store, customerStore)`. Sentinel key: `country-currency-backfill-v1`. Two passes. |
| `src/app/api/cron/route.ts` | Modify | Call the new migration alongside the existing one. Include `countryCurrencyBackfill` in the JSON response. |
| `src/app/dashboard/customers/page.tsx` | Modify | Add `Country` column to the table. |
| `src/app/dashboard/customers/[phone]/page.tsx` | Modify | Add `Country` row in the Identity & KYC panel. |
| `src/app/dashboard/transactions/page.tsx` | Modify | (No prop change if explorer already accepts the data; otherwise thread `tierByPhone`-style.) |
| `src/app/dashboard/transactions-explorer.tsx` | Modify | Pass `sourceCountry` through to tabs (or read it directly from `t.sourceCountry`). |
| `src/app/dashboard/transactions-tabs.tsx` | Modify | Add `Country` column rendering `t.sourceCountry`. |
| `tests/defaults.test.ts` | **Create** | Assert the five constants. |
| `tests/customer-store.test.ts` | Modify | New tests for `upsertOnFirstInbound` writing `senderCountry: 'US'`; `getCustomer` filling missing `senderCountry` on read. |
| `tests/migration.test.ts` | Modify | 3 new tests for `backfillCountryCurrencyOnce` — writes country to customers, writes 4 fields to transfers, idempotent via sentinel. |
| `tests/e2e/dashboard-smoke.spec.ts` | Modify | Assert the `Country` column header exists on `/dashboard/customers`. |
| `tests/transfer-create.test.ts` | Create (if missing) or Modify | Assert `createTransfer` returns a Transfer with all 4 new fields set to defaults. |
| `tests/store-getTransfer.test.ts` | **Create** | Assert `store.getTransfer` returns the 4 new fields filled even for an old record stored without them (lazy fill). |

## Reliability & error handling

| Concern | Mitigation |
|---|---|
| Cron times out on a huge transfer list | Production has <500 transfers. O(n) read-modify-write is fine. Revisit at ~10k. |
| Lazy backfill on `getTransfer` mutates Redis on read | We DO NOT persist on read paths. We fill in-memory only. Cron pass is the only writer. Read paths stay side-effect-free. |
| Two cron firings race the migration | `claimMigrationFlag` uses Redis `SET NX`. First claim wins. Second cron sees `skippedSentinel: true` and exits without touching data. |
| Records created between deploy and first cron run | New customers / transfers go through the MODIFIED write paths and always carry the defaults. Old records loaded between deploy and cron use the in-memory lazy fill via `getTransfer` / `getCustomer`. Either way, the dashboard never sees `undefined`. |
| Country field corrupted by manual Redis edit | TypeScript doesn't catch runtime values not in the literal union. Dashboard shows whatever string is there. We accept this; P4 introduces runtime validation when bot inputs flow into these fields. |
| `customer.country` (legacy KYC field) vs `customer.senderCountry` (new) drift | Documented in the spec: `country` is KYC-provider-supplied free text; `senderCountry` is our strictly-typed routing field. They MAY differ (Persona returns "United States", we store `'US'`). Code paths NEVER read `country` for routing — only `senderCountry`. |
| Old `Transfer` records in the dashboard transactions table | The `store.getTransfer` lazy fill defaults `sourceCountry` to `'US'` for any record missing it. So old + new render identically as `'US'` until P4. |
| Migration partially completes (e.g. customers done, transfers errored mid-loop) | The sentinel is claimed at the very start. If the function throws mid-loop, the next cron sees `skippedSentinel: true` and skips. The missed transfers will be lazy-filled at read time. To force a retry: clear the sentinel via Upstash console. Acceptable for a one-time backfill. |

## Testing strategy

Test count target: 309 → ~325 (+~15 new tests).

**New test files:**
- `tests/defaults.test.ts` — assert the five constants have the expected literal values. Cheap regression guard.
- `tests/store-getTransfer.test.ts` — assert lazy fill on read for old records missing the 4 new fields.

**Modified test files:**
- `tests/customer-store.test.ts` — 2 new tests: `upsertOnFirstInbound` writes `senderCountry: 'US'` on new records; `getCustomer` fills missing `senderCountry` in-memory without persisting.
- `tests/transfer-create.test.ts` (create if absent) — 1 new test: `createTransfer` returns a Transfer with all 4 new fields set.
- `tests/migration.test.ts` — 3 new tests for `backfillCountryCurrencyOnce` (writes country to customers; writes 4 fields to transfers; idempotent via sentinel).
- `tests/e2e/dashboard-smoke.spec.ts` — 1 assertion that the `Country` column header appears on `/dashboard/customers`.

## Acceptance criteria

- [ ] Every existing `Customer` Redis record gets `senderCountry: 'US'` within ~24h of deploy (via cron) OR sooner (via lazy backfill on next inbound).
- [ ] Every existing `Transfer` Redis record gets all 4 new fields within ~24h of deploy.
- [ ] New transfers via the WhatsApp bot have `sourceCountry: 'US'`, `sourceCurrency: 'USD'`, `destinationCountry: 'IN'`, `destinationCurrency: 'INR'`.
- [ ] `/dashboard/customers` shows a `Country` column with `US` for every existing sender after migration.
- [ ] `/dashboard/transactions` shows a `Country` column with `US` for every existing transfer after migration.
- [ ] `/dashboard/customers/[phone]` shows `Country: US` in the Identity panel.
- [ ] `/api/cron` (with `CRON_SECRET`) returns a JSON body that includes `countryCurrencyBackfill: { customersBackfilled, transfersBackfilled, skippedSentinel }`.
- [ ] Second `/api/cron` call returns `skippedSentinel: true` for the country-currency migration.
- [ ] Old Transfer records loaded before migration but accessed via `store.getTransfer` return with the 4 new fields populated (in-memory only).
- [ ] Direct push to `main` rejected by branch protection; PR-only merge path works.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all green.
- [ ] Playwright dashboard smoke green on the prod deploy (including the new `Country` column header assertion).
- [ ] No regression in B1's tier system, recipient suggestions, or any prior feature.

## Open questions

None. All four design decisions locked in chat:
- Field shape: `senderCountry` on Customer; `sourceCountry` + `sourceCurrency` + `destinationCountry` + `destinationCurrency` on Transfer.
- Code formats: ISO 3166-1 alpha-2 for countries, ISO 4217 for currencies.
- New-transfer derivation: hardcoded US/USD via `defaults.ts` until P4.
- Dashboard surfacing: code text in a new column, in two tables + one detail page.

Decomposition decisions also locked:
- Partner ↔ country: 1 partner : many countries (informs P2, not P1).
- Decomposition order: P1 → P2 → P3 → P4 → P5 (P5 may defer post-Phase-1).

## Risks

| Risk | Mitigation |
|---|---|
| The legacy `Customer.country` (free-text KYC field) and new `Customer.senderCountry` (typed routing field) confuse a future developer | Spec calls out the distinction. Add a JSDoc comment in `types.ts` explaining the two-field design. |
| Cron is the only Redis writer and never fires (Vercel cron pauses, secret rotated, etc.) | Lazy backfill in `customer-store.getCustomer` and `store.getTransfer` keeps every read path working with defaults. Cron is an optimization for the dashboard's `listTransfers()` summing; not strictly required for correctness. |
| Adding 5 new fields to the `Transfer` JSON inflates Redis memory non-trivially | Redis stores JSON as strings. Five 2-4-char fields ≈ ~80 bytes per transfer × 500 transfers ≈ 40 KB. Negligible. |
| `Country` column makes `/dashboard/transactions` too wide on narrow screens | Existing table already has `Phone`, `Tier`, `Recipient`, `Amount`, `Fee`, `Status`, `Created`. Adding one more column is small. If needed, we can hide the column on `<sm` breakpoints — defer. |

## Out of scope (reaffirmed)

- Bot behaviour changes (P4).
- FX / quote / compliance changes (P4 / P5).
- Currency column on the dashboard (P4 — when senders can pick non-USD).
- Country picker UI (no need until P4).
- Runtime validation of literal-union types (P4).
- Flag emoji / locale formatting / country name display.
- The Partner entity (P2).
- Per-partner auth scoping (P3).
- Per-corridor compliance (P5).
- Per-partner local hosting (P6 / deferred).
