'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { env } from '@/lib/env';
import { encryptField } from '@/lib/field-crypto';
import { newTransferId } from '@/lib/id';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { pokeWorker } from '@/lib/outbox';
import { issueApplicationToken } from '@/lib/partner-application-token';
import { buildInviteEmail, inviteDedupeKey } from '@/lib/partner-invite-email';
import { isPartnerType, partnerTypeLabel } from '@/lib/partner-type';
import { getRedis } from '@/lib/redis';
import { PARTNER_CORRIDOR_CODES } from '@/app/landing/corridors';

// submitPartnerRequestAction — the PUBLIC "Partner with us" landing form action.
// Intentionally unauthenticated (anyone can express interest), but defended:
//   - a honeypot field drops bots silently (look successful, persist nothing),
//   - a per-IP fixed-window limit caps abuse (fail-open),
//   - server-side validation is authoritative — the form is never trusted.
// On success the lead is persisted AND an 'email.send' effect is enqueued in ONE
// transaction (durable outbox), then the worker is poked to deliver promptly.

// The 10 supported corridors + an "Other" escape hatch — the landing page's
// own list (src/app/landing/corridors.ts), so the checkboxes and this
// allow-list cannot drift. Anything outside it is dropped from the submission.
const ALLOWED_CORRIDORS = PARTNER_CORRIDOR_CODES;

const EMAIL_RE = /.+@.+\..+/;

export async function submitPartnerRequestAction(formData: FormData): Promise<void> {
  // ── HONEYPOT — bots fill hidden fields; a non-empty value ⇒ drop silently. ──
  // Look successful (redirect to ?partner=ok) but persist/notify nothing.
  if (String(formData.get('website') ?? '').trim() !== '') {
    redirect('/?partner=ok#partner-with-us');
  }

  // ── RATE LIMIT — blunt per-IP outer ring; fail-open on any limiter error. ──
  const ip =
    (await headers()).get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  let allowed = true;
  try {
    const r = await checkIpRateLimit(getRedis(), 'partner-request', ip, {
      limit: 5,
      windowSec: 3600,
    });
    allowed = r.allowed;
  } catch {
    allowed = true; // availability wins — never block a lead on a limiter outage
  }
  if (!allowed) redirect('/?partner=rate#partner-with-us');

  // ── VALIDATE (server-side, authoritative) ──────────────────────────────────
  const companyName = String(formData.get('company_name') ?? '').trim().slice(0, 200);
  const email = String(formData.get('email') ?? '').trim().slice(0, 320);
  const phone = String(formData.get('phone') ?? '').trim().slice(0, 40);
  const comments = String(formData.get('comments') ?? '').trim().slice(0, 2000);
  const corridors = formData
    .getAll('corridors')
    .map((c) => String(c).trim())
    .filter((c) => ALLOWED_CORRIDORS.has(c));

  // "I am a:" — required, allow-listed (src/lib/partner-type.ts); the column's
  // CHECK constraint refuses anything else, but the edge rejects it first.
  const partnerTypeRaw = String(formData.get('partner_type') ?? '').trim();
  const partnerType = isPartnerType(partnerTypeRaw) ? partnerTypeRaw : null;

  const phoneDigits = (phone.match(/\d/g) ?? []).length;
  const valid =
    companyName.length >= 2 &&
    EMAIL_RE.test(email) &&
    phoneDigits >= 7 &&
    corridors.length >= 1 &&
    partnerType !== null;

  if (!valid || partnerType === null) redirect('/?partner=err#partner-with-us');

  // ── PERSIST + NOTIFY in ONE transaction ────────────────────────────────────
  // redirect() throws by design — keep it OUT of the transaction/try so it is
  // never swallowed. The transaction body has no try around it: a genuine DB
  // failure should surface (the user sees an error) rather than fake success.
  const id = `preq_${newTransferId()}`;
  await getDb().transaction(async (tx) => {
    const requests = createPartnerRequestRepo(tx);
    const outbox = createOutboxRepo(tx);

    await requests.savePartnerRequest({
      id,
      companyName,
      email,
      phone,
      corridors,
      comments: comments || undefined,
      capturedAt: new Date().toISOString(),
      partnerType,
    });

    // Mint a 30-day, single-use capability token for the detailed application
    // form and persist only its HASH on the lead row. The raw token's one durable
    // copy — the emailed link — is SEALED with field-crypto (fix 11 / F66): the
    // outbox row holds ciphertext and the worker opens it at send time
    // (src/lib/sealed-text.ts). Minted ONCE here, never per send attempt: a
    // re-mint on redelivery would overwrite the hash and kill a delivered link.
    // encryptField is CPU-only — the transaction gains no I/O.
    const { token, hash, expiresAt } = issueApplicationToken();
    await requests.setApplicationToken(id, hash, expiresAt);
    const sealedApplyLink = encryptField(`${env.appBaseUrl}/partners/apply/${token}`);

    // Team notification — internal lead alert.
    await outbox.enqueue(
      'email.send',
      {
        to: env.partnerLeadEmails,
        subject: `New partner request: ${companyName}`,
        text:
          `New partner request via smartremit.ai\n\n` +
          `Company: ${companyName}\n` +
          `Partner type: ${partnerTypeLabel(partnerType)}\n` +
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Corridors: ${corridors.join(', ')}\n` +
          `Comments: ${comments || '—'}\n\n` +
          `Review: ${env.appBaseUrl}/admin-dashboard/partner-requests`,
      },
      { dedupeKey: `preq:${id}` },
    );

    // Partner invite — the unique link to the detailed application form. Goes to
    // the email the partner submitted (NOT the internal lead list). The link is
    // the {{apply_link}} placeholder, rendered from `sealed` at send time. The
    // text comes from the shared builder (the staff resend uses the same one).
    const invite = buildInviteEmail();
    await outbox.enqueue(
      'email.send',
      {
        to: [email],
        subject: invite.subject,
        text: invite.text,
        sealed: { apply_link: sealedApplyLink }, // key = INVITE_LINK_PLACEHOLDER (a literal: the fix-11 scan refuses computed keys)
      },
      { dedupeKey: inviteDedupeKey(id) },
    );
  });

  pokeWorker();
  redirect('/?partner=ok#partner-with-us');
}
