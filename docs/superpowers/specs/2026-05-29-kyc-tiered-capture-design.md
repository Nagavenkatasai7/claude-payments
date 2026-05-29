# KYC Tiered Data-Capture — Design

**Status:** design approved 2026-05-29. Awaiting spec review → implementation plan.

**Sub-project:** KYC tiered data-capture for the SendHome platform reshape (see memory `sendhome-platform-reshape`). The **next batch after P5** (per-corridor compliance, `spec/p5-per-corridor-compliance`). It **reuses P5's `SanctionsScreener` seam** (`src/lib/providers/sanctions-provider.ts` → `getSanctionsScreener`/`MockSanctionsScreener`) for name screening of both sender and recipient, and layers EDD thresholds onto the P5 `ResolvedCorridorRules` / `kycCapHintUsd` hook already shaped for it. It is **not** the B2/Persona integration: the locked future provider (Persona) stays **deferred** behind the existing `KycProvider` / `MockKycProvider` interface (`src/lib/providers/`). This batch captures the tiered KYC / Travel-Rule / EDD **data** without wiring any real identity or sanctions API.

---

## Goal

Capture Western-Union's four-tier KYC/AML data model — **Core-ID (CIP)**, **Transaction/Counterparty (Travel Rule)**, **Risk/Compliance screening**, and **Enhanced Due Diligence (EDD)** at the $3,000 threshold — as structured, screenable, scope-aware data, **without** wiring a real identity provider or a real sanctions API. Today the bot collects only what a transfer mechanically needs (amount, funding method, recipient name/phone, payout). KYC, when it exists, is a manual `kycStatus` flip on the dashboard (`markCustomerVerifiedAction`) plus two optional free-text fields (`Customer.fullName?`, `Customer.dateOfBirth?`). This batch:

- Adds the **missing Core-ID fields** to `Customer` (residential address, government-ID type+number, nationality — `fullName`/`dateOfBirth`/`country` already exist, do not duplicate), all optional.
- Adds **Travel-Rule counterparty fields** to `Transfer` (recipient legal name, sender↔recipient relationship, transfer purpose), captured **per send**.
- Screens **both sender and recipient** names through the existing `SanctionsScreener` seam, and carries a **PEP self-declaration** flag.
- Triggers **EDD** (source-of-funds + occupation, fixed dropdown enums) when **cumulative rolling-month** USD-equivalent volume + the requested amount crosses **$3,000 (300,000 cents)** — catching structuring across many small sends, not just one big one. A miss **flags for staff review** (`complianceStatus 'flagged'`, reason `'edd_required'`); it never hard-blocks.
- Adds a new **`MonthlyVolumeStore`** (mirror of `daily-volume-store.ts`) keyed on USD-equivalent cents to drive the cumulative trigger.

Ship it **dormant**: every sub-$3k / no-EDD send asks for nothing new and screens byte-for-byte as today. The capability is data + a progressive collection path; real verification is a later Persona swap behind the unchanged seam.

## The dormancy invariant (the thing every task protects)

> A send whose **cumulative rolling-month USD-equivalent volume + the requested amount stays under $3,000** — i.e. the overwhelming majority of transfers today — is processed **byte-for-byte** as it is now: the bot collects exactly today's six fields, `check_send_limit` returns the same shape plus a benign `edd_required: false`, `screenTransfer` produces the same `ComplianceStatus`/`reasons`, and no Core-ID/Travel-Rule/EDD field is *required*. Every new field on `Customer` and `Transfer` is **optional**; `MonthlyVolumeStore` is **new** (no migration, no read-path write); the agent asks for SoF/occupation **only** when the cumulative trigger fires. The existing **~453-test suite staying green** is the executable proof.

This mirrors how P1–P5 shipped: working infrastructure, zero live customer-facing change by default.

## Locked design decisions (2026-05-29)

1. **Scope = data capture now, real provider later.** Build the tiered KYC/Travel-Rule/EDD data capture; do **not** implement Persona. The `KycProvider`/`MockKycProvider` interface (`src/lib/providers/kyc-provider.ts`, `mock-kyc-provider.ts`) stays the swap-in seam — untouched.
2. **Reuse P5's `SanctionsScreener` seam** (`src/lib/providers/sanctions-provider.ts`, `getSanctionsScreener`) for name screening of **sender AND recipient**. Keep the pluggable `MockSanctionsScreener`; build no real sanctions API. `compliance-config.ts` remains the canonical home of screening constants.
3. **WU four-tier model captured:**
   - **Tier 1 Core-ID (CIP)** on `Customer`: full legal name, DOB, residential address, government-ID type+number, nationality. (`fullName?`, `dateOfBirth?`, `country?` already exist — `country` is legacy free-text, do not route on it; add only address/ID/nationality.)
   - **Tier 2 Transaction/Counterparty (Travel Rule)** on `Transfer`, **per send**: recipient legal name, sender↔recipient relationship, purpose of transfer.
   - **Tier 3 Risk/Compliance**: screen sender + recipient names via `SanctionsScreener`; a `pepDeclared` self-declaration flag on `Customer`.
   - **Tier 4 EDD at $3,000**: source-of-funds + occupation, triggered on **cumulative rolling-month** USD-equivalent volume via a new `MonthlyVolumeStore` (mirror `daily-volume-store.ts`).
4. **UX / behaviour defaults:** SoF and occupation are **fixed dropdown enums** (screenable, friction-free), not free text. EDD-miss ⇒ **flag** (`complianceStatus 'flagged'`, reason `'edd_required'`), **not** a hard block; flagged transfers surface in the dashboard for triage and do **not** auto-block the customer from future sends. **Progressive collection:** never ask for SoF/occupation on small sends; `check_send_limit` returns an `edd_required` flag and the agent collects EDD fields **only** when cumulative-month + requested crosses $3,000.
5. **Dormancy / back-compat:** every new field **optional**; **lazy-fill on read** (no write on read paths, exactly like `customer-store.getCustomer`'s `senderCountry`/`partnerId` fill); `MonthlyVolumeStore` is **new** (no migration); sub-$3k / no-EDD behaviour is byte-for-byte unchanged. The ~453-test suite staying green is the proof.
6. **PII / security** (see Security notes): new PII (legal name, DOB, ID number, address, SoF, occupation, PEP) lives in Redis. At-rest encryption is the managed-Redis (Upstash) layer; app-level field encryption is **out of scope** for the prototype but flagged. Dashboard PII visibility is **scope-aware** (platform admin + owning-partner staff via the existing scoped store). The **bot stays partner-blind and never echoes PII it shouldn't**. Server-side enforcement; untrusted input defensive (`?? ''`, `trim`); the full server-action security checklist for any new mutation.
7. **Conventions:** USD-equivalent thresholds ($3,000 = `300_000` cents); ISO country codes; no `as any`; `fakeRedis()` in tests; TDD per task; `bot-content-guard` stays green; one atomic commit per task; commit prefix `feat(kyc):`.
8. **Out of scope (deferred):** real Persona integration; real sanctions provider; source-of-funds **document upload** (capture the enum + optional note only); the deferred P5 admin rule-creation UI; auto-blocking on flagged EDD.

---

## Architecture

```
check_send_limit({ amount_usd })                       src/lib/tools.ts
  │  resolveCurrencyAndRates → amountUsd (USD-equiv)
  │  todayUsedCents   = dailyVolumeStore.getTodayCents(phone)      (existing, cap path — UNCHANGED)
  │  monthUsedCents   = monthlyVolumeStore.getMonthCents(phone)    ← NEW (MonthlyVolumeStore)
  │  evaluateCap(...)                                              (UNCHANGED cap math)
  │  evaluateEdd(monthUsedCents, requestedCents)                  ← NEW (tier-rules.ts, pure)
  ▼  returns { ...today's fields, edd_required: boolean, edd_fields_present?: boolean }
  │
  ▼  edd_required === false  →  bot asks NOTHING new (DORMANT — byte-for-byte today)
  │  edd_required === true   →  prompt rule: collect source_of_funds + occupation
  │                             (+ Travel-Rule fields) before send_approve_picker
  ▼
send_approve_picker / create_transfer (draft)          src/lib/tools.ts
  │  Travel-Rule + EDD enum args flow into the Draft, then into CreateTransferInput
  ▼
createTransfer(store, partnerStore, input)             src/lib/transfer-create.ts
  │  sourceCountry = countryForCurrency(input.sourceCurrency)     (P4 symbol)
  │  partner       = partnerStore.getPartner(input.partnerId)     (P5 wiring)
  │  rules         = resolveCorridorRules(partner, sourceCountry) (P5)
  │  monthUsedCents= monthlyVolumeStore.getMonthCents(input.phone)← NEW
  ▼
  ├── screenTransfer({ amountUsd, recipientName, transfersToday,  src/lib/compliance.ts (P5)
  │                    sourceCountry, rules,
  │                    senderName })                              ← NEW: sender name too
  │       screener.screen({ name: recipient, ... })  ─┐
  │       screener.screen({ name: sender, ... })      ├─► SanctionsScreener (P5 seam, REUSED)
  │                                                    │   hit ⇒ status 'blocked'
  │
  └── evaluateEddForTransfer(monthUsedCents, amountUsd_cents,     ← NEW (tier-rules.ts)
                             eddFieldsPresent)
          cumulative crosses $3k AND SoF/occupation missing
          ⇒ merge 'flagged' + reason 'edd_required'  (NEVER 'blocked')
  ▼
  Transfer { complianceStatus, complianceReasons, + Travel-Rule + EDD enums }
  monthlyVolumeStore.addCents(phone, amountUsd_cents)   ← NEW (after save, like dailyVolumeStore)

Dashboard (scope-aware, read-only PII):
  /dashboard/customers/[phone]/page.tsx  ── Core-ID + PEP + KYC card (platform admin
                                            + owning-partner staff only)
  /dashboard/compliance/page.tsx         ── flagged EDD transfers surface for triage
```

For the **dormant** path (cumulative-month + requested < $3,000), `evaluateEdd` returns `edd_required: false`, `evaluateEddForTransfer` is a no-op, the bot asks nothing new, and `screenTransfer` collapses to today's behavior (sender screening of an unknown/absent name is a no-op miss, identical to recipient-only screening today).

---

## Components

### 1. Core-ID (CIP) `Customer` fields + enums — `src/lib/types.ts`

Add the Tier-1 fields **not already present** (`fullName?`, `dateOfBirth?` already exist; `country?` is reserved legacy free-text and is **not** reused for routing or nationality). Plus the Tier-3 PEP flag. All optional → dormancy.

```ts
// Government-ID type — closed list (screenable, ISO-aligned where relevant).
export type GovIdType = 'passport' | 'drivers_license' | 'national_id' | 'state_id';

// Tier-4 EDD enums — FIXED dropdowns, never free text (screenable, friction-free).
export type SourceOfFunds =
  | 'employment' | 'business' | 'investment' | 'gift' | 'savings' | 'other';

export type Occupation =
  | 'salaried' | 'self_employed' | 'business_owner' | 'student'
  | 'homemaker' | 'retired' | 'unemployed' | 'other';

export interface Customer {
  // ...existing: senderPhone, firstSeenAt, kycStatus, kycVerifiedAt?, kycProviderRef?,
  //   kycRejectedReason?, fullName?, dateOfBirth?, country? (legacy free-text),
  //   senderCountry, partnerId, createdAt, updatedAt

  // ── Tier 1 Core-ID (CIP) — NEW (KYC), all optional ──
  residentialAddress?: string;   // single-line residential address (captured, not validated)
  govIdType?: GovIdType;
  govIdNumber?: string;          // PII — masked in dashboard except last 4
  nationality?: CountryCode;     // ISO 3166-1 alpha-2 (typed, unlike legacy `country`)

  // ── Tier 3 Risk — NEW (KYC) ──
  pepDeclared?: boolean;         // self-declared Politically Exposed Person flag

  // ── Tier 4 EDD profile (sticky once captured) — NEW (KYC) ──
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  eddCapturedAt?: string;        // ISO — when EDD enums were last supplied
}
```

Notes:
- `nationality` is a **typed `CountryCode`** (the routing-grade discriminator), deliberately distinct from the legacy `country?: string` — same two-fields-two-concerns precedent P1 set for `senderCountry` vs `country`.
- `govIdNumber` is the one high-sensitivity Core-ID field; the dashboard masks it (Component 8).
- Once `sourceOfFunds`/`occupation`/`eddCapturedAt` are set, they are **sticky** — a returning EDD-eligible customer who already supplied them is **not** re-asked (the agent only collects when missing).
- No migration needed: lazy-fill on read leaves `undefined` as "not captured" (Component 8 renders `'—'`).

### 2. Travel-Rule (Tier 2) `Transfer` fields + enums — `src/lib/types.ts`

Counterparty data captured **per send** (a transfer to one relationship/purpose says nothing about the next).

```ts
export type SenderRecipientRelationship =
  | 'self' | 'spouse' | 'parent' | 'child' | 'sibling'
  | 'other_family' | 'friend' | 'business' | 'other';

export type TransferPurpose =
  | 'family_support' | 'gift' | 'education' | 'medical'
  | 'savings' | 'bills' | 'business' | 'other';

export interface Transfer {
  // ...existing fields...

  // ── Tier 2 Travel-Rule (per-send) — NEW (KYC), all optional ──
  recipientLegalName?: string;            // legal name distinct from display recipientName
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;

  // ── Tier 4 EDD snapshot at send time — NEW (KYC) ──
  eddRequired?: boolean;                  // true when this send crossed the $3k cumulative trigger
}
```

Notes:
- `recipientLegalName` is **separate** from the existing required `recipientName` (display/payout name). On the dormant path it stays `undefined`; the EDD/Travel-Rule path collects it.
- `complianceReasons` (existing `string[]`) carries `'edd_required'` when the EDD field-gate misses — no schema change to the reasons array, mirroring P5's reason-string approach.
- These flow through the existing `Draft` (Component 5) into `CreateTransferInput`.

### 3. `MonthlyVolumeStore` — `src/lib/monthly-volume-store.ts` (new, mirrors `daily-volume-store.ts`)

A direct mirror of `createDailyVolumeStore`, keyed per phone per **calendar month** (Eastern), holding **USD-equivalent cents**. Drives the cumulative EDD trigger so structuring across many small daily sends is caught.

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import { easternMonth } from './dates';     // NEW helper: 'YYYY-MM' in America/New_York
import type { RedisLike } from './store';

const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60; // keep last month for late audits / rollover

export function createMonthlyVolumeStore(redis: RedisLike) {
  function key(senderPhone: string): string {
    return `monthly_volume:${senderPhone}:${easternMonth(Date.now())}`;
  }
  return {
    async getMonthCents(senderPhone: string): Promise<number> {
      const raw = await redis.get(key(senderPhone));
      return raw ? Number(raw) : 0;
    },
    async addCents(senderPhone: string, cents: number): Promise<void> {
      const k = key(senderPhone);
      const current = Number((await redis.get(k)) ?? '0');
      await redis.set(k, String(current + cents), { ex: MONTH_TTL_SECONDS });
    },
  };
}

export type MonthlyVolumeStore = ReturnType<typeof createMonthlyVolumeStore>;

let cached: MonthlyVolumeStore | null = null;
export function getMonthlyVolumeStore(): MonthlyVolumeStore { /* same singleton shape as daily */ }
```

Notes:
- **New key namespace** (`monthly_volume:…`) — no migration, no collision with `daily_volume:…`. A first read of a never-written key returns `0` (dormant: `edd_required` stays false until real cumulative volume accrues).
- Mirrors the daily store's read-modify-write and `automaticDeserialization: false` singleton exactly; `easternMonth` is a 3-line sibling of `easternDate` in `dates.ts` (`YYYY-MM` slice).
- `addCents` is called from `createTransfer` **after** save with `Math.round(transfer.amountUsd * 100)` — the same USD-equivalent cents the daily store and cap path already use.

### 4. EDD trigger in `tier-rules.ts` — pure, TDD'd

Add an EDD threshold constant and two pure helpers alongside `deriveTier`/`evaluateCap`. The EDD evaluation is **orthogonal to the cap tier** (a verified T1 customer still trips EDD at $3k) — kept as separate functions so `evaluateCap` is byte-for-byte unchanged.

```ts
export const EDD_THRESHOLD_CENTS = 300_000;   // $3,000 USD-equivalent

export interface EddEvaluation {
  eddRequired: boolean;          // cumulative-month + requested >= $3,000
  monthUsedCents: number;
  requestedCents: number;
  thresholdCents: number;        // EDD_THRESHOLD_CENTS (surfaced for messaging)
}

// Cumulative trigger: does this send push the rolling-month total to/over $3k?
export function evaluateEdd(
  monthUsedCents: number,
  requestedCents: number,
): EddEvaluation {
  const eddRequired = monthUsedCents + requestedCents >= EDD_THRESHOLD_CENTS;
  return { eddRequired, monthUsedCents, requestedCents, thresholdCents: EDD_THRESHOLD_CENTS };
}

// At create time: if EDD is required AND the EDD profile fields are absent,
// the transfer is FLAGGED (never blocked). Returns the reasons to merge.
export function evaluateEddForTransfer(input: {
  monthUsedCents: number;
  requestedCents: number;
  eddFieldsPresent: boolean;     // sourceOfFunds && occupation both set
}): { eddRequired: boolean; flagReason?: 'edd_required' } {
  const { eddRequired } = evaluateEdd(input.monthUsedCents, input.requestedCents);
  if (eddRequired && !input.eddFieldsPresent) return { eddRequired, flagReason: 'edd_required' };
  return { eddRequired };
}
```

Notes:
- `>=` so a send landing exactly on $3,000 trips EDD (the regulatory threshold is inclusive).
- Defensive: callers pass `monthUsedCents ?? 0`; `evaluateEdd(0, smallCents)` → `false` (dormant).
- **Never** returns a block — the locked decision is flag-only. The flag reason string `'edd_required'` joins `complianceReasons` and is surfaced on the dashboard for triage.

### 5. Agent collection: `check_send_limit` flag, draft/tool args, prompt — `src/lib/tools.ts` + `src/lib/prompt.ts`

**`check_send_limit` (the progressive gate).** Extend the existing tool to also read monthly volume and return an `edd_required` flag plus whether the customer already has EDD fields on file. Today's returned fields are **unchanged** (additive only).

```ts
// inside checkSendLimitTool, after evaluateCap(...):
const monthUsedCents = await ctx.monthlyVolumeStore.getMonthCents(ctx.phone);   // NEW
const edd = evaluateEdd(monthUsedCents, requestedCents);                         // NEW
const eddFieldsPresent = Boolean(customer.sourceOfFunds && customer.occupation); // NEW
return {
  ...existingFields,            // within_cap, tier, daily_cap_usd, …, kyc_url (UNCHANGED)
  edd_required: edd.eddRequired && !eddFieldsPresent,   // false on the dormant path
  edd_threshold_usd: edd.thresholdCents / 100,          // 3000 (for messaging)
};
```

**`ToolContext` + dependency wiring.** Add `monthlyVolumeStore: MonthlyVolumeStore` to `ToolContext` (beside `dailyVolumeStore`), thread it through `agent.ts`'s `executeTool` call and the agent `deps`, and into the webhook/cron wiring (`getMonthlyVolumeStore()`), exactly mirroring how `dailyVolumeStore` is plumbed.

**Travel-Rule + EDD args.** Add **optional** parameters to `create_transfer` / `send_approve_picker` / `create_schedule`: `recipient_legal_name`, `relationship` (enum), `purpose` (enum), `source_of_funds` (enum), `occupation` (enum). They flow into the `Draft` (extend `types.ts` `Draft` with the optional Travel-Rule/EDD fields) and then into `CreateTransferInput`. On the dormant path the LLM omits them (the prompt only asks when `edd_required`), so `Draft`/`Transfer` keep them `undefined`. `createTransferTool` persists `source_of_funds`/`occupation` back onto the `Customer` (sticky profile) when supplied.

**`CreateTransferInput` + `createTransfer`.** Add the optional Travel-Rule/EDD fields to `CreateTransferInput`; inside `createTransfer`, read `monthUsedCents`, call `evaluateEddForTransfer`, and **merge** any `'edd_required'` reason into the compliance result *after* `screenTransfer` (so a watchlist block still wins; EDD only ever adds a flag):

```ts
const monthUsedCents = await monthlyVolumeStore.getMonthCents(input.phone);   // NEW
const eddFieldsPresent = Boolean(input.sourceOfFunds && input.occupation);
const eddCheck = evaluateEddForTransfer({ monthUsedCents, requestedCents: Math.round(q.amountUsd * 100), eddFieldsPresent });
let { status, reasons } = compliance;                          // from screenTransfer
if (status !== 'blocked' && eddCheck.flagReason) {             // EDD never overrides a block
  status = 'flagged';
  reasons = [...reasons, 'edd_required'];
}
// ...write recipientLegalName/relationship/purpose/eddRequired onto the Transfer...
// after saveTransfer: await monthlyVolumeStore.addCents(input.phone, Math.round(transfer.amountUsd * 100));
```

`createTransfer` gains a `monthlyVolumeStore` parameter (alongside `store`, `partnerStore`) — the tool path and the cron path (`cron-run.ts`) both already hold a volume store in scope, so wiring is one parameter.

**`prompt.ts` — a new conditional collection block (asks NOTHING by default):**

```
ENHANCED VERIFICATION (only when check_send_limit returns edd_required: true)
- If — and only if — check_send_limit returns edd_required: true, before
  send_approve_picker collect TWO additional details:
    • source of funds (employment, business, investment, gift, savings, other)
    • occupation (salaried, self-employed, business owner, student, homemaker,
      retired, unemployed, other)
  Pass them as source_of_funds and occupation. Explain briefly: "For transfers
  totaling $3,000 or more this month we're required to ask a couple of quick
  questions." If edd_required is false, NEVER ask these.
```

Notes:
- Per-turn EDD notes are **not** injected as a system note for the dormant path; the gate is the tool result, so no new `[…]` system note appears unless EDD is live — keeping the dormant message stream identical.
- The Travel-Rule fields (relationship/purpose/recipient legal name) are collected on the EDD path; for the prototype they are **optional** and the prompt requests them only in the EDD block to preserve dormancy (a future tightening can require them for all sends — noted in Open questions).
- All prompt additions stay **PII-blind and partner-blind**: no field value is ever echoed back; the words `corridor`/`watchlist`/`sanctions`/`partner` never appear (bot-content-guard).

### 6. Sanctions screening of sender + recipient via the P5 seam — `src/lib/compliance.ts`

`screenTransfer` already routes **recipient** name screening through `SanctionsScreener` (P5). Tier-3 adds **sender** screening through the **same seam** — no new provider, no new interface.

```ts
export async function screenTransfer(input: {
  amountUsd: number;
  recipientName: string;
  transfersToday: number;
  sourceCountry?: CountryCode;
  rules?: ResolvedCorridorRules;
  screener?: SanctionsScreener;
  senderName?: string;          // NEW (KYC) — sender legal name, screened via the SAME seam
}): Promise<ComplianceResult> {
  // ...resolve rules + screener exactly as today (P5)...
  const recipientHit = await screener.screen({ name: input.recipientName ?? '', sourceCountry });
  const senderHit = input.senderName
    ? await screener.screen({ name: input.senderName ?? '', sourceCountry })   // NEW
    : { matched: false };
  if (recipientHit.matched || senderHit.matched) {
    return { status: 'blocked', reasons: ['Recipient is on the compliance watchlist.'] };
    // (reason string kept identical to preserve dormancy; sender-hit reuses it)
  }
  // ...large-amount + velocity exactly as today...
}
```

Notes:
- `senderName` is **optional**; the dormant path passes nothing → `senderHit = { matched: false }` → byte-for-byte today's recipient-only result. The full P5 `compliance.test.ts` suite stays green.
- `senderName` is sourced from `customer.fullName` (or the captured Core-ID legal name) in `createTransfer`; an unset name screens to a clean miss (the mock already returns `{ matched: false }` for `''`).
- Same blocked-reason string (`'Recipient is on the compliance watchlist.'`) is intentionally reused so existing assertions and dashboard rendering are untouched; a distinct sender-reason is an Open question.
- Real provider swap remains a single `getSanctionsScreener` factory change — sender screening rides the existing seam for free.

### 7. EDD-flag surfacing in the dashboard — `src/app/dashboard/compliance/page.tsx`

Flagged-EDD transfers must be **triageable**, not silent. The compliance page already lists flagged/blocked transfers; `'edd_required'` rides the existing `complianceReasons` array, so it surfaces in the flagged tab with **no schema change** — add only a human label/pill for the `edd_required` reason (e.g. `sh-pill sh-pill-warn` "EDD required") so staff can distinguish it from large-amount/velocity flags. Read-only; no server action; scope-aware via the existing `requireScope()` + `createScopedStore(staff)` already on that page.

### 8. Dashboard PII / KYC display — `src/app/dashboard/customers/[phone]/page.tsx`

Extend the existing **Identity & KYC** card to render the captured Core-ID + Tier-3 fields, **scope-aware** and PII-conscious. The page already calls `requireScope()` + `createScopedStore(staff)` and reads the scoped customer; the scoped store already restricts a sub-admin to their partner's customers, so PII visibility is **automatically** platform-admin + owning-partner-staff only.

```tsx
<dt>Full name</dt><dd>{customer.fullName ?? '—'}</dd>          {/* existing */}
<dt>DOB</dt><dd>{customer.dateOfBirth ?? '—'}</dd>            {/* existing */}
<dt>Nationality</dt><dd>{customer.nationality ?? '—'}</dd>     {/* NEW */}
<dt>Address</dt><dd>{customer.residentialAddress ?? '—'}</dd>  {/* NEW */}
<dt>Gov ID</dt><dd>{customer.govIdType ? `${customer.govIdType} ••••${maskLast4(customer.govIdNumber)}` : '—'}</dd>
<dt>PEP</dt><dd>{customer.pepDeclared ? 'Self-declared' : 'No'}</dd>   {/* NEW */}
<dt>Source of funds</dt><dd>{customer.sourceOfFunds ?? '—'}</dd>       {/* NEW (EDD) */}
<dt>Occupation</dt><dd>{customer.occupation ?? '—'}</dd>               {/* NEW (EDD) */}
```

- `govIdNumber` is **masked** to last-4 (`maskLast4` helper, defensive `?? ''`); the raw number is never rendered in full. `'—'` for any unset field (lazy-fill leaves `undefined`).
- The customer **list** page (`customers/page.tsx`) is unchanged — PII detail lives only on the scoped `[phone]` detail page.
- **If** a staff EDD/Core-ID edit form is added, its server action must follow the full server-action security checklist (own `requireScope`/`requireAdmin`, target-customer-in-scope check, no unconditional overwrite of another partner's record, route/`phone`-authoritative ownership) — the existing `markCustomerVerifiedAction` is the template. (Capture-via-bot is the primary path; a staff edit form is an Open question.)

---

## Security notes

- **New PII at rest.** Legal name, DOB, government-ID number, residential address, nationality, source-of-funds, occupation, and the PEP flag are stored in Redis as part of the `Customer`/`Transfer` JSON. **At-rest encryption is provided by the managed Upstash Redis layer.** **App-level field encryption (e.g. encrypting `govIdNumber` before `redis.set`) is OUT OF SCOPE for this prototype** — explicitly flagged here as the gap to close before any real-money launch. `govIdNumber` is masked to last-4 in the dashboard as a minimum exposure control.
- **Scope-aware dashboard PII.** All PII is rendered only through `createScopedStore(staff)` on the `[phone]` detail page: a platform admin sees all customers; a partner sub-admin sees **only their partner's** customers (the scoped store enforces the boundary already). No PII is added to the unscoped list view, analytics, or any cross-partner aggregate.
- **Bot stays partner-blind AND PII-blind.** The agent collects EDD/Travel-Rule data but **never echoes it back**, never reads another customer's PII, and never sees partner identity, corridor rules, or watchlist contents. `bot-content-guard.test.ts` is extended to assert no prompt/tool chat-content string contains PII-leaking or internal terms (`govidnumber`, `source of funds` only ever appears as the *question*, never a stored value; `partner`/`corridor`/`watchlist`/`sanctions` stay absent).
- **Server-side enforcement only.** `evaluateEdd`/`evaluateEddForTransfer`, the monthly-volume read, and `screenTransfer` (sender+recipient) all run inside `createTransfer`/`check_send_limit` on the server. The LLM never sets the $3k threshold, never decides the flag, and cannot bypass screening — the EDD flag is computed from server-held cumulative volume, not from any model-supplied value.
- **Untrusted input, defensive.** Every enum arg from the LLM is validated against its closed set (unknown → treated as unsupplied, `eddFieldsPresent` stays false → flag rather than silent-pass); all string PII is `?? ''`-guarded and `trim`-med before storage; `monthUsedCents`/`requestedCents` are `Number(...)`-coerced with `?? 0` fallback. SoF/occupation being **enums not free text** is itself a security property: it bounds what can be stored and keeps the values screenable.
- **Server-action checklist for any new mutation.** No new public POST is strictly required (capture rides the bot path + existing actions). If a staff Core-ID/EDD edit action is added, it must: call its own `requireScope`/`requireAdmin`; verify the target customer is in the caller's scope; not blindly overwrite (`saveCustomer` is an unconditional SET — spread-merge the existing record, like `markCustomerVerifiedAction`); and treat the route `phone` as authoritative over any body field.

## Testing strategy

Per-component (TDD, `fakeRedis()` where Redis is involved):

- **`tier-rules.test.ts` (extend, ~10 cases):** `evaluateEdd` below/at/above $3k (`300_000` boundary inclusive via `>=`); cumulative trigger (`monthUsed 250_000 + requested 60_000` ⇒ required) catching structuring; `evaluateEddForTransfer` flags only when required **and** fields absent; never returns `'blocked'`; `evaluateCap` outputs **unchanged** (regression — EDD is orthogonal to tier).
- **`monthly-volume-store.test.ts` (new, ~6 cases):** mirrors `daily-volume-store.test.ts` — fresh key reads `0`; `addCents` accumulates; month-keyed isolation (different month ⇒ separate counter); TTL set; defensive `?? '0'`; `getMonthlyVolumeStore` singleton.
- **`compliance.test.ts` (extend, ~5 cases):** **dormant proof** — `screenTransfer` with no `senderName` reproduces today's recipient-only blocked/flagged/cleared exactly; a watchlisted **sender** name ⇒ `'blocked'`; clean sender + watchlisted recipient ⇒ `'blocked'` (unchanged); clean both ⇒ unchanged; sender screening goes through the injected `screener` (seam reuse).
- **`tools.test.ts` (extend, ~8 cases):** `check_send_limit` returns `edd_required: false` on the dormant path with all today's fields intact (regression); `edd_required: true` when cumulative+requested ≥ $3k and SoF/occupation absent; `edd_required: false` when the customer already has EDD fields on file (sticky); EDD enum args persist onto `Customer`; invalid enum ⇒ treated as unsupplied; Travel-Rule fields flow into the draft.
- **`transfer-create.test.ts` (extend, ~7 cases):** dormant send ⇒ today's `complianceStatus`/`complianceReasons` exactly (regression); a $3k-crossing send with missing EDD fields ⇒ `'flagged'` + `'edd_required'` reason, **not blocked**, customer **not** suspended; with EDD fields present ⇒ no EDD flag; a watchlist hit still `'blocked'` even when EDD would flag (precedence); `monthlyVolumeStore.addCents` called with USD-equivalent cents; Travel-Rule fields written onto the Transfer.
- **`bot-content-guard.test.ts` (extend, ~3 cases):** no prompt/tool chat content leaks a PII value or internal term; `source_of_funds`/`occupation` appear only as *questions*; `partner`/`corridor`/`watchlist`/`sanctions` stay absent (P2/P4/P5 guards still green).
- **`prompt.test.ts` (extend, ~2 cases):** the EDD block is present and conditioned on `edd_required: true`; the dormant prompt asks nothing new.
- **Dashboard pages:** not unit-tested (UI convention); covered by the prod Playwright smoke; `govIdNumber` masking verified by a small pure `maskLast4` unit test.
- **Full existing suite stays green — the dormancy proof.**

Rough test-count delta from **~453**: new `monthly-volume-store.test.ts` (~6) + extensions to tier-rules (~10), compliance (~5), tools (~8), transfer-create (~7), bot-content-guard (~3), prompt (~2) + a small mask helper (~2) ≈ **+~43 → ~496**.

## Acceptance criteria

- [ ] Core-ID `Customer` fields (`residentialAddress?`, `govIdType?`, `govIdNumber?`, `nationality?`), Tier-3 `pepDeclared?`, and EDD profile (`sourceOfFunds?`, `occupation?`, `eddCapturedAt?`) added to `types.ts` — all optional, no `as any`, `fullName`/`dateOfBirth`/`country` not duplicated.
- [ ] Travel-Rule `Transfer` fields (`recipientLegalName?`, `relationship?`, `purpose?`, `eddRequired?`) + the `SenderRecipientRelationship`/`TransferPurpose`/`GovIdType`/`SourceOfFunds`/`Occupation` enums added; all optional.
- [ ] `src/lib/monthly-volume-store.ts` exports `createMonthlyVolumeStore`/`getMonthlyVolumeStore` mirroring the daily store; USD-equivalent cents; new key namespace; no migration.
- [ ] `tier-rules.ts` exports `EDD_THRESHOLD_CENTS = 300_000`, `evaluateEdd`, `evaluateEddForTransfer`; pure, unit-tested; `evaluateCap` unchanged.
- [ ] `check_send_limit` returns additive `edd_required`/`edd_threshold_usd`; today's fields unchanged; reads `MonthlyVolumeStore`; `ToolContext` threads `monthlyVolumeStore`.
- [ ] Agent collection wired: optional Travel-Rule/EDD enum args on the relevant tools → `Draft` → `CreateTransferInput`; SoF/occupation persisted to the `Customer` (sticky); prompt asks the two EDD questions **only** when `edd_required: true`.
- [ ] `screenTransfer` screens **sender + recipient** via the **P5 `SanctionsScreener` seam**; optional `senderName` defaults to today's recipient-only behavior; no real provider built.
- [ ] `createTransfer` merges `'edd_required'` flag (never block; watchlist block wins) and calls `monthlyVolumeStore.addCents`; flagged-EDD transfers surface on `/dashboard/compliance` with a distinct label; customer is **not** auto-blocked.
- [ ] `/dashboard/customers/[phone]` renders Core-ID + PEP + EDD fields, scope-aware, with `govIdNumber` masked to last-4.
- [ ] `bot-content-guard` extended; no PII value or internal term leaks to bot content; Persona and any real sanctions API remain unimplemented.
- [ ] The full pre-batch suite passes (every prior test green) — the executable dormancy proof.

## Open questions

1. **Sender-screening reason string:** reuse `'Recipient is on the compliance watchlist.'` for a sender hit (zero churn, slightly imprecise) vs add a distinct `'Sender is on the compliance watchlist.'` (clearer triage, touches dashboard/tests). Recommend a distinct string — small, honest — and budget the extra assertion.
2. **Travel-Rule fields outside EDD:** collect `relationship`/`purpose`/`recipientLegalName` on **every** send (truer to the Travel Rule) vs **only** on the EDD path (preserves byte-for-byte dormancy). Recommend EDD-path-only now to protect the invariant; flag full-send capture as a fast follow once the prototype proves out.
3. **Rolling-month definition:** calendar month (Eastern, simplest, matches `easternDate`) vs a true trailing-30-day window (tighter anti-structuring, needs per-send timestamped accumulation rather than a single counter). Recommend calendar month for v1 (mirrors the daily store exactly); note the trailing-window upgrade.
4. **`kycCapHintUsd` reuse:** wire P5's per-corridor `kycCapHintUsd` (already on `ResolvedCorridorRules`) to **override** `EDD_THRESHOLD_CENTS` per corridor, or keep EDD a single global $3k for v1? Recommend global $3k now (locked), with the corridor hint as the documented future per-corridor override path.
5. **Staff PII edit form:** is bot-driven capture sufficient for v1, or do we also need a staff form on the `[phone]` page to enter/correct Core-ID/EDD fields? If yes, it is a new mutating server action and must clear the full server-action security checklist. Recommend deferring the form; capture via the bot + the existing verify/reject actions.
6. **Schedules and EDD:** does a recurring `create_schedule` whose monthly total will cross $3k need EDD capture at setup time, or only when each fired transfer crosses the cumulative line at run time? Recommend run-time evaluation in `cron-run.ts` (consistent with one trigger path); confirm.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| EDD path accidentally asks new questions on small sends (dormancy break) | Low | High | `edd_required` is the only gate, computed server-side from real cumulative volume; explicit dormant-proof tests; full suite must stay green. |
| `screenTransfer` sender-screening changes a today-cleared result | Low | High | `senderName` optional; absent ⇒ `{matched:false}`; dormant test reproduces recipient-only output byte-for-byte. |
| `createTransfer` EDD flag overrides a watchlist block | Low | High | Merge only when `status !== 'blocked'`; precedence test (watchlist beats EDD). |
| PII (govIdNumber) over-exposed in dashboard | Medium | High | Mask to last-4; scope-aware render only; app-level encryption flagged as out-of-scope gap, not silently ignored. |
| Calendar-month counter misses cross-month structuring (e.g. month-end split) | Medium | Medium | Documented v1 limitation (Open question 3); trailing-30-day upgrade path noted; daily cap still applies underneath. |
| LLM supplies an out-of-enum SoF/occupation value | Medium | Low | Validate against the closed set; unknown ⇒ unsupplied ⇒ flag (fail-safe to triage, never silent-pass). |
| `monthlyVolumeStore` not threaded into every create path (tool/cron) | Low | Medium | Add it to `ToolContext` + `createTransfer` signature; the compiler + the cron-run test catch a missing wire. |
| Persona/real-screening latency model differs from mocks | Medium | Low | Both seams (`KycProvider`, `SanctionsScreener`) already return Promises; swap is a factory change, no call-site churn. |

## Out of scope (deferred)

- **Real Persona integration** — the locked future KYC provider, deferred pending the user's Persona sandbox. The `KycProvider`/`MockKycProvider` interface stays the untouched swap-in seam; this batch captures data only.
- **Real sanctions provider** (ComplyAdvantage / Sanctions.io) — sender+recipient screening rides P5's `MockSanctionsScreener`; the real provider is a later `getSanctionsScreener` swap.
- **Source-of-funds DOCUMENT upload** — capture the SoF **enum** + an optional note only; file upload needs Persona/storage and is deferred.
- **The P5 admin rule-creation UI** — still deferred; the compliance page remains read-only.
- **Auto-blocking customers on flagged EDD** — EDD-miss flags for staff triage and never auto-blocks or suspends the customer.
- **App-level field encryption of PII** — at-rest encryption is the Upstash layer for the prototype; per-field app encryption is flagged but out of scope.
- **Full-send Travel-Rule capture / trailing-30-day window / per-corridor EDD thresholds** — recommended fast-follows captured in Open questions, not built in v1.

## Sequencing note

This batch stacks on **P5** (`spec/p5-per-corridor-compliance`): it reuses `getSanctionsScreener`/`MockSanctionsScreener` (`src/lib/providers/sanctions-provider.ts`), the corridor-aware `screenTransfer` signature and `ResolvedCorridorRules` (`compliance-config.ts`), the `partnerStore` already threaded into `createTransfer` (P4/P5), and the `countryForCurrency` source-country resolution. It also relies on P4's USD-equivalent accounting (`amountUsd` cents) for the cumulative trigger. **Branch off the merged P5 base** (P5 should merge to `main` before this batch begins, since the `SanctionsScreener` seam is its prerequisite). The `KycProvider` seam and Persona remain deferred; the real-provider swaps (KYC + sanctions) are downstream of this data-capture batch and require live partnerships/licenses per `docs/ROADMAP.md`.

---

## Key files (reference)

- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/types.ts` — `Customer`, `Transfer`, `KycStatus`, `CapEvaluation`, `CurrencyCode`/`CountryCode`, `Draft` (extend points)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/tier-rules.ts` — `deriveTier`/`evaluateCap` (unchanged); new `EDD_THRESHOLD_CENTS`/`evaluateEdd`/`evaluateEddForTransfer`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/compliance.ts` + `compliance-config.ts` — `screenTransfer` (add optional `senderName`), `ResolvedCorridorRules`/`kycCapHintUsd` hook
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/providers/sanctions-provider.ts` — `getSanctionsScreener`/`MockSanctionsScreener` (REUSED seam); `kyc-provider.ts`/`mock-kyc-provider.ts` (DEFERRED Persona seam)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/daily-volume-store.ts` — mirror for new `src/lib/monthly-volume-store.ts`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/transfer-create.ts` — EDD merge + `monthlyVolumeStore.addCents` wiring
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/tools.ts` (`checkSendLimitTool`, `ToolContext`, draft/create paths) + `prompt.ts` (EDD collection block) + `agent.ts` (per-turn note pattern, dep wiring)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/app/dashboard/customers/[phone]/page.tsx` + `customers/page.tsx` + `compliance/page.tsx` (scope-aware PII/KYC + EDD-flag display)
- Current suite measured at 453 tests across 54 files (`tests/`); projected delta +~43 → ~496.
