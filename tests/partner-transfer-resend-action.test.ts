import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Lost-features restore p1 A3: resend the payment link from /partner. Through the OUTBOX (the
// durable effect, sent on the owning partner's WhatsApp number by the worker), never inline. Admin
// always; an agent only with canResend. Refused for anything but a live, unpaid, uncharged
// transfer; for an opted-out customer; and outside WhatsApp's 24-hour window (staff are told the
// customer can't be reached, rather than a row that would fail, retry and alert). One resend per
// transfer per 10 minutes (the outbox dedupe key). One transfer.paylink.resend row with the enqueue.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
const pokes = vi.hoisted(() => ({ n: 0 }));

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
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});
vi.mock('@/lib/outbox', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outbox')>('@/lib/outbox');
  return { ...actual, pokeWorker: () => void pokes.n++ };
});

import { resendPayLinkAction } from '@/app/partner/(app)/transfers/[id]/ops-actions';
import { auditEvents, outbox } from '@/db/schema';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { payUrlFor } from '@/lib/pay-url';
import { t } from '@/lib/i18n';

const PHONE = '14155550101';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const form = (id: string) => {
  const fd = new FormData();
  fd.set('id', id);
  return fd;
};
const outboxRows = async () =>
  ((await db.execute(sql`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
    rows: Array<{ kind: string; payload: Record<string, unknown>; dedupe_key: string }>;
  }).rows;
const count = async (table: typeof auditEvents | typeof outbox) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;
const snapshot = async () => ({ audit: await count(auditEvents), outbox: await count(outbox) });
const inWindow = (partnerId: string, phone = PHONE) => redis.set(`lastmsg:${partnerId}:${phone}`, new Date().toISOString(), { ex: 86400 });
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  pokes.n = 0;
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A1', partnerId: 'pa', phone: PHONE, status: 'awaiting_payment' });
  await seedPartnerTransfer(db, { id: 'tr_B1', partnerId: 'pb', phone: PHONE, status: 'awaiting_payment' });
  await inWindow('pa');
  await inWindow('pb');
});

describe('resendPayLinkAction', () => {
  it('the shared action contract', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: resendPayLinkAction,
      form,
      ownId: 'tr_A1',
      foreignId: 'tr_B1',
      allowedRole: 'admin',
      disallowedRole: 'support',
      snapshot,
    });
  });
  it('queues ONE whatsapp.text row on the owning partner (no creds), nonessential, deduped per 10 minutes, with its audit row', async () => {
    await asAdmin();
    expect(await resendPayLinkAction(form('tr_A1'))).toEqual({ ok: true });
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('whatsapp.text');
    expect(rows[0].payload).toEqual({ to: PHONE, body: `Here is your secure payment link again: ${payUrlFor('tr_A1')}`, partnerId: 'pa', category: 'nonessential' });
    expect(rows[0].dedupe_key).toMatch(/^paylink:tr_A1:\d+$/);
    expect(pokes.n).toBe(1);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.paylink.resend'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', subjectId: 'tr_A1' });
    expect(audit[0].meta).toEqual({ reason: null, actorScope: 'partner' });
    expect(JSON.stringify(audit[0])).not.toContain(PHONE);

    expect(await resendPayLinkAction(form('tr_A1'))).toEqual({ ok: false, error: t('partner.transferOps.resend.recent') });
    expect(await outboxRows()).toHaveLength(1);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.paylink.resend'))).toHaveLength(1);
  });
  it('an agent needs canResend; finance and support are bounced by the gate', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    expect(await resendPayLinkAction(form('tr_A1'))).toEqual({ ok: false, error: t('partner.transferOps.noPermission') });
    expect(await count(outbox)).toBe(0);
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent', permissions: { ...perms, canResend: true } });
    expect(await resendPayLinkAction(form('tr_A1'))).toEqual({ ok: true });
    await signInAs(redis, cookieJar, { username: 'pa-fin', partnerId: 'pa', role: 'finance' as Staff['role'] });
    await expect(resendPayLinkAction(form('tr_A1'))).rejects.toThrow(/^REDIRECT:/);
  });
  it('refused (nothing queued) for paid, charged, intent-bound and sandbox transfers', async () => {
    await seedPartnerTransfer(db, { id: 'tr_paid', partnerId: 'pa', phone: PHONE, status: 'paid' });
    await seedPartnerTransfer(db, { id: 'tr_chg', partnerId: 'pa', phone: PHONE, status: 'awaiting_payment', fundingRef: 'ch_1' });
    await seedPartnerTransfer(db, { id: 'tr_pi', partnerId: 'pa', phone: PHONE, status: 'awaiting_payment' });
    await db.execute(sql`UPDATE transfers SET funding_intent_ref = 'pi_1', funding_state = 'pending' WHERE id = 'tr_pi'`);
    await seedPartnerTransfer(db, { id: 'tr_sbx', partnerId: 'pa', phone: PHONE, status: 'awaiting_payment', environment: 'test' });
    await asAdmin();
    for (const id of ['tr_paid', 'tr_chg', 'tr_pi', 'tr_sbx']) {
      expect(await resendPayLinkAction(form(id)), id).toEqual({ ok: false, error: t('partner.transferOps.resend.notAllowed') });
    }
    expect(await snapshot()).toEqual({ audit: 0, outbox: 0 });
  });
  it('an opted-out customer is refused with a clear message', async () => {
    await createCustomerRepo(db, async () => null).ensureCustomer('pa', PHONE);
    await db.execute(sql`UPDATE customers SET opted_out_at = now() WHERE partner_id = 'pa' AND phone = ${PHONE}`);
    await asAdmin();
    expect(await resendPayLinkAction(form('tr_A1'))).toEqual({ ok: false, error: t('partner.transferOps.resend.optedOut') });
    expect(await snapshot()).toEqual({ audit: 0, outbox: 0 });
  });
  it('outside the 24-hour WhatsApp window: staff are told it cannot reach the customer; nothing queued (no retries, no alert)', async () => {
    await redis.del(`lastmsg:pa:${PHONE}`);
    await asAdmin();
    expect(await resendPayLinkAction(form('tr_A1'))).toEqual({ ok: false, error: t('partner.transferOps.resend.outsideWindow') });
    expect(await snapshot()).toEqual({ audit: 0, outbox: 0 });
    // Another tenant's window for the same phone does not count.
    expect(await redis.get(`lastmsg:pb:${PHONE}`)).not.toBeNull();
  });
});
