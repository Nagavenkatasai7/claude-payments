import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

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

/** The raw stored row for a partner, serialized — the at-rest view. */
async function atRest(db: Db, partnerId: string): Promise<string> {
  const raw = await db.execute(
    sql.raw(`SELECT * FROM partner_integrations WHERE partner_id = '${partnerId}'`),
  );
  const rows = (raw as unknown as { rows: unknown[] }).rows;
  return JSON.stringify(rows[0] ?? null);
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
});

describe('partner-integrations store', () => {
  it('returns EMPTY (today\'s behavior) when no row exists', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    expect(await s.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('round-trips a full config — every secret comes back as plaintext', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    await s.saveIntegrations('acme', FULL);
    expect(await s.getIntegrations('acme')).toEqual(FULL);
  });

  it('encrypts every secret AT REST — no plaintext secret in the stored row', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    await s.saveIntegrations('acme', FULL);
    const stored = await atRest(db, 'acme');
    // secrets must NOT appear in cleartext
    for (const secret of ['persona_secret_key', 'whk_kyc', 'csecret', 'whk_pay', 'EAAtoken', 'verify123', 'metaappsecret']) {
      expect(stored).not.toContain(secret);
    }
    // and the encrypted blobs carry the field-crypto version marker
    expect(stored).toContain('v1.');
  });

  it('stores non-secret SELECTORS in the clear (providerType, phoneNumberId)', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    await s.saveIntegrations('acme', FULL);
    const stored = await atRest(db, 'acme');
    expect(stored).toContain('persona'); // kyc.providerType
    expect(stored).toContain('123456'); // whatsapp.phoneNumberId
  });

  it('a branding-only / mock partner serializes with no encrypted fields', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    await s.saveIntegrations('acme', { kyc: {}, payment: { providerType: 'mock' }, whatsapp: {} });
    const stored = await atRest(db, 'acme');
    expect(stored).not.toContain('v1.'); // never touched the master key
    expect(await s.getIntegrations('acme')).toEqual({ kyc: {}, payment: { providerType: 'mock' }, whatsapp: {} });
  });

  // (Redis-era "corrupt non-JSON row" test deleted: typed Postgres columns make a
  // non-JSON blob row unrepresentable, so the corruption scenario is impossible.)

  it('deleteIntegrations crypto-shreds the row (back to EMPTY)', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    await s.saveIntegrations('acme', FULL);
    await s.deleteIntegrations('acme');
    expect(await s.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });

  it('isolates partners — one partner\'s secrets never leak into another\'s row', async () => {
    const s = createPartnerIntegrationsStore(db, provider());
    await s.saveIntegrations('acme', FULL);
    await s.saveIntegrations('globex', { kyc: {}, payment: {}, whatsapp: {} });
    expect(await s.getIntegrations('globex')).toEqual({ kyc: {}, payment: {}, whatsapp: {} });
    expect(await s.getIntegrations('acme')).toEqual(FULL);
  });
});
