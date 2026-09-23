import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { env } from '@/lib/env';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError } from '@/lib/log';
import { verifyStripeSignature } from '@/lib/providers/stripe-signature';
import { parseStripeFundingEvent } from '@/lib/providers/stripe-funding-provider';
import { processStripeFundingEvent } from '@/lib/stripe-funding-webhook';

// Program-Fix 7 — the Stripe FUNDING webhook, one endpoint PER PARTNER:
// POST /api/funding-webhook/stripe/<partnerId>. Each licensed partner points a
// webhook endpoint in THEIR OWN Stripe account here; its signing secret lives
// encrypted in that partner's partner_integrations funding config. A verified
// event is therefore scoped to exactly that tenant (every ledger lookup below
// is (partnerId, intent)). The generic [provider] HMAC route is unchanged and
// can never record a Stripe charge (setFundingRef refuses intent-bound rows).
//
// Order (every refusal is fail-closed, before any money logic):
//   1. per-IP rate limit (loose; Stripe retries on non-2xx) — before any read;
//   2. provider must be 'stripe' (404 otherwise); partner id shape-checked;
//   3. flag OFF / unknown partner / no config / no endpoint secret ⇒ 401 — the
//      SAME 401 as a bad signature, so the route never reveals who is set up;
//   4. Stripe-Signature v1 over the RAW body, 5-min tolerance
//      (https://docs.stripe.com/webhooks, "Verify webhook signatures manually");
//   5. JSON parse; irrelevant event types ⇒ 200 ignored;
//   6. processStripeFundingEvent (transactional; idempotent on event id).
// Route params: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:101
// (`app/shop/[tag]/[item]/route.js` ⇒ params Promise<{ tag, item }>).

const PARTNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Stripe snapshot events are small; refuse anything absurd before hashing it. */
const MAX_BODY_BYTES = 256 * 1024;

const unauthorized = () => NextResponse.json({ ok: false }, { status: 401 });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; partnerId: string }> },
) {
  const limited = await enforceIpRateLimit(req, 'fwhk', 600);
  if (limited) return limited;

  const { provider, partnerId } = await params;
  if (provider !== 'stripe') return NextResponse.json({ ok: false }, { status: 404 });
  if (!PARTNER_ID.test(partnerId)) return unauthorized();

  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }
  if (!env.stripeFundingEnabled) return unauthorized();

  const db = getDb();
  let secrets: string[] = [];
  try {
    const config = await createIntegrationsRepo(db).getFundingConfig(partnerId);
    secrets = config?.webhookSecrets ?? [];
  } catch (err) {
    // A config that fails to decrypt is treated as absent — never as "verified".
    logError('stripe-funding-webhook.config', err, { partnerId });
    return unauthorized();
  }
  if (secrets.length === 0) return unauthorized();

  const signature = req.headers.get('stripe-signature') ?? '';
  if (!verifyStripeSignature(raw, signature, secrets)) return unauthorized();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const event = parseStripeFundingEvent(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  try {
    const result = await processStripeFundingEvent(db, partnerId, event, {
      allowTestMode: env.stripeFundingAllowTestMode,
    });
    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    logError('stripe-funding-webhook.process', err, { partnerId });
    return NextResponse.json({ ok: false }, { status: 500 }); // Stripe redelivers
  }
}
