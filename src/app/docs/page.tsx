import Link from 'next/link';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { SHARE_IMAGE } from '../landing/share-image';
import { SkipLink } from '@/components/skip-link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { destinationListText } from '@/lib/destination-country';

// /docs — the public partner integration hub (Stage 5, Tailwind-native).
// Every endpoint, header, and payload shape on this page mirrors the actual
// implementation (partner-api-service / http-payment-provider) — if you change
// the API, change this page in the same PR.

export const metadata = {
  title: 'SmartRemit — Partner API documentation',
  description:
    'Integrate the SmartRemit white-label remittance infrastructure: REST API, settlement webhooks, WhatsApp channel.',
  // /docs is SmartRemit-owned, so its link preview may carry the share image.
  openGraph: { images: [SHARE_IMAGE] },
  icons: SMARTREMIT_ICONS,
};

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-[#1c2024] p-4 text-[13px] leading-relaxed text-[#e6e8ec]">
      <code>{children}</code>
    </pre>
  );
}

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-2.5">
      <Badge
        variant={method === 'GET' ? 'secondary' : 'default'}
        className="w-14 justify-center font-mono"
      >
        {method}
      </Badge>
      <code className="text-sm font-medium">{path}</code>
      <span className="text-sm text-muted-foreground">{desc}</span>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-background font-sans text-foreground antialiased">
      <SkipLink />
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            SmartRemit <span className="text-muted-foreground font-normal">/ docs</span>
          </Link>
          {/* Five links beside the brand overflow a phone (ui-05): below sm
              only the brand shows; every section is still in the page. */}
          <nav aria-label="Sections" className="hidden items-center gap-4 text-sm sm:flex">
            <a href="#api" className="text-muted-foreground hover:text-foreground">API</a>
            <a href="#rates" className="text-muted-foreground hover:text-foreground">Rates</a>
            <a href="#settlement" className="text-muted-foreground hover:text-foreground">Settlement</a>
            <a href="#webhooks" className="text-muted-foreground hover:text-foreground">Webhooks</a>
            <a href="#whatsapp" className="text-muted-foreground hover:text-foreground">WhatsApp</a>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-4xl space-y-10 px-6 py-10">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight">Partner integration guide</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            SmartRemit provides the <strong className="text-foreground">orchestration layer</strong> for
            cross-border remittance: the WhatsApp conversation, quoting, compliance screening,
            customer KYC flows, and a hosted pay page — under <em>your</em> brand. You remain the
            licensed money transmitter: <strong className="text-foreground">funds never touch
            SmartRemit</strong>. We send your rail a signed settlement instruction; your rail
            reports lifecycle status back via a signed webhook.
          </p>
        </section>

        <Separator />

        <section id="api" className="space-y-4">
          <h2 className="text-xl font-semibold">1 · The Partner API</h2>
          <p className="text-sm text-muted-foreground">
            Base URL <code>https://smartremit.ai/api/partner/v1</code>. Authenticate every
            request with your API key (issued in the dashboard, shown once):
          </p>
          <Code>{`Authorization: Bearer <your-api-key>`}</Code>
          <p className="text-sm text-muted-foreground">
            Rate limit: 120 requests/minute per partner (429 + <code>Retry-After</code> beyond it).
            Errors are JSON: <code>{`{ "error": "…" }`}</code>. <code>503</code> means live FX
            is temporarily unavailable and nothing was minted — retry later (a{' '}
            <code>POST /transactions</code> retry may reuse the same Idempotency-Key).
          </p>
          <Card>
            <CardContent className="divide-y divide-border pt-4">
              <Endpoint method="GET" path="/corridors" desc="Your enabled send corridors + brand" />
              <Endpoint method="POST" path="/quote" desc="Price a transfer (amount_source, source_currency)" />
              <Endpoint method="POST" path="/beneficiaries/validate" desc="Validate payout fields for a country" />
              <Endpoint method="POST" path="/beneficiaries" desc="Store a beneficiary (payout details encrypted at rest)" />
              <Endpoint method="POST" path="/transactions" desc="Mint a transfer — Idempotency-Key header REQUIRED" />
              <Endpoint method="GET" path="/transactions" desc="List your transfers (keyset: ?limit=&cursor=)" />
              <Endpoint method="GET" path="/transactions/:id" desc="Fetch one transfer (404 outside your scope)" />
              <Endpoint method="POST" path="/transactions/:id/confirm" desc="Confirm funds captured → settlement begins (a flagged transfer is held in_review for compliance release; a blocked one is 422)" />
              <Endpoint method="PUT" path="/rates" desc="Push one corridor's wholesale conversion rate" />
              <Endpoint method="GET" path="/rates" desc="Your current rate sheet (freshness + margin)" />
            </CardContent>
          </Card>
          <Code>{`# Mint a transfer (idempotent — safe to retry with the same key)
curl -X POST $BASE/transactions \\
  -H "Authorization: Bearer $KEY" \\
  -H "Idempotency-Key: order-8841" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount_source": 200,
    "source_currency": "USD",
    "sender":      { "phone": "15551230000", "name": "Maria Lopez", "kyc_status": "verified" },
    "beneficiary": { "name": "Anita Sharma", "phone": "919876543210",
                     "payout_method": "bank", "payout_destination": "123456789012|HDFC0001234" }
  }'`}</Code>
          <p className="text-sm text-muted-foreground">
            Compliance screening (sanctions) runs on <em>every</em> mint regardless of KYC mode — a
            watchlist hit returns 422 and the attempt is recorded as <code>blocked</code>. A <code>payout_destination</code> that is a masked display value (for example <code>****1234</code> or <code>account on file</code>) is refused with 422 before the Idempotency-Key is bound. Idempotency-Key values beginning <code>draft:</code> or <code>b2binvoice:</code> are reserved and refused with 400. A payer can never change the beneficiary account of a transaction created through this API: every transaction is bound to its Idempotency-Key before it is created, and that binding locks the account.
          </p>
          <p className="text-sm text-muted-foreground">
            Names — <code>beneficiary.name</code>, <code>sender.name</code> and the <code>name</code> of a stored beneficiary — must be 1–80 characters with no brackets (<code>{'[ ] { } < >'}</code>) and no control or line-break characters. <code>payout_method</code> must be one of <code>bank</code>, <code>upi</code> or <code>usdc</code> (default <code>bank</code>), and an inline <code>payout_destination</code> is at most 64 printable characters. <code>destination_country</code> is optional and defaults to <code>IN</code>; when present it must be one of {destinationListText()} — any other value is refused with 400 (it is never coerced to India). Each is refused with 400 before the Idempotency-Key is bound, so a corrected retry with the same key succeeds. Transactions created through this API are never added to the customer&apos;s saved recipients in chat.
          </p>
        </section>

        <Separator />

        <section id="rates" className="space-y-4">
          <h2 className="text-xl font-semibold">2 · Rates (compete for routed flow)</h2>
          <p className="text-sm text-muted-foreground">
            Push the <strong className="text-foreground">wholesale conversion rate</strong> you
            offer per corridor with <code>PUT /rates</code>. When your fresh rate beats the
            platform mid-market rate (and your settlement rail is configured), SmartRemit routes
            eligible platform transfers to you for settlement. Pushing a rate does{' '}
            <strong className="text-foreground">not</strong> change the pricing of your own{' '}
            <code>/quote</code> or <code>/transactions</code> — those stay at platform mid-market.
          </p>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">PUT /rates — request fields</CardTitle>
              <CardDescription>One corridor per call. Re-push before expiry to stay fresh.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-1.5 pr-4 font-medium">Field</th>
                    <th className="py-1.5 pr-4 font-medium">Type</th>
                    <th className="py-1.5 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="py-1.5 pr-4"><code>source_currency</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5">Required. ISO 4217 send currency (e.g. <code>USD</code>).</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>destination_currency</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5">Required. ISO 4217 payout currency (e.g. <code>INR</code>); must differ from source.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>effective_rate</code></td>
                    <td className="py-1.5 pr-4">number</td>
                    <td className="py-1.5">Required. Destination units per 1 source unit; 0 &lt; rate &lt; 100000.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>ttl_seconds</code></td>
                    <td className="py-1.5 pr-4">number</td>
                    <td className="py-1.5">Optional. Freshness window — default 3600, clamped to [60, 86400]. An expired rate stops competing.</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Code>{`# Push your USD→INR rate (fresh for 30 minutes)
curl -X PUT https://smartremit.ai/api/partner/v1/rates \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "source_currency": "USD", "destination_currency": "INR",
        "effective_rate": 86.4, "ttl_seconds": 1800 }'

# → 200
{ "source_currency": "USD", "destination_currency": "INR",
  "effective_rate": 86.4, "expires_at": "…", "pushed_at": "…" }`}</Code>
          <p className="text-sm text-muted-foreground">
            <code>GET /rates</code> returns your sheet:{' '}
            <code>{`{ "rates": [ { source_currency, destination_currency, effective_rate, expires_at, fresh, margin_bps } ] }`}</code>{' '}
            — <code>fresh</code> tells you whether the pushed rate is still competing;{' '}
            <code>margin_bps</code> is your standing platform-configured fallback margin.
          </p>
        </section>

        <Separator />

        <section id="settlement" className="space-y-4">
          <h2 className="text-xl font-semibold">3 · Settlement instructions (us → you)</h2>
          <p className="text-sm text-muted-foreground">
            When a transfer is paid (pay page or <code>/confirm</code>), SmartRemit POSTs a{' '}
            <strong className="text-foreground">signed instruction</strong> to your configured
            settlement endpoint — with automatic retries and exponential backoff until your rail
            acks 2xx. The signature is <code>HMAC-SHA256(rawBody, signingSecret)</code> hex in the{' '}
            <code>x-signature</code> header.
          </p>
          <Code>{`POST <your settlementUrl>
x-signature: 3f1a…   # HMAC-SHA256 of the exact raw body

{
  "reference": "tr_abc123",          // OUR transfer id — echo it in callbacks
  "partner_id": "acme",
  "corridor": { "source": "US", "destination": "IN" },
  "payout":   { "rail": "bank", "destination": "123456789012|HDFC0001234" },
  "recipient":{ "name": "Anita Sharma", "phone": "919876543210" },
  "amount": {
    "source": 200, "currency": "USD",
    "destination": 16600, "destination_currency": "INR",
    "fx_rate": 83                     // locked at quote time
  }
}`}</Code>
          <p className="text-sm text-muted-foreground">
            Respond <code>2xx</code> with an optional <code>{`{ "providerRef": "…" }`}</code> —
            stored write-once against the transfer. Use <code>reference</code> to deduplicate: the
            instruction is at-least-once.
          </p>
          {/* keep in sync with RAIL_TIMEOUT_MS in src/lib/providers/http-payment-provider.ts */}
          <p className="text-sm text-muted-foreground">
            <strong>Ack deadline: 15 seconds.</strong> We wait at most 15s for your <code>2xx</code>;
            a slower response is treated as a failure and the SAME instruction (same{' '}
            <code>reference</code>) is retried with exponential backoff. Persist and ack first, then
            process asynchronously — and dedupe on <code>reference</code>, so a retry after a slow
            ack can never pay out twice.
          </p>
          {/* keep in sync with src/lib/settlement-url.ts + src/lib/safe-fetch.ts (fix 22) */}
          <p className="text-sm text-muted-foreground">
            <strong>Endpoint requirements.</strong> Your <code>settlementUrl</code> must be a public{' '}
            <code>https://</code> host on port 443 (no IP literals, no internal or single-label names,
            no credentials in the URL). We follow at most two redirects, only <code>307</code>/
            <code>308</code> to the same origin — never a <code>301</code>/<code>302</code>/
            <code>303</code>, which would turn the signed POST into a GET. Your ack must be 64 KB or
            less, uncompressed (we send <code>Accept-Encoding: identity</code> and never decompress),
            and <code>providerRef</code> is at most 128 characters of <code>A–Z a–z 0–9 . _ : -</code>.
            An endpoint that fails these checks is refused before the instruction is sent: the
            instruction is retried with backoff and then raises an ops alert, so fix the endpoint in
            Admin → Partners → Payment and the retries pick it up.
          </p>
        </section>

        <Separator />

        <section id="webhooks" className="space-y-4">
          <h2 className="text-xl font-semibold">4 · Status webhooks (you → us)</h2>
          <p className="text-sm text-muted-foreground">
            Report lifecycle status to{' '}
            <code>POST /api/payment-webhook/&lt;provider&gt;</code>, signed the same way with your{' '}
            <code>webhookSecret</code> (fail-closed: unsigned or mis-signed callbacks are rejected
            with 401).
          </p>
          <Code>{`POST /api/payment-webhook/acme-rail
x-signature: 9c44…   # HMAC-SHA256(rawBody, webhookSecret)

{ "reference": "tr_abc123", "status": "paid_out" }`}</Code>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Status mapping</CardTitle>
              <CardDescription>
                The state machine is forward-only — replays and out-of-order callbacks are safe.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <ul className="space-y-1.5">
                <li><code>created</code> → awaiting payment (no-op transition)</li>
                <li><code>funded</code> → paid (customer charged on your side)</li>
                <li><code>paid_out</code> → delivered — triggers the branded WhatsApp delivery notifications</li>
                <li>
                  <code>failed</code> / <code>returned</code> → cancelled — the sender&apos;s charge is
                  refunded (a partner-pulled debit gets a signed <code>reverse</code> instruction) and the
                  customer is notified, in one transaction. An optional <code>reason</code> (string, ≤200
                  characters) is stored on the transfer&apos;s note for your ops and ours.
                </li>
              </ul>
              <ul className="mt-3 space-y-1.5 text-muted-foreground">
                <li>A <code>failed</code> after <code>paid_out</code> is recorded for ops and never reverses a delivery.</li>
                <li>A <code>paid_out</code> after a <code>failed</code> is refused and alerted — the transfer stays cancelled.</li>
                <li>A <code>reverse</code> for a debit that never happened must be a no-op on your side.</li>
              </ul>
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">
            No rail yet? Point your integration at the <strong className="text-foreground">hosted
            reference rail</strong> (<code>providerType: simulator</code>) — it verifies your
            signatures, acks a providerRef, and calls the public webhook back ~12s later, running
            the exact production loop end to end. To exercise the failure path, pay to a bank
            account that is all zeros (for India: account <code>000000000000</code>, IFSC{' '}
            <code>HDFC0001234</code>): the reference rail acks, then reports{' '}
            <code>failed</code> with reason <code>account_unreachable</code>.
          </p>
        </section>

        <Separator />

        <section id="whatsapp" className="space-y-4">
          <h2 className="text-xl font-semibold">5 · Your WhatsApp number & KYC mode</h2>
          <p className="text-sm text-muted-foreground">
            Bring your own Meta WhatsApp Business number: configure the phone-number id, access
            token, verify token, and app secret in the dashboard, then point Meta&apos;s webhook at
            your dedicated callback URL (shown on your partner page). Inbound messages on your
            number route to your tenant — replies, OTPs, and delivery notifications leave from{' '}
            <em>your</em> number under <em>your</em> brand.
          </p>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">KYC:</strong> run it yourself (delegated mode — you
            attest verification and our send-gate steps aside) or use SmartRemit&apos;s built-in
            tiered KYC. Sanctions screening is <strong className="text-foreground">not</strong>{' '}
            delegable — it always runs on our side.
          </p>
        </section>

        <footer className="border-t border-border pt-6 text-sm text-muted-foreground">
          SmartRemit is the technology platform; partners are the licensed money transmitters.
          Questions? Your dashboard&apos;s partner page lists every credential and URL this guide
          references. <Link href="/" className="text-primary hover:underline">← back to smartremit.ai</Link>
        </footer>
      </main>
    </div>
  );
}
