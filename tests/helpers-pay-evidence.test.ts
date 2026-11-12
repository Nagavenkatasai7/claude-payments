import { describe, expect, it } from 'vitest';
import { okVerify, realMoneyPayBody, testEvidence } from './helpers-pay-evidence';
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import { parsePayBody } from '@/lib/pay-body';
import { isDisclosureAckVersion } from '@/lib/remittance-disclosure';
import { validateSenderAddress, validateSenderDob } from '@/lib/travel-rule';
import type { PaymentEvidence } from '@/lib/payment-evidence';

// Fix pack 4 T8 (C24): the pay-evidence fixtures every later pay test uses.
describe('helpers-pay-evidence (C24)', () => {
  it('okVerify() issuedAt is 60 s before now, attempt 1, channel wa', () => {
    const before = Date.now();
    const v = okVerify();
    const after = Date.now();
    expect(v.ok).toBe(true);
    expect(v.attempt).toBe(1);
    expect(v.channel).toBe('wa');
    expect(v.issuedAt).toBeGreaterThanOrEqual(before - 60_000);
    expect(v.issuedAt).toBeLessThanOrEqual(after - 60_000);
    expect(okVerify({ attempt: 3, channel: 'tg' })).toMatchObject({ ok: true, attempt: 3, channel: 'tg' });
  });

  it('realMoneyPayBody() posts DISCLOSURE_DRAFT_VERSION and a dh1 hash', () => {
    // Fix pack 5 T21a (P32): plus the sender's invented address and a DOB 40 years before now.
    const dob40 = new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    const base = { otp: '654321', disclosureVersion: DISCLOSURE_DRAFT_VERSION, accountHolder: 'Anita Legal' };
    expect(realMoneyPayBody()).toEqual({ ...base, senderAddress: '1 Fixture Road, Testtown 00000', senderDob: dob40 });
    expect(realMoneyPayBody({ originator: false })).toEqual(base);
    const hash = `dh1:${'a'.repeat(64)}`;
    const body = realMoneyPayBody({ disclosureHash: hash, otp: '111111', accountHolder: 'Ravi Kumar', senderAddress: '9 Other Way', senderDob: '1980-01-02' });
    expect(body).toEqual({
      otp: '111111', disclosureVersion: DISCLOSURE_DRAFT_VERSION, accountHolder: 'Ravi Kumar',
      senderAddress: '9 Other Way', senderDob: '1980-01-02', disclosureHash: hash,
    });
    expect(validateSenderAddress(realMoneyPayBody().senderAddress ?? '').ok).toBe(true);
    expect(validateSenderDob(realMoneyPayBody().senderDob ?? '', new Date()).ok).toBe(true);
    const parsed = parsePayBody(body, 'transfer');
    expect(parsed.disclosureVersion).toBe(DISCLOSURE_DRAFT_VERSION);
    expect(parsed.disclosureHash).toBe(hash);
    expect(parsed.accountHolder).toBe('Ravi Kumar');
    expect(parsed.senderAddress).toBe('9 Other Way');
    expect(parsed.senderDob).toBe('1980-01-02');
  });

  it('testEvidence() parses as a PaymentEvidence with ack and snapshot input', () => {
    const ev: PaymentEvidence = testEvidence({ routeId: 'tx_1' });
    expect(ev.auth).toMatchObject({ surface: 'transfer', routeId: 'tx_1', channel: 'wa', attempt: 1, ipHash: null, uaHash: null });
    expect(typeof ev.auth?.verifiedAt).toBe('number');
    expect(ev.auth?.issuedAt).toBe((ev.auth?.verifiedAt ?? 0) - 60_000);
    expect(ev.disclosureAck).toEqual({ version: DISCLOSURE_DRAFT_VERSION, shownHash: null, routeId: 'tx_1' });
    expect(isDisclosureAckVersion(ev.disclosureAck?.version)).toBe(true);
    expect(ev.disclosureSnapshot).toMatchObject({ surface: 'transfer', version: DISCLOSURE_DRAFT_VERSION, shownHash: null });
    expect(Number.isFinite(ev.disclosureSnapshot?.acknowledgedAt)).toBe(true);
    const hash = `dh1:${'b'.repeat(64)}`;
    const link = testEvidence({ routeId: 'pl_1', shownHash: hash, surface: 'link' });
    expect(link.auth?.surface).toBe('link');
    expect(link.disclosureAck?.shownHash).toBe(hash);
    expect(link.disclosureSnapshot).toMatchObject({ surface: 'link', shownHash: hash });
    const noAck = testEvidence({ routeId: 'tx_2', ack: false });
    expect(noAck.disclosureAck).toBeNull();
    expect(noAck.disclosureSnapshot).toBeNull();
    expect(noAck.auth?.routeId).toBe('tx_2');
  });
});
