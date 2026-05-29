import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';

const SECRET = 'test-secret';
const BODY = JSON.stringify({ reference: 'pay_123', status: 'paid_out' });
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts a valid HMAC-SHA256 over the raw body', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });
  it('rejects a tampered body (signature no longer matches)', () => {
    const sig = sign(BODY);
    expect(verifyWebhookSignature(BODY + 'x', sig, SECRET)).toBe(false);
  });
  it('rejects a tampered signature', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY) + '00', SECRET)).toBe(false);
  });
  it('fails closed on an empty secret', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), '')).toBe(false);
  });
  it('fails closed on an empty/garbage signature', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, 'not-hex', SECRET)).toBe(false);
  });
});
