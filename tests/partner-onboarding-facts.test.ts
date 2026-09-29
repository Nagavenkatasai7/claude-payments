import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// UI redesign M3-20, Task 20.2: loadOnboardingFacts reads ONLY the given tenant's stored facts.
// Every fact for 'pa' ignores 'pb' rows: pb is seeded fully complete, pa with nothing, and each of
// pa's facts must stay false; then each fact is flipped on for pa alone.

const redis = fakeRedis();
let db: Db;
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));

import { apiKeys, partnerGoLive, partnerSites, partners, auditEvents, transfers } from '@/db/schema';
import { createApiKeyRepo } from '@/db/repos/api-key-repo';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { loadOnboardingFacts } from '@/db/repos/partner-onboarding-facts';
import { computeOnboardingChecklist, type OnboardingFacts } from '@/lib/partner-onboarding';
import { completeIntegrations, seedInboundMessage, seedOnboardingComplete, seedPing } from './helpers-partner-onboarding';
import { seedPartnerTransfer } from './helpers-partner-app';

const URL_OPTS = { appOrigin: 'https://smartremit.ai', production: true };
const load = (pid: string, now = new Date()) => loadOnboardingFacts(db, pid, { now, urlOpts: URL_OPTS });
const DAY = 86_400_000;

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('loadOnboardingFacts: tenant isolation', () => {
  it('pb fully complete, pa nothing → every pa fact is false (pa steps 1–7 not done)', async () => {
    await seedOnboardingComplete(db, redis, 'pb', '111222333444');
    await db.insert(partnerGoLive).values({ partnerId: 'pb', requestedAt: new Date(), requestedBy: 'pb-admin', approvedAt: new Date(), approvedBy: 'x' });
    const f = await load('pa');
    const trueKeys = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
    expect(trueKeys).toEqual(['partnerActive']);
    expect(computeOnboardingChecklist(f).every((s) => !s.done)).toBe(true);
    // and pb itself reads complete (the seed is right)
    const fb = await load('pb');
    expect(computeOnboardingChecklist(fb).every((s) => s.done)).toBe(true);
  });

  it('steps 4 and 5 for pa stay not done when only pb has a delivered sandbox transfer and an ok ping', async () => {
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', completeIntegrations('555666777888'));
    await seedPartnerTransfer(db, { id: 'tr_pb_sbx', partnerId: 'pb', environment: 'test', status: 'delivered' });
    await seedPing(db, 'pb');
    const f = await load('pa');
    expect(f.sandboxTransferDelivered).toBe(false);
    expect(f.recentPingOk).toBe(false);
    expect(f.partnerRail).toBe(true);
    expect(f.endpointUrlValid).toBe(true);
    const steps = computeOnboardingChecklist(f);
    expect(steps[3].done).toBe(false);
    expect(steps[4].done).toBe(false);
  });

  it('a fully complete pa reads all of 1–6 done', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    const steps = computeOnboardingChecklist(await load('pa'));
    expect(steps.slice(0, 6).every((s) => s.done)).toBe(true);
    expect(steps[6].done).toBe(false);
  });
});

describe('loadOnboardingFacts: each fact', () => {
  const only = async (): Promise<OnboardingFacts> => load('pa');

  it('WhatsApp: nothing stored → not configured (shared number is not "connected")', async () => {
    expect((await only()).whatsappOwnConfigured).toBe(false);
  });
  it('WhatsApp: pnid + token without the app secret → not configured', async () => {
    const i = completeIntegrations('555666777888');
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', { ...i, whatsapp: { phoneNumberId: '555666777888', token: 't' } });
    expect((await only()).whatsappOwnConfigured).toBe(false);
  });
  it('WhatsApp test: a failing or missing test result is not ok; a passing one is', async () => {
    expect((await only()).whatsappTestOk).toBe(false);
    await redis.set('watest:pa', JSON.stringify({ ok: false, at: new Date().toISOString(), status: 401 }));
    expect((await only()).whatsappTestOk).toBe(false);
    await redis.set('watest:pb', JSON.stringify({ ok: true, at: new Date().toISOString() }));
    expect((await only()).whatsappTestOk).toBe(false);
    await redis.set('watest:pa', JSON.stringify({ ok: true, at: new Date().toISOString() }));
    expect((await only()).whatsappTestOk).toBe(true);
  });
  it('inbound: only a WhatsApp INBOUND message counts (not outbound, not web)', async () => {
    await seedInboundMessage(db, 'pa', { direction: 2 });
    await seedInboundMessage(db, 'pa', { channel: 2 });
    expect((await only()).whatsappInboundSeen).toBe(false);
    await seedInboundMessage(db, 'pa');
    expect((await only()).whatsappInboundSeen).toBe(true);
  });
  it('attestation: only this tenant’s partner.templates.attest row counts', async () => {
    await db.insert(auditEvents).values({ partnerId: 'pb', actor: 'x', actorType: 'staff', action: 'partner.templates.attest', subjectId: 'pb', meta: {} });
    // a row naming pa as subject but written under pb's tenant is not pa's attestation
    await db.insert(auditEvents).values({ partnerId: 'pb', actor: 'x', actorType: 'staff', action: 'partner.templates.attest', subjectId: 'pa', meta: {} });
    expect((await only()).templatesAttested).toBe(false);
    await db.insert(auditEvents).values({ partnerId: 'pa', actor: 'x', actorType: 'staff', action: 'partner.templates.attest', subjectId: 'pa', meta: {} });
    expect((await only()).templatesAttested).toBe(true);
  });
  it('sandbox key: a live key or a revoked test key does not count', async () => {
    const repo = createApiKeyRepo(db);
    await repo.issue('pa', 'live');
    const k = await repo.issue('pa', 'test');
    await repo.revoke(k.keyId, 'pa');
    expect((await only()).sandboxKeyActive).toBe(false);
    await repo.issue('pa', 'test');
    expect((await only()).sandboxKeyActive).toBe(true);
    expect((await db.select().from(apiKeys).where(eq(apiKeys.partnerId, 'pa'))).length).toBe(3);
  });
  it('sandbox key: the pk_test_ prefix is matched literally (LIKE "_" is escaped)', async () => {
    await db.insert(apiKeys).values({ id: 'pkXtestXabc', partnerId: 'pa', keyHash: 'h-like-pin', last4: 'abcd' });
    expect((await only()).sandboxKeyActive).toBe(false);
  });
  it('sandbox transfer: a live delivered or a test not-yet-delivered transfer does not count', async () => {
    await seedPartnerTransfer(db, { id: 'tr_live', partnerId: 'pa', environment: 'live', status: 'delivered' });
    await seedPartnerTransfer(db, { id: 'tr_test_paid', partnerId: 'pa', environment: 'test', status: 'paid' });
    expect((await only()).sandboxTransferDelivered).toBe(false);
    await seedPartnerTransfer(db, { id: 'tr_test_ok', partnerId: 'pa', environment: 'test', status: 'delivered' });
    expect((await only()).sandboxTransferDelivered).toBe(true);
    expect((await db.select().from(transfers).where(and(eq(transfers.partnerId, 'pa')))).length).toBe(3);
  });
  it('webhook: a non-http rail is not a partner rail; a SmartRemit URL is not valid', async () => {
    const i = completeIntegrations('555666777888');
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', { ...i, payment: { ...i.payment, providerType: 'simulator' } });
    expect((await only()).partnerRail).toBe(false);
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', {
      ...i,
      payment: { ...i.payment, credentials: { ...i.payment.credentials, settlementUrl: 'https://smartremit.ai/api/rail' } },
    });
    const f = await only();
    expect(f.partnerRail).toBe(true);
    expect(f.endpointUrlValid).toBe(false);
  });
  it('ping: only an ok ping within 30 days counts', async () => {
    const now = new Date();
    await seedPing(db, 'pa', { outcome: 'http_error' });
    await seedPing(db, 'pa', { createdAt: new Date(now.getTime() - 31 * DAY) });
    expect((await load('pa', now)).recentPingOk).toBe(false);
    await seedPing(db, 'pa', { createdAt: new Date(now.getTime() - 29 * DAY) });
    expect((await load('pa', now)).recentPingOk).toBe(true);
  });
  it('ping: an ok ping from BEFORE the latest endpoint update does not count; a newer one does', async () => {
    const now = new Date();
    const endpointUpdate = (pid: string, at: Date) =>
      db.insert(auditEvents).values({ partnerId: pid, actor: 'x', actorType: 'staff', action: 'partner.settlement_endpoint.update', subjectId: pid, meta: {}, at });
    await seedPing(db, 'pa', { createdAt: new Date(now.getTime() - 2 * DAY) });
    expect((await load('pa', now)).recentPingOk).toBe(true);
    await endpointUpdate('pa', new Date(now.getTime() - DAY));
    expect((await load('pa', now)).recentPingOk).toBe(false);
    // another tenant's (later) endpoint update never affects pa
    await seedPing(db, 'pa', { createdAt: new Date(now.getTime() - DAY / 2) });
    await endpointUpdate('pb', new Date(now.getTime() - DAY / 4));
    expect((await load('pa', now)).recentPingOk).toBe(true);
  });
  it('branding: slug; a validated primary colour; a renderable logo', async () => {
    await db.update(partners).set({ primaryColor: 'not-a-colour' }).where(eq(partners.id, 'pa'));
    let f = await only();
    expect([f.slugClaimed, f.primaryColorSet, f.logoSet]).toEqual([false, false, false]);
    await db.insert(partnerSites).values({ partnerId: 'pa', slug: 'pa-site' });
    await db.update(partners).set({ primaryColor: '#0b5d4b', logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }).where(eq(partners.id, 'pa'));
    f = await only();
    expect([f.slugClaimed, f.primaryColorSet, f.logoSet]).toEqual([true, true, true]);
  });
  it('go-live: requested / approved read from this tenant’s row; partnerActive from partners.status', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pb', requestedAt: new Date(), requestedBy: 'b', approvedAt: new Date(), approvedBy: 'x' });
    let f = await only();
    expect([f.goLiveRequested, f.goLiveApproved, f.partnerActive]).toEqual([false, false, true]);
    await db.insert(partnerGoLive).values({ partnerId: 'pa', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    await db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, 'pa'));
    f = await only();
    expect([f.goLiveRequested, f.goLiveApproved, f.partnerActive]).toEqual([false, true, false]);
  });
});

describe('loadOnboardingFacts: returns booleans only', () => {
  it('no secret, URL or identifier leaves the loader', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    const f = await load('pa');
    for (const v of Object.values(f)) expect(typeof v).toBe('boolean');
  });
});
