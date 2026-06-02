import { NextRequest, NextResponse, after } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { verifyPersonaSignature } from '@/lib/providers/persona-signature';
import { parsePersonaEvent } from '@/lib/providers/persona-webhook-parse';
import { applyKycEvent } from '@/lib/kyc-state-machine';
import { sendVerificationStatus } from '@/lib/whatsapp';

/**
 * Persona webhook (Phase 2, Task 10) — the SOURCE OF TRUTH for KYC state.
 *
 * Flow: read raw body → verify HMAC (fail-closed) → parse → idempotency-dedupe by
 * event id → load the customer by reference-id → applyKycEvent (Persona NEVER
 * sets the gate-driving kycStatus; human-review-only) → persist + audit →
 * fast 2xx, then a fail-soft WhatsApp status nudge in after().
 *
 * Mirrors the WhatsApp/payment webhook routes: raw body first, no CSRF (HMAC is
 * the gate), early 2xx. Events arrive >1× and out of order — markEventSeen +
 * the state machine's human-terminal guard make reprocessing safe.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text(); // raw bytes first — Persona signs the exact body
  const header = req.headers.get('persona-signature') ?? '';
  if (!verifyPersonaSignature(raw, header, [env.personaWebhookSecret], Date.now())) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const event = parsePersonaEvent(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  const cases = getKycCaseStore(getStore());

  // Idempotency: Persona re-delivers + reorders; process each event id once.
  if (!(await cases.markEventSeen(event.eventId))) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const phone = event.referenceId;
  if (!phone) return NextResponse.json({ ok: true, ignored: true });

  const customer = await getCustomerStore(getStore()).getCustomer(phone);
  if (!customer) return NextResponse.json({ ok: true, ignored: true });

  const delta = applyKycEvent(customer, event);
  let nextState = customer.kycReviewState;
  if (Object.keys(delta).length > 0) {
    const updated = await cases.applyDelta(phone, delta, { actor: 'persona', action: event.name });
    nextState = updated?.kycReviewState ?? nextState;
  }

  // Notify the customer of the transition, fail-soft (free-form until templates approved).
  // needs_review ⇒ no customer message (staff handle it); approved/rejected ⇒ the review action notifies.
  after(async () => {
    try {
      if (nextState === 'inquiry_started') {
        await sendVerificationStatus(phone, 'in_progress', customer.fullName);
      } else if (nextState === 'pending_review') {
        await sendVerificationStatus(phone, 'received', customer.fullName);
      }
    } catch (err) {
      console.error('persona-webhook notify failed:', err);
    }
  });

  return NextResponse.json({ ok: true });
}
