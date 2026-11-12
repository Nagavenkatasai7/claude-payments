import { describe, it, expect } from 'vitest';
import { REG_CLASS_LABEL, regCaseOverdue, formatDueDate, REG_CASE_TRIAGE_REFUSAL, regCaseStatusMeta } from '@/lib/reg-case-view';

// Fix pack 8 T16 (P14): the pure staff-view helpers of a regulatory case.
const DAY = 86_400_000;

describe('reg-case-view', () => {
  it('labels the four classes (exact record)', () => {
    expect(REG_CLASS_LABEL).toEqual({
      error_notice: 'error notice',
      cancellation: 'cancellation',
      complaint: 'complaint',
      fraud_report: 'fraud report',
    });
  });

  it('regCaseOverdue: only an open classed case past its due date', () => {
    const now = Date.now();
    const yesterday = new Date(now - DAY).toISOString();
    const tomorrow = new Date(now + DAY).toISOString();
    expect(regCaseOverdue({ regClass: 'error_notice', dueAt: yesterday, status: 'open' }, now)).toBe(true);
    expect(regCaseOverdue({ regClass: 'complaint', dueAt: yesterday, status: 'pending' }, now)).toBe(true);
    expect(regCaseOverdue({ regClass: 'complaint', dueAt: yesterday, status: 'waiting_admin' }, now)).toBe(true);
    expect(regCaseOverdue({ regClass: 'error_notice', dueAt: tomorrow, status: 'open' }, now)).toBe(false);
    expect(regCaseOverdue({ regClass: 'error_notice', dueAt: yesterday, status: 'resolved' }, now)).toBe(false);
    expect(regCaseOverdue({ regClass: 'error_notice', dueAt: yesterday, status: 'closed' }, now)).toBe(false);
    // No class: never overdue, even with a due date (reviewer note FA: key on regClass, not dueAt).
    expect(regCaseOverdue({ dueAt: yesterday, status: 'open' }, now)).toBe(false);
    expect(regCaseOverdue({ regClass: 'error_notice', status: 'open' }, now)).toBe(false);
    // An unparseable due date is never overdue.
    expect(regCaseOverdue({ regClass: 'error_notice', dueAt: 'not a date', status: 'open' }, now)).toBe(false);
  });

  it('formatDueDate is en-US medium in UTC', () => {
    const iso = new Date(Date.now() + 3 * DAY).toISOString();
    const want = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
    expect(formatDueDate(iso)).toBe(want);
    expect(formatDueDate(iso)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('the triage refusal text is fixed', () => {
    expect(REG_CASE_TRIAGE_REFUSAL).toBe('A regulatory case keeps its priority and category.');
  });

  it('regCaseStatusMeta: the clock of a classed ticket, nothing for an unclassed one', () => {
    const now = Date.now();
    const tomorrow = new Date(now + DAY).toISOString();
    const yesterday = new Date(now - DAY).toISOString();
    expect(regCaseStatusMeta({ regClass: 'complaint', dueAt: tomorrow }, now)).toEqual({ regClass: 'complaint', dueAt: tomorrow, beforeDue: true });
    expect(regCaseStatusMeta({ regClass: 'error_notice', dueAt: yesterday }, now)).toEqual({ regClass: 'error_notice', dueAt: yesterday, beforeDue: false });
    expect(regCaseStatusMeta({ dueAt: tomorrow }, now)).toBeUndefined();
    expect(regCaseStatusMeta({ regClass: 'complaint' }, now)).toBeUndefined();
    expect(regCaseStatusMeta({}, now)).toBeUndefined();
  });
});
