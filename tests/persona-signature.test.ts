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

  // Program-Fix 35: during a secret rotation Persona sends TWO space-separated
  // `t=…,v1=…` sets (https://docs.withpersona.com/webhooks-best-practices).
  describe('secret rotation: space-separated signature sets', () => {
    const NEW = 'wbhsec_new';

    it('two sets, only set 1\'s secret configured → true', () => {
      const header = `t=${t},v1=${sign(t, SECRET)} t=${t},v1=${sign(t, NEW)}`;
      expect(verifyPersonaSignature(body, header, [SECRET], now)).toBe(true);
    });

    it('two sets, only set 2\'s secret configured → true', () => {
      const header = `t=${t},v1=${sign(t, SECRET)} t=${t},v1=${sign(t, NEW)}`;
      expect(verifyPersonaSignature(body, header, [NEW], now)).toBe(true);
    });

    it('set 2 garbage → still true via set 1', () => {
      const header = `t=${t},v1=${sign(t, SECRET)} t=garbage,v1`;
      expect(verifyPersonaSignature(body, header, [SECRET], now)).toBe(true);
    });

    it('set 1 stale t, set 2 fresh and valid → true (each set uses its own t and window)', () => {
      const old = t - 10 * 60;
      const header = `t=${old},v1=${sign(old, SECRET)} t=${t},v1=${sign(t, NEW)}`;
      expect(verifyPersonaSignature(body, header, [SECRET, NEW], now)).toBe(true);
    });

    it('set 1 stale t (valid for its own t) and set 2 wrong → false', () => {
      const old = t - 10 * 60;
      const header = `t=${old},v1=${sign(old, SECRET)} t=${t},v1=${'0'.repeat(64)}`;
      expect(verifyPersonaSignature(body, header, [SECRET], now)).toBe(false);
    });

    it('a v1 is only checked against its OWN set\'s t (no cross-set mixing)', () => {
      const old = t - 10 * 60;
      // set 2 is fresh but carries set 1's stale signature: must not verify.
      const header = `t=${old},v1=${sign(old, SECRET)} t=${t},v1=${sign(old, SECRET)}`;
      expect(verifyPersonaSignature(body, header, [SECRET], now)).toBe(false);
    });

    it('no set verifies → false', () => {
      const header = `t=${t},v1=${sign(t, 'wbhsec_x')} t=${t},v1=${sign(t, 'wbhsec_y')}`;
      expect(verifyPersonaSignature(body, header, [SECRET, NEW], now)).toBe(false);
    });

    it('v1 before t inside one set, with a space after the comma, still verifies (`v1=…, t=…`)', () => {
      expect(verifyPersonaSignature(body, `v1=${sign(t, SECRET)}, t=${t}`, [SECRET], now)).toBe(true);
      expect(verifyPersonaSignature(body, `v1=${sign(t, SECRET)},t=${t}`, [SECRET], now)).toBe(true);
      // …and as the first of two rotation sets
      expect(verifyPersonaSignature(body, `v1=${sign(t, SECRET)}, t=${t} t=${t},v1=${sign(t, NEW)}`, [SECRET], now)).toBe(true);
    });

    it('extra whitespace between the sets and around the header is tolerated', () => {
      const header = `  t=${t},v1=deadbeef \t  t=${t} , v1=${sign(t, NEW)}  `;
      expect(verifyPersonaSignature(body, header, [NEW], now)).toBe(true);
    });
  });
});
