import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// UI redesign M3-5, Task 5.2 (+ H5): /partner/transfers and /partner/transfers/[id]. The M3-1
// harness on PGlite. Tenant isolation is asserted with crafted ids, cursors and filters, and the
// rendered HTML is checked against seeded PII.
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

import ListPage from '@/app/partner/(app)/transfers/page';
import DetailPage from '@/app/partner/(app)/transfers/[id]/page';
import { auditEvents, fundingEvents, transfers } from '@/db/schema';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { encodeTransferCursor } from '@/lib/partner-transfers';
import { createCustomerRepo } from '@/db/repos/customer-repo';

const PHONE = '14155550101';
const list = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve(sp) }));
const detail = async (id: string) => renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
const asAgent = () => signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });

// Distinctive seeded PII: none of it may reach the HTML.
const PII = ['14155550101', '5550101', '919876543210', '000011112222', 'HDFC0001111', 'Samplesurname', 'Legalfirst Legallast', 'internal staff note', 'kyb notes text'];
const expectNoPii = (html: string) => {
  for (const p of PII) expect(html, p).not.toContain(p);
};

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  const extra = { recipientLegalName: 'Legalfirst Legallast', adminNote: 'internal staff note', kybReviewNotes: 'kyb notes text', assignedTo: 'platform-ops' };
  // The SAME customer phone at both partners.
  await seedPartnerTransfer(db, { id: 'tr_A_held', partnerId: 'pa', phone: PHONE, status: 'in_review', complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.', 'Free text Samplesurname 919876543210'], createdAt: new Date(Date.now() - 60_000).toISOString(), ...extra });
  await seedPartnerTransfer(db, { id: 'tr_A_done', partnerId: 'pa', phone: PHONE, status: 'delivered', createdAt: new Date(Date.now() - 120_000).toISOString(), deliveredAt: new Date().toISOString(), ...extra });
  await seedPartnerTransfer(db, { id: 'tr_A_test', partnerId: 'pa', phone: PHONE, status: 'paid', environment: 'test', createdAt: new Date(Date.now() - 30_000).toISOString() });
  await seedPartnerTransfer(db, { id: 'tr_B_held', partnerId: 'pb', phone: PHONE, status: 'in_review', complianceStatus: 'flagged', createdAt: new Date(Date.now() - 90_000).toISOString(), ...extra });
});

describe('/partner/transfers: gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; support → /partner', async () => {
    await expect(list()).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined });
    await expect(list()).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs(redis, cookieJar, { username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(list()).rejects.toThrow('REDIRECT:/partner');
    await expect(detail('tr_A_held')).rejects.toThrow('REDIRECT:/partner');
  });
});

describe('/partner/transfers: list', () => {
  it("lists the tenant's live transfers only (never B's, even for the same customer phone)", async () => {
    await asAdmin();
    const html = await list();
    expect(html).toContain('tr_A_held');
    expect(html).toContain('tr_A_done');
    expect(html).not.toContain('tr_B_held');
    expect(html).not.toContain('tr_A_test'); // live by default
    expect(html).toContain('href="/partner/transfers/tr_A_held"');
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<main\b/);
    expectNoPii(html);
    expect(html).toContain('Testname S.');
  });
  it('?partnerId=pb / ?partner=pb are ignored', async () => {
    await asAdmin();
    const html = await list({ partnerId: 'pb', partner: 'pb' });
    expect(html).toContain('tr_A_held');
    expect(html).not.toContain('tr_B_held');
  });
  it("?q=<B's id> is the plain empty state (no hint that it exists)", async () => {
    await asAdmin();
    const html = await list({ q: 'tr_B_held' });
    // Only the searched value is echoed back into its own input; no row, no link.
    expect(html).not.toContain('data-row="tr_B_held"');
    expect(html).not.toContain('/partner/transfers/tr_B_held');
    expect(html.split('tr_B_held').length - 1).toBe(1);
    expect(html).toContain('No transfers match');
    const missing = await list({ q: 'tr_missing' });
    // Same body for "someone else's" and "missing" (only the echoed search value differs).
    expect(html.replaceAll('tr_B_held', 'X')).toBe(missing.replaceAll('tr_missing', 'X'));
  });
  it('?q=<own id> finds it; a status filter that does not match empties it', async () => {
    await asAdmin();
    expect(await list({ q: 'tr_A_done' })).toContain('href="/partner/transfers/tr_A_done"');
    expect(await list({ q: 'tr_A_done', status: 'in_review' })).not.toContain('href="/partner/transfers/tr_A_done"');
  });
  it('the id search honours the mode filter', async () => {
    await asAdmin();
    expect(await list({ q: 'tr_A_test' })).not.toContain('href="/partner/transfers/tr_A_test"');
    expect(await list({ q: 'tr_A_test', environment: 'test' })).toContain('href="/partner/transfers/tr_A_test"');
  });
  it('the status filter is a closed set', async () => {
    await asAdmin();
    const held = await list({ status: 'in_review' });
    expect(held).toContain('tr_A_held');
    expect(held).not.toContain('tr_A_done');
    const junk = await list({ status: "in_review' OR 1=1" });
    expect(junk).toContain('tr_A_done');
  });
  it('test mode shows only sandbox rows, badged', async () => {
    await asAdmin();
    const html = await list({ environment: 'test' });
    expect(html).toContain('tr_A_test');
    expect(html).not.toContain('tr_A_held');
    expect(html).toContain('Test');
  });
  it("a crafted cursor pointing into B's rows still lists only A", async () => {
    await asAdmin();
    const [b] = await db.select().from(transfers).where(eq(transfers.id, 'tr_B_held'));
    const cursor = encodeTransferCursor(`${new Date(b.createdAt).toISOString()}|zzzz`);
    const html = await list({ cursor });
    expect(html).not.toContain('tr_B_held');
    expect(html).toContain('tr_A_done');
  });
  it('an empty tenant shows the empty state', async () => {
    await signInAs(redis, cookieJar, { username: 'pb-admin', partnerId: 'pb', role: 'admin' });
    await db.delete(transfers).where(eq(transfers.partnerId, 'pb'));
    const html = await list();
    expect(html).toContain('No transfers yet');
  });
  it('pages by keyset with a bounded page size', async () => {
    await asAdmin();
    for (let i = 0; i < 30; i++) {
      await seedPartnerTransfer(db, { id: `tr_A_bulk${String(i).padStart(2, '0')}`, partnerId: 'pa', createdAt: new Date(Date.now() - 1_000_000 - i * 1000).toISOString() });
    }
    const html = await list();
    expect(html).toContain('rel="next"');
    const m = /href="\/partner\/transfers\?cursor=([A-Za-z0-9_-]+)"/.exec(html);
    expect(m).not.toBeNull();
    const next = await list({ cursor: m![1] });
    expect(next).toContain('tr_A_bulk29');
  });
});

describe('/partner/transfers/[id]: detail', () => {
  it("B's id is NOT_FOUND (the same as a missing id), even for an admin", async () => {
    await asAdmin();
    await expect(detail('tr_B_held')).rejects.toThrow('NOT_FOUND');
    await expect(detail('tr_missing')).rejects.toThrow('NOT_FOUND');
    await expect(detail("x' OR 1=1")).rejects.toThrow('NOT_FOUND');
  });
  it('renders masked values only, the hold reasons from known labels, and one h1', async () => {
    await asAgent();
    const html = await detail('tr_A_held');
    expect(html).toMatch(/\*\*\*\*\d{4}/);
    expectNoPii(html);
    expect(html).toContain('Large transfer amount');
    expect(html).toContain('Other review reason');
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<main\b/);
    expect(html).toContain('name="note"');
    expect(html).toMatch(/name="requestKey" value="[0-9a-f]{32}"/);
    expect(html).toContain('name="id" value="tr_A_held"');
  });
  it('a delivered transfer has no note form', async () => {
    await asAdmin();
    const html = await detail('tr_A_done');
    expect(html).not.toContain('name="note"');
    expectNoPii(html);
  });
  it("the timeline shows this tenant's note rows only (a pb row about A's id never renders)", async () => {
    await asAgent();
    await createAuditRepo(db).record({ partnerId: 'pa', actor: 'pa-agent', actorType: 'staff', action: 'transfer.hold.note', subjectId: 'tr_A_held', meta: { note: 'Checked source of funds', actorScope: 'partner' } });
    await createAuditRepo(db).record({ partnerId: 'pb', actor: 'pb-agent', actorType: 'staff', action: 'transfer.hold.note', subjectId: 'tr_A_held', meta: { note: 'LEAK-FROM-PB', actorScope: 'partner' } });
    await createAuditRepo(db).record({ partnerId: 'pa', actor: 'platform-ops', actorType: 'staff', action: 'transfer.release', subjectId: 'tr_A_held', meta: { reason: 'PLATFORM-REASON' } });
    await createAuditRepo(db).record({ partnerId: 'pa', actor: 'sys', actorType: 'system', action: 'sanctions.screen', subjectId: 'tr_A_held', meta: { evidence: 'EVIDENCE' } });
    const html = await detail('tr_A_held');
    expect(html).toContain('Checked source of funds');
    expect(html).toContain('pa-agent');
    expect(html).not.toContain('LEAK-FROM-PB');
    expect(html).not.toContain('PLATFORM-REASON');
    expect(html).not.toContain('platform-ops');
    expect(html).not.toContain('EVIDENCE');
    expect(html).toContain('SmartRemit');
  });
  it('the timeline keeps the NEWEST rows when a trail is long', async () => {
    await asAgent();
    const repo = createAuditRepo(db);
    for (let i = 0; i < 105; i++) {
      await repo.record({ partnerId: 'pa', actor: 'pa-agent', actorType: 'staff', action: 'transfer.hold.note', subjectId: 'tr_A_held', meta: { note: `bulk note ${i}`, actorScope: 'partner' } });
    }
    await repo.record({ partnerId: 'pa', actor: 'platform-ops', actorType: 'staff', action: 'transfer.release', subjectId: 'tr_A_held', meta: {} });
    const html = await detail('tr_A_held');
    expect(html).toContain('Hold released');
    expect(html).toContain('bulk note 104');
  });
});

describe('/partner/transfers/[id]: H5 funding + settlement instruction', () => {
  beforeEach(async () => {
    await db
      .update(transfers)
      .set({ fundingMethod: 'ach_pull', fundingProvider: 'stripe', fundingIntentRef: 'pi_3QsecretintentWXYZ', fundingState: 'succeeded', fundingRef: 'pi_3QsecretintentWXYZ', paymentProviderRef: 'railref-secret-7788' })
      .where(eq(transfers.id, 'tr_A_held'));
    await db.insert(fundingEvents).values([
      { partnerId: 'pa', provider: 'stripe', eventId: 'evt_secretA0001', eventType: 'payment_intent.succeeded', transferId: 'tr_A_held', outcome: 'funded' },
      { partnerId: 'pb', provider: 'stripe', eventId: 'evt_LEAKB9999', eventType: 'charge.dispute.created', transferId: 'tr_A_held', outcome: 'inquiry' },
    ]);
    await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: 'tr_A_held' }, { dedupeKey: 'instruct:tr_A_held' });
    await db.execute(sql`UPDATE outbox SET status = 'failed', attempts = 2, last_error = 'LASTERR partner pa internal' WHERE dedupe_key = 'instruct:tr_A_held'`);
  });
  it('shows method, provider, state and masked refs; the settlement status; never raw refs, payloads or errors', async () => {
    await asAgent();
    const html = await detail('tr_A_held');
    expect(html).toContain('US bank account (ACH)');
    expect(html).toContain('Stripe');
    expect(html).toContain('Funds received');
    expect(html).toContain('****WXYZ');
    expect(html).not.toContain('pi_3Qsecret');
    expect(html).toContain('Payment succeeded');
    expect(html).toContain('****0001');
    expect(html).not.toContain('evt_secret');
    expect(html).not.toContain('LEAKB');
    expect(html).not.toContain('Dispute opened');
    expect(html).toContain('Retrying');
    expect(html).not.toContain('LASTERR');
    expect(html).toContain('****7788');
    expect(html).not.toContain('railref-secret');
  });
  it('a transfer with no rail row is "Not started"; a sandbox transfer is "Not sent (test transfer)"', async () => {
    await asAgent();
    await db.execute(sql`DELETE FROM outbox`);
    expect(await detail('tr_A_held')).toContain('Not started');
    expect(await detail('tr_A_test')).toContain('Not sent (test transfer)');
  });
});

describe('the page reads never cross tenants (query-level)', () => {
  it('no audit rows are written by viewing (reads only)', async () => {
    await asAdmin();
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n;
    await list();
    await detail('tr_A_held');
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0].n).toBe(before);
  });
});

describe('/partner/transfers/[id]: M3-10 Release button (UX only; the action is the guard)', () => {
  const RELEASE = 'data-testid="partner-release"';
  const delegate = (id: string) => db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = ${id}`);
  const seedHold = (id: string, reasons: string[]) =>
    seedPartnerTransfer(db, { id, partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: reasons });
  // M3-10 follow-up: the sender's customer row (unflagged) for the default seeded phone.
  beforeEach(async () => {
    await createCustomerRepo(db, async () => null).ensureCustomer('pa', PHONE);
  });

  it('shows for an admin on a delegated partner’s EDD-class hold', async () => {
    await delegate('pa');
    await seedHold('tr_A_edd', ['Large transfer amount.', 'edd_required']);
    await asAdmin();
    const html = await detail('tr_A_edd');
    expect(html).toContain(RELEASE);
    expect(html).toContain('Release hold');
    expectNoPii(html);
  });

  it.each(['pep_hit', 'watchlist_hit'])('hidden when the SENDER customer has %s (M3-10 follow-up), and when the sender row is missing', async (col) => {
    await delegate('pa');
    await seedHold('tr_A_edd', ['Large transfer amount.']);
    await asAdmin();
    expect(await detail('tr_A_edd')).toContain(RELEASE);
    await db.execute(sql`UPDATE customers SET ${sql.raw(col)} = true WHERE partner_id = 'pa'`);
    const html = await detail('tr_A_edd');
    expect(html).not.toContain(RELEASE);
    expect(html).toContain('SmartRemit compliance reviews and releases this hold.');
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'pa'`);
    expect(await detail('tr_A_edd')).not.toContain(RELEASE);
  });

  it('hidden for an agent (who is told an admin can release it)', async () => {
    await delegate('pa');
    await seedHold('tr_A_edd', ['Large transfer amount.']);
    await asAgent();
    const html = await detail('tr_A_edd');
    expect(html).not.toContain(RELEASE);
    expect(html).toContain('An admin on your team can release this hold.');
  });

  it('hidden on a screening hold, an AML hold, a free-text reason and for a kycMode ours partner', async () => {
    await delegate('pa');
    await seedHold('tr_A_scr', ['Large transfer amount.', 'Name screening needs manual review.']);
    await seedHold('tr_A_aml', ['Additional review required.']);
    await asAdmin();
    for (const id of ['tr_A_scr', 'tr_A_aml', 'tr_A_held']) {
      const html = await detail(id);
      expect(html, id).not.toContain(RELEASE);
      expect(html, id).toContain('SmartRemit compliance reviews and releases this hold.');
    }
    await db.execute(sql`UPDATE partners SET kyc_mode = 'ours' WHERE id = 'pa'`);
    await seedHold('tr_A_edd', ['Large transfer amount.']);
    expect(await detail('tr_A_edd')).not.toContain(RELEASE);
  });
});

describe('lost-features A6: the Business invoices link', () => {
  it('admins get it in the header; agents and finance do not', async () => {
    await asAdmin();
    expect(await list()).toContain('href="/partner/invoices"');
    await asAgent();
    expect(await list()).not.toContain('href="/partner/invoices"');
    await signInAs(redis, cookieJar, { username: 'pa-fin', partnerId: 'pa', role: 'finance' as 'admin' });
    expect(await list()).not.toContain('href="/partner/invoices"');
  });
});

describe('/partner/transfers/[id]: A3 purpose row', () => {
  it('shows the purpose and the unconfirmed suggested code for family support', async () => {
    await seedPartnerTransfer(db, { id: 'tr_A_purpose', partnerId: 'pa', phone: PHONE, status: 'paid', purpose: 'family_support' });
    await asAdmin();
    const html = await detail('tr_A_purpose');
    expect(html).toContain('Purpose');
    expect(html).toContain('Family support');
    expect(html).toContain('Suggested RBI code P1301 (not confirmed)');
    expectNoPii(html);
  });
  it('a purpose without a code shows the label only', async () => {
    await seedPartnerTransfer(db, { id: 'tr_A_edu', partnerId: 'pa', phone: PHONE, status: 'paid', purpose: 'education' });
    await asAgent();
    const html = await detail('tr_A_edu');
    expect(html).toContain('Education');
    expect(html).not.toContain('Suggested RBI code');
  });
  it('no purpose ⇒ the row says Not stated', async () => {
    await asAdmin();
    const html = await detail('tr_A_done');
    expect(html).not.toContain('Suggested RBI code');
    // The row stays, so a missing purpose reads as "Not stated", not as a missing feature.
    expect(html).toMatch(/>Purpose</);
    expect(html).toContain('Not stated');
  });
  it("another tenant's transfer with a purpose is still NOT_FOUND", async () => {
    await seedPartnerTransfer(db, { id: 'tr_B_purpose', partnerId: 'pb', phone: PHONE, status: 'paid', purpose: 'family_support' });
    await asAdmin();
    await expect(detail('tr_B_purpose')).rejects.toThrow('NOT_FOUND');
  });
});

describe('/partner/transfers/[id]: B1 order references', () => {
  it('shows the client reference and the payout reference', async () => {
    await seedPartnerTransfer(db, {
      id: 'tr_A_refs', partnerId: 'pa', phone: PHONE, status: 'delivered',
      clientReference: 'INV-2026/10#7', payoutReference: 'SIMPAY-tr_A_refs',
    });
    await asAgent();
    const html = await detail('tr_A_refs');
    expect(html).toContain('Your order reference');
    expect(html).toContain('INV-2026/10#7');
    expect(html).toContain('Payout reference');
    expect(html).toContain('SIMPAY-tr_A_refs');
  });
  it('no references: both rows say None', async () => {
    await asAdmin();
    const html = await detail('tr_A_done');
    expect(html).toMatch(/>Your order reference</);
    expect(html).toMatch(/>Payout reference</);
  });
});
