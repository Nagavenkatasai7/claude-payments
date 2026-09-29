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
import { outboxSealedCtx } from '@/lib/crypto-context';
import { pokeWorker } from '@/lib/outbox';
import { issueApplicationToken } from '@/lib/partner-application-token';
import { buildInviteEmail, inviteResendDedupeKey } from '@/lib/partner-invite-email';
import {
  canDecideApplication,
  isPartnerRequestId,
  parseDecisionReason,
  type ApplicationDecision,
} from '@/lib/partner-application-decision';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { requireStaffReason } from '@/lib/send-limits';
import { createPartnerStore } from '@/lib/partner-store';
import { getAuthStore } from '@/lib/auth-store';
import { createPendingGoLive } from '@/db/repos/partner-go-live-repo';
import { partnerIdForRequest, partnerRecordFromRequest } from '@/lib/partner-from-request';
import { getStaffInviteStore, INVITE_ID_LEN } from '@/lib/staff-invite-store';
import { buildStaffInviteEmail, staffInviteDedupeKey } from '@/lib/staff-invite-email';
import { parseInviteEmail, parseInviteName } from '@/lib/staff-invite-input';
import { isValidNewStaffUsername } from '@/lib/staff-username';
import { isReservedStaffUsername } from '@/lib/partner-staff-policy';
import { seedAdminUsername } from '@/lib/staff-login-guard';
import { logWarn } from '@/lib/log';

// Partner-request staff actions (Program-Fix 39). A server action is a public
// POST endpoint, so every action self-gates: PLATFORM ADMINS only (these are
// cross-tenant business-development records), and it validates the target
// before mutating. Every mutation writes an audit_events row.

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
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  if (!isPartnerRequestId(id)) throw new Error('Invalid partner request id.');
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
    const sealedApplyLink = encryptField(
      `${env.appBaseUrl}/partners/apply/${token}`,
      undefined,
      outboxSealedCtx('apply_link'), // the same mapping sealed-text opens with (fix 46A)
    );
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

/**
 * Program-Fix 49C (partner-02): the staff decision on a SUBMITTED application.
 * Platform admins only; a reason is required (kept in the audit row only).
 * completed → approved | rejected, nothing else: an 'invited' row has nothing
 * to decide and a decided row is final. In ONE transaction the conditional
 * UPDATE (the atomic double-decide guard) also clears the application link's
 * token hash, and the audit row is written only when the row actually moved.
 * No email is sent to anyone: approval hands staff to the partner wizard.
 */
async function decideApplication(formData: FormData, decision: ApplicationDecision): Promise<void> {
  const staff = await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  if (!isPartnerRequestId(id)) throw new Error('Invalid partner request id.');
  const page = `/admin-dashboard/partner-requests/${encodeURIComponent(id)}`;

  const existing = await createPartnerRequestRepo(getDb()).getPartnerRequest(id);
  if (!existing) notFound();
  const reason = parseDecisionReason(formData.get('reason'));
  if (!reason) redirect(`${page}?decision=reason_required`);
  if (!canDecideApplication(existing.applicationStatus)) redirect(`${page}?decision=not_decidable`);

  const decided = await getDb().transaction(async (tx) => {
    const moved = await createPartnerRequestRepo(tx).decideApplication(id, decision);
    if (!moved) return false;
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: decision === 'approved' ? 'partner_application.approve' : 'partner_application.reject',
      subjectId: id,
      meta: { reason, from: 'completed', to: decision, linkRevoked: true },
    });
    return true;
  });

  revalidatePath(page);
  revalidatePath('/admin-dashboard/partner-requests');
  redirect(`${page}?decision=${decided ? decision : 'not_decidable'}`);
}

export async function approveApplicationAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  await decideApplication(formData, 'approved');
}

export async function rejectApplicationAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  await decideApplication(formData, 'rejected');
}

/**
 * UI redesign M3-21 (C6): an APPROVED partner request becomes a partner plus an invite for its first
 * partner ADMIN. Platform admins only, with a reason (≥ 10). No API key of any kind is issued: the
 * partner starts with a go-live row NOT approved (sandbox-only until it requests go-live and a
 * platform admin approves it). The approve/reject decision and the wizard are unchanged.
 *
 *   - The partner id is DETERMINISTIC per request (partnerIdForRequest), and the create runs under
 *     the request row's FOR UPDATE lock with an existence check, so a double submit (or a replay)
 *     never makes a second partner: the loser revokes the invite it minted.
 *   - The invitee's address is the LOCKED request row's, never a form field. The link is sealed in
 *     the outbox payload (fix 11); only `to` is plaintext there until the 7-day scrub.
 *   - The invite is the M3-8 single-use 72 h link (Redis, hash only); invitedBy is the platform
 *     admin, which the M3-9 accept re-check admits for an ADMIN invite only (staff-invite-accept.ts).
 *   - partner row + go-live row + email outbox row + both audit rows commit in ONE transaction; a
 *     failure revokes the invite (never a live link that no email carries and no audit records).
 */
export type CreateFromRequestOutcome =
  | 'created'
  | 'exists'
  | 'not_approved'
  | 'reason_required'
  | 'invalid_username'
  | 'invalid_name'
  | 'invalid_email'
  | 'username_taken'
  | 'unconfigured'
  | 'failed';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

export async function createPartnerFromRequestAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  if (!isPartnerRequestId(id)) throw new Error('Invalid partner request id.');
  const page = `/admin-dashboard/partner-requests/${encodeURIComponent(id)}`;

  const existing = await createPartnerRequestRepo(getDb()).getPartnerRequest(id);
  if (!existing) notFound();
  const outcome = await createPartnerFromRequest(formData, id, existing, staff.username);
  if (outcome === 'created') pokeWorker();
  revalidatePath(page);
  revalidatePath('/admin-dashboard/partners');
  redirect(`${page}?create=${outcome}`);
}

async function createPartnerFromRequest(
  formData: FormData,
  id: string,
  existing: { applicationStatus?: string; email: string; companyName: string; corridors: string[] },
  actor: string,
): Promise<CreateFromRequestOutcome> {
  let reason: string;
  try {
    reason = requireStaffReason(formData.get('reason'));
  } catch {
    return 'reason_required';
  }
  if (existing.applicationStatus !== 'approved') return 'not_approved';
  const username = String(formData.get('username') ?? '').trim();
  if (!isValidNewStaffUsername(username)) return 'invalid_username';
  const name = parseInviteName(formData.get('name'));
  if (!name) return 'invalid_name';
  if (!parseInviteEmail(existing.email)) return 'invalid_email';
  if (!existing.companyName.trim()) return 'failed'; // a partner needs a name (the column is NOT NULL, not non-blank)

  const partnerId = partnerIdForRequest(id);
  // Fast path: an already-created partner never mints another invite.
  if (await createPartnerStore(getDb()).getPartner(partnerId)) return 'exists';
  // C10: no link is minted that nobody receives.
  if (!emailConfigured()) return 'unconfigured';
  if (isReservedStaffUsername(username, seedAdminUsername()) || (await getAuthStore().getStaff(username))) {
    return 'username_taken';
  }

  const store = getStaffInviteStore();
  let issued: { token: string; hash: string };
  try {
    const r = await store.issue({ partnerId, username, name, role: 'admin', invitedBy: actor });
    if ('error' in r) return 'failed'; // a brand-new tenant has no pending invites
    issued = r;
  } catch (err) {
    logWarn('admin.partner_from_request.invite', errName(err), { requestId: id });
    return 'failed';
  }
  const inviteId = issued.hash.slice(0, INVITE_ID_LEN);

  let outcome: CreateFromRequestOutcome;
  try {
    outcome = await getDb().transaction(async (tx): Promise<CreateFromRequestOutcome> => {
      // Drizzle pg-core select().for('update') — node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586.
      const [locked] = await tx
        .select({ email: partnerRequests.email, applicationStatus: partnerRequests.applicationStatus, companyName: partnerRequests.companyName, corridors: partnerRequests.corridors })
        .from(partnerRequests)
        .where(eq(partnerRequests.id, id))
        .limit(1)
        .for('update');
      if (!locked || locked.applicationStatus !== 'approved') return 'not_approved';
      const partners = createPartnerStore(tx);
      if (await partners.getPartner(partnerId)) return 'exists';
      const email = parseInviteEmail(locked.email);
      if (!email) return 'invalid_email';
      const corridors = Array.isArray(locked.corridors) ? locked.corridors.map(String) : [];

      // The same store call the platform wizard uses (partners/actions.ts wizardCreatePartnerAction).
      await partners.savePartner(partnerRecordFromRequest({ companyName: locked.companyName, corridors }, partnerId, new Date().toISOString()));
      await createPendingGoLive(tx, partnerId);
      const mail = buildStaffInviteEmail();
      const created = await createOutboxRepo(tx).enqueue(
        'email.send',
        {
          to: [email],
          subject: mail.subject,
          text: mail.text,
          // key = STAFF_INVITE_LINK_PLACEHOLDER (a literal: the fix-11 scan refuses computed keys)
          sealed: {
            staff_invite_link: encryptField(`${env.appBaseUrl}/partner/invite/${issued.token}`, undefined, outboxSealedCtx('staff_invite_link')),
          },
        },
        { dedupeKey: staffInviteDedupeKey(issued.hash) },
      );
      if (!created) throw new Error('Invite email collided.');
      const audit = createAuditRepo(tx);
      await audit.record({
        partnerId,
        actor,
        actorType: 'staff',
        action: 'partner.create_from_request',
        subjectId: id,
        meta: { reason, requestId: id, actorScope: 'platform' },
      });
      await audit.record({
        partnerId,
        actor,
        actorType: 'staff',
        action: 'staff.invite.create',
        subjectId: inviteId,
        meta: { username, role: 'admin', actorScope: 'platform' },
      });
      return 'created';
    });
  } catch (err) {
    logWarn('admin.partner_from_request', errName(err), { requestId: id });
    outcome = 'failed';
  }

  if (outcome !== 'created') {
    // Never leave a live link that no email carries and no audit row records.
    try {
      await store.revoke(partnerId, inviteId);
    } catch (revokeErr) {
      logWarn('admin.partner_from_request.rollback', errName(revokeErr), { requestId: id });
    }
  }
  return outcome;
}
