import { describe, it, expect } from 'vitest';
import {
  resolvePartnerBranding,
  resolveKycMode,
  resolvePartnerIntegrations,
  DEFAULT_BRAND,
} from '@/lib/partner-config';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';
import { fakeRedis } from './helpers';
import type { Partner } from '@/lib/types';

const now = '2026-06-08T00:00:00Z';
function partner(overrides: Partial<Partner>): Partner {
  return {
    id: 'acme',
    name: 'Acme',
    countries: ['US'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('resolvePartnerBranding', () => {
  it('null/undefined partner ⇒ SmartRemit defaults (today\'s behavior)', () => {
    expect(resolvePartnerBranding(null)).toEqual({
      brand: DEFAULT_BRAND,
      supportContact: '',
      botPersona: '',
      primaryColor: null,
      logoUrl: null,
    });
    expect(resolvePartnerBranding(undefined).brand).toBe('SmartRemit');
  });

  it('the bare default partner (no branding fields) still resolves to SmartRemit', () => {
    expect(resolvePartnerBranding(partner({ id: 'default', name: 'SmartRemit Default' })).brand).toBe('SmartRemit');
  });

  it('prefers displayName, then brandName, then SmartRemit', () => {
    expect(resolvePartnerBranding(partner({ displayName: 'Acme Pay', brandName: 'Acme' })).brand).toBe('Acme Pay');
    expect(resolvePartnerBranding(partner({ brandName: 'Acme' })).brand).toBe('Acme');
    expect(resolvePartnerBranding(partner({})).brand).toBe('SmartRemit');
  });

  it('passes through color/logo/support/persona; absent ⇒ null/empty', () => {
    const r = resolvePartnerBranding(
      partner({ primaryColor: '#1a73e8', logoUrl: 'https://cdn/x.png', supportContact: 'help@acme.com', botPersona: 'warm and concise' }),
    );
    expect(r).toEqual({ brand: 'SmartRemit', supportContact: 'help@acme.com', botPersona: 'warm and concise', primaryColor: '#1a73e8', logoUrl: 'https://cdn/x.png' });
  });
});

describe('resolveKycMode', () => {
  it('null/undefined ⇒ ours, gate ON (today\'s behavior)', () => {
    expect(resolveKycMode(null)).toEqual({ mode: 'ours', requireKyc: true });
    expect(resolveKycMode(undefined)).toEqual({ mode: 'ours', requireKyc: true });
  });

  it('INVARIANT: ours can NEVER skip KYC, even if requireKycBeforeSend=false', () => {
    expect(resolveKycMode(partner({ kycMode: 'ours', requireKycBeforeSend: false }))).toEqual({ mode: 'ours', requireKyc: true });
  });

  it('delegated ⇒ gate OFF by default', () => {
    expect(resolveKycMode(partner({ kycMode: 'delegated' }))).toEqual({ mode: 'delegated', requireKyc: false });
  });

  it('delegated + requireKycBeforeSend=true ⇒ gate ON (partner opts back in)', () => {
    expect(resolveKycMode(partner({ kycMode: 'delegated', requireKycBeforeSend: true }))).toEqual({ mode: 'delegated', requireKyc: true });
  });
});

describe('resolvePartnerIntegrations', () => {
  const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

  it('null partner ⇒ EMPTY (mock payment / env KYC / shared WhatsApp)', async () => {
    const store = createPartnerIntegrationsStore(fakeRedis(), provider);
    expect(await resolvePartnerIntegrations(null, store)).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('partner with no row ⇒ EMPTY', async () => {
    const store = createPartnerIntegrationsStore(fakeRedis(), provider);
    expect(await resolvePartnerIntegrations(partner({}), store)).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('partner with a row ⇒ its decrypted config', async () => {
    const store = createPartnerIntegrationsStore(fakeRedis(), provider);
    await store.saveIntegrations('acme', { kyc: {}, payment: { providerType: 'mock' }, whatsapp: { phoneNumberId: '999' } });
    expect(await resolvePartnerIntegrations(partner({ id: 'acme' }), store)).toEqual({ kyc: {}, payment: { providerType: 'mock' }, whatsapp: { phoneNumberId: '999' } });
  });
});
