import { describe, it, expect } from 'vitest';
import { transferStatusView } from '@/lib/ui/transfer-status';
import { transferStatusTone } from '@/app/account/format';
import { t } from '@/lib/i18n';
import { FIXED_REPLIES } from '@/lib/hold-replies';

const STATUSES = ['awaiting_payment', 'paid', 'in_review', 'delivered', 'cancelled', 'blocked'] as const;
describe('transferStatusView (one mapping)', () => {
  it('maps every status to a label key and a tone', () => {
    expect(STATUSES.map((s) => [s, transferStatusView({ status: s }).labelKey])).toEqual(STATUSES.map((s) => [s, `status.transfer.${s}`]));
    expect(transferStatusView({ status: 'delivered' }).tone).toBe('success');
    expect(transferStatusView({ status: 'blocked' }).tone).toBe('danger');
    expect(transferStatusView({ status: 'in_review' }).tone).toBe('warning');
    expect(transferStatusView({ status: 'awaiting_payment' }).tone).toBe('info');
  });
  it('a refund overlay wins, like the customer portal', () => {
    expect(transferStatusView({ status: 'paid', refundStatus: 'completed' }).labelKey).toBe('status.refund.completed');
    expect(transferStatusView({ status: 'paid', refundStatus: 'failed' }).labelKey).toBe('status.transfer.paid');
    expect(transferStatusView({ status: 'paid', refundStatus: 'none' }).labelKey).toBe('status.transfer.paid');
  });
  it('never exposes the raw internal token "blocked" as copy', () => {
    expect(transferStatusView({ status: 'blocked' }).labelKey).not.toBe('blocked');
  });
  it('destructive tones agree with the portal’s badge tones (no semantic drift)', () => {
    for (const s of STATUSES) {
      const portalDanger = transferStatusTone({ status: s, refundStatus: undefined }) === 'destructive';
      expect(transferStatusView({ status: s }).tone === 'danger', s).toBe(portalDanger);
    }
  });
  it('an unknown status from a newer build falls back to a neutral, non-raw view', () => {
    const v = transferStatusView({ status: 'future_state' as never });
    expect(v.tone).toBe('neutral');
    expect(v.labelKey).toBe('status.transfer.unknown');
  });
});

// Review fix (R30): customer surfaces (the portal pill, its receipt and /account)
// never show review wording for a held transfer; staff pages keep "Under review".
describe('transferStatusView for a customer', () => {
  it('a held transfer reads the fixed processing label, with a neutral tone and icon', () => {
    const v = transferStatusView({ status: 'in_review' }, 'customer');
    expect(v.labelKey).toBe('status.customer.in_review');
    expect(t(v.labelKey)).toBe(FIXED_REPLIES.label_held);
    expect(t(v.labelKey)).not.toMatch(/review|hold|check|compliance/i);
    expect(v).toMatchObject({ tone: 'info', icon: 'clock' });
  });
  it('every other status and the refund overlay are the same for both audiences', () => {
    for (const s of STATUSES.filter((x) => x !== 'in_review')) {
      expect(transferStatusView({ status: s }, 'customer'), s).toEqual(transferStatusView({ status: s }));
    }
    expect(transferStatusView({ status: 'in_review', refundStatus: 'pending' }, 'customer').labelKey).toBe('status.refund.pending');
  });
  it('staff keep the review label', () => {
    expect(transferStatusView({ status: 'in_review' }, 'staff').labelKey).toBe('status.transfer.in_review');
    expect(t('status.transfer.in_review')).toBe('Under review');
  });
});
