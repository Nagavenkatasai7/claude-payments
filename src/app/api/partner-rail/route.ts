import { NextRequest, NextResponse } from 'next/server';
import { verifyRailSignature } from '@/lib/providers/rail-signature';
import { railSecrets } from '@/lib/partner-integrations';
import { railNonceSeen, markRailNonce } from '@/lib/rail-replay';
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
export const UNREACHABLE_REASON = 'account_unreachable';

/** fix 8: the sentinel account — the LAST digit run is ≥6 zeros (e.g. "HDFC0001234 000000000000"). */
export function isUnreachableAccount(destination: unknown): boolean {
  if (typeof destination !== 'string') return false;
  const runs = destination.match(/\d+/g);
  const last = runs?.[runs.length - 1] ?? '';
  return last.length >= 6 && /^0+$/.test(last);
}

export async function POST(req: NextRequest) {
  // Stage 3: blunt per-IP ceiling (signature gate below is the real auth).
  const limited = await enforceIpRateLimit(req, 'rail', 120);
  if (limited) return limited;

  const raw = await req.text();

  let body: {
    reference?: unknown;
    partner_id?: unknown;
    action?: unknown;
    funding?: { method?: unknown };
    payout?: { rail?: unknown; destination?: unknown };
    amount?: { destination?: unknown; destination_currency?: unknown };
  } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }
  const reference = typeof body.reference === 'string' ? body.reference : '';
  const partnerId = typeof body.partner_id === 'string' ? body.partner_id : '';
  // 'reverse' = a B2B ach_pull return instruction; 'settle' (default) = a payout.
  const action = typeof body.action === 'string' ? body.action : 'settle';
  // Cross-border B2B (Plan 4): a DUAL-LEG instruction carries `funding.method ===
  // 'bank_debit'` (debit the buyer's local bank) alongside the payout block (pay
  // the seller). The reference rail accepts it and simulates BOTH legs as ONE
  // atomic settlement: the partner debits + does FX + pays out, then reports
  // `paid_out`. So a dual-leg `settle` flows through the SAME forward loop below
  // as a single-leg payout — the delayed `paid_out` callback completes it.
  const fundingMethod =
    body.funding && typeof body.funding === 'object' && typeof body.funding.method === 'string'
      ? body.funding.method
      : '';
  const isDualLeg = fundingMethod === 'bank_debit';
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
  // fix 29: the timestamped header decides alone when present; the legacy
  // x-signature is still accepted without it (deprecation log). Current +
  // unexpired previous signing secret (rotation grace).
  const nowMs = Date.now();
  const verified = verifyRailSignature(
    raw,
    req.headers,
    railSecrets(integrations.payment, 'signing', new Date(nowMs)),
    nowMs,
    { partnerId, route: 'partner-rail' },
  );
  if (!verified.ok) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }
  // Replay guard (check-then-mark, fail-open) — same rule as the status webhook.
  if (verified.scheme === 'v2' && (await railNonceSeen(verified.nonce)) === 'seen') {
    return NextResponse.json({ ok: true, duplicate: true, providerRef: `simrail-${reference}` });
  }
  const response = await handleVerifiedInstruction(body, reference, partnerId, action, isDualLeg);
  if (verified.scheme === 'v2') await markRailNonce(verified.nonce);
  return response;
}

/** fix 29: the verified instruction's destination amount, echoed on the callback. */
function echoAmount(a: unknown): { destination: number | string; destination_currency: string } | null {
  if (!a || typeof a !== 'object') return null;
  const { destination, destination_currency } = a as Record<string, unknown>;
  if ((typeof destination !== 'number' && typeof destination !== 'string') || typeof destination_currency !== 'string') {
    return null;
  }
  return { destination, destination_currency };
}

async function handleVerifiedInstruction(
  body: {
    payout?: { rail?: unknown; destination?: unknown };
    amount?: { destination?: unknown; destination_currency?: unknown };
  },
  reference: string,
  partnerId: string,
  action: string,
  isDualLeg: boolean,
): Promise<NextResponse> {
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
  //
  // fix 8: the reference rail's ONE failure mode (demo + Chrome check). A bank
  // payout whose account number — the LAST digit run of the composed
  // destination (composePayoutDestination puts the account last; IN reads
  // "HDFC0001234 000000000000") — is all zeros with at least 6 digits still
  // acks, then reports `failed` / `account_unreachable` on the same delayed,
  // deduped callback row. The BANK rail only: a USDC address is hex and a UPI
  // VPA ("000000@ybl") is a handle — neither is an account number. Any other
  // account settles as before.
  const unreachable =
    isUnreachableAccount(body.payout?.destination) && (body.payout?.rail ?? 'bank') === 'bank';
  const amount = echoAmount(body.amount);
  await createOutboxRepo(getDb()).enqueue(
    'rail.callback',
    {
      reference,
      partner_id: partnerId,
      ...(unreachable ? { status: 'failed', reason: UNREACHABLE_REASON } : {}),
      // fix 29: the rail reports back the amount it was instructed to pay; the
      // webhook checks it against the locked amount before delivering.
      ...(amount ? { amount } : {}),
    },
    { delayMs: SETTLE_DELAY_MS, dedupeKey: `railcb:${reference}` },
  );
  pokeWorker();

  // `legs:'dual'` confirms the rail accepted the cross-border buyer-debit +
  // seller-payout instruction (both settled atomically before the callback).
  return NextResponse.json({
    ok: true,
    providerRef: `simrail-${reference}`,
    ...(isDualLeg ? { legs: 'dual' } : {}),
  });
}
