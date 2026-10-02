import { decideScheduleAction, type ScheduleAction } from './schedule-control';
import { describeSchedule } from './portal-schedules';
import { schedulesDueInRange } from './dashboard';
import { maskPhoneLast4 } from './mask';
import { maskRecipientName } from './partner-transfers';
import type { MessageKey } from './i18n';
import type { PartnerRole } from './partner-access';
import type { CurrencyCode, ScheduleFrequency, ScheduleStatus } from './types';

// partner-schedules (merge plan 2a): the /partner Schedules page's PURE helpers. The record type is
// what partner-schedule-reads selects: no payout destination column (only its stored last 4), so
// nothing is ever decrypted for this page. Controls come from the ONE transition table
// (decideScheduleAction) and are admin-only (owner decision D1); the server action re-checks both.

/** One schedule as the partner read selects it (no destination ciphertext). */
export interface PartnerScheduleRecord {
  id: string;
  phone: string;
  amountSource: number;
  sourceCurrency: CurrencyCode;
  recipientName: string;
  payoutMethod: string;
  payoutDestinationLast4: string;
  frequency: ScheduleFrequency;
  dayOfMonth?: number;
  dayOfWeek?: number;
  status: ScheduleStatus;
  endDate?: string;
  lastRunAt?: string;
  createdAt: string;
  /** The owner has no legal name on file in this tenant, so a due run mints nothing (2026-10-02). */
  needsSenderName?: boolean;
}

export type ScheduleOp = ScheduleAction;
const OPS: readonly ScheduleOp[] = ['pause', 'resume', 'cancel'];

/** The form's op field: exactly pause | resume | cancel, else null. */
export function parseScheduleOp(v: unknown): ScheduleOp | null {
  return typeof v === 'string' && (OPS as readonly string[]).includes(v) ? (v as ScheduleOp) : null;
}

export interface ScheduleControls {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
}

/** What to offer for one schedule. Admin only (D1); the transition table decides the rest. */
export function scheduleControls(status: ScheduleStatus, role: PartnerRole): ScheduleControls {
  const admin = role === 'admin';
  const ok = (op: ScheduleOp) => admin && decideScheduleAction(status, op).ok;
  return { pause: ok('pause'), resume: ok('resume'), cancel: ok('cancel') };
}

export type ScheduleFilter = 'open' | 'all';

/** ?show=all lists cancelled schedules too; anything else is the open list (active + paused). */
export function parseScheduleFilter(v: unknown): ScheduleFilter {
  return v === 'all' ? 'all' : 'open';
}

export function visiblePartnerSchedules<S extends Pick<PartnerScheduleRecord, 'status'>>(list: S[], filter: ScheduleFilter): S[] {
  return filter === 'all' ? list : list.filter((s) => s.status === 'active' || s.status === 'paused');
}

/** The ONLY fields a list row carries (masked). */
export interface PartnerScheduleRow {
  id: string;
  sender: string;
  recipient: string;
  destination: string;
  amount: number;
  currency: string;
  cadence: { key: MessageKey; vars: Record<string, string | number> };
  status: ScheduleStatus;
  lastRunAt: string | null;
  endDate: string | null;
  /** An ACTIVE schedule whose runs are skipped until the owner gives their legal name. */
  needsSenderName: boolean;
  controls: ScheduleControls;
}

export function toPartnerScheduleRow(s: PartnerScheduleRecord, role: PartnerRole): PartnerScheduleRow {
  const last4 = /^[A-Za-z0-9]{1,4}$/.test(s.payoutDestinationLast4) ? s.payoutDestinationLast4 : '';
  return {
    id: s.id,
    sender: maskPhoneLast4(s.phone),
    recipient: maskRecipientName(s.recipientName),
    destination: `****${last4}`,
    amount: s.amountSource,
    currency: s.sourceCurrency,
    cadence: describeSchedule(s),
    status: s.status,
    lastRunAt: s.lastRunAt ?? null,
    endDate: s.endDate ?? null,
    needsSenderName: s.status === 'active' && s.needsSenderName === true,
    controls: scheduleControls(s.status, role),
  };
}

/** Active schedules due in the next `days` days, soonest first (the legacy rule, reused). */
export function partnerSchedulesDueSoon<S extends PartnerScheduleRecord>(list: S[], now: number, days: number): S[] {
  return schedulesDueInRange(list, now, days);
}
