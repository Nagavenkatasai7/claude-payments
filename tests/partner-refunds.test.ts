import { describe, it, expect } from 'vitest';
import { parseRefundOp, refundControls, refundCounts, refundStepUpTarget, toPartnerRefundRow } from '@/lib/partner-refunds';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';
import type { RefundStatus, Transfer } from '@/lib/types';

// Merge plan 2b: the /partner Refunds page's pure helpers. Decisions are admin-only (D1); approve
// and retry move money, so they are the two step-up targets (D2); dismiss is not.

const NONE = { approve: false, dismiss: false, retry: false };

describe('parseRefundOp', () => {
  it('accepts exactly approve, dismiss and retry', () => {
    expect(parseRefundOp('approve')).toBe('approve');
    expect(parseRefundOp('dismiss')).toBe('dismiss');
    expect(parseRefundOp('retry')).toBe('retry');
  });
  it('refuses anything else', () => {
    for (const v of ['', 'Approve', 'issue', 'refund', ' retry', null, undefined, 0, {}, ['approve']]) expect(parseRefundOp(v)).toBeNull();
  });
});

describe('refundControls', () => {
  it('admin: requested → approve + dismiss; failed → retry; pending / completed / none → nothing', () => {
    expect(refundControls('requested', 'admin')).toEqual({ approve: true, dismiss: true, retry: false });
    expect(refundControls('failed', 'admin')).toEqual({ approve: false, dismiss: false, retry: true });
    for (const s of ['pending', 'completed', 'none', undefined] as Array<RefundStatus | undefined>) expect(refundControls(s, 'admin')).toEqual(NONE);
  });
  it('D1: no non-admin role gets a control in any state', () => {
    for (const role of KNOWN_PARTNER_ROLES.filter((r) => r !== 'admin')) {
      for (const s of ['requested', 'failed', 'pending', 'completed', 'none'] as RefundStatus[]) expect(refundControls(s, role)).toEqual(NONE);
    }
  });
  it('unknown status or role → nothing (fails closed)', () => {
    expect(refundControls('weird' as RefundStatus, 'admin')).toEqual(NONE);
    expect(refundControls('requested', 'root' as never)).toEqual(NONE);
  });
});

describe('refundStepUpTarget', () => {
  it('D2: approve and retry need a step-up; dismiss does not', () => {
    expect(refundStepUpTarget('approve')).toBe('refund.approve');
    expect(refundStepUpTarget('retry')).toBe('refund.retry');
    expect(refundStepUpTarget('dismiss')).toBeNull();
  });
});

describe('refundCounts', () => {
  it('counts each non-none state; none and unknown values are not counted', () => {
    const rows = (['requested', 'requested', 'pending', 'failed', 'completed', 'completed', 'completed', 'none'] as RefundStatus[]).map((refundStatus) => ({ refundStatus }));
    expect(refundCounts(rows)).toEqual({ requested: 2, pending: 1, failed: 1, completed: 3 });
    expect(refundCounts([])).toEqual({ requested: 0, pending: 0, failed: 0, completed: 0 });
  });
});

describe('toPartnerRefundRow', () => {
  const tr = {
    id: 'tr_r1',
    phone: '15550004321',
    recipientName: 'Givenname Familyname',
    recipientPhone: '919800001111',
    payoutDestination: '****2222',
    amountUsd: 100,
    totalChargeUsd: 102,
    totalChargeSource: 102,
    sourceCurrency: 'USD',
    refundStatus: 'requested',
    status: 'paid',
    createdAt: new Date().toISOString(),
    partnerId: 'pa',
  } as unknown as Transfer;

  it('masked values only, the refundable amount is the full source-side charge', () => {
    const row = toPartnerRefundRow(tr, 'admin');
    expect(row).toMatchObject({
      id: 'tr_r1',
      sender: '••••4321',
      recipient: 'Givenname F.',
      amount: 102,
      currency: 'USD',
      refundStatus: 'requested',
      test: false,
      controls: { approve: true, dismiss: true, retry: false },
    });
    const json = JSON.stringify(row);
    for (const raw of ['15550004321', 'Familyname', '919800001111', 'pa']) expect(json).not.toContain(`"${raw}"`);
    expect(json).not.toContain('Familyname');
  });
  it('a sandbox transfer is flagged test; a completed refund shows its refund time', () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const row = toPartnerRefundRow({ ...tr, environment: 'test', refundStatus: 'completed', refundedAt: at } as Transfer, 'admin');
    expect(row.test).toBe(true);
    expect(row.at).toBe(at);
    expect(row.controls).toEqual(NONE);
  });
});
