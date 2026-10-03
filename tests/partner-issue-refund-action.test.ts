import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Lost-features restore p1 A7: Issue refund from /partner. A MONEY action through the ONE refund
// core (dashboard-ops.issueRefund, tenant-scoped): admin only, a typed reason, a fresh 'refund.issue'
// step-up checked after the input and before any write, an explicit clawback tick when the money
// was already delivered, and BL-2: a transfer another partner pays out is refused in every status
// (re-checked inside the money transaction). One funding.refund row `refund:<id>` + one
// refund.issue audit row, together. The real step-up gate is covered in
// partner-step-up-actions.test.ts; here it is a spy so the contract and the ordering can be pinned.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
const gate = vi.hoisted(() => ({ result: null as unknown, calls: [] as string[], during: null as null | (() => Promise<unknown>) }));
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
vi.mock('@/lib/partner-step-up-gate', () => ({
  gatePartnerStepUp: async (_ctx: unknown, _fd: FormData, target: string) => {
    gate.calls.push(target);
    if (gate.during) await gate.during();
    return gate.result;
  },
}));
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: () => void pokes.n++ }));

import { issueRefundAction } from '@/app/partner/(app)/transfers/[id]/refund-actions';
import { auditEvents, outbox, transfers } from '@/db/schema';
import { t } from '@/lib/i18n';

const REASON = 'customer disputed the charge';
const STEP_UP = { ok: false, code: 'step_up_required', factor: 'password', error: 'step up' } as const;
const form = (id: string, o: { reason?: string; clawback?: boolean } = {}) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('reason', o.reason ?? REASON);
  if (o.clawback) fd.set('clawback', 'yes');
  return fd;
};
const refundStatus = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0].refundStatus;
const outboxRows = async () =>
  ((await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as { rows: Array<{ kind: string; dedupe_key: string }> }).rows;
const count = async (table: typeof auditEvents | typeof outbox) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;
const snapshot = async () => ({ a: await refundStatus('tr_A1'), b: await refundStatus('tr_B1'), audit: await count(auditEvents), outbox: await count(outbox) });
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
const refused = (k: Parameters<typeof t>[0]) => ({ ok: false, error: t(k) });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  gate.result = null;
  gate.calls = [];
  gate.during = null;
  pokes.n = 0;
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A1', partnerId: 'pa', status: 'paid', fundingRef: 'ch_a1' });
  await seedPartnerTransfer(db, { id: 'tr_B1', partnerId: 'pb', status: 'paid', fundingRef: 'ch_b1' });
});

describe('issueRefundAction', () => {
  it('the shared action contract (agent is not admin)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: issueRefundAction,
      form: (id) => form(id),
      ownId: 'tr_A1',
      foreignId: 'tr_B1',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
  });
  it('support and finance are bounced by the gate too', async () => {
    for (const role of ['support', 'finance'] as Staff['role'][]) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(issueRefundAction(form('tr_A1'))).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await snapshot()).toEqual({ a: 'none', b: 'none', audit: 0, outbox: 0 });
  });
  it('refunds through the one core: ONE funding.refund row and ONE refund.issue row with the reason; the step-up target is refund.issue', async () => {
    await asAdmin();
    expect(await issueRefundAction(form('tr_A1'))).toEqual({ ok: true });
    expect(gate.calls).toEqual(['refund.issue']);
    expect(await refundStatus('tr_A1')).toBe('pending');
    expect(await outboxRows()).toEqual([{ kind: 'funding.refund', dedupe_key: 'refund:tr_A1' }]);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'refund.issue'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', subjectId: 'tr_A1' });
    expect(rows[0].meta).toMatchObject({ reason: REASON, actorScope: 'partner', previousRefundStatus: 'none', refundStatus: 'pending' });
    expect(pokes.n).toBe(1);
    // A double submit: refused, still one effect and one row.
    expect(await issueRefundAction(form('tr_A1'))).toEqual(refused('partner.transferOps.refund.already'));
    expect(await outboxRows()).toHaveLength(1);
    expect(await count(auditEvents)).toBe(1);
  });
  it('a stale step-up returns step_up_required and writes nothing', async () => {
    await asAdmin();
    gate.result = STEP_UP;
    expect(await issueRefundAction(form('tr_A1'))).toEqual(STEP_UP);
    expect(await snapshot()).toEqual({ a: 'none', b: 'none', audit: 0, outbox: 0 });
  });
  it('the reason is checked before the step-up: short, or carrying a phone-length number, is refused', async () => {
    await asAdmin();
    expect(await issueRefundAction(form('tr_A1', { reason: 'too short' }))).toEqual(refused('partner.transferOps.refund.reasonTooShort'));
    expect(await issueRefundAction(form('tr_A1', { reason: 'refund to 000011112222 please' }))).toEqual(refused('partner.transferOps.refund.reasonHasNumber'));
    expect(gate.calls).toEqual([]);
    expect(await count(outbox)).toBe(0);
  });
  it('a delivered transfer needs the explicit clawback tick', async () => {
    await seedPartnerTransfer(db, { id: 'tr_dlv', partnerId: 'pa', status: 'delivered', fundingRef: 'ch_d' });
    await asAdmin();
    expect(await issueRefundAction(form('tr_dlv'))).toEqual(refused('partner.transferOps.refund.clawbackRequired'));
    expect(gate.calls).toEqual([]);
    expect(await count(outbox)).toBe(0);
    expect(await issueRefundAction(form('tr_dlv', { clawback: true }))).toEqual({ ok: true });
    expect(await refundStatus('tr_dlv')).toBe('pending');
  });
  it('BL-2: a transfer another partner pays out is refused in every status, before the step-up; nothing queued', async () => {
    await asAdmin();
    for (const status of ['paid', 'delivered', 'awaiting_payment', 'in_review', 'cancelled'] as const) {
      const id = `tr_rt_${status}`;
      await seedPartnerTransfer(db, { id, partnerId: 'pa', status, fundingRef: 'ch_r' });
      await db.execute(sql`UPDATE transfers SET settlement_partner_id = 'pb' WHERE id = ${id}`);
      expect(await issueRefundAction(form(id, { clawback: true })), status).toEqual(refused('partner.transferOps.refund.routed'));
    }
    expect(gate.calls).toEqual([]);
    expect(await count(outbox)).toBe(0);
    expect(await count(auditEvents)).toBe(0);
  });
  it('BL-2 inside the transaction: a transfer routed after the eligibility read is still refused, nothing queued', async () => {
    await asAdmin();
    // The step-up runs after the eligibility read and before the core: route the row there.
    gate.during = () => db.execute(sql`UPDATE transfers SET settlement_partner_id = 'pb' WHERE id = 'tr_A1'`);
    expect(await issueRefundAction(form('tr_A1'))).toEqual(refused('partner.transferOps.refund.notAllowed'));
    expect(await count(outbox)).toBe(0);
    expect(await count(auditEvents)).toBe(0);
    expect(await refundStatus('tr_A1')).toBe('none');
  });
  it('the other refusals map to their own copy', async () => {
    await seedPartnerTransfer(db, { id: 'tr_unpaid', partnerId: 'pa', status: 'awaiting_payment' });
    await seedPartnerTransfer(db, { id: 'tr_nochg', partnerId: 'pa', status: 'paid' });
    await seedPartnerTransfer(db, { id: 'tr_req', partnerId: 'pa', status: 'paid', fundingRef: 'ch', refundStatus: 'requested' });
    await seedPartnerTransfer(db, { id: 'tr_sbx', partnerId: 'pa', status: 'paid', fundingRef: 'ch', environment: 'test' });
    await asAdmin();
    expect(await issueRefundAction(form('tr_unpaid'))).toEqual(refused('partner.transferOps.refund.wrongStatus'));
    expect(await issueRefundAction(form('tr_nochg'))).toEqual(refused('partner.transferOps.refund.notCharged'));
    expect(await issueRefundAction(form('tr_req'))).toEqual(refused('partner.transferOps.refund.already'));
    expect(await issueRefundAction(form('tr_sbx'))).toEqual(refused('partner.transferOps.refund.sandbox'));
    expect(await count(outbox)).toBe(0);
  });
});
