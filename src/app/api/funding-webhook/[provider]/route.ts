import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { getFundingProvider } from '@/lib/providers/funding-provider';
import { realMoneyFor } from '@/lib/live-gate';
import { pokeWorker } from '@/lib/outbox';
import { logWarn } from '@/lib/log';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { env } from '@/lib/env';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import type { Transfer } from '@/lib/types';

// The FUNDING provider's async callback (sender-side charge lifecycle) —
// structural twin of /api/payment-webhook (the recipient-side settlement
// rail). A real PSP confirms captures/refunds out-of-band; this route mirrors
// that truth into the ledger and NOTHING else:
//  - captured      ⇒ setFundingRef (write-once; NO status change — the pay
//                    route owns settlement)
//  - refunded      ⇒ refundStatus pending→completed (+refundRef +refundedAt)
//  - refund_failed ⇒ refundStatus pending→failed
// updateRefund's legal-from guard makes replays/out-of-order callbacks
// harmless no-ops. NO WhatsApp sends here — the refund-engine worker owns
// customer messaging. HMAC FAIL-CLOSED for every provider including 'mock'
// (no carve-out: see money-01 / F42).
// Fix pack 5 T13a (P13): on a row whose rail moves real money (realMoneyFor:
// the settlement partner's rail is 'http', the row is not sandbox, an
// unreadable rail counts as real money) EVERY state change is refused, with
// 200 { ok: true, ignored: true } and no write:
//  - captured      ⇒ one ops alert fundcapture:<transferId> (this generic
//                    route cannot confirm a real charge)
//  - refunded      ⇒ one ops alert fundrefund:<transferId>; the refund stays
//  - refund_failed   pending, so only the partner's signed reverse or the
//                    Stripe refund (the funding.refund handler) completes it
// Demo, simulator, mock, sandbox and default-tenant rows are recorded as
// before. The alerts carry ids and the event name only.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  // LOOSE per-IP ceiling — real PSPs retry on 429, and the HMAC gate below is
  // the actual auth; this only blunts raw flooding. Fail-open by design.
  const limited = await enforceIpRateLimit(req, 'fwhk', 600);
  if (limited) return limited;

  const raw = await req.text();                           // raw body first (for HMAC)

  // Every provider, the mock included, MUST verify against
  // FUNDING_WEBHOOK_SECRET_<PROVIDER>; '' ⇒ unconfigured ⇒ reject. The mock
  // funding provider never posts callbacks, and its handleWebhook ACTS on any
  // parsed body, so there is no legitimate unsigned caller (audit money-01 /
  // scan F42: the old carve-out let an anonymous POST arm settlement or forge
  // a completed refund in production).
  const secret = env.fundingWebhookSecret(provider);
  const signature = req.headers.get('x-signature') ?? '';
  if (!verifyWebhookSignature(raw, signature, secret)) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 }); // malformed
  }

  const event = await getFundingProvider().handleWebhook(body);
  if (!event) {
    return NextResponse.json({ ok: true, ignored: true });  // unparseable/irrelevant → 200, no mutation
  }

  const repo = createTransferRepo(getDb());
  const t = await repo.getTransfer(event.transferId);
  if (t && (await realMoneyFor(getDb(), t))) {
    if (event.event === 'captured') await alertFundCaptureRefused(t);
    else await alertFundRefundRefused(t, event.event);
    pokeWorker(); // the ops.alert row is ready now
    return NextResponse.json({ ok: true, ignored: true });
  }
  switch (event.event) {
    case 'captured':
      // Write-once: a replay (or a ref the pay route already persisted
      // synchronously) never clobbers the recorded charge.
      await repo.setFundingRef(event.transferId, event.ref);
      break;
    case 'refunded':
      await repo.updateRefund(event.transferId, {
        refundStatus: 'completed',
        refundRef: event.ref,
        refundedAt: new Date().toISOString(),
      });
      break;
    case 'refund_failed':
      await repo.updateRefund(event.transferId, { refundStatus: 'failed' });
      break;
  }
  return NextResponse.json({ ok: true });
}

/** Fix pack 5 T13a (P30 fundcapture:<id>): ids only. Never throws (logged by the error name). */
async function alertFundCaptureRefused(t: Transfer): Promise<void> {
  const message =
    `⚠️ SmartRemit ops: a funding "captured" callback for transfer ${t.id} (partner ${t.partnerId}) was refused: ` +
    'its rail moves real money, and the generic funding webhook cannot confirm a real charge. Nothing was recorded. ' +
    'Check the payment provider and the partner before acting.';
  try {
    await createOutboxRepo(getDb()).enqueue('ops.alert', { message }, { dedupeKey: `fundcapture:${t.id}` });
  } catch (err) {
    logWarn('funding-webhook.alert', err instanceof Error ? err.name : 'error', { transferId: t.id });
  }
}

/** Fix pack 5 T13a (P30 fundrefund:<id>, review M4): ids and the event name only. Never throws. */
async function alertFundRefundRefused(t: Transfer, event: 'refunded' | 'refund_failed'): Promise<void> {
  const message =
    `⚠️ SmartRemit ops: a funding "${event}" callback for transfer ${t.id} (partner ${t.partnerId}) was refused: ` +
    'its rail moves real money, and the generic funding webhook cannot confirm a real refund. The refund stays pending; ' +
    "only the partner's signed reverse or the Stripe refund completes it. Check the payment provider and the partner before acting.";
  try {
    await createOutboxRepo(getDb()).enqueue('ops.alert', { message }, { dedupeKey: `fundrefund:${t.id}` });
  } catch (err) {
    logWarn('funding-webhook.alert', err instanceof Error ? err.name : 'error', { transferId: t.id });
  }
}
