# Partner Entity + Dashboard (P2) — Design

**Date:** 2026-05-27
**Status:** Awaiting review
**Owner:** SendHome
**Batch:** Platform Phase 1, sub-project 2 of 5 (Partner entity + dashboard partner filter + CRUD)

## Why

P1 established the country + currency data model. P2 adds the multi-tenant boundary: every `Customer` and `Transfer` now belongs to a `Partner`. This is the data foundation for P3 (per-partner sub-admin auth scoping) and beyond.

For v1, the system ships with one seeded "Default Partner" (`id: 'default'`). All existing senders and transfers grandfather into it. Admins can create additional Partners through the dashboard, but per-partner WhatsApp channel routing is deferred — every new customer still maps to the Default Partner.

**Hard rule: customers never see partner information in any WhatsApp message.** Partner assignment is a backend concern only. Bot prompts, error messages, confirmations, button labels — all partner-agnostic. This invariant is testable and enforced via the e2e test.

## Scope

**In:**

1. New `Partner` TypeScript interface + `PartnerId` / `PartnerStatus` types.
2. New `src/lib/partner-store.ts` with factory + cached singleton (mirrors `customer-store.ts` from B1).
3. New `partner:<id>` Redis records + `partners:ids` set.
4. New `DEFAULT_PARTNER_ID = 'default'` constant in `src/lib/defaults.ts`.
5. Extend `Customer` and `Transfer` with required `partnerId: PartnerId`. Extend `Staff` with optional `partnerId?: PartnerId`.
6. Modified write paths (`customer-store.upsertOnFirstInbound`, `transfer-create.createTransfer`) populate `partnerId: 'default'` on every new record.
7. Modified read paths (`customer-store.getCustomer`, `store.getTransfer`) lazy-fill missing `partnerId` with `'default'` **in memory only** (no persistence). Same pattern as P1.
8. New sentinel-guarded `backfillPartnersOnce(store, customerStore, partnerStore)` migration in `src/lib/migration.ts`, called from the existing cron alongside B1's + P1's migrations. Seeds the Default Partner + backfills existing records.
9. New sidebar nav item `Partners` between `Customers` and `Compliance`.
10. New `/dashboard/partners` index page (read-only list table for all staff).
11. New `/dashboard/partners/[id]` detail page (three panels — Identity, Activity stats, Recent transfers).
12. New `/dashboard/partners/new` admin-only create form.
13. New `/dashboard/partners/actions.ts` with admin-only `createPartnerAction`, `updatePartnerAction`, `setPartnerStatusAction`.
14. `Partner` column added to `/dashboard/transactions` and `/dashboard/customers` tables (between `Phone` and `Country`).
15. `Partner` row added to `/dashboard/customers/[phone]` Identity panel.
16. URL-driven partner filter (`?partner=<id>`) on `/dashboard/transactions` and `/dashboard/customers` only.

**Out:**

- Per-partner auth scoping (P3 — partner staff only see their partner's data).
- Per-channel WhatsApp routing (deferred — until we onboard a partner with their own Meta number).
- Bot behaviour changes of any kind (partner is backend-only — hard rule).
- Partner column / filter on `/dashboard/schedules`, `/dashboard/compliance`, `/dashboard/analytics` (small follow-up after P2).
- Per-partner pricing, fee schedules, FX margins.
- Whitelabel actually using `brandName` / `primaryColor` / `logoUrl` — fields exist as forward-compat placeholders, consumed in a future batch.
- Real partner onboarding flow / partner-admin self-service (P3).
- Audit log of partner CRUD actions (defer).
- Per-partner local hosting (P6, deferred).
- Hard-delete of partners (only soft-suspend exists).

## User-visible behaviour

### WhatsApp side
**Zero change.** The customer NEVER sees partner info in any chat message. Bot prompts, button labels, payment links, recipient picker, confirmations — all partner-agnostic. Partner assignment happens server-side, invisibly. Verified by the e2e test asserting no scripted bot reply contains the substring "partner".

### Dashboard

| Surface | Change |
|---|---|
| Sidebar | New `Partners` nav item between `Customers` and `Compliance`. |
| `/dashboard/partners` (new) | Table: Name · Status · Countries · Customer count · Transfer count · Created. Name links to detail page. Admin sees `[+ New partner]` button; agents see read-only list. |
| `/dashboard/partners/[id]` (new) | Three panels — Identity (id/name/status/countries/whitelabel placeholders/notes/timestamps); Activity stats (lifetime customer/transfer count + volume); Recent transfers (50-row cap). Admin sees `[Edit]` and `[Suspend]`/`[Reactivate]` buttons. |
| `/dashboard/partners/new` (new, admin-only) | Form: name, countries (multi-checkbox of 7 send-side countries + IN), brandName, primaryColor (color input), logoUrl, adminNote. Creates a Partner with `id: newTransferId()`, `status: 'active'`. Redirects to detail page. |
| `/dashboard/transactions` | New `Partner` column between `Phone` and `Country`. URL `?partner=<id>` filters server-side. Dropdown at top of page changes the URL. |
| `/dashboard/customers` | New `Partner` column between `Phone` and `Country`. Same `?partner=<id>` filter. |
| `/dashboard/customers/[phone]` | `Partner` row added to Identity panel after `Country`. |
| `/dashboard/schedules`, `/dashboard/compliance`, `/dashboard/analytics` | No change in P2. Data still works; just no partner column or filter yet. |

### Production data (after deploy)

The third sentinel-guarded migration runs once via the daily cron (also accessible via authenticated GET):

1. **Seeds** the Default Partner record:
   ```json
   {
     "id": "default",
     "name": "SendHome Default",
     "countries": ["US"],
     "status": "active",
     "createdAt": "<migration-run timestamp>",
     "updatedAt": "<migration-run timestamp>"
   }
   ```
2. **Backfills** every existing `Customer` → `partnerId: 'default'`.
3. **Backfills** every existing `Transfer` → `partnerId: 'default'`.
4. **Does not touch** `Staff` records — `partnerId` stays undefined (= global admin access).

Records created between deploy and the first cron fire get the defaults via the modified write paths. Old records loaded between deploy and cron get `'default'` in memory via the lazy-fill read paths. Either way, the dashboard never sees `undefined`.

## Data model

### New types in `src/lib/types.ts`

```ts
export type PartnerId = string;  // 'default' or newTransferId() output

export type PartnerStatus = 'active' | 'suspended';

export interface Partner {
  id: PartnerId;
  name: string;                       // staff-facing display name
  countries: CountryCode[];           // which Phase-1 countries this partner operates in
  status: PartnerStatus;
  // Whitelabel placeholders — optional until a real partner needs them.
  brandName?: string;                 // end-customer-facing brand (when whitelabel ships, NOT v1)
  primaryColor?: string;              // hex string e.g. '#1a73e8'
  logoUrl?: string;                   // CDN URL
  adminNote?: string;                 // internal staff annotation
  createdAt: string;
  updatedAt: string;
}
```

### Extended `Customer`

```ts
export interface Customer {
  senderPhone: string;
  firstSeenAt: string;
  kycStatus: KycStatus;
  // ... existing B1 + P1 fields ...
  senderCountry: CountryCode;
  partnerId: PartnerId;               // NEW (P2) — required after migration
  createdAt: string;
  updatedAt: string;
}
```

### Extended `Transfer`

```ts
export interface Transfer {
  // ... existing fields ...
  sourceCountry: CountryCode;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  partnerId: PartnerId;               // NEW (P2) — required after migration
}
```

### Extended `Staff` (optional)

```ts
export interface Staff {
  username: string;
  name: string;
  role: StaffRole;
  permissions: StaffPermissions;
  passwordHash: string;
  createdAt: string;
  partnerId?: PartnerId;              // NEW (P2) — OPTIONAL: undefined = global admin (sees all);
                                      // set = scoped to one partner (P3 enforces)
}
```

### Extended `src/lib/defaults.ts`

```ts
import type { CountryCode, CurrencyCode, PartnerId } from './types';

export const DEFAULT_SENDER_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_CURRENCY: CurrencyCode = 'USD';
export const DEFAULT_DESTINATION_COUNTRY: CountryCode = 'IN';
export const DEFAULT_DESTINATION_CURRENCY: CurrencyCode = 'INR';
export const DEFAULT_PARTNER_ID: PartnerId = 'default';   // NEW (P2)
```

### Redis schema

```
Key:    partner:<id>             # e.g. partner:default, partner:Xk3pQ9mN
Type:   string (JSON-serialized Partner)
TTL:    none — durable

Key:    partners:ids             # set of all partner ids
Type:   set
TTL:    none — durable
```

Pattern mirrors `customer:<phone>` + `customers:phones` from B1.

**Sentinel key:** `partner-backfill-v1` (separate from B1's and P1's sentinels).

**Partner ID format:**
- The seeded Default Partner uses the literal string `'default'`. Simple, memorable, never collides.
- New partners (created via `/dashboard/partners/new`) use `newTransferId()` — the existing 8-char URL-safe ID helper.

## Architecture

### New module: `src/lib/partner-store.ts`

```ts
// src/lib/partner-store.ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { Partner, PartnerId } from './types';
import { DEFAULT_PARTNER_ID } from './defaults';

export interface PartnerStore {
  getPartner(id: PartnerId): Promise<Partner | null>;
  savePartner(p: Partner): Promise<void>;
  listPartners(): Promise<Partner[]>;
  ensureDefaultPartner(): Promise<Partner>;   // idempotent — creates 'default' if missing
}

export function createPartnerStore(redis: RedisLike): PartnerStore { /* ... */ }
export function getPartnerStore(): PartnerStore { /* cached singleton */ }
```

No update/delete methods. Updates go through `savePartner` (read-modify-write at the call site). Hard-delete is never offered — `setPartnerStatusAction('suspended')` is the only way to disable a partner.

### Write paths

```
customer-store.upsertOnFirstInbound(phone)
   │  NEW (P2): writes partnerId: DEFAULT_PARTNER_ID on new records
   │  Lazy fill on getCustomer if missing (existing P1 pattern extended)

transfer-create.createTransfer(input)
   │  NEW (P2): writes partnerId: DEFAULT_PARTNER_ID on new transfers

auth-store.saveStaff(staff)
   │  No change in P2 — Staff.partnerId is optional; existing records leave it undefined
```

P4 will swap the hardcoded `DEFAULT_PARTNER_ID` for routing logic. For P2, every new write goes to `'default'`.

### Read paths

```
customer-store.getCustomer(phone)
   │  If parsed.partnerId missing → fill DEFAULT_PARTNER_ID in-memory (no persist)
   │  (Extends existing P1 lazy fill that already handles senderCountry)

store.getTransfer(id)
   │  If parsed.partnerId missing → fill DEFAULT_PARTNER_ID in-memory (no persist)
   │  (Extends existing P1 lazy fill that handles the 4 country/currency fields)
```

Staff doesn't need lazy fill — `partnerId` is optional there; missing = undefined = global access.

### Migration

```ts
// src/lib/migration.ts (extended)

const PARTNER_SENTINEL_KEY = 'partner-backfill-v1';

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
  const existing = await partnerStore.getPartner(DEFAULT_PARTNER_ID);
  const defaultPartnerCreated = existing === null;
  if (defaultPartnerCreated) {
    const now = new Date().toISOString();
    await partnerStore.savePartner({
      id: DEFAULT_PARTNER_ID,
      name: 'SendHome Default',
      countries: ['US'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Step 2: backfill Customer records (lazy fill populated partnerId in-memory; re-save persists)
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    await customerStore.saveCustomer({ ...c, updatedAt: new Date().toISOString() });
    customersBackfilled++;
  }

  // Step 3: backfill Transfer records (same pattern)
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({ ...t });
    transfersBackfilled++;
  }

  // Staff records NOT backfilled — partnerId stays optional (= global access).

  return { defaultPartnerCreated, customersBackfilled, transfersBackfilled, skippedSentinel: false };
}
```

### Cron route

```ts
// /api/cron/route.ts (extended)

const backfill = await backfillCustomersOnce(store, customerStore);
const countryCurrencyBackfill = await backfillCountryCurrencyOnce(store, customerStore);
const partnerBackfill = await backfillPartnersOnce(store, customerStore, partnerStore);   // NEW

return NextResponse.json({
  ok: true,
  fired: result.fired,
  backfill,
  countryCurrencyBackfill,
  partnerBackfill,    // NEW
});
```

Three sentinel-guarded migrations run in series; each is a no-op after first claim.

### Full data flow

```
inbound webhook (UNCHANGED from P1)
       │
       ▼
customer-store.upsertOnFirstInbound(phone)
   │  Writes partnerId: 'default' on new (P2)
   │  Lazy-fills partnerId on existing missing it (P2)
   ▼
agent + tools (UNCHANGED — bot never mentions partner; hard rule)
   │
   ▼
transfer-create.createTransfer(input)
   │  Writes partnerId: 'default' on new (P2)
   ▼
store.saveTransfer + recipient upsert + daily-volume incr (UNCHANGED)


/api/cron (MODIFIED — third sentinel-guarded migration)
   ├─ backfillCustomersOnce          (B1)
   ├─ backfillCountryCurrencyOnce     (P1)
   ├─ backfillPartnersOnce            (NEW — P2)
   └─ runDueSchedules                 (UNCHANGED)


Dashboard reads (MODIFIED):
   /dashboard/partners                  → NEW list
   /dashboard/partners/[id]             → NEW detail
   /dashboard/partners/new              → NEW create (admin-only)
   /dashboard/customers                 → reads partnerId, renders column + ?partner= filter
   /dashboard/transactions              → same
   /dashboard/customers/[phone]         → renders Partner row in Identity panel
```

## File-level plan

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `PartnerId`, `PartnerStatus`, `Partner`. Extend `Customer` + `Transfer` with required `partnerId`. Extend `Staff` with optional `partnerId`. |
| `src/lib/defaults.ts` | Modify | Add `DEFAULT_PARTNER_ID: PartnerId = 'default'`. |
| `src/lib/partner-store.ts` | **Create** | Factory + cached singleton; `getPartner`, `savePartner`, `listPartners`, `ensureDefaultPartner`. |
| `src/lib/customer-store.ts` | Modify | `upsertOnFirstInbound` writes `partnerId: 'default'` on new records. `getCustomer` lazy-fills `partnerId` if missing (in-memory only). |
| `src/lib/transfer-create.ts` | Modify | `createTransfer` populates `partnerId: 'default'` on new transfers. |
| `src/lib/store.ts` | Modify | `getTransfer` lazy-fills `partnerId` if missing (in-memory only). |
| `src/lib/migration.ts` | Modify | Add `backfillPartnersOnce`. Sentinel key `partner-backfill-v1`. Three steps: seed default + backfill customers + backfill transfers. |
| `src/app/api/cron/route.ts` | Modify | Call `backfillPartnersOnce` alongside B1 + P1 migrations. JSON response includes `partnerBackfill`. |
| `src/app/dashboard/sidebar.tsx` | Modify | Add `Partners` nav item; extend `SidebarActive` with `'partners'`. |
| `src/app/dashboard/partners/page.tsx` | **Create** | Read-only list with name link, status badge, counts. Admin sees `[+ New partner]` button. `force-dynamic`. |
| `src/app/dashboard/partners/[id]/page.tsx` | **Create** | Three panels; admin sees `[Edit]` and `[Suspend]`/`[Reactivate]` actions. |
| `src/app/dashboard/partners/new/page.tsx` | **Create** | Admin-only form; submits to `createPartnerAction`. |
| `src/app/dashboard/partners/actions.ts` | **Create** | `createPartnerAction`, `updatePartnerAction`, `setPartnerStatusAction` — all `requireAdmin`. `revalidatePath` partners pages. |
| `src/app/dashboard/transactions/page.tsx` | Modify | Read `?partner=<id>` from `searchParams`, build `partnerById` map, filter transfers, pass `partnerById` through to explorer. |
| `src/app/dashboard/transactions-explorer.tsx` | Modify | Pass `partnerById` through to tabs. |
| `src/app/dashboard/transactions-tabs.tsx` | Modify | Add `Partner` column between `Phone` and `Country`. Add partner filter dropdown at top. |
| `src/app/dashboard/customers/page.tsx` | Modify | Read `?partner=<id>`, build `partnerById`, filter customers, add Partner column + dropdown. |
| `src/app/dashboard/customers/[phone]/page.tsx` | Modify | Add `Partner` row to Identity panel after `Country`. |
| `src/app/globals.css` | Modify (small) | Two tiny additions: `.sh-tag-partner-active`, `.sh-tag-partner-suspended` color variants (reuse existing `sh-tag` base). |
| `tests/partner-store.test.ts` | **Create** | CRUD round-trips, `listPartners` returns all, `ensureDefaultPartner` idempotent + doesn't overwrite. |
| `tests/partners-actions.test.ts` | **Create** | `createPartnerAction` / `updatePartnerAction` / `setPartnerStatusAction` behaviors + admin-only throws. |
| `tests/customer-store.test.ts` | Modify | 3 new tests for partnerId write + lazy fill. |
| `tests/transfer-create.test.ts` | Modify | 1 new test for `partnerId: 'default'`. |
| `tests/store-getTransfer.test.ts` | Modify | 2 new tests for lazy fill of partnerId. |
| `tests/migration.test.ts` | Modify | 4 new tests for `backfillPartnersOnce`. |
| `tests/e2e/dashboard-smoke.spec.ts` | Modify | Navigate to `/dashboard/partners`; assert table renders with the `Partner` column header on customers/transactions. |
| Test-fixture sweep on ~9 files | Modify | Add `partnerId: 'default' as const` to every `Customer` / `Transfer` literal in: agent.test, analytics.test, dashboard-ops.test, dashboard.test, payment.test, store.test, tier-rules.test, tools.test, migration.test. Same sweep pattern P1 followed. |

## Reliability & error handling

| Concern | Mitigation |
|---|---|
| `partner-backfill-v1` sentinel cron race | `claimMigrationFlag` uses Redis `SET NX`. First call wins; subsequent see `skippedSentinel: true`. Same pattern as B1/P1. |
| Admin renames Default Partner; cron fires again | Sentinel prevents re-entry. Also, `backfillPartnersOnce` checks `partnerStore.getPartner('default') !== null` before seeding — never overwrites. |
| Partner record hard-deleted from Redis (admin via Upstash console) | UI never offers hard delete. If admin manually deletes, orphan customer/transfer records still load (lazy fill defaults to `'default'`). `partnerNameById` helper returns the raw id as fallback. Document for ops. |
| Two admins editing the same Partner concurrently | Last write wins (Redis SET). Partner records change rarely; acceptable for v1. Optimistic concurrency comes later if needed. |
| `partnerNameById` called with unknown id | Returns the raw `partnerId` as fallback. Staff see the id rather than a crash. |
| Filter URL `?partner=<bogus>` | Server-side filter returns empty list. UI renders "No transfers match" / "No customers match" — standard empty state. |
| Migration partially completes (transfers loop errors mid-stream) | Sentinel claimed before loop. Next cron sees `skippedSentinel: true` and skips. Missed records lazy-fill on read. Force retry = clear sentinel via Upstash console. |
| Bot accidentally mentions "partner" in a reply | E2E test asserts no scripted bot reply contains "partner" (case-insensitive). Hard rule enforced by test. Any prompt change touching this fails CI. |
| `Customer.country` (legacy KYC free-text) vs new partner/tier/country fields confuse | Continues to coexist (added in B1). Spec re-emphasizes: `country?` is KYC-provider free text; never used for routing or partner inference. |
| Existing Staff record loaded after deploy with no `partnerId` | Field is optional — `undefined` is valid. Treated as global admin access. P3 will enforce scoping when a partner-scoped staff record is created. |

## Testing strategy

### New test files
- `tests/partner-store.test.ts` — ~6 tests for CRUD + `ensureDefaultPartner` idempotency.
- `tests/partners-actions.test.ts` — ~5 tests for create / update / suspend actions, including admin-only enforcement.

### Modified test files
- `tests/customer-store.test.ts` — 3 new tests for partnerId on new + lazy fill on read.
- `tests/transfer-create.test.ts` — 1 new test for `partnerId: 'default'` on new transfers.
- `tests/store-getTransfer.test.ts` — 2 new tests for lazy-fill partnerId.
- `tests/migration.test.ts` — 4 new tests for `backfillPartnersOnce`.
- `tests/e2e/dashboard-smoke.spec.ts` — 1 navigation + table-header assertion for `/dashboard/partners`.

### Test fixture sweep
~9 files containing `Customer` / `Transfer` literals each need `partnerId: 'default' as const` added (or to their `makeX()` helpers). Same sweep pattern P1 followed for `senderCountry`. See File-level plan for the list.

### Test count target
325 → ~345 (+~20 new tests).

## Acceptance criteria

- [ ] Every existing `Customer` Redis record gets `partnerId: 'default'` within ~24h of deploy (via cron) OR sooner (via lazy backfill on next inbound).
- [ ] Every existing `Transfer` Redis record gets `partnerId: 'default'` within ~24h.
- [ ] Existing `Staff` records untouched (`partnerId` stays undefined = global).
- [ ] New customers / transfers created via the bot have `partnerId: 'default'`.
- [ ] `partner:default` exists in Redis with `name: 'SendHome Default'`, `countries: ['US']`, `status: 'active'`.
- [ ] `/api/cron` response includes `partnerBackfill: { defaultPartnerCreated, customersBackfilled, transfersBackfilled, skippedSentinel }`. Second call returns `skippedSentinel: true`.
- [ ] `/dashboard/partners` lists the Default Partner (and any admin-created partners). Counts are accurate.
- [ ] `/dashboard/partners/[id]` detail renders Identity + Activity + Recent transfers panels.
- [ ] `/dashboard/partners/new` is admin-only; submission creates a Partner with `id` from `newTransferId()` and redirects to detail.
- [ ] `[Edit]`, `[Suspend]`, `[Reactivate]` buttons hidden for agents; functional as admin.
- [ ] `/dashboard/transactions` shows `Partner` column. `?partner=default` filters; `?partner=<other>` filters to that partner; no param shows all.
- [ ] `/dashboard/customers` shows `Partner` column with the same filter behaviour.
- [ ] `/dashboard/customers/[phone]` Identity panel shows a `Partner` row.
- [ ] **WhatsApp bot never mentions partner in any reply.** Verified via e2e: no scripted reply contains "partner" (case-insensitive).
- [ ] Playwright dashboard smoke green on prod (navigates to `/dashboard/partners` and asserts the table renders).
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all green.
- [ ] No regression in B1 (tiers, recipient suggestions) or P1 (country/currency).

## Open questions

None. All six locked in chat:
- New customers → Default Partner; backend-only; bot never surfaces partner info.
- Full CRUD `/dashboard/partners` page in P2 (vs read-only or deferred).
- Richer Partner shape with whitelabel placeholders.
- `partnerId` required on Customer + Transfer; optional on Staff.
- URL query param `?partner=<id>` for filter persistence.
- Admin-only CRUD; agents can view list/detail read-only.

## Risks

| Risk | Mitigation |
|---|---|
| Bot accidentally surfaces "partner" in a reply | E2E test guard. If anyone touches the prompt or a tool response template, the test catches it. |
| Admin creates many partners but never uses them; dashboard scales poorly | We have ≤10 partners realistically until P3+P4 onboard real ones. Counts computed at request time are O(transfers + customers + partners). Revisit at scale. |
| Whitelabel placeholders (`brandName`, `primaryColor`, `logoUrl`) tempt premature use elsewhere | Spec explicitly: P2 stores these but no other code reads them. Future batch wires whitelabel. |
| Deleting a Partner record via Upstash console leaves orphans | Documented; `partnerNameById` falls back to raw id. Don't expose hard-delete in UI. |
| `Customer.country` (free-text, B1) vs `Customer.senderCountry` (P1) vs `Customer.partnerId` (P2) too many concerns on one record | Spec re-emphasizes the distinction. `country` is KYC-provider data; `senderCountry` is routing; `partnerId` is multi-tenancy. JSDoc comments in `types.ts` already note this. |
| Existing tests with Customer / Transfer literals are scattered | Sweep is mechanical and follows P1's precedent. Implementer can grep `complianceStatus` to find every Transfer literal; grep `kycStatus` for every Customer literal. |

## Out of scope (reaffirmed)

- Per-partner auth scoping (P3).
- Per-channel WhatsApp routing.
- Bot behaviour changes.
- Partner column on Schedules / Compliance / Analytics pages (small follow-up).
- Per-partner pricing, fee schedules, FX margins.
- Whitelabel consumption of `brandName` / `primaryColor` / `logoUrl`.
- Real partner onboarding flow.
- Audit log of partner CRUD actions.
- Per-partner local hosting (P6 / deferred).
- Hard-delete of partners.
