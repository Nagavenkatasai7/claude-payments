import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '@/lib/providers/meta-signature-verify';

const SECRET = 'meta-app-secret';
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
// Meta sends "sha256=<hex>" in the X-Hub-Signature-256 header.
const sign = (body: string, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyMetaSignature', () => {
  it('accepts a valid sha256=-prefixed HMAC over the raw body', () => {
    expect(verifyMetaSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });
  it('rejects a tampered body (signature no longer matches)', () => {
    const sig = sign(BODY);
    expect(verifyMetaSignature(BODY + 'x', sig, SECRET)).toBe(false);
  });
  it('rejects a tampered signature', () => {
    expect(verifyMetaSignature(BODY, sign(BODY) + '00', SECRET)).toBe(false);
  });
  it('rejects a header missing the sha256= prefix (bare hex)', () => {
    const bareHex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyMetaSignature(BODY, bareHex, SECRET)).toBe(false);
  });
  it('fails closed on an empty secret', () => {
    expect(verifyMetaSignature(BODY, sign(BODY), '')).toBe(false);
  });
  it('fails closed on an empty header', () => {
    expect(verifyMetaSignature(BODY, '', SECRET)).toBe(false);
  });
});
