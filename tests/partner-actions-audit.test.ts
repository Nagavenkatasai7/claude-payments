import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { EnvKeyProvider } from '@/lib/field-crypto';

// partner-demo R3a (M4, audit A6-1/A6-2): WhatsApp credential changes and API
// key issue/revoke leave an audit row, written in the SAME transaction as the
// change. Meta is booleans / keyId / last4 / mode only — never a token, a
// secret, a pnid or a full key. Cross-tenant replays write nothing.

let currentStaff: { username: string; role: 'admin' | 'agent' | 'support'; partnerId?: string };
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireStaff: async () => currentStaff,
  requirePlatformAdmin: async () => {
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new Error('NEXT_REDIRECT');
    return currentStaff;
  },
}));

let db: Db;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))) };
});
vi.mock('@/lib/partner-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-api-key')>('@/lib/partner-api-key');
  return { ...actual, getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(db) };
});
const sharedRedis = fakeRedis();
vi.mock('@/lib/redis', () => ({ getRedis: () => sharedRedis }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  saveWhatsappConfigAction,
  issueApiKeyAction,
  revokeApiKeyAction,
  wizardCreatePartnerAction,
} from '@/app/admin-dashboard/partners/actions';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
import { createAuditRepo } from '@/db/repos/aux-repos';

const PN = '1234567890123';
const form = (values: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const graphOk = (id: string) => vi.fn(async () => new Response(JSON.stringify({ id }), { status: 200 }));

type Row = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> | null };
async function auditRows(): Promise<Row[]> {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: Row[] }).rows;
}

let integrations: ReturnType<typeof createPartnerIntegrationsStore>;
beforeEach(async () => {
  sharedRedis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
  integrations = createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7)));
  currentStaff = { username: 'acme-admin', role: 'admin', partnerId: 'acme' };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('saveWhatsappConfigAction audits partner.whatsapp_config (booleans only)', () => {
  it('a save with no changes writes ONE row with every flag false (the live check)', async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN, token: 'EAA-stored-tok', appSecret: 'stored-app-sec', verifyToken: 'stored-vt' } });
    const graph = vi.fn();
    vi.stubGlobal('fetch', graph);
    await saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: PN }));
    expect(graph).not.toHaveBeenCalled();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', actor_type: 'staff', action: 'partner.whatsapp_config', subject_id: 'acme' });
    expect(rows[0].meta).toEqual({ pnidChanged: false, tokenChanged: false, verifyTokenChanged: false, appSecretChanged: false, pnidCleared: false });
  });

  it('a full new config (Graph-verified) sets the flags and the row holds none of the submitted values', async () => {
    vi.stubGlobal('fetch', graphOk(PN));
    const secrets = { token: 'EAA-new-secret-Q9Z7', appSecret: 'new-app-secret-xyz', verifyToken: 'new-verify-tok-abc' };
    await saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: PN, ...secrets }));
    expect((await integrations.getIntegrations('acme')).whatsapp.token).toBe(secrets.token);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ pnidChanged: true, tokenChanged: true, verifyTokenChanged: true, appSecretChanged: true, pnidCleared: false });
    const raw = JSON.stringify(rows);
    for (const v of [PN, ...Object.values(secrets), secrets.token.slice(-4)]) expect(raw).not.toContain(v);
  });

  it('only a new verify token ⇒ only verifyTokenChanged', async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN, token: 'EAA-stored', appSecret: 'sec' } });
    vi.stubGlobal('fetch', vi.fn());
    await saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: PN, verifyToken: 'v2-secret' }));
    const rows = await auditRows();
    expect(rows[0].meta).toEqual({ pnidChanged: false, tokenChanged: false, verifyTokenChanged: true, appSecretChanged: false, pnidCleared: false });
    expect(JSON.stringify(rows)).not.toContain('v2-secret');
  });

  it('an INCOMPLETE merged state is refused BEFORE the Graph probe: zero Graph calls, nothing written, no row', async () => {
    const graph = graphOk(PN);
    vi.stubGlobal('fetch', graph);
    // pnid + token but no app secret (none stored either).
    await expect(saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: PN, token: 'EAA-x' }))).rejects.toThrow(/App secret/);
    expect(graph).not.toHaveBeenCalled();
    expect((await integrations.getIntegrations('acme')).whatsapp.phoneNumberId).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('a Graph refusal writes nothing and no row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: PN, token: 'EAA-x', appSecret: 's' }))).rejects.toThrow(/could not be verified/);
    expect(await auditRows()).toEqual([]);
  });

  it('"Disconnect WhatsApp" writes ONE partner.whatsapp.disconnect row: actor + partnerId only', async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN, token: 'EAA-stored-tok', appSecret: 'stored-app-sec' } });
    vi.stubGlobal('fetch', vi.fn());
    await saveWhatsappConfigAction(form({ id: 'acme', disconnect: 'on' }));
    expect((await integrations.getIntegrations('acme')).whatsapp).toEqual({});
    const rows = await auditRows();
    expect(rows).toEqual([
      { partner_id: 'acme', actor: 'acme-admin', actor_type: 'staff', action: 'partner.whatsapp.disconnect', subject_id: 'acme', meta: null },
    ]);
  });

  it("cross-tenant: B's admin saving (or disconnecting) A's WhatsApp ⇒ not found, no write, no row", async () => {
    await integrations.saveIntegrations('acme', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN, token: 'EAA-stored', appSecret: 'sec' } });
    currentStaff = { username: 'beta-admin', role: 'admin', partnerId: 'beta' };
    const graph = vi.fn();
    vi.stubGlobal('fetch', graph);
    await expect(saveWhatsappConfigAction(form({ id: 'acme', phoneNumberId: PN, verifyToken: 'evil' }))).rejects.toThrow('Partner not found.');
    await expect(saveWhatsappConfigAction(form({ id: 'acme', disconnect: 'on' }))).rejects.toThrow('Partner not found.');
    expect(graph).not.toHaveBeenCalled();
    expect((await integrations.getIntegrations('acme')).whatsapp.phoneNumberId).toBe(PN);
    expect(await auditRows()).toEqual([]);
  });
});

describe('issueApiKeyAction / revokeApiKeyAction audit api_key.issue / api_key.revoke', () => {
  it('issue writes ONE row {keyId, mode, last4} with subject keyId — never the plaintext', async () => {
    const r = await issueApiKeyAction('acme', 'test');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', actor_type: 'staff', action: 'api_key.issue', subject_id: r.keyId });
    expect(rows[0].meta).toEqual({ keyId: r.keyId, mode: 'test', last4: r.last4 });
    expect(JSON.stringify(rows)).not.toContain(r.plaintext);
  });

  it('revoke writes ONE row {keyId, last4} and the key stops authenticating', async () => {
    const r = await issueApiKeyAction('acme');
    await revokeApiKeyAction('acme', form({ keyId: r.keyId }));
    expect(await createPartnerApiKeyStore(db).authenticate(r.plaintext)).toBeNull();
    const rows = (await auditRows()).filter((x) => x.action === 'api_key.revoke');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', actor_type: 'staff', subject_id: r.keyId });
    expect(rows[0].meta).toEqual({ keyId: r.keyId, last4: r.last4 });
    expect(JSON.stringify(rows)).not.toContain(r.plaintext);
  });

  it('re-revoking an already revoked key is a no-op: no second row', async () => {
    const r = await issueApiKeyAction('acme');
    await revokeApiKeyAction('acme', form({ keyId: r.keyId }));
    await revokeApiKeyAction('acme', form({ keyId: r.keyId }));
    expect((await auditRows()).filter((x) => x.action === 'api_key.revoke')).toHaveLength(1);
  });

  it('an unknown key ⇒ "Key not found." and no row', async () => {
    await expect(revokeApiKeyAction('acme', form({ keyId: 'pk_live_ghost' }))).rejects.toThrow('Key not found.');
    expect(await auditRows()).toEqual([]);
  });

  it("cross-tenant: A's keyId replayed by B's admin (under B, or under A) ⇒ not found, key still live, no row", async () => {
    const a = await issueApiKeyAction('acme');
    const before = await auditRows();
    currentStaff = { username: 'beta-admin', role: 'admin', partnerId: 'beta' };
    await expect(revokeApiKeyAction('beta', form({ keyId: a.keyId }))).rejects.toThrow('Key not found.');
    await expect(revokeApiKeyAction('acme', form({ keyId: a.keyId }))).rejects.toThrow('Partner not found.');
    await expect(issueApiKeyAction('acme')).rejects.toThrow('Partner not found.');
    expect(await createPartnerApiKeyStore(db).authenticate(a.plaintext)).toMatchObject({ partnerId: 'acme' });
    expect(await auditRows()).toEqual(before);
    // B's audit listing holds none of A's rows.
    expect(await createAuditRepo(db).listByPartner('beta')).toEqual([]);
  });
});

describe('wizardCreatePartnerAction audits the WhatsApp creds and the first key', () => {
  it('writes partner.whatsapp_config {created:true, …flags} and api_key.issue — no secret anywhere', async () => {
    currentStaff = { username: 'admin', role: 'admin' };
    vi.stubGlobal('fetch', graphOk(PN));
    const w = { phoneNumberId: PN, token: 'EAA-wizard-token', appSecret: 'wizard-app-secret', verifyToken: 'wizard-vt' };
    const r = await wizardCreatePartnerAction({ name: 'Wiz Co', countries: ['US'], whatsapp: w, payment: { providerType: 'simulator' } });
    const rows = (await auditRows()).filter((x) => x.partner_id === r.id);
    expect(rows.map((x) => x.action)).toEqual(['partner.whatsapp_config', 'api_key.issue']);
    expect(rows[0]).toMatchObject({ actor: 'admin', actor_type: 'staff', subject_id: r.id });
    expect(rows[0].meta).toEqual({ created: true, pnidChanged: true, tokenChanged: true, verifyTokenChanged: true, appSecretChanged: true, pnidCleared: false });
    expect(rows[1].meta).toMatchObject({ mode: 'live', last4: r.apiKeyLast4 });
    expect(rows[1].subject_id).toBe(rows[1].meta!.keyId);
    const raw = JSON.stringify(rows);
    for (const v of [PN, w.token, w.appSecret, w.verifyToken, r.apiKey]) expect(raw).not.toContain(v);
  });

  it('a wizard with no WhatsApp still records the (all-false) creds row and the first key', async () => {
    currentStaff = { username: 'admin', role: 'admin' };
    const r = await wizardCreatePartnerAction({ name: 'Plain Co', countries: ['CA'] });
    const rows = (await auditRows()).filter((x) => x.partner_id === r.id);
    expect(rows.map((x) => x.action)).toEqual(['partner.whatsapp_config', 'api_key.issue']);
    expect(rows[0].meta).toEqual({ created: true, pnidChanged: false, tokenChanged: false, verifyTokenChanged: false, appSecretChanged: false, pnidCleared: false });
  });
});
