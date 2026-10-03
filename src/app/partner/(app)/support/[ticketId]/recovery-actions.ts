'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getVisibleTicket } from '@/lib/partner-tickets';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import {
  approveMfaRecovery,
  declineMfaRecovery,
  isRecoveryTicket,
  parseDeclineReason,
  parseRecoveryChecks,
  recoveryApprovableAt,
  recoveryTimeLabel,
  type RecoveryActionResult,
} from '@/lib/customer-mfa-recovery';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { Ticket } from '@/lib/types';
import type { PartnerCtx } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '../../../routes';

// /partner two-step recovery decisions (lost-features p4 B4, review BL-3). PARTNER_ADMIN only
// (support and agents see the card read-only). The ticket is the route's target, resolved INSIDE
// the session tenant (getVisibleTicket); a missing, foreign or non-recovery ticket is the same
// not-found, and the customer's partner and phone come only from that row (a form field is never
// read). A request escalated to SmartRemit (waiting_admin) is SmartRemit's to decide: refused
// here, and again atomically in the status UPDATE inside the core. Approval also needs the
// approver's own staff 2FA and a fresh 'customer.mfa.recovery.approve' step-up, checked after the
// input and before any write. Decline only makes things safer, so it asks for no step-up.

const refused = (key: MessageKey, vars?: Record<string, string>): RecoveryActionResult => ({ ok: false, error: t(key, vars) });
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

function refresh(ticketId: string): void {
  revalidatePath(PARTNER_ROUTES.support.href);
  revalidatePath(`${PARTNER_ROUTES.support.href}/${ticketId}`);
}

/** The open recovery request this admin may decide, or the refusal to return. */
async function decidable(ctx: PartnerCtx, formData: FormData): Promise<Ticket | RecoveryActionResult> {
  const ticket = await getVisibleTicket(ctx, String(formData.get('id') ?? '').trim(), 'customer');
  if (!ticket || !isRecoveryTicket(ticket)) return refused('partner.support.notFound');
  if (ticket.status === 'waiting_admin') return refused('partner.support.mfaRecovery.escalated');
  if (ticket.status === 'resolved' || ticket.status === 'closed') return refused('partner.support.mfaRecovery.handled');
  return ticket;
}

export async function approveMfaRecoveryAction(formData: FormData): Promise<RecoveryActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const ticket = await decidable(ctx, formData);
  if ('ok' in ticket) return ticket;

  const checks = parseRecoveryChecks(formData.getAll('check'));
  if (!checks) return refused('partner.support.mfaRecovery.needChecks');
  const approvableAt = recoveryApprovableAt(ticket.createdAt, checks);
  if (!checks.includes('id_document') && Date.now() < approvableAt) {
    return refused('partner.support.mfaRecovery.coolOff', { at: recoveryTimeLabel(approvableAt) });
  }
  let enrolled = false;
  try {
    enrolled = await getStaffMfaStore().isEnrolled(ctx.username);
  } catch {
    enrolled = false; // fail closed
  }
  if (!enrolled) return refused('partner.support.mfaRecovery.needStaffMfa');

  const stepUp = await gatePartnerStepUp(ctx, formData, 'customer.mfa.recovery.approve', { always: true });
  if (stepUp) return stepUp;

  let outcome: Awaited<ReturnType<typeof approveMfaRecovery>>;
  try {
    outcome = await approveMfaRecovery(ticket, { username: ctx.username, scope: 'partner' }, checks);
  } catch (err) {
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.support.mfaRecovery.approve', errName(err), { ticketId: ticket.id });
    return refused('partner.support.failed');
  }
  if (outcome === 'cool_off') return refused('partner.support.mfaRecovery.coolOff', { at: recoveryTimeLabel(approvableAt) });
  if (outcome === 'checks') return refused('partner.support.mfaRecovery.needChecks');
  if (outcome === 'stale' || outcome === 'not_recovery') return refused('partner.support.mfaRecovery.stale');
  refresh(ticket.id);
  return { ok: true, outcome };
}

export async function declineMfaRecoveryAction(formData: FormData): Promise<RecoveryActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const ticket = await decidable(ctx, formData);
  if ('ok' in ticket) return ticket;
  const reason = parseDeclineReason(formData.get('reason'));
  if (!reason) return refused('partner.support.mfaRecovery.reasonInvalid');

  let outcome: Awaited<ReturnType<typeof declineMfaRecovery>>;
  try {
    outcome = await declineMfaRecovery(ticket, { username: ctx.username, scope: 'partner' }, reason);
  } catch (err) {
    logWarn('partner.support.mfaRecovery.decline', errName(err), { ticketId: ticket.id });
    return refused('partner.support.failed');
  }
  if (outcome !== 'declined') return refused('partner.support.mfaRecovery.stale');
  refresh(ticket.id);
  return { ok: true, outcome };
}
