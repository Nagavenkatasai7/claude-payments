# UX Batch (Recipient-Amount-First + Flows Scaffolding) — Design

**Status:** design drafted 2026-05-29. Awaiting spec review → implementation plan.

**Sub-project:** the SendHome chat-UX polish batch. Two customer-facing wins that make the WhatsApp send flow feel more like a product and less like a form: (A) let a customer say *"send Mom ₹40,000"* and have the bot back-solve the dollar amount, instead of forcing everyone to think in dollars; and (B) lay the plumbing for **WhatsApp Flows / interactive lists** — a richer interactive primitive than the 3-button reply we use today — without betting prod on a Meta-Business-verified WABA that the test number doesn't have. Win B ships as a flag-gated, fallback-to-buttons scaffold: the *unit-testable* parts (message construction, reply parsing, fallback selection) are the deliverable; the live Flow send is gated off.

Both wins are **additive**. The send-amount-first path (`amount_usd`) is byte-for-byte unchanged; the recipient-amount branch only fires when the new `amount_inr` arg is present. The Flows primitive defaults **off** and falls back to the existing `sendInteractive` buttons when the flag is off OR the send fails — so with the flag off, prod behavior is byte-for-byte identical to today. The existing **~549-test suite staying green** plus **`bot-content-guard` green** is the executable proof.

**Explicitly NOT in this batch:** FX rate-lock / multi-partner best-rate selection (the FX/settlement-provider feature that ties to the `PaymentProvider` seam + admin/API rate entry) is **deferred to the next batch**. Voice-note intent is out (needs an STT provider). A Meta-**published** multi-screen Flow JSON is out (it requires the verified WABA the test number lacks).

---

## Goal

Two wins, both small, both additive:

- **Win A — Recipient-amount-first quoting.** `get_quote` gains an **optional** target rupee amount `amount_inr`. When present, the tool back-solves the source send amount via a new pure helper `sourceForInr(amountInr, rates)` in `src/lib/fx.ts`, then calls the **unchanged** `quote(amountSource, …)`. The recipient gets the **exact** target INR; the fee is added on top to the sender (today's model). The customer can now ask in either direction — *"send $500"* or *"send Mom ₹40,000"* — and `prompt.ts` explains both.
- **Win B — WhatsApp Flows scaffolding (flag-gated, button fallback).** A richer interactive primitive (`sendFlow` / `sendList`) lands alongside the existing `sendInteractive` button sender in `src/lib/whatsapp.ts`, with its reply shape parsed in `parseIncoming` (`src/lib/whatsapp.ts`) and routed in the webhook (`src/app/api/whatsapp/route.ts` + `whatsapp-buttons.ts`). It is gated behind a new env flag and **falls back to the existing buttons** when the flag is off OR the live send fails. **One** existing interaction — the recipient picker (`send_recipient_picker`) — is wired to optionally use the richer primitive behind the flag, falling back to buttons. **Default (flag off) = today's button behavior, byte-for-byte.**

## The safety invariant (the thing every task protects)

> **Win A is additive.** `quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount)` is **unchanged** — same MIN/MAX, same fee math, same `Math.round(amountSource * rates.toInr)` forward line, same return shape. The new `sourceForInr` is a **pure** inverse helper; the receive-first branch in `getQuoteTool` runs **only** when `amount_inr` is passed. The send-amount-first path (`amount_usd` only) is **byte-for-byte unchanged**. The back-solved `amountSource` flows through the **same** `quote()` MIN/MAX and the **same** USD-equivalent cap / velocity / EDD accounting (P4) — **no accounting change**.
>
> **Win B is flag-off-by-default + button fallback.** With the flag off, `send_recipient_picker` calls `sendInteractive` exactly as today and the webhook parses exactly today's `button_reply` shape — the messages array, the buttons, and the parsed taps are **byte-for-byte identical** to today's. When the flag is on but the live Flow/list send throws (the test WABA is not Meta-Business-verified), the tool **falls back to the same `sendInteractive` buttons**, so a failed Flow never degrades the flow.
>
> The existing **~549-test suite stays green** and **`bot-content-guard` stays green** — together these are the executable proof that this batch is additive, partner-blind, and prod-safe. **No new `TransferStatus`, no new `Transfer` field, no schema change.**

This mirrors how `[SEND CURRENCIES]` (P4) and the recipient-picker buttons (recipient-suggestions batch) shipped: a small, scoped, precondition-gated addition that is invisible when its precondition isn't met.

## Locked design decisions (2026-05-29)

1. **This batch = exactly two wins.** (A) recipient-amount-first quoting + (B) WhatsApp Flows scaffolding. FX rate-lock / multi-partner best-rate selection is **explicitly deferred** to a separate next batch (it's the FX/settlement-provider best-rate feature — ties to the `PaymentProvider` seam, admin + API rate entry — **not** in scope here). **Voice is out** (needs an STT provider).
2. **Win A — receive-first is an additive branch.** `get_quote` gains an **optional** `amount_inr`. New pure helper in `src/lib/fx.ts`:
   `sourceForInr(amountInr, rates) = round2(amountInr / rates.toInr)` — the exact inverse of the forward `amountInr = Math.round(amountSource * rates.toInr)` line in `quote()`. When `amount_inr` is present, `getQuoteTool` computes `amountSource = sourceForInr(amount_inr, rates)` and calls the **unchanged** `quote(amountSource, sourceCurrency, rates, funding_method, transferCount)`. The **recipient gets the exact target INR**; the fee is added on top to the sender (today's model). If **both** `amount_inr` and `amount_usd` are given, **`amount_inr` wins**. Validate `amount_inr` **finite & > 0** (`Number.isFinite`); on invalid, return a `QuoteError`-style `{ error }`. The send-amount-first path is **byte-for-byte unchanged**.
3. **Win A — no accounting change.** The back-solved `amountSource` flows through the **same** `quote()` MIN/MAX (`MIN_USD`/`MAX_USD`, evaluated on the USD-equivalent inside `quote`) and the **same** USD-equivalent cap / velocity / EDD accounting (P4). The tool returns the **same** result shape (`amount_source` / `amount_usd` / `amount_inr` / `fee_*` / `fx_rate` / …) regardless of which direction the customer asked. `prompt.ts` explains the customer can ask either direction.
4. **Win B — richer primitive, flag-gated, button-fallback.** Add `sendFlow` / `sendList` (recommendation: **interactive list** — see Open question 1) to `src/lib/whatsapp.ts` alongside `sendInteractive`, mirroring its Meta Graph API call shape. Parse its reply (`interactive.list_reply` / `interactive.nfm_reply`) in `parseIncoming`, alongside today's `button_reply` parsing, and route it in the webhook + `whatsapp-buttons.ts`. **Gate behind a new env flag** (recommendation: `WHATSAPP_FLOWS_ENABLED`). **Fall back to `sendInteractive` buttons** when the flag is off OR the live send throws (the test WABA is **not** Meta-Business-verified, so a real Flow send may fail — fallback keeps prod identical). Wire **one** existing interaction — `send_recipient_picker` — to optionally use the richer primitive behind the flag.
5. **Win B — default off = unchanged.** With the flag off, `send_recipient_picker` is byte-for-byte today's `sendInteractive(...)` call and the webhook parses today's `button_reply` only. The **unit-testable parts** (message construction, reply parsing, fallback selection) are the deliverable; the **live send is gated**. Do **not** depend on a Meta-published multi-screen Flow JSON that can't run on the test number.
6. **Dormancy / safety.** Both wins additive. Win A fires only on `amount_inr`; Win B is flag-off-by-default + button fallback ⇒ default behavior byte-for-byte unchanged. The existing ~549-test suite staying green + `bot-content-guard` green = the proof. **No new `TransferStatus`; reuse existing fields.**
7. **Conventions.** TDD per task; `fakeRedis()` in tests; **no `as any`**; defensive on untrusted LLM amounts (`Number(...)` + `Number.isFinite`) and on untrusted webhook reply shapes (`?? ''`, optional-chaining, `Number.isFinite`); the bot stays **partner-blind**; commit prefix **`feat(ux):`**; **one atomic commit per task**.

---

## Architecture

### Win A — recipient-amount-first quoting (additive branch in `getQuoteTool`)

```
LLM tool call:  get_quote({ amount_usd?, amount_inr?, funding_method, source_currency? })
  │
  ▼  getQuoteTool(args, ctx)                                   src/lib/tools.ts
  │  transferCount = await ctx.store.getTransferCount(phone)
  │  { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency)
  │
  │  ── NEW additive branch (only when amount_inr present) ──
  │  if (Number.isFinite(Number(args.amount_inr)) && Number(args.amount_inr) > 0):
  │       amountSource = sourceForInr(Number(args.amount_inr), rates)   ← src/lib/fx.ts (NEW pure)
  │                    = round2(amount_inr / rates.toInr)               ← exact inverse of forward line
  │  else:                                          ← UNCHANGED send-first path
  │       amountSource = Number(args.amount_usd)
  │
  ▼  q = quote(amountSource, sourceCurrency, rates, funding_method, transferCount)   ← UNCHANGED
  │     • same MIN_USD/MAX_USD guard (on USD-equivalent)
  │     • same fee math, same amountInr = Math.round(amountSource * rates.toInr)
  │     • recipient gets the target INR; fee added on top to sender
  ▼  return { source_currency, amount_source, fee_source, …, amount_inr, fx_rate, … }  ← SAME shape
```

For the send-first call (`amount_usd` only, no `amount_inr`) the path is the **same lines as today** — the `if` is skipped, `amountSource = Number(args.amount_usd)`, identical downstream. Cap / velocity / EDD accounting downstream (`check_send_limit`, `send_approve_picker`, `create_transfer`) is untouched: it already operates on the USD-equivalent of whatever `amountSource` is produced.

### Win B — Flows scaffolding (flag-gated primitive + button fallback)

```
LLM tool call:  send_recipient_picker({ recipients: [...] })
  │
  ▼  sendRecipientPickerTool(args, ctx)                        src/lib/tools.ts
  │  capped = rawList.slice(0,2)…                              (UNCHANGED build of capped + labels)
  │  buttons = [...recipientButtons, { someoneNew }]            (UNCHANGED)
  │
  │  if (env.whatsappFlowsEnabled):              ← NEW flag (default false)
  │     try   sendList(phone, header, rows)       ← NEW richer primitive (src/lib/whatsapp.ts)
  │     catch fall back → sendInteractive(phone, body, buttons)   ← today's call, byte-for-byte
  │  else:
  │     sendInteractive(phone, body, buttons)     ← today's call, byte-for-byte (default path)
  ▼  return { sent: true, via: 'list' | 'buttons' }            (for tests; bot ignores it)

Incoming reply:
  Meta webhook POST → parseIncoming(body)                      src/lib/whatsapp.ts
  │  interactive.type === 'button_reply'  → { kind:'button', buttonId }   (UNCHANGED)
  │  interactive.type === 'list_reply'    → { kind:'button', buttonId }   ← NEW: same id grammar
  ▼  route.ts: parseButtonId(buttonId) → ButtonTap → synthesizeButtonText  (UNCHANGED downstream)
```

The list rows reuse the **same id grammar** as today's buttons (`recipient:<phone>` / `recipient:new`, parsed by the unchanged `parseButtonId`), so a list reply collapses into the existing `{ kind: 'button', buttonId }` `IncomingMessage` and flows through `parseButtonId` → `ButtonTap` → `synthesizeButtonText` with **zero** new downstream branches. The only new parse surface is recognizing `list_reply` (and, for forward-compat, `nfm_reply`) as a source of a button id.

---

## Components

### (A.1) `sourceForInr` — `src/lib/fx.ts`

A pure helper, the exact inverse of the forward `amountInr` line in `quote()`. Sits beside `quote` / `round2` / `MIN_USD` / `MAX_USD`.

```ts
// The exact inverse of the forward line inside quote():
//   amountInr = Math.round(amountSource * rates.toInr)
// Back-solves the source send amount so the RECIPIENT receives the target INR.
// The fee is added on top to the sender by quote() (unchanged) — today's model.
export function sourceForInr(amountInr: number, rates: FxRates): number {
  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    throw new QuoteError('Please give a valid rupee amount.');
  }
  if (!Number.isFinite(rates.toInr) || rates.toInr <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  return round2(amountInr / rates.toInr);   // same round2 quote() uses
}
```

Notes:
- **Pure + exact inverse.** Uses the same `round2` `quote()` uses. Because the forward line is `Math.round(amountSource * rates.toInr)`, a back-solved `amountSource` re-quoted forward lands on the target INR ±1 rupee (integer-rounding); the helper does **not** re-derive INR — `quote()` re-derives it and that recomputed `amountInr` is what's returned/shown, so the displayed rupee figure is always `quote()`'s own number (single source of truth, no drift between branches).
- **Validates its own inputs** (`Number.isFinite`, `> 0`) — defense in depth even though `getQuoteTool` also pre-validates; throws the existing `QuoteError` so the tool's existing `catch (err instanceof QuoteError)` maps it to `{ error }` with no new error path.
- **No MIN/MAX here.** The back-solved `amountSource` is handed to `quote()`, which applies `MIN_USD`/`MAX_USD` on the USD-equivalent exactly as for a send-first amount — so an INR amount that maps below $10 or above $2,999 is rejected by the **same** guard with the **same** message.

### (A.2) `get_quote` schema + receive-first branch — `src/lib/tools.ts`

The `get_quote` schema gains an optional `amount_inr`; `amount_usd` becomes optional (one of the two must be present); the tool grows one additive branch.

```ts
// get_quote schema: add amount_inr (optional), relax required.
properties: {
  amount_usd: { type: 'number', description: "Amount to send, in the sender's send currency (US dollars unless told otherwise). Provide this OR amount_inr." },
  amount_inr: { type: 'number', description: 'Target rupees the RECIPIENT should receive. Provide this when the customer asks in rupees (e.g. "send Mom ₹40,000"). If given, it wins over amount_usd; the fee is added on top to the sender.' },
  funding_method: { /* unchanged */ },
  source_currency: { /* unchanged */ },
},
required: ['funding_method'],   // was ['amount_usd','funding_method']; amount now via amount_usd OR amount_inr
```

```ts
async function getQuoteTool(args, ctx): Promise<ToolResult> {
  try {
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);

    // ── NEW additive branch: receive-first when amount_inr is present (it wins) ──
    const inr = Number(args.amount_inr);
    let amountSource: number;
    if (args.amount_inr !== undefined && Number.isFinite(inr) && inr > 0) {
      amountSource = sourceForInr(inr, rates);          // back-solve; recipient gets exact INR
    } else if (args.amount_inr !== undefined) {
      return { error: 'Please give a valid rupee amount.' };   // present but invalid
    } else {
      amountSource = Number(args.amount_usd);           // UNCHANGED send-first path
    }

    const q = quote(amountSource, sourceCurrency, rates, args.funding_method as FundingMethod, transferCount);
    return { source_currency: q.sourceCurrency, amount_source: q.amountSource, fee_source: q.feeSource,
             total_charge_source: q.totalChargeSource, amount_usd: q.amountUsd, fee_usd: q.feeUsd,
             total_charge_usd: q.totalChargeUsd, fx_rate: q.fxRate, amount_inr: q.amountInr,
             delivery_estimate: q.deliveryEstimate };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}
```

Notes:
- **`amount_inr` wins.** When present and valid, `amount_usd` is ignored — matches the locked decision and is the natural reading of *"actually, make it ₹40,000"*.
- **Untrusted-amount discipline.** `Number(args.amount_inr)` + `Number.isFinite` + `> 0` (an LLM can pass `"40000"`, `null`, `NaN`, negatives). Send-first keeps `Number(args.amount_usd)` exactly as today; `quote()`'s own `Number.isFinite(amountSource)` guard is the backstop.
- **Result shape unchanged.** Both directions return the identical key set, so `prompt.ts`'s confirmation phrasing and `send_approve_picker` (which re-quotes from `amount_usd` = the source amount) need no shape change. The send-first downstream tools are untouched — receive-first is **only** in `get_quote`; once quoted, the customer confirms a concrete source amount and the rest of the flow is the existing one.
- **Byte-for-byte send-first.** When `amount_inr` is absent, the executed lines reduce to `amountSource = Number(args.amount_usd)` then the unchanged `quote(...)` call — identical to today.

### (A.3) Prompt — `src/lib/prompt.ts`

A short addition under `WHAT TO COLLECT` / `FLOW` explaining the two directions; no behavioral rule change.

```
- The amount can be given EITHER as dollars to send OR as the rupees the recipient should
  receive. If the customer says an amount in rupees (e.g. "send Mom ₹40,000"), pass it to
  get_quote as amount_inr (NOT amount_usd); the recipient gets exactly that amount and the
  fee is added on top to the sender. If they say dollars, pass amount_usd as today. Never
  convert between the two yourself — get_quote does the FX.
```

Notes:
- Reuses the existing "never invent rates / always call `get_quote`" discipline; just teaches the model the `amount_inr` direction. Partner-blind (no tenant vocabulary) — `bot-content-guard` already scans `prompt.ts`.

### (B.1) `sendList` (richer primitive) + fallback contract — `src/lib/whatsapp.ts`

A new sender mirroring `sendInteractive`'s Meta Graph API call shape, but emitting an interactive **list** (recommendation — Open question 1). It **throws on non-OK** like `sendInteractive`, so the caller's `try/catch` selects the button fallback; it keeps `sendInteractive`'s existing **HTTP 470** (24h-window) → `sendText` fallback for parity.

```ts
export interface ListRow { id: string; title: string; description?: string }

/**
 * Send an interactive LIST message (single section). Richer than the 3-button
 * reply: up to 10 rows. Throws on a non-OK, non-470 response so the CALLER can
 * fall back to sendInteractive buttons. 470 (outside 24h window) falls back to
 * sendText with a numbered list, matching sendInteractive.
 */
export async function sendList(
  to: string, bodyText: string, buttonLabel: string, rows: ListRow[],
): Promise<void> {
  if (rows.length === 0 || rows.length > 10) {
    throw new Error(`sendList: WhatsApp list accepts 1-10 rows (got ${rows.length}).`);
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.whatsappToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'list', body: { text: bodyText },
        action: { button: buttonLabel, sections: [{ rows: rows.map((r) => ({
          id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }] },
      },
    }),
  });
  if (res.ok) return;
  if (res.status === 470) {
    const numbered = rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
    await sendText(to, `${bodyText}\n\n${numbered}`); return;
  }
  const body = await res.text();
  throw new Error(`WhatsApp list send failed (${res.status}): ${body}`);
}
```

Notes:
- **Same call shape** as `sendInteractive` (same URL, headers, `messaging_product`/`to`/`type:'interactive'` envelope) — only the `interactive` body differs (`type:'list'` + `sections`). This is the unit-testable deliverable (fetch is stubbed in tests, asserting the body shape).
- **Throws ⇒ caller falls back.** Any non-OK, non-470 (including the not-verified-WABA rejection) throws, and `sendRecipientPickerTool` catches it and re-sends with `sendInteractive`. 470 keeps the same `sendText` numbered-list fallback `sendInteractive` already has.
- **Row id grammar = button id grammar.** Rows carry `recipient:<phone>` / `recipient:new` ids (built by the existing `recipientButtonId` / `someoneNewButtonId`), so the reply parses with the unchanged `parseButtonId` — no new id format, no new validation regex.
- A `sendFlow` (true Flow message, `interactive.type:'flow'`) is **named but deferred** — it depends on a published Flow JSON the test WABA can't run (Out of scope). `sendList` is the primitive we can actually exercise end-to-end on the test number when verified; until then it's flag-off + fallback. (Open question 1 lets the reviewer pick `sendList` vs a stub `sendFlow`.)

### (B.2) Webhook reply parsing — `src/lib/whatsapp.ts` (`parseIncoming`) + `whatsapp-buttons.ts`

`parseIncoming` learns to recognize an interactive **list reply** (and, forward-compat, a Flow `nfm_reply`) as another source of a button id, collapsing it into the existing `{ kind: 'button', buttonId }` `IncomingMessage`.

```ts
// WebhookShape.interactive gains list_reply / nfm_reply (all optional):
interactive?: {
  type?: string;
  button_reply?: { id?: string; title?: string };
  list_reply?:   { id?: string; title?: string };          // NEW
  nfm_reply?:    { response_json?: string };                // NEW (forward-compat; Flow)
};

// In parseIncoming, after the existing button_reply branch:
if (message.type === 'interactive' && message.interactive?.type === 'list_reply'
    && message.interactive.list_reply?.id) {
  return { kind: 'button', from: message.from,
           buttonId: message.interactive.list_reply.id, messageId: message.id };
}
```

Notes:
- **No new `IncomingMessage` kind.** A list-row tap is, semantically, a button tap with an id — reusing `kind: 'button'` means `route.ts` (`parseButtonId` → `ButtonTap` → `synthesizeButtonText`) and `whatsapp-buttons.ts` need **zero** changes. The existing `button_reply` branch is **untouched** (so default behavior is byte-for-byte identical).
- **Defensive on untrusted shape.** Same `try/catch` + optional-chaining + `?? `-guarded reads `parseIncoming` already uses; a malformed `list_reply` (missing `id`) returns `null` (drops, fail-closed), exactly like a malformed `button_reply`.
- **`nfm_reply` is forward-compat only** (the shape a real Flow submission arrives in). This batch adds the field to the type and *may* add a minimal parse, but does **not** depend on it (no published Flow to produce it). Recommendation: add the type field, defer the parse body to the FX/next batch unless a stub keeps the surface honest (Open question 3).

### (B.3) Env flag — `src/lib/env.ts`

One new getter, mirroring the existing optional-flag pattern (`cronSecret`, `seedPartner*`, `paymentProviderMode`).

```ts
get whatsappFlowsEnabled(): boolean {
  // Default OFF. The test WABA is not Meta-Business-verified, so a live Flow/list
  // send may be rejected; OFF keeps prod on today's buttons byte-for-byte.
  return process.env.WHATSAPP_FLOWS_ENABLED === 'true';
},
```

Notes:
- **Default false** (anything other than the literal `'true'` ⇒ off), matching `paymentProviderMode`'s strict-literal pattern. Documented in `.env.example`.
- Read **once** in `sendRecipientPickerTool` (Component B.4); no other call site.

### (B.4) `send_recipient_picker` wiring — `src/lib/tools.ts`

The one interaction wired to the richer primitive behind the flag, with a button fallback on flag-off **or** send-failure. The build of `capped` / `labels` / `buttons` is **unchanged**; only the send is selected.

```ts
async function sendRecipientPickerTool(args, ctx): Promise<ToolResult> {
  // ... UNCHANGED: build `capped`, `labels`, `buttons` (incl. "Someone new") ...
  const body = 'Welcome back 👋 Who are we sending to?';

  if (env.whatsappFlowsEnabled) {
    const rows: ListRow[] = buttons.map((b) => ({ id: b.id, title: b.title }));  // same ids/labels
    try {
      await sendList(ctx.phone, body, 'Choose recipient', rows);
      return { sent: true, via: 'list' };
    } catch (err) {
      console.warn('sendList failed; falling back to buttons:', err);             // fail → buttons
    }
  }
  await sendInteractive(ctx.phone, body, buttons);   // today's call, byte-for-byte (default + fallback)
  return { sent: true, via: 'buttons' };
}
```

Notes:
- **Default path identical.** Flag off ⇒ the `if` is skipped ⇒ the single `sendInteractive(ctx.phone, body, buttons)` is **the exact call today** with the **exact** body/buttons. The `via` field is for tests only; `executeTool`'s result isn't shown to the user verbatim.
- **Two fallbacks, one destination.** Flag off → buttons; flag on but `sendList` throws (unverified WABA, >10 rows impossible here since ≤3, network) → caught → buttons. Either way the customer sees a working picker.
- **Same ids** flow to the list rows, so a list-row tap parses identically to a button tap (Component B.2) — the rest of the recipient-tap flow (`[Tapped: Send to recipient <phone>]`) is unchanged.
- **Only this one interaction is wired.** `send_approve_picker` (Approve/Cancel) stays on `sendInteractive` — out of scope to widen now; the recipient picker is the locked single wiring.

---

## Security / privacy notes

- **Untrusted LLM amounts, validated + cap-checked (Win A).** `amount_inr` is coerced with `Number(...)` and gated on `Number.isFinite && > 0` before `sourceForInr`; `sourceForInr` re-validates and throws `QuoteError` on bad input or a non-positive `rates.toInr`. The back-solved `amountSource` is **not** trusted past `get_quote`: the confirm/create flow re-derives the USD-equivalent and runs the **same** `evaluateCap` / velocity / `evaluateEdd` checks (`check_send_limit`, `send_approve_picker`, `create_transfer`) — a customer cannot use the rupee direction to dodge a cap, because `MIN_USD`/`MAX_USD` and the cap are evaluated on the USD-equivalent of whatever amount is produced.
- **Untrusted webhook reply shape, guarded (Win B).** `parseIncoming` stays inside its `try/catch`; the new `list_reply` / `nfm_reply` reads are optional-chained and a missing `id` returns `null` (drop, fail-closed). Row ids are re-validated by the **existing** `parseButtonId` regexes (`PHONE_RE` / `DRAFT_RE`) before any `ButtonTap` is built — a row carrying a malformed or injected id is rejected exactly as a malformed button id is today. No new id grammar = no new injection surface.
- **Partner-blind.** Neither win surfaces tenant/compliance vocabulary. Win A's prompt addition and the picker body/labels contain none of `partner`/`corridor`/`watchlist`/`sanctions`; `bot-content-guard` already scans `prompt.ts`/`tools.ts` and the picker labels are derived from the customer's own recipient names. The `via` debug field never reaches the customer.
- **No new public attack surface.** No new route, no new server action (the server-action security checklist doesn't apply — nothing is POSTable beyond the existing webhook, which is unchanged in entry shape). `sendList` is an outbound Graph API call gated by an env flag; the live send is **off by default**.
- **Fail-safe send.** A Flow/list send rejected by the unverified WABA is caught and downgraded to buttons — a customer never sees a dead interaction because the richer primitive failed.

## Testing strategy

Per-component (TDD; `fakeRedis()` for the store; `fetch` stubbed for the senders):

- **`fx.test.ts` (extend, ~6 cases) — Win A inverse:** `sourceForInr(40000, { toInr: 80, toUsd: 1 })` returns `500` (round-trips: `quote(500,…).amountInr === 40000`); `sourceForInr` throws `QuoteError` on `0` / negative / `NaN` / `Infinity` `amountInr` and on `toInr <= 0`; `round2` applied (e.g. an INR amount that back-solves to a fractional cent rounds to 2dp); a back-solved amount below `MIN_USD` / above `MAX_USD`, when fed to `quote()`, throws the **same** `QuoteError` as a send-first out-of-range amount.
- **`tools.test.ts` (extend, ~6 cases) — Win A branch + send-first regression:** `get_quote({ amount_inr: 40000, funding_method })` returns a result whose `amount_inr === 40000` (recipient gets the exact target) and whose `amount_source` is the back-solved figure; `amount_inr` **wins** when both `amount_inr` and `amount_usd` are passed; an invalid `amount_inr` (`-1` / `'abc'` / `0`) returns `{ error }`; and — the **regression proof** — `get_quote({ amount_usd: 500, funding_method })` (no `amount_inr`) returns **byte-for-byte the same** result object as before the batch (assert against a captured baseline). Both directions return the identical key set.
- **`whatsapp.test.ts` (extend, ~6 cases) — Win B primitive + parse:** `sendList` POSTs the expected `interactive.type:'list'` body shape (assert the stubbed `fetch` JSON, incl. row ids/titles); `sendList` throws on a non-OK non-470 response (so the caller can fall back) and falls back to `sendText` on 470; `parseIncoming` maps an `interactive.list_reply` payload to `{ kind:'button', buttonId }` with the row id; a malformed `list_reply` (missing `id`) returns `null`; an existing `button_reply` payload still parses **byte-for-byte** as today (regression).
- **`tools.test.ts` (extend, ~5 cases) — Win B wiring + fallback + flag-off-unchanged:** with the flag **off**, `send_recipient_picker` calls **`sendInteractive`** with today's body + buttons and **never** calls `sendList` (the byte-for-byte-unchanged proof — assert the stubbed senders); with the flag **on**, it calls `sendList` with rows carrying the same ids; with the flag **on** and `sendList` stubbed to **throw**, it falls back to `sendInteractive` (same buttons) and still returns `{ sent: true }`. (Flag toggled via stubbing `env.whatsappFlowsEnabled`.)
- **`bot-content-guard.test.ts` (extend, ~2 cases):** the `get_quote` `amount_inr` description, the prompt addition, and the picker list body/labels carry none of `partner`/`corridor`/`watchlist`/`sanctions`; `src/lib/whatsapp.ts`'s new strings are covered by the existing content scan.
- **Whole-suite regression (must stay green):** the full pre-batch suite — every test untouched except the additions above — is the executable proof that send-first quoting, the existing button picker, the webhook button path, and cap/velocity/EDD accounting are all unbroken.

Rough test-count delta from **~549**: `fx.test.ts` (~6) + `tools.test.ts` (~11, Win A + Win B) + `whatsapp.test.ts` (~6) + `bot-content-guard.test.ts` (~2) ≈ **+~25 → ~574**, with all existing tests unmodified.

## Acceptance criteria

- [ ] `src/lib/fx.ts` exports `sourceForInr(amountInr, rates): number = round2(amountInr / rates.toInr)`, the exact inverse of `quote()`'s forward `amountInr` line; throws `QuoteError` on non-finite / `<= 0` `amountInr` or `toInr <= 0`. `quote()` itself is **byte-for-byte unchanged**.
- [ ] `get_quote` accepts an **optional** `amount_inr`; when present and valid it back-solves `amountSource` via `sourceForInr` and the **recipient receives the exact target INR**; `amount_inr` **wins** over `amount_usd`; an invalid `amount_inr` returns `{ error }`.
- [ ] The send-amount-first path (`amount_usd` only, no `amount_inr`) returns **byte-for-byte the same** `get_quote` result as before the batch; both directions return the identical key set; cap / velocity / EDD accounting is unchanged.
- [ ] `src/lib/whatsapp.ts` exports a richer primitive (`sendList`) that POSTs the `interactive` list body shape, **throws** on non-OK (non-470) so the caller can fall back, and keeps the 470 → `sendText` fallback.
- [ ] `parseIncoming` recognizes an `interactive.list_reply` (and types `nfm_reply`) as a `{ kind:'button', buttonId }` `IncomingMessage` using the **same id grammar**; the existing `button_reply` path is unchanged; a malformed reply returns `null`.
- [ ] `src/lib/env.ts` exposes `whatsappFlowsEnabled` (default **false**, strict `'true'` literal); documented in `.env.example`.
- [ ] `send_recipient_picker`: **flag off** ⇒ calls `sendInteractive` with today's body + buttons, byte-for-byte, and never calls `sendList`; **flag on** ⇒ uses `sendList`, **falling back to `sendInteractive`** when the send throws. Only this one interaction is wired.
- [ ] `prompt.ts` explains the customer can ask in dollars or rupees; partner-blind; `bot-content-guard` stays green.
- [ ] **No** new `TransferStatus`, **no** new `Transfer` field, **no** schema change, **no** new route, **no** new server action.
- [ ] The full pre-batch suite passes; the send-first and existing-button-path tests are unmodified and green.

## Open questions

1. **`sendList` vs a stub `sendFlow` for the richer primitive.** Recommendation: **`sendList`** (WhatsApp interactive list, 1–10 rows). It is a real, fully-formed message we can construct, unit-test, and — once the WABA is verified — send end-to-end on the test number, and its reply (`list_reply`) collapses into the existing button-id grammar with zero downstream change. A true `sendFlow` (`interactive.type:'flow'`) needs a **published** Flow JSON the unverified test WABA can't run, so it would be a stub today. Ship `sendList` as the working primitive; add a `sendFlow` **name + type field** as a forward hook only if the reviewer wants the seam visible now (Open question 3).
2. **Flag name.** Recommendation: **`WHATSAPP_FLOWS_ENABLED`** (boolean, default false), matching the family of optional env flags (`CRON_SECRET`, `SEED_PARTNER_*`, `PAYMENT_PROVIDER_MODE`) and the locked decision's wording. Alternative `WHATSAPP_RICH_PICKER` reads narrower but undersells the forward intent; recommendation stays `WHATSAPP_FLOWS_ENABLED`.
3. **Wire `nfm_reply` parse now, or type-only?** Recommendation: **type-only** this batch (add the field to `WebhookShape.interactive`, no parse body) — there is no published Flow to produce an `nfm_reply`, so a parse path would be untestable end-to-end. Add the actual `response_json` parse when a real Flow lands (the FX/next batch, or whenever the WABA is verified). This keeps the surface honest without dead, untested code.
4. **Which interaction to wire (locked: the recipient picker).** Confirmed: `send_recipient_picker` only. The Approve/Cancel picker (`send_approve_picker`) is a **2-button** confirm that maps poorly to a list and is on the money-movement-critical path; leave it on `sendInteractive`. Recommendation: **keep the wiring to the recipient picker** as locked; revisit `send_approve_picker` (e.g. a Flow form) only after the WABA is verified.
5. **Does `amount_inr` need its own MIN/MAX in rupees, or is the USD MIN/MAX enough?** Recommendation: **USD MIN/MAX is enough** — the back-solved `amountSource` hits the same `MIN_USD`/`MAX_USD` guard in `quote()`, so a too-small/too-large rupee amount is rejected with today's message. No separate INR bound (it would be a second source of truth that could drift from the FX rate).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Receive-first branch changes the send-first result (invariant break) | Low | High | The branch is gated on `amount_inr !== undefined`; send-first reduces to the same `amountSource = Number(args.amount_usd)` + unchanged `quote()` lines; explicit byte-for-byte send-first regression test asserts the result object. |
| Rounding drift: shown INR ≠ requested INR | Medium | Medium | `quote()` re-derives `amountInr` from the back-solved source and **that** number is shown — single source of truth. The forward `Math.round` means the displayed figure can differ from the requested by ≤1 rupee; acceptable and within the existing rounding model (documented; tested via round-trip). |
| LLM passes a junk `amount_inr` (`null`/`NaN`/negative/string) | Medium | Medium | `Number(...)` + `Number.isFinite && > 0` in the tool; `sourceForInr` re-validates and throws `QuoteError` → `{ error }`; never reaches `quote()` as NaN. |
| Customer uses the rupee direction to dodge a cap | Low | High | Back-solved `amountSource` flows through the **same** USD-equivalent `MIN_USD`/`MAX_USD` + cap/velocity/EDD checks; no accounting change. |
| Live Flow/list send fails on the unverified test WABA and the picker breaks | Medium | High | Flag **off by default**; when on, `sendList` throws on non-OK and the tool **falls back to `sendInteractive`** buttons; 470 keeps the `sendText` fallback. Default-off + fallback both proven by tests. |
| `list_reply` parse regresses the existing `button_reply` path | Low | High | New branch is **additive** after the untouched `button_reply` branch; reuses `kind:'button'` + the unchanged `parseButtonId`; explicit "existing button_reply still parses byte-for-byte" regression test. |
| Flag accidentally enabled in prod before WABA verification | Low | Medium | Strict `'true'` literal; default off; documented in `.env.example`; even if flipped, the fallback keeps the picker working (it just attempts the list first). |
| Untrusted/injected row id in a `list_reply` | Low | Medium | Re-validated by the existing `parseButtonId` `PHONE_RE`/`DRAFT_RE`; a bad id yields `null` (drop, fail-closed) — same as today's button ids. |

## Out of scope (deferred)

- **FX rate-lock / multi-partner best-rate FX** — the FX/settlement-provider best-rate feature (ties to the `PaymentProvider` seam, admin + API rate entry, per-partner quoted rates). This is the **NEXT batch**, explicitly not here. This batch's quoting still uses the single live Frankfurter rate via `getFxRates`.
- **Voice-note intent** — needs an STT provider/key; out.
- **A Meta-published, multi-screen Flow JSON** — requires a Meta-Business-verified WABA the test number lacks. We scaffold the **send/parse primitive + fallback**; we do **not** depend on a published Flow that can't run on the test number.
- **Rate prediction / alerts** — no "rate will rise/fall," no scheduled rate notifications.
- **Wiring ANY interaction to the richer primitive** -- DEFERRED (user decision 2026-05-29). The seam (`sendList` + `list_reply` parse + flag) ships UNWIRED this batch; wiring `send_recipient_picker` (or the approve step) is a future batch.
- **A real `nfm_reply` (Flow submission) parse body** — type-only this batch; the parse lands with a real published Flow (Open question 3).

## Sequencing note

This batch stacks on `spec/p4-multi-currency` (current branch), which already gives `quote()` / `Quote` the `amountSource` / `sourceCurrency` / `feeSource` fields and `getFxRates → { toInr, toUsd }` that `sourceForInr` and the receive-first branch depend on. It is a **small (S)** batch — one new pure helper, one additive tool branch + a one-line prompt note, one new sender + a webhook parse branch + one env flag + one tool wiring — and ships behind the safety invariant (additive Win A + flag-off-default-with-fallback Win B) rather than a dormancy flag for Win A.

**The FX rate-lock / multi-partner best-rate selection is the NEXT batch.** It is the larger, separately-scoped feature: it introduces per-partner / per-provider quoted rates, an admin + API rate-entry surface, and a rate-lock token on the draft — all of which hang off the `PaymentProvider` seam (see `docs/superpowers/specs/2026-05-29-payment-provider-seam-design.md`). This UX batch deliberately does **not** touch FX selection so the two can be reviewed and shipped independently; receive-first quoting here uses the existing single live rate and will compose cleanly with multi-rate selection when that lands (the back-solve is rate-agnostic — it inverts whatever `rates.toInr` is in effect).

---

## Key files (reference)

- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/fx.ts` — **add** `sourceForInr(amountInr, rates)` beside `quote` / `round2` / `MIN_USD` / `MAX_USD`; `quote()` **unchanged**
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/tools.ts` — `get_quote` schema gains optional `amount_inr` (relax `required`); `getQuoteTool` gains the receive-first branch; `sendRecipientPickerTool` gains the flag-gated `sendList`-with-button-fallback wiring
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/whatsapp.ts` — **add** `sendList` (richer primitive, throws-to-fall-back); extend `parseIncoming` + `WebhookShape` for `list_reply` (+ type `nfm_reply`); `sendInteractive` + the `button_reply` branch **unchanged**
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/whatsapp-buttons.ts` — **unchanged**; `parseButtonId` + the `recipient:`/`recipient:new` id grammar are reused as-is by list rows
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/app/api/whatsapp/route.ts` — **unchanged**; a `list_reply` collapses into the existing `{ kind:'button' }` → `parseButtonId` → `ButtonTap` → `synthesizeButtonText` path
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/env.ts` — **add** `whatsappFlowsEnabled` (default false, strict `'true'`), mirroring `paymentProviderMode`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/prompt.ts` — short addition: the customer can ask in dollars or rupees; pass rupees as `amount_inr`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/rate.ts` — `getFxRates → { toInr, toUsd }`; the rate `sourceForInr` inverts; **unchanged**
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/types.ts` — `Quote` (`amountSource` / `sourceCurrency` / `feeSource`, P4); **unchanged** — no new field, no new `TransferStatus`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/fx.test.ts` — extend with the `sourceForInr` inverse + round-trip + bounds cases
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/tools.test.ts` — extend with the receive-first branch, the send-first byte-for-byte regression, and the flag-on/off picker wiring + fallback
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/whatsapp.test.ts` — extend with `sendList` body-shape + throw-to-fall-back + 470, and `parseIncoming` `list_reply` mapping + the byte-for-byte `button_reply` regression
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/bot-content-guard.test.ts` — extend the content scan to cover the `amount_inr` description, the prompt addition, and the picker list strings
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/docs/superpowers/specs/2026-05-29-transfer-memory-design.md` — the spec whose structure this mirrors
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/docs/superpowers/specs/2026-05-29-payment-provider-seam-design.md` — the seam the **next** (FX best-rate) batch hangs off
- Current suite measured at ~549 cases across 60 test files in `tests/`; projected delta +~25 → ~574.
