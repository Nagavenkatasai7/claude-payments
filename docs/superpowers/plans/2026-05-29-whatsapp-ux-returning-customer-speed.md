# WhatsApp UX — Returning-Customer Fast Path (Bundle C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut turns for repeat senders — resolve a typed recipient name to a saved recipient, default the sender's last funding method, and re-send a past transfer — without touching any money/compliance gate.

**Architecture:** Two new tools in `src/lib/tools.ts` (`resolve_recipient`, read-only; `repeat_transfer`, which routes through the existing `send_approve_picker` → draft → Approve-card path and never calls `create_transfer` directly), one additive optional `Customer` field pair (`lastFundingMethod`/`lastFundingMethodAt`) surfaced as a round-0 `[SENDER DEFAULTS]` system note, and prompt guidance. The existing Approve & pay card is the single human confirmation gate. New/history-less customers behave exactly as today (no match, no default, no note).

**Tech Stack:** Next.js 16, TypeScript, Vitest, Upstash Redis (`fakeRedis()` in tests). Spec: `docs/superpowers/specs/2026-05-29-whatsapp-ux-returning-customer-speed-design.md`.

**Conventions:** TDD per task; one atomic commit per task; commit prefix `feat(wa-ux-c):`; no `as any`; `rm -rf .next` before `npm run typecheck` if a stale-cache "Duplicate identifier" appears. Suite baseline is **592** green at the start of this plan.

---

### Task 1: `resolve_recipient` tool (typed-name → saved recipient)

**Files:**
- Modify: `src/lib/tools.ts` — add a schema object to `toolSchemas` (before its closing `];` at line ~389), add a `case 'resolve_recipient'` to `executeTool` (before `default:` at line ~461), and append the `resolveRecipientTool` function near the other tool impls.
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools.test.ts` (the file already imports `executeTool`, `toolSchemas`, `fakeRedis`, and defines `buildCtx`). Append a new describe block:

```typescript
describe('resolve_recipient — typed-name lookup of saved recipients', () => {
  const seedRecipient = async (
    ctx: ReturnType<typeof buildCtx>,
    over: Partial<{ name: string; recipientPhone: string; payoutMethod: 'upi' | 'bank'; payoutDestination: string }> = {},
  ) => {
    await ctx.store.upsertRecipient(ctx.phone, {
      name: over.name ?? 'Mom',
      recipientPhone: over.recipientPhone ?? '919876543210',
      payoutMethod: over.payoutMethod ?? 'upi',
      payoutDestination: over.payoutDestination ?? 'mom@okhdfc',
      lastUsedAt: new Date().toISOString(),
    });
  };

  it('returns match:exact for a single case-insensitive, trimmed name match with payout details', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210', payoutDestination: 'mom@okhdfc' });
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111', payoutDestination: 'dad@okaxis' });
    const r = await executeTool('resolve_recipient', { name: '  mOm ' }, ctx);
    expect(r.match).toBe('exact');
    expect((r.recipient as Record<string, unknown>).recipient_phone).toBe('919876543210');
    expect((r.recipient as Record<string, unknown>).payout_destination).toBe('mom@okhdfc');
    // field hygiene: no internal fields leak
    expect(r.recipient).not.toHaveProperty('partnerId');
    expect(r.recipient).not.toHaveProperty('complianceStatus');
  });

  it('returns match:ambiguous when two saved recipients share the name', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210' });
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919800000000' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(2);
  });

  it('returns match:ambiguous for a partial/substring match (never auto-proceeds)', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom (work)', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(1);
  });

  it('returns match:none when nothing matches (cold-start path)', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none');
  });

  it('only searches the calling sender\'s own recipients', async () => {
    const redis = fakeRedis();
    const ctx = buildCtx(redis, '15551234567');
    const otherCtx = buildCtx(redis, '15559999999');
    await seedRecipient(otherCtx, { name: 'Mom', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none'); // the other sender's recipient is invisible
  });
});
```

Also update the existing roster test (it currently reads `it('exposes all fourteen tools', ...)`) — change the count word to **fifteen** and add `'resolve_recipient'` to the asserted sorted array:

```typescript
  it('exposes all fifteen tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'cancel_draft',
      'cancel_schedule',
      'check_payment_status',
      'check_send_limit',
      'create_schedule',
      'create_transfer',
      'generate_payment_link',
      'get_quote',
      'list_saved_recipients',
      'list_schedules',
      'resolve_recipient',
      'send_approve_picker',
      'send_recipient_picker',
      'update_recipient_phone',
      'validate_phone',
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools.test.ts -t "resolve_recipient"`
Expected: FAIL — `Unknown tool: resolve_recipient` and the roster test fails (14 vs 15).

- [ ] **Step 3: Add the schema, dispatch case, and implementation**

In `src/lib/tools.ts`, insert this schema object into the `toolSchemas` array, immediately before the closing `];` (i.e. right after the `validate_phone` schema block that ends at line ~388):

```typescript
  {
    type: 'function',
    function: {
      name: 'resolve_recipient',
      description:
        "Look up the sender's saved recipients by a name they typed (e.g. 'Mom'). Returns { match: 'exact', recipient } when exactly one saved recipient matches — use its payout_method, payout_destination, and recipient_phone directly (do not re-ask). Returns { match: 'ambiguous', candidates } when more than one could match — call send_recipient_picker with the candidates. Returns { match: 'none' } when nothing matches — ask for the recipient's number and payout details.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The recipient name the user typed, e.g. 'Mom'." },
        },
        required: ['name'],
      },
    },
  },
```

Add the dispatch case in `executeTool`, immediately before `default:`:

```typescript
    case 'resolve_recipient':
      return resolveRecipientTool(args, ctx);
```

Append the implementation near the other read-only tools (e.g. just after `listSavedRecipientsTool`):

```typescript
async function resolveRecipientTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(args.name ?? '').trim().toLowerCase();
  if (!query) return { match: 'none' };

  let all: import('./types').Recipient[];
  try {
    all = await ctx.store.listRecipients(ctx.phone, 25); // generous cap; own-phone only
  } catch (err) {
    console.warn('resolve_recipient listRecipients failed:', err);
    return { match: 'none' };
  }

  // Customer-owned fields only — never partner/compliance/PII.
  const shape = (r: import('./types').Recipient) => ({
    name: r.name,
    recipient_phone: r.recipientPhone,
    payout_method: r.payoutMethod,
    payout_destination: r.payoutDestination,
  });
  const norm = (s: string) => (s ?? '').trim().toLowerCase();

  const exact = all.filter((r) => norm(r.name) === query);
  if (exact.length === 1) return { match: 'exact', recipient: shape(exact[0]) };

  // Ambiguous: >1 exact match, or only partial (either-direction substring) matches.
  // A partial match alone NEVER auto-proceeds — exact-1 is the only fast path.
  const candidates = (
    exact.length > 1
      ? exact
      : all.filter((r) => {
          const n = norm(r.name);
          return n.includes(query) || query.includes(n);
        })
  ).slice(0, 3); // WhatsApp reply-button cap

  if (candidates.length === 0) return { match: 'none' };
  return { match: 'ambiguous', candidates: candidates.map(shape) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools.test.ts -t "resolve_recipient"` then `npx vitest run tests/tools.test.ts -t "fifteen"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(wa-ux-c): resolve_recipient tool — typed-name lookup of saved recipients"
```

---

### Task 2: Prompt — typed-name resolution + shorthand

**Files:**
- Modify: `src/lib/prompt.ts` (add a section; reference `resolve_recipient`)
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt.test.ts`:

```typescript
describe('SYSTEM_PROMPT — typed-name resolution & shorthand (Bundle C)', () => {
  it('tells the bot to resolve a typed recipient name via resolve_recipient', () => {
    expect(SYSTEM_PROMPT).toContain('resolve_recipient');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('exact');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('ambiguous');
  });
  it('keeps check_send_limit before get_quote on the shorthand path', () => {
    // shorthand must not bypass the cap gate
    expect(SYSTEM_PROMPT).toContain('check_send_limit');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts -t "typed-name"`
Expected: FAIL — `resolve_recipient` not found in `SYSTEM_PROMPT`.

- [ ] **Step 3: Add the prompt section**

In `src/lib/prompt.ts`, insert this block immediately **after** the `GREETING & RETURNING CUSTOMERS` section (after the line `- If the user taps "[Tapped: Someone new]" run the cold-start flow.`) and before `QUOTE CONFIRMATION`:

```
SHORTHAND & TYPED RECIPIENT NAMES
- When the user names a recipient in plain text instead of tapping a button — e.g.
  "send Mom 500" or "send to Dad" — call resolve_recipient with that name FIRST:
  • match "exact"     → use the returned recipient's payout_method, payout_destination,
    and recipient_phone directly. Do NOT ask for them again. Continue with amount +
    funding method, then send_approve_picker.
  • match "ambiguous" → call send_recipient_picker with the returned candidates and let
    the user tap which one.
  • match "none"      → fall back to the normal recipient questions (name + number, then
    payout).
- For one-line shorthand like "send Mom 500", parse the amount and the name from the one
  message, resolve_recipient the name, then follow the usual gate: call check_send_limit
  with the amount BEFORE get_quote, then get_quote, then send_approve_picker. Never skip
  the approval card — it is the user's confirmation that the right person and amount are set.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts -t "typed-name"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(wa-ux-c): prompt — typed-name resolution + one-line shorthand"
```

---

### Task 3: Sticky funding — Customer field, write-on-create, `[SENDER DEFAULTS]` note

**Files:**
- Modify: `src/lib/types.ts` (add 2 optional fields to `Customer`)
- Modify: `src/lib/customer-store.ts` (add `recordFundingMethod`)
- Create: `src/lib/sender-defaults.ts` (pure `getSenderDefaultsNote`)
- Modify: `src/lib/agent.ts` (inject the note at round 0, reusing the already-fetched customer)
- Modify: `src/lib/tools.ts` (`createTransferTool` writes the default after both successful creates)
- Test: `tests/customer-store.test.ts`, `tests/sender-defaults.test.ts` (new), `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/customer-store.test.ts`, add:

```typescript
describe('recordFundingMethod (Bundle C sticky funding)', () => {
  it('persists lastFundingMethod + lastFundingMethodAt on an existing customer', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await cs.upsertOnFirstInbound(PHONE); // creates the customer record
    await cs.recordFundingMethod(PHONE, 'credit_card');
    const c = await cs.getCustomer(PHONE);
    expect(c?.lastFundingMethod).toBe('credit_card');
    expect(typeof c?.lastFundingMethodAt).toBe('string');
  });
  it('is a no-op when there is no customer record yet', async () => {
    const redis = fakeRedis();
    const cs = createCustomerStore(redis, createStore(redis));
    await cs.recordFundingMethod(PHONE, 'bank_transfer'); // must not throw
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });
});
```

Create `tests/sender-defaults.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getSenderDefaultsNote } from '@/lib/sender-defaults';
import type { Customer } from '@/lib/types';

const base: Customer = {
  senderPhone: '15551234567',
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  kycStatus: 'verified',
  senderCountry: 'US',
  partnerId: 'default',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('getSenderDefaultsNote', () => {
  it('returns a note naming a recent funding method', () => {
    const note = getSenderDefaultsNote({
      ...base,
      lastFundingMethod: 'bank_transfer',
      lastFundingMethodAt: new Date().toISOString(),
    });
    expect(note).toContain('[SENDER DEFAULTS]');
    expect(note.toLowerCase()).toContain('bank transfer');
  });
  it('returns "" for a customer with no remembered method (dormancy)', () => {
    expect(getSenderDefaultsNote(base)).toBe('');
  });
  it('returns "" for a null customer (new/history-less)', () => {
    expect(getSenderDefaultsNote(null)).toBe('');
  });
  it('returns "" when the default is older than 90 days (stale ⇒ ask)', () => {
    const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const note = getSenderDefaultsNote({
      ...base,
      lastFundingMethod: 'debit_card',
      lastFundingMethodAt: stale,
    });
    expect(note).toBe('');
  });
  it('leaks no partner/compliance/PII terms', () => {
    const note = getSenderDefaultsNote({
      ...base,
      lastFundingMethod: 'credit_card',
      lastFundingMethodAt: new Date().toISOString(),
    }).toLowerCase();
    for (const term of ['partner', 'corridor', 'compliance', 'watchlist', 'sanctions', 'provider']) {
      expect(note).not.toContain(term);
    }
  });
});
```

In `tests/tools.test.ts`, add (asserts the create path records the default):

```typescript
describe('create_transfer records the sender\'s funding method (Bundle C)', () => {
  it('writes lastFundingMethod onto the customer after a successful create', async () => {
    const ctx = buildCtx(fakeRedis());
    await executeTool('create_transfer', {
      amount_usd: 200,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'credit_card',
    }, ctx);
    const c = await ctx.customerStore.getCustomer(ctx.phone);
    expect(c?.lastFundingMethod).toBe('credit_card');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sender-defaults.test.ts tests/customer-store.test.ts -t "recordFundingMethod"`
Expected: FAIL — `getSenderDefaultsNote` / `recordFundingMethod` not defined.

- [ ] **Step 3a: Add the Customer fields**

In `src/lib/types.ts`, inside `interface Customer`, add immediately after the line `eddCapturedAt?: string;        // ISO — when EDD enums were last supplied`:

```typescript
  // ── Sticky funding (Bundle C) — the sender's last-used funding method ──
  lastFundingMethod?: FundingMethod;
  lastFundingMethodAt?: string;   // ISO-8601; powers the 90-day staleness check
```

- [ ] **Step 3b: Add `recordFundingMethod` to the customer store**

In `src/lib/customer-store.ts`, change the type import:

```typescript
import type { Customer, FundingMethod } from './types';
```

Add this method to the object returned by `createCustomerStore` (e.g. after `saveCustomer`):

```typescript
    async recordFundingMethod(senderPhone: string, method: FundingMethod): Promise<void> {
      const customer = await this.getCustomer(senderPhone);
      if (!customer) return; // nothing to stick to yet (no-op for brand-new senders)
      const nowIso = new Date().toISOString();
      await this.saveCustomer({
        ...customer,
        lastFundingMethod: method,
        lastFundingMethodAt: nowIso,
        updatedAt: nowIso,
      });
    },
```

- [ ] **Step 3c: Create `src/lib/sender-defaults.ts`**

```typescript
import type { Customer, FundingMethod } from './types';

const STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const FUNDING_LABEL: Record<FundingMethod, string> = {
  bank_transfer: 'bank transfer',
  debit_card: 'debit card',
  credit_card: 'credit card',
};

/**
 * A compact round-0 system note of the sender's last-used funding method, so the
 * bot can default it instead of re-asking. Returns '' (inject nothing) when there
 * is no recent default — preserving today's "always ask" behavior for new /
 * history-less customers and for stale (>90-day) defaults.
 *
 * Pure + read-only: takes the already-fetched Customer (no extra Redis read).
 * Surfaces ONLY the funding-method enum label — no PII, no partner, no amounts.
 */
export function getSenderDefaultsNote(customer: Customer | null): string {
  const method = customer?.lastFundingMethod;
  const at = customer?.lastFundingMethodAt;
  if (!method || !at) return '';
  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age > STALE_MS) return ''; // stale or unparseable ⇒ ask
  const label = FUNDING_LABEL[method];
  if (!label) return '';
  return (
    `[SENDER DEFAULTS] Last time, the sender paid by ${label}. If they don't say how ` +
    `they'll pay, default to this method; the approval card shows the fee so they can change it.`
  );
}
```

- [ ] **Step 3d: Inject the note in `agent.ts`**

In `src/lib/agent.ts`, add the import near the `getRecentTransfersNote` import:

```typescript
import { getSenderDefaultsNote } from './sender-defaults'; // NEW (Bundle C)
```

After the line `const recentNote = await getRecentTransfersNote(phone, deps.store);`, add (reusing the `noteCustomer` already fetched above):

```typescript
    // Sticky funding default (Bundle C): surfaced once at round 0 so the bot can
    // default the funding method instead of re-asking. '' (no injection) for new /
    // history-less customers and stale defaults — behavior unchanged.
    const senderDefaultsNote = getSenderDefaultsNote(noteCustomer);
```

In the round-0 injection area, after the existing block:

```typescript
      if (round === 0 && recentNote) {
        messages.push({ role: 'system', content: recentNote });
      }
```

add:

```typescript
      if (round === 0 && senderDefaultsNote) {
        messages.push({ role: 'system', content: senderDefaultsNote });
      }
```

- [ ] **Step 3e: Record the default after each successful create in `tools.ts`**

In `src/lib/tools.ts` `createTransferTool`, **button-tap path**: after the line `await persistEddProfile(ctx, customer, draft.sourceOfFunds, draft.occupation);` add:

```typescript
      await ctx.customerStore.recordFundingMethod(ctx.phone, draft.fundingMethod);
```

**Legacy path**: after the line `await persistEddProfile(ctx, legacyCustomer, legacySof, legacyOcc);` add:

```typescript
    await ctx.customerStore.recordFundingMethod(ctx.phone, args.funding_method as FundingMethod);
```

(`recordFundingMethod` re-reads the customer, so it composes correctly with the optional EDD write that precedes it. Cron-fired schedule sends go through `createTransfer` directly, NOT `createTransferTool`, so they never write the default — as designed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sender-defaults.test.ts tests/customer-store.test.ts tests/tools.test.ts -t "funding"`
Expected: PASS. Then run the full agent suite to confirm the extra round-0 note didn't break a count-based assertion:
Run: `npx vitest run tests/agent.test.ts`
Expected: PASS (if an agent test counts injected system messages, update its expected count by 1 for the case where a recent default is present — but the default is only injected when a `< 90 day` `lastFundingMethod` exists, which no existing agent fixture sets, so existing tests should be unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/customer-store.ts src/lib/sender-defaults.ts src/lib/agent.ts src/lib/tools.ts tests/customer-store.test.ts tests/sender-defaults.test.ts tests/tools.test.ts
git commit -m "feat(wa-ux-c): per-sender sticky funding default + [SENDER DEFAULTS] note"
```

---

### Task 4: Prompt — sticky funding usage

**Files:**
- Modify: `src/lib/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt.test.ts`:

```typescript
describe('SYSTEM_PROMPT — sticky funding default (Bundle C)', () => {
  it('tells the bot to use the [SENDER DEFAULTS] funding method when present', () => {
    expect(SYSTEM_PROMPT).toContain('[SENDER DEFAULTS]');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('default');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts -t "sticky funding"`
Expected: FAIL — `[SENDER DEFAULTS]` not in `SYSTEM_PROMPT`.

- [ ] **Step 3: Add the prompt section**

In `src/lib/prompt.ts`, insert this block immediately **after** the `CURRENCY` section (after the line ending `...send in USD and do not mention currency.`) and before `ENHANCED VERIFICATION`:

```
PAYMENT METHOD MEMORY
- If the system injects a "[SENDER DEFAULTS] ..." note this turn, the sender has a
  remembered funding method. If they do NOT specify how they'll pay, default to that
  method when you call get_quote and send_approve_picker — do not re-ask. The approval
  card shows the resulting fee, so they can still change it ("use credit instead").
- If no "[SENDER DEFAULTS]" note is present this turn, ask for the funding method as usual.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts -t "sticky funding"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(wa-ux-c): prompt — default to remembered funding method"
```

---

### Task 5: `repeat_transfer` tool (reactive re-send, routes through the approve card)

**Files:**
- Modify: `src/lib/tools.ts` — add schema, `case 'repeat_transfer'`, and the `repeatTransferTool` function.
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools.test.ts`:

```typescript
describe('repeat_transfer — reactive re-send to a past recipient (Bundle C)', () => {
  const seedPastTransfer = async (ctx: ReturnType<typeof buildCtx>) => {
    // A real create so the recipient + a past transfer exist with full details.
    await executeTool('create_transfer', {
      amount_usd: 500,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@okhdfc',
      funding_method: 'bank_transfer',
    }, ctx);
  };

  it('hydrates the last transfer and sends an approve card (a draft, NOT a new transfer)', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const countBefore = await ctx.store.getTransferCount(ctx.phone);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // routed through the draft path — no new transfer created yet
    expect(await ctx.store.getTransferCount(ctx.phone)).toBe(countBefore);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.recipient.payoutDestination).toBe('mom@okhdfc');
    expect(draft?.amountSource).toBe(500); // reused last amount
  });

  it('honors an amount_usd override', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 250 }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.amountSource).toBe(250);
  });

  it('falls back to the sender\'s remembered funding method when none is given', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx); // last transfer used bank_transfer + records it as the default
    await ctx.customerStore.recordFundingMethod(ctx.phone, 'credit_card'); // newer default
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.fundingMethod).toBe('credit_card');
  });

  it('errors when there is no past transfer to that number', async () => {
    const ctx = buildCtx(fakeRedis());
    const r = await executeTool('repeat_transfer', { recipient_phone: '910000000000' }, ctx);
    expect(r.error).toBeDefined();
    expect(r.sent).toBeUndefined();
  });

  it('returns needs_edd (and does NOT send a card) when the month is over the EDD threshold', async () => {
    const ctx = buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    // push cumulative monthly volume over $3,000 so evaluateEdd trips; customer has no SoF/occupation
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 300000);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(r.payout_destination).toBe('mom@okhdfc'); // hydrated details returned for the follow-up
  });
});
```

Update the roster test from **fifteen** to **sixteen** and add `'repeat_transfer'` to the sorted array (insert between `'list_schedules'` and `'resolve_recipient'`):

```typescript
  it('exposes all sixteen tools', () => {
    const names = toolSchemas.map((t) => t.function.name).sort();
    expect(names).toEqual([
      'cancel_draft',
      'cancel_schedule',
      'check_payment_status',
      'check_send_limit',
      'create_schedule',
      'create_transfer',
      'generate_payment_link',
      'get_quote',
      'list_saved_recipients',
      'list_schedules',
      'repeat_transfer',
      'resolve_recipient',
      'send_approve_picker',
      'send_recipient_picker',
      'update_recipient_phone',
      'validate_phone',
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools.test.ts -t "repeat_transfer"`
Expected: FAIL — `Unknown tool: repeat_transfer`.

- [ ] **Step 3: Add the schema, dispatch case, and implementation**

In `src/lib/tools.ts`, add this schema object to `toolSchemas` (e.g. directly after the `resolve_recipient` schema added in Task 1):

```typescript
  {
    type: 'function',
    function: {
      name: 'repeat_transfer',
      description:
        "Re-send to a recipient the sender has paid before, reusing that recipient's saved payout details and last amount. Use ONLY when the customer asks to repeat ('send the usual', 'send Mom again', 'same as last time'). amount_usd overrides the last amount; funding_method overrides the remembered method. It re-checks the cap and routes to the [Approve & pay] card — it never moves money without that confirmation. If it returns needs_edd: true, ask the source-of-funds + occupation questions, then call send_approve_picker with all the details it returned plus those two fields.",
      parameters: {
        type: 'object',
        properties: {
          recipient_phone: { type: 'string', description: "The recipient's WhatsApp number, from a past transfer (e.g. 919876543210)." },
          amount_usd: { type: 'number', description: 'Optional. New amount in the send currency; if omitted, reuse the last amount sent to this recipient.' },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'], description: "Optional. Defaults to the sender's remembered method, then the last transfer's method." },
        },
        required: ['recipient_phone'],
      },
    },
  },
```

Add the dispatch case before `default:`:

```typescript
    case 'repeat_transfer':
      return repeatTransferTool(args, ctx);
```

Append the implementation (place it after `sendApprovePickerTool`, since it delegates to it):

```typescript
async function repeatTransferTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return { error: "I need the recipient's WhatsApp number to repeat a transfer." };
  }

  // Hydrate the most-recent transfer to this recipient (own phone, newest-first).
  const mine = (await ctx.store.listTransfers()).filter(
    (t) => (t.phone ?? '') === ctx.phone && t.recipientPhone === recipientPhone,
  );
  const last = mine[0];
  if (!last) {
    return { error: "I don't see a past transfer to that number — who would you like to send to?" };
  }

  // Amount + funding fallback chain.
  const overrideAmount = Number(args.amount_usd);
  const amountSource =
    Number.isFinite(overrideAmount) && overrideAmount > 0
      ? overrideAmount
      : last.amountSource ?? last.amountUsd;
  const customer = await ctx.customerStore.getCustomer(ctx.phone);
  const fundingMethod =
    (args.funding_method as FundingMethod | undefined) ??
    customer?.lastFundingMethod ??
    last.fundingMethod;

  // Defense-in-depth cap + EDD re-check — the same gate the normal flow runs before
  // quoting. EDD must be collected BEFORE the approval card, so on edd_required we
  // return the hydrated details and let the model ask, rather than sending the card.
  const limit = await checkSendLimitTool(
    { amount_usd: amountSource, source_currency: last.sourceCurrency },
    ctx,
  );
  if (limit.within_cap === false) {
    return { error: 'That repeat would exceed your current sending cap.', cap_eval: limit };
  }
  if (limit.edd_required === true) {
    return {
      needs_edd: true,
      edd_threshold_usd: limit.edd_threshold_usd,
      amount_usd: amountSource,
      source_currency: last.sourceCurrency,
      funding_method: fundingMethod,
      recipient_name: last.recipientName,
      recipient_phone: recipientPhone,
      payout_method: last.payoutMethod,
      payout_destination: last.payoutDestination,
    };
  }

  // Route through the EXISTING approve-card path (cap re-check, quote, draft,
  // [Approve & pay] card). Never calls create_transfer directly — compliance
  // re-screens at approval exactly like any other send.
  return sendApprovePickerTool(
    {
      amount_usd: amountSource,
      funding_method: fundingMethod,
      recipient_name: last.recipientName,
      recipient_phone: recipientPhone,
      payout_method: last.payoutMethod,
      payout_destination: last.payoutDestination,
      source_currency: last.sourceCurrency,
    },
    ctx,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools.test.ts -t "repeat_transfer"` then `npx vitest run tests/tools.test.ts -t "sixteen"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(wa-ux-c): repeat_transfer tool — reactive re-send via the approve card"
```

---

### Task 6: Prompt — reactive "send the usual"

**Files:**
- Modify: `src/lib/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt.test.ts`:

```typescript
describe('SYSTEM_PROMPT — reactive repeat (Bundle C)', () => {
  it('tells the bot to use repeat_transfer reactively, never proactively', () => {
    expect(SYSTEM_PROMPT).toContain('repeat_transfer');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('do not offer this proactively');
  });
  it('handles the needs_edd follow-up', () => {
    expect(SYSTEM_PROMPT).toContain('needs_edd');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts -t "reactive repeat"`
Expected: FAIL — `repeat_transfer` not in `SYSTEM_PROMPT`.

- [ ] **Step 3: Add the prompt section**

In `src/lib/prompt.ts`, insert this block immediately **after** the `SHORTHAND & TYPED RECIPIENT NAMES` section (added in Task 2) and before `QUOTE CONFIRMATION`:

```
REPEAT A PAST TRANSFER
- If the customer asks to repeat a send ("send the usual", "send Mom again", "same as
  last time"), use the [RECENT TRANSFERS] note to identify the recipient, confirm the
  amount (same as before, or a new one if they say so), and call repeat_transfer with
  that recipient's phone — pass amount_usd or funding_method only if they asked to change
  them. Do not offer this proactively — only when they ask.
- If repeat_transfer returns needs_edd: true, ask the enhanced-verification questions
  (source of funds + occupation) first, then call send_approve_picker with all the details
  it returned plus those two fields.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts -t "reactive repeat"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(wa-ux-c): prompt — reactive 'send the usual' repeat flow"
```

---

### Task 7: bot-content-guard extension + wrap (gate + review + PR)

**Files:**
- Modify: `tests/bot-content-guard.test.ts` (scan the new note + new module)
- No source change expected unless the guard surfaces a leak.

- [ ] **Step 1: Add the guard test for the new round-0 note**

In `tests/bot-content-guard.test.ts`, add a describe block mirroring the existing transfer-memory rendered-note test:

```typescript
describe('Bundle C: [SENDER DEFAULTS] note + new tool modules stay partner-/compliance-/PII-blind', () => {
  it('the rendered sender-defaults note leaks no internal term', async () => {
    const { getSenderDefaultsNote } = await import('@/lib/sender-defaults');
    const note = getSenderDefaultsNote({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastFundingMethod: 'bank_transfer',
      lastFundingMethodAt: new Date().toISOString(),
    }).toLowerCase();
    for (const term of ['partner', 'corridor', 'compliance', 'watchlist', 'sanctions', 'provider', 'govid', 'residentialaddress']) {
      expect(note).not.toContain(term);
    }
  });

  it('sender-defaults.ts source contains no forbidden internal term', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/sender-defaults.ts'), 'utf-8').toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions']) {
      expect(src).not.toContain(term);
    }
  });
});
```

(`readFileSync` and `resolve` are already imported at the top of `tests/bot-content-guard.test.ts`.)

- [ ] **Step 2: Run the guard + confirm green**

Run: `npx vitest run tests/bot-content-guard.test.ts`
Expected: PASS. If any forbidden term is flagged in `tools.ts` (the new `error:` strings) or the prompt additions, reword the offending string to a customer-friendly phrasing and re-run.

- [ ] **Step 3: Full local gate**

```bash
rm -rf .next
npm run typecheck   # expect TYPECHECK_OK
npm run lint        # expect LINT_OK (eslint --max-warnings 0)
npx vitest run      # expect ~617–627 passed, 0 failed
npm run build       # expect BUILD_OK
```

- [ ] **Step 4: Independent final review (opus, read-only)**

Dispatch one adversarial reviewer over `main..HEAD` with the invariant focus: every `create_transfer` still re-screens; `repeat_transfer` routes through `send_approve_picker`/draft and never calls `create_transfer` directly; caps re-checked in USD-equiv; EDD re-triggers; `resolve_recipient` is read-only and own-phone-only; `Customer.lastFundingMethod` is additive with no migration; new/history-less customers unchanged; `bot-content-guard` green; tool roster 14 → 16. Fold in any Critical/Important findings, re-run the gate.

- [ ] **Step 5: Open the PR (hold the merge for the user's "deploy")**

```bash
git push -u origin spec/wa-ux-returning-customer-speed
gh pr create --base main --head spec/wa-ux-returning-customer-speed \
  --title "feat(wa-ux-c): returning-customer fast path (Bundle C)" \
  --body "<summary: resolve_recipient, sticky funding default, repeat_transfer; money/compliance gates unchanged; dormant for new customers; suite ~620; gate + final review green>"
```

Report the PR is ready and **hold the prod merge for the user's explicit "deploy".**

---

## Self-Review (against the spec)

**Spec coverage:**
- Capability 1 (shorthand) → Task 2 (prompt) on the Task 1 (`resolve_recipient`) seam. ✓
- Capability 2 (typed-name match, exact→card/ambiguous→picker) → Task 1 + Task 2. ✓
- Capability 3 (per-sender sticky funding) → Task 3 (data + write + note) + Task 4 (prompt). ✓
- Capability 4 (reactive repeat-last) → Task 5 (`repeat_transfer`) + Task 6 (prompt). ✓
- Invariant (compliance/caps/EDD re-run; no direct `create_transfer`; additive field, no migration; dormancy) → enforced in Task 5 design + Task 3 (no backfill) + Task 7 review. ✓
- bot-content-guard green → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type/name consistency:** `resolveRecipientTool` / `repeatTransferTool` / `recordFundingMethod` / `getSenderDefaultsNote(customer: Customer | null)` used identically across tasks; tool names `resolve_recipient` / `repeat_transfer` consistent in schema, dispatch, prompt, and tests; roster count steps 14 → 15 (Task 1) → 16 (Task 5) consistent. ✓
