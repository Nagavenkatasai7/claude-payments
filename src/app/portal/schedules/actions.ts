'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth, requirePortalCustomer, type PortalCustomerContext } from '@/lib/portal-auth';
import { getRedis } from '@/lib/redis';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { newRequestKey, runOnce, RequestInFlightError } from '@/lib/portal-request-key';
import { buildToolContext } from '@/lib/tool-context';
import {
  createPortalSchedule,
  parseScheduleForm,
  PORTAL_SCHEDULE_LIMIT,
  setPortalScheduleStatus,
  type ScheduleFormErrors,
} from '@/lib/portal-schedules';
import type { ScheduleAction } from '@/lib/schedule-control';
import { needsScamAck, showsScamWarning } from '@/lib/portal-send';
import { logWarn } from '@/lib/log';
import type { MessageKey } from '@/lib/i18n';
import type { PartnerId } from '@/lib/types';

/**
 * Customer-portal scheduled payments (UI redesign M2-10). Public POST endpoints: each one runs the
 * host gate FIRST (requirePortalSite), then the session (requirePortalCustomer), or the 15-minute
 * step-up (requireFreshPortalAuth) for the two that can lead to a new pay link, create and resume,
 * then the per-customer limit. The partner is the HOST's and the phone the SESSION's; a schedule id
 * comes from the bound argument, is re-validated and resolves only inside (partner, phone), so
 * another customer's or tenant's id is the same "not found". No money moves here: every run still
 * mints through the scheduled run, with its sanctions screen, caps and KYC gate. Next's Origin/Host
 * check covers these actions (node_modules/next/dist/docs/01-app/02-guides/data-security.md:550).
 */

export interface ScheduleFormState {
  requestKey: string;
  error?: MessageKey;
  errors?: ScheduleFormErrors;
  /**
   * Echo of the inputs (an opaque rid, an amount, a day, and the customer's own "Other" reason,
   * returned only to the customer who typed it).
   */
  values?: { rid?: string; amount?: string; frequency?: string; dayOfMonth?: string; dayOfWeek?: string; endDate?: string; purpose?: string; purpose_detail?: string };
  /**
   * Batch B follow-up A4: the reason matches a scam pattern, so the form shows the warning and the
   * required "I have read this warning" tick (never which words matched).
   */
  scamWarning?: boolean;
}

const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.slice(0, 40) : '';
};
const echo = (fd: FormData): ScheduleFormState['values'] => ({
  rid: text(fd, 'rid'),
  amount: text(fd, 'amount'),
  frequency: text(fd, 'frequency'),
  dayOfMonth: text(fd, 'dayOfMonth'),
  dayOfWeek: text(fd, 'dayOfWeek'),
  endDate: text(fd, 'endDate'),
  purpose: text(fd, 'purpose'),
  purpose_detail: (() => {
    const v = fd.get('purpose_detail');
    return typeof v === 'string' ? v.slice(0, 480) : '';
  })(),
});
const refuse = (fd: FormData, e: Omit<ScheduleFormState, 'requestKey' | 'values'>): ScheduleFormState => ({
  requestKey: newRequestKey(),
  values: echo(fd),
  ...e,
});

/** Per customer, 20 schedule changes an hour. Fails OPEN on a limiter error (the session gates it). */
async function withinLimit(partnerId: PartnerId, phone: string): Promise<boolean> {
  try {
    const r = await checkIpRateLimit(getRedis(), PORTAL_SCHEDULE_LIMIT.scope, auditSubjectId(partnerId, phone), {
      limit: PORTAL_SCHEDULE_LIMIT.limit,
      windowSec: PORTAL_SCHEDULE_LIMIT.windowSec,
    });
    return r.allowed;
  } catch {
    logWarn('portal.schedules.limit', 'limiter unavailable');
    return true;
  }
}

/** Each create refusal maps to ONE fixed message (a gone recipient and a foreign rid read the same). */
const CREATE_REFUSAL: Record<string, MessageKey> = {
  not_found: 'portal.schedules.recipient_gone',
  recipient_changed: 'portal.schedules.recipient_changed',
  corridor: 'portal.schedules.corridor',
  unknown_destination: 'portal.schedules.corridor',
  sender_name: 'portal.schedules.sender_name',
  amount: 'portal.schedules.amount_invalid',
  no_payout: 'portal.schedules.no_payout',
  day_range: 'portal.schedules.day_invalid',
  invalid_phone: 'portal.schedules.recipient_unusable',
  bad_funding: 'portal.schedules.failed',
  purpose: 'portal.schedules.purpose_invalid',
};

/** Create a scheduled payment to a saved recipient (by its opaque rid). */
export async function createScheduleAction(_prev: ScheduleFormState, formData: FormData): Promise<ScheduleFormState> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth('/portal/schedules/new');
  const pid = ctx.site.partnerId;
  const phone = ctx.session.phone;
  if (!(await withinLimit(pid, phone))) return refuse(formData, { error: 'portal.schedules.too_many' });
  const parsed = parseScheduleForm(formData);
  if (!parsed.ok) return refuse(formData, { errors: parsed.errors });
  const value = parsed.value;
  // Batch B follow-up A4: a scam-pattern reason shows the warning; the tick is required to save.
  const scam = showsScamWarning(value.purposeDetail) ? { scamWarning: true } : {};
  if (needsScamAck(value.purposeDetail, formData)) return refuse(formData, { error: 'portal.send.scam_ack_required', ...scam });
  let out: { kind: string };
  try {
    out = (
      await runOnce(getRedis(), 'portal-schedule-create', pid, phone, text(formData, 'requestKey'), async () => {
        const toolCtx = buildToolContext({ partnerId: pid, phone, channel: 'web', turn: { isNewConversation: false } });
        const r = await createPortalSchedule(getDb(), toolCtx, pid, phone, value);
        return { kind: r.ok ? 'done' : r.code };
      })
    ).value;
  } catch (err) {
    if (err instanceof RequestInFlightError) return refuse(formData, { error: 'portal.schedules.busy', ...scam });
    logWarn('portal.schedules.create', 'create failed');
    return refuse(formData, { error: 'portal.schedules.failed', ...scam });
  }
  if (out.kind !== 'done') return refuse(formData, { error: CREATE_REFUSAL[out.kind] ?? 'portal.schedules.failed', ...scam });
  redirect('/portal/schedules?done=created');
}

const DONE: Record<ScheduleAction, string> = { pause: 'paused', resume: 'resumed', cancel: 'cancelled' };

/** The shared body of pause / resume / cancel, after the gate. Redirects (never returns). */
async function changeStatus(ctx: PortalCustomerContext, scheduleId: string, op: ScheduleAction): Promise<never> {
  const pid = ctx.site.partnerId;
  const phone = ctx.session.phone;
  if (!(await withinLimit(pid, phone))) redirect('/portal/schedules?error=too_many');
  let target: string;
  try {
    const r = await setPortalScheduleStatus(getDb(), pid, phone, scheduleId, op);
    target = r.ok ? `/portal/schedules?done=${DONE[op]}` : `/portal/schedules?error=${r.code}`;
  } catch {
    logWarn('portal.schedules.status', 'status change failed');
    target = '/portal/schedules?error=failed';
  }
  redirect(target);
}

/** Pause: no step-up (it only stops pay links). */
export async function pauseScheduleAction(scheduleId: string, _formData: FormData): Promise<void> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  await changeStatus(ctx, scheduleId, 'pause');
}

/** Resume: step-up, because it starts pay links again. */
export async function resumeScheduleAction(scheduleId: string, _formData: FormData): Promise<void> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth('/portal/schedules');
  await changeStatus(ctx, scheduleId, 'resume');
}

/** Cancel: no step-up (final, and it only stops pay links). */
export async function cancelScheduleAction(scheduleId: string, _formData: FormData): Promise<void> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  await changeStatus(ctx, scheduleId, 'cancel');
}
