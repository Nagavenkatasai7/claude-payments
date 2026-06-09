import { NextRequest, NextResponse, after } from 'next/server';
import { env } from '@/lib/env';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { signBody } from '@/lib/providers/http-payment-provider';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';

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
  const raw = await req.text();

  let body: { reference?: unknown; partner_id?: unknown } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }
  const reference = typeof body.reference === 'string' ? body.reference : '';
  const partnerId = typeof body.partner_id === 'string' ? body.partner_id : '';
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

  // Settle asynchronously: after a realistic lag, POST the SIGNED status callback
  // through the public webhook — the REAL delivery path (no internal shortcut).
  const webhookSecret = integrations.payment.webhookSecret ?? '';
  after(async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
      const callbackBody = JSON.stringify({ reference, status: 'paid_out' });
      const res = await fetch(`${env.appBaseUrl}/api/payment-webhook/simulator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'x-signature': signBody(callbackBody, webhookSecret) } : {}),
        },
        body: callbackBody,
      });
      if (!res.ok) {
        console.error(`partner-rail: status callback rejected (${res.status}) for ${reference}`);
      }
    } catch (err) {
      console.error('partner-rail: status callback failed:', err);
    }
  });

  return NextResponse.json({ ok: true, providerRef: `simrail-${reference}` });
}
