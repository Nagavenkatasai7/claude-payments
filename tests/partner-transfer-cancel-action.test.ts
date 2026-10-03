import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Lost-features restore p1 A1: cancel an unpaid transfer from /partner. Admin always; an agent only
// with canCancel; support and finance never (the gate). A typed reason (the ConfirmDialog minimum,
// no phone-length number) is required. The shared cancel rule (decideStaffCancel + the guarded
// claim) decides; refusals come back as translated copy. One transfer.cancel row with the flip.
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

import { cancelTransferAction } from '@/app/partner/(app)/transfers/[id]/ops-actions';
import { auditEvents, transfers } from '@/db/schema';
import { t } from '@/lib/i18n';

const REASON = 'customer asked us to stop';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const form = (id: string, reason = REASON) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('reason', reason);
  return fd;
};
const status = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0].status;
const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n;
const snapshot = async () => ({ a: await status('tr_A1'), b: await status('tr_B1'), audit: await count() });
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A1', partnerId: 'pa', status: 'awaiting_payment' });
  await seedPartnerTransfer(db, { id: 'tr_B1', partnerId: 'pb', status: 'awaiting_payment' });
});

describe('cancelTransferAction', () => {
  it('the shared action contract', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: cancelTransferAction,
      form: (id) => form(id),
      ownId: 'tr_A1',
      foreignId: 'tr_B1',
      allowedRole: 'admin',
      disallowedRole: 'support',
      snapshot,
    });
  });
  it('cancels with ONE transfer.cancel row carrying the reason and the partner scope', async () => {
    await asAdmin();
    expect(await cancelTransferAction(form('tr_A1'))).toEqual({ ok: true });
    expect(await status('tr_A1')).toBe('cancelled');
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.cancel'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', subjectId: 'tr_A1' });
    expect(rows[0].meta).toEqual({ previousStatus: 'awaiting_payment', newStatus: 'cancelled', reason: REASON, actorScope: 'partner' });
    // A second click is a quiet success with no second row.
    expect(await cancelTransferAction(form('tr_A1'))).toEqual({ ok: true });
    expect(await count()).toBe(1);
  });
  it('an agent needs canCancel; finance is bounced by the gate', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    expect(await cancelTransferAction(form('tr_A1'))).toEqual({ ok: false, error: t('partner.transferOps.noPermission') });
    expect(await status('tr_A1')).toBe('awaiting_payment');
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent', permissions: { ...perms, canCancel: true } });
    expect(await cancelTransferAction(form('tr_A1'))).toEqual({ ok: true });
    await signInAs(redis, cookieJar, { username: 'pa-fin', partnerId: 'pa', role: 'finance' as Staff['role'] });
    await expect(cancelTransferAction(form('tr_A1'))).rejects.toThrow(/^REDIRECT:/);
  });
  it('a short or missing reason, or one carrying a phone-length number, is refused before any write', async () => {
    await asAdmin();
    const before = await snapshot();
    expect(await cancelTransferAction(form('tr_A1', 'too short'))).toEqual({ ok: false, error: t('partner.transferOps.cancel.reasonTooShort') });
    expect(await cancelTransferAction(form('tr_A1', ''))).toEqual({ ok: false, error: t('partner.transferOps.cancel.reasonTooShort') });
    expect(await cancelTransferAction(form('tr_A1', 'call them on 14155550101'))).toEqual({ ok: false, error: t('partner.transferOps.cancel.reasonHasNumber') });
    expect(await snapshot()).toEqual(before);
  });
  it('the shared rule refuses paid, held, charged and blocked rows with translated copy; nothing written', async () => {
    await seedPartnerTransfer(db, { id: 'tr_paid', partnerId: 'pa', status: 'paid' });
    await seedPartnerTransfer(db, { id: 'tr_hold', partnerId: 'pa', status: 'in_review' });
    await seedPartnerTransfer(db, { id: 'tr_chg', partnerId: 'pa', status: 'awaiting_payment', fundingRef: 'ch_1' });
    await seedPartnerTransfer(db, { id: 'tr_blk', partnerId: 'pa', status: 'blocked' });
    await asAdmin();
    expect(await cancelTransferAction(form('tr_paid'))).toEqual({ ok: false, error: t('partner.transferOps.cancel.refused.paid') });
    expect(await cancelTransferAction(form('tr_hold'))).toEqual({ ok: false, error: t('partner.transferOps.cancel.refused.inReview') });
    expect(await cancelTransferAction(form('tr_chg'))).toEqual({ ok: false, error: t('partner.transferOps.cancel.refused.charged') });
    expect(await cancelTransferAction(form('tr_blk'))).toEqual({ ok: false, error: t('partner.transferOps.cancel.refused.blocked') });
    expect(await count()).toBe(0);
  });
});
