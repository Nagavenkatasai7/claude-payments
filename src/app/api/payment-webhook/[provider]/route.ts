import { NextRequest, NextResponse, after } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { railCallbackTransferId } from '@/lib/providers/http-payment-provider';
import { getPartnerStore } from '@/lib/partner-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { env } from '@/lib/env';
import { recipientTemplateParams, formatDestAmount } from '@/lib/payment';
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';

// WL3: the settlement status callback. A partner's rail (or our hosted reference
// rail) POSTs lifecycle events here; we verify the HMAC with THAT partner's
// webhook secret (resolved from the transfer the callback references), mirror
// the status through the forward-only state machine, and fire the terminal
// stage-2 notifications under the partner's brand from the partner's number.
// NON-CUSTODIAL: we only mirror what the licensed partner reports.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const raw = await req.text();                           // raw body first (for HMAC)
  const store = getStore();

  // Parse early ONLY to discover which transfer (and thus which partner + secret)
  // this callback references. Nothing acts on the body until the signature gate
  // below passes — JSON.parse + reads are side-effect-free.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 }); // malformed
  }

  // Resolve the owning partner from the referenced transfer (when present) so
  // verification uses the PARTNER's secret. An unknown/absent reference falls
  // back to the global per-provider env secret — still fail-closed.
  const refTransferId = railCallbackTransferId(body);
  const refTransfer = refTransferId ? await store.getTransfer(refTransferId) : null;
  const integrations = refTransfer
    ? await getPartnerIntegrationsStore().getIntegrations(refTransfer.partnerId)
    : null;

  // Mock skips verification (it never posts callbacks); every other provider MUST
  // verify: the partner's webhookSecret first, else the env per-provider secret.
  // '' ⇒ unconfigured ⇒ reject (fail-closed; never fail-open).
  if (provider !== 'mock') {
    const secret = integrations?.payment.webhookSecret || env.paymentWebhookSecret(provider);
    const signature = req.headers.get('x-signature') ?? '';
    if (!verifyWebhookSignature(raw, signature, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  }

  const result = await getPaymentProvider(store, createOutboxRepo(getDb()), integrations?.payment).handleWebhook(body);
  if (!result) {
    return NextResponse.json({ ok: true, ignored: true });  // unparseable/irrelevant → 200, no mutation
  }

  const updated = await store.updateTransferFromWebhook(result.transferId, result.status);
  // Fire stage-2 notifications ONLY on a real terminal transition (non-null + delivered).
  if (updated && updated.status === 'delivered') {
    after(async () => {
      try {
        // Brand + send from the OWNING partner's identity (default ⇒ SmartRemit + env number).
        const owningPartner = await getPartnerStore().getPartner(updated.partnerId);
        const brand = resolvePartnerBranding(owningPartner).brand;
        const waCreds = waCredsFrom(integrations);
        await sendText(
          updated.phone,
          `🎉 ${formatDestAmount(updated.amountInr, updated.destinationCurrency ?? 'INR')} delivered to ${updated.recipientName}. Thanks for using ${brand}!`,
          waCreds,
        );
        if (updated.recipientPhone) {
          await sendTemplate(
            updated.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
            recipientTemplateParams(updated),
            waCreds,
          );
        }
      } catch (err) {
        console.error('Webhook stage-2 notify failed:', err);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
