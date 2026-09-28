import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// UI redesign M3-5, Task 5.3: addHoldNoteAction — an AUDIT-ONLY write (no transfer column
// changes, no money movement). The M3-1 harness: real auth store on a fake Redis, real partner
// store + ledger on PGlite.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;
const revalidated: string[] = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
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
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { addHoldNoteAction } from '@/app/partner/(app)/transfers/[id]/actions';
import { auditEvents, transfers } from '@/db/schema';
import { PARTNER_OPS } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '@/app/partner/routes';

const KEY = () => Array.from({ length: 32 }, () => 'abcdef'[Math.floor(Math.random() * 6)]).join('');
const form = (id: string, note = 'Asked the sender for the source of funds.', requestKey = KEY()) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('note', note);
  fd.set('requestKey', requestKey);
  return fd;
};
const noteRows = () =>
  db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.hold.note')).orderBy(auditEvents.id);
const transferRow = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0];
const snapshot = async () => ({
  audit: (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n,
  ta: await transferRow('tr_heldA1'),
  tb: await transferRow('tr_heldB1'),
});

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_heldA1', partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
  await seedPartnerTransfer(db, { id: 'tr_heldB1', partnerId: 'pb', status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
  await seedPartnerTransfer(db, { id: 'tr_doneA1', partnerId: 'pa', status: 'delivered' });
  await seedPartnerTransfer(db, { id: 'tr_flagA1', partnerId: 'pa', status: 'paid', complianceStatus: 'flagged' });
});

const asAgent = () => signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });

describe('addHoldNoteAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign id, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: addHoldNoteAction,
      form: (id) => form(id),
      ownId: 'tr_heldA1',
      foreignId: 'tr_heldB1',
      allowedRole: 'agent',
      disallowedRole: 'support',
      snapshot,
    });
  });
  it('the action policy is PARTNER_OPS, and every role it admits can also open the transfers page', () => {
    for (const r of PARTNER_OPS.roles) expect(PARTNER_ROUTES.transfers.policy.roles).toContain(r);
  });
  it('the admin role may add a note too', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    expect(await addHoldNoteAction(form('tr_heldA1'))).toEqual({ ok: true });
  });
  it('a missing id and a foreign id return the SAME not-found result', async () => {
    await asAgent();
    const missing = await addHoldNoteAction(form('tr_nope99'));
    const foreign = await addHoldNoteAction(form('tr_heldB1'));
    expect(missing).toEqual(foreign);
    expect(missing).toMatchObject({ ok: false });
    const junk = await addHoldNoteAction(form("x' OR 1=1"));
    expect(junk).toEqual(missing);
  });
});

describe('addHoldNoteAction: input (item 5: refused before any write)', () => {
  const refuses = async (fd: FormData) => {
    const before = await snapshot();
    const r = await addHoldNoteAction(fd);
    expect(r).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(before);
    return r as { ok: false; error: string };
  };
  it('a blank or whitespace note', async () => {
    await asAgent();
    await refuses(form('tr_heldA1', ''));
    await refuses(form('tr_heldA1', '   \n\t  '));
  });
  it('a note carrying a phone or account number (and the error never echoes it)', async () => {
    await asAgent();
    const r = await refuses(form('tr_heldA1', 'Call them on +1 415 555 0101 please'));
    expect(r.error).not.toContain('415');
  });
  it('a missing or malformed request key', async () => {
    await asAgent();
    await refuses(form('tr_heldA1', 'ok note', ''));
    await refuses(form('tr_heldA1', 'ok note', 'not-hex'));
  });
  it('a transfer that is not held (delivered)', async () => {
    await asAgent();
    await refuses(form('tr_doneA1'));
  });
});

describe('addHoldNoteAction: success (item 6)', () => {
  it('writes exactly one audit row, tenant-bound, with meta {note, actorScope} only', async () => {
    await asAgent();
    expect(await addHoldNoteAction(form('tr_heldA1', 'Asked the sender for documents.'))).toEqual({ ok: true });
    const rows = await noteRows();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.partnerId).toBe('pa');
    expect(r.actor).toBe('pa-agent');
    expect(r.actorType).toBe('staff');
    expect(r.subjectId).toBe('tr_heldA1');
    expect(r.meta).toEqual({ note: 'Asked the sender for documents.', actorScope: 'partner' });
    const s = JSON.stringify(r.meta);
    expect(s).not.toMatch(/\+?\d{10,}/);
    expect(s).not.toContain('000011112222');
    expect(s).not.toContain('Samplesurname');
    expect(revalidated.every((p) => p.startsWith('/partner/'))).toBe(true);
    expect(revalidated).toContain('/partner/transfers/tr_heldA1');
  });
  it('a flagged transfer that is not in review is also held', async () => {
    await asAgent();
    expect(await addHoldNoteAction(form('tr_flagA1'))).toEqual({ ok: true });
  });
  it('the note is cut to 500 characters', async () => {
    await asAgent();
    await addHoldNoteAction(form('tr_heldA1', 'n'.repeat(600)));
    const [r] = await noteRows();
    expect((r.meta as { note: string }).note).toHaveLength(500);
  });
  it('the transfer row is byte-identical before and after', async () => {
    await asAgent();
    const before = await transferRow('tr_heldA1');
    await addHoldNoteAction(form('tr_heldA1'));
    expect(await transferRow('tr_heldA1')).toEqual(before);
  });
  it('a replay of the same request key writes once; a new key writes again', async () => {
    await asAgent();
    const k = KEY();
    expect(await addHoldNoteAction(form('tr_heldA1', 'first', k))).toEqual({ ok: true });
    expect(await addHoldNoteAction(form('tr_heldA1', 'first', k))).toEqual({ ok: true });
    expect(await noteRows()).toHaveLength(1);
    await addHoldNoteAction(form('tr_heldA1', 'second', KEY()));
    expect(await noteRows()).toHaveLength(2);
  });
  it('the replay claim is bound to the user: the same key from another user is a new note', async () => {
    const k = KEY();
    await asAgent();
    await addHoldNoteAction(form('tr_heldA1', 'from agent', k));
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    await addHoldNoteAction(form('tr_heldA1', 'from admin', k));
    const rows = await noteRows();
    expect(rows.map((r) => r.actor)).toEqual(['pa-agent', 'pa-admin']);
  });
  it('no audit row for pb is ever written by a pa session', async () => {
    await asAgent();
    await addHoldNoteAction(form('tr_heldA1'));
    const pb = await db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, 'pb')));
    expect(pb).toHaveLength(0);
  });
});
