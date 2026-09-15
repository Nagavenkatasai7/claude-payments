import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { getFundingProvider } from '@/lib/providers/funding-provider';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { env } from '@/lib/env';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';

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
