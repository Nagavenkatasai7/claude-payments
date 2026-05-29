# Transfer Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Raj's complaint — *"yesterday's payments are not being remembered by our LLM."* Completed transfers are persisted in Redis (`transfer:<id>`, indexed by the `transfers:ids` set, read newest-first by `store.listTransfers()`) but are **never injected into the model's context**. In `runAgentTurn` (`src/lib/agent.ts:56-108`) the only customer-specific context the model sees is the chat transcript (`store.getConversation(phone)`, last 40 via `trimHistory`) plus saved recipients (only if the model itself calls `list_saved_recipients`). Across a day the "I sent Mom $500" exchange falls out of the 40-message window, so a returning customer is invisible. This batch adds a new read-only module `src/lib/recent-transfers.ts` → `getRecentTransfersNote(phone, store): Promise<string>` that filters `listTransfers()` to the calling customer's **own** transfers (strict sender-phone equality), takes the most recent 5, and renders a compact `[RECENT TRANSFERS]` block — one line each: human date (`easternDate`) · `recipientName` · amount in **source currency** · status label. It wires **one** call into `runAgentTurn`'s round-0 system-note block, alongside the existing `[NEW CONVERSATION]` / `[NEW CUSTOMER]` / `[TIER_REMINDER]` / `[SEND CURRENCIES]` pushes (agent.ts:78-107), appended **only when the returned string is non-empty**. This **intentionally changes behavior for returning customers** — that is the point — but is **byte-for-byte unchanged** for any customer with no transfer history (empty note ⇒ no push), read-only, schema-free, and partner-blind.

**Architecture:** This batch stacks on `spec/p4-multi-currency` (the current branch — P4 multi-currency mid-execution), which already gives every `Transfer` its `amountSource` / `sourceCurrency` fields. It depends only on already-present symbols: `store.listTransfers()` (store.ts:108-118, newest-first + defensively sorted `(b.createdAt ?? '').localeCompare(a.createdAt ?? '')`), the `Transfer` shape (`recipientName` / `amountSource` / `sourceCurrency` / `status` / `createdAt` / `phone`, types.ts:27-65), the `TransferStatus` union `awaiting_payment | paid | delivered | cancelled | blocked` (types.ts:5-10), `easternDate(epochMs: number)` (dates.ts:3), the round-0 note-injection slot in `runAgentTurn` (agent.ts:71-108), and the `bot-content-guard` test harness (tests/bot-content-guard.test.ts). None are in flight in this batch. It mirrors how the P4 `[SEND CURRENCIES]` note shipped: a small, scoped, round-0 injection that only fires when its precondition is met and is invisible otherwise. **Not a tool** — always available with no extra LLM round-trip, and not subject to the model forgetting to call it (the failure mode that already makes `list_saved_recipients` flaky on returning turns).

```
Incoming WhatsApp turn:  runAgentTurn(phone, incomingText, turn)        src/lib/agent.ts
  │  history       = store.getConversation(phone)        (transcript, last 40)
  │  noteCustomer  = customerStore.getCustomer(phone)
  │  notePartner   = partnerStore.getPartner(...) ?? ensureDefaultPartner()
  │  sendCurrencies= allowedSendCurrencies(notePartner)
  │  recentNote    = await getRecentTransfersNote(phone, deps.store)     ← NEW (once, before loop)
  ▼
for round 0:
  messages = [ { system: SYSTEM_PROMPT } ]
    if isNewConversation && round 0   → push [NEW CONVERSATION]
    if round 0 && isNewCustomer       → push [NEW CUSTOMER]
       else if tierReminderDayOfWindow→ push [TIER_REMINDER]
    if round 0 && sendCurrencies > 1  → push [SEND CURRENCIES: ...]
    if round 0 && recentNote          → push { system: recentNote }     ← NEW (only if non-empty)
    messages.push(...history)
  ▼
getRecentTransfersNote(phone, store)                                    src/lib/recent-transfers.ts (NEW)
  │  all  = await store.listTransfers()    (newest-first, defensively sorted)
  │  mine = all.filter(t => (t.phone ?? '') === phone)                  ← strict own-phone filter
  │  top  = mine.slice(0, MAX_RECENT)      (= 5)
  │  if top.length === 0  → return ''      ← history-less ⇒ inject nothing
  └─ return `[RECENT TRANSFERS] ...\n${top.map(formatLine).join('\n')}`
  ▼
messages → deps.chat(messages, toolSchemas) → model now SEES the customer's recent sends
```

The note is computed **once per turn** (a single `listTransfers()` read) but consulted only inside the `round === 0` branch — same lifecycle as `sendCurrencies`. It is pushed into the per-turn `messages` array only, **never** `history.push(...)`ed, so `saveConversation` does not persist it and it does not echo on later turns — identical to how `[NEW CONVERSATION]` / `[SEND CURRENCIES]` are handled. For a history-less customer `recentNote === ''`, the `push` is skipped and the messages array is identical to today's.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis, `Intl.NumberFormat` (source-currency amount rendering, the same renderer the dashboard's `money()` helper uses in `transactions-tabs.tsx`).

**Spec:** `../specs/2026-05-29-transfer-memory-design.md`

**Branch:** `spec/transfer-memory` (branch off the current `spec/p4-multi-currency` — `store.listTransfers()` newest-first + defensive sort, the `Transfer` fields `recipientName`/`amountSource`/`sourceCurrency`/`status`/`createdAt`/`phone`, `TransferStatus`, `easternDate`, the round-0 note slot in `runAgentTurn`, and the `bot-content-guard` harness are all already present on the working base here).

**Test count delta:** from **529** (current suite). New `tests/recent-transfers.test.ts` (~11); extensions to `tests/agent.test.ts` (~4) and `tests/bot-content-guard.test.ts` (~3). Net **+~18 → ~547**. The existing `agent.test.ts` cases (currency note / new-conversation / tier-reminder) stay **unmodified and green** — proof the new injection slot composes with the others; the history-less customer's `messages`-array-identical test is the executable proof the fix is additive.

**Patterns to reuse (do not reinvent):**
- **Round-0 system-note injection (the thing being mirrored):** `src/lib/agent.ts:78-107` — the `if (round === 0 && sendCurrencies.length > 1) messages.push({ role: 'system', content: ... })` block. `recentNote` is the **same shape**, new content: computed once before the `for (let round...)` loop (beside `noteCustomer`/`notePartner`/`sendCurrencies`, agent.ts:62-66) and pushed only at `round === 0` when non-empty. Pushed into `messages` **only**, never `history` — exactly like the existing notes (per the comment at agent.ts:72-74).
- **Defensive `?? ''` on Redis-resident strings/sorts:** `store.listTransfers()` (store.ts:113-117) sorts with `(b.createdAt ?? '').localeCompare(a.createdAt ?? '')`; `listRecipients` (store.ts:167) does the same on `lastUsedAt`. The new module reads every field with the same `?? ''` / `?? 'USD'` / `?? 0` discipline and never throws on a legacy record.
- **Source-currency amount renderer:** `src/app/dashboard/transactions-tabs.tsx` `money()` uses `new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)`. The note's `formatAmount` mirrors it exactly, with a `try/catch` fallback to a bare `${amount} ${currency}` if `Intl` rejects an unknown code.
- **The single date helper:** `easternDate(epochMs: number)` (dates.ts:3) — `new Date(epochMs).toLocaleDateString('en-US', { timeZone: 'America/New_York' })`. The note calls `easternDate(Date.parse(createdAt))`; no new clock dependency.
- **`fakeRedis()` + `createStore` in tests:** every store-touching test uses `createStore(fakeRedis())` and `await store.saveTransfer(...)` to seed (see `tests/store.test.ts`). `recent-transfers.test.ts` follows this verbatim.
- **`bot-content-guard` static-scan extension:** the existing P2 (`'partner'`), P5 (`corridor`/`watchlist`/`sanctions`), and KYC-PII scans iterate a `filesToScan` array and match `content:\s*['"\`]([^'"\`]*?)['"\`]/g` literals (tests/bot-content-guard.test.ts:10-31, 41-64, 66-81). Add `src/lib/recent-transfers.ts` to the relevant lists; the template is also a `content:` payload at the agent push site, so a behavioral guard over a rendered note backstops post-interpolation leaks.
- **Conventions:** TDD per task; `fakeRedis()` in tests; no `as any`; `??` (never `||`) for fallbacks; the bot stays partner-blind; **one atomic commit per task**; commit prefix `feat(memory):`.

**CI reminders:**
- `main` branch protection requires the `ci / ci` status check; no direct pushes. Open a PR; Vercel auto-deploys on merge; Playwright smoke runs against prod.
- The full local gate is `npm run typecheck && npm run lint && npx vitest run && npm run build`.
- The existing `tests/agent.test.ts` cases (currency / new-conversation / tier-reminder) must stay green **and unmodified** — if one needs editing to pass, the new injection slot has collided with an existing one; fix the wiring, not the test.
- GitGuardian may red on a known env-var-name false positive; `ci` is the required check.

---

## File Map

**New files:**
- `src/lib/recent-transfers.ts` — `getRecentTransfersNote(phone, store): Promise<string>` + the `formatLine`/`formatAmount` helpers + `STATUS_LABEL` (`Record<TransferStatus, string>`) + `MAX_RECENT = 5`. Read-only; depends only on `Store.listTransfers`, the `Transfer`/`TransferStatus` types, and `easternDate`.
- `tests/recent-transfers.test.ts` — module unit tests (~11), including the empty-history invariant, own-phone filter, cap-at-5, source-currency rendering, `blocked`→"on hold", defensive-on-missing-fields, and the token-bound assertion.

**Modified files:**
- `src/lib/agent.ts` — compute `recentNote` once before the round loop (beside `noteCustomer`/`notePartner`/`sendCurrencies`); push it as a round-0 `system` message after `[SEND CURRENCIES]` and before `messages.push(...history)`, only when non-empty. Uses `deps.store` (already on `AgentDeps`).
- `tests/agent.test.ts` — extend (~4) with the wiring + the history-less-unchanged proof.
- `tests/bot-content-guard.test.ts` — add `src/lib/recent-transfers.ts` to the static scans + a behavioral rendered-note guard (~3).

> Deliberately **not** modified: `src/lib/store.ts` (`listTransfers()` is the read-only source), `src/lib/types.ts` (no new `Transfer` field, no new `TransferStatus`), `src/lib/dates.ts`, `src/lib/tools.ts` / `src/lib/prompt.ts` (the `list_saved_recipients` recipient-suggestion path is untouched — this is additive context, not a replacement). No new Redis key, no new route, no new server action.

---

## Task 1: `getRecentTransfersNote` module — read-only, TDD'd

**Goal:** Create the whole `src/lib/recent-transfers.ts` module: `getRecentTransfersNote(phone, store)` reads `store.listTransfers()`, filters to the customer's **own** transfers by strict sender-phone equality, caps at the newest 5, and renders the compact `[RECENT TRANSFERS]` block — date (`easternDate`) · `recipientName` · source-currency amount · status label. Returns `''` when the customer has no matching transfers. **Read-only** (no Redis writes), no `as any`, defensive `?? ''` on every field it reads, `blocked`→"on hold". This is the literal embodiment of the safety invariant.

**Files:**
- Create: `src/lib/recent-transfers.ts`
- Test: `tests/recent-transfers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/recent-transfers.test.ts`. Seed transfers via `createStore(fakeRedis())` + `saveTransfer`, then assert on the rendered string. A small `mk()` builder keeps each case terse:

```ts
import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { getRecentTransfersNote } from '@/lib/recent-transfers';
import type { Transfer } from '@/lib/types';

let n = 0;
function mk(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `t_${n}`, phone: '+15551230000', amountUsd: 500, feeUsd: 5, totalChargeUsd: 505,
    fxRate: 83, amountInr: 41500, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: '2026-05-28T12:00:00Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 500, feeSource: 5, totalChargeSource: 505,
    ...over,
  } as Transfer;
}

async function storeWith(...transfers: Transfer[]) {
  const store = createStore(fakeRedis());
  for (const t of transfers) await store.saveTransfer(t);
  return store;
}

describe('getRecentTransfersNote — empty-history invariant', () => {
  it('returns "" when the customer has no transfers (inject nothing)', async () => {
    const store = await storeWith(mk({ phone: '+1999', id: 'other' }));
    expect(await getRecentTransfersNote('+15551230000', store)).toBe('');
  });
  it('returns "" for a totally empty store', async () => {
    expect(await getRecentTransfersNote('+15551230000', createStore(fakeRedis()))).toBe('');
  });
});

describe('getRecentTransfersNote — own transfers only (strict phone filter)', () => {
  it("never includes another customer's transfers", async () => {
    const store = await storeWith(
      mk({ id: 'mine', recipientName: 'Mom' }),
      mk({ id: 'theirs', phone: '+1999', recipientName: 'Stranger' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('Mom');
    expect(note).not.toContain('Stranger');
  });
  it('drops a legacy record with a missing phone (fail-closed, never leaks)', async () => {
    const store = await storeWith(
      mk({ id: 'mine', recipientName: 'Mom' }),
      mk({ id: 'legacy', recipientName: 'Ghost', phone: undefined as unknown as string }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('Mom');
    expect(note).not.toContain('Ghost');
  });
});

describe('getRecentTransfersNote — caps at the newest 5', () => {
  it('a 7-transfer customer yields exactly 5 lines, the newest 5, newest-first', async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      mk({ id: `c_${i}`, recipientName: `R${i}`, createdAt: `2026-05-2${i}T00:00:00Z` }),
    );
    const store = await storeWith(...seven);
    const note = await getRecentTransfersNote('+15551230000', store);
    const lines = note.split('\n').slice(1); // drop the preamble line
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('R6'); // newest (2026-05-26) first
    expect(note).not.toContain('R1'); // 2026-05-21 fell off the cap
    expect(note).not.toContain('R0');
  });
});

describe('getRecentTransfersNote — per-line content', () => {
  it('renders date (easternDate) · recipientName · source-currency amount · status label', async () => {
    const store = await storeWith(
      mk({ recipientName: 'Mom', amountSource: 500, sourceCurrency: 'USD', status: 'delivered',
           createdAt: '2026-05-28T12:00:00Z' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('5/28/2026'); // easternDate(Date.parse(createdAt)) in ET
    expect(note).toContain('Mom');
    expect(note).toContain('$500.00');   // Intl.NumberFormat en-US USD
    expect(note).toContain('delivered');
  });
  it('renders a non-USD source currency with its own symbol', async () => {
    const store = await storeWith(
      mk({ recipientName: 'Dad', amountSource: 300, sourceCurrency: 'GBP', status: 'paid' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('£300.00');
  });
  it('maps blocked → "on hold" and NEVER the raw token', async () => {
    const store = await storeWith(mk({ recipientName: 'Ravi', status: 'blocked' }));
    const note = (await getRecentTransfersNote('+15551230000', store)).toLowerCase();
    expect(note).toContain('on hold');
    expect(note).not.toContain('blocked');
  });
  it('renders human labels for each status', async () => {
    const store = await storeWith(
      mk({ id: 'a', recipientName: 'A', status: 'awaiting_payment', createdAt: '2026-05-28T05:00:00Z' }),
      mk({ id: 'c', recipientName: 'C', status: 'cancelled',        createdAt: '2026-05-28T04:00:00Z' }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('awaiting payment');
    expect(note).toContain('cancelled');
  });
});

describe('getRecentTransfersNote — defensive on missing fields', () => {
  it('never throws on missing createdAt / recipientName / sourceCurrency', async () => {
    const store = await storeWith(
      mk({ recipientName: '', createdAt: '' as unknown as string,
           sourceCurrency: undefined as unknown as Transfer['sourceCurrency'],
           amountSource: undefined as unknown as number }),
    );
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note).toContain('[RECENT TRANSFERS]'); // rendered, did not throw
    expect(note).toContain('a recipient');        // recipientName fallback
  });
});

describe('getRecentTransfersNote — token budget', () => {
  it('a 5-line note over long names stays within a fixed budget (6 lines, < 600 chars)', async () => {
    const long = Array.from({ length: 5 }, (_, i) =>
      mk({ id: `L_${i}`, recipientName: `Very Long Recipient Name Number ${i}`,
           createdAt: `2026-05-2${i}T00:00:00Z` }),
    );
    const store = await storeWith(...long);
    const note = await getRecentTransfersNote('+15551230000', store);
    expect(note.split('\n')).toHaveLength(6); // 1 preamble + 5 lines (cap holds)
    expect(note.length).toBeLessThan(600);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/recent-transfers.test.ts`
Expected: FAIL — module `@/lib/recent-transfers` not found.

- [ ] **Step 3: Implement `src/lib/recent-transfers.ts`**

```ts
import type { Store } from './store';
import type { Transfer, TransferStatus } from './types';
import { easternDate } from './dates';

const MAX_RECENT = 5; // last 5 of the already-newest-first list (fixed token cost)

// Customer-facing status labels. NEVER the raw internal token for `blocked` —
// the customer must never see compliance wording. bot-content-guard backstops this.
const STATUS_LABEL: Record<TransferStatus, string> = {
  awaiting_payment: 'awaiting payment',
  paid: 'paid',
  delivered: 'delivered',
  cancelled: 'cancelled',
  blocked: 'on hold',
};

function formatAmount(transfer: Transfer): string {
  // Mirrors the dashboard money() helper (transactions-tabs.tsx) — source
  // currency, customer-visible. amountSource ?? amountUsd defends pre-P4 records
  // (getTransfer already backfills amountSource = amountUsd, belt-and-braces here).
  const currency = transfer.sourceCurrency ?? 'USD';
  const amount = transfer.amountSource ?? transfer.amountUsd ?? 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`; // Intl rejected an unknown code — never throw
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
 *
 * Read-only: calls store.listTransfers() and nothing else — no Redis writes,
 * no schema change, no new key. Partner-blind by construction: surfaces only
 * recipientName + source-currency amount + status label + date (fields the
 * customer already owns). Strict own-phone filter; a legacy record with a
 * missing phone matches nothing and is dropped (fail-closed).
 */
export async function getRecentTransfersNote(phone: string, store: Store): Promise<string> {
  const all = await store.listTransfers();                   // newest-first, defensively sorted
  const mine = all.filter((t) => (t.phone ?? '') === phone); // strict own-phone filter
  const top = mine.slice(0, MAX_RECENT);
  if (top.length === 0) return '';                           // history-less ⇒ unchanged behavior
  const lines = top.map(formatLine);
  return (
    `[RECENT TRANSFERS] The customer's most recent sends (newest first), for context only — ` +
    `reference naturally if relevant, do not list them unprompted:\n${lines.join('\n')}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/recent-transfers.test.ts`
Expected: PASS — all ~11 cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. Nothing imports the module yet outside the test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/recent-transfers.ts tests/recent-transfers.test.ts
git commit -m "feat(memory): getRecentTransfersNote — read-only own-transfers round-0 note"
```

---

## Task 2: Wire the note into `runAgentTurn` (round-0 injection)

**Goal:** Compute `recentNote` once before the round loop (beside `noteCustomer`/`notePartner`/`sendCurrencies`), and push it as a `round === 0` `system` message **after** the `[SEND CURRENCIES]` push and **before** `messages.push(...history)`, only when non-empty. **No behavior change for a history-less customer** — `getRecentTransfersNote` returns `''`, which is falsy, so the `push` is skipped and the `messages` array is byte-for-byte identical to today's. The note is pushed into `messages` only, never `history`, so it is not persisted and does not echo. The existing `agent.test.ts` cases (currency / new-conversation / tier-reminder) stay green — proof the slot composes.

**Files:**
- Modify: `src/lib/agent.ts`
- Test: `tests/agent.test.ts`

- [ ] **Step 1: Confirm the baseline is green before wiring**

Run: `npx vitest run tests/agent.test.ts`
Expected: PASS — capture this; the existing cases must read identically after this task.

- [ ] **Step 2: Write the failing tests**

Add to `tests/agent.test.ts` (it already builds an agent with stubbed `deps` and a `chat` spy that captures `messages`). Mirror the existing currency-note test's structure — seed transfers via the same `store` the agent's `deps.store` points at, capture the `messages` passed to the first `chat` call, and assert on the round-0 system messages. Sketch:

```ts
describe('transfer-memory: [RECENT TRANSFERS] round-0 injection', () => {
  it('a returning customer WITH history gets a [RECENT TRANSFERS] system message at round 0', async () => {
    const { agent, store, chat } = makeAgent(); // existing helper in this file
    await store.saveTransfer(/* mk transfer for '+15551230000', recipient 'Mom' */);
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'hi' });

    await agent.runAgentTurn('+15551230000', 'did my payment go through?');

    const sent = chat.mock.calls[0][0] as Array<{ role: string; content: string | null }>;
    const note = sent.find((m) => m.role === 'system' && (m.content ?? '').includes('[RECENT TRANSFERS]'));
    expect(note).toBeDefined();
    expect(note!.content).toContain('Mom');
  });

  it('a customer with NO history gets NO such message (messages identical to baseline)', async () => {
    const { agent, store, chat } = makeAgent();
    // no transfers saved for this phone
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'hi' });

    await agent.runAgentTurn('+15551230000', 'hello');

    const sent = chat.mock.calls[0][0] as Array<{ role: string; content: string | null }>;
    expect(sent.some((m) => (m.content ?? '').includes('[RECENT TRANSFERS]'))).toBe(false);
  });

  it('the note is NOT persisted to history (absent from a subsequent turn transcript)', async () => {
    const { agent, store, chat } = makeAgent();
    await store.saveTransfer(/* mk transfer for '+15551230000' */);
    chat.mockResolvedValue({ role: 'assistant', content: 'ok' });

    await agent.runAgentTurn('+15551230000', 'turn one');
    const persisted = await store.getConversation('+15551230000');
    expect(persisted.some((m) => (m.content ?? '').includes('[RECENT TRANSFERS]'))).toBe(false);
  });

  it('the note carries no partnerId / compliance term', async () => {
    const { agent, store, chat } = makeAgent();
    await store.saveTransfer(/* mk blocked transfer for '+15551230000', partnerId 'default' */);
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'ok' });

    await agent.runAgentTurn('+15551230000', 'status?');
    const sent = chat.mock.calls[0][0] as Array<{ content: string | null }>;
    const note = (sent.find((m) => (m.content ?? '').includes('[RECENT TRANSFERS]'))!.content ?? '').toLowerCase();
    for (const term of ['partner', 'compliance', 'blocked']) expect(note).not.toContain(term);
  });
});
```

> Match this file's actual agent-construction helper and `mk`-transfer style; the asserts above are the load-bearing part. If the file's helper does not expose `store`/`chat`, follow the currency-note test's existing pattern for capturing the `chat` call and seeding the store.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL — the returning-customer test finds no `[RECENT TRANSFERS]` message; the others pass trivially (nothing injected yet).

- [ ] **Step 4: Wire the note into `src/lib/agent.ts`**

Add the import beside the other lib imports (after agent.ts:12):

```ts
import { getRecentTransfersNote } from './recent-transfers'; // NEW (transfer-memory)
```

Compute it once before the loop — right after `const sendCurrencies = allowedSendCurrencies(notePartner);` (agent.ts:66):

```ts
    // Recent-transfer memory: the customer's OWN recent sends, surfaced once at
    // round 0 so the model can reference "you sent Mom $500 yesterday". '' when
    // the customer has no history ⇒ nothing is injected (behavior unchanged).
    const recentNote = await getRecentTransfersNote(phone, deps.store);
```

Push it inside the existing round-0 block — immediately after the `[SEND CURRENCIES]` push (agent.ts:100-107) and before `messages.push(...history);` (agent.ts:108):

```ts
      if (round === 0 && recentNote) {
        messages.push({ role: 'system', content: recentNote });
      }
```

> `if (round === 0 && recentNote)` — an empty string is falsy, so the history-less customer's `messages` array is untouched (the invariant). No `turn` flag is needed; presence of history is the precondition. Uses `deps.store`, already on `AgentDeps` (agent.ts:20) — no new dependency added.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent.test.ts`
Expected: PASS — the new ~4 cases plus every existing case (currency / new-conversation / tier-reminder) unchanged and green.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent.ts tests/agent.test.ts
git commit -m "feat(memory): inject [RECENT TRANSFERS] note at round 0 (only when non-empty)"
```

---

## Task 3: `bot-content-guard` extension — partner-/compliance-blind by test

**Goal:** The note is generated content that reaches a chat message's `content:` field, so it must clear the same partner-blind / compliance-blind bar as `prompt.ts` / `agent.ts` / `tools.ts`. Two complementary guards: (a) add `src/lib/recent-transfers.ts` to the existing P2 / P5 / KYC static `content:`-literal scans (covers the `STATUS_LABEL` map and the template literal); (b) a behavioral guard that renders a real note over fixture transfers — including a `blocked` one — and asserts it leaks none of the forbidden vocabulary and never the raw `blocked` token, while customer-owned data **is** present. The static scan can't catch a leak that only appears after interpolation, so the behavioral check asserts on the actual output string.

**Files:**
- Modify: `tests/bot-content-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend `tests/bot-content-guard.test.ts`. First add `'src/lib/recent-transfers.ts'` to the P2 `filesToScan` (line 10-16), the P5 `filesToScan` (line 42), and the KYC `filesToScan` (line 67) — these iterate `content:` literals and assert the forbidden terms are absent. The `STATUS_LABEL` map values (`'on hold'`, etc.) and the template are written as plain string literals, but to be matched by the existing `content:\s*['"\`]...` regex the template would need a `content:` prefix; since the module assigns the note to a return value (not a `content:` field), add a **module-source scan** that reads the file raw and asserts the forbidden tokens never appear as bare literals, plus the behavioral guard:

```ts
describe('transfer-memory: recent-transfers module + rendered note stay partner-/compliance-blind', () => {
  it('the module source contains none of the forbidden tenant/compliance terms', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/recent-transfers.ts'), 'utf-8').toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions', 'compliance'])
      expect(src).not.toContain(term);
    // 'blocked' MUST appear once — as the STATUS_LABEL KEY mapping to 'on hold' —
    // but never as a value the customer sees. Assert the mapping is to 'on hold'.
    expect(src).toContain("blocked: 'on hold'");
  });

  it('a rendered note (incl. a blocked transfer) leaks no tenant/compliance internals', async () => {
    const { createStore } = await import('@/lib/store');
    const { fakeRedis } = await import('./helpers');
    const { getRecentTransfersNote } = await import('@/lib/recent-transfers');
    const store = createStore(fakeRedis());
    const base = {
      id: 'g1', phone: '+1555', amountUsd: 500, feeUsd: 5, totalChargeUsd: 505, fxRate: 83,
      amountInr: 41500, recipientName: 'Mom', recipientPhone: '919', payoutMethod: 'upi',
      payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
      complianceReasons: [], status: 'delivered', createdAt: '2026-05-28T12:00:00Z',
      partnerId: 'default', sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
      destinationCurrency: 'INR', amountSource: 500, feeSource: 5, totalChargeSource: 505,
    };
    await store.saveTransfer(base as never);
    await store.saveTransfer({ ...base, id: 'g2', recipientName: 'Ravi', status: 'blocked',
      createdAt: '2026-05-27T12:00:00Z' } as never);

    const note = (await getRecentTransfersNote('+1555', store)).toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions', 'blocked', 'compliance', 'partnerid'])
      expect(note).not.toContain(term);
    expect(note).toContain('mom');     // customer-owned data IS present
    expect(note).toContain('on hold'); // blocked surfaced as the soft label
  });
});
```

- [ ] **Step 2: Run it to verify it fails (or confirm the static-list additions hold)**

Run: `npx vitest run tests/bot-content-guard.test.ts`
Expected: the new `describe` block FAILS only if the module leaks a term (it should not — Task 1 mapped `blocked`→"on hold" and reads no tenant fields). If Task 1 is correct, the behavioral assertions pass on first run; the static-list additions for `recent-transfers.ts` pass because the module has no offending `content:` literal. The point of this task is to **lock in** the regression net, so confirm the block runs and is green; if any assert is red, the leak is real — fix `recent-transfers.ts`, not the test.

- [ ] **Step 3: (If needed) reconcile**

If `expect(src).not.toContain('partner')` fails, it means a comment or identifier in `recent-transfers.ts` uses the word — reword the comment (the doc-comment in Task 1 deliberately avoids "partner" in favor of "partner-blind by construction" → confirm it does not literally contain `partner`; if it does, change to "tenant-blind"). Re-run.

- [ ] **Step 4: Run green**

Run: `npx vitest run tests/bot-content-guard.test.ts`
Expected: PASS — the existing P2 / P5 / KYC scans (now including `recent-transfers.ts`) plus the new behavioral block.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tests/bot-content-guard.test.ts
git commit -m "feat(memory): bot-content-guard scans recent-transfers module + rendered note"
```

---

## Task 4: Wrap — full verification, PR, post-merge runbook

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (~547 tests). The pre-batch 529 staying green — `agent.test.ts`'s existing currency / new-conversation / tier-reminder cases unmodified — is the proof the injection slot composes; the history-less-customer messages-identical test is the proof the fix is additive.

- [ ] **Step 2: Confirm the safety invariant by hand**

Verify the read-only / additive / partner-blind claims explicitly:
- `git diff main -- src/lib/store.ts src/lib/types.ts src/lib/dates.ts src/lib/tools.ts src/lib/prompt.ts` → **empty** (no schema change, no new key, no `TransferStatus`/`Transfer` field, the `list_saved_recipients` path untouched).
- `git diff --name-only main` lists **only**: `src/lib/recent-transfers.ts`, `src/lib/agent.ts`, `tests/recent-transfers.test.ts`, `tests/agent.test.ts`, `tests/bot-content-guard.test.ts`.
- `getRecentTransfersNote` calls **only** `store.listTransfers()` — grep the module for `save`/`set`/`incr`/`sadd`/`hset` → **none** (read-only proof).
- History-less customer: the `agent.test.ts` "NO such message" case asserts the `messages` array has no `[RECENT TRANSFERS]` entry (byte-for-byte-unchanged proof).
- `blocked` never reaches chat: the `STATUS_LABEL` map (`blocked: 'on hold'`) + the `bot-content-guard` rendered-note assert.
- The note is not persisted: the `agent.test.ts` subsequent-turn-transcript case.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/transfer-memory
gh pr create --title "feat(memory): surface recent transfer history to the WhatsApp bot (round-0 note)" --body "$(cat <<'EOF'
## Summary
- Fixes Raj's complaint — "yesterday's payments are not being remembered by our LLM." Completed transfers live in Redis (`transfer:<id>`, indexed by `transfers:ids`, read newest-first by `store.listTransfers()`) but were NEVER injected into the model's context: `runAgentTurn` only ever saw the chat transcript (last 40 msgs) plus saved recipients (and only if the model called `list_saved_recipients`). A returning customer who sent Mom $500 yesterday was invisible once that exchange fell out of the 40-message window.
- NEW read-only module `src/lib/recent-transfers.ts` → `getRecentTransfersNote(phone, store)`: filters `listTransfers()` to the customer's OWN transfers (strict sender-phone equality), takes the newest 5, and renders a compact `[RECENT TRANSFERS]` block — one line each: date (`easternDate`) · recipientName · amount in SOURCE currency (`Intl.NumberFormat`, the dashboard's renderer) · status label. `blocked` → "on hold" — the compliance token never reaches chat.
- Wired ONE call into `runAgentTurn`'s round-0 system-note block (beside `[NEW CONVERSATION]` / `[NEW CUSTOMER]` / `[TIER_REMINDER]` / `[SEND CURRENCIES]`), pushed into `messages` only (never `history`), and ONLY when non-empty.
- NOT a tool: always available, no extra LLM round-trip, no "model forgot to ask" failure mode.

## Safety invariant (the executable proof)
- Read-only: `getRecentTransfersNote` calls only `store.listTransfers()` — no Redis writes, no schema change, no new key, no new `TransferStatus`/`Transfer` field, no new route, no new server action.
- A customer with NO transfer history gets `''` ⇒ nothing is injected ⇒ the round-0 `messages` array is byte-for-byte identical to today's (explicit `agent.test.ts` test).
- Partner-blind by construction AND by test: `bot-content-guard` scans the module source AND a rendered note (incl. a `blocked` fixture) for `partner`/`corridor`/`watchlist`/`sanctions`/`blocked`/`compliance`.
- The pre-batch 529-test suite stays green; `agent.test.ts`'s currency / new-conversation / tier-reminder cases are unmodified.

## Test plan
- [ ] typecheck / lint / vitest / build all green (~547 tests)
- [ ] `git diff main -- src/lib/store.ts src/lib/types.ts src/lib/tools.ts src/lib/prompt.ts` is empty (read-only / additive / no-replacement proof)
- [ ] New: `recent-transfers` (empty-history invariant, own-phone filter, cap-at-5, source-currency render, blocked→on-hold, defensive-on-missing, token budget); extensions to `agent` (round-0 wiring, history-less-unchanged, not-persisted, no-tenant-term) and `bot-content-guard` (module + rendered-note scan)

## Out of scope (deferred)
- Full conversation summarization (transcript trimming `MAX_HISTORY = 40` unchanged); spending analytics / insights / totals; proactive cross-day status push notifications
- A secondary `transfers:phone:<phone>` index — `listTransfers()` full-scan + filter is fine at prototype scale; the index is the scale-up move
- Changing the `list_saved_recipients` recipient-suggestion path — this is ADDITIVE context, not a replacement
- A `recent_transfers` tool — explicitly rejected in favor of the always-injected note
EOF
)"
```

- [ ] **Step 4: Confirm `ci / ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red on the known env-var-name false positive.)

- [ ] **Step 5: Post-merge runbook**

After merge → Vercel auto-deploys → Playwright smoke runs against prod. **No migration runs** — the fix reads existing `transfer:<id>` records via `listTransfers()` and adds no key namespace. Live behavior: a returning customer who has sent before now gets a compact `[RECENT TRANSFERS]` note injected at round 0, so the bot can answer "did my last payment go through?" or naturally reference "you sent Mom $500 yesterday." A history-less (or brand-new) customer is completely unaffected — empty note, no push, identical `messages`. Token cost is bounded: at most 5 short lines + a one-line preamble (~90-120 tokens) added to round 0 only, on turns where the customer has history; zero for history-less customers. If `listTransfers()` full-scan ever becomes a latency concern at scale, the documented next step is a secondary `transfers:phone:<phone>` index (Out of scope here).

---

## Self-Review (completed by plan author)

**Spec coverage (tasks → spec sections):**
- §Component 1 (`getRecentTransfersNote` + `formatLine`/`formatAmount` + `STATUS_LABEL` + `MAX_RECENT`; read-only via `store.listTransfers()`; strict `(t.phone ?? '') === phone` filter; cap at newest 5; source-currency `Intl.NumberFormat`; `blocked`→"on hold"; `''` on no history; defensive `?? ''`/`?? 'USD'`/`?? 0`) → **Task 1**.
- §Component 2 (agent injection: compute `recentNote` once before the loop via `deps.store`, push as a round-0 system message after `[SEND CURRENCIES]` and before `messages.push(...history)`, only when non-empty, never `history.push`ed) → **Task 2**.
- §Component 3 (`bot-content-guard` extension: `recent-transfers.ts` added to the P2/P5/KYC scans + a behavioral rendered-note guard over a `blocked` fixture asserting absence of `partner`/`corridor`/`watchlist`/`sanctions`/`blocked`/`compliance` and presence of customer-owned data) → **Task 3**.
- §The safety invariant (read-only; no schema change; no new key/`TransferStatus`/`Transfer` field/route/server action; history-less ⇒ `''` ⇒ messages byte-for-byte identical; 529-suite + `bot-content-guard` green) → proven as units in **Task 1** (empty-history + read-only), at the wiring in **Task 2** (history-less-unchanged + not-persisted), by test in **Task 3** (partner-blind), and whole-suite-green + empty `git diff` on `store.ts`/`types.ts`/`tools.ts`/`prompt.ts` in **Task 4**.
- §Security/privacy notes (own transfers only via strict phone filter; legacy missing-`phone` records dropped fail-closed; customer-visible fields only — no `partnerId`/`complianceStatus`/`complianceReasons`/transfer `id`/`payoutDestination`/recipient phone/USD-FX internals; no new attack surface — not a tool, not a route, not a server action) → **Tasks 1 + 3** + the no-tenant-term agent test in **Task 2**.
- §Testing strategy → new `recent-transfers.test.ts` (~11) + extensions to `agent.test.ts` (~4) and `bot-content-guard.test.ts` (~3); existing `agent.test.ts` cases unmodified; projected +~18 → ~547 from 529.
- §Open questions resolved: (1) **5** transfers, a single `MAX_RECENT` module constant (Task 1); (2) injected on **every** turn's round 0 — one `listTransfers()` read, always available so the model can answer mid-conversation (Task 2); (3) date format = `easternDate` (Task 1, dates.ts:3); (4) per-line source-currency amounts, no aggregation (Task 1 `formatAmount`).

**Placeholder scan:** No TBD/TODO. Every code step cites symbols verified in this session — `runAgentTurn`'s round-0 push block + the `noteCustomer`/`notePartner`/`sendCurrencies` setup it sits beside (`agent.ts:62-108`), the `AgentDeps.store` it reuses (`agent.ts:20`), `store.listTransfers()`'s newest-first defensive sort `(b.createdAt ?? '').localeCompare(a.createdAt ?? '')` (`store.ts:108-118`), `easternDate(epochMs: number)` returning ET `M/D/YYYY` (`dates.ts:3-5`), the `TransferStatus` union `awaiting_payment | paid | delivered | cancelled | blocked` (`types.ts:5-10`), the `Transfer` fields `phone`/`recipientName`/`amountSource`/`sourceCurrency`/`amountUsd`/`status`/`createdAt` (`types.ts:27-65`), `getTransfer`'s pre-P4 lazy-fill `amountSource = amountUsd` (`store.ts:75-80`), and the `bot-content-guard` `content:\s*['"\`]([^'"\`]*?)['"\`]/g` scan over `filesToScan` (`tests/bot-content-guard.test.ts:10-31, 41-64, 66-81`). The rendered example `5/28/2026` matches `easternDate(Date.parse('2026-05-28T12:00:00Z'))` in ET; `$500.00` / `£300.00` match `Intl.NumberFormat('en-US', { style: 'currency', currency })`.

**Type consistency:** `MAX_RECENT = 5` (number); `STATUS_LABEL: Record<TransferStatus, string>` (all five keys); `formatAmount(transfer: Transfer): string`; `formatLine(transfer: Transfer): string`; `getRecentTransfersNote(phone: string, store: Store): Promise<string>` — returns `''` on no history, a `[RECENT TRANSFERS]`-prefixed multi-line string otherwise. Agent wiring: `const recentNote: string` (computed once); `if (round === 0 && recentNote) messages.push({ role: 'system', content: recentNote })` — `content` is `string`, matching `ChatMessage` (`types.ts:82-89`). No `as any`; `??` (never `||`) for the `?? ''` / `?? 'USD'` / `?? 0` fallbacks; the `Intl.NumberFormat` call is wrapped in `try/catch` so an unknown currency code never throws. No new `Transfer` field, no new `TransferStatus`, no new Redis key, no new route, no new server action. ✓
