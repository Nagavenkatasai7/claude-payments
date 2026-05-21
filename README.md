# SendHome — WhatsApp US→India Remittance (Prototype)

A prototype, inspired by Felix Pago, that lets a US user send money to family
in India entirely through a WhatsApp conversation. An AI agent (Kimi K2.6 on
Ollama Cloud) guides the chat in English / Hindi / Hinglish. All money movement
is mocked — no real funds move.

## Architecture

- **Next.js (App Router)** on Vercel.
- `POST /api/whatsapp` receives WhatsApp messages; the agent replies after a
  fast webhook ACK.
- The agent calls TypeScript tools (`get_quote`, `create_transfer`,
  `generate_payment_link`, `check_payment_status`) for deterministic money math.
- A mock card page at `/pay/[transferId]` triggers WhatsApp delivery messages.
- State (conversations, transfers) lives in Upstash Redis.

## Setup

1. **Install:** `npm install`
2. **Upstash Redis:** in the Vercel dashboard, add the Upstash Redis
   integration from the Marketplace. It sets `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.
3. **Ollama Cloud:** set `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, and `OLLAMA_MODEL`
   (the exact Kimi K2.6 model tag).
4. **Meta WhatsApp:** create a Meta app with WhatsApp, note the test number's
   `WHATSAPP_PHONE_NUMBER_ID` and a `WHATSAPP_TOKEN`. Add the demo recipient's
   phone number to the test number's allowed recipients.
5. **Deploy:** push to Vercel. Set `APP_BASE_URL` to the deployed URL.
6. **Webhook:** in the Meta app, set the WhatsApp webhook callback URL to
   `https://<your-app>/api/whatsapp` and the verify token to your
   `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.

Copy `.env.example` to `.env.local` for local development.

## Testing

`npm test` runs the Vitest suite (FX math, store, tools, agent loop, payment,
WhatsApp parsing, webhook verification, and an end-to-end happy path).

## Scope

This is a concept demo. Out of scope: real KYC, real payment/payout rails,
AML/compliance, live FX feeds, voice notes, and corridors other than US→India.
