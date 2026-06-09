import { describe, it, expect, afterEach, vi } from 'vitest';
import { getKycProvider } from '@/lib/providers/kyc-provider';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { PersonaKycProvider } from '@/lib/providers/persona-kyc-provider';
import { fakeRedis } from './helpers';
import { createCustomerStore } from '@/lib/customer-store';
import type { Store } from '@/lib/store';

const cs = createCustomerStore(fakeRedis(), {} as unknown as Store);

describe('getKycProvider', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns MockKycProvider when PERSONA_API_KEY is unset', () => {
    vi.stubEnv('PERSONA_API_KEY', '');
    expect(getKycProvider(cs, 'https://app')).toBeInstanceOf(MockKycProvider);
  });

  it('returns PersonaKycProvider when PERSONA_API_KEY is set', () => {
    vi.stubEnv('PERSONA_API_KEY', 'persona_sandbox_x');
    vi.stubEnv('PERSONA_INQUIRY_TEMPLATE_VERSION_ID', 'itmplv_x');
    expect(getKycProvider(cs, 'https://app')).toBeInstanceOf(PersonaKycProvider);
  });

  it('WL1: a partner with their OWN Persona creds gets Persona even when env key is unset', () => {
    vi.stubEnv('PERSONA_API_KEY', '');
    vi.stubEnv('PERSONA_INQUIRY_TEMPLATE_VERSION_ID', 'itmplv_x');
    expect(
      getKycProvider(cs, 'https://app', { providerType: 'persona', apiKey: 'partner_persona_key' }),
    ).toBeInstanceOf(PersonaKycProvider);
  });

  it('WL1: a partner config WITHOUT Persona creds falls through to env/mock (unchanged)', () => {
    vi.stubEnv('PERSONA_API_KEY', '');
    // providerType 'ours' / no apiKey ⇒ no per-partner Persona ⇒ Mock (env unset)
    expect(getKycProvider(cs, 'https://app', { providerType: 'ours' })).toBeInstanceOf(MockKycProvider);
    expect(getKycProvider(cs, 'https://app', {})).toBeInstanceOf(MockKycProvider);
  });
});
