# WhatsApp UX — Clarity + Faster First Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two findings from the live-bot test drive this batch. **(1) The quote is opaque and split from the approve buttons.** Today `sendApprovePickerTool` (`src/lib/tools.ts:833-841`) sends one interactive message whose body is only `` `Sending ${fmt(q.amountSource)} to ${args.recipient_name}.\nFee ${fmt(q.feeSource)} → ₹${q.amountInr.toLocaleString('en-IN')}.` `` — the FX rate (`q.fxRate`), the delivery ETA (`q.deliveryEstimate`, the `'within 10 minutes'` string computed in `fx.ts:67` and returned by `get_quote` but **never shown**), and the payout destination are all absent. **(2) The first send asks too many sequential questions and catches a bad number too late.** The prompt's `WHAT TO COLLECT` (`src/lib/prompt.ts:9-18`) is six items asked roughly one at a time; the recipient phone is only validated at `create_transfer` / `send_approve_picker` time (`normalizePhone` + `isValidPhone`, `src/lib/tools.ts:509-510`, `780-781`), so a typo surfaces as a late tool error. And the stage-1/2 payment strings (`src/lib/payment.ts:36`, `71`) trail off with `…` and carry no Transfer ID.

This batch fixes both — **Bundle A** (quote/confirmation clarity) and **Bundle B** (faster first send). It is an **intentional, behavior-changing UX batch**: bot conversation, question sequencing, and customer-visible copy change on purpose. **TRANSFER-CORRECTNESS is the invariant** — `fx.ts` (`quote()`, `sourceForInr()`, `MIN_USD`/`MAX_USD`, the `transferCount === 0 ⇒ feeUsd = 0` first-free path), every cap evaluation (`evaluateCap`/`evaluateEdd`), the draft create/consume flow (`draftStore.createDraft`/`consumeDraft`), `createTransfer()`, the server-side phone validation in `create_transfer`/`send_approve_picker`, and every `Quote`/`Transfer`/`TransferStatus`/Redis schema are **byte-for-byte unchanged**. This batch changes only: (a) customer-visible **copy** (the picker summary string, the two `payment.ts` stage strings), (b) question **sequencing** in `prompt.ts`, and (c) one **new read-only `validate_phone` tool** wrapping the existing `normalizePhone`/`isValidPhone` (no Redis, no writes). The empty-note "unchanged behavior" escape hatch from the transfer-memory batch does **not** apply here — the bot's words and question order change on purpose; the executable proof is that `bot-content-guard` stays green and the full suite stays green **after** the intentional copy/flow test updates.

**Architecture:** This batch stacks on `spec/p4-multi-currency` (the current branch), whose `Quote`/`Transfer` already carry `sourceCurrency`/`amountSource`/`feeSource` and whose `send_approve_picker` already renders source-currency amounts — so A1's FX/source-currency lines drop into the existing render path. It depends only on already-present symbols: the `Quote` shape (`fxRate`/`amountInr`/`deliveryEstimate`/`sourceCurrency`/`feeSource`/`feeUsd`/`amountSource`, `types.ts:14-25`, populated by `quote()` `fx.ts:61-72`), the `Transfer` shape (`id`/`payoutMethod`/`amountInr`/`recipientName`/`totalChargeUsd`, `types.ts`), `PayoutMethod = 'upi' | 'bank'` (`types.ts:1`), the funding-fee constants in `quote()` (`bank_transfer → 1.99`, `debit_card → 2.99`, `credit_card → round2(2.99 + 0.03·amountUsd)`, `fx.ts:40-48`), `normalizePhone`/`isValidPhone` (`phone.ts:1-7`), `sendInteractive` + `approveButtonId`/`cancelButtonId` (`whatsapp.ts`/`whatsapp-buttons.ts`), the `executeTool` switch (`tools.ts:358-393`), and the `bot-content-guard` harness — none in flight in this batch.

```
OLD (sequential, late phone-validation, split quote)        NEW (Bundle B sequencing + Bundle A merged quote)
─────────────────────────────────────────────────          ──────────────────────────────────────────────────
1. "How much?"                                              1. "How much, and how do you want to pay
2. "How do you want to pay?"          ── B1 merge ──▶           (credit/debit card or bank transfer)?"
3. "Recipient name?"                                           → get_quote(amount_usd, funding_method)  [schema unchanged]
4. "Their WhatsApp number?"                                 2. "Who's it going to — name + their WhatsApp
5. "UPI or bank?"                     ── B2 merge ──▶           number (with country code)?"
6. "UPI ID / account + IFSC?"                                  → validate_phone(number)  ◀── B3 early-catch
   (phone only checked at create_transfer ── B3 ──▶            if !valid: re-ask the number NOW, loop here
    time, as a late tool error)                             3. "Pay out to their UPI ID, or bank account + IFSC?"
                                                               (bot parses upi vs bank+ifsc from one reply)
7. send_approve_picker →                                    4. send_approve_picker →  [A1 enriched single message]
   "Sending $X to <name>.                                      ┌──────────────────────────────────────────┐
    Fee $Y → ₹Z."   [+ Approve/Cancel]                         │ Sending $X to <name>.                      │
   (no FX rate, no ETA, no destination)                        │ first transfer free — you save $Y   [A2]   │
                                                               │ Rate: 1 USD = ₹R                           │
                                                               │ They get ₹Z within 10 minutes.            │
                                                               │ To: UPI mom@okhdfc  (or bank ****6789…)    │
                                                               │ Rate locked ~10 min.                       │
                                                               └──────────────────────────────────────────┘
                                                                                  [ Approve & pay ] [ Cancel ]
8. tap Approve → create_transfer(draftId)  ── UNCHANGED ──▶  5. tap Approve → create_transfer(draftId)  [identical]
9. pay page → stage1 "…Sending ₹Z…"   ── A3 ──▶             6. stage1: "✅ Payment received — $X charged.
                                                               <name> will get ₹Z within ~10 minutes.
                                                               Transfer ID: <id>"
10. delivered → stage2 "🎉 ₹Z delivered…" ── A4 ──▶         7. stage2: "🎉 ₹Z delivered to <name> via UPI.
                                                               Transfer ID: <id>. Thanks for using SendHome!"
```

`validate_phone` insertion (B3) — pure, no `ToolContext`, no Redis:

```
runAgentTurn → model emits tool_call validate_phone(phone) → executeTool('validate_phone', args)
  └─ validatePhoneTool(args)                       src/lib/tools.ts (NEW, read-only)
       normalized = normalizePhone(args.phone)     src/lib/phone.ts (existing)
       valid      = isValidPhone(normalized)        src/lib/phone.ts (existing)
       return valid ? { valid:true, normalized }
                    : { valid:false, normalized, error: '…send it with country code, e.g. 919876543210.' }
  └─ NO ctx access — pure wrapper, no Redis, no writes
```

Enriched picker (A1/A2) — only the `summary` string changes; `createDraft`, the three cap re-checks, the button IDs, and the return shape are untouched:

```
q = quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount)        ── UNCHANGED (tools.ts:812)
draftId = await ctx.draftStore.createDraft({ … quote:{ feeUsd, fxRate, amountInr } }) ── UNCHANGED (tools.ts:813-832)
summary = buildApproveSummary(q, recipientName, payoutMethod, payoutDestination)      ◀── NEW pure helper (replaces 833-837)
await sendInteractive(ctx.phone, summary, [approveButtonId(draftId), cancelButtonId(draftId)]) ── buttons UNCHANGED (838-841)
return { sent: true, draft_id: draftId }                                              ── UNCHANGED (842)
```

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis, `Intl.NumberFormat` (source-currency amount rendering — the same renderer already used in `sendApprovePickerTool`'s `fmt` at `tools.ts:833-834`).

**Spec:** `../specs/2026-05-29-whatsapp-ux-clarity-flow-design.md`

**Branch:** `spec/whatsapp-ux-clarity-flow` (branch off the current `spec/p4-multi-currency` — the `Quote` fields `fxRate`/`amountInr`/`deliveryEstimate`/`sourceCurrency`/`feeSource`/`feeUsd`/`amountSource`, the `Transfer` fields `id`/`payoutMethod`/`amountInr`/`recipientName`/`totalChargeUsd`, `PayoutMethod`, the `quote()` fee constants, `normalizePhone`/`isValidPhone`, `sendInteractive` + the approve/cancel button IDs, the `executeTool` switch, and the `bot-content-guard` harness are all already present on this working base).

**Test count delta:** from **573** (current suite, 60 files). `validate_phone` (~5) + `buildApproveSummary`/enriched picker (~5) + first-free framing (~2) + `wouldBeFeeUsd` in `fx.test.ts` (~2) + payment copy adds (~3) + prompt-flow asserts (~4) ≈ **+~21 → ~594**, with the existing correctness/cap/draft/fx tests **unmodified and green** and the old-copy assertions in `payment.test.ts` / `tools.test.ts` / `prompt.test.ts` **updated** (intentional) rather than added.

**Patterns to reuse (do not reinvent):**
- **Source-currency `Intl.NumberFormat` renderer:** `sendApprovePickerTool`'s `fmt` (`tools.ts:833-834`) — `new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n)`. `buildApproveSummary` lifts this exact helper, so a GBP-source quote renders `1 GBP = ₹R` correctly.
- **Single ETA source of truth:** `q.deliveryEstimate` is `'within 10 minutes'` (`fx.ts:67`). A1 shows it verbatim; A3 reuses the same "within ~10 minutes" phrasing — never a second hard-coded time string.
- **Pure, exported, unit-testable helper next to the engine:** `quote()` in `fx.ts` is pure and TDD'd. The A2 "save $X" figure comes from a tiny **exported pure** `wouldBeFeeUsd(amountUsd, fundingMethod)` co-located with `quote()`, single-sourcing the fee schedule (`fx.ts:40-48`); `quote()`'s body is untouched.
- **Read-only tool that takes only `args`:** `validate_phone` follows the pure shape — no `ToolContext`, no `ctx.store`/`ctx.draftStore` — so it needs no `fakeRedis()` and can never write.
- **Defense-in-depth phone validation stays:** `createTransferTool` (`tools.ts:509-510`) and `sendApprovePickerTool` (`tools.ts:780-786`) keep their `normalizePhone`/`isValidPhone` guards — `validate_phone` is a UX early-catch, not their replacement. Both call the **same** `phone.ts` functions so the early-catch and the gate agree on every boundary case.
- **Tool-schema definition shape:** new `validate_phone` schema mirrors the existing `toolSchemas` entries (`tools.ts:39-72`); `executeTool` gains one `case` beside the others (`tools.ts:363-389`).
- **Conventions:** TDD per task; `fakeRedis()` where a store is needed (`buildApproveSummary`/`validate_phone`/`wouldBeFeeUsd` need none); no `as any`; `??` (never `||`) for fallbacks; the bot stays partner-/provider-/PII-blind (`bot-content-guard` green); **one atomic commit per task**; commit prefix `feat(ux):`.

**CI reminders:**
- `main` branch protection requires the `ci / ci` status check; no direct pushes. Open a PR; Vercel auto-deploys on merge; Playwright smoke runs against prod.
- The full local gate is `npm run typecheck && npm run lint && npx vitest run && npm run build`.
- The correctness/cap/draft/fx tests must stay green **and unmodified** — if `fx.test.ts`, the `send_approve_picker — cap enforcement` test (`tools.test.ts:778-800`), or any draft test needs editing to pass, a copy/sequencing change has leaked into the engine; fix the code, not the test.
- The copy/flow test edits in `payment.test.ts` / `tools.test.ts` / `prompt.test.ts` are **intentional** and called out per-task.
- GitGuardian may red on a known env-var-name false positive; `ci` is the required check.

---

## File Map

**New files:** none. (No new module — all new code lands in existing files: a `validate_phone` schema + handler and a `buildApproveSummary`/`maskDestination` helper in `tools.ts`, and an exported `wouldBeFeeUsd` in `fx.ts`.)

**Modified files:**
- `src/lib/fx.ts` — add **exported pure** `wouldBeFeeUsd(amountUsd, fundingMethod): number` co-located with `quote()`, single-sourcing the fee schedule for A2's "save $X". `quote()` body **unchanged** (A2).
- `src/lib/tools.ts` — add the `validate_phone` schema to `toolSchemas`, the `validatePhoneTool(args)` handler, and the `executeTool` `case` (B3); add exported `buildApproveSummary` + `maskDestination` and call them in `sendApprovePickerTool` (A1/A2). Draft/cap/button/return logic **unchanged**.
- `src/lib/payment.ts` — stage-1 (A3) and stage-2 (A4) `senderMessages` copy; uses existing `Transfer` fields only (`totalChargeUsd`/`recipientName`/`amountInr`/`id`/`payoutMethod`).
- `src/lib/prompt.ts` — amount+funding-together (B1), two-ask recipient + immediate `validate_phone` (B2/B3), confirmation-surfacing + `DESTINATION & SENDING` reword (A5).
- `tests/fx.test.ts` — add `wouldBeFeeUsd` cases (~2); existing `quote`/`sourceForInr`/MIN-MAX/first-free cases **unmodified**.
- `tests/tools.test.ts` — roster 13→14 (intentional); add `validate_phone` + `buildApproveSummary` cases; the `send_approve_picker — cap enforcement` test (`778-800`) **unchanged**.
- `tests/payment.test.ts` — update stage-1/stage-2 copy assertions (Transfer ID, `via UPI`/`via bank`) (intentional).
- `tests/prompt.test.ts` — add B1/B2/B3/A5 flow + reword assertions; existing card/EDD/dormancy/tool-naming assertions kept.
- `tests/bot-content-guard.test.ts` — stays green, no rewrite (`prompt.ts`/`tools.ts` already scanned).

> Deliberately **not** modified: `quote()` / `sourceForInr()` / `MIN_USD` / `MAX_USD` bodies in `fx.ts`; `createTransfer()` (`transfer-create.ts`); `evaluateCap`/`evaluateEdd`; `draftStore.createDraft`/`consumeDraft`; the `create_transfer`/`send_approve_picker` server-side phone guards; `types.ts` (no `Quote`/`Transfer`/`TransferStatus` field); any Redis key, route, or server action; `recipientTemplateParams` (`payment.ts:77-82`, the WhatsApp template path).

---

## Task 1: `validate_phone` tool — read-only, TDD'd

**Goal:** Add a new read-only tool: `validate_phone(phone)` runs the existing `normalizePhone`/`isValidPhone` (`phone.ts:1-7`) and returns `{ valid, normalized, error? }`. **No `ToolContext`, no Redis, no writes** — a pure wrapper called as `validatePhoneTool(args)`. The create-time guards stay (defense in depth). Smallest task, no dependencies — first.

**Files:**
- Modify: `src/lib/tools.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Update the roster test + add `validate_phone` cases (intentional roster change)**

In `tests/tools.test.ts`, change the `exposes all thirteen tools` test (`57-74`) to **fourteen**, inserting `'validate_phone'` in the sorted array (alphabetically after `update_recipient_phone`? — no: sort places it between `update_recipient_phone` and the end; verify with the sorted list — `validate_phone` sorts **after** `update_recipient_phone`). Rename the `it(...)` title to `'exposes all fourteen tools'`:

```ts
it('exposes all fourteen tools', () => {
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
    'send_approve_picker',
    'send_recipient_picker',
    'update_recipient_phone',
    'validate_phone',
  ]);
});
```

Then add a new `describe` (no `fakeRedis` — the handler is pure; import `executeTool` which is already imported in this file):

```ts
describe('validate_phone — read-only phone early-catch', () => {
  const call = (phone: unknown) =>
    executeTool('validate_phone', { phone }, {} as never); // ctx is never touched

  it('a clean 919876543210 → { valid: true, normalized }', async () => {
    expect(await call('919876543210')).toEqual({ valid: true, normalized: '919876543210' });
  });
  it('a formatted "+91 98765 43210" → valid, normalized digits-only', async () => {
    expect(await call('+91 98765 43210')).toEqual({ valid: true, normalized: '919876543210' });
  });
  it('too-short "12345" → valid:false with a re-ask error', async () => {
    const r = await call('12345') as { valid: boolean; error: string };
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/valid/i);
  });
  it('junk/empty → valid:false', async () => {
    expect((await call('') as { valid: boolean }).valid).toBe(false);
    expect((await call('abc') as { valid: boolean }).valid).toBe(false);
  });
  it('performs no Redis I/O — runs with a bare ctx and still returns', async () => {
    // {} as never proves the handler reads nothing off ctx
    expect((await call('919876543210') as { valid: boolean }).valid).toBe(true);
  });
});
```

> `executeTool('validate_phone', …)` is dispatched through the switch but the handler ignores `ctx`; passing `{} as never` is the executable proof it touches no store. `as never` is on the **test-only** ctx stub, not on production code.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — the roster expects 14 but only 13 exist; `executeTool('validate_phone', …)` returns `{ error: 'Unknown tool: validate_phone' }`.

- [ ] **Step 3: Implement the schema, handler, and switch case in `src/lib/tools.ts`**

Add the schema as the final entry in `toolSchemas` (after the last `}` before `tools.ts:73`-style close — append to the array):

```ts
  {
    type: 'function',
    function: {
      name: 'validate_phone',
      description:
        "Check that a recipient WhatsApp number is well-formed (digits only, with country code, 10–15 digits). Call this immediately after the user gives the recipient's number, BEFORE asking about payout. Returns { valid, normalized, error? }.",
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: "The recipient's WhatsApp number as the user typed it, e.g. '+91 98765 43210'.",
          },
        },
        required: ['phone'],
      },
    },
  },
```

Add the handler (pure — no `ctx`; `normalizePhone`/`isValidPhone` are already imported at `tools.ts:6`):

```ts
function validatePhoneTool(args: Record<string, unknown>): ToolResult {
  const normalized = normalizePhone(args.phone);
  if (!isValidPhone(normalized)) {
    return {
      valid: false,
      normalized,
      error:
        "That doesn't look like a valid WhatsApp number — please send it with country code, e.g. 919876543210.",
    };
  }
  return { valid: true, normalized };
}
```

Add the `case` in `executeTool` (beside the others, `tools.ts:388`-area, before `default`):

```ts
    case 'validate_phone':
      return validatePhoneTool(args); // pure — no ctx
```

> Confirm `ToolResult` admits `{ valid, normalized, error? }` — if it is a closed shape, widen it minimally (e.g. it is `Record<string, unknown>`-like or a union the other tools already return through, such as `{ sent: true }` / `{ error: string }`); check the existing return shapes before editing and prefer reusing the existing index-signature type rather than adding a one-off interface. No `as any`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS — roster is 14; the 5 `validate_phone` cases green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(ux): add read-only validate_phone tool for early number-catch"
```

---

## Task 2: `wouldBeFeeUsd` helper in `fx.ts` — pure fee-schedule single-source for A2

**Goal:** A2's "first transfer free — you save $X" needs the fee the customer *would* pay on a repeat send, but `quote()` short-circuits `feeUsd = 0` on a first transfer (`fx.ts:36-37`), so `q.feeSource` is 0 and can't supply the figure. Add an **exported pure** `wouldBeFeeUsd(amountUsd, fundingMethod): number` co-located with `quote()`, single-sourcing the fee schedule (`fx.ts:40-48`). `quote()`'s body is **unchanged** — this is a new sibling function only.

**Files:**
- Modify: `src/lib/fx.ts`
- Test: `tests/fx.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/fx.test.ts` (alongside the existing `quote` cases — import `wouldBeFeeUsd` from `@/lib/fx`):

```ts
describe('wouldBeFeeUsd — the repeat-send fee (for first-transfer-free framing)', () => {
  it('bank_transfer → 1.99, debit_card → 2.99', () => {
    expect(wouldBeFeeUsd(500, 'bank_transfer')).toBe(1.99);
    expect(wouldBeFeeUsd(500, 'debit_card')).toBe(2.99);
  });
  it('credit_card → 2.99 + 3% of the amount (matches quote()\'s schedule)', () => {
    expect(wouldBeFeeUsd(500, 'credit_card')).toBe(17.99); // round2(2.99 + 0.03*500)
    expect(wouldBeFeeUsd(100, 'credit_card')).toBe(5.99);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/fx.test.ts`
Expected: FAIL — `wouldBeFeeUsd` is not exported.

- [ ] **Step 3: Implement `wouldBeFeeUsd` in `src/lib/fx.ts`**

Add directly after `quote()` (after `fx.ts:73`), reusing the same `round2` and `FundingMethod` already in scope:

```ts
/**
 * The fee the sender WOULD pay on a repeat send with this funding method, in USD.
 * Single-sources the same fee schedule quote() uses (bank 1.99 / debit 2.99 /
 * credit 2.99 + 3%), so the "first transfer free — you save $X" framing can show
 * an honest figure without quote() (which returns 0 on a first transfer) supplying
 * it. quote()'s body is unchanged; this is a pure sibling for presentation only.
 */
export function wouldBeFeeUsd(amountUsd: number, fundingMethod: FundingMethod): number {
  switch (fundingMethod) {
    case 'bank_transfer':
      return 1.99;
    case 'debit_card':
      return 2.99;
    case 'credit_card':
      return round2(2.99 + 0.03 * amountUsd);
  }
}
```

> Exhaustive `switch` over the `FundingMethod` union — no `default` needed; if a new method is added the compiler flags this. The constants are duplicated by intent kept *deliberately identical* to `fx.ts:40-48`; the two tests above lock them together so they cannot silently drift. (If review prefers extracting a shared `FEE_TABLE`, that is a refactor of `quote()` and is out of scope for this UX batch — keep `quote()` byte-for-byte unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fx.test.ts`
Expected: PASS — the 2 new cases green; every existing `quote`/`sourceForInr`/MIN-MAX/first-free case unmodified and green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fx.ts tests/fx.test.ts
git commit -m "feat(ux): export pure wouldBeFeeUsd for first-transfer-free framing (quote unchanged)"
```

---

## Task 3: Enriched single approve message — `buildApproveSummary` + `maskDestination` (A1/A2)

**Goal:** Replace the two-line `summary` in `sendApprovePickerTool` (`tools.ts:833-837`) with a single enriched body rendering amount, fee (first-free framing when `q.feeUsd === 0`), FX rate (`1 <CCY> = ₹R` from `q.fxRate`), INR payout (`q.amountInr`), delivery ETA (`q.deliveryEstimate`), the payout destination (UPI shown, bank masked to last-4), and a "Rate locked ~10 min." line — via a new **exported pure** `buildApproveSummary`. The `createDraft` call, the three cap re-checks, the `sendInteractive` buttons (`approveButtonId`/`cancelButtonId`), and the `{ sent, draft_id }` return are **byte-for-byte unchanged**.

**Files:**
- Modify: `src/lib/tools.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests (unit, no Redis — `buildApproveSummary` is pure)**

Add to `tests/tools.test.ts` (import `buildApproveSummary` from `@/lib/tools`; build a `Quote` literal — all fields are on `types.ts:14-25`):

```ts
import { buildApproveSummary } from '@/lib/tools';
import type { Quote } from '@/lib/types';

const baseQuote = (over: Partial<Quote> = {}): Quote => ({
  amountUsd: 500, feeUsd: 1.99, totalChargeUsd: 501.99, fxRate: 83, amountInr: 41500,
  deliveryEstimate: 'within 10 minutes', sourceCurrency: 'USD', amountSource: 500,
  feeSource: 1.99, totalChargeSource: 501.99, ...over,
});

describe('buildApproveSummary — enriched single approve body (A1/A2)', () => {
  it('renders FX rate, ETA, masked bank destination, and the rate-lock line', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '123456789 HDFC0001234');
    expect(s).toContain('1 USD = ₹83');
    expect(s).toContain('₹41,500');
    expect(s).toContain('within 10 minutes');
    expect(s).toContain('bank a/c ****6789');
    expect(s).toContain('IFSC HDFC0001234');
    expect(s).toContain('Rate locked ~10 min');
  });
  it('shows a UPI destination in full', () => {
    const s = buildApproveSummary(baseQuote({ payoutMethod: undefined } as never), 'Mom', 'upi', 'mom@okhdfc');
    expect(s).toContain('UPI mom@okhdfc');
  });
  it('first transfer (feeUsd 0) → "first transfer free" framing, NEVER "Fee $0.00"', () => {
    const s = buildApproveSummary(baseQuote({ feeUsd: 0, feeSource: 0 }), 'Mom', 'upi', 'mom@okhdfc');
    expect(s.toLowerCase()).toContain('first transfer free');
    expect(s).not.toContain('Fee $0.00');
  });
  it('a repeat transfer renders a concrete Fee line', () => {
    const s = buildApproveSummary(baseQuote({ feeUsd: 1.99, feeSource: 1.99 }), 'Mom', 'upi', 'mom@okhdfc');
    expect(s).toContain('Fee $1.99');
  });
  it('a GBP-source quote renders "1 GBP = ₹"', () => {
    const s = buildApproveSummary(baseQuote({ sourceCurrency: 'GBP', amountSource: 400, feeSource: 1.6 }), 'Mom', 'upi', 'mom@okhdfc');
    expect(s).toContain('1 GBP = ₹');
    expect(s).toContain('£');
  });
});
```

> The existing `send_approve_picker — cap enforcement` test (`tools.test.ts:778-800`) is **NOT touched** — it asserts an over-cap returns `error` with `interactiveSent === false`, which the unchanged cap re-check still produces. Confirm it stays green after this task.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — `buildApproveSummary` is not exported.

- [ ] **Step 3: Implement `maskDestination` + `buildApproveSummary` and wire them into `sendApprovePickerTool`**

Add the two helpers (export `buildApproveSummary`; `PayoutMethod`/`Quote`/`wouldBeFeeUsd` are importable — confirm imports). The "save $X" figure uses `wouldBeFeeUsd(q.amountUsd, fundingMethod)` from Task 2, converted to source currency via the same rate ratio the quote uses (`q.feeSource`'s rate = `feeUsd / feeSource` is undefined at 0; instead derive source via `amountSource / amountUsd`):

```ts
import { quote, QuoteError, wouldBeFeeUsd } from './fx'; // extend the existing fx import
import type { Quote /*, …existing*/ } from './types';

function maskDestination(method: PayoutMethod, dest: string): string {
  if (method === 'upi') return `UPI ${dest}`;
  // bank: "<acct> <ifsc>" or "<acct>, <ifsc>" → mask all but last 4 of the account
  const [acct, ...rest] = dest.split(/[,\s]+/).filter(Boolean);
  const last4 = (acct ?? '').slice(-4);
  const ifsc = rest.join(' ');
  return `bank a/c ****${last4}${ifsc ? `, IFSC ${ifsc}` : ''}`;
}

export function buildApproveSummary(
  q: Quote,
  recipientName: string,
  payoutMethod: PayoutMethod,
  payoutDestination: string,
): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n);
  const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  // A2: first-transfer-free framing when the quote fee is 0. The "save" figure is
  // the repeat-send fee in source currency: wouldBeFeeUsd × (amountSource/amountUsd).
  let feeLine: string;
  if (q.feeUsd === 0) {
    const ratio = q.amountUsd > 0 ? q.amountSource / q.amountUsd : 1; // USD→source
    const wouldBeSource = Math.round(wouldBeFeeUsdForLine(q) * ratio * 100) / 100;
    feeLine = `first transfer free — you save ${fmt(wouldBeSource)}`;
  } else {
    feeLine = `Fee ${fmt(q.feeSource)}`;
  }
  return [
    `Sending ${fmt(q.amountSource)} to ${recipientName}.`,
    feeLine,
    `Rate: 1 ${q.sourceCurrency} = ${inr(q.fxRate)}`,
    `They get ${inr(q.amountInr)} ${q.deliveryEstimate}.`,
    `To: ${maskDestination(payoutMethod, payoutDestination)}`,
    `Rate locked ~10 min.`,
  ].join('\n');
}
```

> **Funding-method threading note.** `buildApproveSummary` does not receive `fundingMethod` in the signature the spec locks. To get the would-be fee, pass `fundingMethod` to it as well (extend the signature to `buildApproveSummary(q, recipientName, payoutMethod, payoutDestination, fundingMethod)`) and call `wouldBeFeeUsd(q.amountUsd, fundingMethod)` directly — drop the `wouldBeFeeUsdForLine` placeholder above. Update the Step-1 test calls to pass `'bank_transfer'` as the trailing arg, and assert the first-free case with `feeUsd: 0` + `fundingMethod: 'bank_transfer'` shows "you save $1.99". (The `fundingMethod` is already in scope at the call site — `tools.ts:787`.) This keeps the figure honest and single-sourced; if review prefers zero math risk, fall back to a figure-less `first transfer free 🎉` and drop the `wouldBeFeeUsd` dependency.

Wire it into `sendApprovePickerTool`, replacing `tools.ts:833-837` (the `fmt`/`summary` block) — leave `createDraft` (`813-832`) and the `sendInteractive` buttons (`838-841`) and the `return` (`842`) untouched:

```ts
    const summary = buildApproveSummary(
      q,
      String(args.recipient_name),
      args.payout_method as PayoutMethod,
      String(args.payout_destination),
      fundingMethod,
    );
    await sendInteractive(ctx.phone, summary, [
      { id: approveButtonId(draftId), title: 'Approve & pay' },
      { id: cancelButtonId(draftId), title: 'Cancel' },
    ]);
    return { sent: true, draft_id: draftId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS — the 5 `buildApproveSummary` cases green; the `send_approve_picker — cap enforcement` test (`778-800`) **unchanged** and green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(ux): enriched single approve message (FX/ETA/destination + first-free framing)"
```

---

## Task 4: Concrete stage-1 + stage-2 payment copy with Transfer ID (A3/A4)

**Goal:** Replace the trailing-`…` stage-1 string (`payment.ts:36`) with a terminated sentence + Transfer ID, and add the payout-method label + Transfer ID to the stage-2 delivered string (`payment.ts:71`). Both use fields already on `Transfer` (`totalChargeUsd`/`recipientName`/`amountInr`/`id`/`payoutMethod`) — no new field, no new arg. The idempotency / cancelled-not-delivered / missing-transfer logic and `recipientTemplateParams` are **unchanged**. The copy assertions in `payment.test.ts` are updated **intentionally**.

**Files:**
- Modify: `src/lib/payment.ts`
- Test: `tests/payment.test.ts`

- [ ] **Step 1: Update the copy assertions (intentional) + add Transfer-ID / via-method asserts**

In `tests/payment.test.ts`, the stage-1 block currently asserts `toContain('$500.00')` / `'42,600'` / `'Mom'` (`52-54`) — **keep those**, and **add**:

```ts
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
    expect(result.senderMessages[0]).not.toContain('…'); // no trailing ellipsis
    expect(result.senderMessages[0]).toContain('within ~10 minutes');
```

In the stage-2 block (keep `toContain('42,600')` / `'Mom'`, `101-102`) **add**:

```ts
    expect(result.senderMessages[0]).toContain('via UPI');       // default fixture payoutMethod 'upi'
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
```

And in the existing bank-payout fixture test (`payoutMethod: 'bank'`, around `163`) assert `toContain('via bank')`.

> These are **intentional copy updates** — the old strings (`'Sending ₹… to Mom…'`, `'delivered to Mom. Thanks'`) are being replaced. The `$500.00` / `42,600` / `Mom` substrings survive by design, so most existing asserts stay; only the trailing-`…` shape and the new ID/method substrings are new.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/payment.test.ts`
Expected: FAIL — the new `Transfer ID` / `via UPI` / `within ~10 minutes` substrings are absent from the current copy.

- [ ] **Step 3: Implement the copy in `src/lib/payment.ts`**

Stage-1 — replace `payment.ts:35-37`:

```ts
  const senderMessages = [
    `✅ Payment received — $${updated.totalChargeUsd.toFixed(2)} charged. ${updated.recipientName} will get ₹${inr(updated.amountInr)} within ~10 minutes. Transfer ID: ${updated.id}`,
  ];
```

Stage-2 — replace `payment.ts:70-72`:

```ts
  const via = updated.payoutMethod === 'upi' ? 'UPI' : 'bank';
  const senderMessages = [
    `🎉 ₹${inr(updated.amountInr)} delivered to ${updated.recipientName} via ${via}. Transfer ID: ${updated.id}. Thanks for using SendHome!`,
  ];
```

> Uses only fields already on `Transfer` (`payment.ts` already destructures `updated`); `inr()` (`payment.ts:9-11`) is unchanged; `recipientTemplateParams` (`77-82`, the template path) is untouched. "within ~10 minutes" mirrors the A1 ETA wording so the two surfaces agree.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payment.test.ts`
Expected: PASS — new asserts green; idempotency / cancelled-not-delivered / missing-transfer / `recipientTemplateParams` cases unchanged and green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payment.ts tests/payment.test.ts
git commit -m "feat(ux): concrete stage-1/stage-2 payment copy with Transfer ID + payout method"
```

---

## Task 5: Prompt — faster first send + confirmation-surfacing + destination reword (B1/B2/B3/A5)

**Goal:** Reword `src/lib/prompt.ts` for the new flow: ask amount + funding method together (B1); collect the recipient in two asks with an immediate `validate_phone` call after the number (B2/B3); instruct surfacing FX rate + ETA + payout destination in confirmations and add a `DESTINATION & SENDING` block that distinguishes "pays out only in India" from "you can send from the US / a listed currency" (A5). `get_quote`'s schema is **unchanged** (`required: ['amount_usd', 'funding_method']`, `tools.ts:70`). Done last, after B1/B2 wording settles. Prompt-flow assertions in `prompt.test.ts` are **added intentionally**; existing card/EDD/dormancy/tool-naming assertions are kept.

**Files:**
- Modify: `src/lib/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing assertions (intentional flow + reword)**

Add to `tests/prompt.test.ts` (it asserts on the exported `SYSTEM_PROMPT` string):

```ts
describe('whatsapp-ux: faster first send + clearer confirmation + destination reword', () => {
  it('B1: asks amount + funding method together in one turn', () => {
    expect(SYSTEM_PROMPT).toMatch(/how do you want to pay/i);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('together'); // the combined-ask instruction
  });
  it('B2/B3: two-ask recipient + immediate validate_phone call', () => {
    expect(SYSTEM_PROMPT).toContain('validate_phone');
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/name and (their )?whatsapp number/);
  });
  it('A5: surfaces FX rate + ETA + payout destination in confirmations', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('delivery time');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('payout destination');
  });
  it('A5: distinguishes pay-out from send-from (no blanket send-block)', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('pays out only in india');
    expect(SYSTEM_PROMPT).toContain('[SEND CURRENCIES');
    // the old blanket "sending money to India" send-blocking promise is gone
    expect(SYSTEM_PROMPT).not.toContain('Do not promise anything beyond sending money to India');
  });
});
```

> The last assertion is the **intentional** removal of the old line (`prompt.ts:35`). Keep every existing `prompt.test.ts` assertion (tool names, EDD, dormancy, card-detail refusal) — if one breaks, the reword over-reached; narrow the edit.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — `validate_phone`, "together", "pays out only in India", "[SEND CURRENCIES" surfacing absent; the old line still present.

- [ ] **Step 3: Reword `src/lib/prompt.ts`**

**B1 — `WHAT TO COLLECT` head (replace `prompt.ts:9`-area through item 2).** Keep the same data points; instruct the combined first ask:

```
WHAT TO COLLECT
Ask for the amount and the funding method TOGETHER in your first question
("How much would you like to send, and how do you want to pay — credit card,
debit card, or bank transfer?"), then call get_quote (it needs both):
1. The amount to send, in US dollars (or the listed send currency).
2. How the SENDER wants to pay — their funding method:
   - "credit card" → credit_card (fee: flat $2.99 + 3% surcharge; first transfer free)
   - "debit card" → debit_card (fee: $2.99; first transfer free)
   - "bank transfer" → bank_transfer (fee: $1.99; first transfer free)
```

**B2/B3 — recipient in two asks (replace items 3–6, `prompt.ts:15-18`):**

```
Collect the recipient in TWO questions, not four:
- Ask 1 — name + number: "Who are you sending to? Send me their name and their
  WhatsApp number in India with country code (e.g. 919876543210)." Parse both from
  the one reply. The MOMENT you have the number, call validate_phone with it. If it
  returns valid: false, do NOT proceed — apologize briefly and ask for the number
  again, right then, until it is valid. Only after a valid number move to Ask 2.
  (This is in addition to the system's own check at send time.)
- Ask 2 — payout: "How should they receive it — a UPI ID, or a bank account number
  with IFSC code?" Parse the method (upi vs bank) and the destination from the one reply.
```

**A5 (i) — confirmation surfacing (replace `FLOW` line `prompt.ts:21`):**

```
- Once you know the amount and the sender's funding method, call get_quote, then
  confirm back the fee, the exchange rate (e.g. "1 USD = ₹X"), the rupee amount the
  recipient will receive, the delivery time, and the payout destination. The approval
  card (send_approve_picker) already shows all of these — keep any free-text
  confirmation consistent with it and never invent a rate, fee, or ETA that get_quote
  did not return.
```

**A5 (ii) — destination reword (replace `prompt.ts:35`, the `Do not promise anything beyond sending money to India.` line, with a block):**

```
DESTINATION & SENDING
- SendHome pays out only in India (INR), to a UPI ID or an Indian bank account. If a
  user asks to send money to any OTHER country as the destination, explain warmly that
  right now we only deliver to India — do NOT offer other destinations.
- The SEND side is separate: by default people send from the United States in US
  dollars. If the system injects a "[SEND CURRENCIES: ...]" note this turn, the user
  may send from one of those listed currencies. Never tell a user they "can't send"
  because of where they are — only the payout destination is limited to India. (E.g.
  someone messaging from the UAE can still send; we just pay out in India.)
- Do not promise anything beyond paying out to India.
```

> `bot-content-guard`: this block names only public geography (US/India/UAE) and the already-guarded `[SEND CURRENCIES]` token (same phrasing as `prompt.ts:99-100`); no `partner`/`corridor`/`watchlist`/`sanctions`/PII token. Leave the rest of the prompt (`RULES`, `RECURRING`, `GREETING`, `QUOTE CONFIRMATION`, `CURRENCY`, `EDD`) intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS — the 4 new asserts green; existing tool-name/EDD/dormancy/card-refusal asserts unchanged and green.

- [ ] **Step 5: Confirm `bot-content-guard` stays green (no rewrite)**

Run: `npx vitest run tests/bot-content-guard.test.ts`
Expected: PASS unmodified — `prompt.ts`/`tools.ts` are already in the P2/P5/KYC scan lists; the new copy and the new tool's `description`/`error` strings clear every forbidden set.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(ux): prompt asks amount+funding together, two-ask recipient + validate_phone, pay-out/send-from reword"
```

---

## Task 6: Wrap — full verification, PR, post-merge runbook

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (~594 tests). The correctness/cap/draft/fx tests (`fx.test.ts` `quote`/`sourceForInr`/MIN-MAX/first-free, the `send_approve_picker — cap enforcement` test, the draft create/consume tests, the receive-first `amount_inr` branch) staying green **unmodified** is the executable proof the engine is untouched; `bot-content-guard` staying green is the proof the new copy and tool leak nothing.

- [ ] **Step 2: Confirm the transfer-correctness invariant by hand**

- `git diff main -- src/lib/transfer-create.ts src/lib/types.ts` → **empty** (no `createTransfer` change, no `Quote`/`Transfer`/`TransferStatus` field).
- `git diff main -- src/lib/fx.ts` shows **only** the new exported `wouldBeFeeUsd` — `quote()`/`sourceForInr()`/`MIN_USD`/`MAX_USD` bodies are unchanged (eyeball the hunk: the `quote()` function body has zero `-`/`+` lines).
- In `tools.ts`, the `sendApprovePickerTool` diff touches **only** the `summary` construction (`833-837`) — `createDraft` (`813-832`), the cap re-check block (`792-809`), the `sendInteractive` button IDs (`838-841`), and the `return { sent, draft_id }` (`842`) are unchanged; the `createTransferTool`/`sendApprovePickerTool` `normalizePhone`/`isValidPhone` guards (`509-510`, `780-786`) are unchanged.
- `validate_phone` is read-only: grep `validatePhoneTool` for `ctx`/`store`/`save`/`set`/`createDraft` → **none**.
- `git diff --name-only main` lists **only**: `src/lib/fx.ts`, `src/lib/tools.ts`, `src/lib/payment.ts`, `src/lib/prompt.ts`, `tests/fx.test.ts`, `tests/tools.test.ts`, `tests/payment.test.ts`, `tests/prompt.test.ts`.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/whatsapp-ux-clarity-flow
gh pr create --title "feat(ux): WhatsApp clarity + faster first send (Bundles A + B)" --body "$(cat <<'EOF'
## Summary
Two findings from the live-bot test, fixed as an intentional UX batch (Bundles A + B; C + D deferred). TRANSFER-CORRECTNESS is the invariant — FX math, caps, the draft/create flow, and createTransfer() are byte-for-byte unchanged; only message COPY, question SEQUENCING, and a new read-only validate_phone tool change.

### Bundle A — quote & confirmation clarity
- `send_approve_picker` now sends ONE enriched interactive message: amount, fee (first-transfer-free framing when the quote fee is 0, never a bare "Fee $0.00"), FX rate ("1 USD = ₹X" from q.fxRate), INR payout, delivery ETA (q.deliveryEstimate — computed in fx.ts but never previously shown), the payout destination (UPI shown in full, bank account masked to last-4 + IFSC), and a "Rate locked ~10 min." line — with the unchanged [Approve & pay]/[Cancel] buttons. Body factored into a pure, exported buildApproveSummary; the draft payload, cap re-checks, button IDs, and return shape are untouched.
- The "save $X" first-free figure comes from a new exported pure wouldBeFeeUsd in fx.ts that single-sources the same fee schedule as quote() (quote() body unchanged).
- payment.ts stage-1: terminated sentence with amount charged + recipient/INR/"within ~10 minutes" + Transfer ID (no trailing "…"). stage-2: adds "via UPI"/"via bank" + Transfer ID.
- prompt.ts: instructs surfacing FX rate + ETA + payout destination in confirmations, and a new DESTINATION & SENDING block that distinguishes "pays out only in India" from "you can send from the US / a listed [SEND CURRENCIES] currency" — UAE-as-destination is still refused; a UAE sender is no longer implied to be blocked.

### Bundle B — faster first send
- Amount + funding method asked together in one turn (get_quote schema unchanged — already requires both).
- Recipient collected in TWO asks (name+number, then payout) instead of four.
- NEW read-only validate_phone tool wraps normalizePhone/isValidPhone; the bot calls it the moment it has the recipient number and re-asks on valid:false before payout. The create-time phone guards stay (defense in depth) — validate_phone is a UX early-catch, not a replacement.

## Safety invariant (executable proof)
- `git diff main -- src/lib/transfer-create.ts src/lib/types.ts` is empty (no createTransfer change, no Quote/Transfer/TransferStatus field, no Redis key).
- quote()/sourceForInr()/MIN_USD/MAX_USD bodies unchanged; fx.ts diff is only the new wouldBeFeeUsd.
- The send_approve_picker cap-enforcement test, every fx.ts test, the draft create/consume tests, and the create-time phone guards are unmodified and green.
- bot-content-guard stays green (prompt.ts/tools.ts already scanned; new copy + tool strings leak no partner/provider/PII/compliance vocabulary).
- validate_phone is pure: no ToolContext, no Redis, no writes, no new route/server action.

## Test plan
- [ ] typecheck / lint / vitest / build all green (~594 tests)
- [ ] New/updated: validate_phone (~5), buildApproveSummary incl. first-free + GBP + masked bank (~5), wouldBeFeeUsd (~2), payment stage-1/2 copy (Transfer ID + via UPI/bank), prompt flow + reword asserts (~4)
- [ ] Correctness/cap/draft/fx tests unmodified and green; copy/flow asserts in payment/tools/prompt updated intentionally

## Out of scope (deferred)
- Bundle C (funding shorthand / "same as last time" / sticky funding / text-match saved recipients / proactive re-send)
- Bundle D (code-guard check_send_limit before get_quote)
- WhatsApp Flow wiring; voice/audio; multi-partner FX presentation beyond [SEND CURRENCIES]; live rate-lock countdown
EOF
)"
```

- [ ] **Step 4: Confirm `ci / ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red on the known env-var-name false positive.)

- [ ] **Step 5: Post-merge runbook**

After merge → Vercel auto-deploys → Playwright smoke runs against prod. **No migration runs** — no schema, no Redis key, no money amount changes. Live behavior: the first send now asks amount + funding in one turn and the recipient in two asks; a bad recipient number is caught at entry by `validate_phone` (re-asked immediately) instead of as a late `create_transfer` error; the approve card shows the FX rate, ETA, payout destination, first-transfer-free framing, and a rate-lock line in one message; and the post-payment messages are concrete with a Transfer ID. The transfer engine (FX, caps, draft/create, server-side phone validation) is unchanged, so existing in-flight drafts and transfers are unaffected.

---

## Self-Review (completed by plan author)

**Spec coverage (tasks → spec sections):**
- §A1 (enriched single approve message: amount, fee, `1 <CCY> = ₹X` from `q.fxRate`, `q.amountInr`, `q.deliveryEstimate`, masked destination, "Rate locked ~10 min." + unchanged buttons/draft/return; pure `buildApproveSummary` + `maskDestination`) → **Task 3** (depends on **Task 2** for the save figure).
- §A2 (first-transfer-free framing when `q.feeUsd === 0`, never `Fee $0.00`; figure from a single-sourced `wouldBeFeeUsd`, `quote()` unchanged) → **Task 2** (helper) + **Task 3** (rendering).
- §A3 (stage-1: terminated sentence + amount charged + recipient/INR/"within ~10 minutes" + `Transfer ID`, no trailing `…`) → **Task 4**.
- §A4 (stage-2: `via UPI`/`via bank` + `Transfer ID`) → **Task 4**.
- §A5 (prompt surfaces FX/ETA/destination; `DESTINATION & SENDING` block distinguishes pay-out from send-from; UAE-destination still refused, UAE-sender not blocked) → **Task 5**.
- §B1 (amount + funding together, one turn; `get_quote` schema unchanged) → **Task 5** (prompt) — confirmed against `tools.ts:70` `required: ['amount_usd', 'funding_method']`.
- §B2 (recipient in two asks, bot parses each reply) → **Task 5**.
- §B3 (new read-only `validate_phone` wrapping `normalizePhone`/`isValidPhone`, called immediately, re-ask on `valid:false`; create-time guards untouched) → **Task 1** (tool) + **Task 5** (prompt wiring).
- §Invariant (FX math, caps, draft/create, `createTransfer`, server-side phone validation, schemas unchanged) → proven in **Task 2** (`quote()` body untouched, fx tests unmodified), **Task 3** (only `summary` changes; cap-enforcement test unchanged), **Task 6 Step 2** (empty `git diff` on `transfer-create.ts`/`types.ts`, read-only grep on `validatePhoneTool`).
- §Testing strategy (TDD; `fakeRedis()` where needed; `buildApproveSummary`/`validate_phone`/`wouldBeFeeUsd` need none; roster 13→14; payment/prompt copy updated intentionally) → **Tasks 1–5**; whole-suite gate in **Task 6**.
- §Open questions resolved: (1) "save $X" via exported `wouldBeFeeUsd` (Task 2), with figure-less `first transfer free 🎉` as the documented fallback (Task 3 note); (2) bank masking `bank a/c ****<last4>, IFSC <ifsc>`, UPI shown in full (Task 3 `maskDestination`); (3) "Rate locked ~10 min" is static reassurance, no live countdown; (4) `validate_phone` keeps the same 10–15-digit check as create-time (no India-prefix divergence).

**Placeholder scan:** No TBD/TODO. Every code step cites symbols verified this session — `sendApprovePickerTool`'s `summary` block (`tools.ts:833-837`), `createDraft` (`813-832`), cap re-check (`792-809`), buttons (`838-841`), return (`842`); the `toolSchemas` array shape (`39-72`) and `executeTool` switch (`358-393`); `normalizePhone`/`isValidPhone` (`phone.ts:1-7`); `quote()`'s fee schedule (`fx.ts:36-48`), `round2` (`fx.ts:14`), `deliveryEstimate: 'within 10 minutes'` (`fx.ts:67`); the `Quote` interface (`types.ts:14-25`) and `PayoutMethod` (`types.ts:1`); `payment.ts` stage strings (`36`, `71`), `inr()` (`9-11`), `recipientTemplateParams` (`77-82`); the prompt's `WHAT TO COLLECT`/`FLOW`/`Do not promise…` lines (`prompt.ts:9-21`, `35`) and the guarded `[SEND CURRENCIES]` phrasing (`99-100`); the roster test (`tools.test.ts:57-74`) and cap-enforcement test (`778-800`); the payment copy asserts (`payment.test.ts:52-54`, `101-102`, `163`). The rendered `1 USD = ₹83`, `₹41,500`, `bank a/c ****6789` match the `Quote` fixture and `maskDestination` logic.

**Type consistency:** `wouldBeFeeUsd(amountUsd: number, fundingMethod: FundingMethod): number` (exhaustive `switch`, no `default`); `maskDestination(method: PayoutMethod, dest: string): string`; `buildApproveSummary(q: Quote, recipientName: string, payoutMethod: PayoutMethod, payoutDestination: string, fundingMethod: FundingMethod): string` (returns the multi-line body); `validatePhoneTool(args: Record<string, unknown>): ToolResult` returning `{ valid: boolean; normalized: string; error?: string }` — widen/reuse the existing `ToolResult` index-signature shape rather than adding a one-off type (verify before editing); `executeTool` `case 'validate_phone': return validatePhoneTool(args)` (no `ctx`). No `as any` in production code (the `{} as never` ctx stub and the `as Quote`/`as never` overrides are **test-only**); `??` (never `||`) for fallbacks (`acct ?? ''`, `q.amountUsd > 0 ? … : 1`). No new `Quote`/`Transfer`/`TransferStatus` field, no new Redis key, no new route, no new server action. ✓
