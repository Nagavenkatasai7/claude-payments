import { NextRequest, NextResponse, after } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { verifyRailSignature } from '@/lib/providers/rail-signature';
import { railCallbackTransferId, checkCallbackAmount } from '@/lib/providers/http-payment-provider';
import { railSecrets, type PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';
import { railNonceSeen, markRailNonce } from '@/lib/rail-replay';
import { getPartnerStore } from '@/lib/partner-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getDb } from '@/db/client';
import { createOutboxRepo, type OutboxRepo } from '@/db/repos/outbox-repo';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { logWarn } from '@/lib/log';
import { handleRailFailure, alertRefusedDelivery } from '@/lib/rail-failure';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { env } from '@/lib/env';
import { recipientTemplateParams, recipientDeliveredFallbackText, formatDestAmount, recipientDisplayName } from '@/lib/payment';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError } from '@/lib/log';
import {
  sendText, sendTemplate, sendTemplateOrText, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
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

  // EVERY provider segment verifies (fix 29, authz-08: /mock no longer skips —
  // nothing legitimate posts there, and the mock provider parses nothing).
  // Secrets: the rail partner's webhookSecret (+ its unexpired previous one
  // during a rotation) first, else the env per-provider secret (+ the optional
  // env _PREVIOUS). No secret ⇒ unconfigured ⇒ reject (fail-closed).
  const nowMs = Date.now();
  const envSecret = env.paymentWebhookSecret(provider);
  const secrets = railIntegrations?.payment.webhookSecret
    ? railSecrets(railIntegrations.payment, 'webhook', new Date(nowMs))
    : envSecret
      ? [envSecret, env.paymentWebhookSecretPrevious(provider)].filter((s) => s !== '')
      : []; // a previous secret alone never verifies
  const verified = verifyRailSignature(raw, req.headers, secrets, nowMs, {
    partnerId: railPartnerId,
    route: 'payment-webhook',
  });
  if (!verified.ok) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }

  // fix 29: replay guard for the timestamped scheme — CHECK here, MARK only
  // after the handling below returned. A throw propagates (the rail retries)
  // and leaves no mark. Redis down ⇒ 'unavailable' ⇒ proceed (fail-open; the
  // ±5 min window still holds and every downstream effect is idempotent).
  if (verified.scheme === 'v2' && (await railNonceSeen(verified.nonce)) === 'seen') {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  const response = await handleVerified(provider, body, railPartnerId, railIntegrations, refTransfer);
  if (verified.scheme === 'v2') await markRailNonce(verified.nonce);
  return response;
}

async function handleVerified(
  provider: string,
  body: unknown,
  railPartnerId: string | null,
  railIntegrations: PartnerIntegrations | null,
  refTransfer: Transfer | null,
): Promise<NextResponse> {
  const store = getStore();
  const outbox = createOutboxRepo(getDb());
  const result = await getPaymentProvider(store, outbox, railIntegrations?.payment).handleWebhook(body);
  if (!result) {
    return NextResponse.json({ ok: true, ignored: true });  // unparseable/irrelevant → 200, no mutation
  }

  // fix 8 (money-02 / rail-02): a signed `failed` / `returned` is acted on —
  // cancel + refund + customer notice + ops alert in ONE transaction (or an
  // alert alone when the row is not `paid`). Below the HMAC gate, so an
  // unsigned failure can never act; the `/mock` segment reaches the mock
  // provider's null above. A throw here 500s and the rail retries: at-least-
  // once, idempotent by the row claim and the dedupe keys.
  if ('failure' in result) {
    await handleRailFailure(getDb(), result.transferId, result.failure);
    return NextResponse.json({ ok: true });
  }

  // fix 29 (money-09): a delivery is checked before it may land.
  //  • a row already HELD for an amount mismatch (`railamount:<id>`) is never
  //    delivered by a later callback — staff resolve it by cancel/refund;
  //  • the callback's `amount` must equal the locked instruction amount. A
  //    mismatch (or a partial/unparseable block) never settles: one deduped
  //    ops alert (transfer id only) and 200 held, so the rail stops retrying.
  //    No amount at all is accepted for now, with a deprecation log.
  if (result.status === 'delivered') {
    if (await outbox.hasDedupeKey(`railamount:${result.transferId}`)) {
      logWarn('payment-webhook.held', 'delivery refused: transfer is held for an amount mismatch', {
        transferId: result.transferId,
      });
      return NextResponse.json({ ok: true, held: true });
    }
    if (refTransfer && refTransfer.id === result.transferId) {
      const amountCheck = checkCallbackAmount(refTransfer, body);
      if (amountCheck === 'mismatch') {
        await holdForAmountMismatch(outbox, result.transferId);
        logWarn('payment-webhook.amount_mismatch', 'delivery held: callback amount differs from the instruction', {
          transferId: result.transferId,
          partnerId: railPartnerId,
        });
        return NextResponse.json({ ok: true, held: true });
      }
      if (amountCheck === 'absent') {
        logWarn('payment-webhook.amount_absent', 'paid_out callback without an amount block (deprecated)', {
          transferId: result.transferId,
          partnerId: railPartnerId,
          provider,
        });
      }
    }
  }

  const updated = await store.updateTransferFromWebhook(result.transferId, result.status);
  // fix 8: a REFUSED paid_out on a cancelled row, or on a paid row with a refund
  // in progress, is never silent — money may have moved twice (railconflict:<id>).
  if (!updated && result.status === 'delivered') {
    await alertRefusedDelivery(getDb(), result.transferId);
  }
  // Fire stage-2 notifications ONLY on a real terminal transition (non-null + delivered).
  if (updated && updated.status === 'delivered') {
    // Phase 4 (B2B): "update accounting" — flip the linked mock invoice to paid.
    // Idempotent; a failure here is non-critical (admin/reconcile can correct it).
    if (updated.invoiceId) {
      try {
        await store.markB2bInvoicePaid(
          updated.invoiceId,
          updated.deliveredAt ?? new Date().toISOString(),
        );
      } catch (err) {
        logWarn('b2b.invoice_mark_paid', err, { transferId: updated.id });
      }
    }
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
          `🎉 ${formatDestAmount(updated.amountInr, updated.destinationCurrency ?? 'INR')} delivered to ${recipientDisplayName(updated)}. Thanks for using ${brand}!`,
          waCreds,
        );
        if (updated.recipientPhone) {
          // Template-first (reaches a recipient outside the 24h window), but
          // degrade to a free-form text if Meta rejects the template — otherwise
          // the recipient silently gets nothing while the sender is notified.
          const recipientPhone = updated.recipientPhone;
          await sendTemplateOrText(
            recipientPhone,
            () => sendTemplate(
              recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
              recipientTemplateParams(updated),
              waCreds,
            ),
            recipientDeliveredFallbackText(updated, brand),
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

/**
 * fix 29: the ONE durable hold marker + ops alert for an amount mismatch. The
 * `railamount:<id>` dedupe key is what the instruct handler, reconcileSweep and
 * this route read (outboxRepo.hasDedupeKey) to never deliver or re-instruct the
 * row. Transfer id only — no amounts, no PII.
 */
async function holdForAmountMismatch(outbox: OutboxRepo, transferId: string): Promise<void> {
  await outbox.enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: transfer ${transferId} — the rail's paid_out reported a different ` +
        `amount than the settlement instruction. NOT delivered; held (stays paid, never re-instructed). ` +
        `Investigate with the rail, then cancel/refund it.`,
    },
    { dedupeKey: `railamount:${transferId}` },
  );
}
