import { describe, it, expect } from 'vitest';
import { certifiedLiveControls } from './helpers-live';

// Fix pack 7 T2 (DP1): isLiveCertified and hasStandingCertification moved to the
// client-safe live-certified.ts; live-gate.ts re-exports the SAME functions. The
// full cases stay in tests/live-gate.test.ts.

describe('live-certified', () => {
  it('the live-gate exports ARE the live-certified functions', async () => {
    const gate = await import('@/lib/live-gate');
    const certified = await import('@/lib/live-certified');
    expect(gate.isLiveCertified).toBe(certified.isLiveCertified);
    expect(gate.hasStandingCertification).toBe(certified.hasStandingCertification);
  });

  it('smoke: certified -> true, revoked -> false', async () => {
    const { isLiveCertified, hasStandingCertification } = await import('@/lib/live-certified');
    const lc = certifiedLiveControls();
    expect(isLiveCertified({ id: 'acme', status: 'active', liveControls: lc })).toBe(true);
    expect(hasStandingCertification(lc)).toBe(true);
    const revoked = { ...lc, certification: { ...lc.certification!, revokedAt: lc.certification!.certifiedAt } };
    expect(isLiveCertified({ id: 'acme', status: 'active', liveControls: revoked })).toBe(false);
    expect(hasStandingCertification(revoked)).toBe(false);
  });
});
