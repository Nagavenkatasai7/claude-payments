'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { gateStaffStepUp } from '@/lib/partner-step-up-gate';
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
import { isTicketId } from '@/lib/partner-tickets';
import { logWarn } from '@/lib/log';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { Ticket } from '@/lib/types';

// /admin-dashboard two-step recovery decisions (lost-features p4 B4, review BL-3). PLATFORM admins
// only (requirePlatformAdmin: role admin with no tenant; support, agents and every partner-scoped
// record are redirected). The ticket is the form's target id, re-read here; anything that is not an
// open recovery request is the same not-found, and the customer's partner and phone come only from
// that row. Approval needs the approver's own staff 2FA and a fresh 'customer.mfa.recovery.approve'
// step-up, checked after the input and before any write. A request a partner escalated to
// SmartRemit (waiting_admin) is decided here. Copy is English literals (no catalogue on this surface).

const NOT_FOUND = 'Recovery request not found.';
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (error: string): RecoveryActionResult => ({ ok: false, error });

async function decidable(formData: FormData): Promise<Ticket | RecoveryActionResult> {
  const id = String(formData.get('ticketId') ?? '').trim();
  if (!isTicketId(id)) return refused(NOT_FOUND);
  const ticket = await createTicketRepo(getDb()).getTicket(id);
  if (!ticket || !isRecoveryTicket(ticket)) return refused(NOT_FOUND);
  if (ticket.status === 'resolved' || ticket.status === 'closed') return refused('This request was already handled.');
  return ticket;
}

const coolOff = (at: number) => refused(`Without an ID document check, this can be approved from ${recoveryTimeLabel(at)}.`);
const NEED_CHECKS = 'Check an ID document or a recent transfer first.';
const STALE = 'This request was already handled. Reload the page.';

export async function approveMfaRecoveryAction(formData: FormData): Promise<RecoveryActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const ticket = await decidable(formData);
  if ('ok' in ticket) return ticket;

  const checks = parseRecoveryChecks(formData.getAll('check'));
  if (!checks) return refused(NEED_CHECKS);
  const approvableAt = recoveryApprovableAt(ticket.createdAt, checks);
  if (!checks.includes('id_document') && Date.now() < approvableAt) return coolOff(approvableAt);
  let enrolled = false;
  try {
    enrolled = await getStaffMfaStore().isEnrolled(staff.username);
  } catch {
    enrolled = false; // fail closed
  }
  if (!enrolled) return refused('Turn on two-step verification for your own staff account first.');

  const stepUp = await gateStaffStepUp(staff, formData, 'customer.mfa.recovery.approve');
  if (stepUp) return stepUp;

  let outcome: Awaited<ReturnType<typeof approveMfaRecovery>>;
  try {
    outcome = await approveMfaRecovery(ticket, { username: staff.username, scope: 'platform' }, checks);
  } catch (err) {
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('tickets.mfaRecovery.approve', errName(err), { ticketId: ticket.id });
    return refused('Something went wrong. Nothing was changed. Please try again.');
  }
  if (outcome === 'cool_off') return coolOff(approvableAt);
  if (outcome === 'checks') return refused(NEED_CHECKS);
  if (outcome === 'stale' || outcome === 'not_recovery') return refused(STALE);
  revalidatePath('/admin-dashboard', 'layout');
  return { ok: true, outcome };
}

export async function declineMfaRecoveryAction(formData: FormData): Promise<RecoveryActionResult> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const ticket = await decidable(formData);
  if ('ok' in ticket) return ticket;
  const reason = parseDeclineReason(formData.get('reason'));
  if (!reason) return refused('Choose a reason.');

  let outcome: Awaited<ReturnType<typeof declineMfaRecovery>>;
  try {
    outcome = await declineMfaRecovery(ticket, { username: staff.username, scope: 'platform' }, reason);
  } catch (err) {
    logWarn('tickets.mfaRecovery.decline', errName(err), { ticketId: ticket.id });
    return refused('Something went wrong. Nothing was changed. Please try again.');
  }
  if (outcome !== 'declined') return refused(STALE);
  revalidatePath('/admin-dashboard', 'layout');
  return { ok: true, outcome };
}
