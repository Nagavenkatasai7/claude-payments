# WhatsApp Pay — One-Tap CTA Button + Cancel-by-Text (Batch 1) — Design

**Status:** design approved (Q&A 2026-05-29). Branch `spec/wa-pay-cta-button` off `main` at Bundle D (e833d3e, suite 622).

**Problem:** Today the approve card uses reply buttons `[Approve & pay]` `[Cancel]`. Tapping a reply button can't open a URL — it round-trips to the webhook, and the bot replies with a **second message containing the pay link**. The user wants: tap **Approve → the pay page opens in one tap**; type/tap **Cancel → the transfer is cancelled**.

**Constraint (Meta Cloud API):** a button can either send a reply OR open a URL (`interactive.type: 'cta_url'`), and a `cta_url` button **cannot share a message with a reply button**. A `cta_url` tap opens the URL with **no webhook callback**. So: Approve becomes a `cta_url` button (the pay link must exist when the card is shown), and Cancel moves off that message to the typed word "cancel".

## Approved decisions
1. **Approve = one-tap CTA-URL button**; **Cancel = reply "cancel"** (single message).
2. **Create-at-pay:** the transfer is created **only when the customer pays** — the CTA button links to a **draft-keyed** pay URL; the pay page finalizes (creates the transfer) on payment. No premature transfers / cap usage.
3. **Screen at card-show:** compliance is screened when the card is built; a flagged recipient gets **no pay button** (the bot explains warmly).
4. **Pay link valid ~30 min** (draft TTL extended from 10 → 30 min).

## The invariant
> **Money still only moves through `createTransfer` → `payment.ts` stages, and compliance/caps are enforced at creation.** Create-at-pay relocates *when* the transfer is created (at payment instead of at the Approve tap) but not *how*: `/api/pay` for a draft calls the unchanged `createTransfer(store, partnerStore, monthlyVolumeStore, input)` (which screens + accrues counters) with a **fresh cap re-check** immediately before it, then runs the unchanged `completePaymentStage1/Stage2`. The existing **transferId** pay path is preserved byte-for-byte (dual-lookup tries transfer first). `quote()`/fee math, `payment.ts`, and `transfer-create.ts` are unchanged. `bot-content-guard` stays green (the CTA URL is built in code, never emitted by the LLM; `sanitizeReply` still strips any model-written URL). New/within-cap senders see the same quote; the only behavior change is the **card delivery** (one-tap pay button instead of reply buttons + follow-up link) and **cancel via text**.

## Architecture

### 1. `sendCtaUrl` — `src/lib/whatsapp.ts`
New `sendCtaUrl(to, bodyText, button: {displayText, url}, headerText?, footerText?)` posting `interactive.type:'cta_url'` (`action.name:'cta_url'`, `parameters.{display_text,url}`). Validates `url` starts `https://` and `displayText.length ≤ 20`. On HTTP 470 → fallback to `sendText(to, body + "\n\n" + displayText + "\n" + url)` (mirrors `sendInteractive`). Export a `CtaButton` type. No `parseIncoming` change (no callback).

### 2. Draft store — `src/lib/draft-store.ts`
- `DRAFT_TTL_SECONDS: 600 → 1800` (30 min).
- Add a **per-phone active-draft pointer** so "cancel" (typed) can find the draft: on `createDraft(draft)`, also `set('active_draft:{senderPhone}', draftId, {ex: 1800})`; add `getActiveDraftId(phone)`; on `consumeDraft`, the pointer naturally expires (or is cleared). Keep `getDraft`/`consumeDraft` (used by the pay page).

### 3. Approve card — `sendApprovePickerTool` (`src/lib/tools.ts`)
Rework: build the draft (as today), then **screen** the prospective transfer (`screenTransfer` on the draft's amount/recipient/sender — read-only). If **blocked** → return an error result (no card; the bot relays a warm refusal). If **cleared** → build the pay URL `{env.appBaseUrl}/pay/{draftId}` and `sendCtaUrl(phone, summary, {displayText:'Approve & Pay', url})`. The summary body is the existing `buildApproveSummary(...)` text **plus** a "or reply *cancel* to stop" line. **No reply buttons.** Cap re-check stays (unconditional, from Bundle D-era code). Returns `{ sent:true, draft_id }`.

### 4. Cancel-by-text — `cancelDraftTool` (`src/lib/tools.ts`)
When `ctx.turn.buttonTap?.kind === 'cancel'` use its draftId (legacy path, harmless); **else** look up `getActiveDraftId(ctx.phone)` and consume that. Returns `{cancelled:true}` / `{cancelled:false, reason}`. The prompt routes the typed word "cancel" to `cancel_draft`.

### 5. Pay page + endpoint — finalize from a draft
- **`src/lib/pay-finalize.ts`** (NEW, testable): `finalizeDraftPayment(stores, draftId)` — `consumeDraft(draftId)`; if null → `{error:'expired_or_used'}`; **re-check cap** (`evaluateCap` on the draft's `amountUsd`); if over → `{error:'cap'}`; else `createTransfer(...draft fields, senderName)` → if `complianceStatus==='blocked'` → `{error:'blocked', transferId}`; else accrue daily cents + `recordFundingMethod` (parity with the tool path) → return `{transferId}`. Then the caller runs `completePaymentStage1`.
- **`/api/pay/[id]/route.ts`**: try `getTransfer(id)` (today's path, unchanged); if null, treat `id` as a draft → `finalizeDraftPayment` → on success run the existing payment provider stage-1; surface errors as JSON the form shows.
- **`/pay/[id]/page.tsx`**: dual-lookup — `getTransfer(id)`; if null, `getDraft(id)` and render the same quote summary from the draft (status treated as "awaiting_payment"); if both null → "this link is no longer active." Draft display fields: amountSource/sourceCurrency + `quote.{feeUsd,fxRate,amountInr}` (+ derive totals); to avoid recompute, **extend the draft's stored `quote`** to include `feeSource`, `totalChargeSource`, `totalChargeUsd` at `createDraft` time (sendApprovePickerTool already has the full `q`).

### 6. Prompt (`src/lib/prompt.ts`)
Rewrite the QUOTE CONFIRMATION section: after all details, call `send_approve_picker` — it now sends a one-tap **Approve & Pay** button (the pay page opens directly; there is **no** separate `generate_payment_link` step and **no** `[Approve & pay]` reply button). If the user types/says **cancel**, call `cancel_draft` (no args). Remove the "[Tapped: Approve & pay] → create_transfer with no args" instruction (that webhook tap no longer happens). Keep `create_transfer`'s legacy path for cron.

## Data model changes
- `draft-store`: TTL 1800; new `active_draft:{phone}` key. `Draft.quote` gains `feeSource`, `totalChargeSource`, `totalChargeUsd` (optional, additive). No transfer/customer schema change.

## Testing (TDD)
- `sendCtaUrl`: POST shape, header/footer, https/≤20 validation, 470 fallback (`tests/whatsapp.test.ts`).
- draft-store: TTL constant, `active_draft` pointer set on create + `getActiveDraftId` + cleared on consume (`tests/draft-store.test.ts`).
- `cancelDraftTool`: cancels via active-draft pointer when no buttonTap; idempotent when none (`tests/tools.test.ts`).
- `sendApprovePickerTool`: cleared → `sendCtaUrl` called with a `/pay/{draftId}` https URL + draft persisted with the enriched quote; **blocked recipient → no card, error result** (`tests/tools.test.ts`).
- `finalizeDraftPayment`: happy path creates transfer + consumes draft + accrues counters; expired draft → error; over-cap → error (no transfer); blocked → error; idempotent re-pay (draft gone) → expired (`tests/pay-finalize.test.ts`).
- `bot-content-guard` green; existing transferId pay tests unchanged.

## Tasks
1. `sendCtaUrl` + tests.
2. draft-store: TTL 1800 + `active_draft` pointer + enriched `Draft.quote` fields + tests.
3. `sendApprovePickerTool` → screen + `sendCtaUrl` draft-keyed link (no reply buttons) + tests.
4. `cancelDraftTool` active-draft fallback + tests.
5. `finalizeDraftPayment` lib + tests.
6. `/api/pay/[id]` + `/pay/[id]/page.tsx` dual-lookup (draft finalize) — wire to the lib.
7. Prompt rewrite (approve/pay/cancel) + tests.
8. Wrap: bot-content-guard + full gate + final review + PR (hold).

## Risks
- **Customer-facing pay UI** (page.tsx not unit-tested) — mitigated by extracting logic to `pay-finalize.ts` (tested), dual-lookup preserving the transferId path, and the prod smoke + final review. Manual verify step in the morning report.
- **CTA tap has no callback** — by design; cancel is text, payment is the pay page. The bot never "waits" for an approve tap.
- **Draft expiry (30 min)** — the pay page shows "link no longer active" past TTL; acceptable, matches "rate locked".
