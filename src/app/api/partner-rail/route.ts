import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';

// partner-rail — SmartRemit's HOSTED REFERENCE RAIL (WL3). This endpoint plays
// the role of a partner's settlement system, end to end and for real:
//   1. receives the SIGNED settlement instruction (verifies the HMAC with the
//      partner's signingSecret — exactly what a real rail must do),
//   2. acks with a providerRef,
//   3. settles, then POSTs a SIGNED `paid_out` callback to the public
//      /api/payment-webhook/simulator route — the same loop a live rail runs.
// Partners select it as providerType 'simulator'; swapping in their real
// endpoint later changes ONLY the settlementUrl — no code change.
//
// NON-CUSTODIAL: no funds exist here; this is the integration loop, hosted.

const SETTLE_DELAY_MS = 12_000; // a realistic, demo-friendly settlement lag

export async function POST(req: NextRequest) {
  // Stage 3: blunt per-IP ceiling (signature gate below is the real auth).
  const limited = await enforceIpRateLimit(req, 'rail', 120);
  if (limited) return limited;

  const raw = await req.text();

  let body: { reference?: unknown; partner_id?: unknown; action?: unknown } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }
  const reference = typeof body.reference === 'string' ? body.reference : '';
  const partnerId = typeof body.partner_id === 'string' ? body.partner_id : '';
  // 'reverse' = a B2B ach_pull return instruction; 'settle' (default) = a payout.
  const action = typeof body.action === 'string' ? body.action : 'settle';
  if (!reference || !partnerId) {
    return NextResponse.json({ ok: false, error: 'reference and partner_id are required' }, { status: 400 });
  }

  // The rail knows its own secrets — resolve this partner's config and verify
  // the instruction's signature. Fail-closed: only partners explicitly pointed
  // at the reference rail (providerType 'simulator') are served.
  const integrations = await getPartnerIntegrationsStore().getIntegrations(partnerId);
  if (integrations.payment.providerType !== 'simulator') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const signingSecret = integrations.payment.credentials?.signingSecret ?? '';
  const signature = req.headers.get('x-signature') ?? '';
  if (!verifyWebhookSignature(raw, signature, signingSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }

  // A REVERSE (B2B ach_pull return) has NO payout to settle — the rail simply
  // acknowledges it returned the debit it owns. So we DON'T schedule a payout
  // callback (which would POST a bogus `paid_out` for a non-existent transfer id);
  // the worker completes the reversal synchronously on this 2xx ack, exactly as a
  // funds-return (b2c refund) completes on its provider's response.
  if (action === 'reverse') {
    return NextResponse.json({ ok: true, providerRef: `simrail-${reference}`, action: 'reverse' });
  }

  // Settle asynchronously: a DELAYED outbox row (Stage 2b — was a best-effort
  // after() sleep). The worker POSTs the SIGNED status callback through the
  // public webhook with retries/backoff/dead-letter — the REAL delivery path,
  // now guaranteed-eventually even if this function dies.
  await createOutboxRepo(getDb()).enqueue(
    'rail.callback',
    { reference, partner_id: partnerId },
    { delayMs: SETTLE_DELAY_MS, dedupeKey: `railcb:${reference}` },
  );
  pokeWorker();

  return NextResponse.json({ ok: true, providerRef: `simrail-${reference}` });
}
