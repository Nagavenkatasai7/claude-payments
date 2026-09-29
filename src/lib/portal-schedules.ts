import type { Db, DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { auditSubjectId } from './customer-ref';
import { PORTAL_AUTH_ACTOR } from './portal-auth-audit';
import { findByRid, isRid, lockRecipientBook } from './portal-recipients';
import { decideScheduleAction, SCHEDULE_REFUSAL, type ScheduleAction } from './schedule-control';
import { validateScheduleInput, type ScheduleRefusalCode } from './schedule-validate';
import { newTransferId } from './id';
import { normalizePhone } from './phone';
import { boundUntrustedText, NAME_MAX } from './untrusted-text';
import { t, type MessageKey } from './i18n';
import type { ToolContext } from './tools';
import type { PartnerId, Schedule, ScheduleStatus } from './types';

/**
 * portal-schedules — the customer portal's recurring payments (UI redesign M2-10). Server only.
 *
 * - Create: the recipient is a SAVED, live recipient addressed by its opaque rid (M2-8), resolved
 *   inside (host partner, session phone); its number and name come from the stored row, never the
 *   form. The schedule itself is built by the bot's own validation (validateScheduleInput: India
 *   only, day ranges, sender legal name, the payout from resolveStoredPayout, tombstone-aware) with
 *   the portal's two opt-in checks on (amount range, a stored payout required), then saved with the
 *   same writer the bot uses and audited in the SAME transaction. No money moves here: every run
 *   still mints through the scheduled run (cron-run.ts), with its sanctions screen, caps and KYC gate.
 * - Pause / resume / cancel: the ONE transition table (decideScheduleAction) and the conditional
 *   writer (setStatusIf, `WHERE id AND partner_id AND status IN (from)`), after a read scoped to the
 *   owner (getOwnedSchedule: partner AND phone in the WHERE). Another tenant's or customer's id,
 *   a random id and a malformed id are the same "not found". Audited in the same transaction.
 * - Audit meta: ids and states only (an allow-list; anything else throws).
 */

/** Per customer: creates and status changes together (plan DoD: `portal-schedule` 20/h). */
export const PORTAL_SCHEDULE_LIMIT = { scope: 'portal-schedule', limit: 20, windowSec: 3600 } as const;

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const isScheduleId = (v: unknown): v is string => typeof v === 'string' && SCHEDULE_ID_RE.test(v);

/** What the portal lists: active and paused (a cancelled schedule is history, not shown). */
export function visibleSchedules(list: Schedule[]): Schedule[] {
  return list.filter((s) => s.status === 'active' || s.status === 'paused');
}

const WEEKDAY_KEYS: MessageKey[] = [
  'portal.schedules.weekday0',
  'portal.schedules.weekday1',
  'portal.schedules.weekday2',
  'portal.schedules.weekday3',
  'portal.schedules.weekday4',
  'portal.schedules.weekday5',
  'portal.schedules.weekday6',
];

/** The cadence line: "Every month on day 5" / "Every Monday". */
export function describeSchedule(s: Pick<Schedule, 'frequency' | 'dayOfMonth' | 'dayOfWeek'>): { key: MessageKey; vars: Record<string, string | number> } {
  if (s.frequency === 'weekly') {
    const k = WEEKDAY_KEYS[s.dayOfWeek ?? -1];
    return { key: 'portal.schedules.weeklyOn', vars: { weekday: k ? t(k) : '' } };
  }
  return { key: 'portal.schedules.monthlyOn', vars: { day: s.dayOfMonth ?? '' } };
}

// ── The create form ───────────────────────────────────────────────────────────

export interface ScheduleFormErrors {
  recipient?: MessageKey;
  amount?: MessageKey;
  frequency?: MessageKey;
  day?: MessageKey;
  endDate?: MessageKey;
}

export interface ScheduleFormValue {
  rid: string;
  amount: number;
  frequency: 'monthly' | 'weekly';
  dayOfMonth: number | undefined;
  dayOfWeek: number | undefined;
  endDate: string | undefined;
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.trim().slice(0, 40) : '';
};
const AMOUNT_RE = /^\d{1,6}(\.\d{1,2})?$/;
const INT_RE = /^\d{1,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape-only parse of the create form; the business rules are validateScheduleInput's. */
export function parseScheduleForm(fd: FormData, now: number = Date.now()): { ok: true; value: ScheduleFormValue } | { ok: false; errors: ScheduleFormErrors } {
  const errors: ScheduleFormErrors = {};
  const rid = str(fd, 'rid');
  if (!isRid(rid)) errors.recipient = 'portal.schedules.recipient_invalid';
  const amountRaw = str(fd, 'amount');
  const amount = AMOUNT_RE.test(amountRaw) ? Number(amountRaw) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) errors.amount = 'portal.schedules.amount_invalid';
  const f = str(fd, 'frequency');
  const frequency = f === 'monthly' || f === 'weekly' ? f : null;
  if (!frequency) errors.frequency = 'portal.schedules.frequency_invalid';
  let dayOfMonth: number | undefined;
  let dayOfWeek: number | undefined;
  if (frequency === 'monthly') {
    const d = str(fd, 'dayOfMonth');
    dayOfMonth = INT_RE.test(d) ? Number(d) : Number.NaN;
    if (!(dayOfMonth >= 1 && dayOfMonth <= 28)) errors.day = 'portal.schedules.day_invalid';
  } else if (frequency === 'weekly') {
    const d = str(fd, 'dayOfWeek');
    dayOfWeek = /^\d$/.test(d) ? Number(d) : Number.NaN;
    if (!(dayOfWeek >= 0 && dayOfWeek <= 6)) errors.day = 'portal.schedules.day_invalid';
  } else {
    errors.day = 'portal.schedules.day_invalid';
  }
  const e = str(fd, 'endDate');
  let endDate: string | undefined;
  if (e !== '') {
    const at = DATE_RE.test(e) ? Date.parse(`${e}T23:59:59Z`) : Number.NaN;
    if (!Number.isFinite(at) || at <= now || new Date(`${e}T00:00:00Z`).toISOString().slice(0, 10) !== e) {
      errors.endDate = 'portal.schedules.endDate_invalid';
    } else {
      endDate = e;
    }
  }
  if (Object.keys(errors).length > 0 || !frequency) return { ok: false, errors };
  return { ok: true, value: { rid, amount, frequency, dayOfMonth, dayOfWeek, endDate } };
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export type ScheduleAuditAction = 'schedule.create' | 'schedule.pause' | 'schedule.resume' | 'schedule.cancel';
export type ScheduleAuditMeta = { scheduleId: string; from?: ScheduleStatus; to?: ScheduleStatus };

const STATUSES: ReadonlySet<unknown> = new Set(['active', 'paused', 'cancelled']);

function checkMeta(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    const ok = (k === 'scheduleId' && isScheduleId(v)) || ((k === 'from' || k === 'to') && STATUSES.has(v));
    if (!ok) throw new Error('portal schedule audit: meta not allowed');
  }
}

/**
 * One audit row for a customer's own schedule change: actor `system:customer-portal`, subject = the
 * keyed customer subject (never the phone). Throws on a guard refusal or a DB failure (the caller's
 * transaction then rolls back).
 */
export async function recordScheduleAudit(
  db: DbOrTx,
  e: { partnerId: PartnerId; phone: string; action: ScheduleAuditAction; meta: ScheduleAuditMeta },
): Promise<void> {
  checkMeta(e.meta as Record<string, unknown>);
  await createAuditRepo(db).record({
    partnerId: e.partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system',
    action: e.action,
    subjectId: auditSubjectId(e.partnerId, normalizePhone(e.phone)),
    meta: e.meta,
  });
}

// ── Create ────────────────────────────────────────────────────────────────────

export type CreateScheduleResult = { ok: true; scheduleId: string } | { ok: false; code: 'not_found' | 'recipient_changed' | ScheduleRefusalCode };

/**
 * Create one schedule for (partnerId, phone). `ctx` is a web ToolContext for the SAME (partner,
 * phone) (the caller builds it from the host and the session). The recipient is re-resolved here by
 * rid, so a deleted, another customer's or another tenant's recipient is `not_found` with nothing
 * written.
 */
export async function createPortalSchedule(
  db: Db,
  ctx: ToolContext,
  partnerId: PartnerId,
  phone: string,
  value: ScheduleFormValue,
): Promise<CreateScheduleResult> {
  if (ctx.partnerId !== partnerId || ctx.phone !== phone) throw new Error('portal schedule: context mismatch');
  const recipient = await findByRid(db, partnerId, phone, value.rid);
  if (!recipient) return { ok: false, code: 'not_found' };
  const v = await validateScheduleInput(
    ctx,
    {
      recipientPhone: recipient.recipientPhone,
      recipientName: boundUntrustedText(recipient.name, NAME_MAX),
      amountSource: value.amount,
      fundingMethod: 'bank_transfer',
      frequency: value.frequency,
      dayOfMonth: value.dayOfMonth,
      dayOfWeek: value.dayOfWeek,
      // No destination argument: the recipient's own number decides, so a non-Indian number is
      // refused (corridor). An explicit 'IN' would let any number through the India-only check.
      destinationCountry: undefined,
      endDate: value.endDate,
    },
    { amountBounds: true, requirePayout: true },
  );
  if (!v.ok) return { ok: false, code: v.code };
  const schedule: Schedule = { id: newTransferId(), ...v.schedule, createdAt: new Date().toISOString() };
  // Serialized with a recipient delete (review LOW 2): both take the same per-(tenant, sender)
  // address-book lock, and the recipient is re-resolved under it. A delete that committed first is
  // seen here (not_found, nothing written); a delete that comes after waits and its schedule sweep
  // then sees (and cancels) this schedule.
  // The account saved must be exactly the saved recipient's as it stands under the lock: a portal
  // edit (which takes the same lock) or a delete-and-re-add that changed it after validation is
  // refused, never saved with the old account (delta review LOW-B).
  const outcome = await db.transaction(async (tx): Promise<'saved' | 'not_found' | 'recipient_changed'> => {
    await lockRecipientBook(tx, partnerId, phone);
    const fresh = await findByRid(tx, partnerId, phone, value.rid);
    if (!fresh) return 'not_found';
    if (fresh.payoutMethod !== schedule.payoutMethod || fresh.payoutDestination !== schedule.payoutDestination) return 'recipient_changed';
    await createScheduleRepo(tx).saveSchedule(schedule);
    await recordScheduleAudit(tx, { partnerId, phone, action: 'schedule.create', meta: { scheduleId: schedule.id } });
    return 'saved';
  });
  if (outcome !== 'saved') return { ok: false, code: outcome };
  return { ok: true, scheduleId: schedule.id };
}

// ── Pause / resume / cancel ───────────────────────────────────────────────────

export type ScheduleStatusRefusal = 'not_found' | 'already_paused' | 'not_paused' | 'cancelled' | 'changed';
export type SetScheduleStatusResult = { ok: true; status: ScheduleStatus } | { ok: false; code: ScheduleStatusRefusal };

function refusalCode(reason: string): ScheduleStatusRefusal {
  if (reason === SCHEDULE_REFUSAL.alreadyPaused) return 'already_paused';
  if (reason === SCHEDULE_REFUSAL.notPaused) return 'not_paused';
  if (reason === SCHEDULE_REFUSAL.cancelled) return 'cancelled';
  return 'changed';
}

/** One status change on the customer's OWN schedule: scoped read → transition table → conditional write + audit. */
export async function setPortalScheduleStatus(
  db: Db,
  partnerId: PartnerId,
  phone: string,
  id: unknown,
  op: ScheduleAction,
): Promise<SetScheduleStatusResult> {
  if (!isScheduleId(id)) return { ok: false, code: 'not_found' };
  const current = await createScheduleRepo(db).getOwnedSchedule(partnerId, phone, id);
  if (!current) return { ok: false, code: 'not_found' };
  const decision = decideScheduleAction(current.status, op);
  if (!decision.ok) return { ok: false, code: refusalCode(decision.reason) };
  return db.transaction(async (tx): Promise<SetScheduleStatusResult> => {
    // partnerId is the HOST's; the owner check above bound the id to this (partner, phone).
    // From the status actually read (always inside decision.from), so a concurrent change is a
    // 'changed' refusal and the audit's `from` is exactly what was replaced (review LOW 1).
    const updated = await createScheduleRepo(tx).setStatusIf(id, partnerId, [current.status], decision.to);
    if (!updated || updated.phone !== phone) {
      if (updated) throw new Error('portal schedule: owner changed'); // unreachable: phone is immutable; roll back
      return { ok: false, code: 'changed' };
    }
    await recordScheduleAudit(tx, {
      partnerId,
      phone,
      action: `schedule.${op}`,
      meta: { scheduleId: id, from: current.status, to: decision.to },
    });
    return { ok: true, status: decision.to };
  });
}
