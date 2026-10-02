import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore, type Store } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

// Merge plan 2c (owner D5): AML alerts in /partner are ADMIN only. reviewAmlAlertAction (ported
// from the legacy compliance action) closes one of THIS tenant's open alerts; /partner/reviews
// lists held transfers, the KYC queue (masked) and, for admins, the open alerts as one label.
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
vi.mock('@/lib/kyc-case-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kyc-case-store')>('@/lib/kyc-case-store');
  const cs = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getKycCaseStore: (s: Store) => actual.createKycCaseStore(redis, cs.createCustomerStore(db, s)) };
});

import { reviewAmlAlertAction } from '@/app/partner/(app)/reviews/aml-actions';
import ReviewsPage from '@/app/partner/(app)/reviews/page';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { LARGE_AMOUNT_REASON } from '@/lib/compliance-config';
import { t } from '@/lib/i18n';

const form = (id: string, disposition = 'no_action', note?: string) => {
  const fd = new FormData();
  fd.set('alertId', id);
  fd.set('disposition', disposition);
  if (note !== undefined) fd.set('note', note);
  return fd;
};
async function seedAlert(partnerId: string, transferId: string, rule = 'structuring'): Promise<number> {
  await createAuditRepo(db).record({
    partnerId,
    actor: 'system',
    actorType: 'system',
    action: 'aml.alert',
    subjectId: transferId,
    meta: { rule, window: '7d', count: 7, sumUsd: 2737 },
  });
  return ((await db.execute(sql`SELECT max(id)::int AS id FROM audit_events`)) as unknown as { rows: Array<{ id: number }> }).rows[0].id;
}
const reviewed = async () =>
  ((await db.execute(sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = 'aml.reviewed' ORDER BY id`)) as unknown as {
    rows: Array<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }>;
  }).rows;
const auditCount = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;

let alertA: number;
let alertB: number;
beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  host.value = 'smartremit.ai';
  db = await freshDb();
  store = createStore(redis, db);
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  alertA = await seedAlert('pa', 'tr_amlA1');
  alertB = await seedAlert('pb', 'tr_amlB1');
});

const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

describe('reviewAmlAlertAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign alert, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: reviewAmlAlertAction,
      form: (id) => form(id),
      ownId: String(alertA),
      foreignId: String(alertB),
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot: async () => ({ audit: await auditCount(), reviewed: await reviewed() }),
    });
    const rows = await reviewed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'pa', subject_id: 'tr_amlA1' });
    expect(rows[0].meta).toEqual({ alertId: alertA, disposition: 'no_action', note: null, actorScope: 'partner' });
  });

  it.each(['agent', 'support', 'finance'] as const)('a non-admin role (%s) is refused (D5)', async (role) => {
    await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
    await expect(reviewAmlAlertAction(form(String(alertA)))).rejects.toThrow('REDIRECT:/partner');
    expect(await reviewed()).toEqual([]);
  });

  it('refuses on a partner-site host', async () => {
    await asAdmin();
    host.value = 'acme.smartremit.ai';
    await expect(reviewAmlAlertAction(form(String(alertA)))).rejects.toThrow('NOT_FOUND');
  });
});

describe('reviewAmlAlertAction: refusals', () => {
  it('a foreign, missing, junk or non-alert id is the SAME not-found, nothing written', async () => {
    await createAuditRepo(db).record({ partnerId: 'pa', actor: 'x', actorType: 'staff', action: 'transfer.release', subjectId: 'tr_x', meta: {} });
    const other = ((await db.execute(sql`SELECT max(id)::int AS id FROM audit_events`)) as unknown as { rows: Array<{ id: number }> }).rows[0].id;
    await asAdmin();
    const before = await auditCount();
    const nf = { ok: false, error: t('partner.reviews.aml.notFound') };
    expect(await reviewAmlAlertAction(form(String(alertB)))).toEqual(nf);
    expect(await reviewAmlAlertAction(form('999999'))).toEqual(nf);
    expect(await reviewAmlAlertAction(form('1 OR 1=1'))).toEqual(nf);
    expect(await reviewAmlAlertAction(form(String(other)))).toEqual(nf);
    expect(await auditCount()).toBe(before);
  });

  it('an unknown disposition and a note carrying a phone/account number are refused', async () => {
    await asAdmin();
    expect(await reviewAmlAlertAction(form(String(alertA), 'cleared'))).toEqual({ ok: false, error: t('partner.reviews.aml.invalidDisposition') });
    expect(await reviewAmlAlertAction(form(String(alertA), 'escalated', 'Called 415 555 0101'))).toEqual({
      ok: false,
      error: t('partner.reviews.aml.noteHasNumber'),
    });
    expect(await reviewed()).toEqual([]);
  });
});

describe('reviewAmlAlertAction: success', () => {
  it('writes ONE aml.reviewed row; a replay writes nothing extra; the alert leaves the open list', async () => {
    await asAdmin();
    expect(await reviewAmlAlertAction(form(String(alertA), 'escalated', 'Asked the sender for payslips.'))).toEqual({ ok: true });
    expect(await reviewAmlAlertAction(form(String(alertA), 'no_action'))).toEqual({ ok: true });
    const rows = await reviewed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', subject_id: 'tr_amlA1' });
    expect(rows[0].meta).toMatchObject({ alertId: alertA, disposition: 'escalated', note: 'Asked the sender for payslips.', actorScope: 'partner' });
    expect((await createAuditRepo(db).listOpenAmlAlerts('pa')).map((a) => a.id)).toEqual([]);
    expect((await createAuditRepo(db).listOpenAmlAlerts('pb')).map((a) => a.id)).toEqual([alertB]);
    expect(revalidated).toContain('/partner/reviews');
  });
});

describe('/partner/reviews page', () => {
  const PHONE = '15551239876';
  const seedQueued = (partnerId: string, o: Partial<Customer> = {}) =>
    createCustomerStore(db, store).saveCustomer({
      senderPhone: PHONE,
      firstSeenAt: new Date().toISOString(),
      kycStatus: 'pending',
      kycReviewState: 'needs_review',
      senderCountry: 'US',
      partnerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fullName: 'Qzxname Vortsurname',
      kycRejectedReason: 'LISTMATCHDETAIL',
      ...o,
    } as Customer);
  const render = async () => renderToStaticMarkup(await ReviewsPage());
  beforeEach(async () => {
    await seedPartnerTransfer(db, { id: 'tr_heldA1', partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await seedPartnerTransfer(db, { id: 'tr_heldB1', partnerId: 'pb', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON] });
    await seedPartnerTransfer(db, { id: 'tr_paidA1', partnerId: 'pa', status: 'paid' });
    await seedQueued('pa', { pepHit: true, watchlistHit: true });
    await seedQueued('pb');
  });

  it('admin: held transfers, the masked KYC queue and the AML alerts as ONE label (no rule detail), own tenant only', async () => {
    await asAdmin();
    const html = await render();
    expect(html).toContain('data-testid="partner-reviews-held"');
    expect(html).toContain('tr_heldA1');
    expect(html).not.toContain('tr_heldB1');
    expect(html).not.toContain('tr_paidA1');
    expect(html).toContain('data-testid="partner-reviews-kyc"');
    expect(html).toContain('/partner/customers/');
    expect(html).toContain('9876'); // masked last 4 only
    expect(html).not.toContain(PHONE);
    expect(html).not.toMatch(/Qzxname|Vortsurname|LISTMATCHDETAIL/);
    expect(html.toLowerCase()).not.toMatch(/watchlist|\bpep\b|sanction/);
    expect(html).toContain('data-testid="partner-reviews-aml"');
    expect(html).toContain(t('partner.reviews.aml.rule.structuring'));
    expect(html).toContain('href="/partner/transfers/tr_amlA1"');
    expect(html).not.toContain('tr_amlB1');
    expect(html).not.toContain('2737');
    // No window or count (the sealed ref is random text, so match whole cell values only).
    expect(html).not.toMatch(/>[^<]*\b7d\b[^<]*</);
    expect(html).not.toMatch(/>\s*7\s*</);
    expect(html).toContain('data-kpi="held">1<');
    expect(html).toContain('data-kpi="kycAwaiting">1<');
    expect(html).toContain('data-kpi="aml">1<');
  });

  it("in 'ours' mode the KYC section carries the one neutral line", async () => {
    await asAdmin();
    expect(await render()).toContain(t('partner.reviews.neutral'));
  });

  it('agent: held transfers and the KYC queue, but no AML section or tile (D5)', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    const html = await render();
    expect(html).toContain('tr_heldA1');
    expect(html).toContain('data-testid="partner-reviews-kyc"');
    expect(html).not.toContain('data-testid="partner-reviews-aml"');
    expect(html).not.toContain('data-kpi="aml"');
    expect(html).not.toContain(t('partner.reviews.aml.rule.structuring'));
  });

  it.each(['finance', 'support'] as const)('%s is bounced', async (role) => {
    await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
    await expect(ReviewsPage()).rejects.toThrow('REDIRECT:/partner');
  });
});
