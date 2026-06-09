import { describe, it, expect } from 'vitest';
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
