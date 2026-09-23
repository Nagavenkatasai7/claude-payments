'use server';

import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { partnerRequests } from '@/db/schema';
import { createAuditRepo, createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { emailConfigured } from '@/lib/email';
import { env } from '@/lib/env';
import { encryptField } from '@/lib/field-crypto';
import { pokeWorker } from '@/lib/outbox';
import { issueApplicationToken } from '@/lib/partner-application-token';
import { buildInviteEmail, inviteResendDedupeKey } from '@/lib/partner-invite-email';

// Partner-request staff actions (Program-Fix 39). A server action is a public
// POST endpoint, so every action self-gates: PLATFORM ADMINS only (these are
// cross-tenant business-development records), and it validates the target
// before mutating. Every mutation writes an audit_events row.

const PREQ_ID = /^preq_[A-Za-z0-9_-]{1,64}$/;

/**
 * Resend the partner-application invite. The raw token is not retained
 * anywhere (fix 11 seals it; fix 37 empties done rows), so a resend RE-ISSUES
 * the token: the previously emailed link stops working.
 *
 * In ONE transaction:
 *   1. lock the request row FOR UPDATE (serialises concurrent resends),
 *   2. re-check it is still 'invited',
 *   3. store the new token hash (kills the old link),
 *   4. enqueue one SEALED 'email.send' keyed `partner_app_invite:<id>:r<hash[0,12)>`,
 *      throwing on a dedupe miss so the stored hash never differs from the
 *      emailed link,
 *   5. audit `partner_application.invite_resent`.
 * The recipient is the address on the locked row, never a form field.
 */
export async function resendApplicationInviteAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  if (!PREQ_ID.test(id)) throw new Error('Invalid partner request id.');
  const page = `/admin-dashboard/partner-requests/${encodeURIComponent(id)}`;

  const existing = await createPartnerRequestRepo(getDb()).getPartnerRequest(id);
  if (!existing) notFound();
  if ((existing.applicationStatus ?? 'invited') !== 'invited') redirect(`${page}?invite=not_invited`);
  // Refuse rather than re-issue a token whose only carrier would be skipped.
  if (!emailConfigured()) redirect(`${page}?invite=unconfigured`);

  const outcome = await getDb().transaction(async (tx) => {
    // Drizzle pg-core select().for('update') — node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586.
    const [locked] = await tx
      .select({ email: partnerRequests.email, applicationStatus: partnerRequests.applicationStatus })
      .from(partnerRequests)
      .where(eq(partnerRequests.id, id))
      .limit(1)
      .for('update');
    if (!locked || locked.applicationStatus !== 'invited') return 'not_invited' as const;

    const { token, hash, expiresAt } = issueApplicationToken();
    await createPartnerRequestRepo(tx).setApplicationToken(id, hash, expiresAt);
    // The link's one durable copy is sealed (fix 11); the worker opens it at send time.
    const sealedApplyLink = encryptField(`${env.appBaseUrl}/partners/apply/${token}`);
    const invite = buildInviteEmail();
    const created = await createOutboxRepo(tx).enqueue(
      'email.send',
      {
        to: [locked.email],
        subject: invite.subject,
        text: invite.text,
        sealed: { apply_link: sealedApplyLink }, // key = INVITE_LINK_PLACEHOLDER (a literal: the fix-11 scan refuses computed keys)
      },
      { dedupeKey: inviteResendDedupeKey(id, hash) },
    );
    if (!created) {
      // Throwing rolls back the new hash: never store a link nobody was sent.
      throw new Error('Invite resend collided with an existing email; nothing was changed. Try again.');
    }
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'partner_application.invite_resent',
      subjectId: id,
      meta: { previousLinkRevoked: true },
    });
    return 'resent' as const;
  });

  if (outcome === 'resent') pokeWorker();
  revalidatePath(page);
  redirect(`${page}?invite=${outcome}`);
}
