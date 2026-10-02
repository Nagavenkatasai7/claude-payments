import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore, type Store } from '@/lib/store';
import type { Db } from '@/db/client';

// Merge plan 2c (owner D4): rejectHoldAction — reject & refund of a held transfer from /partner. A
// MONEY write that reuses the ONE reject path (dashboard-ops rejectTransfer: the guarded cancel,
// the `transfer.reject` audit row and, when charged, refund pending + funding.refund in one
// transaction). Allowed only on holds the partner may release.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
const host = { value: 'smartremit.ai' };
let db: Db;
let store: Store;
let pgPartnerStore: PartnerStore;
const revalidated: string[] = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
// `afterRead` runs right after the (real) sender pre-check read: the window before the claim.
const screeningRead: { fail: boolean; afterRead: null | (() => Promise<unknown>) } = { fail: false, afterRead: null };
vi.mock('@/db/repos/customer-repo', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/customer-repo')>('@/db/repos/customer-repo');
  return {
    ...actual,
    readSenderScreeningFlags: async (...a: Parameters<typeof actual.readSenderScreeningFlags>) => {
      if (screeningRead.fail) throw new Error('connection reset');
      const r = await actual.readSenderScreeningFlags(...a);
      if (screeningRead.afterRead) await screeningRead.afterRead();
      return r;
    },
  };
});

import { rejectHoldAction } from '@/app/partner/(app)/transfers/[id]/reject-actions';
import { auditEvents, outbox, transfers } from '@/db/schema';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { EDD_REQUIRED_REASON as EDD, LARGE_AMOUNT_REASON as LARGE, SCREENING_REASONS } from '@/lib/compliance-config';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { t } from '@/lib/i18n';

const REASON = 'Sender could not show the source of funds.';
const form = (id: string, reason = REASON) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('reason', reason);
  return fd;
};
const transferRow = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0];
const count = async (table: typeof auditEvents | typeof outbox) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;
const outboxRows = async () =>
  ((await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as { rows: Array<{ kind: string; dedupe_key: string }> }).rows;
const rejectRows = () => db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.reject')).orderBy(auditEvents.id);
const snapshot = async () => ({
  audit: await count(auditEvents),
  outbox: await count(outbox),
  ta: await transferRow('tr_heldA1'),
  tb: await transferRow('tr_heldB1'),
});

const SENDER = '14155550101';
const seedSender = (partnerId: string) => createCustomerRepo(db, async () => null).ensureCustomer(partnerId, SENDER);
const flagSender = (partnerId: string, col: 'pep_hit' | 'watchlist_hit') =>
  db.execute(sql`UPDATE customers SET ${sql.raw(col)} = true WHERE partner_id = ${partnerId} AND phone = ${SENDER}`);
const setKyc = (id: string, mode: 'ours' | 'delegated') => db.execute(sql`UPDATE partners SET kyc_mode = ${mode} WHERE id = ${id}`);
const seedHeld = (id: string, partnerId: string, reasons: string[], o: Record<string, unknown> = {}) =>
  seedPartnerTransfer(db, { id, partnerId, status: 'in_review', complianceStatus: 'flagged', complianceReasons: reasons, paidAt: new Date().toISOString(), ...o });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  screeningRead.fail = false;
  screeningRead.afterRead = null;
  host.value = 'smartremit.ai';
  db = await freshDb();
  store = createStore(redis, db);
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await setKyc('pa', 'delegated');
  await setKyc('pb', 'delegated');
  await seedHeld('tr_heldA1', 'pa', [LARGE]);
  await seedHeld('tr_heldB1', 'pb', [LARGE]);
  await seedSender('pa');
  await seedSender('pb');
});

const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

describe('rejectHoldAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign id, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: rejectHoldAction,
      form: (id) => form(id),
      ownId: 'tr_heldA1',
      foreignId: 'tr_heldB1',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
    expect((await transferRow('tr_heldA1')).status).toBe('cancelled');
    expect((await transferRow('tr_heldB1')).status).toBe('in_review');
  });

  it.each(['agent', 'support', 'finance'] as const)('every non-admin role (%s) → REDIRECT:/partner, nothing changed', async (role) => {
    const before = await snapshot();
    await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
    await expect(rejectHoldAction(form('tr_heldA1'))).rejects.toThrow('REDIRECT:/partner');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses on a partner-site host before any read', async () => {
    await asAdmin();
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(rejectHoldAction(form('tr_heldA1'))).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toEqual(before);
  });

  it('a missing id, a foreign id and a junk id return the SAME not-found result', async () => {
    await asAdmin();
    const missing = await rejectHoldAction(form('tr_nope99'));
    expect(missing).toEqual({ ok: false, error: t('partner.common.notFound') });
    expect(await rejectHoldAction(form('tr_heldB1'))).toEqual(missing);
    expect(await rejectHoldAction(form("x' OR 1=1"))).toEqual(missing);
    expect((await transferRow('tr_heldB1')).status).toBe('in_review');
  });
});

describe('rejectHoldAction: D4 refusals (nothing cancelled, no audit row, no refund row)', () => {
  const refuses = async (fd: FormData, error: string) => {
    const before = await snapshot();
    expect(await rejectHoldAction(fd)).toEqual({ ok: false, error });
    expect(await snapshot()).toEqual(before);
  };
  const notAllowed = () => t('partner.reject.notAllowed');

  it.each(SCREENING_REASONS)('a SCREENING / SANCTIONS hold (%j) is refused, alone or mixed with a KYC reason', async (reason) => {
    await seedHeld('tr_scrA1', 'pa', [reason], { fundingRef: 'mockfund-scr1' });
    await seedHeld('tr_scrA2', 'pa', [LARGE, reason]);
    await asAdmin();
    await refuses(form('tr_scrA1'), notAllowed());
    await refuses(form('tr_scrA2'), notAllowed());
    expect((await transferRow('tr_scrA1')).status).toBe('in_review');
    expect(await count(outbox)).toBe(0);
  });

  it('an AML hold is refused', async () => {
    await seedHeld('tr_amlA1', 'pa', [AML_HOLD_REASON], { fundingRef: 'mockfund-aml1' });
    await asAdmin();
    await refuses(form('tr_amlA1'), notAllowed());
  });

  it('an unknown or empty reasons list is refused (fail closed)', async () => {
    await seedHeld('tr_unkA1', 'pa', ['Something new.']);
    await seedHeld('tr_empA1', 'pa', []);
    await asAdmin();
    await refuses(form('tr_unkA1'), notAllowed());
    await refuses(form('tr_empA1'), notAllowed());
  });

  it("a kycMode 'ours' partner is refused", async () => {
    await setKyc('pa', 'ours');
    await asAdmin();
    await refuses(form('tr_heldA1'), notAllowed());
  });

  it('a sanctions-BLOCKED compliance status is refused', async () => {
    await seedHeld('tr_blkA1', 'pa', [LARGE], { complianceStatus: 'blocked' });
    await asAdmin();
    await refuses(form('tr_blkA1'), notAllowed());
  });

  it.each(['pep_hit', 'watchlist_hit'] as const)('a sender with %s is refused', async (col) => {
    await flagSender('pa', col);
    await asAdmin();
    await refuses(form('tr_heldA1'), notAllowed());
  });

  it('a missing sender row or a failed sender lookup is refused (fail closed)', async () => {
    await asAdmin();
    screeningRead.fail = true;
    await refuses(form('tr_heldA1'), notAllowed());
    screeningRead.fail = false;
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'pa'`);
    await refuses(form('tr_heldA1'), notAllowed());
  });

  it('a transfer that is not in_review is refused', async () => {
    await seedPartnerTransfer(db, { id: 'tr_paidA1', partnerId: 'pa', status: 'paid', complianceStatus: 'flagged', complianceReasons: [LARGE] });
    await asAdmin();
    await refuses(form('tr_paidA1'), notAllowed());
  });

  it('a short or blank reason, and a reason carrying a phone/account number, are refused', async () => {
    await asAdmin();
    await refuses(form('tr_heldA1', 'too short'), t('partner.reject.reasonTooShort'));
    await refuses(form('tr_heldA1', '   \n\t '), t('partner.reject.reasonTooShort'));
    await refuses(form('tr_heldA1', 'Sender account 000011112222 is closed'), t('partner.reject.reasonHasNumber'));
  });
});

describe('rejectHoldAction: success through the ONE reject path', () => {
  it('an UNCHARGED hold: cancelled, exactly one transfer.reject row (actorScope partner), no refund row', async () => {
    await asAdmin();
    expect(await rejectHoldAction(form('tr_heldA1'))).toEqual({ ok: true });
    const row = await transferRow('tr_heldA1');
    expect(row.status).toBe('cancelled');
    expect(await outboxRows()).toEqual([]);
    const rows = await rejectRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', subjectId: 'tr_heldA1' });
    expect(rows[0].meta).toMatchObject({ reason: REASON, previousStatus: 'in_review', newStatus: 'cancelled', refundStatus: 'none', actorScope: 'partner' });
    expect(await count(auditEvents)).toBe(1);
    expect(revalidated).toEqual(['/partner/transfers', '/partner/transfers/tr_heldA1', '/partner/reviews']);
  });

  it('a CHARGED hold: cancelled, refund pending and exactly ONE funding.refund outbox row', async () => {
    await seedHeld('tr_chgA1', 'pa', [EDD], { fundingRef: 'mockfund-chgA1' });
    await asAdmin();
    expect(await rejectHoldAction(form('tr_chgA1'))).toEqual({ ok: true });
    const row = await transferRow('tr_chgA1');
    expect(row.status).toBe('cancelled');
    expect(row.refundStatus).toBe('pending');
    expect(await outboxRows()).toEqual([{ kind: 'funding.refund', dedupe_key: 'refund:tr_chgA1' }]);
    const rows = await rejectRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ refundStatus: 'pending', actorScope: 'partner' });
    const meta = JSON.stringify(rows[0].meta);
    expect(meta).not.toContain('000011112222');
    expect(meta).not.toContain('Samplesurname');
  });

  it('a replay writes nothing extra: notAllowed, still one audit row and one refund row', async () => {
    await seedHeld('tr_chgA2', 'pa', [LARGE], { fundingRef: 'mockfund-chgA2' });
    await asAdmin();
    expect(await rejectHoldAction(form('tr_chgA2'))).toEqual({ ok: true });
    expect(await rejectHoldAction(form('tr_chgA2'))).toEqual({ ok: false, error: t('partner.reject.notAllowed') });
    expect(await outboxRows()).toHaveLength(1);
    expect(await rejectRows()).toHaveLength(1);
  });

  it('two concurrent submits: exactly one rejects, one refund row', async () => {
    await seedHeld('tr_chgA3', 'pa', [LARGE], { fundingRef: 'mockfund-chgA3' });
    await asAdmin();
    const results = await Promise.all([rejectHoldAction(form('tr_chgA3')), rejectHoldAction(form('tr_chgA3'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: t('partner.reject.notAllowed') }]);
    expect(await outboxRows()).toHaveLength(1);
    expect(await rejectRows()).toHaveLength(1);
  });
});

describe('rejectHoldAction: sender flag raised between the pre-check and the claim', () => {
  it.each(['pep_hit', 'watchlist_hit'] as const)('%s set after the read: notAllowed, stays in_review, nothing written', async (col) => {
    await seedHeld('tr_chgA4', 'pa', [LARGE], { fundingRef: 'mockfund-chgA4' });
    await asAdmin();
    screeningRead.afterRead = () => flagSender('pa', col);
    expect(await rejectHoldAction(form('tr_chgA4'))).toEqual({ ok: false, error: t('partner.reject.notAllowed') });
    expect((await transferRow('tr_chgA4')).status).toBe('in_review');
    expect(await count(auditEvents)).toBe(0);
    expect(await count(outbox)).toBe(0);
  });

  it('another tenant flagging the same phone does not block this tenant', async () => {
    await asAdmin();
    screeningRead.afterRead = () => flagSender('pb', 'pep_hit');
    expect(await rejectHoldAction(form('tr_heldA1'))).toEqual({ ok: true });
  });
});
