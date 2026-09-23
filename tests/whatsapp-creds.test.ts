import { describe, it, expect, vi } from 'vitest';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';

describe('waCredsFrom (WL2 outbound credential resolution)', () => {
  it('returns creds only when BOTH phoneNumberId and token are configured', () => {
    expect(
      waCredsFrom({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: '111', token: 'tok' } }),
    ).toEqual({ phoneNumberId: '111', token: 'tok' });
  });

  it('half-configured / empty / null ⇒ undefined (fall back to the shared env number)', () => {
    expect(waCredsFrom({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: '111' } })).toBeUndefined();
    expect(waCredsFrom({ kyc: {}, payment: {}, whatsapp: { token: 'tok' } })).toBeUndefined();
    expect(waCredsFrom(EMPTY_PARTNER_INTEGRATIONS)).toBeUndefined();
    expect(waCredsFrom(null)).toBeUndefined();
    expect(waCredsFrom(undefined)).toBeUndefined();
  });
});

// Program-Fix 49A (whatsapp-11): the ONE shared resolver the direct senders
// (portal OTP, Persona nudge, KYC decision) use. FAIL-SOFT on purpose: an OTP
// must still arrive when a partner read hiccups, so any error ⇒ the shared
// number and the SmartRemit brand. (The outbox worker keeps its own
// fail-closed, memoized resolver.)
describe('partnerWaContext (Program-Fix 49A)', () => {
  it('a BYO partner ⇒ its brand + its creds', async () => {
    const { partnerWaContext } = await import('@/lib/whatsapp-creds');
    const ctx = await partnerWaContext('acme', {
      getPartner: async () => ({ id: 'acme', displayName: 'Acme Remit' }) as never,
      getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn', token: 't' } }) as never,
    });
    expect(ctx).toEqual({ brand: 'Acme Remit', waCreds: { phoneNumberId: 'pn', token: 't' } });
  });

  it('no partner row / no integrations ⇒ SmartRemit + the shared number', async () => {
    const { partnerWaContext } = await import('@/lib/whatsapp-creds');
    const ctx = await partnerWaContext('ghost', { getPartner: async () => null, getIntegrations: async () => null as never });
    expect(ctx).toEqual({ brand: 'SmartRemit', waCreds: undefined });
  });

  it('a read error ⇒ SmartRemit + the shared number, never a throw', async () => {
    const { partnerWaContext } = await import('@/lib/whatsapp-creds');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await partnerWaContext('acme', {
      getPartner: async () => { throw new Error('db down'); },
      getIntegrations: async () => ({}) as never,
    });
    expect(ctx).toEqual({ brand: 'SmartRemit', waCreds: undefined });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
