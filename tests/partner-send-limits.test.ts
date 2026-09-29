import { describe, it, expect } from 'vitest';
import { clampToPlatform, partnerMayWriteOverride, validatePartnerCustomerLimit } from '@/lib/partner-send-limits';
import { PLATFORM_SEND_LIMITS, SEND_LIMIT_HARD_CEILING_CENTS, resolveEffectiveSendLimits } from '@/lib/send-limits';
import type { SendLimitOverride } from '@/lib/types';

// UI redesign M3-12 (SPEC §3.4): a partner may set a per-customer limit only AT OR BELOW the
// platform caps and any SmartRemit partner-level limit, and may never overwrite a live SmartRemit
// (platform) override. The resolver re-clamps partner-set entries at READ time, so a later
// SmartRemit tightening is never escaped; every other entry resolves exactly as before.
const now = new Date();
const future = new Date(now.getTime() + 86_400_000).toISOString();
const past = new Date(now.getTime() - 86_400_000).toISOString();
const form = (o: Partial<Parameters<typeof validatePartnerCustomerLimit>[0]> = {}) => ({
  perTransferUsd: '',
  t1DailyUsd: '',
  t0DailyUsd: '',
  expiresAt: '',
  reason: 'Customer asked for a lower cap',
  clear: false,
  ...o,
});

describe('partner per-customer limits (SPEC §3.4)', () => {
  it('clamps anything above the platform caps DOWN to them', () => {
    expect(clampToPlatform({ perTransferCapCents: 1_000_000, t1DailyCapCents: 900_000 }, null, now)).toEqual({
      perTransferCapCents: PLATFORM_SEND_LIMITS.perTransferCapCents,
      t1DailyCapCents: PLATFORM_SEND_LIMITS.t1DailyCapCents,
    });
    expect(clampToPlatform({ perTransferCapCents: 10_000 }, null, now)).toEqual({ perTransferCapCents: 10_000 });
  });
  it('a SmartRemit partner-level tightening also caps the partner-set customer override', () => {
    const partner = { sendLimits: { perTransferCapCents: 100_000 } };
    expect(clampToPlatform({ perTransferCapCents: 299_900 }, partner, now)).toEqual({ perTransferCapCents: 100_000 });
  });
  it('an EXPIRED partner-level tightening does not cap it', () => {
    const partner = { sendLimits: { perTransferCapCents: 100_000, expiresAt: past } };
    expect(clampToPlatform({ perTransferCapCents: 200_000 }, partner, now)).toEqual({ perTransferCapCents: 200_000 });
  });
  it('a partner-level RAISE never lifts a partner-set override above the platform cap', () => {
    const partner = { sendLimits: { perTransferCapCents: 800_000 } };
    expect(clampToPlatform({ perTransferCapCents: 800_000 }, partner, now)).toEqual({
      perTransferCapCents: PLATFORM_SEND_LIMITS.perTransferCapCents,
    });
  });
  it('validate: $10,000 input becomes the platform cap (clamped); a missing reason throws before anything else', () => {
    const v = validatePartnerCustomerLimit(form({ perTransferUsd: '10000' }), null, now);
    expect(v.value).toMatchObject({ perTransferCapCents: PLATFORM_SEND_LIMITS.perTransferCapCents });
    expect(v.clamped).toBe(true);
    expect(() => validatePartnerCustomerLimit(form({ perTransferUsd: '100', reason: '' }), null, now)).toThrow();
  });
  it('validate: a value within the caps is kept as-is and not marked clamped; the expiry rides along', () => {
    const v = validatePartnerCustomerLimit(form({ perTransferUsd: '500', t1DailyUsd: '1000', expiresAt: future }), null, now);
    expect(v.value).toEqual({ perTransferCapCents: 50_000, t1DailyCapCents: 100_000, expiresAt: future });
    expect(v.clamped).toBe(false);
  });
  it('validate: T0 is never accepted, even when posted', () => {
    const v = validatePartnerCustomerLimit(form({ perTransferUsd: '500', t0DailyUsd: '100' }), null, now);
    expect(v.value).not.toHaveProperty('t0DailyCapCents');
    expect(() => validatePartnerCustomerLimit(form({ t0DailyUsd: '100' }), null, now)).toThrow();
  });
  it('validate: clear stores null and ignores the figures', () => {
    const v = validatePartnerCustomerLimit(form({ clear: true, perTransferUsd: '99999' }), null, now);
    expect(v.value).toBeNull();
    expect(v.clamped).toBe(false);
  });
  it('never overwrites a live platform override; may overwrite its own or an expired one', () => {
    expect(partnerMayWriteOverride({ perTransferCapCents: 500_000, setBy: 'owner' }, now)).toBe(false);
    expect(partnerMayWriteOverride({ perTransferCapCents: 500_000, setScope: 'platform', expiresAt: future }, now)).toBe(false);
    expect(partnerMayWriteOverride({ perTransferCapCents: 500_000, setScope: 'platform', expiresAt: past }, now)).toBe(true);
    expect(partnerMayWriteOverride({ perTransferCapCents: 10_000, setScope: 'partner' }, now)).toBe(true);
    expect(partnerMayWriteOverride(null, now)).toBe(true);
    expect(partnerMayWriteOverride(undefined, now)).toBe(true);
  });
  it('an unknown scope string, or an unparseable expiry, is treated as a live SmartRemit override', () => {
    expect(partnerMayWriteOverride({ perTransferCapCents: 10_000, setScope: 'Partner' } as unknown as SendLimitOverride, now)).toBe(false);
    expect(partnerMayWriteOverride({ perTransferCapCents: 10_000, expiresAt: 'not-a-date' }, now)).toBe(false);
  });
});

describe('resolveEffectiveSendLimits: the resolve-time clamp for partner-set entries (review R6)', () => {
  const tightened = { sendLimits: { perTransferCapCents: 100_000 } };

  it('a partner-set 299_900 override + a LATER partner-level tightening to 100_000 → effective 100_000 from the partner level', () => {
    const r = resolveEffectiveSendLimits(tightened, { sendLimitOverride: { perTransferCapCents: 299_900, setScope: 'partner' } }, now);
    expect(r.perTransferCapCents).toBe(100_000);
    expect(r.source.perTransferCapCents).toBe('partner');
    expect(r.maxUsd).toBe(1000);
  });
  it('a platform raise without setScope + the same partner level → the raise still wins (unchanged)', () => {
    const r = resolveEffectiveSendLimits(tightened, { sendLimitOverride: { perTransferCapCents: 500_000 } }, now);
    expect(r.perTransferCapCents).toBe(500_000);
    expect(r.source.perTransferCapCents).toBe('customer');
  });
  it("setScope 'platform' resolves exactly like a legacy entry", () => {
    const legacy = resolveEffectiveSendLimits(tightened, { sendLimitOverride: { perTransferCapCents: 500_000, t1DailyCapCents: 700_000 } }, now);
    const platform = resolveEffectiveSendLimits(
      tightened,
      { sendLimitOverride: { perTransferCapCents: 500_000, t1DailyCapCents: 700_000, setScope: 'platform' } },
      now,
    );
    expect(platform).toEqual(legacy);
  });
  it('an unknown setScope string resolves as today (a platform entry)', () => {
    const r = resolveEffectiveSendLimits(
      tightened,
      { sendLimitOverride: { perTransferCapCents: 500_000, setScope: 'PARTNER' } as unknown as SendLimitOverride },
      now,
    );
    expect(r.perTransferCapCents).toBe(500_000);
  });
  it('a partner-set value BELOW every level applies, with source customer', () => {
    const r = resolveEffectiveSendLimits(tightened, { sendLimitOverride: { perTransferCapCents: 20_000, t1DailyCapCents: 50_000, setScope: 'partner' } }, now);
    expect(r).toMatchObject({ perTransferCapCents: 20_000, t1DailyCapCents: 50_000, maxUsd: 200 });
    expect(r.source).toMatchObject({ perTransferCapCents: 'customer', t1DailyCapCents: 'customer' });
  });
  it('a tie with the lower level reports customer (the value the customer entry names is applied)', () => {
    const r = resolveEffectiveSendLimits(null, { sendLimitOverride: { perTransferCapCents: 299_900, setScope: 'partner' } }, now);
    expect(r.perTransferCapCents).toBe(299_900);
    expect(r.source.perTransferCapCents).toBe('customer');
  });
  it('a hand-planted partner-set value above the platform cap is clamped to the platform (no partner level)', () => {
    const r = resolveEffectiveSendLimits(null, { sendLimitOverride: { perTransferCapCents: 900_000, t1DailyCapCents: 900_000, setScope: 'partner' } }, now);
    expect(r.perTransferCapCents).toBe(PLATFORM_SEND_LIMITS.perTransferCapCents);
    expect(r.t1DailyCapCents).toBe(PLATFORM_SEND_LIMITS.t1DailyCapCents);
    expect(r.source.perTransferCapCents).toBe('platform');
  });
  it('a partner-level RAISE never lifts a partner-set value above the platform cap at resolve', () => {
    const raised = { sendLimits: { perTransferCapCents: 800_000 } };
    const r = resolveEffectiveSendLimits(raised, { sendLimitOverride: { perTransferCapCents: 600_000, setScope: 'partner' } }, now);
    expect(r.perTransferCapCents).toBe(PLATFORM_SEND_LIMITS.perTransferCapCents);
    expect(r.perTransferCapCents).toBeLessThanOrEqual(SEND_LIMIT_HARD_CEILING_CENTS);
  });
  it('an EXPIRED partner-level tightening is ignored; an expired partner-set entry is skipped whole', () => {
    const lapsed = { sendLimits: { perTransferCapCents: 100_000, expiresAt: past } };
    expect(resolveEffectiveSendLimits(lapsed, { sendLimitOverride: { perTransferCapCents: 200_000, setScope: 'partner' } }, now).perTransferCapCents).toBe(200_000);
    const r = resolveEffectiveSendLimits(tightened, { sendLimitOverride: { perTransferCapCents: 20_000, setScope: 'partner', expiresAt: past } }, now);
    expect(r.perTransferCapCents).toBe(100_000);
    expect(r.source.perTransferCapCents).toBe('partner');
  });
  it('a field the partner-set entry does not name falls through to the partner level / platform as today', () => {
    const r = resolveEffectiveSendLimits(
      { sendLimits: { t1DailyCapCents: 150_000 } },
      { sendLimitOverride: { perTransferCapCents: 20_000, setScope: 'partner' } },
      now,
    );
    expect(r.t1DailyCapCents).toBe(150_000);
    expect(r.source.t1DailyCapCents).toBe('partner');
  });
  it('T0 is never affected by a customer entry of either scope', () => {
    const p = { sendLimits: { t0DailyCapCents: 20_000 } };
    const a = resolveEffectiveSendLimits(p, { sendLimitOverride: { perTransferCapCents: 20_000, setScope: 'partner' } }, now);
    const b = resolveEffectiveSendLimits(p, null, now);
    expect(a.t0DailyCapCents).toBe(b.t0DailyCapCents);
    expect(a.source.t0DailyCapCents).toBe(b.source.t0DailyCapCents);
  });
});
