import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Lost-features restore p1 A2: assign a transfer from /partner. Admin always; an agent only with
// canAssign; support and finance never (the gate). The assignee must be an active admin or agent
// of THIS tenant (never a SmartRemit account, a test account, another tenant's staff). One
// transfer.assign row with the write; adminNote is never touched.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});

import { assignTransferAction } from '@/app/partner/(app)/transfers/[id]/ops-actions';
import { auditEvents, transfers } from '@/db/schema';
import { getAuthStore } from '@/lib/auth-store';
import { t } from '@/lib/i18n';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const form = (id: string, assignee = 'pa-worker', note = '') => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('assignee', assignee);
  if (note) fd.set('assignNote', note);
  return fd;
};
const row = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0];
const assignRows = () => db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.assign')).orderBy(auditEvents.id);
const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n;
const snapshot = async () => ({ a: (await row('tr_A1')).assignedTo, b: (await row('tr_B1')).assignedTo, audit: await count() });
const saveStaff = (o: Partial<Staff>) =>
  getAuthStore().saveStaff({ username: 'x', name: 'X', role: 'agent', permissions: perms, passwordHash: 'h', createdAt: '', ...o } as Staff);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A1', partnerId: 'pa', adminNote: 'rail failure note' });
  await seedPartnerTransfer(db, { id: 'tr_B1', partnerId: 'pb' });
  await saveStaff({ username: 'pa-worker', partnerId: 'pa' });
  await saveStaff({ username: 'pa-boss', partnerId: 'pa', role: 'admin' });
  await saveStaff({ username: 'pa-sup', partnerId: 'pa', role: 'support' });
  await saveStaff({ username: 'pa-fin', partnerId: 'pa', role: 'finance' as Staff['role'] });
  await saveStaff({ username: 'pa-gone', partnerId: 'pa', status: 'suspended' });
  await saveStaff({ username: 'e2e-smoke-agent', partnerId: 'pa' });
  await saveStaff({ username: 'pb-worker', partnerId: 'pb' });
  await saveStaff({ username: 'plat-admin', role: 'admin' });
});

describe('assignTransferAction', () => {
  it('the shared action contract', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: assignTransferAction,
      form: (id) => form(id),
      ownId: 'tr_A1',
      foreignId: 'tr_B1',
      allowedRole: 'admin',
      disallowedRole: 'support',
      snapshot,
    });
  });
  it('finance is bounced by the gate', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-f', partnerId: 'pa', role: 'finance' as Staff['role'] });
    await expect(assignTransferAction(form('tr_A1'))).rejects.toThrow(/^REDIRECT:/);
  });
  it('an agent without canAssign is refused and nothing is written; with it, the assignment lands', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    const before = await snapshot();
    expect(await assignTransferAction(form('tr_A1'))).toEqual({ ok: false, error: t('partner.transferOps.noPermission') });
    expect(await snapshot()).toEqual(before);
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent', permissions: { ...perms, canAssign: true } });
    expect(await assignTransferAction(form('tr_A1', 'pa-boss', 'please call the customer'))).toEqual({ ok: true });
    const r = await row('tr_A1');
    expect(r.assignedTo).toBe('pa-boss');
    expect(r.adminNote).toBe('rail failure note');
    const [a] = await assignRows();
    expect(a).toMatchObject({ partnerId: 'pa', actor: 'pa-agent', subjectId: 'tr_A1' });
    expect(a.meta).toEqual({ assignee: 'pa-boss', previousAssignee: null, note: 'please call the customer', reason: null, actorScope: 'partner' });
  });
  it('every ineligible assignee gets one message and nothing is written', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const before = await snapshot();
    for (const who of ['pb-worker', 'plat-admin', 'pa-sup', 'pa-fin', 'pa-gone', 'e2e-smoke-agent', 'nobody', 'x'.repeat(200)]) {
      expect(await assignTransferAction(form('tr_A1', who)), who).toEqual({ ok: false, error: t('partner.transferOps.assign.invalid') });
    }
    expect(await snapshot()).toEqual(before);
  });
  it('unassign with an empty assignee; the same assignee again is ok with no second row', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    expect(await assignTransferAction(form('tr_A1'))).toEqual({ ok: true });
    expect(await assignTransferAction(form('tr_A1'))).toEqual({ ok: true });
    expect(await assignRows()).toHaveLength(1);
    expect(await assignTransferAction(form('tr_A1', ''))).toEqual({ ok: true });
    expect((await row('tr_A1')).assignedTo).toBeNull();
    expect(await assignRows()).toHaveLength(2);
  });
  it('a note with a phone-length number is refused', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    expect(await assignTransferAction(form('tr_A1', 'pa-worker', 'call 14155550101'))).toEqual({ ok: false, error: t('partner.transferOps.assign.noteHasNumber') });
    expect(await assignRows()).toHaveLength(0);
  });
});
