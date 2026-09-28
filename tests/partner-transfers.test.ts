import { describe, it, expect } from 'vitest';
import {
  TRANSFER_STATUSES,
  PARTNER_TRANSFERS_PAGE_SIZE,
  parseTransferFilters,
  encodeTransferCursor,
  decodeTransferCursor,
  maskRecipientName,
  maskRef,
  transferTimeline,
  holdReasonKeys,
  isHeld,
  fundingView,
  fundingEventView,
  settlementView,
  isPartnerNoteShaped,
  transfersListHref,
} from '@/lib/partner-transfers';
import { POSSIBLE_MATCH_REASON, SENDER_WATCHLIST_REASON } from '@/lib/compliance-config';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { t } from '@/lib/i18n';
import type { Transfer, TransferStatus } from '@/lib/types';

// UI redesign M3-5, Task 5.1: the pure helpers behind /partner/transfers. No I/O here.

const base = (o: Partial<Transfer> = {}): Transfer => ({
  id: 'tr_abc123',
  phone: '14155550101',
  amountUsd: 100,
  feeUsd: 2,
  totalChargeUsd: 102,
  fxRate: 85,
  amountInr: 8500,
  recipientName: 'Testname Samplesurname',
  recipientPhone: '919000000001',
  payoutMethod: 'bank',
  payoutDestination: '****2222',
  fundingMethod: 'bank_transfer',
  complianceStatus: 'cleared',
  complianceReasons: [],
  status: 'paid',
  createdAt: '2026-09-01T10:00:00.000Z',
  sourceCountry: 'US',
  sourceCurrency: 'USD',
  destinationCountry: 'IN',
  destinationCurrency: 'INR',
  partnerId: 'pa',
  amountSource: 100,
  feeSource: 2,
  totalChargeSource: 102,
  environment: 'live',
  ...o,
});

describe('TRANSFER_STATUSES', () => {
  it('is exactly the TransferStatus union (pinned both ways)', () => {
    // Compile-time: every union member is a key here, and every key is a union member.
    const all: Record<TransferStatus, true> = {
      awaiting_payment: true,
      paid: true,
      in_review: true,
      delivered: true,
      cancelled: true,
      blocked: true,
    };
    expect([...TRANSFER_STATUSES].sort()).toEqual(Object.keys(all).sort());
  });
});

describe('parseTransferFilters', () => {
  it('keeps an allowlisted status', () => {
    expect(parseTransferFilters({ status: 'in_review' }).status).toBe('in_review');
  });
  it('drops an unknown status (closed set)', () => {
    expect(parseTransferFilters({ status: 'DROP TABLE' }).status).toBeUndefined();
    expect(parseTransferFilters({ status: ['paid', 'x'] }).status).toBeUndefined();
  });
  it('drops a q that is not an id shape (literal, no operators, no names)', () => {
    expect(parseTransferFilters({ q: "abc' OR 1=1" }).q).toBeUndefined();
    expect(parseTransferFilters({ q: '50%_' }).q).toBeUndefined();
    expect(parseTransferFilters({ q: 'Testname Samplesurname' }).q).toBeUndefined();
    expect(parseTransferFilters({ q: '  tr_abc-123  ' }).q).toBe('tr_abc-123');
  });
  it('trims q to 64 characters before the shape check', () => {
    expect(parseTransferFilters({ q: 'a'.repeat(80) }).q).toBe('a'.repeat(64));
  });
  it('never accepts a phone number as a search (no PII in URLs)', () => {
    expect(parseTransferFilters({ q: '+14155550101' }).q).toBeUndefined();
    expect(parseTransferFilters({ q: '14155550101' }).q).toBeUndefined();
  });
  it('environment defaults to live; only live|test', () => {
    expect(parseTransferFilters({}).environment).toBe('live');
    expect(parseTransferFilters({ environment: 'test' }).environment).toBe('test');
    expect(parseTransferFilters({ environment: 'x' }).environment).toBe('live');
  });
  it('ignores a partnerId / partner param entirely', () => {
    const f = parseTransferFilters({ partnerId: 'pb', partner: 'pb' });
    expect(JSON.stringify(f)).not.toContain('pb');
  });
  it('decodes only a well-formed cursor token', () => {
    const tok = encodeTransferCursor('2026-09-01T10:00:00.000Z|tr_abc123');
    expect(parseTransferFilters({ cursor: tok }).cursor).toBe('2026-09-01T10:00:00.000Z|tr_abc123');
    expect(parseTransferFilters({ cursor: 'not base64!' }).cursor).toBeUndefined();
    expect(parseTransferFilters({ cursor: encodeTransferCursor("x|' OR 1=1") }).cursor).toBeUndefined();
    expect(decodeTransferCursor('A'.repeat(500))).toBeUndefined();
    expect(decodeTransferCursor(encodeTransferCursor('+275760-09-13T00:00:00.000Z|x'))).toBeUndefined();
    expect(decodeTransferCursor(encodeTransferCursor('not-a-date-at-all|x'))).toBeUndefined();
  });
  it('the page size is bounded', () => {
    expect(PARTNER_TRANSFERS_PAGE_SIZE).toBeGreaterThan(0);
    expect(PARTNER_TRANSFERS_PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});

describe('transfersListHref', () => {
  it('builds a static path with only the known filters (never a tenant)', () => {
    expect(transfersListHref({ environment: 'live' })).toBe('/partner/transfers');
    expect(transfersListHref({ environment: 'test', status: 'in_review', cursor: 'c|x' })).toBe(
      `/partner/transfers?status=in_review&environment=test&cursor=${encodeTransferCursor('c|x')}`,
    );
  });
});

describe('maskRecipientName', () => {
  it('first word plus the initial of the last word', () => {
    expect(maskRecipientName('Testname Samplesurname')).toBe('Testname S.');
    expect(maskRecipientName('  Testname  Middle   Samplesurname ')).toBe('Testname S.');
  });
  it('a single word keeps one character plus an ellipsis', () => {
    expect(maskRecipientName('Testname')).toBe('T…');
  });
  it('an empty name is a dash', () => {
    expect(maskRecipientName('   ')).toBe('—');
  });
});

describe('maskRef', () => {
  it('shows only the last 4 characters', () => {
    expect(maskRef('pi_3Qabcdef1234WXYZ')).toBe('****WXYZ');
    expect(maskRef('ab')).toBe('****');
    expect(maskRef(undefined)).toBeUndefined();
  });
});

describe('transferTimeline', () => {
  const tenant = new Set(['pa-agent']);
  it('sorts ascending, includes the ledger timestamps, a note row with its text, and masks a platform actor', () => {
    const tr = base({ status: 'delivered', paidAt: '2026-09-01T10:05:00.000Z', deliveredAt: '2026-09-01T12:00:00.000Z' });
    const rows = transferTimeline(
      tr,
      [
        { at: new Date('2026-09-01T11:00:00.000Z'), action: 'transfer.release', actor: 'platform-ops', actorType: 'staff', meta: { reason: 'secret' } },
        { at: new Date('2026-09-01T10:30:00.000Z'), action: 'transfer.hold.note', actor: 'pa-agent', actorType: 'staff', meta: { note: 'Called the sender.', actorScope: 'partner' } },
      ],
      tenant,
    );
    expect(rows.map((r) => r.kind)).toEqual(['created', 'paid', 'note', 'release', 'delivered']);
    const note = rows.find((r) => r.kind === 'note')!;
    expect(note.note).toBe('Called the sender.');
    expect(note.by).toBe('pa-agent');
    const release = rows.find((r) => r.kind === 'release')!;
    expect(release.by).toBe(t('partner.transfers.actor.smartremit'));
    // A release reason is never surfaced (only hold notes carry text).
    expect(JSON.stringify(rows)).not.toContain('secret');
    expect(JSON.stringify(rows)).not.toContain('platform-ops');
  });
  it('masks system and api_key actors, and ignores actions outside the allowlist', () => {
    const rows = transferTimeline(
      base({ status: 'awaiting_payment' }),
      [
        { at: new Date('2026-09-01T10:01:00.000Z'), action: 'transfer.hold.note', actor: 'sys', actorType: 'system', meta: { note: 'n1' } },
        { at: new Date('2026-09-01T10:02:00.000Z'), action: 'transfer.hold.note', actor: 'key_1', actorType: 'api_key', meta: { note: 'n2' } },
        { at: new Date('2026-09-01T10:03:00.000Z'), action: 'sanctions.screen', actor: 'sys', actorType: 'system', meta: { evidence: 'x' } },
      ],
      tenant,
    );
    expect(rows.map((r) => r.by)).toEqual([undefined, t('partner.transfers.actor.system'), t('partner.transfers.actor.apiKey')]);
    expect(JSON.stringify(rows)).not.toContain('evidence');
  });
  it('shows note text only for a partner-scoped note by a tenant user (never platform free text)', () => {
    const rows = transferTimeline(
      base({ status: 'awaiting_payment' }),
      [
        { at: new Date('2026-09-01T10:01:00.000Z'), action: 'transfer.hold.note', actor: 'platform-ops', actorType: 'staff', meta: { note: 'PLATFORM TEXT', actorScope: 'partner' } },
        { at: new Date('2026-09-01T10:02:00.000Z'), action: 'transfer.hold.note', actor: 'pa-agent', actorType: 'staff', meta: { note: 'NO SCOPE' } },
      ],
      tenant,
    );
    expect(JSON.stringify(rows)).not.toContain('PLATFORM TEXT');
    expect(JSON.stringify(rows)).not.toContain('NO SCOPE');
  });
  it('a completed refund adds a refunded row; a malformed note is dropped to no text', () => {
    const rows = transferTimeline(
      base({ status: 'cancelled', refundStatus: 'completed', refundedAt: '2026-09-02T10:00:00.000Z' }),
      [{ at: new Date('2026-09-01T10:01:00.000Z'), action: 'transfer.hold.note', actor: 'pa-agent', actorType: 'staff', meta: { note: 42 } }],
      tenant,
    );
    expect(rows.map((r) => r.kind)).toEqual(['created', 'note', 'refunded']);
    expect(rows[1].note).toBeUndefined();
  });
});

describe('holds', () => {
  it('isHeld: a flagged transfer stops being held once released or finished', () => {
    // markPaidIfInReview never clears complianceStatus, so 'flagged' outlives the hold.
    expect(isHeld(base({ status: 'awaiting_payment', complianceStatus: 'flagged' }))).toBe(true);
    for (const status of ['paid', 'delivered', 'cancelled'] as const) {
      expect(isHeld(base({ status, complianceStatus: 'flagged' })), status).toBe(false);
    }
  });
  it('isHeld: in_review, or a flagged/blocked compliance status', () => {
    expect(isHeld(base({ status: 'in_review' }))).toBe(true);
    expect(isHeld(base({ status: 'awaiting_payment', complianceStatus: 'flagged' }))).toBe(true);
    expect(isHeld(base({ status: 'blocked', complianceStatus: 'blocked' }))).toBe(true);
    expect(isHeld(base({ status: 'delivered' }))).toBe(false);
  });
  it('holdReasonKeys: known constants map to labels; unknown free text never renders', () => {
    const keys = holdReasonKeys([POSSIBLE_MATCH_REASON, 'Large transfer amount.', AML_HOLD_REASON, 'edd_required', 'Free text with Samplesurname', 'another unknown']);
    expect(keys).toEqual([
      'partner.transfers.reason.screening',
      'partner.transfers.reason.large',
      'partner.transfers.reason.additional',
      'partner.transfers.reason.edd',
      'partner.transfers.reason.other',
    ]);
    expect(holdReasonKeys([SENDER_WATCHLIST_REASON])).toEqual(['partner.transfers.reason.screening']);
  });
});

describe('H5: funding + settlement views (existing columns only)', () => {
  it('fundingView: method, provider, state and a masked intent ref', () => {
    const v = fundingView(base({ fundingMethod: 'ach_pull', fundingProvider: 'stripe', fundingState: 'pending', fundingIntentRef: 'pi_3QabcdefWXYZ' }));
    expect(v.method).toBe('partner.transfers.funding.method.ach_pull');
    expect(v.provider).toBe('Stripe');
    expect(v.state).toBe('partner.transfers.funding.state.pending');
    expect(v.ref).toBe('****WXYZ');
    expect(JSON.stringify(v)).not.toContain('pi_3Qabcdef');
  });
  it('fundingView: a row with no async debit has no state and falls back to the charge ref', () => {
    const v = fundingView(base({ fundingRef: 'ch_ABCD1234' }));
    expect(v.state).toBeUndefined();
    expect(v.provider).toBeUndefined();
    expect(v.ref).toBe('****1234');
  });
  it('fundingEventView: allowlisted type + outcome, masked event id', () => {
    const e = fundingEventView({ eventType: 'payment_intent.succeeded', outcome: 'funded', eventId: 'evt_1ABCDEF9876', receivedAt: new Date('2026-09-01T10:00:00Z') });
    expect(e.type).toBe('partner.transfers.funding.event.succeeded');
    expect(e.outcome).toBe('partner.transfers.funding.outcome.funded');
    expect(e.ref).toBe('****9876');
    const odd = fundingEventView({ eventType: 'weird.<script>', outcome: 'odd', eventId: 'x', receivedAt: new Date() });
    expect(odd.type).toBe('partner.transfers.funding.event.other');
    expect(odd.outcome).toBe('partner.transfers.funding.outcome.other');
  });
  const row = (status: string, createdAt = '2026-09-01T10:00:00Z', attempts = 0) => ({ status, attempts, createdAt: new Date(createdAt) });
  it('settlementView: a sandbox transfer is never sent to a rail', () => {
    expect(settlementView(base({ environment: 'test' }), [row('done')]).state).toBe('partner.transfers.settlement.sandbox');
  });
  it('settlementView: a cancelled transfer is never "accepted", even with a rail reference and a done row', () => {
    // The rail accepted (setProviderRef) and later failed (failPaidFromRail → cancelled, refund pending).
    const v = settlementView(base({ status: 'cancelled', paymentProviderRef: 'rail-settle-00001234' }), [row('done')]);
    expect(v.state).toBe('partner.transfers.settlement.notCompleted');
    expect(settlementView(base({ status: 'blocked' }), [row('done')]).state).toBe('partner.transfers.settlement.notCompleted');
  });
  it('settlementView: a mock rail reference is shown as simulated, not as a real rail', () => {
    expect(settlementView(base({ paymentProviderRef: 'mock-tr_abc123' }), [row('done')]).state).toBe('partner.transfers.settlement.simulated');
  });
  it('settlementView: delivered is settled', () => {
    expect(settlementView(base({ status: 'delivered' }), []).state).toBe('partner.transfers.settlement.settled');
  });
  it('settlementView: no instruction row is "not started"', () => {
    expect(settlementView(base({ status: 'awaiting_payment' }), []).state).toBe('partner.transfers.settlement.notStarted');
  });
  it('settlementView: follows the LATEST rail row', () => {
    expect(settlementView(base(), [row('dead', '2026-09-01T10:00:00Z'), row('pending', '2026-09-01T11:00:00Z')]).state).toBe(
      'partner.transfers.settlement.queued',
    );
    expect(settlementView(base(), [row('processing')]).state).toBe('partner.transfers.settlement.sending');
    expect(settlementView(base(), [row('failed', undefined, 3)]).state).toBe('partner.transfers.settlement.retrying');
    expect(settlementView(base(), [row('failed', undefined, 3)]).attempts).toBe(3);
    expect(settlementView(base(), [row('dead')]).state).toBe('partner.transfers.settlement.attention');
  });
  it('settlementView: done is "accepted" only with a rail reference (masked); otherwise "processed"', () => {
    const acc = settlementView(base({ paymentProviderRef: 'rail-settle-00001234' }), [row('done')]);
    expect(acc.state).toBe('partner.transfers.settlement.accepted');
    expect(acc.ref).toBe('****1234');
    expect(settlementView(base(), [row('done')]).state).toBe('partner.transfers.settlement.processed');
  });
});

describe('isPartnerNoteShaped', () => {
  it('refuses a note carrying a phone- or account-length digit run (spaces, dots and dashes ignored)', () => {
    expect(isPartnerNoteShaped('Sender confirmed by call.')).toBe(true);
    expect(isPartnerNoteShaped('Ref 123456789 checked')).toBe(true);
    expect(isPartnerNoteShaped('Call +1 415 555 0101')).toBe(false);
    expect(isPartnerNoteShaped('acct 0000-1111-2222')).toBe(false);
    expect(isPartnerNoteShaped('4155550101')).toBe(false);
    expect(isPartnerNoteShaped('12345/67890')).toBe(false);
    expect(isPartnerNoteShaped('12345,67890')).toBe(false);
    expect(isPartnerNoteShaped('12345_67890')).toBe(false);
    expect(isPartnerNoteShaped('\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660')).toBe(false);
    expect(isPartnerNoteShaped('Two refs: 12345 and 67890 checked')).toBe(true);
  });
});
