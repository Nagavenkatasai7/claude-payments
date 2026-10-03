import { describe, it, expect } from 'vitest';
import { transferTimeline } from '@/lib/portal-transfers';
import { t as msg } from '@/lib/i18n';
import type { Transfer } from '@/lib/types';

// UI redesign M2-7, Task 7.1: the customer portal's transfer timeline. A pure function over the
// forward-only status machine plus the refund overlay. It never invents timestamps (a step carries
// one only when it is done and the row has the matching valid time: createdAt, paidAt, deliveredAt,
// refundedAt), and a held or blocked transfer shows ONE neutral "under review" step with no
// sanctions or compliance detail.

const CREATED = '2026-01-02T03:04:05.000Z';
const PAID = '2026-01-02T03:10:00.000Z';
const DELIVERED = '2026-01-02T09:00:00.000Z';
const base = (over: Partial<Transfer>): Transfer =>
  ({ id: 'tx1', status: 'awaiting_payment', createdAt: CREATED, refundStatus: 'none', ...over }) as Transfer;

const shape = (t: Transfer) => transferTimeline(t).map((s) => `${s.key}:${s.state}`);

describe('transferTimeline', () => {
  it('awaiting_payment: created done, payment current, delivery upcoming', () => {
    expect(shape(base({}))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.paid:current',
      'portal.timeline.delivered:upcoming',
    ]);
  });
  it('paid: payment done, delivery current', () => {
    expect(shape(base({ status: 'paid', paidAt: CREATED }))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.paid:done',
      'portal.timeline.delivered:current',
    ]);
  });
  it('delivered: every step done', () => {
    expect(shape(base({ status: 'delivered', paidAt: CREATED, deliveredAt: CREATED }))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.paid:done',
      'portal.timeline.delivered:done',
    ]);
  });
  it('in_review (held after payment): a stopped neutral review step, delivery upcoming', () => {
    expect(shape(base({ status: 'in_review', paidAt: CREATED }))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.paid:done',
      'portal.timeline.under_review:stopped',
      'portal.timeline.delivered:upcoming',
    ]);
  });
  it('blocked (never charged): the same neutral review step, stopped, and nothing after it', () => {
    expect(shape(base({ status: 'blocked', complianceReasons: ['sanctions_match'] }))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.under_review:stopped',
    ]);
  });
  it('the review copy carries no sanctions or compliance detail', () => {
    const text = transferTimeline(base({ status: 'blocked' }))
      .map((s) => msg(s.key))
      .join(' ')
      .toLowerCase();
    expect(text).not.toMatch(/sanction|ofac|compliance|blocked|match|screen/);
  });
  it('cancelled before payment: created done, cancelled stopped', () => {
    expect(shape(base({ status: 'cancelled' }))).toEqual(['portal.timeline.created:done', 'portal.timeline.cancelled:stopped']);
  });
  it('cancelled after payment: payment done, then cancelled stopped', () => {
    expect(shape(base({ status: 'cancelled', paidAt: CREATED }))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.paid:done',
      'portal.timeline.cancelled:stopped',
    ]);
  });
  it('refund overlays: requested and in progress are current, completed is done', () => {
    expect(shape(base({ status: 'paid', paidAt: CREATED, refundStatus: 'requested' })).at(-1)).toBe('portal.timeline.refund_requested:current');
    expect(shape(base({ status: 'cancelled', paidAt: CREATED, refundStatus: 'pending' })).at(-1)).toBe('portal.timeline.refund_in_progress:current');
    expect(shape(base({ status: 'cancelled', paidAt: CREATED, refundStatus: 'failed' })).at(-1)).toBe('portal.timeline.refund_in_progress:current');
    expect(shape(base({ status: 'cancelled', paidAt: CREATED, refundStatus: 'completed' })).at(-1)).toBe('portal.timeline.refunded:done');
  });
  it('never invents timestamps: only done steps with a recorded time carry one', () => {
    const steps = transferTimeline(
      base({ status: 'cancelled', paidAt: PAID, deliveredAt: DELIVERED, refundStatus: 'completed', refundedAt: '2026-01-03T00:00:00.000Z' }),
    );
    expect(steps.find((s) => s.key === 'portal.timeline.created')?.at).toBe(CREATED);
    expect(steps.find((s) => s.key === 'portal.timeline.paid')?.at).toBe(PAID);
    expect(steps.find((s) => s.key === 'portal.timeline.refunded')?.at).toBe('2026-01-03T00:00:00.000Z');
    // Cancelled: no delivered step, so deliveredAt is never shown.
    expect(steps.find((s) => s.key === 'portal.timeline.delivered')).toBeUndefined();
    expect(steps.filter((s) => s.at !== undefined)).toHaveLength(3);
    // A completed refund without refundedAt carries no time.
    expect(transferTimeline(base({ status: 'cancelled', refundStatus: 'completed' })).find((s) => s.key === 'portal.timeline.refunded')?.at).toBeUndefined();
  });
  it('delivered: the paid and delivered steps carry their times', () => {
    const steps = transferTimeline(base({ status: 'delivered', paidAt: PAID, deliveredAt: DELIVERED }));
    expect(steps.find((s) => s.key === 'portal.timeline.paid')?.at).toBe(PAID);
    expect(steps.find((s) => s.key === 'portal.timeline.delivered')?.at).toBe(DELIVERED);
  });
  it('paid: only the paid step carries a time; the current delivery step has none', () => {
    const steps = transferTimeline(base({ status: 'paid', paidAt: PAID, deliveredAt: DELIVERED }));
    expect(steps.find((s) => s.key === 'portal.timeline.paid')?.at).toBe(PAID);
    expect(steps.find((s) => s.key === 'portal.timeline.delivered')?.at).toBeUndefined();
  });
  it('in_review: the paid time shows; the upcoming delivery step has none', () => {
    const steps = transferTimeline(base({ status: 'in_review', paidAt: PAID, deliveredAt: DELIVERED }));
    expect(steps.find((s) => s.key === 'portal.timeline.paid')?.at).toBe(PAID);
    expect(steps.find((s) => s.key === 'portal.timeline.delivered')?.at).toBeUndefined();
  });
  it('awaiting_payment: a stray paidAt on a current step is never shown', () => {
    const steps = transferTimeline(base({ paidAt: PAID }));
    expect(steps.find((s) => s.key === 'portal.timeline.paid')?.at).toBeUndefined();
  });
  it('an invalid time string is dropped, not shown', () => {
    const steps = transferTimeline(base({ status: 'delivered', paidAt: 'not-a-date', deliveredAt: '' }));
    expect(steps.find((s) => s.key === 'portal.timeline.paid')?.at).toBeUndefined();
    expect(steps.find((s) => s.key === 'portal.timeline.delivered')?.at).toBeUndefined();
  });
  it('an unknown status degrades to the neutral review step (never a crash, never a raw token)', () => {
    expect(shape(base({ status: 'weird' as Transfer['status'] }))).toEqual([
      'portal.timeline.created:done',
      'portal.timeline.under_review:stopped',
    ]);
  });
});
