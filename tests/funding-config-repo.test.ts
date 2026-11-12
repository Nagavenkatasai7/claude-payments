/**
 * Program-Fix 7 — the partner's funds-capture PSP config lives on the
 * existing encrypted integration-secrets row, in its OWN columns with its own
 * repo methods: the key + endpoint secrets are envelope-encrypted (never
 * plaintext at rest), and a dashboard save of the rail/KYC/WhatsApp config
 * (saveIntegrations) can never null them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { freshDb } from './helpers-db';
import { __setFieldCryptoWriteV2ForTests } from '@/lib/field-crypto';

let db: Awaited<ReturnType<typeof freshDb>>;
// Fix pack 5 T16 (P16): only a restricted key is accepted at write.
const KEY = ['rk', 'test', 'repoonly'].join('_');
const WH = ['whsec', 'repo', 'only'].join('_');

beforeEach(async () => {
  db = await freshDb();
  await db.execute(sql`INSERT INTO partners (id, name) VALUES ('acme', 'Acme') ON CONFLICT DO NOTHING`);
});

describe('integrations-repo funding config', () => {
  it('no row / no config ⇒ null (the mock)', async () => {
    const repo = createIntegrationsRepo(db);
    expect(await repo.getFundingConfig('acme')).toBeNull();
    await repo.saveIntegrations('acme', { kyc: {}, payment: { providerType: 'simulator' }, whatsapp: {} });
    expect(await repo.getFundingConfig('acme')).toBeNull();
  });

  it('round-trips, encrypted at rest (no plaintext key or secret in the row)', async () => {
    const repo = createIntegrationsRepo(db);
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    expect(await repo.getFundingConfig('acme')).toEqual({ providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    const res = await db.execute(sql`SELECT funding_provider_type, funding_credentials_enc FROM partner_integrations WHERE partner_id = 'acme'`);
    const row = (res as unknown as { rows: Array<Record<string, string>> }).rows[0];
    expect(row.funding_provider_type).toBe('stripe');
    expect(row.funding_credentials_enc).toBeTruthy();
    expect(row.funding_credentials_enc).not.toContain(KEY);
    expect(row.funding_credentials_enc).not.toContain(WH);
  });

  it('refuses a Stripe funding config on SmartRemit\'s own default tenant (never merchant of record); clearing is allowed', async () => {
    const repo = createIntegrationsRepo(db);
    await expect(repo.setFundingConfig('default', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] })).rejects.toThrow(/default/);
    expect(await repo.getFundingConfig('default')).toBeNull();
    await expect(repo.setFundingConfig('default', null)).resolves.toBeUndefined();
  });

  it('saveIntegrations (a dashboard save) never wipes the funding config', async () => {
    const repo = createIntegrationsRepo(db);
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    await repo.saveIntegrations('acme', { kyc: {}, payment: { providerType: 'simulator' }, whatsapp: {} });
    expect((await repo.getFundingConfig('acme'))?.secretKey).toBe(KEY);
  });

  it('setFundingConfig(null) clears it; tenant rows are independent', async () => {
    const repo = createIntegrationsRepo(db);
    await db.execute(sql`INSERT INTO partners (id, name) VALUES ('globex', 'Globex') ON CONFLICT DO NOTHING`);
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    expect(await repo.getFundingConfig('globex')).toBeNull();
    await repo.setFundingConfig('acme', null);
    expect(await repo.getFundingConfig('acme')).toBeNull();
  });

  it('a ciphertext copied onto another tenant does not decrypt (AAD binds partner + column, once v2 writes are on — fix 46B)', async () => {
    __setFieldCryptoWriteV2ForTests(true);
    const repo = createIntegrationsRepo(db);
    await db.execute(sql`INSERT INTO partners (id, name) VALUES ('globex', 'Globex') ON CONFLICT DO NOTHING`);
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    await repo.setFundingConfig('globex', { providerType: 'stripe', secretKey: ['rk', 'test', 'globex'].join('_'), webhookSecrets: ['y'] });
    await db.execute(sql`UPDATE partner_integrations SET funding_credentials_enc = (SELECT funding_credentials_enc FROM partner_integrations WHERE partner_id = 'acme') WHERE partner_id = 'globex'`);
    try {
      await expect(repo.getFundingConfig('globex')).rejects.toThrow();
    } finally {
      __setFieldCryptoWriteV2ForTests(false);
    }
  });

  it('fix pack 5 T16 (P16): an unrestricted key is refused at write (throws /restricted/, no key in the message) and nothing is written', async () => {
    const repo = createIntegrationsRepo(db);
    const sk = ['sk', 'test', 'repoonly'].join('_');
    let msg = '';
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: sk, webhookSecrets: [WH] }).catch((e: Error) => { msg = e.message; });
    expect(msg).toMatch(/restricted/);
    expect(msg).not.toContain('repoonly');
    expect(await repo.getFundingConfig('acme')).toBeNull();
    // An existing restricted config is kept when a later write is refused.
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    for (const bad of [sk, ['sk', 'org', 'x'].join('_'), ['pk', 'live', 'x'].join('_'), '', undefined]) {
      await expect(repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: bad, webhookSecrets: [WH] })).rejects.toThrow(/restricted/);
    }
    expect(await repo.getFundingConfig('acme')).toEqual({ providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    // Clearing (null) and a non-Stripe config are not checked.
    await expect(repo.setFundingConfig('acme', {})).resolves.toBeUndefined();
    expect(await repo.getFundingConfig('acme')).toBeNull();
    await repo.setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
    await expect(repo.setFundingConfig('acme', null)).resolves.toBeUndefined();
    expect(await repo.getFundingConfig('acme')).toBeNull();
  });
});
