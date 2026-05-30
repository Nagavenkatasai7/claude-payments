# WhatsApp UX — Returning-Customer Fast Path (Bundle C) — Design

**Status:** design drafted 2026-05-29. Awaiting spec review → implementation plan. Branches off `main` at the wa-ux clarity batch (PR #18, suite **592**). The enriched **Approve & pay card** that batch shipped (`buildApproveSummary` in `src/lib/tools.ts` — recipient name + masked destination + amount + fee + FX rate + ETA + "rate locked ~10 min") is the load-bearing confirmation surface this batch leans on.

**Sub-project:** the "returning customers re-type everything they already told us" UX pass. The bot is purely LLM-driven (no deterministic NLU) and the system prompt forces a step-by-step collection flow, so a customer who has sent to "Mom" ten times still walks the full first-send questionnaire every time. This batch makes the repeat path fast — **without** touching any server-side money or compliance gate.

This is an **intentionally behavior-changing UX batch** (bot conversation, tool roster, and one additive Customer field change on purpose). It is **NOT** dormant. But it carries a strict **dormancy-for-new-customers** guarantee: a customer with **no saved recipients and no transfer history** sees byte-for-byte today's behavior (the new lookup returns "none", no default exists, no note is injected).

---

## Goal

Cut turns for repeat senders by reusing what we already store, gated by the existing Approve & pay card. Four user-approved capabilities (all four, one batch):

1. **One-line shorthand** — "send Mom 500" chains to a quote + approve card in one turn when "Mom" resolves to a saved recipient.
2. **Typed-name → saved recipient** — match a name the customer *types* (not just a button they tap) to a saved recipient and reuse its stored payout method + destination.
3. **Sticky funding method (per-sender global default)** — remember the sender's last-used funding method and default it; the card shows the resulting fee so they can change it.
4. **Repeat-last / "send the usual" (reactive only)** — re-send to a saved recipient from their most-recent transfer's details, re-running every cap/compliance/EDD check.

## The invariant

> **MONEY & COMPLIANCE GATES ARE UNCHANGED.** Every transfer still flows through `createTransfer()` (`transfer-create.ts`), which **always** calls `screenTransfer()` (sanctions/watchlist/velocity, sender + recipient) and `evaluateEddForTransfer()`, and accrues USD-equivalent monthly volume — no path added in this batch bypasses it. `check_send_limit` is still called before `get_quote`; caps are still evaluated in USD-equivalent via `evaluateCap`; EDD still re-triggers above $3 000/month and re-asks source-of-funds/occupation. **No new tool calls `create_transfer` directly** — `repeat_transfer` routes through the existing `send_approve_picker` → draft → Approve & pay card path exactly like a normal send. A prior transfer's `cleared` status is **never** carried forward. `fx.ts` `quote()` and all fee math are byte-for-byte unchanged. The only stored-data change is one **additive, optional** field pair on the `Customer` record (`lastFundingMethod` / `lastFundingMethodAt`); absent ⇒ ask, which is today's behavior, so **no migration/backfill is needed**. `bot-content-guard` stays green (the two new tools and the prompt additions leak no partner / provider / corridor / watchlist / sanctions / PII terms; recipient data returned is customer-owned only). The full suite stays green after intentional prompt/tool-roster test updates. These are the executable proofs that the speed-ups are confined to data-gathering and the transfer/compliance engine is untouched.

## Locked design decisions (2026-05-29, user-approved)

1. **Typed-name resolution is a new read-only tool, `resolve_recipient` (capabilities 1 + 2 share this seam).** It searches **all** of the sender's saved recipients (`store.listRecipients(phone, <high limit>)`, not the 2-item picker cap) and returns a discriminated result:
   - `{ match: 'exact', recipient: { name, recipient_phone, payout_method, payout_destination } }` when exactly **one** case-insensitive, whitespace-normalized **full-name** match exists.
   - `{ match: 'ambiguous', candidates: [...] }` when more than one name matches, or only partial/`startsWith`/`includes` matches exist (a partial match alone never auto-proceeds).
   - `{ match: 'none' }` when nothing matches.
   No writes, no Redis mutation, no `ctx` side effects. Returns customer-owned recipient fields only.
2. **Name-match safety = exact → card, ambiguous → picker (user choice).** On `exact`, the bot uses the saved `payout_method` + `payout_destination` + `recipient_phone` directly and proceeds to `get_quote` → `send_approve_picker`; the **Approve & pay card already names the recipient and masks the account**, so the customer confirms before any money moves. On `ambiguous`, the bot calls the existing `send_recipient_picker` with the candidates (tap to choose). On `none`, the bot falls back to today's cold path (ask for number + payout). The bot **never** silently sends on a loose/partial match.
3. **Shorthand is prompt-only (no parser).** The agent already chains tools across up to 6 rounds. The prompt is reworded so that when a free-text message names a recipient, the bot calls `resolve_recipient`; on `exact` it pulls payout details, defaults the funding method (decision 4), and goes straight to the card. `check_send_limit` is still called before `get_quote` (unchanged server gate). No change to `route.ts`, no deterministic NLU.
4. **Sticky funding is a per-sender global default (user choice).** Add optional `lastFundingMethod?: FundingMethod` + `lastFundingMethodAt?: string` to the **Customer** record (NOT the recipient). Written after each **interactive bot-created** transfer (`createTransferTool` and the `repeat_transfer` path), via a small `customerStore.recordFundingMethod(phone, method)`; **cron-fired schedule transfers do NOT touch it** (they carry their own `fundingMethod` and have no interactive sender choosing "now"). Surfaced to the bot at round 0 as a compact `[SENDER DEFAULTS]` system note. Prompt rule: if the customer hasn't specified a funding method and a default exists that is **< 90 days** old, use it (the card shows the resulting fee, so "use credit instead" corrects it); if the default is **≥ 90 days** old or absent, ask normally.
5. **Repeat-last is a new tool, `repeat_transfer`, reactive only (user choice).** Triggered by "send the usual" / "repeat" / "send Mom again". Parameters: `{ recipient_phone: string, amount_usd?: number, funding_method?: string }`. It hydrates the **most-recent transfer to that recipient** (`store.listTransfers` filtered by sender phone + `recipientPhone`, newest first) to recover `recipientName`, `payoutMethod`, `payoutDestination`, and the last amount/currency; `amount_usd` overrides the last amount when given; `funding_method` falls back to the sticky default then the last transfer's method. It then re-runs `check_send_limit` and routes through `send_approve_picker` (draft + card). It **never** calls `create_transfer` directly. **No proactive/unprompted offer** is injected anywhere.
6. **The Approve & pay card is the single human gate.** Every speed-up above ends at the existing card (`buildApproveSummary`), which shows recipient name, masked destination, amount, fee (funding-derived), FX rate, INR, ETA. The faster we make data-gathering, the more this card carries the confirmation burden — so no speed-up may skip it.
7. **Dormancy for new/history-less customers.** `resolve_recipient` returns `none`, no `lastFundingMethod` exists, and no `[SENDER DEFAULTS]` note is injected — the bot asks exactly as it does today. This is the same empty-string-no-injection pattern `getRecentTransfersNote` already uses.
8. **Conventions.** TDD per task; `fakeRedis()` in tests; no `as any`; the bot stays partner-/provider-/PII-blind (`bot-content-guard` green, extended to scan the two new tools' output + the prompt additions); `tools.test.ts` (tool roster 14 → 16), `prompt.test.ts`, and any affected tests updated to the new flow (intentional); commit prefix `feat(wa-ux-c):`; one atomic commit per task; final independent opus review before the PR; hold the prod merge for the user's "deploy."

---

## Architecture

### New tool: `resolve_recipient`  (`src/lib/tools.ts`, read-only)

```
resolve_recipient({ name: string })
  → { match: 'exact',     recipient:  { name, recipient_phone, payout_method, payout_destination } }
  | { match: 'ambiguous', candidates: Array<{ name, recipient_phone, payout_method, payout_destination }> }
  | { match: 'none' }
```

- Reads `ctx.store.listRecipients(ctx.phone, 25)` (own-phone only; high cap so a non-top-2 recipient is still findable).
- Normalize for matching: `name.trim().toLowerCase()`.
- **Exact** = exactly one recipient whose normalized `name` equals the normalized query. → `match:'exact'`.
- Otherwise gather candidates whose normalized name `startsWith`/`includes` the query (or vice-versa); if ≥1, `match:'ambiguous'` with those candidates (capped, e.g. 3, for the picker); if 0, `match:'none'`.
- No writes; no compliance/partner/PII fields in the response (recipient fields only). Mirrors the read-only shape of `validate_phone`.

### New tool: `repeat_transfer`  (`src/lib/tools.ts`, routes through draft/approve)

```
repeat_transfer({ recipient_phone: string, amount_usd?: number, funding_method?: 'credit_card'|'debit_card'|'bank_transfer' })
  → (same return shape as send_approve_picker: an approve-card interactive + draft, OR { error })
```

- Hydrate the most-recent transfer: `ctx.store.listTransfers(ctx.phone)` → first where `recipientPhone === normalizePhone(args.recipient_phone)`. If none, return a friendly `{ error }` ("I don't see a past transfer to that number — who would you like to send to?").
- Resolve fields: `recipientName`, `payoutMethod`, `payoutDestination` from that transfer; `amount = args.amount_usd ?? <last amountUsd-or-source>`; `funding = args.funding_method ?? lastFundingMethod ?? <last transfer's fundingMethod>`.
- Re-validate the recipient phone (`validate_phone` semantics) and re-run `check_send_limit` (defense-in-depth cap/EDD).
- Then call the **same internal path as `sendApprovePickerTool`** (build quote, run the cap re-check, create the draft, send the `[Approve & pay]`/`[Cancel]` card). Implementation may factor the existing `sendApprovePickerTool` body into a shared helper that both tools call — no behavior change to the existing tool.
- Compliance re-screens at `createTransfer` time when the user approves (unchanged). EDD re-triggers if the month is now over threshold (unchanged).

### Sticky funding default

- **Type:** `Customer.lastFundingMethod?: FundingMethod` + `Customer.lastFundingMethodAt?: string` (ISO-8601). Optional/additive.
- **Write:** `customerStore.recordFundingMethod(phone, method)` called from `createTransferTool` (and `repeat_transfer`) **after** a successful create. Not called from the cron schedule path.
- **Read/surface:** a `[SENDER DEFAULTS]` round-0 system note (built like `getRecentTransfersNote`), present only when a `< 90 day` default exists. Format (customer-blind, enum-only): e.g. `[SENDER DEFAULTS] Last paid by: bank transfer.` The note is informational context for the LLM, never persisted to history.
- **Prompt:** "If the customer hasn't said how they'll pay and a recent default is shown in `[SENDER DEFAULTS]`, use it; the approve card shows the fee, so they can change it. If no default is shown, ask."

### Prompt changes (`src/lib/prompt.ts`)

- **Typed-name resolution:** when a message names a recipient in free text (no button tap), call `resolve_recipient`; branch on `exact` / `ambiguous` / `none` as in decision 2.
- **Shorthand:** parse amount + name (+ optional funding) from one message; resolve the recipient; default funding; proceed to the card. Always `check_send_limit` before `get_quote`.
- **Sticky funding usage:** decision 4's rule.
- **Reactive repeat:** when the customer says "the usual"/"repeat"/"again", reference `[RECENT TRANSFERS]`, confirm same-or-new amount, call `repeat_transfer`.
- No forbidden terms; no change to the destination-refusal or EDD blocks shipped earlier.

### Data flow (happy path — returning customer, "send Mom 500")

```
"send Mom 500"
  → resolve_recipient({name:"Mom"}) → {match:'exact', recipient:{phone, payout_method:'upi', payout_destination:'mom@okhdfc'}}
  → check_send_limit({amount_usd:500})            (server cap/EDD gate — unchanged)
  → get_quote({amount_usd:500, funding_method:<sticky default>})
  → send_approve_picker({amount, funding, recipient_name:"Mom", recipient_phone, payout_method, payout_destination})
  → [Approve & pay] / [Cancel] card  ← single human gate (names recipient, masks account, shows fee+rate)
  → approve tap → create_transfer (button-tap path) → createTransfer() → screenTransfer()  (unchanged)
```

Turns: ~1–2 (shorthand + the tap) vs today's ~5–6.

---

## Data model changes

| Record | Change | Migration |
|---|---|---|
| `Customer` (`types.ts`, `customer-store.ts`) | **add** optional `lastFundingMethod?: FundingMethod`, `lastFundingMethodAt?: string` | **None.** Optional; absent ⇒ ask (today's behavior). No sentinel/backfill. |

No change to `Recipient`, `Transfer`, `Draft`, `Schedule`, or any Redis key shape.

---

## Testing (TDD, `fakeRedis()`)

- **`resolve_recipient`:** exact single match (case-insensitive, whitespace-trimmed); ambiguous (two same-name, and partial/substring); none (no match → cold path); own-phone only (no cross-sender leak); response carries payout fields but no compliance/partner/PII fields.
- **Sticky funding:** `recordFundingMethod` write + read; `[SENDER DEFAULTS]` note format and enum labels; `< 90 day` surfaces, `≥ 90 day` does not; absent ⇒ no note (dormancy); cron path does not write it.
- **`repeat_transfer`:** hydrates most-recent transfer to a recipient; `amount_usd` override; funding fallback chain (`arg → sticky → last`); re-runs `check_send_limit`; routes through draft/approve (asserts it does **not** call `create_transfer` directly and **does** create a draft + card); error when no past transfer to that number; EDD re-trigger when month now over threshold; a now-blocked recipient is re-screened at approve.
- **Tool roster:** `tools.test.ts` updated 14 → 16 tools (`resolve_recipient`, `repeat_transfer`).
- **bot-content-guard:** extended to scan both new tools' output strings + the prompt additions; stays green.
- **Dormancy regression:** existing prompt/tool/agent tests stay green; a history-less customer's flow is unchanged.

Estimated suite delta ≈ **+25 to +35** (592 → ~617–627).

---

## Tasks (subagent-driven, one atomic commit each)

1. **`resolve_recipient` tool** — schema + `resolveRecipientTool(args, ctx)` + executeTool wiring; tests (exact/ambiguous/none, case-insensitivity, own-phone, field hygiene).
2. **Prompt: typed-name resolution + shorthand** — branch on resolve result; one-message shorthand; keep `check_send_limit` before `get_quote`. Update `prompt.test.ts`.
3. **Sticky funding data + note** — `Customer.lastFundingMethod`/`At` + `customerStore.recordFundingMethod`; write from `createTransferTool`; `[SENDER DEFAULTS]` round-0 note (< 90d) injected in `runAgentTurn`; tests.
4. **Prompt: sticky-funding usage** — use default when present/recent, else ask; tests.
5. **`repeat_transfer` tool** — factor shared approve-card helper out of `sendApprovePickerTool` (no behavior change); implement `repeat_transfer` routing through it; write sticky default after create; tests (hydration, override, fallback, re-check, no direct create, EDD).
6. **Prompt: reactive "send the usual"** — reference `[RECENT TRANSFERS]`, confirm amount, call `repeat_transfer`; tests.
7. **bot-content-guard extension + wrap** — extend guard to the new surfaces; full local gate (typecheck / lint / vitest / build); independent opus final review; PR; hold for "deploy."

---

## Risks & mitigations

- **Wrong-recipient send on a name collision.** Mitigated by: exact-match-only auto-proceed; ambiguous → explicit picker; and the Approve & pay card naming the recipient + masking the account before money moves. (User-chosen posture.)
- **Stale funding default surprises the customer on fee.** Mitigated by: per-sender default is *last-used* (not arbitrary), 90-day staleness re-asks, and the card always shows the real fee computed at approve time (`quote()` is called fresh, so the displayed fee is never stale even if the default is).
- **Repeat-last silently skipping a compliance change.** Mitigated by routing through the normal draft/approve/`createTransfer` path — `screenTransfer` + EDD + caps all re-run; `cleared` is never inherited. Explicitly tested.
- **LLM mis-parses shorthand (e.g. amount in the wrong currency).** Unchanged guards apply: `resolveSendCurrency` rejects currencies outside `partner.countries`; `check_send_limit` + `quote()` validate amount/MIN/MAX; the card surfaces the parsed result for human confirmation.
- **Tool-roster / prompt test churn.** Intentional; tests updated in the same task that changes the behavior.

## Open questions (defaults taken unless you say otherwise)

1. **`[SENDER DEFAULTS]` staleness window = 90 days.** Default taken (user reviewed the design with this value). Trivial to change to 30/60.
2. **`resolve_recipient` search cap = 25 recipients.** Generous; a single sender realistically has far fewer. Default taken.
3. **Ambiguous-candidate cap for the picker = 3** (WhatsApp reply-button max). If a name matches >3, the bot lists them as text and asks which. Default taken.
4. **"send the usual" with no amount = reuse the last amount to that recipient** (the customer can override with "send Mom 600"). Default taken.
