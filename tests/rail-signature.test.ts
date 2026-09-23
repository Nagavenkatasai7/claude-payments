import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

// Program-Fix 29: the timestamped rail signature (x-smartremit-signature).
// The legacy x-signature stays byte-identical; the new header, when present,
// decides alone.

const logWarn = vi.fn();
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: unknown[]) => logWarn(...a) };
});

import {
  RAIL_SIG_HEADER,
  RAIL_SIG_TOLERANCE_SEC,
  signRailHeaders,
  verifyRailSignature,
} from '@/lib/providers/rail-signature';
import { signBody } from '@/lib/providers/http-payment-provider';

const RAW = JSON.stringify({ reference: 'tr_1', status: 'paid_out' });
const NOW = 1_800_000_000_000; // fixed clock (ms)
const T = Math.floor(NOW / 1000);
const hmac = (s: string, m: string) => createHmac('sha256', s).update(m).digest('hex');
const ctx = { partnerId: 'acme', route: 'test' };

/** Headers from a plain record (case-insensitive get, as Fetch Headers). */
function h(rec: Record<string, string>) {
  return new Headers(rec);
}

beforeEach(() => logWarn.mockReset());

describe('signRailHeaders', () => {
  it('keeps the legacy header byte-identical (current secret only) and adds one v1 per secret', () => {
    const out = signRailHeaders(RAW, ['cur', 'prev'], NOW);
    expect(out['x-signature']).toBe(signBody(RAW, 'cur'));
    expect(out[RAIL_SIG_HEADER]).toBe(`t=${T},v1=${hmac('cur', `${T}.${RAW}`)},v1=${hmac('prev', `${T}.${RAW}`)}`);
  });

  it('empty secrets → no headers', () => {
    expect(signRailHeaders(RAW, [], NOW)).toEqual({});
  });
});

describe('verifyRailSignature', () => {
  it('FIXED VECTOR: a header computed straight from the documented recipe verifies as v2', () => {
    const header = `t=${T},v1=${hmac('cur', `${T}.${RAW}`)}`;
    const r = verifyRailSignature(RAW, h({ [RAIL_SIG_HEADER]: header }), ['cur'], NOW, ctx);
    expect(r).toEqual({ ok: true, scheme: 'v2', nonce: createHash('sha256').update(`${T}.${RAW}`).digest('hex') });
  });

  it('round trip: signRailHeaders → verify ok v2', () => {
    const r = verifyRailSignature(RAW, h(signRailHeaders(RAW, ['cur'], NOW)), ['cur'], NOW, ctx);
    expect(r.ok && r.scheme).toBe('v2');
    expect(logWarn).not.toHaveBeenCalled();
  });

  it(`rejects a timestamp outside ±${300}s (301s either way) and accepts the edge`, () => {
    expect(RAIL_SIG_TOLERANCE_SEC).toBe(300);
    const at = (t: number) => h({ [RAIL_SIG_HEADER]: `t=${t},v1=${hmac('cur', `${t}.${RAW}`)}` });
    expect(verifyRailSignature(RAW, at(T - 301), ['cur'], NOW, ctx).ok).toBe(false);
    expect(verifyRailSignature(RAW, at(T + 301), ['cur'], NOW, ctx).ok).toBe(false);
    expect(verifyRailSignature(RAW, at(T - 300), ['cur'], NOW, ctx).ok).toBe(true);
    expect(verifyRailSignature(RAW, at(T + 300), ['cur'], NOW, ctx).ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const headers = h(signRailHeaders(RAW, ['cur'], NOW));
    expect(verifyRailSignature(RAW.replace('paid_out', 'funded'), headers, ['cur'], NOW, ctx).ok).toBe(false);
  });

  it('a present-but-invalid new header with a VALID legacy header → rejected (the new header decides alone)', () => {
    const headers = h({ 'x-signature': signBody(RAW, 'cur'), [RAIL_SIG_HEADER]: `t=${T},v1=${'0'.repeat(64)}` });
    expect(verifyRailSignature(RAW, headers, ['cur'], NOW, ctx).ok).toBe(false);
    // a malformed new header is still "present"
    const bad = h({ 'x-signature': signBody(RAW, 'cur'), [RAIL_SIG_HEADER]: 'garbage' });
    expect(verifyRailSignature(RAW, bad, ['cur'], NOW, ctx).ok).toBe(false);
  });

  it('accepts a v1 made with the PREVIOUS secret; the nonce is the same whichever secret signed', () => {
    const withPrev = h({ [RAIL_SIG_HEADER]: `t=${T},v1=${hmac('prev', `${T}.${RAW}`)}` });
    const withCur = h({ [RAIL_SIG_HEADER]: `t=${T},v1=${hmac('cur', `${T}.${RAW}`)}` });
    const a = verifyRailSignature(RAW, withPrev, ['cur', 'prev'], NOW, ctx);
    const b = verifyRailSignature(RAW, withCur, ['cur', 'prev'], NOW, ctx);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok && a.scheme === 'v2' && b.scheme === 'v2') expect(a.nonce).toBe(b.nonce);
    else throw new Error('expected v2');
  });

  it('empty secrets → false for both schemes', () => {
    expect(verifyRailSignature(RAW, h(signRailHeaders(RAW, ['cur'], NOW)), [], NOW, ctx).ok).toBe(false);
    expect(verifyRailSignature(RAW, h({ 'x-signature': signBody(RAW, 'cur') }), [], NOW, ctx).ok).toBe(false);
    expect(verifyRailSignature(RAW, h({ 'x-signature': signBody(RAW, '') }), ['', ''], NOW, ctx).ok).toBe(false);
  });

  it('no headers at all → false', () => {
    expect(verifyRailSignature(RAW, h({}), ['cur'], NOW, ctx).ok).toBe(false);
  });

  it('legacy-only (current or previous secret) → scheme legacy, with a deprecation log that names the partner', () => {
    const r = verifyRailSignature(RAW, h({ 'x-signature': signBody(RAW, 'prev') }), ['cur', 'prev'], NOW, ctx);
    expect(r).toEqual({ ok: true, scheme: 'legacy' });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][0]).toBe('rail-sig.legacy');
    expect(logWarn.mock.calls[0][2]).toMatchObject({ partnerId: 'acme', route: 'test' });
  });

  it('a request sent with both headers still verifies as legacy when only x-signature arrives (documented residual, see the fix-29 brief)', () => {
    const sent = signRailHeaders(RAW, ['cur'], NOW);
    const r = verifyRailSignature(RAW, h({ 'x-signature': sent['x-signature'] }), ['cur'], NOW, ctx);
    expect(r).toEqual({ ok: true, scheme: 'legacy' });
    expect(logWarn.mock.calls[0][2]).toMatchObject({ partnerId: 'acme' });
  });
});
