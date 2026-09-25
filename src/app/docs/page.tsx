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

// The scope each Partner API route requires, and whether a test key holds it
// (TEST_SCOPES in src/lib/partner-api-scopes.ts). Live keys hold all nine.
const SCOPE_ROWS: ReadonlyArray<readonly [route: string, scope: string, test: boolean]> = [
  ['GET /corridors', 'corridors:read', true],
  ['POST /quote', 'quote', true],
  ['POST /beneficiaries/validate', 'beneficiaries:validate', true],
  ['POST /beneficiaries', 'beneficiaries:write', false],
  ['GET /transactions · GET /transactions/:id', 'transactions:read', true],
  ['POST /transactions · POST /transactions/:id/confirm', 'transactions:write', true],
  ['GET /rates', 'rates:read', false],
  ['PUT /rates', 'rates:write', false],
  ['GET /settlements', 'settlements:read', false],
];

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

        {/* Program-Fix 42 (docs-04): the honest status note, worded as on /about
            (src/app/about/page.tsx "Honest status note" and "Sanctions screening
            always on"), so a partner reading the API guide is not left to assume
            a live rail, a live identity vendor or a commercial sanctions feed. */}
        <Card role="note" aria-labelledby="docs-status-title" className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle id="docs-status-title" className="text-base">
              Where we are today
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              {`SmartRemit is a working demonstration of production-grade remittance infrastructure. The AI conversation, live FX quoting, signed instruction-and-callback loop, durable processing, dashboards and WhatsApp notifications are real. Actual fund movement, the production identity-verification vendor, a commercial sanctions feed, and a live payout rail are simulated today — a reference "simulator" rail runs the exact signed loop a production rail would. We'll only describe those as live once they are.`}
            </p>
            <p>
              {`Sanctions screening runs on every transfer and is structurally impossible to switch off, in every mode. (In today's demonstration it runs against a built-in reference rule set, not yet a live commercial AML feed.)`}
            </p>
          </CardContent>
        </Card>

        <Separator />

        <section id="api" className="space-y-4">
          <h2 className="text-xl font-semibold">1 · The Partner API</h2>
          <p className="text-sm text-muted-foreground">
            Base URL <code>https://smartremit.ai/api/partner/v1</code>. Authenticate every
            request with your API key (issued in the dashboard, shown once):
          </p>
          <Code>{`Authorization: Bearer <your-api-key>`}</Code>
          <p className="text-sm text-muted-foreground">
            Errors are JSON: <code>{`{ "error": "…" }`}</code>. <code>503</code> means live FX
            is temporarily unavailable (or another transfer for the same sender is in progress)
            and nothing was minted — retry later (a <code>POST /transactions</code> retry may reuse
            the same Idempotency-Key; see <a href="#idempotency" className="underline">Idempotency</a>).
          </p>

          {/* keep in sync with src/lib/partner-api-scopes.ts, guardPartner in src/lib/partner-api.ts
              and the guardPartner(req, scope) call in each partner/v1 route.ts (R6a) */}
          <Card id="keys">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Keys, environments and scopes</CardTitle>
              <CardDescription>
                Every key is either live or test, and each route needs one scope.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>
                  A live key starts <code>sr_live_</code>; a test (sandbox) key starts{' '}
                  <code>sr_test_</code>. The mode comes from the key itself: the whole key, prefix
                  included, is what we verify, so editing the prefix only makes the key invalid (401).
                </li>
                <li>
                  A test key only ever creates and sees <strong className="text-foreground">sandbox</strong>{' '}
                  transactions. They settle on the mock rail, never message a customer or recipient,
                  and can never be paid on the hosted pay page. Sanctions screening still runs on every
                  sandbox transaction. A live key never sees sandbox transactions, and a test key never
                  sees live ones (<code>404</code>).
                </li>
                <li>
                  A key is a long-lived bearer secret: it does not expire, and it is shown once, when it
                  is issued on your partner page in the dashboard. Keep it server-side. To rotate, issue a
                  new key, move your traffic to it, then revoke the old one there. A revoked or unknown
                  key gets <code>401</code> <code>Invalid or revoked API key.</code>
                </li>
              </ul>
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[520px] text-left">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="py-1.5 pr-4 font-medium">Route</th>
                      <th className="py-1.5 pr-4 font-medium">Scope</th>
                      <th className="py-1.5 pr-4 font-medium">Live key</th>
                      <th className="py-1.5 font-medium">Test key</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {SCOPE_ROWS.map(([route, scope, test]) => (
                      <tr key={scope}>
                        <td className="py-1.5 pr-4"><code>{route}</code></td>
                        <td className="py-1.5 pr-4"><code>{scope}</code></td>
                        <td className="py-1.5 pr-4">Yes</td>
                        <td className="py-1.5">{test ? 'Yes (sandbox only)' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground">
                A key is issued with every scope its mode allows, as in the table. A request
                outside the key&apos;s scopes gets <code>403</code>{' '}
                <code>{`{ "error": "This key cannot perform this action." }`}</code>. A key whose
                partner is not active gets <code>403</code>{' '}
                <code>{`{ "error": "Partner not active." }`}</code>.
              </p>
            </CardContent>
          </Card>

          {/* keep in sync with src/lib/partner-rate-limit.ts + guardPartner in src/lib/partner-api.ts (R6a) */}
          <Card id="rate-limits">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Rate limits</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>
                  <strong className="text-foreground">120 requests per minute per partner</strong>,
                  shared by all of your keys, live and test together. Each key is also capped at 120
                  per minute on its own.
                </li>
                <li>
                  The window is a fixed calendar minute (UTC), not a rolling 60 seconds: the count
                  resets at the start of each minute.
                </li>
                <li>
                  Every request with a valid key counts, including ones answered <code>403</code> or{' '}
                  <code>429</code>. A request refused <code>401</code> (missing, unknown or revoked key)
                  is not counted.
                </li>
                <li>
                  Over the limit you get <code>429</code> with body{' '}
                  <code>{`{ "error": "Rate limit exceeded." }`}</code> and the header{' '}
                  <code>Retry-After: 60</code> (always 60 seconds, whatever is left of the minute).
                  Back off before retrying, and add random jitter so your workers don&apos;t all retry
                  at the same moment.
                </li>
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="divide-y divide-border pt-4">
              <Endpoint method="GET" path="/corridors" desc="Your enabled send corridors + brand" />
              <Endpoint method="POST" path="/quote" desc="Price a transfer (amount_source, source_currency)" />
              <Endpoint method="POST" path="/beneficiaries/validate" desc="Validate payout fields for a country" />
              <Endpoint method="POST" path="/beneficiaries" desc="Store a beneficiary (payout details encrypted at rest)" />
              <Endpoint method="POST" path="/transactions" desc="Mint a transfer — Idempotency-Key header REQUIRED" />
              <Endpoint method="GET" path="/transactions" desc="List your transfers (keyset: ?limit=&cursor=)" />
              <Endpoint method="GET" path="/transactions/:id" desc="Fetch one transfer (404 outside your scope)" />
              <Endpoint method="GET" path="/settlements" desc="Settlements statement for reconciliation (?from=&to=&limit=&cursor=&format=json|csv)" />
              <Endpoint method="POST" path="/transactions/:id/confirm" desc="Confirm funds captured → settlement begins (a flagged transfer is held in_review for compliance release; a blocked one is 422)" />
              <Endpoint method="PUT" path="/rates" desc="Push one corridor's wholesale conversion rate" />
              <Endpoint method="GET" path="/rates" desc="Your current rate sheet (freshness + margin)" />
            </CardContent>
          </Card>
          <Code>{`# Mint a transfer (idempotent — safe to retry with the same key)
curl -X POST $BASE/transactions \\
  -H "Authorization: Bearer $KEY" \\
  -H "Idempotency-Key: 5f0c8a3e-2b7d-4e61-9a4f-0d3b8c1e7a52" \\
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
            watchlist hit returns 422 and the attempt is recorded as <code>blocked</code>. (In today&apos;s demonstration it runs against a built-in reference rule set, not yet a live commercial AML feed.) A later request with the same Idempotency-Key returns that blocked transaction with 200 — see <a href="#idempotency" className="underline">Idempotency</a>. A <code>payout_destination</code> that is a masked display value (for example <code>****1234</code> or <code>account on file</code>) is refused with 422 before the Idempotency-Key is bound. Idempotency-Key values beginning <code>draft:</code>, <code>b2binvoice:</code>, <code>sched:</code> or <code>test:</code> are reserved and refused with 400. A payer can never change the beneficiary account of a transaction created through this API: every transaction is bound to its Idempotency-Key before it is created, and that binding locks the account. A transaction still <code>awaiting_payment</code> and unpaid 7 days after it was created expires: its status becomes <code>cancelled</code> and it can no longer be paid.
          </p>
          <p className="text-sm text-muted-foreground">
            Names — <code>beneficiary.name</code>, <code>sender.name</code> and the <code>name</code> of a stored beneficiary — must be 1–80 characters with no brackets (<code>{'[ ] { } < >'}</code>) and no control or line-break characters. <code>payout_method</code> must be one of <code>bank</code>, <code>upi</code> or <code>usdc</code> (default <code>bank</code>), and an inline <code>payout_destination</code> is at most 64 printable characters. <code>destination_country</code> is optional and defaults to <code>IN</code>; when present it must be one of {destinationListText()} — any other value is refused with 400 (it is never coerced to India). Each is refused with 400 before the Idempotency-Key is bound, so a corrected retry with the same key succeeds. Transactions created through this API are never added to the customer&apos;s saved recipients in chat.
            <code>sender.name</code> is optional today but strongly recommended: a transaction created without it is held for manual review (it is created with <code>compliance_status</code> <code>flagged</code>, and confirming it returns <code>in_review</code> until compliance staff release it). <code>sender.name</code> will become required in a future version.
          </p>

          {/* keep in sync with createTransaction in src/lib/partner-api-service.ts (R6a) */}
          <Card id="idempotency">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Idempotency</CardTitle>
              <CardDescription>
                How the <code>Idempotency-Key</code> header on <code>POST /transactions</code> behaves.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>
                  The header is required on <code>POST /transactions</code> only (missing: <code>400</code>).
                  No other route is idempotent: in particular, retrying <code>POST /beneficiaries</code>{' '}
                  stores a second beneficiary.
                </li>
                <li>
                  Use a fresh random UUID per transaction and put no personal data in it. We recommend
                  at most 255 characters. Keys are kept indefinitely, per partner and per environment:
                  the same key sent with a test key and with a live key makes two separate transactions.
                </li>
                <li>
                  <strong className="text-foreground">Once a transaction exists under a key, every request
                  with that key and a valid body returns that same transaction</strong>: <code>200</code> with the same{' '}
                  <code>id</code> and its <em>current</em> state (not a copy of the first response). A
                  concurrent duplicate can also get <code>201</code> for the same <code>id</code>, or a
                  retryable <code>503</code>.
                </li>
                <li>
                  <strong className="text-foreground">The body is validated but not compared.</strong> A
                  different body that passes validation returns the original transaction and is not
                  applied; one that fails validation is refused as usual (<code>400</code>/<code>404</code>/
                  <code>422</code>). Never reuse a key for a different transfer.
                </li>
                <li>
                  This includes a transaction blocked by sanctions screening: the first request gets{' '}
                  <code>422</code>, a repeat with the same key gets <code>200</code> with the blocked
                  transaction. Always read <code>status</code> and <code>compliance_status</code> in the
                  body, not only the HTTP code.
                </li>
                <li>
                  If a request failed with any error other than <code>409</code> and no transaction was
                  created, a retry with the same key is validated again from scratch using the body you
                  send then, and creates the transaction if it now succeeds.
                </li>
                <li>
                  <code>409</code> <code>Idempotency-Key conflict. Retry with a new key.</code> is rare and
                  means exactly that: the key can no longer be used, so retry with a new one.
                </li>
                <li>
                  Reserved prefixes, refused with <code>400</code>: <code>draft:</code>,{' '}
                  <code>b2binvoice:</code>, <code>sched:</code> and <code>test:</code>.
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card id="settlements">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">GET /settlements — settlements statement</CardTitle>
              <CardDescription>
                Reconcile your book against ours: every transfer of yours that was paid and sent for settlement in a time window.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                SmartRemit is non-custodial, so this is the <strong className="text-foreground">instruction ledger</strong>{' '}
                (what was paid and instructed to a rail), not a record of funds held. In today&apos;s demonstration the
                payout rail is the reference simulator, so <code>provider_ref</code> values and delivery are simulated.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  The window is half-open <code>[from, to)</code> on <code>paid_at</code>, in UTC. <code>from</code>/<code>to</code>{' '}
                  take a date (<code>2026-09-01</code>, midnight UTC) or a datetime (no zone means UTC). Default: yesterday.
                  At most 31 days; a longer or reversed window is 400.
                </li>
                <li>
                  Listed: <code>paid</code> and <code>delivered</code> transfers, and <code>cancelled</code> ones only if a rail was
                  instructed (see <code>refund_status</code>). A transfer held for compliance review (<code>in_review</code>) is never
                  listed; once released it appears on its release day.
                </li>
                <li>
                  Oldest first. <code>limit</code> 1–500 (default 100). Pass <code>next_cursor</code> back as <code>cursor</code>{' '}
                  to get the next page; treat it as opaque. <code>null</code> means the last page.
                </li>
                <li>
                  <code>totals</code> cover <strong className="text-foreground">this page only</strong> (every listed row,
                  cancelled included), per currency, in integer minor units (cents: <code>20000</code> = 200.00).
                </li>
                <li>
                  <code>format=csv</code> returns <code>text/csv</code> as an attachment, and the next cursor in the{' '}
                  <code>X-Next-Cursor</code> header. A text cell starting with <code>{'= + - @'}</code>, a tab or a carriage return is
                  prefixed with <code>&apos;</code> so a spreadsheet never runs it as a formula.
                </li>
                <li>Results are always scoped to your API key&apos;s partner; any <code>partner_id</code> parameter is ignored.</li>
              </ul>
              <Code>{`curl "$BASE/settlements?from=2026-09-01&to=2026-09-08&limit=100" \\
  -H "Authorization: Bearer $KEY"

{
  "settlements": [
    { "reference": "Qm9…", "status": "delivered", "compliance_status": "cleared",
      "refund_status": "none", "amount_source": 200, "source_currency": "USD",
      "fee_source": 1.99, "total_charge_source": 201.99, "fx_rate": 85.2,
      "amount_destination": 17040, "destination_currency": "INR",
      "destination_country": "IN", "payout_rail": "bank",
      "provider_ref": "simrail-Qm9…", "funding_ref": null, "refund_ref": null,
      "created_at": "2026-09-02T10:00:00.000Z", "paid_at": "2026-09-02T10:01:12.345Z",
      "delivered_at": "2026-09-02T10:01:20.000Z", "refunded_at": null }
  ],
  "next_cursor": null,
  "totals": { "count": 1,
              "amount_source_minor_by_currency": { "USD": 20000 },
              "amount_destination_minor_by_currency": { "INR": 1704000 } },
  "window": { "from": "2026-09-01T00:00:00.000Z", "to": "2026-09-08T00:00:00.000Z" }
}

# The same page as CSV
curl -OJ "$BASE/settlements?from=2026-09-01&to=2026-09-08&format=csv" \\
  -H "Authorization: Bearer $KEY"`}</Code>
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-1.5 pr-4 font-medium">Field</th>
                    <th className="py-1.5 pr-4 font-medium">Type</th>
                    <th className="py-1.5 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`reference`}</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5">The transaction id (the same id as <code>/transactions/:id</code>).</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`status`}</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5"><code>paid</code>, <code>delivered</code>, or <code>cancelled</code> (only a cancelled transfer that was instructed to a rail).</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`compliance_status`}</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5"><code>cleared</code> or <code>flagged</code> (a flagged transfer appears once staff released it).</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`refund_status`}</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5"><code>none</code>, <code>requested</code>, <code>pending</code>, <code>completed</code> or <code>failed</code>.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`amount_source · fee_source · total_charge_source`}</code></td>
                    <td className="py-1.5 pr-4">number</td>
                    <td className="py-1.5">Major units in <code>source_currency</code>.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`fx_rate · amount_destination`}</code></td>
                    <td className="py-1.5 pr-4">number</td>
                    <td className="py-1.5">Destination units per 1 source unit; the payout amount in <code>destination_currency</code>.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`source_currency · destination_currency · destination_country`}</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5">ISO 4217 / ISO 3166-1 alpha-2.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`payout_rail`}</code></td>
                    <td className="py-1.5 pr-4">string</td>
                    <td className="py-1.5"><code>bank</code>, <code>upi</code> or <code>usdc</code>.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`provider_ref`}</code></td>
                    <td className="py-1.5 pr-4">string | null</td>
                    <td className="py-1.5">The rail&apos;s settlement reference. On the reference simulator rail it is simulated.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`funding_ref · refund_ref`}</code></td>
                    <td className="py-1.5 pr-4">string | null</td>
                    <td className="py-1.5">The funding charge and refund references, when present.</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4"><code>{`created_at · paid_at · delivered_at · refunded_at`}</code></td>
                    <td className="py-1.5 pr-4">string | null</td>
                    <td className="py-1.5">ISO 8601 UTC. For a released compliance hold, <code>paid_at</code> is the release time.</td>
                  </tr>
                </tbody>
              </table>
              </div>
              <p className="text-muted-foreground">
                The statement never includes payout account details, recipient or sender identity.
              </p>
            </CardContent>
          </Card>
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
            acks 2xx. Every instruction carries a timestamped signature in the{' '}
            <code>x-smartremit-signature</code> header — verify it (see{' '}
            <a href="#signatures" className="underline">Signatures</a> below).
          </p>
          <Code>{`POST <your settlementUrl>
x-smartremit-signature: t=1790000000,v1=5d2e…   # recommended — verify this
x-signature: 3f1a…                              # deprecated — HMAC-SHA256 of the raw body

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
          {/* keep in sync with buildComplianceBlock in src/lib/providers/http-payment-provider.ts (Program-Fix 31) */}
          <div id="compliance-block" className="space-y-3">
            <h3 className="text-base font-semibold">Compliance block (additive)</h3>
            <p className="text-sm text-muted-foreground">
              Instructions also carry a top-level <code>compliance</code> object after the fields
              above. It is <strong className="text-foreground">additive and optional</strong>: ignore
              unknown keys, and do not reject an instruction that lacks it (instructions sent by an
              older release, or where the data could not be loaded, have no block or{' '}
              <code>originator: null</code>). The signatures cover it, like every other byte of the
              body.
            </p>
            <Code>{`"compliance": {
  "version": 1,
  "originator": {                     // null when routed or unavailable
    "entity_type": "individual",      // or "business" (name = the business)
    "name": "Ravi Kumar", "country": "US", "phone": "15551230000",
    "id_type": "passport", "id_last4": "1234"
  },
  "beneficiary": { "entity_type": "individual", "name": "Anita Sharma",
                   "relationship": "parent", "country": "IN" },
  "purpose": "family_support",
  "purpose_code": null,
  "kyc": { "status": "verified", "tier": "T1", "verified_at": "2026-09-01T12:00:00.000Z" },
  "screening": { "status": "cleared", "reasons": [],
                 "screened_at": "2026-09-23T10:00:00.000Z",
                 "list_source": "…", "list_version": "…", "decision": "clear" },
  "edd_required": false
}`}</Code>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>
                <strong>Never sent:</strong> the full ID number, date of birth, email or residential
                address. The originator&apos;s address is not included yet.
              </li>
              <li>
                <code>purpose</code> is our purpose value. <code>purpose_code</code> (for example an
                RBI purpose code) is always <code>null</code> for now: a draft, for counsel review.
              </li>
              <li>
                <code>list_source</code>, <code>list_version</code> and <code>decision</code> appear only
                when a sanctions screening record exists for the transfer.
              </li>
              <li>
                When a transfer is settled on a rail other than the owning partner&apos;s, the block
                carries <code>&quot;routed&quot;: true</code> and <code>originator: null</code>: the
                sender&apos;s identity is not shared with another partner.
              </li>
            </ul>
          </div>
          {/* keep in sync with src/lib/providers/rail-signature.ts (Program-Fix 29) */}
          <div id="signatures" className="space-y-3">
            <h3 className="text-base font-semibold">Signatures (both directions)</h3>
            <p className="text-sm text-muted-foreground">
              <code>x-smartremit-signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code> where{' '}
              <code>v1 = HMAC-SHA256(secret, t + &quot;.&quot; + rawBody)</code>, hex. Use the{' '}
              <code>signingSecret</code> on instructions (us → you) and the <code>webhookSecret</code>{' '}
              on status callbacks (you → us).
            </p>
            <Code>{`signed = t + "." + rawBody            // the exact bytes received
expected = hex(HMAC_SHA256(secret, signed))
valid = |now - t| <= 300 seconds
        AND some v1 in the header equals expected (constant-time compare)`}</Code>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>
                Reject anything outside the <strong>±5 minute</strong> window, and keep the messages you
                have already processed (e.g. a hash of <code>t.rawBody</code>) for at least 15 minutes:
                answer a repeat with <code>2xx</code> and do nothing. We do the same — a repeated
                callback gets <code>{`{ "ok": true, "duplicate": true }`}</code>.
              </li>
              <li>
                <strong>Key rotation:</strong> when a secret is changed in Admin → Partners → Payment,
                the old one stays valid for <strong>7 days</strong>. During that time our instructions
                carry one <code>v1</code> per active secret; accept the message if any of them matches.
                Your callbacks may be signed with either secret.
              </li>
              <li>
                <strong>Deprecated:</strong> <code>x-signature</code> (hex <code>HMAC-SHA256(rawBody,
                secret)</code>, no timestamp) is still sent and still accepted when{' '}
                <code>x-smartremit-signature</code> is absent. It will be retired — move to the
                timestamped header now. When <code>x-smartremit-signature</code> is present it alone
                decides.
              </li>
            </ul>
          </div>
        </section>

        <Separator />

        <section id="webhooks" className="space-y-4">
          <h2 className="text-xl font-semibold">4 · Status webhooks (you → us)</h2>
          <p className="text-sm text-muted-foreground">
            Report lifecycle status to{' '}
            <code>POST /api/payment-webhook/&lt;provider&gt;</code>, signed with your{' '}
            <code>webhookSecret</code> using the{' '}
            <a href="#signatures" className="underline">timestamped signature</a> (fail-closed:
            unsigned, mis-signed or out-of-window callbacks are rejected with 401).
          </p>
          <Code>{`POST /api/payment-webhook/acme-rail
x-smartremit-signature: t=1790000000,v1=9c44…   # HMAC-SHA256(webhookSecret, t + "." + rawBody)

{ "reference": "tr_abc123", "status": "paid_out",
  "amount": { "destination": 16600, "destination_currency": "INR" } }`}</Code>
          <p className="text-sm text-muted-foreground">
            <strong>Amount on <code>paid_out</code>:</strong> echo the <code>amount.destination</code>{' '}
            and <code>destination_currency</code> from our instruction. If they differ from what we
            instructed (to the minor unit), the transfer is <strong>not</strong> delivered: it is held
            for our ops team, who resolve it with you, and we answer{' '}
            <code>{`{ "ok": true, "held": true }`}</code> so you stop retrying. A{' '}
            <code>paid_out</code> without an <code>amount</code> is accepted for now but is
            deprecated.
          </p>
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
            attest verification) or use SmartRemit&apos;s built-in tiered KYC. Sanctions screening is{' '}
            <strong className="text-foreground">not</strong> delegable — it always runs on our side
            and cannot be switched off.
          </p>

          {/* keep in sync with sendGateActive (src/lib/kyc-gate.ts), createTransfer's KYC backstop
              (src/lib/transfer-create.ts) and deriveTier (src/lib/tier-rules.ts) (R6a) */}
          <Card id="kyc-attestation">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">KYC attestation on the API</CardTitle>
              <CardDescription>
                Your <code>sender.kyc_status</code> is your attestation; SmartRemit trusts it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Whether an unverified sender may send at all depends on your partner&apos;s{' '}
                <strong className="text-foreground">verify-before-send</strong> setting (off unless it
                was turned on for you), in either KYC mode. The value must be one of the five below,
                exactly as written (lowercase); any other value, or no value, counts as{' '}
                <code>not_started</code>. Always send it explicitly.
              </p>
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[560px] text-left">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="py-1.5 pr-4 font-medium"><code>kyc_status</code></th>
                      <th className="py-1.5 pr-4 font-medium">Verify-before-send off</th>
                      <th className="py-1.5 font-medium">Verify-before-send on</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    <tr>
                      <td className="py-1.5 pr-4"><code>verified</code></td>
                      <td className="py-1.5 pr-4">Sends.</td>
                      <td className="py-1.5">Sends.</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-4"><code>grandfathered</code></td>
                      <td className="py-1.5 pr-4">Sends.</td>
                      <td className="py-1.5">Refused (<code>422</code>).</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-4"><code>not_started</code> · <code>pending</code></td>
                      <td className="py-1.5 pr-4">Sends.</td>
                      <td className="py-1.5">Refused (<code>422</code>).</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 pr-4"><code>rejected</code></td>
                      <td className="py-1.5 pr-4">Refused (<code>422</code>).</td>
                      <td className="py-1.5">Refused (<code>422</code>).</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>
                  <strong className="text-foreground">Every new sender starts with a 3-day observation
                  window</strong>, counted from when we first see them, even if you attest{' '}
                  <code>verified</code>: during it the lower daily limit applies. After it, the higher
                  limit applies to every sender who can send.
                </li>
                <li>
                  A transfer over the sender&apos;s current limit is refused with <code>422</code>{' '}
                  <code>This transfer exceeds the sender&apos;s current sending limit.</code> (no figures
                  in the response).
                </li>
                <li>
                  Sanctions screening runs on every transaction whatever the attestation, sandbox
                  included.
                </li>
                <li>
                  Always send <code>sender.name</code> as well: without it the transaction is held for
                  manual review (see above).
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* keep in sync with recipientTemplateParams in src/lib/payment.ts and
              RECIPIENT_TEMPLATE_NAME / RECIPIENT_TEMPLATE_LANG in src/lib/whatsapp.ts (R6a) */}
          <Card id="delivery-template">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recipient delivery template</CardTitle>
              <CardDescription>
                The message a recipient gets when their money is delivered.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                A recipient usually has no open conversation with the sending number, so this notice
                is a WhatsApp message template. If you use your own WhatsApp number, create it in your
                own WhatsApp Business account with <strong className="text-foreground">exactly</strong>{' '}
                this name and language, or every send falls back to a plain text, which only reaches a
                recipient who messaged your number in the last 24 hours. (On SmartRemit&apos;s shared
                number, SmartRemit&apos;s own template is used and there is nothing to submit.)
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Name <code>transfer_delivered</code> · category Utility · language English (<code>en</code>)</li>
                <li>Exactly four body variables, in this order:</li>
              </ul>
              <Code>{`Hi {{1}}, you've received {{2}} from the sender with phone number {{3}}. It's on its way to your {{4}}.

{{1}} recipient name       sample: Priya
{{2}} amount delivered     sample: ₹4,750
{{3}} sender phone, masked sample: ••••4567
{{4}} payout label         sample: bank account`}</Code>
              <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>
                  The sender&apos;s phone number is always masked to its last 4 digits (for example{' '}
                  <code>••••4567</code>); the recipient never sees the full number.
                </li>
                <li>
                  <code>{'{{4}}'}</code> is always <code>bank account</code> today, whatever the payout method.
                </li>
                <li>
                  Submit the template well before you go live: Meta reviews it before it can be sent.
                </li>
              </ul>
            </CardContent>
          </Card>
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
