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
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError } from '@/lib/log';
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
  // Stage 3: LOOSE per-IP ceiling — real rails retry on 429, and the HMAC gate
  // below is the actual auth; this only blunts raw flooding.
  const limited = await enforceIpRateLimit(req, 'pwhk', 600);
  if (limited) return limited;

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

  // Resolve the RAIL partner from the referenced transfer (when present) so
  // verification uses THAT partner's secret. Best-rate routing: the callback
  // comes from the SETTLEMENT rail — when the transfer is routed
  // (settlementPartnerId set) the rail-side config (webhookSecret, provider
  // resolution) is the settlement partner's; unrouted ⇒ the owning partner's,
  // exactly as before. The transfer lookup itself is by id on the global
  // ledger — partner-agnostic, so a routed callback still finds it. An
  // unknown/absent reference falls back to the global per-provider env
  // secret — still fail-closed.
  const refTransferId = railCallbackTransferId(body);
  const refTransfer = refTransferId ? await store.getTransfer(refTransferId) : null;
  const railPartnerId = refTransfer
    ? (refTransfer.settlementPartnerId ?? refTransfer.partnerId)
    : null;
  const railIntegrations = railPartnerId
    ? await getPartnerIntegrationsStore().getIntegrations(railPartnerId)
    : null;

  // Mock skips verification (it never posts callbacks) — but ONLY when the
  // resolved rail is actually mock. The URL segment is caller-chosen: if the
  // transfer's rail partner is webhook-driven (http/simulator), an unsigned
  // POST to /mock must NOT bypass the HMAC gate (it would resolve the http
  // adapter below and flip real money state unauthenticated). Every other
  // provider MUST verify: the rail partner's webhookSecret first, else the
  // env per-provider secret. '' ⇒ unconfigured ⇒ reject (fail-closed).
  const railProviderType = railIntegrations?.payment.providerType;
  const railWebhookDriven = railProviderType === 'http' || railProviderType === 'simulator';
  if (provider !== 'mock' || railWebhookDriven) {
    const secret = railIntegrations?.payment.webhookSecret || env.paymentWebhookSecret(provider);
    const signature = req.headers.get('x-signature') ?? '';
    if (!verifyWebhookSignature(raw, signature, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  }

  const result = await getPaymentProvider(store, createOutboxRepo(getDb()), railIntegrations?.payment).handleWebhook(body);
  if (!result) {
    return NextResponse.json({ ok: true, ignored: true });  // unparseable/irrelevant → 200, no mutation
  }

  const updated = await store.updateTransferFromWebhook(result.transferId, result.status);
  // Fire stage-2 notifications ONLY on a real terminal transition (non-null + delivered).
  if (updated && updated.status === 'delivered') {
    after(async () => {
      try {
        // Brand + send from the OWNING partner's identity (default ⇒ SmartRemit + env number).
        // Routed transfers: the verified integrations above are the SETTLEMENT
        // partner's — re-resolve the OWNER's for the customer-facing sends.
        const owningPartner = await getPartnerStore().getPartner(updated.partnerId);
        const brand = resolvePartnerBranding(owningPartner).brand;
        const brandIntegrations =
          railPartnerId && railPartnerId !== updated.partnerId
            ? await getPartnerIntegrationsStore().getIntegrations(updated.partnerId)
            : railIntegrations;
        const waCreds = waCredsFrom(brandIntegrations);
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
        logError('payment-webhook.notify', err, { transferId: updated.id });
      }
    });
  }
  return NextResponse.json({ ok: true });
}
