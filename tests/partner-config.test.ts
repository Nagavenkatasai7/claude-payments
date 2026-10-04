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
import { freshDb, seedPartner } from './helpers-db';
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

  // Oct 4 owner decision: SmartRemit is the only customer-facing brand. Partners stay behind the
  // scenes, so a partner's display name, brand name, colour and logo never become the brand.
  it('always SmartRemit, whatever displayName / brandName the partner has', () => {
    expect(resolvePartnerBranding(partner({ displayName: 'Acme Pay', brandName: 'Acme' })).brand).toBe('SmartRemit');
    expect(resolvePartnerBranding(partner({ brandName: 'Acme' })).brand).toBe('SmartRemit');
    expect(resolvePartnerBranding(partner({})).brand).toBe('SmartRemit');
  });

  it('drops partner colour and logo; keeps support contact and persona (not brand)', () => {
    const r = resolvePartnerBranding(
      partner({ primaryColor: '#1a73e8', logoUrl: 'https://cdn/x.png', supportContact: 'help@acme.com', botPersona: 'warm and concise' }),
    );
    expect(r).toEqual({ brand: 'SmartRemit', supportContact: 'help@acme.com', botPersona: 'warm and concise', primaryColor: null, logoUrl: null });
  });
});

describe('resolveKycMode', () => {
  it('null/undefined ⇒ ours, gate OFF (verification is partner OPT-IN)', () => {
    expect(resolveKycMode(null)).toEqual({ mode: 'ours', requireKyc: false });
    expect(resolveKycMode(undefined)).toEqual({ mode: 'ours', requireKyc: false });
  });

  it('requireKycBeforeSend:true turns the gate ON in EITHER mode', () => {
    expect(resolveKycMode(partner({ kycMode: 'ours', requireKycBeforeSend: true }))).toEqual({ mode: 'ours', requireKyc: true });
    expect(resolveKycMode(partner({ kycMode: 'delegated', requireKycBeforeSend: true }))).toEqual({ mode: 'delegated', requireKyc: true });
    expect(resolveKycMode(partner({ kycMode: 'ours', requireKycBeforeSend: false }))).toEqual({ mode: 'ours', requireKyc: false });
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
    const db = await freshDb();
    const store = createPartnerIntegrationsStore(db, provider);
    expect(await resolvePartnerIntegrations(null, store)).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('partner with no row ⇒ EMPTY', async () => {
    const db = await freshDb();
    const store = createPartnerIntegrationsStore(db, provider);
    expect(await resolvePartnerIntegrations(partner({}), store)).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('partner with a row ⇒ its decrypted config', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    const store = createPartnerIntegrationsStore(db, provider);
    await store.saveIntegrations('acme', { kyc: {}, payment: { providerType: 'mock' }, whatsapp: { phoneNumberId: '999' } });
    expect(await resolvePartnerIntegrations(partner({ id: 'acme' }), store)).toEqual({ kyc: {}, payment: { providerType: 'mock' }, whatsapp: { phoneNumberId: '999' } });
  });
});
