import { describe, it, expect } from 'vitest';
import { setupView } from '@/lib/partner-setup-view';
import type { Partner } from '@/lib/types';

// Lost-features p3 B13: the read-only compliance setup summary on /partner/settings. Pure: the KYC
// mode, the verify-before-send gate, the live-rail warning and the countries. Sanctions screening
// has no switch, so the view carries none.
const partner = (o: Partial<Partner> = {}): Partner =>
  ({ id: 'ptn-a', name: 'A', status: 'active', countries: ['US', 'GB'], createdAt: '2026-01-01T00:00:00Z', ...o }) as Partner;
const rail = (providerType?: string) => ({ payment: providerType === undefined ? {} : { providerType } });

describe('setupView', () => {
  it('ours mode, gate off by default, mock rail: no warning', () => {
    expect(setupView(partner(), rail())).toEqual({
      kycMode: 'ours',
      verifyBeforeSend: false,
      liveRailWarning: false,
      countries: ['US', 'GB'],
    });
  });

  it('the warning shows only for ours + gate off + a live rail', () => {
    expect(setupView(partner(), rail('http')).liveRailWarning).toBe(true);
    expect(setupView(partner(), rail('simulator')).liveRailWarning).toBe(false);
    expect(setupView(partner({ requireKycBeforeSend: true }), rail('http')).liveRailWarning).toBe(false);
    expect(setupView(partner({ kycMode: 'delegated' }), rail('http')).liveRailWarning).toBe(false);
  });

  it('delegated mode and the gate on are reported as configured', () => {
    const v = setupView(partner({ kycMode: 'delegated', requireKycBeforeSend: true }), rail('http'));
    expect(v.kycMode).toBe('delegated');
    expect(v.verifyBeforeSend).toBe(true);
  });

  it('an unreadable integrations row hides only the warning (null), never guesses', () => {
    const v = setupView(partner(), null);
    expect(v.liveRailWarning).toBeNull();
    expect(v.kycMode).toBe('ours');
  });

  it('carries no credentials and no sanctions switch', () => {
    const v = setupView(partner(), { payment: { providerType: 'http', credentials: { settlementUrl: 'https://x.example', signingSecret: 'sek' } } });
    const json = JSON.stringify(v);
    expect(json).not.toContain('sek');
    expect(json).not.toContain('x.example');
    expect(Object.keys(v).sort()).toEqual(['countries', 'kycMode', 'liveRailWarning', 'verifyBeforeSend']);
  });
});
