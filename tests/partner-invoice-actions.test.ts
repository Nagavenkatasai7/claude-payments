import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Lost-features A6: /partner/invoices void and reissue. Real gate over the real auth store on a fake
// Redis, real invoice and audit repos on PGlite. Both actions run the shared contract (admin
// allowed, agent bounced) plus their own cases: a malformed or another tenant's id is the same
// not-found; a lost status guard is a fixed refusal; the change and its ONE audit row commit
// together.
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

import { b2bInvoices } from '@/db/schema';
import { createAuditRepo, createB2bInvoiceRepo } from '@/db/repos/aux-repos';
import { reissueInvoiceAction, voidInvoiceAction } from '@/app/partner/(app)/invoices/actions';
import type { B2bInvoice } from '@/lib/types';

const NOT_FOUND = { ok: false, error: 'We could not find that invoice.' };
const NOT_ALLOWED = { ok: false, error: 'This invoice can no longer be changed this way. Reload the page.' };

const inv = (o: Partial<B2bInvoice> & { id: string; partnerId: string }): B2bInvoice => ({
  businessName: 'Seller Co',
  buyerPhone: '15550001111',
  lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 100 }],
  amountUsd: 100,
  currency: 'USD',
  status: 'unpaid',
  createdAt: new Date().toISOString(),
  ...o,
});
function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const audits = async () => (await createAuditRepo(db).listRecent(100)).filter((r) => r.action.startsWith('b2b.invoice.'));
const snapshot = async () => ({
  i: (await db.select().from(b2bInvoices)).map((r) => [r.id, r.status]).sort(),
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
  const repo = createB2bInvoiceRepo(db);
  await repo.saveInvoice(inv({ id: 'inv_a', partnerId: 'pa' }));
  await repo.saveInvoice(inv({ id: 'inv_a_dead', partnerId: 'pa', status: 'voided' }));
  await repo.saveInvoice(inv({ id: 'inv_a_paid', partnerId: 'pa', status: 'paid', paidAt: new Date().toISOString() }));
  await repo.saveInvoice(inv({ id: 'inv_b', partnerId: 'pb' }));
  await repo.saveInvoice(inv({ id: 'inv_b_dead', partnerId: 'pb', status: 'disputed' }));
  vi.clearAllMocks();
});

describe('voidInvoiceAction', () => {
  it('passes the shared /partner action contract (admin allowed, agent bounced)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: voidInvoiceAction,
      form: (id) => form({ id }),
      ownId: 'inv_a',
      foreignId: 'inv_b',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
    expect((await createB2bInvoiceRepo(db).getInvoice('inv_a'))?.status).toBe('voided');
    expect((await createB2bInvoiceRepo(db).getInvoice('inv_b'))?.status).toBe('unpaid');
  });
  it('support and finance are bounced; the site-host guard runs first', async () => {
    for (const role of ['support', 'finance'] as Staff['role'][]) {
      await signIn({ username: `pa-${role}`, role });
      await expect(voidInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow(/^REDIRECT:/);
    }
    host.value = 'acme.smartremit.ai';
    await expect(voidInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect((await createB2bInvoiceRepo(db).getInvoice('inv_a'))?.status).toBe('unpaid');
  });
  it('a malformed or missing id is not found; a paid bill is a fixed refusal; nothing is written', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    const before = JSON.stringify(await snapshot());
    for (const id of ['', '../inv_a', 'inv a', 'inv_missing']) {
      expect(await voidInvoiceAction(form({ id })), id).toEqual(NOT_FOUND);
    }
    expect(await voidInvoiceAction(form({ id: 'inv_a_paid' }))).toEqual(NOT_ALLOWED);
    expect(JSON.stringify(await snapshot())).toBe(before);
  });
  it('writes the void and ONE audit row with the partner scope', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await voidInvoiceAction(form({ id: 'inv_a' }))).toEqual({ ok: true });
    expect(await voidInvoiceAction(form({ id: 'inv_a' }))).toEqual(NOT_ALLOWED);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', action: 'b2b.invoice.void', subjectId: 'inv_a' });
    expect(rows[0].meta).toEqual({ actorScope: 'partner' });
  });
});

describe('reissueInvoiceAction', () => {
  it('passes the shared /partner action contract (admin allowed, agent bounced)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: reissueInvoiceAction,
      form: (id) => form({ id }),
      ownId: 'inv_a_dead',
      foreignId: 'inv_b_dead',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
    expect((await createB2bInvoiceRepo(db).getInvoice('reissue-inv_a_dead'))?.status).toBe('unpaid');
    expect(await createB2bInvoiceRepo(db).getInvoice('reissue-inv_b_dead')).toBeNull();
  });
  it('a double submit mints one clone and one audit row; an unpaid source is refused', async () => {
    await signIn({ username: 'pa-admin', role: 'admin' });
    expect(await reissueInvoiceAction(form({ id: 'inv_a_dead' }))).toEqual({ ok: true });
    expect(await reissueInvoiceAction(form({ id: 'inv_a_dead' }))).toEqual({ ok: true });
    expect((await db.select().from(b2bInvoices)).filter((r) => r.id.startsWith('reissue-'))).toHaveLength(1);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ actorScope: 'partner', reissuedAs: 'reissue-inv_a_dead' });
    expect(await reissueInvoiceAction(form({ id: 'inv_a' }))).toEqual(NOT_ALLOWED);
  });
});
