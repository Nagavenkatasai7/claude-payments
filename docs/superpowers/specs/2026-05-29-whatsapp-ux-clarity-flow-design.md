# WhatsApp UX — Clarity + Faster First Send — Design

**Status:** design drafted 2026-05-29. Awaiting spec review → implementation plan. Stacks on `spec/p4-multi-currency` (current branch; P4 multi-currency fields `amountSource` / `sourceCurrency` / `feeSource` are already on every `Transfer` and every `Quote`, and `send_approve_picker` already renders source-currency amounts).

**Sub-project:** the "first send feels long and the quote is opaque" UX pass. Two findings from the live-bot test and the UX audit drive this batch:

1. **The quote is split from the approve buttons, and it hides what the customer most wants to see.** Today `send_approve_picker` (`src/lib/tools.ts`) sends one interactive message whose body is literally `` `Sending ${fmt(q.amountSource)} to ${args.recipient_name}.\nFee ${fmt(q.feeSource)} → ₹${q.amountInr.toLocaleString('en-IN')}.` `` with `[Approve & pay]` / `[Cancel]` buttons. The **FX rate** (`q.fxRate`) and the **delivery ETA** (`q.deliveryEstimate`, the string `'within 10 minutes'` from `fx.ts` — *computed on every quote and returned by `get_quote` as `delivery_estimate`, but never shown to a customer*) and the **payout destination** are all absent. A customer approving a transfer cannot see the rate they're getting, when it lands, or which UPI/bank account it's going to — the three questions a remittance customer asks first.
2. **The first send asks too many sequential questions, and a bad recipient number is caught too late.** The prompt's `WHAT TO COLLECT` list (`src/lib/prompt.ts`) is six items asked roughly one-at-a-time: amount, then funding method, then recipient name, then number, then payout method, then payout destination. The recipient phone is only validated at `create_transfer` time (`normalizePhone` + `isValidPhone` inside `createTransferTool`), so a typo'd number surfaces as a late tool error after the customer has already entered everything else. And the stage-1 / stage-2 payment messages (`src/lib/payment.ts`) trail off — `` `…Sending ₹${inr} to ${recipientName}…` `` — with no Transfer ID for the customer to reference and no clear "what happens next."

This is an **intentionally behavior-changing UX batch** — it changes bot conversation, question sequencing, and customer-visible message copy on purpose. It is **NOT** a dormant/additive change. Transfer correctness (FX math, caps, draft/create flow) is untouched; only copy, sequencing, and a new read-only `validate_phone` tool change. Tests asserting the old copy/flow are updated to the new copy (intentional).

---

## Goal

Two bundles the user picked (C + D deferred):

- **Bundle A — Quote & confirmation clarity.** Make the single approve message say everything a remittance customer needs before tapping pay: amount, fee (with first-transfer-free framing), FX rate, INR payout, delivery ETA, the payout destination, and a "rate locked ~10 min" line — merged with the existing `[Approve & pay]` / `[Cancel]` buttons into one message. Make the post-payment messages concrete (what happens next + Transfer ID + payout method). Reword the prompt so a sender abroad isn't told they "can't send."
- **Bundle B — Faster first send.** Collect amount + funding method in one turn; collect the recipient in two asks (name + number, then payout) instead of four; and add a `validate_phone` tool the bot calls the moment it has the recipient number, so a bad number is caught at entry rather than at create time.

## The invariant

> **TRANSFER-CORRECTNESS is unchanged.** `fx.ts` (`quote()`, `sourceForInr()`, `MIN_USD`/`MAX_USD`, the first-transfer-free `transferCount === 0 ⇒ feeUsd = 0` logic), every cap evaluation (`evaluateCap` / `evaluateEdd` in the three defense-in-depth sites), the draft create/consume flow (`draftStore.createDraft` / `consumeDraft`), and `createTransfer()` (`transfer-create.ts`) are **byte-for-byte unchanged**. No `Transfer` field, no `TransferStatus`, no `Quote` field, no Redis key, no schema, and no money amount changes. This batch changes only: (a) customer-visible **message copy** (the `send_approve_picker` summary string, the two `payment.ts` stage strings), (b) question **sequencing** instructions in `prompt.ts`, and (c) one **new read-only `validate_phone` tool** that wraps the existing `normalizePhone` / `isValidPhone` and performs no writes. `bot-content-guard` stays green (the new copy and the new tool leak no partner/provider/PII/compliance terms), and after the intentional copy/flow test updates the **full suite stays green** — those two facts are the executable proof that the changes are confined to UX surface and the transfer engine is untouched. This is an **intentional UX change**, not a dormant batch — the empty-note "unchanged behavior" escape hatch from the transfer-memory batch does **not** apply here; the bot's words and question order change on purpose.

## Locked design decisions (2026-05-29)

1. **One enriched approve message (A1).** `send_approve_picker` sends a single interactive message containing amount, fee, FX rate (`1 USD = ₹X` derived from `q.fxRate`), INR payout (`q.amountInr`), delivery ETA (`q.deliveryEstimate`), the payout destination (UPI ID, or `bank a/c ****NNNN, IFSC …`), and a "rate locked ~10 min" line — together with the existing `[Approve & pay]` / `[Cancel]` buttons. The quote and the approve buttons are merged into this one message (one fewer step). The draft payload and the buttons' `approveButtonId(draftId)` / `cancelButtonId(draftId)` are unchanged — **only the body string changes**.
2. **First-transfer-free framing (A2).** When `q.feeUsd === 0` (the `transferCount === 0` path in `fx.ts`), the fee line reads "first transfer free — you save $X" (where X is the fee they *would* have paid for the chosen funding method), not a bare "Fee $0.00". This is presentation-only; the fee is still 0 from `quote()`.
3. **Concrete stage-1 message + Transfer ID (A3).** `completePaymentStage1` replaces the trailing `…Sending ₹X to <recipient>…` with a clear, terminated sentence + the Transfer ID: amount charged, who gets how much and when, and `Transfer ID: <id>`.
4. **Concrete stage-2 message + Transfer ID + payout method (A4).** `completePaymentStage2` adds the Transfer ID and the payout method (`via UPI` / `via bank`) to the delivered message.
5. **Prompt surfaces FX + ETA + destination; reword the destination refusal (A5).** The prompt instructs the bot to surface FX rate, ETA, and payout destination in confirmations (so the enriched picker isn't contradicted by terse free-text fallbacks), and **rewords the India framing** to distinguish "we **pay out** to India" (the locked destination) from "you can **send from** the US (or a listed `[SEND CURRENCIES]` country)" (the send side, which is NOT blocked). UAE-as-*destination* is still refused; a UAE *sender* is not implied to be blocked.
6. **Amount + funding method together (B1).** `get_quote` already `required: ['amount_usd', 'funding_method']` — the prompt is reworded to ask both in one turn rather than amount-then-funding sequentially. No schema change.
7. **Recipient in two asks (B2).** The prompt collapses the four recipient questions into two combined asks: (i) name + WhatsApp number, then (ii) UPI ID **or** bank account + IFSC. The bot parses each combined reply itself.
8. **New `validate_phone` tool, called immediately (B3).** A new tool takes a raw phone string, runs the existing `normalizePhone` / `isValidPhone` (`src/lib/phone.ts`), and returns `{ valid, normalized, error }`. The prompt instructs the bot to call it **the moment it has the recipient number** (right after ask (i)), and if `valid` is false, re-ask the number then and there — before moving to payout. Read-only: no Redis access, no writes. The `create_transfer` / `send_approve_picker` server-side phone validation stays exactly as-is (defense in depth — `validate_phone` is a UX early-catch, not a replacement).
9. **Conventions.** TDD per task; `fakeRedis()` in tests; no `as any`; the bot stays partner-/provider-/PII-blind (`bot-content-guard` green); `prompt.test.ts` + `tools.test.ts` + `payment.test.ts` updated to the new copy/flow (intentional); commit prefix `feat(ux):`; one atomic commit per task.

---

## Architecture

### Send-flow turn sequence — old vs new

```
OLD (sequential, late phone-validation, split quote)        NEW (Bundle B sequencing + Bundle A merged quote)
─────────────────────────────────────────────────          ──────────────────────────────────────────────────
1. "How much?"                                              1. "How much, and how do you want to pay
2. "How do you want to pay?"          ── B1 merge ──▶           (credit/debit card or bank transfer)?"
3. "Recipient name?"                                           → get_quote(amount_usd, funding_method)   [unchanged schema]
4. "Their WhatsApp number?"                                 2. "Who's it going to — name + their
5. "UPI or bank?"                     ── B2 merge ──▶           WhatsApp number (with country code)?"
6. "UPI ID / account + IFSC?"                                  → validate_phone(number)  ◀── B3 early-catch
   (phone only checked at create_transfer ── B3 ──▶            if !valid: re-ask the number NOW, loop here
    time, as a late tool error)                             3. "Pay out to their UPI ID, or bank account + IFSC?"
                                                               (bot parses upi vs bank+ifsc from one reply)
7. send_approve_picker →                                    4. send_approve_picker →  [A1 enriched single message]
   "Sending $X to <name>.                                      ┌──────────────────────────────────────────┐
    Fee $Y → ₹Z."   [+ Approve/Cancel]                         │ Sending $X to <name>.                      │
   (no FX rate, no ETA, no destination)                        │ first transfer free — you save $Y   [A2]   │
                                                               │ Rate: 1 USD = ₹R                           │
                                                               │ They get ₹Z within ~10 minutes             │
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

### `validate_phone` insertion point (B3)

```
runAgentTurn → model emits tool_call validate_phone(phone) → executeTool('validate_phone', …)
  └─ validatePhoneTool(args)                       src/lib/tools.ts (NEW, read-only)
       normalized = normalizePhone(args.phone)     src/lib/phone.ts (existing)
       valid      = isValidPhone(normalized)        src/lib/phone.ts (existing)
       return valid
         ? { valid: true,  normalized }
         : { valid: false, normalized, error: 'That doesn't look like a valid WhatsApp
                                               number — please send it with country code, e.g. 919876543210.' }
  └─ NO ctx.store / ctx.*Store access — pure wrapper, no Redis, no writes
```

### Enriched approve message assembly (A1/A2) — inside `sendApprovePickerTool`, after `quote()`

```
q = quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount)   ── UNCHANGED ──
draftId = await draftStore.createDraft({ … quote: { feeUsd, fxRate, amountInr } })  ── UNCHANGED ──
summary = buildApproveSummary(q, recipientName, payoutMethod, payoutDestination)   ◀── NEW pure helper
await sendInteractive(ctx.phone, summary, [Approve&pay(draftId), Cancel(draftId)])  ── buttons UNCHANGED ──
return { sent: true, draft_id: draftId }                                            ── UNCHANGED ──
```

The draft, the cap re-checks, `createDraft`, the button IDs, and the return shape are all untouched. The single change is `summary`'s construction (a new pure `buildApproveSummary` helper, unit-testable without Redis).

---

## Components

### A1 — Enriched single approve message (`src/lib/tools.ts`, `sendApprovePickerTool` + a new pure helper)

**Before** (lines 833–841 of `src/lib/tools.ts`):

```ts
const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n);
const summary =
  `Sending ${fmt(q.amountSource)} to ${args.recipient_name}.\n` +
  `Fee ${fmt(q.feeSource)} → ₹${q.amountInr.toLocaleString('en-IN')}.`;
await sendInteractive(ctx.phone, summary, [
  { id: approveButtonId(draftId), title: 'Approve & pay' },
  { id: cancelButtonId(draftId), title: 'Cancel' },
]);
```

**After** — factor the body into a pure, testable helper `buildApproveSummary(q, recipientName, payoutMethod, payoutDestination)` and call it; the `sendInteractive` buttons are unchanged:

```ts
const summary = buildApproveSummary(
  q,
  String(args.recipient_name),
  args.payout_method as PayoutMethod,
  String(args.payout_destination),
);
await sendInteractive(ctx.phone, summary, [
  { id: approveButtonId(draftId), title: 'Approve & pay' },
  { id: cancelButtonId(draftId), title: 'Cancel' },
]);
```

Where the new helper (same file, exported for unit test) renders the six required lines from the **existing** `Quote` fields (`amountSource`, `feeSource`, `feeUsd`, `fxRate`, `amountInr`, `deliveryEstimate`, `sourceCurrency`):

```ts
function maskDestination(method: PayoutMethod, dest: string): string {
  if (method === 'upi') return `UPI ${dest}`;
  // bank: "<acct> <ifsc>" or "<acct>, <ifsc>" → mask all but last 4 of the account
  const [acct, ...rest] = dest.split(/[,\s]+/).filter(Boolean);
  const last4 = (acct ?? '').slice(-4);
  const ifsc = rest.join(' ');
  return `bank a/c ****${last4}${ifsc ? `, IFSC ${ifsc}` : ''}`;
}

export function buildApproveSummary(
  q: Quote, recipientName: string, payoutMethod: PayoutMethod, payoutDestination: string,
): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n);
  const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  // A2: first-transfer-free framing when the quote fee is 0 (feeUsd === 0 path in fx.ts).
  const feeLine =
    q.feeUsd === 0
      ? `first transfer free — you save ${fmt(q.feeSource)}`   // see A2 note on the "save" amount
      : `Fee ${fmt(q.feeSource)}`;
  return [
    `Sending ${fmt(q.amountSource)} to ${recipientName}.`,
    feeLine,
    `Rate: 1 ${q.sourceCurrency} = ${inr(q.fxRate)}`,
    `They get ${inr(q.amountInr)} ${q.deliveryEstimate}.`,   // q.deliveryEstimate = 'within 10 minutes'
    `To: ${maskDestination(payoutMethod, payoutDestination)}`,
    `Rate locked ~10 min.`,
  ].join('\n');
}
```

- The FX rate line uses `q.fxRate` (already on `Quote`, already in the draft payload, never previously shown). For a USD partner `1 USD = ₹R`; for a `[SEND CURRENCIES]` partner it correctly reads `1 GBP = ₹R` because the line interpolates `q.sourceCurrency`.
- `q.deliveryEstimate` is the `'within 10 minutes'` string from `fx.ts` (returned by `get_quote` as `delivery_estimate` today but never surfaced) — now shown verbatim, so the ETA stays a single source of truth.
- `maskDestination` shows the UPI ID in full (it's a routing handle the customer typed and needs to verify) but masks all but the last 4 of a bank account number — destination is customer-owned data, no partner/provider leak.

### A2 — First-transfer-free framing (folded into `buildApproveSummary` above)

**Before:** the bare fee line `Fee ${fmt(q.feeSource)}` renders `Fee $0.00` on a first transfer.

**After:** `q.feeUsd === 0 ? 'first transfer free — you save $X' : 'Fee $Y'`.

**Note on the "save" amount.** The cleanest honest number is the fee they *would* pay on a repeat send with the **same funding method**. `q.feeSource` is 0 on a first transfer (it's the actual fee), so the helper cannot derive the "saved" amount from the quote alone — `quote()` short-circuits to `feeUsd = 0` before computing the method fee. Two implementable options (see Open question 1): **(a)** show the framing without a dollar figure — "first transfer free 🎉" (zero extra computation, no risk of a wrong number); **(b)** compute the would-be fee from `q.amountUsd` + `fundingMethod` using the same constants as `fx.ts` (`bank_transfer → 1.99`, `debit_card → 2.99`, `credit_card → round2(2.99 + 0.03*amountUsd)`) and convert to source currency via `q.feeSource`'s rate. **Recommendation: (b)**, but exposed as a tiny exported pure helper `wouldBeFeeUsd(amountUsd, fundingMethod)` co-located with `quote()` in `fx.ts` so the fee schedule stays single-sourced and unit-tested — `quote()` itself is unchanged. If review prefers zero math risk, fall back to (a).

### A3 — Stage-1 payment copy (`src/lib/payment.ts`, `completePaymentStage1`)

**Before** (lines 35–37):

```ts
const senderMessages = [
  `✅ Payment received — $${updated.totalChargeUsd.toFixed(2)} charged. Sending ₹${inr(updated.amountInr)} to ${updated.recipientName}…`,
];
```

**After:**

```ts
const senderMessages = [
  `✅ Payment received — $${updated.totalChargeUsd.toFixed(2)} charged. ${updated.recipientName} will get ₹${inr(updated.amountInr)} within ~10 minutes. Transfer ID: ${updated.id}`,
];
```

- Uses fields already on `Transfer`: `totalChargeUsd`, `recipientName`, `amountInr`, `id`. No new field, no new arg. The `inr()` local helper is unchanged.
- Existing test assertions (`payment.test.ts`) that the message `toContain('$500.00')`, `'42,600'`, `'Mom'` still hold; one new assertion checks it contains the Transfer ID (`'pay12345'`) and no longer trails with `…`.

### A4 — Stage-2 (delivered) payment copy (`src/lib/payment.ts`, `completePaymentStage2`)

**Before** (lines 70–72):

```ts
const senderMessages = [
  `🎉 ₹${inr(updated.amountInr)} delivered to ${updated.recipientName}. Thanks for using SendHome!`,
];
```

**After** — add the payout-method label (reuse the same UPI/bank wording already in `recipientTemplateParams`) + the Transfer ID:

```ts
const via = updated.payoutMethod === 'upi' ? 'UPI' : 'bank';
const senderMessages = [
  `🎉 ₹${inr(updated.amountInr)} delivered to ${updated.recipientName} via ${via}. Transfer ID: ${updated.id}. Thanks for using SendHome!`,
];
```

- `payoutMethod` and `id` are already on `Transfer`. Existing assertions (`toContain('42,600')`, `'Mom'`) still hold; new assertions check `via UPI` / `via bank` and the Transfer ID. The bank-payout branch of `payment.test.ts` (`payoutMethod: 'bank'`) covers the `via bank` path.

### A5 — Prompt: surface FX/ETA/destination + reword the destination refusal (`src/lib/prompt.ts`)

**(i) Confirmation-surfacing.** The `FLOW` / `QUOTE CONFIRMATION` blocks instruct the bot to mention the FX rate, ETA, and payout destination when confirming. Today the `FLOW` line 21 says only "show the user the fee, the exchange rate, and the rupee amount." Reword to:

> - Once you know the amount and the sender's funding method, call get_quote, then confirm back the fee, the exchange rate (e.g. "1 USD = ₹X"), the rupee amount the recipient will receive, the delivery time, and the payout destination. The enriched approval card (send_approve_picker) already shows all of these — keep any free-text confirmation consistent with it and never invent a rate, fee, or ETA that get_quote did not return.

**(ii) Destination-refusal reword.** The framing that a sender abroad misreads is in line 1 ("a service that lets people in the **United States** send money to family in India") and line 35 ("Do not promise anything beyond **sending money to India**"). Add an explicit `DESTINATION & SENDING` block that separates pay-out from send-from:

**Before** (line 35):

```
- Do not promise anything beyond sending money to India.
```

**After** — keep the refusal of non-India *destinations* but stop implying the *send* side is blocked:

```
DESTINATION & SENDING
- SendHome pays out only in India (INR), to a UPI ID or an Indian bank account. If a user asks to send money to any other country as the destination, explain warmly that right now we only deliver to India — do NOT offer other destinations.
- The SEND side is separate: by default people send from the United States in US dollars. If the system injects a "[SEND CURRENCIES: ...]" note this turn, the user may send from one of those listed currencies. Never tell a user they "can't send" because of where they are — only the payout destination is limited to India. (e.g. someone messaging from the UAE can still send; we just pay out in India.)
- Do not promise anything beyond paying out to India.
```

- **`bot-content-guard` compliance:** this block names countries (US, India, UAE) and `[SEND CURRENCIES]` but contains no `partner` / `corridor` / `watchlist` / `sanctions` / PII tokens — it clears every existing static scan. The `[SEND CURRENCIES]` reference is the same partner-blind phrasing already in the prompt's `CURRENCY` block (line 99) and already guarded.
- `prompt.test.ts` gains assertions that the prompt distinguishes pay-out from send-from (e.g. contains "pays out only in India" and "[SEND CURRENCIES]" and does **not** contain a blanket "only supports sending money to India"-style send-blocking phrase).

### B1 — Amount + funding method asked together (`src/lib/prompt.ts`, `WHAT TO COLLECT` + `FLOW`)

**Before** (lines 9–14): items 1 and 2 are listed as separate sequential asks (amount; then funding method), and `FLOW` line 21 begins "Once you know the amount and the sender's funding method, call get_quote…".

**After:** keep the same six data points but instruct one combined ask. Reword the head of `WHAT TO COLLECT`:

> Collect these to send money. Ask for the amount and the funding method **together in your first question** ("How much would you like to send, and how do you want to pay — credit card, debit card, or bank transfer?"), then call get_quote (it needs both):
> 1. The amount to send, in US dollars (or the listed send currency).
> 2. How the SENDER wants to pay … (unchanged fee table)

- No schema change: `get_quote` is already `required: ['amount_usd', 'funding_method']` (lines 70–71 of `tools.ts`). This is purely a prompt-sequencing instruction; `tools.test.ts`'s `get_quote schema has amount_usd and funding_method (no payout_method)` assertion is unaffected.

### B2 — Recipient collected in two asks (`src/lib/prompt.ts`)

**Before** (lines 15–18): recipient name (3), WhatsApp number (4), payout method (5), payout destination (6) — four separate items, asked roughly one-per-turn.

**After** — two combined asks, the bot parses each reply:

> Collect the recipient in **two** questions, not four:
> - **Ask 1 — name + number:** "Who are you sending to? Send me their name and their WhatsApp number in India with country code (e.g. 919876543210)." Parse both from the one reply. As soon as you have the number, call **validate_phone** with it (see below) before moving on.
> - **Ask 2 — payout:** "How should they receive it — a UPI ID, or a bank account number with IFSC code?" Parse the method (upi vs bank) and the destination from the one reply.

### B3 — `validate_phone` tool (`src/lib/tools.ts` schema + `executeTool` switch + new `validatePhoneTool`) and prompt wiring

**New tool schema** (added to `toolSchemas`, following the existing tool-definition pattern):

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

**New handler** (read-only — no `ToolContext` Redis access; takes only `args`):

```ts
function validatePhoneTool(args: Record<string, unknown>): ToolResult {
  const normalized = normalizePhone(args.phone);          // existing src/lib/phone.ts
  if (!isValidPhone(normalized)) {                         // existing src/lib/phone.ts
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

**Switch wiring** (in `executeTool`, alongside the other cases):

```ts
case 'validate_phone':
  return validatePhoneTool(args);   // no ctx — pure
```

**Prompt wiring** (in the B2 recipient block + a dedicated note):

> - The moment you have the recipient's WhatsApp number, call **validate_phone** with it. If it returns `valid: false`, do not proceed — apologize briefly and ask for the number again, right then, until it's valid. Only after a valid number move on to the payout question. (This is in addition to the system's own check at send time.)

- **Defense in depth preserved:** `createTransferTool`'s legacy-path `normalizePhone`/`isValidPhone` guard (lines 509–515) and `sendApprovePickerTool`'s guard (lines 780–786) are **unchanged** — `validate_phone` is a UX early-catch, not their replacement.
- **`bot-content-guard`:** the tool's `description` and `error` strings contain no `partner`/`corridor`/`watchlist`/`sanctions`/PII tokens.
- **Tool-count update:** `tools.test.ts`'s `exposes all thirteen tools` test (lines 57–74) becomes **fourteen tools**, with `'validate_phone'` added to the sorted list and the title updated.

---

## Security / privacy notes

- **`validate_phone` takes untrusted input and is defensively safe.** Its only argument is a model-supplied string; it does nothing but `normalizePhone` (which is `String(raw ?? '').replace(/\D/g, '')` — strips everything non-digit, so any payload is reduced to digits) and `isValidPhone` (a length-bounded `/^\d+$/` regex check). It performs **no Redis read or write**, touches **no `ToolContext`** (it's called as `validatePhoneTool(args)` without `ctx`), and can mutate nothing. There is no injection surface: the normalized output is digits-only and the error string is a fixed literal.
- **No PII / partner / provider leak in any new copy.** The enriched approve message (A1) surfaces only customer-owned data: the amount **they** entered, the fee/rate/ETA from `get_quote`, the INR payout, and the destination **they** typed (with the bank account masked to last-4). The stage-1/2 messages (A3/A4) surface amount, recipient name, INR, payout method label (UPI/bank), and the Transfer ID — all already on `Transfer`, none of them tenant-internal. The A5 prompt block names only public-facing geography (US / India / UAE) and the already-guarded `[SEND CURRENCIES]` token. No `partnerId`, no provider name, no `complianceStatus`/reasons, no KYC/PII field appears in any string this batch adds.
- **`bot-content-guard` stays the backstop.** Every new string lives in `src/lib/prompt.ts` or `src/lib/tools.ts`, both already in the P2 (`partner`), P5 (`corridor`/`watchlist`/`sanctions`), and KYC-PII static scan lists. `payment.ts` strings are customer-facing by design and contain none of the forbidden vocabulary; if review wants belt-and-braces, the guard's file list can be extended to `src/lib/payment.ts` (it has no `content:` literals today, but the scan would future-proof the stage messages).
- **No new attack surface.** No new route, no new server action, no new Redis key, no new public POST endpoint — the server-action security checklist does not apply (nothing is mutated, nothing is POSTable). `validate_phone` is an internal tool on an already-authenticated chat turn; the existing create-time phone validation that actually gates persistence is untouched.

## Testing strategy

Per-component (TDD; `fakeRedis()` where a store is needed; `validate_phone` and `buildApproveSummary` need no Redis):

- **`tools.test.ts` (update + add):**
  - **Tool roster:** `exposes all thirteen tools` → **fourteen**, with `'validate_phone'` inserted in the sorted list (title + array updated). Intentional.
  - **`validate_phone` (new, ~5 cases):** a clean `919876543210` → `{ valid: true, normalized: '919876543210' }`; a formatted `'+91 98765 43210'` → `valid: true`, `normalized` digits-only; too-short `'12345'` → `{ valid: false, error: /valid/i }`; junk/empty → `valid: false`; the handler performs no Redis I/O (call with no `ctx` and assert it still returns). 
  - **`buildApproveSummary` / enriched picker (new, ~5 cases):** the rendered summary contains the FX line (`1 USD = ₹`), the ETA (`within 10 minutes`), the masked destination (`UPI mom@okhdfc` for upi; `bank a/c ****6789` for bank), and the "Rate locked ~10 min." line; first-transfer (fee 0) renders the **first-transfer-free** framing and **not** `Fee $0.00`; a repeat transfer renders `Fee $X`; a GBP-source quote renders `1 GBP = ₹`. The existing `send_approve_picker — cap enforcement` test (over-cap returns error, `interactiveSent === false`) is **unchanged** (correctness invariant).
- **`payment.test.ts` (update):** stage-1's message now `toContain` the Transfer ID (`'pay12345'`) and no longer ends with `…`; stage-2's message now `toContain` `'via UPI'` (and the bank fixture `'via bank'`) and the Transfer ID. The existing `$500.00` / `42,600` / `Mom` / idempotency / cancelled-not-delivered / missing-transfer assertions stay green. Intentional copy update.
- **`prompt.test.ts` (update + add):** keep the existing tool-naming and card/EDD/dormancy assertions; **add** assertions that the prompt (a) asks amount + funding together (e.g. contains "and how do you want to pay"), (b) instructs a two-ask recipient collection and an immediate `validate_phone` call (contains `validate_phone`), and (c) the A5 reword — contains "pays out only in India" and references "[SEND CURRENCIES]", and does **not** contain a blanket send-blocking phrase. Intentional flow update.
- **`bot-content-guard.test.ts` (must stay green, no rewrite):** `prompt.ts` and `tools.ts` are already scanned; the new strings clear the P2/P5/KYC forbidden sets. No change required (optionally extend the file list to `payment.ts`).
- **Transfer-correctness regression (must stay green, untouched):** every `fx.ts` test (`quote` math, `sourceForInr`, MIN/MAX, first-free), every cap test (`check_send_limit`, `send_approve_picker` cap, `create_transfer` cap), the draft create/consume tests, and the receive-first (`amount_inr`) branch tests pass **unmodified** — the executable proof the engine is untouched.

**Rough test-count delta from 573** (measured: 573 passing across 60 files): `validate_phone` (~5) + enriched-picker / `buildApproveSummary` (~5) + first-free framing (~2) + payment copy adds (~3) + prompt-flow asserts (~3) ≈ **+~18 → ~591**, with the existing correctness/cap/draft/fx tests **unmodified** and the old-copy assertions in `payment.test.ts` / `tools.test.ts` / `prompt.test.ts` **updated** rather than added.

## Acceptance criteria

- [ ] `send_approve_picker` sends **one** interactive message containing amount, fee (first-free framing when fee is 0), FX rate (`1 <CCY> = ₹X` from `q.fxRate`), INR payout (`q.amountInr`), delivery ETA (`q.deliveryEstimate`), the payout destination (UPI shown, bank masked to last-4), and a "Rate locked ~10 min." line — with the unchanged `[Approve & pay]` / `[Cancel]` buttons and unchanged draft payload + return shape.
- [ ] First-transfer-free is framed as "first transfer free — you save $X" (or "first transfer free 🎉" per Open Q1), never a bare `Fee $0.00`; the underlying `quote()` fee is still 0.
- [ ] `completePaymentStage1` message is a terminated sentence with amount charged, recipient + INR + "within ~10 minutes", and `Transfer ID: <id>`; no trailing `…`.
- [ ] `completePaymentStage2` message includes `via UPI` / `via bank` and `Transfer ID: <id>`.
- [ ] The prompt instructs surfacing FX rate + ETA + payout destination in confirmations, and the A5 block distinguishes "pays out only in India" from "you can send from the US / a listed currency"; UAE-as-destination is still refused; a UAE sender is not told they can't send.
- [ ] The prompt asks amount + funding method together (one turn) and collects the recipient in two asks (name+number, then payout).
- [ ] `validate_phone` exists, is read-only (no Redis, no `ctx`), wraps `normalizePhone`/`isValidPhone`, returns `{ valid, normalized, error? }`; the prompt calls it immediately after the recipient number and re-asks on `valid: false` before payout.
- [ ] `create_transfer` / `send_approve_picker` server-side phone validation, FX math, caps, and the draft/create flow are **unchanged**.
- [ ] `tools.test.ts` tool roster updated to **fourteen** tools including `validate_phone`; `payment.test.ts` / `tools.test.ts` / `prompt.test.ts` updated to the new copy/flow.
- [ ] `bot-content-guard` stays green; the full suite is green after the intentional copy/flow updates.

## Open questions

1. **First-free "save $X" amount (A2).** `quote()` returns `feeSource = 0` on a first transfer, so the helper can't read the would-be fee from the quote. **Recommendation:** add a tiny exported pure `wouldBeFeeUsd(amountUsd, fundingMethod)` next to `quote()` in `fx.ts` (single-sources the fee schedule, unit-tested, leaves `quote()` untouched) and show "first transfer free — you save $X". If review wants zero math risk, fall back to "first transfer free 🎉" with no figure.
2. **Bank-destination masking format (A1).** Recommendation: `bank a/c ****<last4>, IFSC <ifsc>` — mask the account to last-4 (customer can still recognize it) but show the IFSC in full (it's a public branch code, not sensitive). UPI IDs are shown in full (they're routing handles the customer typed and must verify). Confirm the last-4 masking is desired vs. showing the full account the customer just typed back to them.
3. **"Rate locked ~10 min" honesty (A1).** The draft has a TTL via `draftStore` but the picker doesn't read it. Recommendation: keep the copy as an approximate reassurance ("~10 min") matching the existing draft expiry intent; do **not** wire a live countdown (out of scope, no transfer-correctness impact). Revisit if the actual draft TTL differs materially from 10 minutes.
4. **`validate_phone` country-specificity.** `isValidPhone` only checks 10–15 digits with country code — it does **not** assert an India (`91`) prefix. Recommendation: keep it as-is for v1 (matches the existing create-time check exactly, so the early-catch and the gate agree); an India-prefix check is a candidate fast-follow but would diverge the two validations and is out of scope here.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Enriched picker accidentally surfaces a partner/provider/PII term | Low | High | New strings live in `tools.ts` (already scanned by `bot-content-guard` P2/P5/KYC); renderer reads only customer-owned fields; bank account masked to last-4; suite + guard green = proof. |
| First-free "save $X" shows a wrong/fabricated number | Low | Medium | Derive from a single-sourced `wouldBeFeeUsd` helper unit-tested against the same `fx.ts` constants, or fall back to figure-less framing (Open Q1); `quote()` itself untouched. |
| Touching `send_approve_picker` perturbs the draft/cap flow | Low | High | Only the `summary` string changes; `createDraft`, the three cap re-checks, button IDs, and the return shape are byte-for-byte unchanged; the cap-enforcement test stays green unmodified. |
| Prompt reword makes the bot offer non-India destinations | Low | High | A5 block explicitly keeps the India-only payout refusal ("we only deliver to India — do NOT offer other destinations"); `prompt.test.ts` asserts the refusal phrasing survives. |
| `validate_phone` diverges from the create-time check, causing accept-then-reject | Low | Medium | Both call the **same** `normalizePhone`/`isValidPhone`; v1 keeps them identical (Open Q4); a shared dedicated test asserts agreement on the boundary cases. |
| Bot stops calling `validate_phone` / asks recipient in 4 turns again (prompt drift) | Medium | Low | Prompt makes the two-ask + immediate-validate sequence explicit; `prompt.test.ts` asserts the instructions are present; functionally harmless (create-time validation still gates persistence). |
| Stage-1/2 copy change breaks a copy assertion elsewhere | Low | Low | `payment.test.ts` is the only asserter of these strings; updated intentionally; `recipientTemplateParams` (the WhatsApp template path) is untouched. |

## Out of scope (deferred)

- **Bundle C — funding shorthand & stickiness:** "same as last time," sticky funding method, text-match against saved recipients, proactive re-send. Not in this batch.
- **Bundle D — code-guard `check_send_limit` before `get_quote`:** the prompt already instructs the cap check before `get_quote`; promoting it to a code-enforced gate is deferred.
- **WhatsApp Flow wiring** (native multi-field forms) — the recipient collection stays free-text + parsing; no Flow.
- **Voice / audio input.**
- **Multi-partner FX presentation beyond `[SEND CURRENCIES]`** — the enriched picker renders `1 <sourceCurrency> = ₹X` correctly for the existing P4 single-send-currency-per-turn model; cross-partner FX comparison is not added.
- **Live rate-lock countdown** — "Rate locked ~10 min" is static reassurance copy, not a wired timer (Open Q3).

## Sequencing note

This batch stacks on `spec/p4-multi-currency` (current branch), whose `Quote`/`Transfer` already carry `sourceCurrency` / `amountSource` / `feeSource` and whose `send_approve_picker` already renders source-currency amounts — so A1's FX/source-currency lines drop straight into the existing render path. It depends only on: the `Quote` shape (`fxRate` / `amountInr` / `deliveryEstimate` / `sourceCurrency` / `feeSource` / `feeUsd`, `src/lib/fx.ts`), the `Transfer` shape (`id` / `payoutMethod` / `amountInr` / `recipientName` / `totalChargeUsd`, `src/lib/types.ts`), `normalizePhone`/`isValidPhone` (`src/lib/phone.ts`), `sendInteractive` + the approve/cancel button IDs (`src/lib/whatsapp.ts` / `whatsapp-buttons.ts`), and the existing `bot-content-guard` harness — none of which are in flight in this batch. Suggested task order (one atomic `feat(ux):` commit each): **B3** `validate_phone` (smallest, no dependencies) → **A1/A2** `buildApproveSummary` + first-free → **A3** stage-1 copy → **A4** stage-2 copy → **B1** amount+funding prompt → **B2** two-ask recipient prompt → **A5** confirmation-surfacing + destination reword (touches the prompt last, after B1/B2 have settled the flow wording). Each commit updates only the tests whose copy/flow it intentionally changes; the correctness/cap/draft/fx tests stay untouched and green throughout.

---

## Key files (reference)

- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/tools.ts` — add `validate_phone` schema + `validatePhoneTool` + `executeTool` case (B3); add exported `buildApproveSummary` + `maskDestination` and call them in `sendApprovePickerTool` (A1/A2). Draft/cap/button logic unchanged.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/payment.ts` — stage-1 (A3) and stage-2 (A4) `senderMessages` copy; uses existing `Transfer` fields only.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/prompt.ts` — amount+funding-together (B1), two-ask recipient + immediate `validate_phone` (B2/B3), confirmation-surfacing + `DESTINATION & SENDING` reword (A5).
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/fx.ts` — **unchanged** transfer math; optional tiny exported `wouldBeFeeUsd(amountUsd, fundingMethod)` co-located with `quote()` for the A2 "save $X" figure (Open Q1). `quote()` body untouched.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/phone.ts` — `normalizePhone` / `isValidPhone`, wrapped (unchanged) by `validate_phone`.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/whatsapp.ts` + `src/lib/whatsapp-buttons.ts` — `sendInteractive` and `approveButtonId`/`cancelButtonId`, used unchanged by the enriched picker.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/tools.test.ts` — tool roster 13→14; add `validate_phone` + `buildApproveSummary` cases; cap-enforcement test unchanged.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/payment.test.ts` — update stage-1/stage-2 copy assertions (Transfer ID, `via UPI`/`via bank`).
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/prompt.test.ts` — add B1/B2/B3/A5 flow + reword assertions; keep existing card/EDD/dormancy assertions.
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/bot-content-guard.test.ts` — stays green; `prompt.ts`/`tools.ts` already scanned (optionally extend to `payment.ts`).
- Current suite measured at **573 tests across 60 files**; projected delta **+~18 → ~591**, with correctness/cap/draft/fx tests unmodified.
