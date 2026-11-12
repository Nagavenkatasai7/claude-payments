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
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createRailMessageRepo, RAIL_IN } from '@/db/repos/rail-message-repo';
import { railRecordAlertKey } from '@/lib/instruct-errors';
import { parsePayoutReference } from '@/lib/order-references';
import { pokeWorker } from '@/lib/outbox';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { logWarn } from '@/lib/log';
import { handleRailFailure, alertRefusedDelivery, alertCallbackOnHold } from '@/lib/rail-failure';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { env } from '@/lib/env';
import { recipientTemplateParams, recipientDeliveredFallbackText, formatDestAmount, recipientDisplayName } from '@/lib/payment';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError } from '@/lib/log';
import {
  sendText, sendTemplate, sendTemplateOrText, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';
import { WhatsAppSendError } from '@/lib/whatsapp-errors';
import { sendTextThenTemplate } from '@/lib/whatsapp-business-initiated';
import { deliveredSenderTemplate } from '@/lib/whatsapp-templates';
import { SANCTIONS_FUNDS_RULE } from '@/lib/sanctions/notices';
import { liveRefusalForRail } from '@/lib/live-gate';

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
    // Fix pack 5 T2 (P6): the verifier already logged the reason. A refused
    // legacy-only callback whose old HMAC verified is a genuine rail partner
    // still on the old scheme: tell ops (deduped per rail per hour). An
    // invalid legacy header raises nothing (no anonymous alert spam).
    if (verified.reason === 'legacy_rejected' && verified.legacyValid) {
      await alertRailLegacy(railPartnerId);
    }
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }

  // fix 29: replay guard for the timestamped scheme — CHECK here, MARK only
  // after the handling below returned a 2xx. A throw propagates (the rail retries)
  // and leaves no mark. Redis down ⇒ 'unavailable' ⇒ proceed (fail-open; the
  // ±5 min window still holds and every downstream effect is idempotent).
  if (verified.scheme === 'v2' && (await railNonceSeen(verified.nonce)) === 'seen') {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  // fix pack 5 (P4, D6): the sealed record of every verified callback, before
  // any effect; the nonce is marked only after handling, so a failed record is
  // retried by the rail; the stored body is the verified text from req.text(),
  // so a leading BOM is dropped and invalid UTF-8 becomes U+FFFD, and
  // body_sha256 hashes that text. The insert is ON CONFLICT (id) DO NOTHING
  // under inboundRailMessageId, so a replay that passes the nonce check (Redis
  // down, fail-open) adds no row and is still handled (idempotent effects).
  try {
    await createRailMessageRepo(getDb()).append({
      partnerId: refTransfer?.partnerId ?? null,
      railPartnerId,
      transferId: refTransfer?.id ?? refTransferId ?? null,
      direction: RAIL_IN,
      kind: 'callback',
      body: raw,
      signatureHeader: req.headers.get('x-smartremit-signature'),
    });
  } catch (err) {
    logWarn('payment-webhook.rail-record', err instanceof Error ? err.name : 'error', {
      transferId: refTransferId ?? null,
      railPartnerId,
    });
    await alertRailRecordInbound(refTransferId ?? null); // best-effort, never throws
    pokeWorker();
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const response = await handleVerified(provider, body, railPartnerId, railIntegrations, refTransfer);
  // Fix pack 5 T3 (P6): mark only after a HANDLED 2xx. A 422 (amount_required,
  // reference_unresolved) leaves the nonce unmarked, so a corrected retry of
  // the same message is processed, not taken for a duplicate.
  if (verified.scheme === 'v2' && response.ok) await markRailNonce(verified.nonce);
  return response;
}

/**
 * Fix pack 5 T2 (P30): one `raillegacy:<rail|unresolved>:<hour>` ops alert.
 * Ids only. Best-effort: a failed write is logged by error name and the
 * caller still answers the same 401.
 */
async function alertRailLegacy(railPartnerId: string | null): Promise<void> {
  const rail = railPartnerId ?? 'unresolved';
  const message =
    `⚠️ SmartRemit ops: a rail callback for rail partner ${rail} was refused (401): ` +
    'it was signed only with the legacy x-signature header. Ask the rail partner to sign with ' +
    'x-smartremit-signature (see the webhooks docs); the rail keeps retrying until it does. ' +
    'Further refusals for this rail this hour are coalesced into this alert.';
  try {
    await createOutboxRepo(getDb()).enqueue(
      'ops.alert',
      { message },
      { dedupeKey: `raillegacy:${rail}:${Math.floor(Date.now() / 3_600_000)}` },
    );
    pokeWorker();
  } catch (err) {
    logWarn('payment-webhook.raillegacy', err instanceof Error ? err.name : 'error', { partnerId: railPartnerId });
  }
}

/**
 * Fix pack 5 T10 (P30): one `railrecord:<hour>` ops alert (the key the worker
 * shares) when a verified callback could not be recorded. Ids only.
 * Best-effort: a failed write is logged by error name and the caller still
 * answers the same 500.
 */
async function alertRailRecordInbound(transferId: string | null): Promise<void> {
  const message =
    `⚠️ SmartRemit ops: a verified rail callback (transfer ${transferId ?? 'unresolved'}) could not be recorded in rail_messages, ` +
    'so it was NOT processed (answered 500; the rail retries). Further failures this hour are coalesced into this alert.';
  try {
    await createOutboxRepo(getDb()).enqueue('ops.alert', { message }, { dedupeKey: railRecordAlertKey() });
  } catch (err) {
    logWarn('payment-webhook.railrecord', err instanceof Error ? err.name : 'error', { transferId });
  }
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
  // partner-demo R4: every branch below may commit outbox rows (rail-failure
  // refund + notice + alert, amount hold, refused-delivery / on-hold alerts).
  // after() runs post-response, i.e. after they committed.
  pokeWorker();

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

  // fix 29 (money-09) + fix pack 5 T3 (P6): a delivery is checked before it may land.
  //  • a row already HELD for an amount mismatch (`railamount:<id>`) is never
  //    delivered by a later callback — staff resolve it by cancel/refund;
  //  • the callback must name the transfer it is about: no resolvable
  //    reference, or one that differs from the parsed transfer ⇒ 422
  //    reference_unresolved (ids-only log, no alert, nothing applied);
  //  • the callback's `amount` must equal the locked instruction amount. A
  //    mismatch (or a partial/unparseable block) never settles: one deduped
  //    ops alert (transfer id only) and 200 held, so the rail stops retrying.
  //    No amount block at all ⇒ 422 amount_required (nothing saved) plus one
  //    `railnoamount:<rail|unresolved>:<hour>` alert; the rail retries until
  //    it reports the amount (a 4xx leaves the nonce unmarked).
  if (result.status === 'delivered') {
    if (await outbox.hasDedupeKey(`railamount:${result.transferId}`)) {
      logWarn('payment-webhook.held', 'delivery refused: transfer is held for an amount mismatch', {
        transferId: result.transferId,
      });
      return NextResponse.json({ ok: true, held: true });
    }
    if (!refTransfer || refTransfer.id !== result.transferId) {
      logWarn('payment-webhook.reference_unresolved', 'delivered callback refused: the reference does not resolve to this transfer', {
        transferId: result.transferId,
        refTransferId: refTransfer?.id ?? null,
        partnerId: railPartnerId,
        provider,
      });
      return NextResponse.json({ ok: false, error: 'reference_unresolved' }, { status: 422 });
    }
    const amountCheck = checkCallbackAmount(refTransfer, body);
    if (amountCheck === 'mismatch') {
      await holdForAmountMismatch(outbox, result.transferId, refTransfer.complianceStatus === 'blocked');
      logWarn('payment-webhook.amount_mismatch', 'delivery held: callback amount differs from the instruction', {
        transferId: result.transferId,
        partnerId: railPartnerId,
      });
      return NextResponse.json({ ok: true, held: true });
    }
    if (amountCheck === 'missing') {
      // The pokeWorker() above already ran, so this alert row is picked up.
      // The id comes from the ledger row (`refTransfer.id`, proven equal to
      // `result.transferId` by the reference check above), never from `result`:
      // `result` is built by a provider that holds the rail's integrations, and
      // the static outbox gate (tests/outbox-payload-secrets.test.ts) refuses a
      // payload whose local dataflow reaches a PartnerIntegrations field.
      const rail = railPartnerId ?? 'unresolved';
      await outbox.enqueue(
        'ops.alert',
        {
          message:
            `⚠️ SmartRemit ops: a paid_out callback from rail partner ${rail} for transfer ${refTransfer.id} was refused (422 amount_required): ` +
            'it carried no amount block, so the transfer was not marked delivered. Ask the rail partner to report amount.destination and ' +
            'amount.destination_currency (see the webhooks docs); the rail keeps retrying until it does. ' +
            'Further refusals for this rail this hour are coalesced into this alert.',
        },
        { dedupeKey: `railnoamount:${rail}:${Math.floor(Date.now() / 3_600_000)}` },
      );
      logWarn('payment-webhook.amount_missing', 'paid_out callback refused: no amount block', {
        transferId: result.transferId,
        partnerId: railPartnerId,
        provider,
      });
      return NextResponse.json({ ok: false, error: 'amount_required' }, { status: 422 });
    }
  }

  // Pack 3 (contract 6, critic M1): a signed funded / paid_out may not flip an
  // awaiting_payment row to paid or delivered when its rail is real money and
  // not certified for live money (or its owner is the default tenant): rows
  // minted before deploy, or whose rail was switched to http after the mint.
  // Real money is judged on the integrations already read above (no second
  // read). Not applied: one deduped ops alert (ids only) and 200 held, so the
  // rail stops retrying (the poke above already ran). A paid row's paid_out is
  // NOT gated (it may be a payout instructed before deploy).
  if (
    (result.status === 'paid' || result.status === 'delivered') &&
    refTransfer?.id === result.transferId &&
    refTransfer.status === 'awaiting_payment'
  ) {
    const live = await liveRefusalForRail(getDb(), refTransfer, railIntegrations?.payment.providerType ?? null);
    if (live) {
      // refTransfer.id (=== result.transferId here): the payload names ids only, and its
      // dataflow stays clear of the integrations (tests/outbox-payload-secrets.test.ts).
      await outbox.enqueue(
        'ops.alert',
        {
          message: `transfer ${refTransfer.id} (rail ${railPartnerId}) got a signed rail callback that was not applied: the rail partner is not certified for live money. Check with the rail partner before cancelling or refunding it.`,
        },
        { dedupeKey: `livegate:${refTransfer.id}` },
      );
      logWarn('payment-webhook.live-refused', 'rail callback not applied: rail partner not certified', {
        transferId: refTransfer.id,
        partnerId: railPartnerId,
      });
      return NextResponse.json({ ok: true, held: true });
    }
  }

  // Batch B1: the payout partner's confirmation (e.g. a UTR), saved write-once BELOW the
  // signature gate, ONLY on a paid_out that passed the hold and amount checks above (an early
  // status or a held callback never takes the slot of the real UTR), and BEFORE the status
  // update (so the delivered receipt can show it). A bad value is ignored; a save error is
  // logged. Neither ever stops the status from applying.
  if (result.status === 'delivered') await savePayoutReference(result.transferId, body);

  const updated = await store.updateTransferFromWebhook(result.transferId, result.status);
  // fix 8: a REFUSED paid_out on a cancelled row, or on a paid row with a refund
  // in progress, is never silent — money may have moved twice (railconflict:<id>).
  if (!updated && result.status === 'delivered') {
    await alertRefusedDelivery(getDb(), result.transferId);
  }
  // Program-Fix 14: status updates respect compliance holds. The guarded
  // UPDATE never advances a row under review; when a funded / paid_out was
  // not applied, a held row raises ONE deduped ops signal (railhold:<id>) and
  // the rail gets the same 200 { ok: true } as any no-op, so it stops retrying.
  if (!updated && (result.status === 'paid' || result.status === 'delivered')) {
    await alertCallbackOnHold(getDb(), result.transferId);
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
    // Program-Fix 44 P2: a sandbox transfer never messages a real phone.
    if (updated.environment !== 'test') after(async () => {
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
        // 2026-10-03: outside the 24-hour window the sender's notice goes as
        // the approved transfer_delivered_sender template (plain text if that
        // fails); a failure still throws into the catch below, as before.
        await sendTextThenTemplate(
          updated.phone,
          {
            text: `🎉 ${formatDestAmount(updated.amountInr, updated.destinationCurrency ?? 'INR')} delivered to ${recipientDisplayName(updated)}. Thanks for using ${brand}!`,
            template: deliveredSenderTemplate(updated),
          },
          waCreds,
          { partnerId: updated.partnerId, sendText, sendTemplate },
        );
        if (updated.recipientPhone) {
          // Template-first (reaches a recipient outside the 24h window), but
          // degrade to a free-form text if Meta rejects the template — otherwise
          // the recipient silently gets nothing while the sender is notified.
          const recipientPhone = updated.recipientPhone;
          const outcome = await sendTemplateOrText(
            recipientPhone,
            () => sendTemplate(
              recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
              recipientTemplateParams(updated),
              waCreds,
            ),
            recipientDeliveredFallbackText(updated, brand),
            waCreds,
          );
          // Program-Fix 25 PR B (§3.7): the recipient notice failing is no longer silent.
          if (!outcome.ok) await alertNotifyFailed(updated.id, outcome.code);
        }
      } catch (err) {
        logError('payment-webhook.notify', err, { transferId: updated.id });
        await alertNotifyFailed(updated.id, err instanceof WhatsAppSendError ? err.code : undefined);
      }
    });
  }
  return NextResponse.json({ ok: true });
}

/** Batch B1: best effort — the callback's status applies whatever happens here. */
async function savePayoutReference(transferId: string, body: unknown): Promise<void> {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).payout_reference : undefined;
  if (raw === undefined || raw === null) return;
  const ref = parsePayoutReference(raw);
  if (!ref) {
    logWarn('payment-webhook.payout_reference', 'payout_reference ignored: not a valid reference', { transferId });
    return;
  }
  try {
    await createTransferRepo(getDb()).setPayoutReference(transferId, ref);
  } catch (err) {
    logWarn('payment-webhook.payout_reference', err instanceof Error ? err.name : 'error', { transferId });
  }
}

/**
 * Program-Fix 25 PR B (§3.7): a delivered notice that did not reach the sender or
 * the recipient raises an ops alert, COALESCED per Graph code per hour (review
 * r1: on a production number the notice often hits 131047, window closed, so a
 * per-transfer alert would be one alert per transfer). The first failure of a
 * code in an hour alerts and names its transfer; the rest of that hour fold into
 * it. EXCEPT 131030 (recipient not on the sandbox allow-list): it fires on every
 * demo delivery through the simulator callback, so it stays log-only. The
 * message carries the transfer id and the numeric code only — no phone, no name.
 * Best-effort: an enqueue error is logged, never thrown (this runs in after()).
 */
const NOTIFY_ALERT_EXEMPT_CODE = 131030;
async function alertNotifyFailed(transferId: string, code: number | undefined): Promise<void> {
  if (code === NOTIFY_ALERT_EXEMPT_CODE) return;
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  try {
    await createOutboxRepo(getDb()).enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${transferId} was delivered, but the WhatsApp "delivered" notice ` +
          `did not reach the customer${code !== undefined ? ` (WhatsApp #${code})` : ''}. ` +
          `Further failures with the same code this hour are coalesced into this alert. ` +
          `Check the template / number in WhatsApp Manager.`,
      },
      { dedupeKey: `notifyfail:${code ?? 'none'}:${hourBucket}` },
    );
    pokeWorker(); // runs inside after(); nested after() is supported (next/dist/docs/.../after.md:56)
  } catch (err) {
    logError('payment-webhook.notify-alert', err, { transferId });
  }
}

/**
 * fix 29: the ONE durable hold marker + ops alert for an amount mismatch. The
 * `railamount:<id>` dedupe key is what the instruct handler, reconcileSweep and
 * this route read (outboxRepo.hasDedupeKey) to never deliver or re-instruct the
 * row. Transfer id only — no amounts, no PII.
 */
async function holdForAmountMismatch(outbox: OutboxRepo, transferId: string, sanctionsBlocked: boolean): Promise<void> {
  await outbox.enqueue(
    'ops.alert',
    {
      // Review S5 (inventory): a sanctions-blocked row is never told to be
      // cancelled or refunded: the compliance officer decides first.
      message: sanctionsBlocked
        ? `⚠️ SmartRemit ops: transfer ${transferId} — the rail's paid_out reported a different ` +
          `amount than the settlement instruction. NOT delivered; held (stays paid, never re-instructed). ` +
          `It is blocked by sanctions screening: investigate with the rail, and ${SANCTIONS_FUNDS_RULE}.`
        : `⚠️ SmartRemit ops: transfer ${transferId} — the rail's paid_out reported a different ` +
          `amount than the settlement instruction. NOT delivered; held (stays paid, never re-instructed). ` +
          `Investigate with the rail, then cancel/refund it.`,
    },
    { dedupeKey: `railamount:${transferId}` },
  );
}
