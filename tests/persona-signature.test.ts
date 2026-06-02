import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyPersonaSignature } from '@/lib/providers/persona-signature';

const SECRET = 'wbhsec_test';
const body = JSON.stringify({ data: { id: 'evt_1' } });
const sign = (t: number, secret: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('verifyPersonaSignature', () => {
  const now = 1_700_000_000_000; // ms
  const t = Math.floor(now / 1000);

  it('accepts a fresh, correctly-signed body', () => {
    expect(verifyPersonaSignature(body, `t=${t},v1=${sign(t, SECRET)}`, [SECRET], now)).toBe(true);
  });

  it('rejects a replayed (stale) timestamp beyond 5 min', () => {
    const old = t - 6 * 60;
    expect(verifyPersonaSignature(body, `t=${old},v1=${sign(old, SECRET)}`, [SECRET], now)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyPersonaSignature(body + 'x', `t=${t},v1=${sign(t, SECRET)}`, [SECRET], now)).toBe(false);
  });

  it('accepts when ANY of multiple v1 sigs matches (secret rotation)', () => {
    const header = `t=${t},v1=deadbeefdeadbeef,v1=${sign(t, SECRET)}`;
    expect(verifyPersonaSignature(body, header, ['wbhsec_other', SECRET], now)).toBe(true);
  });

  it('fail-closed on empty header or empty secrets', () => {
    expect(verifyPersonaSignature(body, '', [SECRET], now)).toBe(false);
    expect(verifyPersonaSignature(body, `t=${t},v1=${sign(t, SECRET)}`, [''], now)).toBe(false);
    expect(verifyPersonaSignature(body, `t=${t},v1=${sign(t, SECRET)}`, [], now)).toBe(false);
  });

  it('rejects a malformed header (no t= or no v1=)', () => {
    expect(verifyPersonaSignature(body, `v1=${sign(t, SECRET)}`, [SECRET], now)).toBe(false);
    expect(verifyPersonaSignature(body, `t=${t}`, [SECRET], now)).toBe(false);
    expect(verifyPersonaSignature(body, `t=notanumber,v1=${sign(t, SECRET)}`, [SECRET], now)).toBe(false);
  });

  it('tolerates whitespace around the comma-separated parts', () => {
    expect(verifyPersonaSignature(body, ` t=${t} , v1=${sign(t, SECRET)} `, [SECRET], now)).toBe(true);
  });
});
