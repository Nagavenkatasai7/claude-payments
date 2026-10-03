import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Lost-features A12: a partner admin answers, resolves or closes a TEAM question (an internal thread
// addressed to the tenant's admins). Real gate over the real auth store on a fake Redis, real ticket
// and audit repos on PGlite. Both actions run the shared contract (admin allowed, agent bounced) plus
// their own cases: a thread addressed to SmartRemit, or one the admin opened, is not found and
// nothing is written; the write and its ONE audit row commit together; closed is terminal.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
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
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { createTicketRepo } from '@/db/repos/ticket-repo';
import { auditEvents, tickets, ticketMessages } from '@/db/schema';
import { answerTeamQuestionAction, setTeamQuestionStatusAction } from '@/app/partner/(app)/support/contact/team-actions';
import { TEAM_QUESTION_CATEGORY } from '@/lib/ticket-category';

const NOT_FOUND = { ok: false, error: 'We could not find that ticket.' };
let keyN = 0;
const newKey = () => (++keyN).toString(16).padStart(32, '0');

async function seedQuestion(id: string, partnerId: string, o: { team?: boolean; openedBy?: string } = {}) {
  await createTicketRepo(db).createTicket({
    id,
    partnerId,
    kind: 'internal',
    openedBy: o.openedBy ?? 'staff-asker',
    subject: `subject ${id}`,
    body: `first message ${id}`,
    ...(o.team === false ? {} : { category: TEAM_QUESTION_CATEGORY }),
  });
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const answerForm = (id: string, extra: Record<string, string> = {}) => form({ id, body: 'Use the settlement page.', requestKey: newKey(), ...extra });

const audits = () => db.select().from(auditEvents);
const ticketRow = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0];
const messages = (id: string) => db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id));
const snapshot = async () => ({
  t: (await db.select().from(tickets)).map((r) => [r.id, r.status]).sort(),
  m: (await db.select().from(ticketMessages)).length,
  a: (await audits()).length,
});
const signIn = (o: Partial<Staff>) => signInAs(redis, cookieJar, { partnerId: 'pa', ...o });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedQuestion('tk_qa', 'pa');
  await seedQuestion('tk_qb', 'pb');
  await seedQuestion('tk_sr', 'pa', { team: false });
  await seedQuestion('tk_own', 'pa', { openedBy: 'pa-admin' });
  vi.clearAllMocks();
});

describe('answerTeamQuestionAction', () => {
  it('passes the shared /partner action contract (admin allowed, agent bounced)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: answerTeamQuestionAction,
      form: (id) => answerForm(id),
      ownId: 'tk_qa',
      foreignId: 'tk_qb',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
  });
  it('support and finance are bounced too; nothing is written', async () => {
    for (const role of ['support', 'finance'] as Staff['role'][]) {
      await signIn({ username: `pa-${role}`, role });
      const before = JSON.stringify(await snapshot());
      await expect(answerTeamQuestionAction(answerForm('tk_qa'))).rejects.toThrow(/^REDIRECT:/);
      expect(JSON.stringify(await snapshot())).toBe(before);
    }
  });
  it('the site-host guard runs first', async () => {
    host.value = 'acme.smartremit.ai';
    await expect(answerTeamQuestionAction(answerForm('tk_qa'))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
  it('a thread addressed to SmartRemit, or one the admin opened, is not found and nothing is written', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    const before = JSON.stringify(await snapshot());
    expect(await answerTeamQuestionAction(answerForm('tk_sr'))).toEqual(NOT_FOUND);
    expect(await answerTeamQuestionAction(answerForm('tk_own'))).toEqual(NOT_FOUND);
    expect(await answerTeamQuestionAction(answerForm('tk_missing'))).toEqual(NOT_FOUND);
    expect(JSON.stringify(await snapshot())).toBe(before);
  });
  it('writes the answer and ONE audit row together; a double submit adds one message', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    const fd = answerForm('tk_qa');
    expect(await answerTeamQuestionAction(fd)).toEqual({ ok: true });
    expect(await answerTeamQuestionAction(fd)).toEqual({ ok: true });
    const msgs = await messages('tk_qa');
    expect(msgs).toHaveLength(2); // the question + one answer
    expect(msgs[1]).toMatchObject({ actorType: 'staff', actorId: 'pa-admin', internal: false });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', action: 'employee_question.answer', subjectId: 'tk_qa' });
    expect(rows[0].meta).toEqual({ actorScope: 'partner' });
    expect(JSON.stringify(rows)).not.toContain('settlement page');
    expect((await ticketRow('tk_qa')).status).toBe('open');
  });
  it('a closed question is refused with fixed copy; an empty body is refused', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await answerTeamQuestionAction(answerForm('tk_qa', { body: '   ' }))).toMatchObject({ ok: false });
    await createTicketRepo(db).updateStatus('tk_qa', 'closed');
    expect(await answerTeamQuestionAction(answerForm('tk_qa'))).toEqual({ ok: false, error: 'This conversation is closed.' });
    expect(await audits()).toHaveLength(0);
  });
});

describe('setTeamQuestionStatusAction', () => {
  it('passes the shared /partner action contract (admin allowed, agent bounced)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: setTeamQuestionStatusAction,
      form: (id) => form({ id, status: 'resolved' }),
      ownId: 'tk_qa',
      foreignId: 'tk_qb',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
    expect((await ticketRow('tk_qa')).status).toBe('resolved');
  });
  it('resolve then close, each audited with the move; closed is terminal', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await setTeamQuestionStatusAction(form({ id: 'tk_qa', status: 'resolved' }))).toEqual({ ok: true });
    expect(await setTeamQuestionStatusAction(form({ id: 'tk_qa', status: 'closed' }))).toEqual({ ok: true });
    expect((await ticketRow('tk_qa')).status).toBe('closed');
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.meta])).toEqual([
      ['employee_question.status', { actorScope: 'partner', status: 'resolved', from: 'open' }],
      ['employee_question.status', { actorScope: 'partner', status: 'closed', from: 'resolved' }],
    ]);
    expect(await setTeamQuestionStatusAction(form({ id: 'tk_qa', status: 'resolved' }))).toEqual({ ok: false, error: 'This conversation is closed.' });
    expect(await audits()).toHaveLength(2);
  });
  it('only resolved or closed; a same-state move is refused and writes nothing', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    for (const status of ['open', 'pending', 'waiting_admin', '']) {
      expect(await setTeamQuestionStatusAction(form({ id: 'tk_qa', status }))).toMatchObject({ ok: false });
    }
    await setTeamQuestionStatusAction(form({ id: 'tk_qa', status: 'resolved' }));
    expect(await setTeamQuestionStatusAction(form({ id: 'tk_qa', status: 'resolved' }))).toEqual({
      ok: false,
      error: 'That status change is not allowed. Reload the page.',
    });
    expect(await audits()).toHaveLength(1);
  });
  it('a thread addressed to SmartRemit stays read-only for the partner admin', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await setTeamQuestionStatusAction(form({ id: 'tk_sr', status: 'closed' }))).toEqual(NOT_FOUND);
    expect((await ticketRow('tk_sr')).status).toBe('open');
    expect(await audits()).toHaveLength(0);
  });
});
