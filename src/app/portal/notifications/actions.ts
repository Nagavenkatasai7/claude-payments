'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth, requirePortalCustomer, type PortalCustomerContext } from '@/lib/portal-auth';
import { createCustomerStore } from '@/lib/customer-store';
import { getStore } from '@/lib/store';
import { clearEmailVerification, emailVerifiedTag, setEmailReceipts, verifiedReceiptEmail } from '@/lib/portal-prefs';
import { mintEmailVerifyToken, normalizePortalEmail, PORTAL_EMAIL_LIMIT, portalEmailVerifyUrl } from '@/lib/portal-email-verify';
import { runOnce, BadRequestKeyError, RequestInFlightError } from '@/lib/portal-request-key';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { PORTAL_AUTH_ACTOR } from '@/lib/portal-auth-audit';
import { encryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';
import { pokeWorker } from '@/lib/outbox';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';
import { t, type MessageKey } from '@/lib/i18n';

/**
 * The customer portal's Notifications actions (UI redesign M2-11, Tasks 11.3-11.4). PUBLIC POST
 * endpoints: requirePortalSite() FIRST (the scanner pins it), then the session (the 15-minute step-up
 * for the email change). Every write is keyed by the HOST partner and the SESSION phone; the form
 * carries only the choice, the new address and the server-minted request key. Each state change and
 * its audit row commit in ONE transaction. Results are fixed copy keys; nothing logs an address or a
 * token.
 */

export type NotificationsActionState = { notice?: MessageKey; error?: MessageKey } | null;

const NOTIFICATIONS_PATH = '/portal/notifications';

/** '1' → true, '0' → false, anything else → null (refused). */
function choice(fd: FormData): boolean | null {
  const v = fd.get('on');
  return v === '1' ? true : v === '0' ? false : null;
}

function audit(ctx: PortalCustomerContext, action: string, meta: Record<string, unknown>) {
  return {
    partnerId: ctx.site.partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system' as const,
    action,
    subjectId: auditSubjectId(ctx.site.partnerId, ctx.session.phone),
    meta,
  };
}

/**
 * WhatsApp updates on/off, mapped EXACTLY onto the bot's STOP/START writes
 * (src/lib/whatsapp-inbound.ts applyConsent): off = setOptedOut(partner, phone, now); on =
 * clearOptedOut(partner, phone) only (START does not stamp opt-in). The bot's confirmation reply is
 * not sent from here. Only `nonessential` messages are suppressed (consent-gate.ts): transfer status
 * and security codes still arrive. Naturally idempotent.
 */
export async function setWhatsappNotificationsAction(_prev: NotificationsActionState, formData: FormData): Promise<NotificationsActionState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const on = choice(formData);
  if (on === null) return { error: 'portal.action.failed' };
  const { partnerId } = ctx.site;
  const phone = ctx.session.phone;
  try {
    await getDb().transaction(async (tx) => {
      const customers = createCustomerStore(tx, getStore());
      if (on) await customers.clearOptedOut(partnerId, phone);
      else await customers.setOptedOut(partnerId, phone, new Date());
      await createAuditRepo(tx).record(audit(ctx, 'customer.consent.whatsapp', { on, via: 'portal' }));
    });
  } catch (err) {
    logWarn('portal.notifications.whatsapp', err instanceof Error ? err.name : 'error');
    return { error: 'portal.action.failed' };
  }
  revalidatePath(NOTIFICATIONS_PATH);
  return { notice: on ? 'portal.notify.wa_on' : 'portal.notify.wa_off' };
}

/** Email receipts on/off. Turning it ON needs the CURRENT address to be verified (tag match). */
export async function setEmailReceiptsAction(_prev: NotificationsActionState, formData: FormData): Promise<NotificationsActionState> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const on = choice(formData);
  if (on === null) return { error: 'portal.action.failed' };
  const { partnerId } = ctx.site;
  const phone = ctx.session.phone;
  try {
    const db = getDb();
    if (on && !(await verifiedReceiptEmail(db, { partnerId, senderPhone: phone, email: ctx.customer.email }))) {
      return { error: 'portal.receipt.verify_email_first' };
    }
    await db.transaction(async (tx) => {
      await setEmailReceipts(tx, partnerId, phone, on);
      await createAuditRepo(tx).record(audit(ctx, 'customer.email.receipts', { on }));
    });
  } catch (err) {
    logWarn('portal.notifications.receipts', err instanceof Error ? err.name : 'error');
    return { error: 'portal.action.failed' };
  }
  revalidatePath(NOTIFICATIONS_PATH);
  return { notice: on ? 'portal.notify.receipts_on' : 'portal.notify.receipts_off' };
}

/**
 * Change the email address (step-up) and send a verify link to it. Inside runOnce (a double submit
 * sends ONE email) and the per-customer `portal-email` limit (5 an hour): the token is minted first
 * (Redis; bound to partner, phone and the new address's tag), then ONE transaction writes the
 * address (single-column, sealed), voids any earlier verification, enqueues the sealed `email.send`
 * and the audit row (no address in it). A token orphaned by a rollback is harmless: its tag matches
 * no address on file. The link is on the partner's own host.
 */
export async function updateEmailAction(_prev: NotificationsActionState, formData: FormData): Promise<NotificationsActionState> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth(NOTIFICATIONS_PATH);
  const email = normalizePortalEmail(formData.get('email'));
  if (!email) return { error: 'portal.email.invalid' };
  const { partnerId, slug, brand } = ctx.site;
  const phone = ctx.session.phone;
  const requestKey = String(formData.get('requestKey') ?? '');
  let code: string;
  try {
    ({ code } = (
      await runOnce(getRedis(), 'portal-email', partnerId, phone, requestKey, async () => {
        const rl = await checkIpRateLimit(getRedis(), PORTAL_EMAIL_LIMIT.scope, auditSubjectId(partnerId, phone), {
          limit: PORTAL_EMAIL_LIMIT.limit,
          windowSec: PORTAL_EMAIL_LIMIT.windowSec,
        });
        if (!rl.allowed) return { code: 'rate_limited' };
        const token = await mintEmailVerifyToken(getRedis(), { partnerId, phone, tag: emailVerifiedTag(partnerId, phone, email) });
        const body = t('portal.email.verify_body', { brand, link: portalEmailVerifyUrl(slug, token) });
        await getDb().transaction(async (tx) => {
          if (!(await createCustomerStore(tx, getStore()).setEmail(partnerId, phone, email))) throw new Error('customer row missing');
          await clearEmailVerification(tx, partnerId, phone);
          await createOutboxRepo(tx).enqueue(
            'email.send',
            {
              to: [email],
              subject: t('portal.email.verify_subject', { brand }),
              text: '{{verify_body}}',
              sealed: { verify_body: encryptField(body, undefined, outboxSealedCtx('verify_body')) },
            },
            { dedupeKey: `pemail:${requestKey}` },
          );
          await createAuditRepo(tx).record(audit(ctx, 'customer.email.update', { via: 'portal' }));
        });
        pokeWorker();
        return { code: 'sent' };
      })
    ).value);
  } catch (err) {
    if (err instanceof BadRequestKeyError) return { error: 'portal.action.expired' };
    if (err instanceof RequestInFlightError) return { error: 'portal.action.in_flight' };
    logWarn('portal.notifications.email', err instanceof Error ? err.name : 'error');
    return { error: 'portal.action.failed' };
  }
  revalidatePath(NOTIFICATIONS_PATH);
  if (code === 'rate_limited') return { error: 'portal.email.rate_limited' };
  return { notice: 'portal.email.sent' };
}
