'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createAuditLogStore } from '@/lib/audit-log-store';
import { getAuthStore } from '@/lib/auth-store';
import { checkIpRateLimit, clientIpFrom } from '@/lib/ip-rate-limit';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { newStaffRecord } from '@/lib/partner-staff-policy';
import { getPartnerStore } from '@/lib/partner-store';
import { hashPassword } from '@/lib/password';
import { getRedis } from '@/lib/redis';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { inviteRedeemable } from '@/lib/staff-invite-accept';
import { getStaffInviteStore, type StaffInvite } from '@/lib/staff-invite-store';
import { seedAdminUsername } from '@/lib/staff-login-guard';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { assertStaffPasswordPolicy, StaffPasswordPolicyError } from '@/lib/staff-password';
import type { Staff } from '@/lib/types';
import {
  DEAD_INVITE,
  INVITE_ACCEPT_IP_LIMIT,
  INVITE_ACCEPT_SCOPE,
  INVITE_ACCEPT_WINDOW_SEC,
  type AcceptInviteResult,
} from './accept-result';

// acceptInviteAction (UI redesign M3-9): the PUBLIC endpoint that turns a single-use staff invite into
// an account. It is unauthenticated, so:
//   - the ONLY request inputs are the token and the two passwords; tenant, role, username and name
//     come from the CONSUMED invite record (any other form field is never read);
//   - every token-side failure returns the one DEAD_INVITE (no oracle);
//   - the password is validated BEFORE the token is consumed, so a weak password never burns the link;
//   - the account claim is createStaff's SET NX, so a name taken meanwhile (two tenants may hold
//     pending invites for one name) loses atomically;
//   - the forced-MFA marker is written (NX, no TTL) BEFORE the account and never deleted here, so no invite-created account
//     can ever exist without it (review R7);
//   - no password, hash or token is ever logged or echoed.
// redirect() stays outside every try (next/dist/docs/01-app/03-api-reference/04-functions/redirect.md:51-53).

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const failed = (): AcceptInviteResult => ({ ok: false, error: t('partner.common.failed') });

/** Per-IP fixed window on the app Redis; FAILS OPEN (the 256-bit token is the real barrier). */
async function acceptRateLimited(): Promise<boolean> {
  try {
    const ip = clientIpFrom(await headers());
    if (ip === 'unknown') return false; // one shared bucket would lock out everyone behind a stripping proxy
    const r = await checkIpRateLimit(getRedis(), INVITE_ACCEPT_SCOPE, ip, {
      limit: INVITE_ACCEPT_IP_LIMIT,
      windowSec: INVITE_ACCEPT_WINDOW_SEC,
    });
    return !r.allowed;
  } catch (err) {
    logWarn('partner.invite.ratelimit', errName(err));
    return false;
  }
}

function redeemDeps() {
  return {
    getPartner: (id: string) => getPartnerStore().getPartner(id),
    getStaff: (u: string) => getAuthStore().getStaff(u),
    seedName: seedAdminUsername(),
  };
}

export async function acceptInviteAction(formData: FormData): Promise<AcceptInviteResult> {
  await refuseOnSiteHost();
  if (await acceptRateLimited()) return DEAD_INVITE;

  const token = formData.get('token');
  const password = formData.get('password');
  const confirm = formData.get('confirm');
  if (typeof token !== 'string' || typeof password !== 'string' || typeof confirm !== 'string') return DEAD_INVITE;

  // Password problems are about the PASSWORD only (not an oracle about the token), and are checked
  // before consume so a weak password never burns the link. Create-class: the breach check fails closed.
  if (password !== confirm) return { ok: false, error: t('partner.invite.mismatch') };
  try {
    await assertStaffPasswordPolicy(password, { failClosed: true });
  } catch (err) {
    if (err instanceof StaffPasswordPolicyError) return { ok: false, error: err.message };
    logWarn('partner.invite.policy', errName(err));
    return failed();
  }

  const store = getStaffInviteStore();
  let inv: StaffInvite | null;
  try {
    inv = await store.consume(token); // GETDEL: a replay or a parallel accept sees null
  } catch (err) {
    logWarn('partner.invite.consume', errName(err));
    return failed();
  }
  if (!inv) return DEAD_INVITE;
  const invite: StaffInvite = inv;

  let record: Staff;
  try {
    if (!(await inviteRedeemable(invite, redeemDeps()))) return DEAD_INVITE;
    record = newStaffRecord(invite.partnerId, {
      username: invite.username,
      name: invite.name,
      role: invite.role,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // The token is already spent; the admin re-sends. Nothing was created.
    logWarn('partner.invite.redeem', errName(err), { partnerId: invite.partnerId });
    return failed();
  }

  const redis = getRedis();
  const markerKey = `${MFA_PENDING_PREFIX}${invite.username}`;
  let created: boolean;
  try {
    // NO ttl: a TTL would silently lift forced enrolment for an invitee who waits to sign in. Cleared
    // only by a successful enrolment (the gate's lazy clear) or by removing the member.
    await redis.set(markerKey, '1', { nx: true });
    created = await getAuthStore().createStaff(record);
  } catch (err) {
    // createStaff released its own claim on a ledger failure. The marker is NEVER deleted on a failure
    // path: another tenant's invitee may win the name in the gap and rely on it (review LOW-1). A
    // leftover marker only ever forces enrolment; enrolment or member removal clears it.
    logWarn('partner.invite.create', errName(err), { partnerId: invite.partnerId });
    return failed();
  }
  if (!created) {
    // The name was taken between the checks and the claim. The marker is LEFT in place (as above).
    logWarn('partner.invite.taken', 'username claimed concurrently', { partnerId: invite.partnerId });
    return DEAD_INVITE;
  }

  // Audit: both rows in ONE transaction. The account already exists, so a failed audit is logged and
  // the invitee still continues (the "nothing was changed" copy would be false now).
  try {
    await getDb().transaction(async (tx) => {
      await createAuditRepo(tx).record({
        partnerId: invite.partnerId,
        actor: invite.username,
        actorType: 'staff',
        action: 'staff.invite.accept',
        subjectId: invite.username,
        meta: { role: invite.role, invitedBy: invite.invitedBy, actorScope: 'partner' },
      });
      await createAuditLogStore(tx).record({
        at: new Date().toISOString(),
        actor: invite.invitedBy,
        action: 'created',
        target: invite.username,
        detail: `${invite.role}, partner staff (invite accepted)`,
        partnerId: invite.partnerId,
        // M3-21: the actor here is the INVITER; a platform-issued invite's inviter is SmartRemit, so the
        // tenant audit view shows "SmartRemit", never the platform username (partner-audit-view.ts).
        actorScope: invite.inviterScope === 'platform' ? 'platform' : 'partner',
      });
    });
  } catch (err) {
    logWarn('partner.invite.audit', errName(err), { partnerId: invite.partnerId });
  }
  // Program-Fix 17b parity (partners/actions.ts): no stale enrolment on a re-used name. Only after our
  // claim won; a failed reset leaves a stale enrolment that fails closed (the invitee cannot sign in).
  try {
    await getStaffMfaStore().reset(invite.username);
  } catch (err) {
    logWarn('partner.invite.mfa_reset', errName(err), { partnerId: invite.partnerId });
  }

  redirect('/login');
}
