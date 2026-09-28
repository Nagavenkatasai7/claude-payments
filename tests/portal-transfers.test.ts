import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { decodePortalCursor, encodePortalCursor, receiptView, renderReceiptText } from '@/lib/portal-transfers';
import { saveTransferFilter } from '@/lib/portal-transfer-filter';
import { freshDb } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';
import type { Transfer } from '@/lib/types';

// UI redesign M2-7, Task 7.2: Home, the transfer list, the detail page and the printable receipt
// (render tests over the real PGlite fixture; the UI itself is walked after enablement). Pinned:
// no unmasked destination in any HTML, the KYC banner when gated, the search form POSTs (no name in
// a URL), the empty state, and 404 for another customer's or another partner's transfer.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  db: null as unknown,
  redis: null as unknown,
  store: null as unknown,
  ps: null as unknown,
}));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({
  getPortalCustomer: async () => h.ctx,
  requirePortalCustomer: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    return h.ctx;
  },
  requireFreshPortalAuth: async () => h.ctx,
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => h.ps }));

import PortalHomePage from '@/app/portal/page';
import TransfersPage from '@/app/portal/transfers/page';
import TransferDetailPage from '@/app/portal/transfers/[id]/page';
import ReceiptPage from '@/app/portal/transfers/[id]/receipt/page';

let db: Db;
let redis: FakeRedis;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;

function signIn(partnerId: string, p: string, kycStatus = 'verified') {
  h.site = { partnerId, slug: partnerId, brand: `Brand ${partnerId}`, logo: null, theme: {} };
  h.ctx = { site: h.site, session: { phone: p, sid: 's1' }, token: 'tok', customer: { partnerId, senderPhone: p, kycStatus } };
}

const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const home = async () => renderToStaticMarkup(await PortalHomePage());
const list = async (q: Record<string, string> = {}) => renderToStaticMarkup(await TransfersPage({ searchParams: sp(q) }));
const detail = async (id: string) => renderToStaticMarkup(await TransferDetailPage({ params: Promise.resolve({ id }) }));
const receipt = async (id: string) => renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ id }) }));

const FULL_ACCOUNT = '000011112222';

beforeEach(async () => {
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.db = db;
  h.redis = redis;
  h.store = createStore(redis, db);
  h.ps = createPartnerStore(db);
  signIn('pa', phone);
});

describe('Home', () => {
  it('quick send, the recent transfers (masked), and no KYC banner for a verified customer', async () => {
    const html = await home();
    expect(html).toContain('href="/portal/send"');
    for (const id of A.transferIds) expect(html).toContain(`href="/portal/transfers/${id}"`);
    for (const id of B.transferIds) expect(html).not.toContain(id);
    expect(html).not.toContain(FULL_ACCOUNT);
    expect(html).not.toContain('data-kyc-banner');
  });
  it('the KYC banner shows when the partner gates sends and the customer is not verified', async () => {
    signIn('pa', phone, 'pending');
    await db.execute(sql`UPDATE partners SET require_kyc_before_send = true WHERE id = 'pa'`);
    expect(await home()).toContain('data-kyc-banner');
    expect(await home()).toContain('href="/portal/profile"');
  });
  it('no KYC banner when the partner does not gate sends on KYC', async () => {
    signIn('pa', phone, 'pending');
    expect(await home()).not.toContain('data-kyc-banner');
  });
  it('the empty state when the customer has no transfers', async () => {
    signIn('pa', '14155550177');
    const html = await home();
    expect(html).toContain('data-empty');
    expect(html).not.toContain('/portal/transfers/');
  });
  it('apex → 404; signed out → sign-in', async () => {
    h.site = null;
    await expect(PortalHomePage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    signIn('pa', phone);
    h.ctx = null;
    await expect(PortalHomePage()).rejects.toThrow('REDIRECT:/portal/login');
  });
});

describe('Transfers list', () => {
  it("lists A's transfers only, masked, as a table (sm+) and cards (below sm)", async () => {
    const html = await list();
    for (const id of A.transferIds) expect(html).toContain(`href="/portal/transfers/${id}"`);
    for (const id of B.transferIds) expect(html).not.toContain(id);
    expect(html).not.toContain(FULL_ACCOUNT);
    expect(html).toMatch(/\*{4}/);
    expect(html).toContain('<table');
    expect(html).toContain('data-cards');
  });
  it('the search form POSTs to a server action (no GET form, no name in a URL)', async () => {
    const html = await list();
    const form = html.match(/<form[^>]*>/)?.[0] ?? '';
    expect(form).not.toMatch(/method="get"/i);
    expect(form).not.toMatch(/action="\/portal/);
    expect(html).toContain('name="q"');
    expect(html).toContain('name="status"');
  });
  it('?f= applies THIS customer\'s stored filter; another customer\'s f is ignored', async () => {
    const f = (await saveTransferFilter(redis, { partnerId: 'pa', phone }, { status: 'completed' }))!;
    const html = await list({ f });
    expect(html).toContain(`/portal/transfers/${A.transferIds[1]}`);
    expect(html).not.toContain(`/portal/transfers/${A.transferIds[0]}"`);
    const fOther = (await saveTransferFilter(redis, { partnerId: 'pb', phone }, { status: 'completed' }))!;
    const html2 = await list({ f: fOther });
    for (const id of A.transferIds) expect(html2).toContain(`/portal/transfers/${id}`);
  });
  it('a search that matches nothing shows the no-results state', async () => {
    const f = (await saveTransferFilter(redis, { partnerId: 'pa', phone }, { q: 'nobody-by-this-name' }))!;
    expect(await list({ f })).toContain('data-empty');
  });
  it('the cursor is opaque in the URL and round-trips', () => {
    const c = '2026-01-02T03:04:05.000Z|abcDEF_-12';
    const enc = encodePortalCursor(c);
    expect(enc).not.toContain('|');
    expect(decodePortalCursor(enc)).toBe(c);
    expect(decodePortalCursor('%%%')).toBeUndefined();
    expect(decodePortalCursor('x'.repeat(400))).toBeUndefined();
  });
});

describe('Transfer detail', () => {
  it("A's transfer: status, timeline, masked destination only, and the receipt link", async () => {
    const html = await detail(A.transferIds[0]);
    expect(html).toContain('sh-page-title');
    expect(html).toContain('Payment received');
    expect(html).toMatch(/\*{4}/);
    expect(html).not.toContain(FULL_ACCOUNT);
    expect(html).not.toContain('HDFC0000001');
    expect(html).toContain(`href="/portal/transfers/${A.transferIds[0]}/receipt"`);
    expect(html).toContain('name="requestKey"');
  });
  it("B's transfer and another phone's transfer → 404", async () => {
    await expect(detail(B.transferIds[0])).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    signIn('pa', '14155550177');
    await expect(detail(A.transferIds[0])).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
  it('a delivered transfer inside the window offers "report a problem" with the reason list', async () => {
    const html = await detail(A.transferIds[1]);
    expect(html).toContain('name="reason"');
    expect(html).toContain('value="not_received"');
  });
});

describe('Printable receipt', () => {
  it('masked, with the Reg E disclosure block and no script', async () => {
    const html = await receipt(A.transferIds[0]);
    expect(html).not.toContain(FULL_ACCOUNT);
    expect(html).toMatch(/\*{4}/);
    expect(html).toContain('data-disclosure-version');
    expect(html).not.toContain('<script');
  });
  it("B's transfer → 404", async () => {
    await expect(receipt(B.transferIds[0])).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('renderReceiptText', () => {
  it('holds the masked destination and never the full account', () => {
    const t = {
      id: 'tx_12345678', createdAt: '2026-01-02T03:04:05.000Z', recipientName: 'R Name', payoutDestination: '****2222', payoutMethod: 'bank',
      amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 85, amountInr: 8500, status: 'paid', refundStatus: 'none',
      sourceCurrency: 'USD', destinationCurrency: 'INR',
    } as unknown as Transfer;
    const text = renderReceiptText(receiptView(t), 'Acme');
    expect(text).toContain('****2222');
    expect(text).toContain('Acme');
    expect(text).toContain('tx_12345678');
    expect(text).not.toContain(FULL_ACCOUNT);
  });
});
