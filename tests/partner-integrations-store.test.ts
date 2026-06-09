import { describe, it, expect } from 'vitest';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';
import { fakeRedis } from './helpers';

// Fixed master key so the test never depends on FIELD_ENCRYPTION_KEY env.
const KEY = Buffer.alloc(32, 7);
const provider = () => new EnvKeyProvider(KEY);

const FULL = {
  kyc: { providerType: 'persona' as const, apiKey: 'persona_secret_key', webhookSecret: 'whk_kyc' },
  payment: {
    providerType: 'mock',
    credentials: { clientId: 'cid', clientSecret: 'csecret' },
    webhookSecret: 'whk_pay',
  },
  whatsapp: { phoneNumberId: '123456', token: 'EAAtoken', verifyToken: 'verify123', appSecret: 'metaappsecret' },
};

describe('partner-integrations store', () => {
  it('returns EMPTY (today\'s behavior) when no row exists', async () => {
    const s = createPartnerIntegrationsStore(fakeRedis(), provider());
    expect(await s.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('round-trips a full config — every secret comes back as plaintext', async () => {
    const s = createPartnerIntegrationsStore(fakeRedis(), provider());
    await s.saveIntegrations('acme', FULL);
    expect(await s.getIntegrations('acme')).toEqual(FULL);
  });

  it('encrypts every secret AT REST — no plaintext secret in the stored row', async () => {
    const redis = fakeRedis();
    const s = createPartnerIntegrationsStore(redis, provider());
    await s.saveIntegrations('acme', FULL);
    const atRest = redis.dump.get('partner:acme:integrations')!;
    // secrets must NOT appear in cleartext
    for (const secret of ['persona_secret_key', 'whk_kyc', 'csecret', 'whk_pay', 'EAAtoken', 'verify123', 'metaappsecret']) {
      expect(atRest).not.toContain(secret);
    }
    // and the encrypted blobs carry the field-crypto version marker
    expect(atRest).toContain('v1.');
  });

  it('stores non-secret SELECTORS in the clear (providerType, phoneNumberId)', async () => {
    const redis = fakeRedis();
    const s = createPartnerIntegrationsStore(redis, provider());
    await s.saveIntegrations('acme', FULL);
    const atRest = redis.dump.get('partner:acme:integrations')!;
    expect(atRest).toContain('persona'); // kyc.providerType
    expect(atRest).toContain('123456'); // whatsapp.phoneNumberId
  });

  it('a branding-only / mock partner serializes with no encrypted fields', async () => {
    const redis = fakeRedis();
    const s = createPartnerIntegrationsStore(redis, provider());
    await s.saveIntegrations('acme', { kyc: {}, payment: { providerType: 'mock' }, whatsapp: {} });
    const atRest = redis.dump.get('partner:acme:integrations')!;
    expect(atRest).not.toContain('v1.'); // never touched the master key
    expect(await s.getIntegrations('acme')).toEqual({ kyc: {}, payment: { providerType: 'mock' }, whatsapp: {} });
  });

  it('falls safe to EMPTY on a corrupt (non-JSON) row', async () => {
    const redis = fakeRedis();
    await redis.set('partner:acme:integrations', 'not-json{');
    const s = createPartnerIntegrationsStore(redis, provider());
    expect(await s.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('deleteIntegrations crypto-shreds the row (back to EMPTY)', async () => {
    const s = createPartnerIntegrationsStore(fakeRedis(), provider());
    await s.saveIntegrations('acme', FULL);
    await s.deleteIntegrations('acme');
    expect(await s.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('isolates partners — one partner\'s secrets never leak into another\'s row', async () => {
    const s = createPartnerIntegrationsStore(fakeRedis(), provider());
    await s.saveIntegrations('acme', FULL);
    await s.saveIntegrations('globex', { kyc: {}, payment: {}, whatsapp: {} });
    expect(await s.getIntegrations('globex')).toEqual({ kyc: {}, payment: {}, whatsapp: {} });
    expect(await s.getIntegrations('acme')).toEqual(FULL);
  });
});
