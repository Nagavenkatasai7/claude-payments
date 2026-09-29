import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// UI redesign M3-15a security review M1: the WhatsApp writers rewrite the WHOLE integrations row
// (integrations-repo.ts saveIntegrations). If they write back a copy of the payment config read
// BEFORE the Graph probe, a settlement-secret rotation committed meanwhile is silently undone (the
// partner was shown a secret that is no longer stored). They must re-read under the tenant lock.

const redis = fakeRedis();
let db: Db;
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db) };
});
// The Graph probe runs between the writer's first read and its transaction: a concurrent rotation
// is committed exactly there.
const during = vi.hoisted(() => ({ fn: async () => {} }));
vi.mock('@/lib/partner-integrations-verify', () => ({
  verifyPhoneNumberOwnership: async () => {
    await during.fn();
    return { ok: true };
  },
}));

import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { railSecrets } from '@/lib/partner-integrations';
import { rotateRailSecret } from '@/lib/partner-settlement-endpoint';
import { saveWhatsappConfig } from '@/lib/partner-whatsapp-config';

const actor = { username: 'pa-admin', actorScope: 'partner' as const };

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await createPartnerIntegrationsStore(db).saveIntegrations('pa', {
    kyc: {},
    payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail.example.com/i', signingSecret: 'a'.repeat(64) }, webhookSecret: 'b'.repeat(64) },
    whatsapp: {},
  });
});

describe('WhatsApp save vs a concurrent settlement-secret rotation', () => {
  it.each(['signing', 'webhook'] as const)('a %s rotation committed during the Graph probe survives the WhatsApp save', async (kind) => {
    let secret = '';
    during.fn = async () => {
      const r = await rotateRailSecret(db, 'pa', actor, kind);
      if (!r.ok) throw new Error('rotation refused');
      secret = r.secret;
    };
    await saveWhatsappConfig('pa', 'pa-admin', { phoneNumberId: '1234567', token: 'tok', verifyToken: '', appSecret: 'app', wabaId: '' });
    const after = await createPartnerIntegrationsStore(db).getIntegrations('pa');
    expect(secret).not.toBe('');
    expect(railSecrets(after.payment, kind, new Date())[0]).toBe(secret);
    expect(after.whatsapp.phoneNumberId).toBe('1234567');
  });
});
