# Transfer Memory — Design

**Status:** design drafted 2026-05-29. Awaiting spec review → implementation plan.

**Sub-project:** the "yesterday's payments aren't remembered" fix. Raj's complaint, verbatim: *"yesterday's payments are not being remembered by our LLM."* He's right, and we verified the gap: completed transfers are persisted in Redis (`transfer:<id>`, indexed by the `transfers:ids` set, read back by `store.listTransfers()` newest-first) but are **never injected into the model's context**. In `runAgentTurn` (`src/lib/agent.ts`) the only customer-specific context the model ever sees is the chat transcript (`store.getConversation(phone)`, last 40 messages via `trimHistory`) plus saved recipients (only if the model itself calls `list_saved_recipients`). A returning customer who sent Mom $500 yesterday is invisible to the model unless that exchange happens to still be inside the 40-message window — across a day it usually isn't. This batch surfaces a customer's own recent transfer history as a compact, always-injected round-0 system note, mirroring the existing `[NEW CONVERSATION]` / `[TIER_REMINDER]` / `[SEND CURRENCIES]` injection pattern.

This is an **additive, intentionally behavior-changing** fix for returning customers — that's the whole point — but it is byte-for-byte unchanged for any customer with no transfer history, and it is read-only, schema-free, and partner-blind.

---

## Goal

Let the WhatsApp bot reference a customer's **recent transfer history** in conversation — e.g. answer "did my last payment go through?" or naturally say "you sent Mom $500 yesterday" — by giving the model, every turn, a compact list of the customer's own most-recent transfers.

Concretely, this batch:

- Adds a new pure-ish module `src/lib/recent-transfers.ts` exporting `getRecentTransfersNote(phone, store): Promise<string>` that reads `store.listTransfers()` (already newest-first + defensively sorted), **filters to the calling customer's own transfers by sender phone**, takes the most recent 5, and renders a compact `[RECENT TRANSFERS]` block — one line each: human date (via `easternDate`) · `recipientName` · amount in `sourceCurrency` · status label.
- Wires one call to it into `runAgentTurn`'s round-0 system-note block in `src/lib/agent.ts`, **alongside** the existing `noteCustomer` / `notePartner` resolution and the `[NEW CONVERSATION]` / `[TIER_REMINDER]` / `[SEND CURRENCIES]` pushes — appended only when the returned string is non-empty.
- Extends `tests/bot-content-guard.test.ts` so the `[RECENT TRANSFERS]` template is scanned for the same forbidden terms (`partner`, `corridor`, `watchlist`, `sanctions`, …) the rest of the bot content path is already held to.

It is **NOT** a tool. The note is always available with no extra LLM round-trip, which is cheaper and removes the "model has to remember to ask" failure mode that already makes `list_saved_recipients` flaky on returning turns.

## The safety invariant (the thing every task protects)

> `getRecentTransfersNote` is **read-only** — it calls only `store.listTransfers()` and performs **no Redis writes**, **no schema change**, and adds **no new key namespace**. It introduces **no new `TransferStatus`** and **no new `Transfer` field**. A customer with **no matching transfers gets `''`**, and an empty string is **not appended** to the round-0 messages — so for a history-less customer the messages array sent to the model is **byte-for-byte identical** to today's and their behavior is unchanged. The existing **529-test suite stays green**, and `tests/bot-content-guard.test.ts` (extended) stays green — those two facts together are the executable proof that this fix is additive, partner-blind, and safe.

This mirrors how the `[SEND CURRENCIES]` note shipped in P4: a small, scoped, round-0 injection that only fires when its precondition is met, and is invisible otherwise.

## Locked design decisions (2026-05-29)

1. **Surface recent transfer history to the model.** Transfers live in Redis but are never in the model's context. This fix injects them. Verified gap: `runAgentTurn` builds `messages` from `SYSTEM_PROMPT` + scoped notes + `history` (the transcript) only; `listTransfers()` is never read on the chat path.
2. **Round-0 system note, not a tool.** Inject a compact `[RECENT TRANSFERS]` note at `round === 0`, mirroring the existing `[NEW CONVERSATION]` / `[TIER_REMINDER]` / `[SEND CURRENCIES]` pushes in `src/lib/agent.ts`. Cheaper than a tool (no extra round-trip), always available, and not subject to the model forgetting to call it. Like those notes, it is injected per-turn into `messages` and **never pushed onto `history`**, so it does not echo or get persisted.
3. **Own transfers only, last 5.** New module `src/lib/recent-transfers.ts` → `getRecentTransfersNote(phone, store): Promise<string>`. It filters `store.listTransfers()` to entries whose sender `phone === phone` (strict equality), keeps the first 5 of the already-newest-first list, and renders them. `listTransfers` is already newest-first + defensively sorted (`(b.createdAt ?? '').localeCompare(a.createdAt ?? '')`), so no re-sort is needed — but the module defends the same way on any field it reads.
4. **Compact per-line format, customer-visible fields only.** Each line: `easternDate(Date.parse(createdAt))` (human date) · `recipientName` · amount in **source currency** (`amountSource` + `sourceCurrency`, via `Intl.NumberFormat('en-US', { style: 'currency', currency: sourceCurrency })` — the **same** renderer the dashboard's `money()` helper uses in `transactions-tabs.tsx`) · a human status label (`awaiting_payment`→"awaiting payment", `paid`→"paid", `delivered`→"delivered", `cancelled`→"cancelled", `blocked`→"on hold" — never the raw internal token for `blocked`). **No** `partnerId`, **no** `complianceStatus`/`complianceReasons`, **no** transfer `id`, **no** `payoutDestination`, **no** recipient phone, **no** `amountUsd`/`fxRate` internals.
5. **Empty note when no history.** When the customer has zero matching transfers, return `''` and inject nothing → byte-for-byte-unchanged behavior for them (the invariant above).
6. **Partner-blind + privacy-bounded.** The note must contain **none** of `partner` / `corridor` / `watchlist` / `sanctions` (the existing forbidden set) and must surface only fields the customer already owns (their own recipient names, their own source-currency amounts, dates, statuses). `bot-content-guard` is extended to scan the `[RECENT TRANSFERS]` template, so a regression that leaks a tenant-internal term fails CI.
7. **Conventions.** TDD per task; `fakeRedis()` in tests; no `as any`; defensive `?? ''` on Redis-resident strings/sorts and on every field the renderer reads; the bot stays partner-blind; one atomic commit per task; commit prefix `feat(memory):`; the existing 529-suite green + `bot-content-guard` green = the safety proof.

---

## Architecture

```
Incoming WhatsApp turn:  runAgentTurn(phone, incomingText, turn)   src/lib/agent.ts
  │  history = store.getConversation(phone)         (transcript, last 40)
  │  noteCustomer = customerStore.getCustomer(phone)
  │  notePartner  = partnerStore.getPartner(...) ?? ensureDefaultPartner()
  │  sendCurrencies = allowedSendCurrencies(notePartner)
  │  recentNote = await getRecentTransfersNote(phone, store)        ← NEW (round-0 only)
  ▼
for round 0:
  messages = [ {system: SYSTEM_PROMPT} ]
    if isNewConversation && round 0  → push [NEW CONVERSATION]
    if round 0 && isNewCustomer      → push [NEW CUSTOMER]
       else if tierReminderDayOfWindow → push [TIER_REMINDER]
    if round 0 && sendCurrencies > 1 → push [SEND CURRENCIES: ...]
    if round 0 && recentNote !== ''  → push {system: recentNote}    ← NEW
    messages.push(...history)
  ▼
getRecentTransfersNote(phone, store)                               src/lib/recent-transfers.ts (NEW)
  │  all = await store.listTransfers()        (newest-first, defensively sorted)
  │  mine = all.filter(t => (t.phone ?? '') === phone)             ← strict own-phone filter
  │  top  = mine.slice(0, MAX_RECENT)         (= 5)
  │  if top.length === 0  → return ''         ← history-less ⇒ inject nothing
  │  lines = top.map(formatLine)              ← date · recipientName · amount(source) · status label
  └─ return `[RECENT TRANSFERS] ...\n${lines.join('\n')}`
  ▼
messages → deps.chat(messages, toolSchemas) → model now SEES the customer's recent sends
```

The note is computed **once per turn** but only consulted inside the `round === 0` branch (it is the model's first sight of the conversation; later tool rounds re-send the same standing context). For a history-less customer `recentNote === ''`, the `push` is skipped, and the messages array is identical to today's.

---

## Components

### 1. `getRecentTransfersNote` + the line formatter — `src/lib/recent-transfers.ts` (new)

The whole module. Read-only; depends only on `Store.listTransfers`, the `Transfer` type, and `easternDate`.

```ts
import type { Store } from './store';
import type { Transfer, TransferStatus } from './types';
import { easternDate } from './dates';

const MAX_RECENT = 5;   // last 5 of the already-newest-first list

// Customer-facing status labels. NEVER the raw internal token for blocked.
const STATUS_LABEL: Record<TransferStatus, string> = {
  awaiting_payment: 'awaiting payment',
  paid: 'paid',
  delivered: 'delivered',
  cancelled: 'cancelled',
  blocked: 'on hold',   // never surface "blocked"/compliance wording to the customer
};

function formatAmount(transfer: Transfer): string {
  // Mirrors the dashboard money() helper (transactions-tabs.tsx) — source currency,
  // customer-visible. Defensive: fall back to a bare number if Intl rejects the code.
  const currency = transfer.sourceCurrency ?? 'USD';
  const amount = transfer.amountSource ?? transfer.amountUsd ?? 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatLine(transfer: Transfer): string {
  const when = transfer.createdAt ? easternDate(Date.parse(transfer.createdAt)) : 'recently';
  const who = (transfer.recipientName ?? '').trim() || 'a recipient';
  const amount = formatAmount(transfer);
  const status = STATUS_LABEL[transfer.status] ?? 'in progress';
  return `${when} · ${who} · ${amount} · ${status}`;
}

/**
 * A compact, round-0 system note of the customer's OWN most-recent transfers.
 * Returns '' (inject nothing) when the customer has no transfer history.
 * Read-only: no Redis writes, no schema change. Partner-blind by construction —
 * surfaces only recipientName + source-currency amount + status label + date.
 */
export async function getRecentTransfersNote(phone: string, store: Store): Promise<string> {
  const all = await store.listTransfers();                      // newest-first, defensively sorted
  const mine = all.filter((t) => (t.phone ?? '') === phone);    // strict own-phone filter
  const top = mine.slice(0, MAX_RECENT);
  if (top.length === 0) return '';                              // history-less ⇒ unchanged behavior
  const lines = top.map(formatLine);
  return (
    `[RECENT TRANSFERS] The customer's most recent sends (newest first), for context only — ` +
    `reference naturally if relevant, do not list them unprompted:\n${lines.join('\n')}`
  );
}
```

Notes:
- **Read-only.** Calls `store.listTransfers()` and nothing else; no `save*`, no `incr`, no new key. This is the literal embodiment of the safety invariant.
- **Strict own-phone filter.** `(t.phone ?? '') === phone` — only the calling customer's transfers, never another customer's. The `?? ''` guards a legacy record with a missing `phone` (it would simply never match, which is correct — better to drop than to leak).
- **Source-currency presentation.** Uses `amountSource` + `sourceCurrency` (P4 fields), the customer-visible amounts, via the same `Intl.NumberFormat` the dashboard uses. `?? transfer.amountUsd` defends pre-P4 records (whose `getTransfer` lazy-fill already backfills `amountSource = amountUsd`, but the belt-and-braces fallback costs nothing). It never reads `amountInr`/`fxRate` internals.
- **`blocked` → "on hold".** The customer must never see the compliance token `blocked` or any reason; the label map enforces this and `bot-content-guard` (Component 3) backstops it.
- **Defensive everywhere.** `createdAt ?? '…'`, `recipientName ?? ''`, `sourceCurrency ?? 'USD'`, `status` label fallback — mirrors the `?? ''` discipline already in `store.listTransfers` / `listRecipients`.
- **`MAX_RECENT = 5`** is a module constant (single source; trivially tunable — see Open question 1).
- **Full-scan + filter** is fine at prototype scale; a secondary `transfers:phone:<phone>` index is explicitly Out of scope (noted there).

### 2. Agent injection point — `src/lib/agent.ts`

One `await` next to the existing `noteCustomer`/`notePartner` resolution, and one conditional `push` inside the `round === 0` block, mirroring `[SEND CURRENCIES]`.

```ts
import { getRecentTransfersNote } from './recent-transfers';   // NEW

// ...inside runAgentTurn, beside the existing noteCustomer/notePartner/sendCurrencies setup,
// BEFORE the `for (let round...)` loop:
const recentNote = await getRecentTransfersNote(phone, deps.store);   // '' when no history

// ...inside the loop, in the existing round-0 block (after the [SEND CURRENCIES] push):
if (round === 0 && recentNote) {
  messages.push({ role: 'system', content: recentNote });
}
```

Notes:
- Computed **once** before the loop (a single `listTransfers()` read per turn), consulted only at `round === 0` — same lifecycle as `sendCurrencies`.
- The note is pushed into the per-turn `messages` array only; it is **never** `history.push(...)`ed, so it is not persisted by `saveConversation` and does not echo on later turns — identical to how `[NEW CONVERSATION]` / `[SEND CURRENCIES]` are handled.
- `if (round === 0 && recentNote)` — an empty string is falsy, so the history-less customer's `messages` array is untouched (the invariant). No `turn` flag is needed; presence of history is the precondition.
- Uses `deps.store`, already on `AgentDeps` and already passed into `executeTool`'s context — no new dependency added to `AgentDeps` or `createAgent`.
- Placement: appended **after** `[SEND CURRENCIES]` and **before** `messages.push(...history)`, so the standing transcript still comes last.

### 3. `bot-content-guard` extension — `tests/bot-content-guard.test.ts`

The note is generated content that reaches `content:` on a chat message, so it must clear the same partner-blind / compliance-blind bar as `prompt.ts` / `agent.ts` / `tools.ts`. Two complementary guards:

```ts
// (a) Source-scan: the new module is added to the existing P2/P5/KYC content-scan lists,
//     so any string literal assigned to a `content:` field (or the template the note builds
//     from) is checked for the forbidden terms.
const filesToScan = [ /* ...existing... */ , 'src/lib/recent-transfers.ts' ];   // P2 + P5 + KYC scans

// (b) Behavioral guard: render a real note over fixture transfers (incl. a blocked one)
//     and assert it leaks none of the tenant/compliance vocabulary, and never the raw
//     "blocked" token.
describe('transfer-memory: [RECENT TRANSFERS] note stays partner-/compliance-blind', () => {
  it('a rendered recent-transfers note contains no tenant/compliance internals', async () => {
    const store = makeStoreWithTransfers([
      { phone: '+1555', recipientName: 'Mom',   amountSource: 500, sourceCurrency: 'USD', status: 'delivered', createdAt: '2026-05-28T12:00:00Z' },
      { phone: '+1555', recipientName: 'Ravi',  amountSource: 200, sourceCurrency: 'USD', status: 'blocked',   createdAt: '2026-05-27T12:00:00Z' },
    ]);
    const note = (await getRecentTransfersNote('+1555', store)).toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions', 'blocked', 'compliance', 'partnerid'])
      expect(note).not.toContain(term);
    expect(note).toContain('mom');     // customer-owned data IS present
    expect(note).toContain('on hold'); // blocked surfaced as the soft label
  });
});
```

Notes:
- Part (a) extends the existing static scans (the P2 `'partner'` rule, the P5 `corridor/watchlist/sanctions` rule, and the KYC PII rule) to include `src/lib/recent-transfers.ts`, so the **STATUS_LABEL map and the template literal** are covered the same way the prompt is.
- Part (b) is a behavioral check over a real render (including a `blocked` transfer) — the static scan can't catch a leak that only appears after interpolation, so we assert on the actual output string.
- These live in `bot-content-guard.test.ts` (extended) and partly in `recent-transfers.test.ts` (Component 1's spec); the static-list extension is the cheap regression net.

---

## Security / privacy notes

- **Own transfers only — strict phone filter.** `getRecentTransfersNote` filters `listTransfers()` by `(t.phone ?? '') === phone`, where `phone` is the WhatsApp sender id `runAgentTurn` was invoked with (the webhook's authenticated `from`). A customer can only ever see their own sends; there is no path by which customer A's transfers enter customer B's note. A legacy record with a missing `phone` matches nothing and is dropped (fail-closed).
- **Customer-visible fields only.** The note renders exactly four dimensions, all already owned by or shown to the customer: the date they sent, the recipient name **they** typed, the amount in the currency **they** sent, and a soft status label. It never reads or emits `partnerId`, `complianceStatus`/`complianceReasons`, the internal transfer `id`, `payoutDestination`, recipient phone, or the USD/FX internals (`amountUsd`/`fxRate`/`amountInr`).
- **Partner-blind by construction + by test.** The note contains no tenant or compliance vocabulary; `blocked` is mapped to "on hold" so the compliance token never reaches chat. `bot-content-guard` scans both the module source and a rendered note for `partner`/`corridor`/`watchlist`/`sanctions`/`blocked`, so a future regression fails CI.
- **No new attack surface.** This is not a tool and not a route — there is no new public endpoint, no new server action (the server-action security checklist does not apply: nothing is mutated, nothing is POSTable). It is internal context assembly on an already-authenticated chat turn.
- **Token cost is bounded.** At most 5 short lines (~12–18 tokens each) plus a one-line preamble ⇒ a hard ceiling of roughly **90–120 tokens** added to round 0 only, on turns where the customer has history. The cap of 5 is what makes this a *fixed* cost, not one that grows with a customer's lifetime volume. Zero added cost for history-less customers (empty note, no push).

## Testing strategy

Per-component (TDD, `fakeRedis()` for the store):

- **`recent-transfers.test.ts` (new, ~10 cases):** `getRecentTransfersNote` returns `''` for a customer with **no** transfers (invariant); renders one line per transfer for a customer with history; **caps at 5** (a 7-transfer customer yields exactly 5 lines, the **newest** 5, in newest-first order); filters to **own phone only** (transfers for another phone never appear); each line carries `easternDate(createdAt)`, `recipientName`, the **source-currency** amount (`amountSource`+`sourceCurrency` via `Intl.NumberFormat`), and the human status label; `blocked` renders as **"on hold"** (never the raw token); defensive on a record with missing `createdAt`/`recipientName`/`sourceCurrency` (falls back, never throws); a legacy record with missing `phone` is dropped.
- **`agent.test.ts` (extend, ~4 cases) — the history-less-unchanged proof + the wiring:** a returning customer **with** history gets a `[RECENT TRANSFERS]` system message in `messages` at round 0 (assert the captured `messages` passed to the stubbed `chat`); a customer with **no** history gets **no** such message and the `messages` array is **identical** to the pre-batch baseline (byte-for-byte-unchanged proof); the note is **not** persisted to `history` (it does not appear in a subsequent turn's transcript); the note carries no `partnerId`/compliance term (cross-check with the guard). The existing agent tests (currency note, new-conversation, tier-reminder) stay **green** — proof the injection slot composes with the others.
- **`bot-content-guard.test.ts` (extend, ~3 cases):** `src/lib/recent-transfers.ts` added to the P2/P5/KYC static scan lists; a rendered note (incl. a `blocked` transfer) contains none of `partner`/`corridor`/`watchlist`/`sanctions`/`blocked`; customer-owned data (recipient name) **is** present.
- **Token-bound assertion (~1 case, in `recent-transfers.test.ts`):** a note over 5 long-name transfers stays under a fixed character/line budget (5 lines + 1 preamble) — guards against the cap silently regressing.
- **Whole-suite regression (must stay green):** the full pre-batch suite — every test untouched except the additions above — is the executable proof that this is additive and the existing chat/cron/dashboard mechanics are unbroken.

Rough test-count delta from **529**: new `recent-transfers.test.ts` (~11) + extensions to `agent.test.ts` (~4) and `bot-content-guard.test.ts` (~3) ≈ **+~18 → ~547**, with all existing tests unmodified.

## Acceptance criteria

- [ ] `src/lib/recent-transfers.ts` exports `getRecentTransfersNote(phone, store): Promise<string>`; read-only (no Redis writes), no `as any`, defensive `?? ''` on every field it reads.
- [ ] The note lists the customer's **own** transfers only (strict `t.phone === phone` filter), **newest-first**, **capped at 5**.
- [ ] Each line carries: human date (`easternDate`), `recipientName`, amount in **source currency** (`amountSource` + `sourceCurrency`), and a customer-facing status label; `blocked` renders as "on hold", never the raw token.
- [ ] The note contains **none** of `partnerId`, `complianceStatus`/`complianceReasons`, internal transfer `id`, `payoutDestination`, recipient phone, or USD/FX internals.
- [ ] A customer with **no** transfer history gets `''`, and `runAgentTurn` injects nothing → the round-0 `messages` array is byte-for-byte identical to today's for that customer.
- [ ] `runAgentTurn` injects the note as a round-0 system message (after `[SEND CURRENCIES]`, before the transcript), only when non-empty, computed once per turn via `deps.store`; the note is **never** pushed onto `history` / persisted.
- [ ] `tests/bot-content-guard.test.ts` scans `src/lib/recent-transfers.ts` and a rendered note for `partner`/`corridor`/`watchlist`/`sanctions`/`blocked`, and stays green.
- [ ] No new `TransferStatus`, no new `Transfer` field, no new Redis key, no new route, no new server action.
- [ ] The full pre-batch suite passes; `agent.test.ts`'s existing cases (currency / new-conversation / tier-reminder) are unmodified and green.

## Open questions

1. **3 vs 5 transfers.** Locked at **5**. 3 is tighter on tokens; 5 better covers "the last few days" for an active sender without unbounded cost. Recommendation: **keep 5** — it's a single module constant, trivial to dial down if token cost ever bites.
2. **Every turn vs new-conversation-only.** The plan injects on **every** turn's round 0 (cheap; one `listTransfers()` read; always available so the model can answer "did it go through?" mid-conversation). Alternative: gate behind `turn.isNewConversation` (like `[NEW CONVERSATION]`) to save a read on chatty turns. Recommendation: **every turn** — it's the behavior Raj actually wants ("remembered," not "remembered only on the first message"), and the read is one Redis call against a prototype-scale set. Revisit if the transfer set grows large enough to make the full-scan a latency concern (then add the secondary index — see Out of scope).
3. **Date format.** Locked to `easternDate` (e.g. `5/28/2026`), the codebase's single date helper, ET like the rest of the app. Alternative: a relative phrasing ("yesterday", "2 days ago") which reads more naturally in chat but needs a clock and a tested relative-date helper. Recommendation: **`easternDate` for v1** (reuses an existing, tested symbol, no new clock dependency); a relative-phrasing pass is a candidate fast-follow if the model's date phrasing reads stiff.
4. **Currency mix across lines.** A customer who sent in two currencies (multi-currency partner) gets per-line currency-correct amounts (each line renders its own `sourceCurrency`). No aggregation/total is shown (that would be analytics — Out of scope). Confirm per-line source amounts are the right presentation (recommendation: **yes**, matches the dashboard's per-row source-currency display).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Note leaks a tenant/compliance term (e.g. `blocked`, `partnerId`) to the customer | Low | High | `STATUS_LABEL` maps `blocked`→"on hold"; renderer reads only 4 customer-visible fields; `bot-content-guard` scans both the module source and a rendered note (incl. a `blocked` fixture) for the forbidden set. |
| Another customer's transfers appear in the note | Low | High | Strict `(t.phone ?? '') === phone` filter; legacy missing-`phone` records drop (fail-closed); dedicated own-phone-only test in `recent-transfers.test.ts`. |
| Behavior changes for a history-less customer (invariant break) | Low | High | `getRecentTransfersNote` returns `''` and the `if (round === 0 && recentNote)` push is skipped; explicit byte-for-byte-identical `messages` test in `agent.test.ts`. |
| Token cost grows with a customer's lifetime volume | Low | Medium | Hard cap of `MAX_RECENT = 5`; token-bound test guards the budget; cost is fixed, not lifetime-proportional. |
| Note persists into `history` and echoes on every later turn (like a bug the `[NEW CONVERSATION]` comment warns about) | Low | Medium | Pushed only into the per-turn `messages` array, never `history.push`ed — same handling as the existing round-0 notes; test asserts it's absent from a subsequent turn's transcript. |
| `listTransfers()` full-scan becomes a latency cost at scale | Low | Low | Acceptable at prototype scale; secondary `transfers:phone:<phone>` index is documented Out of scope as the scale upgrade. |
| Pre-P4 record with no `amountSource` renders a wrong/blank amount | Low | Low | `getTransfer`'s lazy-fill already backfills `amountSource = amountUsd`; renderer additionally falls back `amountSource ?? amountUsd ?? 0` and `sourceCurrency ?? 'USD'`. |

## Out of scope (deferred)

- **Full conversation summarization** — this surfaces *transfers*, not a rolling summary of the chat; transcript trimming (`MAX_HISTORY = 40`) is unchanged.
- **Spending analytics / insights** — no totals, no "you've sent $X this month," no trends. Per-line facts only.
- **Proactive cross-day status push notifications** — the note is *pull* context for the model to reference when relevant; it does not trigger any outbound message.
- **A secondary `transfers:phone:<phone>` index** — `listTransfers()` full-scan + filter is fine at prototype scale; the index is the scale-up move, not needed now.
- **Changing `list_saved_recipients` / the recipient-picker path** — this is **additive** context, not a replacement; the new-conversation recipient-suggestion flow is untouched.
- **A `recent_transfers` tool** — explicitly rejected in favor of the always-injected note (cheaper, always available, no model-must-remember failure mode).

## Sequencing note

This batch stacks on `spec/p4-multi-currency` (current branch; P4 multi-currency mid-execution), which already gives every `Transfer` the `amountSource` / `sourceCurrency` fields the note renders. It depends only on: `store.listTransfers()` (already newest-first + defensively sorted, `src/lib/store.ts`), the `Transfer` shape (`recipientName` / `amountSource` / `sourceCurrency` / `status` / `createdAt` / `phone`, `src/lib/types.ts`), `easternDate` (`src/lib/dates.ts`), the round-0 note-injection slot in `runAgentTurn` (`src/lib/agent.ts`), and the `bot-content-guard` test harness. None of these are in flight in this batch. It is a **small (S)** batch — one new module, one ~3-line agent wiring, one test-file extension — and ships behind the safety invariant rather than a dormancy flag (it intentionally changes behavior for returning customers; the empty-note path keeps history-less customers unchanged).

---

## Key files (reference)

- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/recent-transfers.ts` — **new**: `getRecentTransfersNote(phone, store)` + the line formatter + `STATUS_LABEL` + `MAX_RECENT`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/agent.ts` — inject the note at round 0 in `runAgentTurn`, beside the existing `[NEW CONVERSATION]` / `[TIER_REMINDER]` / `[SEND CURRENCIES]` pushes (computed once via `deps.store`, only pushed when non-empty)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/store.ts` — `listTransfers()` (newest-first, defensively sorted) is the **read-only** source; **not modified**
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/types.ts` — `Transfer` (`recipientName` / `amountSource` / `sourceCurrency` / `status` / `createdAt` / `phone`); **unchanged** — no new field, no new `TransferStatus`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/dates.ts` — `easternDate` (the line date renderer)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/app/dashboard/transactions-tabs.tsx` — `money()` helper (`Intl.NumberFormat('en-US', { style: 'currency', currency })`) the note's amount renderer mirrors
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/tools.ts` — `list_saved_recipients` / `listSavedRecipientsTool` (the recipient-suggestion path this fix is ADDITIVE to, not a replacement for)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/bot-content-guard.test.ts` — extend the P2/P5/KYC scans to cover `src/lib/recent-transfers.ts` + a rendered-note behavioral guard
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/agent.test.ts` — extend with the wiring + the history-less-unchanged proof
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/docs/superpowers/specs/2026-05-29-payment-provider-seam-design.md` — the freshest spec whose structure this mirrors
- Current suite measured at 529 tests across 59 test files in `tests/`; projected delta +~18 → ~547.
