import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Partner } from '@/lib/types';
import { certifiedLiveControls } from './helpers-live';

// The B2B bill-pay and seller-onboarding confirmation codes are sent DIRECTLY (not via the outbox).
// A non-default partner's customer is dealing with the partner's brand, so the code must never fall
// back to SmartRemit's shared number when that partner's own channel cannot be used. The rule
// (portal pay-page twin: PR #438):
//   own channel → its creds; nothing set (API-only) or the default tenant → the shared number;
//   half-configured → fail closed + incomplete_config health mark; creds read throws → fail closed
//   for a non-default partner (the default tenant's number IS the shared one); no tenant → fail closed.

const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn }));

import { resolveDirectOtpChannel } from '@/lib/direct-otp-channel';

const cfg = (whatsapp: PartnerIntegrations['whatsapp']): PartnerIntegrations => ({ kyc: {}, payment: {}, whatsapp });
const deps = (
  get: () => Promise<PartnerIntegrations | null | undefined>,
  getPartner: (id: string) => Promise<Partner | null | undefined> = async () => null,
) => {
  const recordIncomplete = vi.fn(async () => {});
  return { getIntegrations: vi.fn(get), recordIncomplete, getPartner: vi.fn(getPartner) };
};
/** A Partner fake: only the fields isLiveCertified reads matter here. */
const partnerFake = (id: string, certified: boolean): Partner =>
  ({ id, status: 'active', liveControls: certified ? certifiedLiveControls() : { optIns: {}, complianceUsers: [] } }) as unknown as Partner;

beforeEach(() => logWarn.mockClear());

describe('resolveDirectOtpChannel', () => {
  it("a partner's own channel → its creds", async () => {
    const d = deps(async () => cfg({ phoneNumberId: '1234567', token: 'tok', appSecret: 's' }));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: true, creds: { phoneNumberId: '1234567', token: 'tok' } });
    expect(d.recordIncomplete).not.toHaveBeenCalled();
  });

  it('a non-default partner with NOTHING set (deliberately on the shared number) → the shared number', async () => {
    const d = deps(async () => cfg({}));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: true, creds: undefined });
  });

  it('the default tenant → the shared number', async () => {
    const d = deps(async () => cfg({}));
    expect(await resolveDirectOtpChannel('default', 'b2b.otp', d)).toEqual({ ok: true, creds: undefined });
  });

  it('a half-configured non-default channel → fail closed, incomplete_config recorded, logged without values', async () => {
    const d = deps(async () => cfg({ phoneNumberId: '1234567', appSecret: 'secret-app-value' }));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: false, why: 'incomplete' });
    expect(d.recordIncomplete).toHaveBeenCalledWith('pa');
    expect(logWarn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain('1234567');
    expect(logged).not.toContain('secret-app-value');
  });

  it('a non-default partner whose creds read throws → fail closed; the error message is never logged', async () => {
    const d = deps(async () => {
      throw new Error('decrypt failed for token tok-SECRET-1234567');
    });
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: false, why: 'lookup_failed' });
    expect(d.recordIncomplete).not.toHaveBeenCalled();
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain('tok-SECRET');
    expect(logged).toContain('"partnerId":"pa"');
  });

  it("the default tenant's creds read throws → the shared number (it IS the default tenant's number)", async () => {
    const d = deps(async () => {
      throw new Error('db down');
    });
    expect(await resolveDirectOtpChannel('default', 'b2b.otp', d)).toEqual({ ok: true, creds: undefined });
  });

  it.each([undefined, null, ''])('an unresolved tenant (%s) → fail closed without a lookup', async (pid) => {
    const d = deps(async () => cfg({}));
    expect(await resolveDirectOtpChannel(pid as string | undefined, 'b2b.otp', d)).toEqual({ ok: false, why: 'tenant_unresolved' });
    expect(d.getIntegrations).not.toHaveBeenCalled();
  });

  it('a health-mark failure never turns a refusal into a send', async () => {
    const d = deps(async () => cfg({ token: 'tok' }));
    d.recordIncomplete.mockRejectedValueOnce(new Error('redis down'));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: false, why: 'incomplete' });
  });
});

// Pack 3 (contract 17): a partner CERTIFIED for live money never has its confirmation codes sent
// on SmartRemit's shared number: its customers deal with a licensed partner, so the code must come
// from that partner's own number or not at all. Uncertified partners keep today's rule.
describe('resolveDirectOtpChannel — own-number rule for certified partners (pack 3)', { retry: 0 }, () => {
  it('a certified non-default partner on the shared number → not_own_number, logged with the partner id only', async () => {
    const d = deps(async () => cfg({}), async (id) => partnerFake(id, true));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: false, why: 'not_own_number' });
    expect(d.getPartner).toHaveBeenCalledWith('pa');
    expect(d.recordIncomplete).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0][2]).toEqual({ partnerId: 'pa' });
  });

  it('a certified partner with its own number → its creds', async () => {
    const d = deps(async () => cfg({ phoneNumberId: '1234567', token: 'tok' }), async (id) => partnerFake(id, true));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: true, creds: { phoneNumberId: '1234567', token: 'tok' } });
  });

  it('an uncertified partner on the shared number → the shared number (unchanged)', async () => {
    const d = deps(async () => cfg({}), async (id) => partnerFake(id, false));
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: true, creds: undefined });
    expect(d.getPartner).toHaveBeenCalledWith('pa');
  });

  it('the default tenant never reads the partner', async () => {
    const d = deps(async () => cfg({}), async (id) => partnerFake(id, true));
    expect(await resolveDirectOtpChannel('default', 'b2b.otp', d)).toEqual({ ok: true, creds: undefined });
    expect(d.getPartner).not.toHaveBeenCalled();
  });

  it('a getPartner throw for a non-default shared partner → lookup_failed; the error message is never logged', async () => {
    const d = deps(async () => cfg({}), async () => {
      throw new Error('connection postgres://user:pw-SECRET@host');
    });
    expect(await resolveDirectOtpChannel('pa', 'b2b.otp', d)).toEqual({ ok: false, why: 'lookup_failed' });
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain('pw-SECRET');
    expect(logged).toContain('"partnerId":"pa"');
  });
});
