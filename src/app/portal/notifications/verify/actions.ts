'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { emailVerifiedTag, markEmailVerified } from '@/lib/portal-prefs';
import { consumeEmailVerifyToken } from '@/lib/portal-email-verify';
import { openCustomerEmail } from '@/lib/portal-profile';
import { auditSubjectId } from '@/lib/customer-ref';
import { PORTAL_AUTH_ACTOR } from '@/lib/portal-auth-audit';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import type { MessageKey } from '@/lib/i18n';

export type VerifyEmailState = { notice?: MessageKey; error?: MessageKey } | null;

/**
 * Confirm the email verify link (UI redesign M2-11, Task 11.4). The GET page never consumes; this POST
 * does, and only for the token's own (HOST partner, SESSION customer, CURRENT address): anything else
 * (another partner's host, another customer, an address changed since, a used or expired token) is
 * ONE answer and leaves the token untouched (portal-email-verify). On success: email_verified_at +
 * email_verified_tag, audited `customer.email.verified`, in one transaction.
 */
export async function verifyEmailAction(_prev: VerifyEmailState, formData: FormData): Promise<VerifyEmailState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const token = String(formData.get('token') ?? '');
  const { partnerId } = ctx.site;
  const phone = ctx.session.phone;
  const INVALID: VerifyEmailState = { error: 'portal.email.link_invalid' };
  try {
    const email = openCustomerEmail(ctx.customer);
    if (!email) return INVALID;
    const tag = emailVerifiedTag(partnerId, phone, email);
    if (!(await consumeEmailVerifyToken(getRedis(), token, { partnerId, phone, tag }))) return INVALID;
    await getDb().transaction(async (tx) => {
      await markEmailVerified(tx, partnerId, phone, tag);
      await createAuditRepo(tx).record({
        partnerId,
        actor: PORTAL_AUTH_ACTOR,
        actorType: 'system',
        action: 'customer.email.verified',
        subjectId: auditSubjectId(partnerId, phone),
        meta: { via: 'portal' },
      });
    });
  } catch (err) {
    logWarn('portal.notifications.verify', err instanceof Error ? err.name : 'error');
    return { error: 'portal.action.failed' };
  }
  revalidatePath('/portal/notifications');
  return { notice: 'portal.email.verified' };
}
