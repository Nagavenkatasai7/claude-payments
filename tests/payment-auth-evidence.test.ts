import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PAY_OTP_IP_INFO, PAY_OTP_UA_INFO, PAY_PAYLOAD_INFO, PAYLOAD_HASH_VERSION,
  buildPaymentAuthEvidence, payEvidenceHash, payloadHashFor,
} from '@/lib/payment-auth-evidence';
import { stableJson } from '@/lib/ai-provenance';

// Fix pack 4 (C6): keyed IP / UA / payload hashes for the pay step's evidence.
// A fixed test master key, never a real one.
const KEY = Buffer.alloc(32, 7).toString('hex');
const OTHER_KEY = Buffer.alloc(32, 9).toString('hex');
const NOW = Date.now();

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

const ROW = {
  id: 'tx_vector_0001',
  amountSource: 100,
  feeSource: 5,
  totalChargeSource: 105,
  sourceCurrency: 'USD',
  amountInr: 8350.5,
  destinationCurrency: 'INR',
  fxRate: 83.505,
  recipientName: 'Priya Sharma',
  payoutDestination: '****1234',
} as const;

describe('payEvidenceHash', () => {
  it('32 lowercase hex, deterministic, different for the IP and UA infos and for another master key', () => {
    const a = payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, KEY);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, KEY)).toBe(a);
    expect(payEvidenceHash('203.0.113.9', PAY_OTP_UA_INFO, KEY)).not.toBe(a);
    expect(payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, OTHER_KEY)).not.toBe(a);
  });

  it('null for an undefined, empty or undecodable master key and for an empty value; never throws', () => {
    expect(payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, undefined)).toBeNull();
    expect(payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, '')).toBeNull();
    expect(payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, 'not-a-key')).toBeNull();
    expect(payEvidenceHash('', PAY_OTP_IP_INFO, KEY)).toBeNull();
  });
});

describe('buildPaymentAuthEvidence', () => {
  it('maps the verify result: channel, issuedAt, attempt, verifiedAt = now, surface and routeId as given', () => {
    const issuedAt = NOW - 60_000;
    const ev = buildPaymentAuthEvidence({
      otp: { ok: true, issuedAt, attempt: 2, channel: 'tg' },
      headers: headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'UA/1' }),
      surface: 'link', routeId: 'pl_abc', now: NOW, masterRaw: KEY,
    });
    expect(ev).toEqual({
      surface: 'link', routeId: 'pl_abc', channel: 'tg', issuedAt, verifiedAt: NOW, attempt: 2,
      ipHash: payEvidenceHash('203.0.113.9', PAY_OTP_IP_INFO, KEY),
      uaHash: payEvidenceHash('UA/1', PAY_OTP_UA_INFO, KEY),
    });
  });

  it('a legacy { ok: true } verify result gives channel, issuedAt and attempt null', () => {
    const ev = buildPaymentAuthEvidence({ otp: { ok: true }, headers: headers({}), surface: 'transfer', routeId: 'tx_1', now: NOW, masterRaw: KEY });
    expect(ev.channel).toBeNull();
    expect(ev.issuedAt).toBeNull();
    expect(ev.attempt).toBeNull();
  });

  it("ipHash is null for x-forwarded-for absent (clientIpFrom 'unknown') and uses the FIRST forwarded entry", () => {
    const none = buildPaymentAuthEvidence({ otp: { ok: true }, headers: headers({}), surface: 'b2b', routeId: 'inv_1', now: NOW, masterRaw: KEY });
    expect(none.ipHash).toBeNull();
    const fwd = buildPaymentAuthEvidence({
      otp: { ok: true }, headers: headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }),
      surface: 'b2b', routeId: 'inv_1', now: NOW, masterRaw: KEY,
    });
    expect(fwd.ipHash).toBe(payEvidenceHash('198.51.100.7', PAY_OTP_IP_INFO, KEY));
  });

  it('uaHash is null without a user-agent; a 600-char UA hashes equal to its first 512 chars', () => {
    const none = buildPaymentAuthEvidence({ otp: { ok: true }, headers: headers({}), surface: 'transfer', routeId: 'tx_1', now: NOW, masterRaw: KEY });
    expect(none.uaHash).toBeNull();
    const long = 'a'.repeat(512) + 'b'.repeat(88);
    const ev = buildPaymentAuthEvidence({ otp: { ok: true }, headers: headers({ 'user-agent': long }), surface: 'transfer', routeId: 'tx_1', now: NOW, masterRaw: KEY });
    expect(ev.uaHash).toBe(payEvidenceHash('a'.repeat(512), PAY_OTP_UA_INFO, KEY));
  });

  it('a header read that throws gives ipHash and uaHash null, never a throw (fix pack 4 T9: the evidence never blocks a payment)', () => {
    const broken = { get: () => { throw new Error('header read failed'); } } as unknown as Headers;
    const ev = buildPaymentAuthEvidence({ otp: { ok: true, issuedAt: NOW, attempt: 1, channel: 'wa' }, headers: broken, surface: 'transfer', routeId: 'tx_1', now: NOW, masterRaw: KEY });
    expect(ev).toMatchObject({ channel: 'wa', issuedAt: NOW, attempt: 1, ipHash: null, uaHash: null });
  });

  it('the evidence holds no raw IP or UA', () => {
    const ev = buildPaymentAuthEvidence({
      otp: { ok: true, issuedAt: NOW, attempt: 1, channel: 'wa' },
      headers: headers({ 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0 SecretBrowser' }),
      surface: 'transfer', routeId: 'tx_1', now: NOW, masterRaw: KEY,
    });
    const s = JSON.stringify(ev);
    expect(s).not.toContain('203.0.113.9');
    expect(s).not.toContain('SecretBrowser');
    expect(ev.ipHash).not.toBeNull();
    expect(ev.uaHash).not.toBeNull();
  });
});

describe('payloadHashFor', () => {
  it("'ph1:' + 64 hex; equal for the same figures in any object key order; changes when an amount, the rate, the recipient name, the masked last4 or the master key changes", () => {
    const h = payloadHashFor(ROW, KEY);
    expect(PAYLOAD_HASH_VERSION).toBe('ph1');
    expect(h).toMatch(/^ph1:[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(ROW).reverse()) as unknown as typeof ROW;
    expect(payloadHashFor(reordered, KEY)).toBe(h);
    for (const change of [
      { amountSource: 101 }, { feeSource: 6 }, { totalChargeSource: 106 }, { amountInr: 8350.6 },
      { fxRate: 83.6 }, { recipientName: 'Priya S' }, { payoutDestination: '****9999' },
    ]) {
      expect(payloadHashFor({ ...ROW, ...change }, KEY), JSON.stringify(change)).not.toBe(h);
    }
    expect(payloadHashFor(ROW, OTHER_KEY)).not.toBe(h);
  });

  it('payloadHashFor pinned vector', () => {
    expect(PAY_PAYLOAD_INFO).toBe('smartremit/pay-payload/v1');
    expect(payloadHashFor(ROW, KEY)).toBe('ph1:e320ca109b2401d94672bbfa7e2f070a453e5c0d27d25d51fe4548f6a02630c1');
  });

  it('payloadHashFor is KEYED: null with no / an undecodable key, never throws; sha256 of the same JSON without the key is NOT equal', () => {
    expect(payloadHashFor(ROW, '')).toBeNull();
    expect(payloadHashFor(ROW, 'not-a-key')).toBeNull();
    const plain = createHash('sha256').update(stableJson({
      v: 1, id: ROW.id, amountSource: ROW.amountSource, feeSource: ROW.feeSource, totalChargeSource: ROW.totalChargeSource,
      sourceCurrency: ROW.sourceCurrency, amountDest: ROW.amountInr, destinationCurrency: ROW.destinationCurrency,
      fxRate: ROW.fxRate, recipientName: ROW.recipientName, payoutLast4: '1234',
    })).digest('hex');
    expect(payloadHashFor(ROW, KEY)).not.toBe(`ph1:${plain}`);
  });

  it("payloadHashFor uses the last 4 of the MASKED destination ('****1234' -> '1234'; '' -> '') and its output contains neither the name nor the last4", () => {
    // Same last 4 behind a different mask prefix: the hash only sees the last 4.
    expect(payloadHashFor({ ...ROW, payoutDestination: 'xx1234' }, KEY)).toBe(payloadHashFor(ROW, KEY));
    const empty = payloadHashFor({ ...ROW, payoutDestination: '' }, KEY);
    expect(empty).toMatch(/^ph1:[0-9a-f]{64}$/);
    expect(empty).not.toBe(payloadHashFor(ROW, KEY));
    const h = payloadHashFor(ROW, KEY) ?? '';
    expect(h).not.toContain('Priya');
    expect(h.slice(4)).not.toContain('1234');
  });
});
