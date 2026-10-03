import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// lost-features p4 B4 (review BL-3): the staff decisions on a two-step recovery request, on both
// dashboards. /partner: PARTNER_ADMIN of the ticket's own tenant (support / agent / finance are
// bounced), never a request escalated to SmartRemit. /admin-dashboard: platform admins only. Both:
// the approver's own staff 2FA, a fresh 'customer.mfa.recovery.approve' step-up (real gate here,
// bypassable for the shared contract), an ID document or a confirmed recent transfer (plus the
// 24-hour wait without the ID document), the tenant and phone from the ticket row only.

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
const staffMfa = vi.hoisted(() => ({ enrolled: new Set<string>(), code: '123456' }));
const gate = vi.hoisted(() => ({ bypass: false, calls: [] as string[] }));
const legacy = vi.hoisted(() => ({ signedOut: [] as string[] }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai', 'x-forwarded-for': '203.0.113.7' }),
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
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  getStaffMfaStore: () => ({
    isEnrolled: async (u: string) => staffMfa.enrolled.has(u),
    verifyCode: async (_u: string, c: string) => c === staffMfa.code,
  }),
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-step-up-gate')>();
  return {
    ...actual,
    gatePartnerStepUp: async (...a: Parameters<typeof actual.gatePartnerStepUp>) => {
      gate.calls.push(a[2]);
      return gate.bypass ? null : actual.gatePartnerStepUp(...a);
    },
    gateStaffStepUp: async (...a: Parameters<typeof actual.gateStaffStepUp>) => {
      gate.calls.push(a[2]);
      return gate.bypass ? null : actual.gateStaffStepUp(...a);
    },
  };
});
vi.mock('@/lib/customer-auth-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/customer-auth-store')>()),
  getCustomerAuthStore: () => ({
    deleteAllSessions: async (phone: string) => {
      legacy.signedOut.push(phone);
    },
  }),
}));
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: () => undefined }));

import { auditEvents, outbox, tickets } from '@/db/schema';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { openMfaRecoveryRequest, RECOVERY_COOL_OFF_MS } from '@/lib/customer-mfa-recovery';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { t } from '@/lib/i18n';
import {
  approveMfaRecoveryAction as partnerApprove,
  declineMfaRecoveryAction as partnerDecline,
} from '@/app/partner/(app)/support/[ticketId]/recovery-actions';
import {
  approveMfaRecoveryAction as platformApprove,
  declineMfaRecoveryAction as platformDecline,
} from '@/app/admin-dashboard/tickets/recovery-actions';
import {
  replyAction as partnerReply,
  setStatusAction as partnerSetStatus,
} from '@/app/partner/(app)/support/[ticketId]/actions';
import {
  closeAction as platformClose,
  replyAction as platformReply,
  resolveAction as platformResolve,
} from '@/app/admin-dashboard/tickets/actions';
import { RECOVERY_LOCKED_MESSAGE } from '@/lib/customer-mfa-recovery-rules';

const PHONE_A = '14155550101';
const PHONE_B = '14155550202';
const customers = () => createCustomerRepo(db, async () => null);
const mfaOn = (partnerId: string, phone: string) => customers().isMfaEnrolled(partnerId, phone);

async function recoveryTicket(partnerId: string, phone: string): Promise<string> {
  await customers().upsertOnFirstInbound(partnerId, phone);
  expect(await customers().enableMfa(partnerId, phone, 'JBSWY3DPEHPK3PXP')).toBe(true);
  expect(await openMfaRecoveryRequest({ partnerId, phone, via: 'portal' }, { db, redis, poke: () => undefined, isEnrolled: (k) => mfaOn(k.partnerId, k.phone) })).toBe('opened');
  const [row] = await db.select().from(tickets).where(and(eq(tickets.partnerId, partnerId), eq(tickets.customerPhone, phone)));
  return row.id;
}

const partnerForm = (id: string, o: { checks?: string[]; secret?: string; extra?: Record<string, string> } = {}) => {
  const fd = new FormData();
  fd.set('id', id);
  for (const c of o.checks ?? ['id_document']) fd.append('check', c);
  if (o.secret) fd.set(STEP_UP_FIELD, o.secret);
  for (const [k, v] of Object.entries(o.extra ?? {})) fd.set(k, v);
  return fd;
};
const platformForm = (id: string, o: { checks?: string[]; secret?: string } = {}) => {
  const fd = partnerForm(id, o);
  fd.delete('id');
  fd.set('ticketId', id);
  return fd;
};
const status = async (id: string) => (await createTicketRepo(db).getTicket(id))!.status;
const count = async (action: string) => (await db.select().from(auditEvents).where(eq(auditEvents.action, action))).length;
const outboxCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(outbox))[0].n;

let A: string;
let B: string;

async function partnerAdmin(username = 'pa-admin'): Promise<Staff> {
  staffMfa.enrolled.add(username);
  return signInAs(redis, cookieJar, { username, partnerId: 'pa', role: 'admin' });
}
async function platformAdmin(username = 'ops-admin'): Promise<Staff> {
  staffMfa.enrolled.add(username);
  return signInAs(redis, cookieJar, { username, partnerId: undefined, role: 'admin' });
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  staffMfa.enrolled = new Set();
  gate.bypass = false;
  gate.calls = [];
  legacy.signedOut = [];
  db = await freshDb();
  await seedTwoTenants(db);
  A = await recoveryTicket('pa', PHONE_A);
  B = await recoveryTicket('pb', PHONE_B);
});

describe('/partner approveMfaRecoveryAction', () => {
  it('the shared action contract (support is not admin)', async () => {
    gate.bypass = true;
    staffMfa.enrolled.add('contract-allowed');
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: partnerApprove,
      form: (id) => partnerForm(id),
      ownId: A,
      foreignId: B,
      allowedRole: 'admin',
      disallowedRole: 'support',
      snapshot: async () => ({ a: await mfaOn('pa', PHONE_A), b: await mfaOn('pb', PHONE_B), sa: await status(A), sb: await status(B) }),
    });
    expect(await mfaOn('pa', PHONE_A)).toBe(false);
    expect(await mfaOn('pb', PHONE_B)).toBe(true);
  });

  it('agents and finance are bounced by the gate', async () => {
    for (const role of ['agent', 'finance'] as Staff['role'][]) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(partnerApprove(partnerForm(A))).rejects.toThrow(/^REDIRECT:/);
      await expect(partnerDecline(partnerForm(A, { extra: { reason: 'duplicate' } }))).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
  });

  it('a stale session gets step_up_required with nothing written; the retry with the code approves', async () => {
    await partnerAdmin();
    const r = await partnerApprove(partnerForm(A));
    expect(isStepUpRequired(r)).toBe(true);
    expect(gate.calls).toEqual(['customer.mfa.recovery.approve']);
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
    expect(await count('customer.mfa.recovery.approve')).toBe(0);

    expect(await partnerApprove(partnerForm(A, { secret: staffMfa.code }))).toEqual({ ok: true, outcome: 'approved' });
    expect(await mfaOn('pa', PHONE_A)).toBe(false);
    expect(await status(A)).toBe('resolved');
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'customer.mfa.recovery.approve'));
    expect(row).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', subjectId: A });
    expect(row.meta).toEqual({ checks: ['id_document'], actorScope: 'partner' });
    expect(await count('auth.stepup')).toBe(1);
    expect(legacy.signedOut).toEqual([PHONE_A]);
  });

  it('refuses before the step-up: no strong check, the 24-hour wait, or no staff 2FA', async () => {
    await partnerAdmin();
    gate.bypass = true;
    expect(await partnerApprove(partnerForm(A, { checks: ['kyc_name', 'callback'] }))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.needChecks') });
    const wait = (await partnerApprove(partnerForm(A, { checks: ['recent_transfer'] }))) as { ok: boolean; error: string };
    expect(wait.ok).toBe(false);
    expect(wait.error).toContain('UTC');
    staffMfa.enrolled.delete('pa-admin');
    expect(await partnerApprove(partnerForm(A))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.needStaffMfa') });
    expect(gate.calls).toEqual([]);
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
  });

  it('a confirmed recent transfer is enough once 24 hours have passed', async () => {
    await partnerAdmin();
    gate.bypass = true;
    // The request was made just over 24 hours ago.
    await db.update(tickets).set({ createdAt: new Date(Date.now() - RECOVERY_COOL_OFF_MS - 60_000) }).where(eq(tickets.id, A));
    expect(await partnerApprove(partnerForm(A, { checks: ['recent_transfer'] }))).toEqual({ ok: true, outcome: 'approved' });
    expect((await db.select().from(auditEvents).where(eq(auditEvents.action, 'customer.mfa.recovery.approve')))[0].meta).toEqual({ checks: ['recent_transfer'], actorScope: 'partner' });
  });

  it('every approval asks for a fresh code, even right after another step-up', async () => {
    await partnerAdmin();
    const second = await recoveryTicket('pa', '14155550303');
    expect(await partnerApprove(partnerForm(A, { secret: staffMfa.code }))).toEqual({ ok: true, outcome: 'approved' });
    expect(isStepUpRequired(await partnerApprove(partnerForm(second)))).toBe(true);
    expect(await mfaOn('pa', '14155550303')).toBe(true);
  });

  it('a request escalated to SmartRemit is refused, and nothing is written', async () => {
    await partnerAdmin();
    gate.bypass = true;
    await createTicketRepo(db).updateStatus(A, 'waiting_admin');
    const before = await outboxCount();
    expect(await partnerApprove(partnerForm(A))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.escalated') });
    expect(await partnerDecline(partnerForm(A, { extra: { reason: 'duplicate' } }))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.escalated') });
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
    expect(await outboxCount()).toBe(before);
  });

  it('an ordinary ticket of the own tenant is not found; forged phone fields are ignored', async () => {
    await partnerAdmin();
    gate.bypass = true;
    const plain = await createTicketRepo(db).createTicket({ id: 'tk_plain', partnerId: 'pa', kind: 'customer', customerPhone: PHONE_A, subject: 'Help', body: 'b' });
    expect(await partnerApprove(partnerForm(plain.id))).toEqual({ ok: false, error: t('partner.support.notFound') });
    await customers().upsertOnFirstInbound('pa', PHONE_B);
    await customers().enableMfa('pa', PHONE_B, 'JBSWY3DPEHPK3PXP');
    expect(await partnerApprove(partnerForm(A, { extra: { phone: PHONE_B, customerPhone: PHONE_B } }))).toEqual({ ok: true, outcome: 'approved' });
    expect(await mfaOn('pa', PHONE_A)).toBe(false);
    expect(await mfaOn('pa', PHONE_B)).toBe(true);
  });

  it('decline keeps the factor, needs a listed reason, and a decided request cannot be decided again', async () => {
    await partnerAdmin();
    expect(await partnerDecline(partnerForm(A, { extra: { reason: 'because' } }))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.reasonInvalid') });
    expect(await partnerDecline(partnerForm(A, { extra: { reason: 'not_verified' } }))).toEqual({ ok: true, outcome: 'declined' });
    expect(gate.calls).toEqual([]); // decline never asks for a step-up
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
    expect(await count('customer.mfa.recovery.decline')).toBe(1);
    expect(await partnerDecline(partnerForm(A, { extra: { reason: 'not_verified' } }))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.handled') });
    gate.bypass = true;
    expect(await partnerApprove(partnerForm(A))).toEqual({ ok: false, error: t('partner.support.mfaRecovery.handled') });
    expect(await count('customer.mfa.recovery.decline')).toBe(1);
  });
});

describe('/admin-dashboard approveMfaRecoveryAction', () => {
  it('support, agents and partner-scoped admins are redirected', async () => {
    for (const o of [
      { username: 'ops-support', role: 'support' as const },
      { username: 'ops-agent', role: 'agent' as const },
      { username: 'pa-admin', role: 'admin' as const, partnerId: 'pa' },
    ]) {
      await signInAs(redis, cookieJar, { partnerId: undefined, ...o });
      await expect(platformApprove(platformForm(A))).rejects.toThrow(/^REDIRECT:/);
      await expect(platformDecline(platformForm(A))).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
  });

  it('a platform admin without staff 2FA is refused before the step-up', async () => {
    await signInAs(redis, cookieJar, { username: 'ops-admin', partnerId: undefined, role: 'admin' });
    const r = (await platformApprove(platformForm(A))) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('two-step verification');
    expect(gate.calls).toEqual([]);
  });

  it('stale → step_up_required; the retry approves, including a request a partner escalated', async () => {
    await platformAdmin();
    await createTicketRepo(db).updateStatus(B, 'waiting_admin');
    expect(isStepUpRequired(await platformApprove(platformForm(B)))).toBe(true);
    expect(await mfaOn('pb', PHONE_B)).toBe(true);
    expect(await platformApprove(platformForm(B, { secret: staffMfa.code }))).toEqual({ ok: true, outcome: 'approved' });
    expect(gate.calls).toEqual(['customer.mfa.recovery.approve', 'customer.mfa.recovery.approve']);
    expect(await mfaOn('pb', PHONE_B)).toBe(false);
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'customer.mfa.recovery.approve'));
    expect(row).toMatchObject({ partnerId: 'pb', actor: 'ops-admin', subjectId: B });
    expect(row.meta).toEqual({ checks: ['id_document'], actorScope: 'platform' });
  });

  it('every approval asks for a fresh code, even right after another step-up', async () => {
    await platformAdmin();
    expect(await platformApprove(platformForm(B, { secret: staffMfa.code }))).toEqual({ ok: true, outcome: 'approved' });
    expect(isStepUpRequired(await platformApprove(platformForm(A)))).toBe(true);
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
  });

  it('a non-recovery ticket is not found; decline works with a listed reason', async () => {
    await platformAdmin();
    gate.bypass = true;
    const plain = await createTicketRepo(db).createTicket({ id: 'tk_plain', partnerId: 'pa', kind: 'customer', customerPhone: PHONE_A, subject: 'Help', body: 'b' });
    expect(await platformApprove(platformForm(plain.id))).toEqual({ ok: false, error: 'Recovery request not found.' });
    const fd = platformForm(A);
    fd.set('reason', 'duplicate');
    expect(await platformDecline(fd)).toEqual({ ok: true, outcome: 'declined' });
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
    expect(await status(A)).toBe('resolved');
  });
});

describe('ordinary ticket actions refuse a recovery request', () => {
  const messageCount = async (id: string) => (await createTicketRepo(db).listMessages(id, { includeInternal: true })).length;

  it('/partner reply and status change return the locked copy and write nothing', async () => {
    await partnerAdmin();
    const before = { messages: await messageCount(A), outbox: await outboxCount() };
    const locked = { ok: false, error: t('partner.support.mfaRecovery.locked') };
    expect(await partnerReply(partnerForm(A, { checks: [], extra: { body: 'Done, all sorted.', requestKey: 'k'.repeat(32) } }))).toEqual(locked);
    for (const next of ['resolved', 'closed', 'pending']) {
      expect(await partnerSetStatus(partnerForm(A, { checks: [], extra: { status: next } }))).toEqual(locked);
    }
    expect(await status(A)).toBe('open');
    expect(await messageCount(A)).toBe(before.messages);
    expect(await outboxCount()).toBe(before.outbox);
    expect(await mfaOn('pa', PHONE_A)).toBe(true);
  });

  it('/admin-dashboard reply, resolve and close throw the locked message and write nothing', async () => {
    await platformAdmin();
    const before = { messages: await messageCount(A), outbox: await outboxCount() };
    const fd = platformForm(A, { checks: [] });
    fd.set('body', 'Done, all sorted.');
    await expect(platformReply(fd)).rejects.toThrow(RECOVERY_LOCKED_MESSAGE);
    await expect(platformResolve(platformForm(A, { checks: [] }))).rejects.toThrow(RECOVERY_LOCKED_MESSAGE);
    await expect(platformClose(platformForm(A, { checks: [] }))).rejects.toThrow(RECOVERY_LOCKED_MESSAGE);
    expect(await status(A)).toBe('open');
    expect(await messageCount(A)).toBe(before.messages);
    expect(await outboxCount()).toBe(before.outbox);
    expect(await count('ticket.resolve')).toBe(0);
    expect(await count('ticket.close')).toBe(0);
  });

  it('an ordinary ticket of the same tenant still resolves on both dashboards', async () => {
    const plain = await createTicketRepo(db).createTicket({ id: 'tk_plain', partnerId: 'pa', kind: 'customer', customerPhone: PHONE_A, subject: 'Help', body: 'b' });
    await platformAdmin();
    await platformResolve(platformForm(plain.id, { checks: [] }));
    expect(await status(plain.id)).toBe('resolved');
    await partnerAdmin();
    expect(await partnerSetStatus(partnerForm(plain.id, { checks: [], extra: { status: 'open' } }))).toMatchObject({ ok: true });
    expect(await status(plain.id)).toBe('open');
  });
});
