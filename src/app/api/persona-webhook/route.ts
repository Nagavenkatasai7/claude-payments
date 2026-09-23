import { NextRequest, NextResponse, after } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { getPartnerStore } from '@/lib/partner-store';
import { verifyPersonaSignature } from '@/lib/providers/persona-signature';
import { parsePersonaEvent } from '@/lib/providers/persona-webhook-parse';
import { applyKycEvent } from '@/lib/kyc-state-machine';
import { sendGateActive } from '@/lib/kyc-gate';
import { sendVerificationStatus } from '@/lib/whatsapp';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import { logError, logWarn } from '@/lib/log';
import type { PersonaEvent } from '@/lib/providers/persona-webhook-parse';
import type { KycCaseStore } from '@/lib/kyc-case-store';
import type { Customer, KycReviewState } from '@/lib/types';

/**
 * Persona webhook (Phase 2, Task 10) — the SOURCE OF TRUTH for KYC state.
 *
 * Flow: read raw body → verify HMAC (fail-closed) → parse → idempotency-dedupe by
 * event id → bind ONE customer (inquiry events: reference-id phone + recorded
 * inquiry; report events: the inquiry relationship, Program-Fix 35) → applyKycEvent (Persona NEVER
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

  // Program-Fix 35 — RELEASE ON FAILURE: everything from the mark above through
  // the state apply and the match alert runs inside ONE try. If any of it
  // throws, the mark is released and we answer 500 so Persona's retry is
  // processed instead of deduped (before this, a throw lost the event).
  //
  // Why a re-apply after a release is safe (a retry may re-run a partly
  // applied event, e.g. "save ok, audit throws"): applyKycEvent is a pure
  // function of (customer, event) and converges —
  //   • the hold lock and the monotone rank guard stop any backward move;
  //   • fix 48's kycSubmittedAt guard stops a re-stamp;
  //   • a repeat hold is a no-op (same needs_review + same flag);
  //   • the alert dedupes on `kycmatch:<eventId>`.
  // The only double effect possible is a second `kyc` audit line (append-only).
  let applied: Applied | null;
  try {
    applied = await applyEvent(event, cases);
  } catch (err) {
    logError('persona.webhook.apply', err, { name: event.name });
    try {
      await cases.unmarkEventSeen(event.eventId);
    } catch (releaseErr) {
      logError('persona.webhook.release', releaseErr, { name: event.name });
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (!applied) return NextResponse.json({ ok: true, ignored: true });
  const { customer, nextState } = applied;
  // The phone is ALWAYS the bound customer's own (a report event carries none).
  const phone = customer.senderPhone;

  // KYC is partner OPT-IN: resolve the owning partner so the after() nudge can
  // be suppressed when the verify-before-send gate is OFF. State application
  // above stays UNCONDITIONAL — Persona is the KYC source of truth either way —
  // and is deliberately FIRST: the event is already marked seen, so a partner
  // read hiccup must only ever cost the fail-soft notify, never the state.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());

  // Notify the customer of the transition, fail-soft (free-form until templates approved).
  // needs_review ⇒ no customer message (staff handle it); approved/rejected ⇒ the review action notifies.
  // Gated on sendGateActive: a gate-OFF partner's customers never hear about KYC.
  after(async () => {
    try {
      // Report events never message the customer: a match is a hold (staff
      // handle it) and any other report event moves nothing.
      if (!isReportEvent(event) && sendGateActive(partner)) {
        if (nextState === 'inquiry_started') {
          await sendVerificationStatus(phone, 'in_progress', customer.fullName);
        } else if (nextState === 'pending_review') {
          await sendVerificationStatus(phone, 'received', customer.fullName);
        }
      }
    } catch (err) {
      console.error('persona-webhook notify failed:', err);
    }
  });

  return NextResponse.json({ ok: true });
}

interface Applied {
  customer: Customer;
  nextState: KycReviewState | undefined;
}

function isReportEvent(event: PersonaEvent): boolean {
  return event.name.startsWith('report/') || event.reportId !== undefined;
}

/**
 * Bind the event to exactly ONE customer row, or null (never guess a tenant).
 *   • inquiry events: the Persona reference-id is the phone
 *     (persona-kyc-provider.ts) and a phone may have a row under several
 *     partners — bind by the inquiry id the row recorded when verification
 *     started; fall back to the single row only when the phone is unambiguous
 *     (fix 1, D7).
 *   • report events (Program-Fix 35) carry no phone: bind by the inquiry
 *     relationship through findByKycInquiryId — exactly one row, else ignored.
 */
async function bindCustomer(event: PersonaEvent): Promise<Customer | null> {
  const customers = getCustomerStore(getStore());
  if (event.referenceId) {
    const rows = await customers.findByPhone(event.referenceId);
    return (
      rows.find((c) => Boolean(event.inquiryId) && c.kycInquiryId === event.inquiryId) ??
      (rows.length === 1 ? rows[0] : null)
    );
  }
  if (event.inquiryId) {
    const rows = await customers.findByKycInquiryId(event.inquiryId);
    if (rows.length === 1) return rows[0];
    logWarn('persona.webhook.unbound', event.name, { candidates: rows.length });
    return null;
  }
  // A report event with no inquiry relationship: warn, so an envelope mismatch
  // shows in the logs instead of silently dropping every hold.
  if (isReportEvent(event)) logWarn('persona.webhook.unbound', event.name, { candidates: 0, reason: 'no_inquiry' });
  return null;
}

/** Bind → pure delta → persist + audit → (on a match) the deduped ops alert. Throws are the caller's to release. */
async function applyEvent(event: PersonaEvent, cases: KycCaseStore): Promise<Applied | null> {
  const matchKind = event.matchKind;
  if (matchKind) logWarn('persona.event', event.name, { matchKind });

  const customer = await bindCustomer(event);
  if (!customer) return null;
  const phone = customer.senderPhone;

  const delta = applyKycEvent(customer, event);
  let nextState = customer.kycReviewState;
  if (Object.keys(delta).length > 0) {
    const updated = await cases.applyDelta(customer.partnerId, phone, delta, { actor: 'persona', action: event.name });
    nextState = updated?.kycReviewState ?? nextState;
  }

  if (matchKind) {
    // Ids only — never a phone, a name or a Persona id. The keyed audit subject
    // is how staff find the customer's audit trail.
    const subject = auditSubjectId(customer.partnerId, phone);
    const stillTerminal = nextState === 'approved' || nextState === 'rejected';
    await createOutboxRepo(getDb()).enqueue(
      'ops.alert',
      {
        message:
          `🔎 SmartRemit KYC: Persona reported a ${matchKind} match (${event.name}) for customer ${subject} ` +
          `(partner ${customer.partnerId}). ` +
          (stillTerminal
            ? `The customer's review is already ${nextState}; ` +
              (matchKind === 'other' ? '' : 'the flag is recorded and ') +
              'sending is NOT blocked. Staff decide.'
            : 'The customer is held for review (needs_review). Open the KYC review queue.'),
      },
      { dedupeKey: `kycmatch:${event.eventId}` },
    );
  }

  return { customer, nextState };
}
