import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { decodePortalCursor, encodePortalCursor, receiptView, renderReceiptText } from '@/lib/portal-transfers';
import { saveTransferFilter } from '@/lib/portal-transfer-filter';
import { customerPortalPrefs } from '@/db/schema';
import { encryptField } from '@/lib/field-crypto';
import { customerEmailCtx } from '@/lib/crypto-context';
import { emailVerifiedTag } from '@/lib/portal-prefs';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { newTransferId } from '@/lib/id';
import { freshDb } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';
import type { Transfer } from '@/lib/types';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { DEFAULT_CATALOG } from '@/lib/rewards/settings';
import { easternMonth } from '@/lib/dates';

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
  returnTo: undefined as string | undefined,
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
  requirePortalCustomer: async (returnTo?: string) => {
    h.returnTo = returnTo;
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

describe('Home: B3 My rewards card', () => {
  async function rewardsOn() {
    process.env.DEMO_PHONES = '*';
    await createFeatureFlagRepo(db).upsert({ key: 'rewards.enabled', scopeType: 'partner', scopeId: 'pa', enabled: true, reason: 'B3 test switch', updatedBy: 'root' });
    invalidateFlagCache(db);
    const repo = createRewardRepo(db);
    await repo.upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: true }, 'root');
    await repo.upsertPartnerSetting('pa', { kind: 'nth_transfer', enabled: true, nth: 5 }, 'pa-admin');
    await repo.insertRedemption({
      transferId: A.transferIds[0], partnerId: 'pa', phone, month: easternMonth(Date.now()),
      reward: { kind: 'first_transfer', discountUsd: 1.99, detail: {} }, giveBackUsd: 0, giveBackWithheld: false,
    });
  }
  afterEach(() => {
    delete process.env.DEMO_PHONES;
    invalidateFlagCache(db);
  });

  it('hidden while the switch is off (the default)', async () => {
    expect(await home()).not.toContain('data-my-rewards');
  });
  it('shown when rewards are on: the offers that are on and the customer\'s own rewards', async () => {
    await rewardsOn();
    const html = await home();
    expect(html).toContain('data-my-rewards');
    expect(html).toContain('Every 5th transfer you send in a month has no fee (up to $2.99 off).');
    expect(html).toContain('Reward: first transfer free (saved $1.99).');
    // Partner B's customer (same phone) sees no card: the switch is on for A only.
    signIn('pb', phone);
    expect(await home()).not.toContain('data-my-rewards');
  });
  it('the receipt shows the reward line', async () => {
    await rewardsOn();
    expect(await receipt(A.transferIds[0])).toContain('Reward: first transfer free (saved $1.99).');
    expect(await receipt(A.transferIds[1])).not.toContain('data-reward-line');
  });
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
  it('one customer portal: the four tiles, from THIS customer on THIS partner only', async () => {
    const html = await home();
    expect(html).toContain('data-stat-tiles');
    for (const label of ['Sent this month', 'Daily limit left', 'Transfers', 'Pending refunds']) expect(html).toContain(label);
    // A's fixture: two live transfers (B's two are on another partner and never counted).
    expect(html).toMatch(/>Transfers<\/p><p[^>]*>2<\/p>/);
  });
  it('one customer portal: saved recipients with Send again (masked, rid link), never another partner\'s', async () => {
    const html = await home();
    expect(html).toContain('data-saved-recipients');
    expect(html).toContain('Recipient PA');
    expect(html).not.toContain('Recipient PB');
    expect(html).not.toContain(FULL_ACCOUNT);
    expect(html).toMatch(/href="\/portal\/send\?r=[^"]+"[^>]*>Send again</);
  });
  it('one customer portal: no Send again while sending is blocked by the identity check', async () => {
    signIn('pa', phone, 'pending');
    await db.execute(sql`UPDATE partners SET require_kyc_before_send = true WHERE id = 'pa'`);
    const html = await home();
    expect(html).toContain('data-kyc-banner');
    expect(html).not.toContain('data-saved-recipients');
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

describe('Transfer detail: "Email me a receipt" only for a verified address (#397 review L3)', () => {
  const EMAIL = 'user@example.com';
  function withEmail(partnerId: string) {
    signIn(partnerId, phone);
    (h.ctx as { customer: Record<string, unknown> }).customer.email = encryptField(EMAIL, undefined, customerEmailCtx({ partnerId, senderPhone: phone }));
  }
  it('no verified address → no email button, a link to Notifications instead', async () => {
    withEmail('pa');
    const html = await detail(A.transferIds[0]);
    expect(html).not.toContain('Email me a receipt');
    expect(html).toContain('href="/portal/notifications"');
    expect(html).toContain('Add and verify an email address');
  });
  it('verified for THIS partner → the button; the same phone verified only on partner B does not count on A', async () => {
    await db.insert(customerPortalPrefs).values({ partnerId: 'pb', phone, emailVerifiedAt: new Date(), emailVerifiedTag: emailVerifiedTag('pb', phone, EMAIL) });
    withEmail('pa');
    expect(await detail(A.transferIds[0])).not.toContain('Email me a receipt');
    await db.insert(customerPortalPrefs).values({ partnerId: 'pa', phone, emailVerifiedAt: new Date(), emailVerifiedTag: emailVerifiedTag('pa', phone, EMAIL) });
    const html = await detail(A.transferIds[0]);
    expect(html).toContain('Email me a receipt');
    expect(html).not.toContain(EMAIL);
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

// Lost-features p4 B1 + B2: business names, badges and the Payment card on a b2b transfer; paid and
// delivered times on the receipt. The full account number never renders.
async function seedOwn(over: Partial<Transfer>): Promise<string> {
  const id = newTransferId();
  await createTransferRepo(db).saveTransfer({
    id, phone, amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85, amountInr: 8500,
    recipientName: 'Mumbai Textiles', recipientPhone: '919000000000', payoutMethod: 'bank',
    payoutDestination: `${FULL_ACCOUNT}|HDFC0000001`, fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
    complianceReasons: [], status: 'paid', createdAt: new Date().toISOString(), partnerId: 'pa',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 100, feeSource: 0, totalChargeSource: 100, ...over,
  } as Transfer);
  return id;
}
const B2B: Partial<Transfer> = {
  transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business', fundingMethod: 'ach_pull',
  senderBusinessName: 'Acme Imports LLC', recipientBusinessName: 'Mumbai Textiles Pvt',
};

describe('Business (b2b) transfers: names, badges and the Payment card', () => {
  it('detail: both business names, the badges and the funding line; never the full account', async () => {
    const html = await detail(await seedOwn(B2B));
    expect(html).toContain('Mumbai Textiles Pvt');
    expect(html).toContain('Acme Imports LLC');
    expect(html).toContain('data-b2b-payment');
    expect(html).toContain('Business name');
    expect(html).toContain('Debited from business account');
    expect(html).toContain('>Business<');
    expect(html).not.toContain(FULL_ACCOUNT);
    expect(html).not.toContain('HDFC0000001');
  });
  it('receipt: the same names and Payment block; never the full account', async () => {
    const html = await receipt(await seedOwn(B2B));
    expect(html).toContain('Mumbai Textiles Pvt');
    expect(html).toContain('Acme Imports LLC');
    expect(html).toContain('data-b2b-payment');
    expect(html).not.toContain(FULL_ACCOUNT);
  });
  it('no sender business name: From is the masked phone, never the full number', async () => {
    const html = await detail(await seedOwn({ ...B2B, senderEntityType: 'individual', senderBusinessName: undefined }));
    expect(html).toContain(`\u2022\u2022\u2022\u2022${phone.slice(-4)}`);
    expect(html).not.toContain(phone);
    expect(html).toContain('>Individual<');
  });
  it('a consumer transfer has no Payment card and no badges', async () => {
    const html = await detail(A.transferIds[0]);
    expect(html).not.toContain('data-b2b-payment');
    expect(html).not.toContain('Business name');
  });
});

describe('C1: signed out, each page asks to come back to itself', () => {
  it('the list, the detail and the receipt pass their own path', async () => {
    h.ctx = null;
    const id = A.transferIds[0];
    await expect(list()).rejects.toThrow('REDIRECT:/portal/login');
    expect(h.returnTo).toBe('/portal/transfers');
    await expect(detail(id)).rejects.toThrow('REDIRECT:/portal/login');
    expect(h.returnTo).toBe(`/portal/transfers/${id}`);
    await expect(receipt(id)).rejects.toThrow('REDIRECT:/portal/login');
    expect(h.returnTo).toBe(`/portal/transfers/${id}/receipt`);
  });
});

describe('Receipt: paid and delivered times', () => {
  it('shows each time only when the row has it', async () => {
    const both = await receipt(await seedOwn({ status: 'delivered', paidAt: '2026-01-02T03:10:00.000Z', deliveredAt: '2026-01-02T09:00:00.000Z' }));
    expect(both).toContain('>Paid<');
    expect(both).toContain('Jan 2, 2026, 3:10 AM UTC');
    expect(both).toContain('>Delivered<');
    expect(both).toContain('Jan 2, 2026, 9:00 AM UTC');
    const none = await receipt(await seedOwn({ status: 'awaiting_payment' }));
    expect(none).not.toContain('>Paid<');
    expect(none).not.toContain('>Delivered<');
  });
  it('the detail timeline shows the paid time on the done step', async () => {
    const html = await detail(await seedOwn({ status: 'paid', paidAt: '2026-01-02T03:10:00.000Z' }));
    expect(html).toContain('Jan 2, 2026, 3:10 AM UTC');
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

  it('Batch B1: "Payout reference" shows only after delivery', () => {
    const base = {
      id: 'tx_ref1', createdAt: '2026-01-02T03:04:05.000Z', recipientName: 'R', payoutDestination: '****2222', payoutMethod: 'bank',
      amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 85, amountInr: 8500, refundStatus: 'none',
      sourceCurrency: 'USD', destinationCurrency: 'INR', payoutReference: 'SIMPAY-tx_ref1',
    };
    const delivered = receiptView({ ...base, status: 'delivered' } as unknown as Transfer);
    expect(delivered.payoutReference).toBe('SIMPAY-tx_ref1');
    expect(renderReceiptText(delivered, 'Acme')).toContain('Payout reference: SIMPAY-tx_ref1');
    const paid = receiptView({ ...base, status: 'paid' } as unknown as Transfer);
    expect(paid.payoutReference).toBeUndefined();
    expect(renderReceiptText(paid, 'Acme')).not.toContain('Payout reference');
  });

  it('B3: a reward adds one line after the fee, in the currency the customer paid in', () => {
    const t = {
      id: 'tx_1', createdAt: '2026-01-02T03:04:05.000Z', recipientName: 'R', payoutDestination: '****2222', payoutMethod: 'bank',
      amountUsd: 100, feeUsd: 0, totalChargeUsd: 100, fxRate: 85, amountInr: 8500, status: 'delivered', refundStatus: 'none',
      sourceCurrency: 'USD', destinationCurrency: 'INR',
    } as unknown as Transfer;
    expect(renderReceiptText(receiptView(t), 'Acme')).not.toContain('Reward');
    const text = renderReceiptText(receiptView(t, { kind: 'first_transfer', discountUsd: 1.99, detail: {} }), 'Acme');
    const lines = text.split('\n');
    const fee = lines.findIndex((l) => l.startsWith('Fee:'));
    expect(lines[fee + 1]).toBe('Reward: first transfer free (saved $1.99).');
    // A transfer paid in another currency shows the saving in that currency.
    const gbp = { ...t, sourceCurrency: 'GBP', amountSource: 80 } as unknown as Transfer;
    expect(receiptView(gbp, { kind: 'nth_transfer', discountUsd: 2.5, detail: { nth: 5 } }).rewardLine)
      .toBe('Reward: 5th transfer this month (saved £2.00).');
  });
});
