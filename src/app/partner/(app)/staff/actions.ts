'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getAuthStore } from '@/lib/auth-store';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { emailConfigured } from '@/lib/email';
import { env } from '@/lib/env';
import { encryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';
import { pokeWorker } from '@/lib/outbox';
import { getRedis } from '@/lib/redis';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { isReservedStaffUsername } from '@/lib/partner-staff-policy';
import { removeTenantStaff } from '@/lib/partner-staff-ops';
import { seedAdminUsername } from '@/lib/staff-login-guard';
import { isValidNewStaffUsername } from '@/lib/staff-username';
import { buildStaffInviteEmail, staffInviteDedupeKey } from '@/lib/staff-invite-email';
import { getStaffInviteStore, INVITE_ID_LEN, isInviteId, MAX_PENDING_INVITES } from '@/lib/staff-invite-store';
import { parseInviteEmail, parseInviteName, parseInviteRole } from '@/lib/staff-invite-input';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/staff server actions (UI redesign M3-8). Every action: the site-host guard, then the gate
// (admin only, MFA enforced by requirePartnerStaff) outside any try, the TENANT from the session only
// (any partnerId / partner / tenant form field is never read), the target resolved inside that
// tenant (missing and foreign are the same "not found"), the input validated before any write.

const POLICY = PARTNER_ROUTES.staff.policy;
const PAGE = PARTNER_ROUTES.staff.href;
/** Invite EMAILS per tenant per hour. The pending cap alone does not bound sends (revoke + re-issue). */
const INVITE_SEND_LIMIT = 20;
const INVITE_SEND_WINDOW_SEC = 60 * 60;
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const fail = (key: MessageKey): ActionResult => ({ ok: false, error: t(key) });

/**
 * Invite a teammate: a single-use 72 h link emailed through the outbox. The link is SEALED in the
 * payload (fix 11); only the recipient address is plaintext there, as for the partner-application
 * invite. The email is never stored in Redis, the invite record or the audit row.
 */
export async function inviteStaffAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);

  // C10: no link is minted that nobody receives.
  if (!emailConfigured()) return fail('partner.staff.emailUnavailable');

  const email = parseInviteEmail(formData.get('email'));
  if (!email) return fail('partner.staff.invalidEmail');
  const username = String(formData.get('username') ?? '').trim();
  if (!isValidNewStaffUsername(username)) return fail('partner.staff.invalidUsername');
  const name = parseInviteName(formData.get('name'));
  if (!name) return fail('partner.staff.invalidName');
  const role = parseInviteRole(formData.get('role'));
  if (!role) return fail('partner.staff.invalidRole');

  const store = getStaffInviteStore();
  let issued: { token: string; hash: string };
  try {
    // One message for every "taken" case (an account anywhere, the seed name, a pending invite in
    // THIS tenant). The inviter is an authenticated tenant admin: the same disclosure as today's
    // create. Other tenants' pending invites are never consulted (that would disclose them).
    if (isReservedStaffUsername(username, seedAdminUsername()) || (await getAuthStore().getStaff(username))) {
      return fail('partner.staff.usernameUnavailable');
    }
    const pending = await store.listForPartner(ctx.partnerId);
    if (pending.some((i) => i.username === username)) return fail('partner.staff.usernameUnavailable');
    if (pending.length >= MAX_PENDING_INVITES) return fail('partner.staff.tooManyInvites');
    const limit = await checkIpRateLimit(getRedis(), 'partner_staff_invite', ctx.partnerId, {
      limit: INVITE_SEND_LIMIT,
      windowSec: INVITE_SEND_WINDOW_SEC,
    });
    if (!limit.allowed) return fail('partner.staff.tooManyInvites');
    const r = await store.issue({ partnerId: ctx.partnerId, username, name, role, invitedBy: ctx.username });
    if ('error' in r) return fail('partner.staff.tooManyInvites');
    issued = r;
  } catch (err) {
    logWarn('partner.staff.invite.issue', errName(err), { partnerId: ctx.partnerId });
    return fail('partner.common.failed');
  }

  const { token, hash } = issued;
  const inviteId = hash.slice(0, INVITE_ID_LEN);
  try {
    await getDb().transaction(async (tx) => {
      const mail = buildStaffInviteEmail();
      const created = await createOutboxRepo(tx).enqueue(
        'email.send',
        {
          to: [email],
          subject: mail.subject,
          text: mail.text,
          // key = STAFF_INVITE_LINK_PLACEHOLDER (a literal: the fix-11 scan refuses computed keys)
          sealed: {
            staff_invite_link: encryptField(`${env.appBaseUrl}/partner/invite/${token}`, undefined, outboxSealedCtx('staff_invite_link')),
          },
        },
        { dedupeKey: staffInviteDedupeKey(hash) },
      );
      if (!created) throw new Error('Invite email collided.');
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'staff.invite.create',
        subjectId: inviteId,
        meta: { username, role, actorScope: 'partner' },
      });
    });
  } catch (err) {
    // Never leave a live link that no email carries and no audit row records.
    try {
      await store.revoke(ctx.partnerId, inviteId);
    } catch (revokeErr) {
      logWarn('partner.staff.invite.rollback', errName(revokeErr), { partnerId: ctx.partnerId, inviteId });
    }
    logWarn('partner.staff.invite', errName(err), { partnerId: ctx.partnerId, inviteId });
    return fail('partner.common.failed');
  }

  pokeWorker();
  revalidatePath(PAGE);
  return { ok: true };
}

/** Revoke one of THIS tenant's pending invites (by its 12-hex id). */
export async function revokeInviteAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const notFound = fail('partner.staff.notFound');

  const id = String(formData.get('id') ?? '').trim();
  if (!isInviteId(id)) return notFound;
  const store = getStaffInviteStore();
  let outcome: 'revoked' | 'gone';
  try {
    const invite = (await store.listForPartner(ctx.partnerId)).find((i) => i.id === id);
    if (!invite) return notFound;
    // The revoke runs inside the transaction, before the audit insert: an audit row is written only
    // for an invite this call actually killed. (A commit failure after the revoke leaves the invite
    // revoked without a row: the safe direction.)
    outcome = await getDb().transaction(async (tx) => {
      if (!(await store.revoke(ctx.partnerId, id))) return 'gone' as const;
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'staff.invite.revoke',
        subjectId: id,
        meta: { username: invite.username, role: invite.role, actorScope: 'partner' },
      });
      return 'revoked' as const;
    });
  } catch (err) {
    logWarn('partner.staff.revoke', errName(err), { partnerId: ctx.partnerId, inviteId: id });
    return fail('partner.common.failed');
  }
  if (outcome === 'gone') return notFound;
  revalidatePath(PAGE);
  return { ok: true };
}

/** Remove a member of THIS tenant (removeTenantStaff: 404-never-403, never yourself, never the last admin). */
export async function removeStaffAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);

  const username = String(formData.get('username') ?? '').trim();
  // Bounded: legacy usernames may predate the new-name format, so only the length is checked here.
  if (!username || username.length > 254) return fail('partner.staff.notFound');
  let result: Awaited<ReturnType<typeof removeTenantStaff>>;
  try {
    result = await removeTenantStaff(ctx.staff, ctx.partnerId, username);
  } catch (err) {
    logWarn('partner.staff.remove', errName(err), { partnerId: ctx.partnerId });
    return fail('partner.common.failed');
  }
  switch (result) {
    case 'removed':
      revalidatePath(PAGE);
      return { ok: true };
    case 'suspended':
      return fail('partner.staff.suspended');
    case 'last_admin':
      return fail('partner.staff.lastAdmin');
    default:
      return fail('partner.staff.notFound');
  }
}
