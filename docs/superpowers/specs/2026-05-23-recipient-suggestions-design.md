# AI Recipient Suggestions + WhatsApp Interactive Buttons — Design

**Date:** 2026-05-23
**Status:** Awaiting review
**Owner:** SendHome
**Batch:** Lane A (cheap wins, no external partnerships)

## Why

Today every conversation starts cold: the bot asks for the recipient name, phone, payout method, and destination — even from a customer who has already sent to "Mom" five times. That's the prototype tell that breaks the magic.

This batch makes the bot feel like a returning-customer product:

- Remember who each sender pays.
- Open conversations with a one-tap recipient picker.
- Replace text "yes/confirm" with a native WhatsApp **Approve & pay** button.

It also forces the codebase to grow two primitives — interactive-message send/parse, and a short-lived draft store — that future features (scheduling suggestions, in-chat status taps) will reuse.

## Scope

**In:**

1. Persist recipients per sender phone in Redis.
2. On the first message of a new conversation (no messages from this sender in the last 24 h), the bot calls `list_saved_recipients`; if results exist, sends an interactive picker.
3. New `send_recipient_picker` tool — wraps WhatsApp Cloud API interactive message of type `button`.
4. New `send_approve_picker` tool — used after `get_quote` to present `[Approve & pay]` and `[Cancel]` buttons.
5. New draft store for the brief window between quote and approval (10-minute TTL).
6. Extend webhook to parse `type: interactive` button replies, materialising them as synthetic text turns the agent reasons about.

**Out:**

- Cron-fired scheduled-transfer buttons (requires a separate approved template; deferred to a later batch).
- Defaulting amount from history ("send the usual $200?"). User explicitly chose to keep amount fresh per transfer.
- Sender-side recipient management UI (rename, delete, edit payout). Recipients self-prune by rolling out of the top-2.
- Per-recipient analytics on the dashboard.
- Migration backfilling historical transfers into the recipients hash — pre-launch transfers don't appear as buttons until the sender ships a new transfer.

## User-visible behaviour

```
[New customer]                                [Returning customer with 2+ saved recipients]
─────────────────────────────────────         ───────────────────────────────────────────────
USER: hi                                      USER: hi
BOT:  Hey 👋 I'm SendHome. How much            BOT:  Welcome back 👋 Who are we sending to?
      would you like to send to India?              [Mom] [Brother] [Someone new]
USER: $200                                    USER: *taps [Mom]*
BOT:  Got it. Bank, debit, or credit?         BOT:  How much do you want to send to Mom?
USER: bank                                    USER: $300
... (standard flow) ...                       BOT:  Bank, debit, or credit?
BOT:  Quote ready:                            USER: bank
      $200.00 + $1.99 fee                     BOT:  Sending $300 to Mom via UPI (mom@upi).
      → ₹16,820 to Mom                              Fee $1.99 (bank). She gets ₹25,200.
      [Approve & pay] [Cancel]                      [Approve & pay] [Cancel]
                                              USER: *taps [Approve & pay]*
                                              BOT:  Tap to pay securely: <link>
```

### Behavioural rules

| Sender state | Picker behaviour |
|---|---|
| 0 saved recipients | No picker. Cold-start prompt as today. |
| 1 saved recipient | Picker shows `[<Name>] [Someone new]` (2 buttons). |
| 2 saved recipients | `[<Name1>] [<Name2>] [Someone new]` (3 buttons). |
| 3+ saved recipients | Top-2 by `lastUsedAt` desc + `[Someone new]`. Older recipients accessible by typing name. |
| New conversation, but inside an existing flow | The "new conversation" gate is "no messages in the last 24 h". If a sender messages mid-flow, no picker — the agent continues the in-progress turn. |
| Outside 24 h customer-service window | Bot is replying to an inbound message, so by definition we're inside the window. Picker only ever sent in response to an inbound message. (Cron-fired notifications can't use buttons without a template; out of scope here.) |

### Button labels

- Recipient name truncated to 17 chars + `…` if longer (WhatsApp limit is 20).
- If two saved recipients share the same name (e.g. user's mom and spouse's mom), append a `(…NNNN)` suffix using the last 4 digits of the recipient phone, *only when collision detected*. Example: `[Mom (…3210)]` and `[Mom (…7890)]`. Single-name occurrences stay clean as `[Mom]`.
- The "Someone new" label is fixed; never collides.

### Body text fallback

Every interactive message includes a `body.text` that lists the same options in numbered form so users on outdated clients (or assistive tech that doesn't render buttons) can reply with the number:

```
Who are we sending to?
1. Mom
2. Brother
3. Someone new
```

The agent recognises numeric replies the same way it recognises tapped buttons.

## Data model

### `recipients:<senderPhone>` — Redis hash

| Field | Value |
|---|---|
| `<recipientPhone>` (e.g. `919876543210`) | JSON: `{ name, payoutMethod: 'upi'\|'bank', payoutDestination, lastUsedAt: ISO-8601 }` |

**Why hash, not list:**
- Upsert is O(1) on the natural identity key (recipient phone). List would require scan-and-rewrite.
- Two real people with the same display name coexist cleanly.
- Stale recipients self-prune at read time (we sort by `lastUsedAt` and slice to top-N).

**Why recipient phone as the field key:**
- A person's WhatsApp number is the most stable identity we have. UPI IDs and bank accounts change; phones rarely do.
- If a recipient's UPI changes from `mom@upi` → `mommy@upi`, the next transfer upserts in place — no duplicate "Mom" entries.

**Hash field encoding:**
- All `recipientPhone` values are normalised via the existing `normalizePhone` helper before being used as fields. Redis is byte-comparison strict; consistent normalization prevents accidental duplicates.

### `recipient_draft:<draftId>` — Redis string, 10-minute TTL

Drafts hold the pre-confirmation state between the moment the bot has all transfer details and the user tapping `[Approve & pay]`. Why a separate store rather than reusing the conversation history:

- TTL gives us automatic cleanup if the user abandons.
- Consumption is atomic (`GETDEL`) — concurrent taps can't double-charge.
- The draft holds the full quote (rate, fee, INR amount, locked at the moment the picker was sent), so the price the user sees on tap is the price we honour even if rates have moved in the meantime.

Draft JSON:

```ts
{
  senderPhone: string;
  recipient: { name, recipientPhone, payoutMethod, payoutDestination };
  amountUsd: number;
  fundingMethod: 'credit_card'|'debit_card'|'bank_transfer';
  quote: { feeUsd, fxRate, amountInr };
  createdAt: ISO-8601;
}
```

`draftId` is a generated id from the existing `id.ts` helper (URL-safe, ~12 chars).

### `lastmsg:<senderPhone>` — Redis string with 24-hour TTL

Tracks the time of the most recent inbound message from a sender. Set on every inbound. Used to detect "new conversation".

- Read with `EXISTS` on inbound — if `false`, this is a new conversation.
- Then `SET lastmsg:<senderPhone> <iso-timestamp> EX 86400` (always, on every inbound).
- The two-op pattern has a mild race only if the same sender sends two messages within milliseconds; the worst case is showing the picker twice. Acceptable.

This explicit signal replaces "LLM judgement about whether the user is starting fresh." Deterministic detection > model intuition.

## Architecture

```
inbound webhook (WhatsApp Cloud API)
        │
        ▼
parseIncoming(body)
   ├─ type === 'text'        → IncomingMessage { kind: 'text', from, text, messageId }
   └─ type === 'interactive' → IncomingMessage { kind: 'button',  from, buttonId, messageId }
        │
        ▼
/api/whatsapp/route.ts
   │  • Lookup last message timestamp; mark `isNewConversation` if > 24 h gap
   │  • For button replies, synthesize a text turn the agent sees:
   │      "[Tapped: Send to Mom (UPI mom@upi)]" + system hint with buttonId
   ▼
agent.runAgentTurn(senderPhone, message, { isNewConversation, buttonId? })
   │
   ▼
LLM (Kimi K2.6) chooses tools:
   ┌──────────────────────────────────────────────────────────────────┐
   │  list_saved_recipients()                                         │
   │     → returns top-N from recipients:<senderPhone>                │
   │  send_recipient_picker(recipients[])                             │
   │     → sendInteractive([recip1, recip2, "new"]) → { sent: true }  │
   │  get_quote(amount, fundingMethod)                                │
   │     → returns quote (UNCHANGED — stateless, no draft side-effect)│
   │  send_approve_picker(amount, fundingMethod, recipient*)          │
   │     → re-quotes, creates draft (10-min TTL),                     │
   │       sends [Approve & pay] [Cancel] interactive,                │
   │       returns { sent: true }. Agent has now relinquished control │
   │       to the user; next turn happens on button tap.              │
   │  create_transfer(draftId)  (called after Approve tap)            │
   │     → atomic consumeDraft(draftId), runs compliance,             │
   │       creates transfer, upserts recipient                        │
   │  cancel_draft(draftId)  (called after Cancel tap)                │
   │     → consumeDraft(draftId), bot acknowledges                    │
   └──────────────────────────────────────────────────────────────────┘
```

### Why draft creation lives in `send_approve_picker`, not `get_quote`

`get_quote` is called early — sometimes before the recipient is known (cold-start). The draft needs the *complete* transfer (recipient + amount + funding), so creating it inside `get_quote` forces an artificial restructure of the flow.

`send_approve_picker` is called exactly when the agent has assembled all transfer details and is about to ask for confirmation. That is the natural draft-creation moment. It re-quotes internally so the locked rate reflects the moment of approval-ask, not some earlier exploratory quote.

## File-level plan

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `Recipient`, `Draft`, `InteractiveButtonReply`, widen `IncomingMessage` to discriminated union. |
| `src/lib/store.ts` | Modify | Add `upsertRecipient`, `listRecipients(limit)`. |
| `src/lib/draft-store.ts` | **Create** | `createDraft`, `getDraft`, `consumeDraft` (atomic GETDEL), 10-min TTL. |
| `src/lib/whatsapp.ts` | Modify | Add `sendInteractive(to, body, buttons[])`; widen `parseIncoming` to discriminated union; export `BUTTON_LABEL_MAX = 20`, `MAX_BUTTONS = 3`. |
| `src/lib/whatsapp-buttons.ts` | **Create** | Pure helpers: `truncateLabel(name)`, `disambiguateNames(recipients)`, `recipientButtonId(phone)`, `parseButtonId(id) → { kind: 'recipient'\|'new'\|'approve'\|'cancel', ... }`. |
| `src/lib/tools.ts` | Modify | Add `list_saved_recipients`, `send_recipient_picker`, `send_approve_picker`, `cancel_draft`; modify `create_transfer` so when a `draftId` is provided by *agent context* (not LLM args) it consumes the draft instead of taking explicit args. Explicit-args path stays — the cron job uses it. `get_quote` is unchanged. |
| `src/lib/transfer-create.ts` | Modify | After transfer persists, call `store.upsertRecipient(...)`. Idempotent — repeat calls just bump `lastUsedAt`. |
| `src/lib/prompt.ts` | Modify | Add the GREETING & RETURNING CUSTOMERS section described below. |
| `src/app/api/whatsapp/route.ts` | Modify | Detect `isNewConversation` (last-message-time check), pass into the agent, synthesize button replies into text turns, route the synthetic turn through the existing agent loop. |
| `tests/recipient-store.test.ts` | **Create** | Upsert creates, upsert updates lastUsedAt, list returns top-N sorted, list returns [] when empty. |
| `tests/draft-store.test.ts` | **Create** | Round-trip, consume returns then deletes, TTL expiry. |
| `tests/whatsapp-buttons.test.ts` | **Create** | Truncation, disambiguation, button id parse/round-trip, malformed-input safety. |
| `tests/whatsapp.test.ts` | Modify | Add coverage for `sendInteractive` payload shape + the 24h-window error path; add cases for `parseIncoming` on interactive replies. |
| `tests/e2e.test.ts` | Modify | Add a returning-customer happy path: pre-seed a recipient, message "hi", expect picker, tap Mom, give amount, get quote, tap Approve, transfer delivered. |

## Agent-context plumbing (replay-safety)

A subtle but important detail. The agent loop receives more than just the user's text — it also receives a `TurnContext` object the LLM cannot see or fabricate:

```ts
interface TurnContext {
  isNewConversation: boolean;
  buttonTap?: {
    kind: 'recipient' | 'recipient_new' | 'approve' | 'cancel';
    draftId?: string;      // for approve/cancel
    recipientPhone?: string; // for recipient tap
  };
}
```

Tool implementations (server-side, in `tools.ts`) receive `TurnContext` as a hidden third argument. They use it for trust-sensitive decisions:

- `create_transfer` prefers `context.buttonTap.draftId` over any draftId the LLM might pass. The LLM physically cannot get the bot to consume a different draft than the one whose button the user actually tapped.
- `cancel_draft` likewise uses `context.buttonTap.draftId`.

The agent loop **also** synthesizes a human-readable text turn for the LLM ("[Tapped: Approve & pay]") so the LLM can reason about what just happened — but the *authority* for which draft to consume lives in the context object, not in that text. If the user types `[Tapped: Approve & pay]` literally in chat, the buttonTap field is undefined, and `create_transfer(draftId)` is forced to use the LLM-supplied draftId; the LLM has no reason to invent one without context, and even if it did, the worst case is a "draft not found" error. Fail closed.

This is the design pattern that prevents prompt-injection from being able to spend other senders' drafts.

## System-prompt addition

A new section near the top of `SYSTEM_PROMPT`:

```
GREETING & RETURNING CUSTOMERS
- The system tells you when a turn is the start of a new conversation
  (signalled in the user message as a "[NEW CONVERSATION]" prefix).
- On new conversations only, your first action is to call list_saved_recipients.
- If it returns 0 recipients, greet warmly and ask how much they want to send.
- If it returns 1 or more recipients, call send_recipient_picker with up to
  the top 2 (the tool returns immediately; do not also list them in text).
- If the user taps a recipient button you will see a synthetic message
  "[Tapped: Send to <Name> (<payout>)]". Skip recipient questions; only
  collect amount and funding method.
- If the user taps "[Tapped: Someone new]" run the cold-start flow.

QUOTE CONFIRMATION
- When you have ALL transfer details (amount, fundingMethod, recipient
  name, recipient phone, payoutMethod, payoutDestination), call
  send_approve_picker with those details. It will quote, lock the rate,
  create a draft, and send the user [Approve & pay] [Cancel] buttons.
- The user can also type "yes" / "confirm" / "cancel" as fallback; both work.
- When the user taps [Approve & pay], you'll see "[Tapped: Approve & pay]".
  Call create_transfer with NO arguments — the system supplies the draftId
  from the tap context. The draft contains everything.
- When the user taps [Cancel], you'll see "[Tapped: Cancel]". Call
  cancel_draft with no arguments, then send a brief acknowledgement.
```

## Reliability & error handling

This is the section the design lives or dies on. Every state transition that can fail is enumerated below with the chosen mitigation.

### Atomicity

| Concern | Mitigation |
|---|---|
| User taps `[Approve & pay]` twice (network lag retries the tap) | `consumeDraft` uses Redis `GETDEL` — atomic read-and-delete. The second invocation gets `null` and the bot replies "That quote was already approved; check WhatsApp for the payment link." |
| Two concurrent `create_transfer` calls for the same draft | Same `GETDEL` guard. Only one wins. |
| User taps `[Cancel]` then immediately taps `[Approve & pay]` (or vice versa) — both events delivered | First tap consumes the draft (cancel deletes it; approve consumes-then-creates-transfer). Second tap finds null and gets the expired-draft message. No double-action possible. |
| Saved-recipient upsert race (transfer A finishes while transfer B starts) | `HSET` is atomic per field. Both writes succeed; the later write's `lastUsedAt` wins. No data loss; ordering is best-effort. |

### Graceful degradation

| Failure | Behaviour |
|---|---|
| WhatsApp Cloud API returns 470 / 24h-window error on `sendInteractive` | Catch in `sendInteractive`, fall back to `sendText` with the body+numbered fallback text the picker would have included. Log a `warn` so we know if this is happening in production. |
| Redis transient unavailability on `listRecipients` | The agent treats it as "no recipients" and proceeds to the cold-start flow. Bot remains usable; user just doesn't see the picker that turn. Logged. |
| Redis unavailability on `upsertRecipient` after `create_transfer` succeeded | The transfer is already persisted (that's the source of truth). Log a `warn` and continue. Recipient gets re-saved on the *next* transfer. No user-facing failure. |
| Redis unavailability on `consumeDraft` (user taps Approve) | Bot replies "Something went wrong reading your quote. Could you send the request again?" The transfer is **not** created — failing closed is correct here. |
| Draft TTL expired before user taps | `consumeDraft` returns `null`. Bot: "That quote expired. Just say 'send to <Name>' or give me an amount and we'll re-quote." |
| User taps a recipient button after the recipient was somehow deleted from Redis between picker-send and tap (e.g. another conversation in a different client) | Agent re-reads the recipient via `list_saved_recipients`-style lookup on tap. If gone, bot: "That recipient is no longer saved. Who would you like to send to?" + cold flow. |

### Input validation

| Source | Validation |
|---|---|
| `buttonId` from incoming webhook | `parseButtonId` accepts only four prefixes (`recipient:<phone>`, `recipient:new`, `approve:<draftId>`, `cancel:<draftId>`). Anything else is rejected and the message is treated as raw text. No injection surface into Redis keys — the parser whitelists characters. |
| `draftId` in `create_transfer(draftId)` | Must match the existing `id.ts` format (URL-safe, fixed length). Mismatch → tool returns an error → agent reports it to the user. |
| Recipient name in `upsertRecipient` | Trimmed, truncated to 80 chars before write. (Long names handled by the existing transfer create path already, this just hardens the new path.) |
| Recipient phone in hash field | Normalised by `normalizePhone` before write *and* before read. Defends against double-saves when WhatsApp emits with/without a leading `+`. |

### 24h window mechanics (background)

WhatsApp Cloud API permits free-form messages (text + interactive) only when responding to a user-initiated message *within the last 24 hours*. Outside the window, you must use a pre-approved template. The picker and Approve flows are **always** replies to an inbound message, so they're always inside the window — except in the edge case where the Vercel function takes >24 h to respond (impossible in practice). We confirm by attempting `sendInteractive` and gracefully degrading on 470.

### Idempotency

- `upsertRecipient` is idempotent. Running it twice for the same transfer produces the same final state (latest `lastUsedAt` wins).
- `consumeDraft` is **not** idempotent by design — second call returns null. Callers must treat null as "already processed" not "error".
- `sendInteractive` is **not** idempotent (WhatsApp delivers twice). The agent ensures `send_recipient_picker` and `send_approve_picker` are called at most once per turn by checking conversation state.

## Testing strategy

Unit tests are TDD'd against the new pure helpers (`whatsapp-buttons`, `recipient-store`, `draft-store`). The agent-level tests use scripted Kimi responses (existing pattern). End-to-end test exercises the full returning-customer flow with `fakeRedis`.

Specific tests we need beyond happy-path:

- `consumeDraft` returns null on second call, not just on expired ttl.
- `sendInteractive` falls back to `sendText` on simulated 470 response.
- `parseButtonId` rejects 6 specific malformed inputs (empty, missing prefix, unknown prefix, embedded newline, phone with non-digits, missing colon).
- `disambiguateNames` only suffixes on collision; single names stay clean.
- `truncateLabel` preserves valid labels untouched; ellipsis is single `…` not `...`.
- Returning-customer e2e test asserts the second transfer's recipient hash has updated `lastUsedAt` (not duplicated).

## Acceptance criteria

- [ ] A sender with zero saved recipients sees no picker (existing flow unchanged).
- [ ] A sender with one saved recipient sees `[<Name>] [Someone new]` on greeting after >24 h.
- [ ] A sender with three or more saved recipients sees their two most-recently-used as buttons.
- [ ] Tapping a recipient button skips name / phone / payout-method / destination collection.
- [ ] After every `get_quote`, the bot follows with `[Approve & pay] [Cancel]` buttons.
- [ ] Tapping `[Approve & pay]` once creates exactly one transfer; tapping twice doesn't double-charge.
- [ ] Tapping `[Cancel]` deletes the draft, bot acknowledges, no transfer created.
- [ ] Tapping `[Approve & pay]` 11 minutes after the quote yields a friendly "quote expired" reply, no transfer.
- [ ] Typing "yes" or "confirm" after a quote still works as before.
- [ ] User typing "[Tapped: Approve & pay]" literally in chat (forgery attempt) does not create a transfer — agent context has no buttonTap, LLM has no real draftId to supply, `create_transfer` either is not called or returns "draft not found."
- [ ] `parseIncoming` returns `null` for malformed interactive payloads.
- [ ] `WhatsApp returned 470 (re-engagement)` on `sendInteractive` falls back to text; no crash.
- [ ] Existing `npm run typecheck`, `npm run lint`, `npm test`, `npm run e2e` (against prod) all pass.
- [ ] No regression on the dashboard Playwright smoke (it doesn't exercise WhatsApp).

## Open questions

None. Earlier draft asked about button count (resolved: 3 max → 2 saved + 1 new), amount defaulting (resolved: collect fresh), confirmation-button-only vs more (resolved: confirmation only for v1).

## Risks

| Risk | Mitigation |
|---|---|
| LLM forgets to call `list_saved_recipients` on new conversations | The `[NEW CONVERSATION]` synthetic prefix makes the trigger deterministic. If the LLM still skips it, an agent-level fallback re-injects the call (small extra cost; reliability win). Validated via the new e2e test. |
| LLM calls `send_recipient_picker` with more than 3 recipients | Tool input validation: server-side cap at 2 + "Someone new"; ignore excess silently. Logs a warn if hit. |
| WhatsApp button-tap webhooks land out-of-order with a follow-up text | The agent's turn-by-turn loop already processes messages in arrival order via the conversation history; each turn produces a complete reply. Out-of-order tap+text just becomes two sequential turns. |
| Saved recipient data leaks across sender phones (bug in key construction) | Key is `recipients:<senderPhone>`. Unit tests cover same-sender / different-sender isolation. `senderPhone` is normalized identically wherever it's used. |
| New e2e test becomes flaky | Use `fakeRedis` (in-memory, deterministic). Avoid sleeps; advance fake time explicitly for TTL tests. |

## Out of scope (reaffirmed)

- Cron-fired scheduled-transfer buttons.
- Amount-defaulting from history.
- Sender-side recipient management UI.
- Per-recipient analytics on the dashboard.
- Migration / backfill of pre-existing transfers into the recipients hash.
