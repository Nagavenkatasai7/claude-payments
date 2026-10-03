import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// Lost-features A6: /partner/invoices. The M3-1 harness on PGlite: admin only, the session tenant's
// bills only, masked buyers, and the one control each status allows.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;

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
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
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

import InvoicesPage from '@/app/partner/(app)/invoices/page';
import { createB2bInvoiceRepo } from '@/db/repos/aux-repos';
import type { B2bInvoice } from '@/lib/types';

const render = async () => renderToStaticMarkup(await InvoicesPage());
const BUYER_A = '15557770101';
const BUYER_B = '15558880202';
const inv = (o: Partial<B2bInvoice> & { id: string; partnerId: string }): B2bInvoice => ({
  businessName: 'Alpha Seller',
  buyerPhone: BUYER_A,
  lineItems: [{ description: 'Secret line item', qty: 1, unitAmountUsd: 100 }],
  amountUsd: 100,
  currency: 'USD',
  status: 'unpaid',
  createdAt: new Date().toISOString(),
  ...o,
});

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  const repo = createB2bInvoiceRepo(db);
  await repo.saveInvoice(inv({ id: 'inv_a_open', partnerId: 'pa' }));
  await repo.saveInvoice(inv({ id: 'inv_a_dead', partnerId: 'pa', status: 'voided' }));
  await repo.saveInvoice(inv({ id: 'inv_a_paid', partnerId: 'pa', status: 'paid', paidAt: new Date().toISOString() }));
  await repo.saveInvoice(inv({ id: 'inv_a_old', partnerId: 'pa', createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
  await repo.saveInvoice(inv({ id: 'inv_b_open', partnerId: 'pb', businessName: 'Bravo Seller', buyerPhone: BUYER_B }));
});

describe('/partner/invoices', () => {
  it('admin only: anonymous → /login, platform → /admin-dashboard, agent / support / finance → /partner', async () => {
    await expect(render()).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined });
    await expect(render()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role: role as 'admin' });
      await expect(render(), role).rejects.toThrow('REDIRECT:/partner');
    }
  });
  it("lists only the session tenant's bills, buyers masked, no line-item text, one h1", async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const html = await render();
    for (const id of ['inv_a_open', 'inv_a_dead', 'inv_a_paid', 'inv_a_old']) expect(html, id).toContain(id);
    expect(html).not.toContain('inv_b_open');
    expect(html).not.toContain('Bravo Seller');
    expect(html).not.toContain(BUYER_A);
    expect(html).not.toContain(BUYER_B);
    expect(html).not.toContain('Secret line item');
    expect(html).toContain('0101');
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
  });
  it('each status offers its one control; an old unpaid bill reads Expired and can still be voided', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const html = await render();
    const row = (id: string) => html.slice(html.indexOf(`data-row="${id}"`), html.indexOf('</tr>', html.indexOf(`data-row="${id}"`)));
    expect(row('inv_a_open')).toContain('data-invoice-control="void"');
    expect(row('inv_a_dead')).toContain('data-invoice-control="reissue"');
    expect(row('inv_a_paid')).not.toContain('data-invoice-control');
    expect(row('inv_a_old')).toContain('Expired');
    expect(row('inv_a_old')).toContain('data-invoice-control="void"');
  });
  it('an empty tenant shows the empty state', async () => {
    await signInAs(redis, cookieJar, { username: 'pb-admin', partnerId: 'pb', role: 'admin' });
    await db.delete((await import('@/db/schema')).b2bInvoices);
    expect(await render()).toContain('No business invoices yet');
  });
});
