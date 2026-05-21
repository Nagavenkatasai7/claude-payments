# SendHome — WhatsApp US→India Remittance Bot (Prototype Design)

**Date:** 2026-05-21
**Status:** Approved — proceeding to implementation plan
**Working name:** SendHome (renamable)

## 1. Purpose

A concept-demo prototype, inspired by Felix Pago, that lets a person in the US
send money to family in India entirely through a WhatsApp conversation. A user
chats naturally (English / Hindi / Hinglish) with an AI agent that collects the
amount and recipient, quotes FX + fee, sends a secure payment link, and confirms
delivery. All money movement is realistically **mocked**. The goal is a
convincing demo to show a project partner — not a production money service.

## 2. Decisions (locked)

| Topic | Decision |
|---|---|
| Goal | Concept demo (everything mocked, looks real) |
| Channel | Meta WhatsApp Cloud API (test number) |
| Assistant | Real AI agent — Kimi K2.6 on Ollama Cloud, native tool-calling |
| Payments | Fully mocked (no real money, no real APIs) |
| Corridor | US → India only (USD → INR) |
| Voice notes | Out of scope |
| Recipient side | Sender confirmation only (no recipient experience) |
| Hosting | Vercel (Next.js App Router) |
| State store | Upstash Redis (Vercel Marketplace) |

## 3. Architecture & Components

Next.js (App Router) deployed on Vercel. Modules are isolated so each is
independently testable and the LLM layer is swappable.

| Module | Responsibility | Depends on |
|---|---|---|
| `app/api/whatsapp/route.ts` | GET = Meta webhook verification; POST = receive messages, ACK 200 immediately, process work in `after()` | whatsapp, agent, store |
| `lib/agent.ts` | Agent loop: assemble messages, call Kimi, run the tool-call loop until a final reply | ollama, tools, prompt, store |
| `lib/ollama.ts` | Thin Ollama Cloud client (OpenAI-compatible `/v1/chat/completions`) | env config |
| `lib/tools.ts` | Tool JSON schemas + TypeScript executors (deterministic money logic) | fx, store |
| `lib/whatsapp.ts` | Meta Cloud API client — send text messages, parse incoming webhook payloads | env config |
| `lib/store.ts` | Upstash Redis access — conversation history, transfers, dedupe, user counts | Upstash |
| `lib/fx.ts` | Mock FX rate + fee calculation | none |
| `lib/prompt.ts` | System prompt text | none |
| `app/pay/[transferId]/page.tsx` | Branded mock card payment page | store |
| `app/api/pay/[transferId]/route.ts` | Card-submit handler: mark transfer paid, push WhatsApp delivery messages | store, whatsapp |

**LLM interface boundary:** `lib/agent.ts` exposes a single function
(e.g. `runAgentTurn(phone, incomingText)`) so the underlying provider
(Ollama/Kimi today; could be Anthropic SDK later) can be swapped without
touching callers.

## 4. Conversation Flow (happy path)

1. User messages the bot → agent greets bilingually, asks how much & to whom.
2. User: "send $500 to my mom" → agent asks recipient name and payout method
   (**UPI ID** or **bank account + IFSC**) plus the destination value.
3. Agent calls `get_quote` → presents: amount sent, fee, FX rate, INR received,
   delivery estimate. Asks the user to confirm.
4. User confirms → agent calls `create_transfer` then `generate_payment_link`,
   and sends the secure link `…/pay/{transferId}`.
5. User taps the link → branded mock card page → enters a test card → submits.
6. `api/pay/[transferId]` marks the transfer `paid` and immediately pushes two
   WhatsApp messages: "✅ Payment received — converting…" then (~2s later)
   "🎉 ₹X delivered to {recipient}'s UPI."
7. Agent offers to send again.

**Fee rule:** first transfer per phone number is free ($0); subsequent transfers
cost a flat **$2.99** (a nod to Felix Pago's first-free model).

**Mock amount limits:** $10 – $2,999 per transfer.

## 5. The Agent & Tools

Kimi K2.6 uses native function-calling via the Ollama OpenAI-compatible
endpoint. The orchestrator in `lib/agent.ts` runs the loop: send messages +
tool schemas → if the model returns tool calls, execute them in TypeScript,
append results, call again → repeat until the model returns a plain reply.
A JSON-mode fallback (model emits `{reply, action}` objects parsed by the
orchestrator) is implemented in case tool-calling is unreliable over Ollama.

**Tools:**

- `get_quote(amount_usd, payout_method)` → `{ fee_usd, fx_rate, amount_inr, delivery_estimate }`
- `create_transfer({ amount_usd, recipient_name, payout_method, payout_destination })` → `{ transfer_id, status }`
- `generate_payment_link(transfer_id)` → `{ url }`
- `check_payment_status(transfer_id)` → `{ status }`

**System prompt highlights:**
- Identity: assistant for SendHome, sending money US→India via WhatsApp.
- Mirror the user's language/register: English, Hindi, or Hinglish.
- Collect amount, recipient name, payout method, payout destination — then
  quote, confirm, create transfer, send pay link.
- Never invent FX rates or fees — always call `get_quote`.
- Never ask for card details in chat — that is the secure link's job.
- Short, friendly, WhatsApp-style messages; sparing emoji use.
- Enforce mock limits $10–$2,999.

## 6. Data Model (Upstash Redis)

- `conv:{phone}` → JSON array of `{role, content, tool_calls?, tool_call_id?}`
  messages; trimmed to the last ~20 turns.
- `transfer:{id}` → JSON `{ id, phone, amount_usd, fee_usd, fx_rate,
  amount_inr, recipient_name, payout_method, payout_destination, status,
  created_at, paid_at, delivered_at }`. Status: `awaiting_payment → paid →
  delivered`.
- `user:{phone}` → JSON `{ transfer_count }` for the first-free fee rule.
- `msg:{wamid}` → dedupe marker with TTL (Meta retries webhooks on slow ACK).

## 7. Error Handling

- GET webhook validates the Meta verify token and echoes `hub.challenge`.
- POST webhook deduplicates on the WhatsApp message id before processing.
- POST ACKs `200` immediately; the LLM/tool work runs in `after()` so a slow
  model response never causes Meta webhook retries.
- Ollama failure/timeout → send the user a friendly "one moment, please resend"
  message and log the error.
- Malformed tool call → caught; one retry; then a graceful fallback message.
- Mock payment always succeeds (it is a demo); the payment page still validates
  card-field formats for realism.
- `api/pay` failures are logged; no automated retry in the prototype.

## 8. Testing

TDD on deterministic pieces, written before implementation:
- `fx.ts` — quote math (rate, fee, INR amount, first-free logic).
- `tools.ts` — each tool executor.
- `store.ts` — Redis read/write/trim/dedupe operations.
- `whatsapp.ts` — incoming webhook payload parsing.

One integration test drives the full happy path with a **stubbed LLM** that
returns canned tool calls, asserting the correct WhatsApp messages are sent and
the transfer record reaches `delivered`.

Final manual check: a real conversation on a phone via Meta's test number.

## 9. Out of Scope (YAGNI)

Real KYC / identity verification; real payment processing or payout rails;
AML / compliance / money-transmitter licensing; live FX feeds; voice notes;
multiple corridors; recipient-side app or notifications; user accounts /
dashboards / auth; data retention beyond Redis defaults.

## 10. Configuration (environment variables)

- `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL` — Ollama Cloud / Kimi.
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`,
  `WHATSAPP_APP_SECRET` (optional, for signature checks) — Meta Cloud API.
- `APP_BASE_URL` — public origin used to build payment links.
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Upstash Redis.

## 11. External Setup (user-performed, documented during build)

- Create a Meta WhatsApp Cloud API app + test number; add the demo recipient's
  phone number to the test number's allowed recipients list.
- Provision Upstash Redis via the Vercel Marketplace.
- Provide Ollama Cloud base URL, model tag, and API key.

Note: Meta's customer-service window allows free-form replies within 24h of the
user's last message. The payment-page-triggered messages occur moments after the
user was chatting, so they fall inside the window — no message templates needed.
