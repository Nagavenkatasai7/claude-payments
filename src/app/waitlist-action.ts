'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { newTransferId } from '@/lib/id';
import { checkIpRateLimit, clientIpFrom } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import { getRedis } from '@/lib/redis';
import { WAITLIST_CONSENT_VERSION, parseWaitlistSignup } from '@/lib/waitlist';
import { WAITLIST_DESTINATION_CODES } from '@/app/landing/corridors';

// joinWaitlistAction — the PUBLIC "Join waitlist" landing form action. Same
// defensive posture as submitPartnerRequestAction (src/app/partners-action.ts):
//   - a honeypot field drops bots silently (look successful, persist nothing),
//   - a per-IP fixed-window limit caps abuse (FAIL-OPEN on limiter errors),
//   - server-side validation is authoritative — the form is never trusted,
//   - a duplicate (same email OR same phone, after normalisation) is a SILENT
//     success: the response never reveals who is already on the list.
// PII is encrypted by the repo before it reaches the table; nothing from the
// form is ever logged (the scrubbing logger is used only for the limiter
// warning, which carries no form data).

export async function joinWaitlistAction(formData: FormData): Promise<void> {
  // ── HONEYPOT ───────────────────────────────────────────────────────────────
  if (String(formData.get('website') ?? '').trim() !== '') {
    redirect('/?waitlist=ok#waitlist');
  }

  // ── RATE LIMIT — own scope ('waitlist'), never shared with the partner form. ──
  const ip = clientIpFrom(await headers());
  let allowed = true;
  try {
    const r = await checkIpRateLimit(getRedis(), 'waitlist', ip, { limit: 5, windowSec: 3600 });
    allowed = r.allowed;
  } catch (err) {
    allowed = true; // availability wins — never lose a signup to a limiter outage
    logWarn('waitlist', 'rate limiter unavailable; failing open', { error: err });
  }
  if (!allowed) redirect('/?waitlist=rate#waitlist');

  // ── VALIDATE (server-side, authoritative) ──────────────────────────────────
  const parsed = parseWaitlistSignup(formData, WAITLIST_DESTINATION_CODES);
  if (!parsed.ok) redirect('/?waitlist=err#waitlist');

  // ── PERSIST (encrypted; duplicate ⇒ no-op) ─────────────────────────────────
  // redirect() throws by design — keep it OUT of any try so it is never
  // swallowed. A genuine DB failure surfaces (the user sees an error) rather
  // than faking success.
  await createWaitlistRepo(getDb()).insertIfNew({
    ...parsed.value,
    id: `wl_${newTransferId()}`,
    consentAt: new Date().toISOString(),
    consentTextVersion: WAITLIST_CONSENT_VERSION,
  });

  redirect('/?waitlist=ok#waitlist');
}
