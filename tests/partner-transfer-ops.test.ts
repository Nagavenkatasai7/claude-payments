import { describe, it, expect } from 'vitest';
import {
  REVEALABLE_TRANSFER_FIELDS,
  assigneeView,
  cancelRefusalKey,
  complianceViewKey,
  isRevealableTransferField,
  issueRefundEligibility,
  paylinkDedupeKey,
  resendEligibility,
  settlementRouteKey,
  transferOpsFor,
} from '@/lib/partner-transfer-ops';
import { CANCEL_REFUSAL } from '@/lib/dashboard-cancel-policy';
import { revealClassOf } from '@/lib/partner-reveal-policy';
import { t } from '@/lib/i18n';
import type { Staff, Transfer } from '@/lib/types';

// Lost-features restore p1: the pure rules behind the /partner transfer actions and columns. The
// page shows buttons from transferOpsFor; every action re-checks on the server.

const tr = (o: Partial<Transfer> = {}): Transfer =>
  ({
    id: 'tr_1',
    partnerId: 'pa',
    phone: '14155550101',
    status: 'paid',
    complianceStatus: 'cleared',
    complianceReasons: [],
    fundingMethod: 'credit_card',
    environment: 'live',
    refundStatus: 'none',
    ...o,
  }) as Transfer;

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const staff = (role: Staff['role'], p: Partial<typeof perms> = {}): Staff =>
  ({ username: 'u', name: 'U', role, partnerId: 'pa', permissions: { ...perms, ...p }, passwordHash: 'x', createdAt: '' }) as Staff;

describe('complianceViewKey', () => {
  it('closed labels only: clear, held, blocked, reviewed', () => {
    expect(complianceViewKey(tr())).toBe('partner.transfers.compliance.clear');
    expect(complianceViewKey(tr({ status: 'in_review', complianceStatus: 'flagged' }))).toBe('partner.transfers.compliance.held');
    expect(complianceViewKey(tr({ status: 'blocked', complianceStatus: 'blocked' }))).toBe('partner.transfers.compliance.blocked');
    expect(complianceViewKey(tr({ status: 'awaiting_payment', complianceStatus: 'blocked' }))).toBe('partner.transfers.compliance.blocked');
    expect(complianceViewKey(tr({ status: 'paid', complianceStatus: 'flagged' }))).toBe('partner.transfers.compliance.reviewed');
    for (const k of ['clear', 'held', 'blocked', 'reviewed']) expect(t(`partner.transfers.compliance.${k}` as never)).not.toContain('partner.');
  });
});

describe('settlementRouteKey', () => {
  it('own rail, a network partner (never named), or sandbox', () => {
    expect(settlementRouteKey(tr(), 'pa')).toBe('partner.transfers.settledVia.own');
    expect(settlementRouteKey(tr({ settlementPartnerId: 'pa' }), 'pa')).toBe('partner.transfers.settledVia.own');
    expect(settlementRouteKey(tr({ settlementPartnerId: 'pz' }), 'pa')).toBe('partner.transfers.settledVia.network');
    expect(settlementRouteKey(tr({ environment: 'test', settlementPartnerId: 'pz' }), 'pa')).toBe('partner.transfers.settledVia.sandbox');
  });
});

describe('assigneeView', () => {
  it('a tenant member by username; anyone else is SmartRemit; none is unassigned', () => {
    const tenant = new Set(['pa-agent']);
    expect(assigneeView('pa-agent', tenant)).toEqual({ kind: 'tenant', username: 'pa-agent' });
    expect(assigneeView('platform-ops', tenant)).toEqual({ kind: 'smartremit' });
    expect(assigneeView(undefined, tenant)).toEqual({ kind: 'none' });
    expect(assigneeView('', tenant)).toEqual({ kind: 'none' });
  });
});

describe('REVEALABLE_TRANSFER_FIELDS', () => {
  it('sender name and phone, recipient name and phone (identity), the destination (destination class)', () => {
    expect([...REVEALABLE_TRANSFER_FIELDS].sort()).toEqual(['full_name', 'payout_destination', 'phone', 'recipient_name', 'recipient_phone']);
    for (const f of REVEALABLE_TRANSFER_FIELDS) expect(revealClassOf(f)).not.toBeNull();
    expect(revealClassOf('payout_destination')).toBe('destination');
    expect(isRevealableTransferField('recipient_name')).toBe(true);
    expect(isRevealableTransferField('date_of_birth')).toBe(false);
    expect(isRevealableTransferField('admin_note')).toBe(false);
    expect(isRevealableTransferField(1)).toBe(false);
  });
});

describe('cancelRefusalKey', () => {
  it('maps every policy refusal to translated copy (the English strings never reach /partner)', () => {
    expect(cancelRefusalKey(CANCEL_REFUSAL.paid)).toBe('partner.transferOps.cancel.refused.paid');
    expect(cancelRefusalKey(CANCEL_REFUSAL.paidPartnerPulled)).toBe('partner.transferOps.cancel.refused.paid');
    expect(cancelRefusalKey(CANCEL_REFUSAL.inReview)).toBe('partner.transferOps.cancel.refused.inReview');
    expect(cancelRefusalKey(CANCEL_REFUSAL.chargedAwaiting)).toBe('partner.transferOps.cancel.refused.charged');
    expect(cancelRefusalKey(CANCEL_REFUSAL.blocked)).toBe('partner.transferOps.cancel.refused.blocked');
    expect(cancelRefusalKey(CANCEL_REFUSAL.changed)).toBe('partner.transferOps.cancel.refused.changed');
    expect(cancelRefusalKey('anything else')).toBe('partner.transferOps.cancel.refused.changed');
  });
});

describe('paylinkDedupeKey', () => {
  it('one key per transfer per 10-minute bucket', () => {
    const base = Date.UTC(2026, 9, 3, 12, 0, 0);
    expect(paylinkDedupeKey('tr_1', base)).toBe(paylinkDedupeKey('tr_1', base + 9 * 60_000 + 59_000));
    expect(paylinkDedupeKey('tr_1', base)).not.toBe(paylinkDedupeKey('tr_1', base + 10 * 60_000));
    expect(paylinkDedupeKey('tr_1', base)).not.toBe(paylinkDedupeKey('tr_2', base));
    expect(paylinkDedupeKey('tr_1', base)).toMatch(/^paylink:tr_1:\d+$/);
  });
});

describe('resendEligibility', () => {
  it('only a live, uncharged awaiting_payment transfer', () => {
    expect(resendEligibility(tr({ status: 'awaiting_payment' }))).toBe('ok');
    expect(resendEligibility(tr({ status: 'paid' }))).toBe('wrongStatus');
    expect(resendEligibility(tr({ status: 'awaiting_payment', environment: 'test' }))).toBe('sandbox');
    expect(resendEligibility(tr({ status: 'awaiting_payment', fundingRef: 'x' }))).toBe('charged');
    expect(resendEligibility(tr({ status: 'awaiting_payment', fundingIntentRef: 'pi_x' }))).toBe('charged');
  });
});

describe('issueRefundEligibility (BL-2: a transfer another partner pays out is refused in every status)', () => {
  it('ok for a charged, live, paid or delivered transfer on the owner\'s own rail', () => {
    expect(issueRefundEligibility(tr({ fundingRef: 'ch_1' }), 'pa')).toBe('ok');
    expect(issueRefundEligibility(tr({ status: 'delivered', fundingRef: 'ch_1' }), 'pa')).toBe('ok');
    expect(issueRefundEligibility(tr({ fundingRef: 'ch_1', settlementPartnerId: 'pa' }), 'pa')).toBe('ok');
  });
  it('routed to another partner: refused whatever the status', () => {
    for (const status of ['paid', 'delivered', 'awaiting_payment', 'in_review'] as const) {
      expect(issueRefundEligibility(tr({ status, fundingRef: 'ch_1', settlementPartnerId: 'pz' }), 'pa')).toBe('routed');
    }
  });
  it('each other refusal', () => {
    expect(issueRefundEligibility(tr({ status: 'awaiting_payment', fundingRef: 'ch_1' }), 'pa')).toBe('wrongStatus');
    expect(issueRefundEligibility(tr({ status: 'cancelled', fundingRef: 'ch_1' }), 'pa')).toBe('wrongStatus');
    expect(issueRefundEligibility(tr(), 'pa')).toBe('notCharged');
    expect(issueRefundEligibility(tr({ fundingRef: 'ch_1', refundStatus: 'requested' }), 'pa')).toBe('already');
    expect(issueRefundEligibility(tr({ fundingRef: 'ch_1', refundStatus: 'failed' }), 'pa')).toBe('already');
    expect(issueRefundEligibility(tr({ fundingRef: 'ch_1', environment: 'test' }), 'pa')).toBe('sandbox');
  });
});

describe('transferOpsFor (UX only; each action re-checks)', () => {
  const awaiting = tr({ status: 'awaiting_payment' });
  it('admin: every op the transfer allows', () => {
    expect(transferOpsFor(awaiting, { role: 'admin', staff: staff('admin'), partnerId: 'pa' })).toEqual({
      cancel: true,
      assign: true,
      resend: true,
      refund: false,
    });
    expect(transferOpsFor(tr({ fundingRef: 'ch_1' }), { role: 'admin', staff: staff('admin'), partnerId: 'pa' })).toEqual({
      cancel: false,
      assign: true,
      resend: false,
      refund: true,
    });
  });
  it('agent: only with each per-staff flag; never refund', () => {
    expect(transferOpsFor(awaiting, { role: 'agent', staff: staff('agent'), partnerId: 'pa' })).toEqual({
      cancel: false,
      assign: false,
      resend: false,
      refund: false,
    });
    const flagged = staff('agent', { canCancel: true, canAssign: true, canResend: true });
    expect(transferOpsFor(awaiting, { role: 'agent', staff: flagged, partnerId: 'pa' })).toEqual({
      cancel: true,
      assign: true,
      resend: true,
      refund: false,
    });
  });
  it('support and finance: nothing, whatever their stored flags', () => {
    const all = { canCancel: true, canAssign: true, canResend: true, canRevealPii: true };
    for (const role of ['support', 'finance'] as const) {
      expect(transferOpsFor(awaiting, { role, staff: staff(role, all), partnerId: 'pa' })).toEqual({
        cancel: false,
        assign: false,
        resend: false,
        refund: false,
      });
    }
  });
});
