'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { env } from '@/lib/env';
import { newTransferId } from '@/lib/id';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { pokeWorker } from '@/lib/outbox';
import { getRedis } from '@/lib/redis';

// submitPartnerRequestAction — the PUBLIC "Partner with us" landing form action.
// Intentionally unauthenticated (anyone can express interest), but defended:
//   - a honeypot field drops bots silently (look successful, persist nothing),
//   - a per-IP fixed-window limit caps abuse (fail-open),
//   - server-side validation is authoritative — the form is never trusted.
// On success the lead is persisted AND an 'email.send' effect is enqueued in ONE
// transaction (durable outbox), then the worker is poked to deliver promptly.

// The 8 supported corridors + an "Other" escape hatch. Server-side allow-list:
// anything outside this set is dropped from the submitted corridors.
const ALLOWED_CORRIDORS = new Set(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN', 'Other']);

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

  const phoneDigits = (phone.match(/\d/g) ?? []).length;
  const valid =
    companyName.length >= 2 &&
    EMAIL_RE.test(email) &&
    phoneDigits >= 7 &&
    corridors.length >= 1;

  if (!valid) redirect('/?partner=err#partner-with-us');

  // ── PERSIST + NOTIFY in ONE transaction ────────────────────────────────────
  // redirect() throws by design — keep it OUT of the transaction/try so it is
  // never swallowed. The transaction body has no try around it: a genuine DB
  // failure should surface (the user sees an error) rather than fake success.
  const id = `preq_${newTransferId()}`;
  await getDb().transaction(async (tx) => {
    await createPartnerRequestRepo(tx).savePartnerRequest({
      id,
      companyName,
      email,
      phone,
      corridors,
      comments: comments || undefined,
      capturedAt: new Date().toISOString(),
    });
    await createOutboxRepo(tx).enqueue(
      'email.send',
      {
        to: env.partnerLeadEmails,
        subject: `New partner request: ${companyName}`,
        text:
          `New partner request via smartremit.ai\n\n` +
          `Company: ${companyName}\n` +
          `Email: ${email}\n` +
          `Phone: ${phone}\n` +
          `Corridors: ${corridors.join(', ')}\n` +
          `Comments: ${comments || '—'}\n\n` +
          `Review: ${env.appBaseUrl}/admin-dashboard/partner-requests`,
      },
      { dedupeKey: `preq:${id}` },
    );
  });

  pokeWorker();
  redirect('/?partner=ok#partner-with-us');
}
