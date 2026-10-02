import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { RefundStatus, Transfer } from '@/lib/types';

// Merge plan 2b: refundOpAction (approve / dismiss / retry from /partner/refunds). A MONEY action:
// admin only (D1), approve and retry behind a fresh 15-minute step-up (D2), the transfer resolved
// inside the session tenant, a typed reason, and the ONE refund path (dashboard-ops), which commits
// the state change, the funding.refund effect and the audit row together.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
const revalidated: string[] = [];
let failAudit = false;
// Runs once, right after the action's tenant-scoped pre-read (a concurrent decision lands here).
const afterRead: { fn: null | (() => Promise<unknown>) } = { fn: null };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai', 'x-forwarded-for': '203.0.113.9' }),
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
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (dbx: Parameters<typeof real.createAuditRepo>[0]) => {
      const r = real.createAuditRepo(dbx);
      return {
        ...r,
        record: async (e: Parameters<typeof r.record>[0]) => {
          if (failAudit) throw new Error('audit insert failed');
          return r.record(e);
        },
      };
    },
  };
});
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const r = real.createTransferRepo(...a);
      return {
        ...r,
        getOwnedTransfer: async (...g: Parameters<typeof r.getOwnedTransfer>) => {
          const out = await r.getOwnedTransfer(...g);
          const fn = afterRead.fn;
          afterRead.fn = null;
          if (fn) await fn();
          return out;
        },
      };
    },
  };
});

import { refundOpAction } from '@/app/partner/(app)/refunds/actions';
import { approveRefund } from '@/lib/dashboard-ops';
import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { staffStepUpKey } from '@/lib/staff-step-up';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { hashPassword } from '@/lib/password';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { t } from '@/lib/i18n';

const REASON = 'Customer confirmed the request by phone.';
const PASSWORD = 'correct horse battery staple';
const form = (id: string, op: string, reason = REASON) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('op', op);
  fd.set('reason', reason);
  return fd;
};
const rows = async <T,>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
const transferRow = async (id: string) => (await rows<{ refund_status: string; admin_note: string | null }>(sql`SELECT refund_status, admin_note FROM transfers WHERE id = ${id}`))[0];
const refundEffects = () => rows<{ dedupe_key: string; payload: Record<string, unknown> }>(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'funding.refund' ORDER BY id`);
const audits = () => rows<{ partner_id: string; actor: string; action: string; subject_id: string; meta: Record<string, unknown> }>(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events ORDER BY id`);
const count = async (table: 'outbox' | 'audit_events') => (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`))[0].n;
const snapshot = async () => ({ a: await transferRow('tr_a1'), b: await transferRow('tr_b1'), outbox: await count('outbox'), audit: await count('audit_events') });
const seed = (id: string, partnerId: string, refundStatus: RefundStatus, o: Partial<Transfer> = {}) =>
  seedPartnerTransfer(db, { id, partnerId, status: 'cancelled', fundingRef: `f-${id}`, refundStatus, ...o });

/** Mark the CURRENT cookie's session as freshly stepped up (the 15-minute window). */
async function markFresh(): Promise<void> {
  const token = cookieJar.get(SESSION_COOKIE);
  if (!token) return;
  const user = await getAuthStore().getSessionUser(token);
  if (user) await redis.set(staffStepUpKey(token), `${user}:${Date.now()}`, { ex: 900 });
}
/** The action with a fresh step-up on whatever session is current (the contract helper re-signs in). */
const freshAction = async (fd: FormData) => {
  await markFresh();
  return refundOpAction(fd);
};
const asAdmin = async (fresh = true) => {
  await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin', passwordHash: await hashPassword(PASSWORD) });
  if (fresh) await markFresh();
};

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  failAudit = false;
  afterRead.fn = null;
  pokeSpy.mockClear();
  db = await freshDb();
  await seedTwoTenants(db);
});

describe('refundOpAction: the shared action contract', () => {
  for (const [op, state] of [['approve', 'requested'], ['dismiss', 'requested'], ['retry', 'failed']] as const) {
    it(`${op}: checklist items 1-4 (an agent is the disallowed role: D1)`, async () => {
      await seed('tr_a1', 'pa', state);
      await seed('tr_b1', 'pb', state);
      await expectPartnerActionContract({ db, redis, cookieJar, action: freshAction, form: (id) => form(id, op), ownId: 'tr_a1', foreignId: 'tr_b1', allowedRole: 'admin', disallowedRole: 'agent', snapshot });
      expect((await transferRow('tr_a1')).refund_status).toBe(op === 'dismiss' ? 'none' : 'pending');
      expect((await transferRow('tr_b1')).refund_status).toBe(state);
    });
  }
  it('finance and support are refused too, nothing written', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await seed('tr_b1', 'pb', 'requested');
    const before = await snapshot();
    for (const role of ['finance', 'support'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await markFresh();
      await expect(refundOpAction(form('tr_a1', 'approve'))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('refundOpAction: the money effect', () => {
  it('approve: requested → pending, exactly ONE funding.refund effect, one refund.approve row with reason and actorScope', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin();
    expect(await refundOpAction(form('tr_a1', 'approve'))).toEqual({ ok: true });
    expect((await transferRow('tr_a1')).refund_status).toBe('pending');
    expect(await refundEffects()).toEqual([{ dedupe_key: 'refund:tr_a1', payload: { transferId: 'tr_a1' } }]);
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', action: 'refund.approve', subject_id: 'tr_a1', meta: { previousRefundStatus: 'requested', refundStatus: 'pending', reason: REASON, actorScope: 'partner' } });
    expect(pokeSpy).toHaveBeenCalled();
    expect(revalidated).toEqual(expect.arrayContaining(['/partner/refunds', '/partner/transfers/tr_a1']));
  });
  it('a second approve (double submit) is refused and still ONE effect', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin();
    await refundOpAction(form('tr_a1', 'approve'));
    expect(await refundOpAction(form('tr_a1', 'approve'))).toEqual({ ok: false, error: t('partner.refunds.notAllowed') });
    expect(await refundEffects()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });
  it('retry: failed → pending, exactly ONE new funding.refund effect with a fresh key', async () => {
    await seed('tr_a1', 'pa', 'failed');
    await asAdmin();
    expect(await refundOpAction(form('tr_a1', 'retry'))).toEqual({ ok: true });
    expect((await transferRow('tr_a1')).refund_status).toBe('pending');
    const fx = await refundEffects();
    expect(fx).toHaveLength(1);
    expect(fx[0].dedupe_key).toMatch(/^refund:tr_a1:retry:\d+$/);
    expect((await audits()).map((r) => [r.action, r.meta.actorScope])).toEqual([['refund.retry', 'partner']]);
  });
  it('dismiss: requested → none with a note, NO money effect', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin();
    expect(await refundOpAction(form('tr_a1', 'dismiss'))).toEqual({ ok: true });
    const row = await transferRow('tr_a1');
    expect(row.refund_status).toBe('none');
    expect(row.admin_note).toContain('refund request dismissed');
    expect(await refundEffects()).toEqual([]);
    expect((await audits()).map((r) => r.action)).toEqual(['refund.dismiss']);
  });
  it('wrong state: approve on failed / pending / completed, retry on requested, dismiss on failed → not allowed, nothing written', async () => {
    await seed('tr_f', 'pa', 'failed');
    await seed('tr_p', 'pa', 'pending');
    await seed('tr_c', 'pa', 'completed');
    await seed('tr_r', 'pa', 'requested');
    await seed('tr_n', 'pa', 'none');
    await asAdmin();
    const notAllowed = { ok: false, error: t('partner.refunds.notAllowed') };
    for (const [id, op] of [['tr_f', 'approve'], ['tr_p', 'approve'], ['tr_c', 'approve'], ['tr_r', 'retry'], ['tr_f', 'dismiss'], ['tr_p', 'retry'], ['tr_n', 'approve'], ['tr_n', 'dismiss']]) {
      expect(await refundOpAction(form(id, op))).toEqual(notAllowed);
    }
    expect(await refundOpAction(form('tr_r', 'issue'))).toEqual(notAllowed);
    expect(await count('outbox')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });
  it('a missing, malformed or foreign id is the same not-found', async () => {
    await seed('tr_b1', 'pb', 'requested');
    await asAdmin();
    for (const id of ['tr_missing', '', 'a b', 'tr_b1']) expect(await refundOpAction(form(id, 'approve'))).toEqual({ ok: false, error: t('partner.refunds.notFound') });
    expect(await count('outbox')).toBe(0);
  });
});

describe('refundOpAction: the reason', () => {
  it(`is required (at least ${STAFF_REASON_MIN} characters) and may not carry a phone/account-length number`, async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin();
    expect(await refundOpAction(form('tr_a1', 'approve', 'short'))).toEqual({ ok: false, error: t('partner.refunds.reasonTooShort', { min: STAFF_REASON_MIN }) });
    expect(await refundOpAction(form('tr_a1', 'dismiss', '            '))).toMatchObject({ ok: false });
    expect(await refundOpAction(form('tr_a1', 'approve', 'Refund to account 000011112222 ok'))).toEqual({ ok: false, error: t('partner.refunds.reasonHasNumber') });
    expect((await transferRow('tr_a1')).refund_status).toBe('requested');
    expect(await count('outbox')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });
});

describe('refundOpAction: the step-up (D2)', () => {
  it('approve and retry on a stale session → step_up_required, nothing written', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await seed('tr_a2', 'pa', 'failed');
    await asAdmin(false);
    for (const [id, op] of [['tr_a1', 'approve'], ['tr_a2', 'retry']]) {
      const r = await refundOpAction(form(id, op));
      expect(isStepUpRequired(r)).toBe(true);
      expect(r).toMatchObject({ factor: 'password' });
    }
    expect((await transferRow('tr_a1')).refund_status).toBe('requested');
    expect((await transferRow('tr_a2')).refund_status).toBe('failed');
    expect(await count('outbox')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });
  it('a retry carrying the right password runs the approve once; a wrong one is refused with nothing moved', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin(false);
    const wrong = form('tr_a1', 'approve');
    wrong.set(STEP_UP_FIELD, 'not the password');
    expect(isStepUpRequired(await refundOpAction(wrong))).toBe(true);
    expect(await refundEffects()).toEqual([]);
    expect((await audits()).map((r) => r.action)).toEqual(['auth.stepup.failed']);

    const right = form('tr_a1', 'approve');
    right.set(STEP_UP_FIELD, PASSWORD);
    expect(await refundOpAction(right)).toEqual({ ok: true });
    expect(await refundEffects()).toHaveLength(1);
    const a = await audits();
    expect(a.map((r) => r.action)).toEqual(['auth.stepup.failed', 'auth.stepup', 'refund.approve']);
    expect(JSON.stringify(a)).not.toContain(PASSWORD);
  });
  it('dismiss moves no money and needs no step-up', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin(false);
    expect(await refundOpAction(form('tr_a1', 'dismiss'))).toEqual({ ok: true });
    expect((await transferRow('tr_a1')).refund_status).toBe('none');
  });
});

describe('refundOpAction: atomicity', () => {
  it('a lost race (another decision committed after the pre-read) is refused; still ONE effect and ONE decision row', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await asAdmin();
    afterRead.fn = () => approveRefund(db, 'tr_a1', { actor: 'someone-else', reason: 'concurrent decision' });
    expect(await refundOpAction(form('tr_a1', 'approve'))).toEqual({ ok: false, error: t('partner.refunds.notAllowed') });
    expect((await transferRow('tr_a1')).refund_status).toBe('pending');
    expect(await refundEffects()).toHaveLength(1);
    expect((await audits()).map((r) => [r.action, r.actor])).toEqual([['refund.approve', 'someone-else']]);
  });
  it('a failed audit insert rolls the whole decision back: no state change, no effect, fixed copy', async () => {
    await seed('tr_a1', 'pa', 'requested');
    await seed('tr_a2', 'pa', 'failed');
    await asAdmin();
    failAudit = true;
    for (const [id, op] of [['tr_a1', 'approve'], ['tr_a1', 'dismiss'], ['tr_a2', 'retry']]) {
      const r = await refundOpAction(form(id, op));
      expect(r).toEqual({ ok: false, error: t('partner.common.failed') });
      expect(JSON.stringify(r)).not.toContain('audit insert failed');
    }
    failAudit = false;
    expect((await transferRow('tr_a1')).refund_status).toBe('requested');
    expect((await transferRow('tr_a1')).admin_note ?? '').not.toContain('dismissed');
    expect((await transferRow('tr_a2')).refund_status).toBe('failed');
    expect(await count('outbox')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });
});
