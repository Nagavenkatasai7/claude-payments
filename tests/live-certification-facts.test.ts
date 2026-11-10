import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import { seedOnboardingComplete } from './helpers-partner-onboarding';
import type { Db } from '@/db/client';
import type { Staff, StaffRole } from '@/lib/types';

// Fix pack 3 (contract 8): loadLiveReadinessFacts reads ONLY the given
// tenant's facts, never catches (callers fail closed), and returns booleans,
// enums and usernames only.

const redis = fakeRedis();
let db: Db;
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
const fitness = vi.hoisted(() => vi.fn(async (_now: Date): Promise<'live' | 'stale' | 'not_live'> => 'live'));
vi.mock('@/lib/sanctions/list-health', async (orig) => ({
  ...(await orig<typeof import('@/lib/sanctions/list-health')>()),
  sanctionsListFitnessNow: fitness,
}));

import { partnerGoLive } from '@/db/schema';
import { loadLiveReadinessFacts } from '@/db/repos/live-certification-facts';
import { getAuthStore } from '@/lib/auth-store';
import { staffMfaKeys } from '@/lib/staff-mfa-store';

async function seedStaff(username: string, o: { partnerId?: string; role?: StaffRole; status?: Staff['status']; mfa?: boolean } = {}) {
  const s: Staff = {
    username,
    name: `Name of ${username}`,
    role: o.role ?? 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    passwordHash: 'HASH',
    createdAt: new Date().toISOString(),
    ...(o.partnerId !== undefined ? { partnerId: o.partnerId } : {}),
    ...(o.status !== undefined ? { status: o.status } : {}),
  };
  await getAuthStore().saveStaff(s);
  if (o.mfa !== false) await redis.set(staffMfaKeys.secret(username), 'sealed');
}

const approve = (partnerId: string) =>
  db.insert(partnerGoLive).values({ partnerId, requestedAt: new Date(), requestedBy: `${partnerId}-admin`, approvedAt: new Date(), approvedBy: 'x' });

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  fitness.mockReset();
  fitness.mockResolvedValue('live');
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('loadLiveReadinessFacts', () => {
  it('goLiveApproved follows partner_go_live.approved_at (isLiveApproved)', async () => {
    expect((await loadLiveReadinessFacts(db, 'pa', new Date())).goLiveApproved).toBe(false);
    await db.insert(partnerGoLive).values({ partnerId: 'pa', requestedAt: new Date(), requestedBy: 'pa-admin' });
    expect((await loadLiveReadinessFacts(db, 'pa', new Date())).goLiveApproved).toBe(false);
    await approve('pb');
    expect((await loadLiveReadinessFacts(db, 'pa', new Date())).goLiveApproved).toBe(false);
    expect((await loadLiveReadinessFacts(db, 'pb', new Date())).goLiveApproved).toBe(true);
  });

  it('listFitness is sanctionsListFitnessNow(now) with the given now', async () => {
    const now = new Date(Date.now() - 5 * 60_000);
    fitness.mockResolvedValueOnce('stale');
    expect((await loadLiveReadinessFacts(db, 'pa', now)).listFitness).toBe('stale');
    expect(fitness).toHaveBeenCalledWith(now);
    expect((await loadLiveReadinessFacts(db, 'pa', now)).listFitness).toBe('live');
  });

  it('ownWhatsapp follows loadOnboardingFacts.whatsappOwnConfigured', async () => {
    expect((await loadLiveReadinessFacts(db, 'pa', new Date())).ownWhatsapp).toBe(false);
    await seedOnboardingComplete(db, redis, 'pa');
    expect((await loadLiveReadinessFacts(db, 'pa', new Date())).ownWhatsapp).toBe(true);
  });

  it('complianceStaff: one entry per LISTED username; unknown left out; an unlisted tenant admin is not loaded', async () => {
    await seedStaff('pa-comp1', { partnerId: 'pa', role: 'admin' });
    await seedStaff('pa-comp2', { partnerId: 'pa', role: 'agent', status: 'suspended', mfa: false });
    await seedStaff('pa-boss', { partnerId: 'pa', role: 'admin' });
    await seedStaff('platform-op', { role: 'support' });
    await certifyPartnerForTest(db, 'pa', { complianceUsers: ['pa-comp1', 'pa-comp2', 'platform-op', 'pa-ghost'] });
    const f = await loadLiveReadinessFacts(db, 'pa', new Date());
    const byName = [...f.complianceStaff].sort((a, b) => a.username.localeCompare(b.username));
    expect(byName).toEqual([
      { username: 'pa-comp1', partnerId: 'pa', role: 'admin', active: true, mfaEnrolled: true },
      { username: 'pa-comp2', partnerId: 'pa', role: 'agent', active: false, mfaEnrolled: false },
      { username: 'platform-op', partnerId: undefined, role: 'support', active: true, mfaEnrolled: true },
    ]);
    // booleans, enums and usernames only: no names, password hashes or permissions
    expect(JSON.stringify(f)).not.toContain('Name of');
    expect(JSON.stringify(f)).not.toContain('HASH');
  });

  it('a db error throws (callers fail closed)', async () => {
    const broken = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'select') return () => { throw new Error('db down'); };
        return Reflect.get(target, prop, recv);
      },
    }) as Db;
    await expect(loadLiveReadinessFacts(broken, 'pa', new Date())).rejects.toThrow('db down');
  });

  it("reads only this tenant's rows", async () => {
    await seedOnboardingComplete(db, redis, 'pb', '111222333444');
    await approve('pb');
    await seedStaff('pb-comp1', { partnerId: 'pb' });
    await seedStaff('pb-comp2', { partnerId: 'pb' });
    await certifyPartnerForTest(db, 'pb', { posture: true, complianceUsers: ['pb-comp1', 'pb-comp2'] });
    const fa = await loadLiveReadinessFacts(db, 'pa', new Date());
    expect(fa).toEqual({ goLiveApproved: false, listFitness: 'live', ownWhatsapp: false, complianceStaff: [] });
    const fb = await loadLiveReadinessFacts(db, 'pb', new Date());
    expect(fb.goLiveApproved).toBe(true);
    expect(fb.ownWhatsapp).toBe(true);
    expect(fb.complianceStaff.map((s) => s.username).sort()).toEqual(['pb-comp1', 'pb-comp2']);
  });

  it('an unknown partner reads as no facts (no listed users)', async () => {
    const f = await loadLiveReadinessFacts(db, 'nobody', new Date());
    expect(f.goLiveApproved).toBe(false);
    expect(f.complianceStaff).toEqual([]);
  });
});
