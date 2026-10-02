import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore, type Store } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

// Merge plan 2c (owner D3): decideKycAction — a partner admin approves or rejects a customer's KYC
// ONLY in delegated mode and ONLY without a screening hit, through the ONE durable writer
// (kyc-case-store.review, allowScreeningHold:false, re-checked on the locked row).
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
const host = { value: 'smartremit.ai' };
let db: Db;
let store: Store;
let pgPartnerStore: PartnerStore;
const revalidated: string[] = [];
const notify = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: true })));

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
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (s: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, s) };
});
vi.mock('@/lib/kyc-case-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kyc-case-store')>('@/lib/kyc-case-store');
  const cs = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getKycCaseStore: (s: Store) => actual.createKycCaseStore(redis, cs.createCustomerStore(db, s)) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logSpy }));
vi.mock('@/lib/whatsapp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp')>('@/lib/whatsapp');
  return { ...actual, sendVerificationStatus: notify };
});

import { decideKycAction } from '@/app/partner/(app)/customers/[ref]/kyc-actions';
import CustomerDetailPage from '@/app/partner/(app)/customers/[ref]/page';
import { sealCustomerRef } from '@/lib/customer-ref';
import { t } from '@/lib/i18n';

const PHONE_A = '15551230000';
const PHONE_B = '15551230000'; // the SAME phone at the other tenant is a different customer
const REASON = 'Identity documents checked against the selfie.';
const refA = () => sealCustomerRef('pa', PHONE_A);
const refB = () => sealCustomerRef('pb', PHONE_B);
const form = (ref: string, decision = 'approve', reason = REASON) => {
  const fd = new FormData();
  fd.set('ref', ref);
  fd.set('decision', decision);
  fd.set('reason', reason);
  return fd;
};
const ISO = new Date(Date.now() - 3 * 86_400_000).toISOString();
const seedCustomer = (o: Partial<Customer>) =>
  createCustomerStore(db, store).saveCustomer({
    senderPhone: PHONE_A,
    firstSeenAt: ISO,
    kycStatus: 'pending',
    kycReviewState: 'pending_review',
    senderCountry: 'US',
    partnerId: 'pa',
    createdAt: ISO,
    updatedAt: ISO,
    ...o,
  } as Customer);
const row = async (partnerId: string, phone = PHONE_A) =>
  ((await db.execute(sql`SELECT kyc_status, kyc_review_state, kyc_approved_by FROM customers WHERE partner_id = ${partnerId} AND phone = ${phone}`)) as unknown as {
    rows: Array<{ kyc_status: string; kyc_review_state: string; kyc_approved_by: string | null }>;
  }).rows[0];
const kycAudit = async () =>
  ((await db.execute(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events WHERE action LIKE 'kyc.%' ORDER BY id`)) as unknown as {
    rows: Array<{ partner_id: string; actor: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
  }).rows;
const auditCount = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
const snapshot = async () => ({ a: await row('pa'), b: await row('pb', PHONE_B), audit: await auditCount() });
const setKyc = (id: string, mode: 'ours' | 'delegated') => db.execute(sql`UPDATE partners SET kyc_mode = ${mode} WHERE id = ${id}`);
const flag = (partnerId: string, col: 'pep_hit' | 'watchlist_hit') =>
  db.execute(sql`UPDATE customers SET ${sql.raw(col)} = true WHERE partner_id = ${partnerId} AND phone = ${PHONE_A}`);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  notify.mockClear();
  logSpy.mockClear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  store = createStore(redis, db);
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await setKyc('pa', 'delegated');
  await setKyc('pb', 'delegated');
  await db.execute(sql`UPDATE partners SET require_kyc_before_send = true`);
  await seedCustomer({ partnerId: 'pa' });
  await seedCustomer({ partnerId: 'pb', senderPhone: PHONE_B });
});

const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', name: 'Pat Admin', partnerId: 'pa', role: 'admin' });

describe('decideKycAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign ref, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: decideKycAction,
      form: (ref) => form(ref),
      ownId: refA(),
      foreignId: refB(),
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
    expect((await row('pa')).kyc_status).toBe('verified');
    expect((await row('pb', PHONE_B)).kyc_status).toBe('pending');
  });

  it.each(['agent', 'support', 'finance'] as const)('a non-admin role (%s) is refused, nothing changed', async (role) => {
    const before = await snapshot();
    await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
    await expect(decideKycAction(form(refA()))).rejects.toThrow('REDIRECT:/partner');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses on a partner-site host', async () => {
    await asAdmin();
    host.value = 'acme.smartremit.ai';
    await expect(decideKycAction(form(refA()))).rejects.toThrow('NOT_FOUND');
  });

  it('a foreign ref, a junk ref and a ref to no customer return the SAME not-found result', async () => {
    await asAdmin();
    const foreign = await decideKycAction(form(refB()));
    expect(foreign).toEqual({ ok: false, error: t('partner.customers.notFound') });
    expect(await decideKycAction(form('junk'))).toEqual(foreign);
    expect(await decideKycAction(form(sealCustomerRef('pa', '15550009999')))).toEqual(foreign);
    expect((await row('pb', PHONE_B)).kyc_status).toBe('pending');
  });
});

describe('decideKycAction: D3 refusals (nothing written)', () => {
  const refuses = async (fd: FormData, error: string) => {
    const before = await snapshot();
    expect(await decideKycAction(fd)).toEqual({ ok: false, error });
    expect(await snapshot()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  };

  it("an 'ours'-mode partner is refused", async () => {
    await setKyc('pa', 'ours');
    await asAdmin();
    await refuses(form(refA()), t('partner.kyc.notAllowed'));
    await refuses(form(refA(), 'reject'), t('partner.kyc.notAllowed'));
  });

  it.each(['pep_hit', 'watchlist_hit'] as const)('a customer with %s gets the fixed referred result: nothing written, a fixed log tag', async (col) => {
    await flag('pa', col);
    await asAdmin();
    await refuses(form(refA()), t('partner.kyc.referred'));
    await refuses(form(refA(), 'reject'), t('partner.kyc.referred'));
    expect(await kycAudit()).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith('partner.kyc.decide', 'referred', { partnerId: 'pa' });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(PHONE_A);
  });

  it('the referred copy names no screening detail', () => {
    expect(t('partner.kyc.referred').toLowerCase()).not.toMatch(/watchlist|pep|screen|sanction|politic|hit/);
  });

  it('a screening flag raised after the pre-check is caught on the locked row: the same referred result, nothing written', async () => {
    await asAdmin();
    const real = pgPartnerStore;
    // The owner lookup runs after the customer read: raise the flag there.
    pgPartnerStore = {
      ...real,
      getPartner: async (id: string) => {
        await flag('pa', 'pep_hit');
        return real.getPartner(id);
      },
    } as PartnerStore;
    const before = { a: await row('pa'), audit: await auditCount() };
    expect(await decideKycAction(form(refA()))).toEqual({ ok: false, error: t('partner.kyc.referred') });
    expect({ a: await row('pa'), audit: await auditCount() }).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('an invalid decision, a short reason and a reason with a phone number are refused', async () => {
    await asAdmin();
    await refuses(form(refA(), 'override'), t('partner.kyc.invalidDecision'));
    await refuses(form(refA(), 'approve', 'too short'), t('partner.kyc.reasonTooShort'));
    await refuses(form(refA(), 'approve', 'Spoke to them on 415 555 0101 today'), t('partner.kyc.reasonHasNumber'));
  });
});

describe('decideKycAction: success', () => {
  it('approve from the queue: verified, ONE kyc.review.approve row (actorScope partner, keyed subject), the gated notice', async () => {
    await asAdmin();
    expect(await decideKycAction(form(refA()))).toEqual({ ok: true });
    expect(await row('pa')).toMatchObject({ kyc_status: 'verified', kyc_review_state: 'approved', kyc_approved_by: 'Pat Admin (pa-admin)' });
    const rows = await kycAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', action: 'kyc.review.approve' });
    expect(rows[0].meta).toMatchObject({ source: 'persona_review', reason: REASON, actorScope: 'partner', previousStatus: 'pending', newStatus: 'verified' });
    expect(rows[0].subject_id).not.toContain(PHONE_A);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('verified');
    expect(revalidated).toContain('/partner/reviews');
  });

  it('reject from the queue: rejected, ONE kyc.review.reject row', async () => {
    await asAdmin();
    expect(await decideKycAction(form(refA(), 'reject'))).toEqual({ ok: true });
    expect((await row('pa')).kyc_status).toBe('rejected');
    const rows = await kycAudit();
    expect(rows.map((r) => r.action)).toEqual(['kyc.review.reject']);
    expect(notify.mock.calls[0][1]).toBe('failed');
  });

  it('a replay writes nothing extra (the second approve is a refused no-op)', async () => {
    await asAdmin();
    expect(await decideKycAction(form(refA()))).toEqual({ ok: true });
    expect(await decideKycAction(form(refA()))).toEqual({ ok: false, error: t('partner.kyc.notAllowed') });
    expect(await kycAudit()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('outside the queue a decision is a manual override and sends no notice', async () => {
    await db.execute(sql`UPDATE customers SET kyc_status = 'verified', kyc_review_state = 'approved' WHERE partner_id = 'pa'`);
    await asAdmin();
    expect(await decideKycAction(form(refA(), 'reject'))).toEqual({ ok: true });
    expect((await kycAudit()).map((r) => r.action)).toEqual(['kyc.manual_override.reject']);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('/partner/customers/[ref]: the decision block', () => {
  const page = async (ref = refA()) => renderToStaticMarkup(await CustomerDetailPage({ params: Promise.resolve({ ref }) }));
  const block = (html: string) => {
    const m = html.match(/<div[^>]*data-testid="partner-kyc-decision"[^>]*>[\s\S]*?<\/div>/);
    return m ? m[0] : null;
  };

  it('a delegated admin on a clean queued customer sees the approve and reject controls', async () => {
    await asAdmin();
    const html = await page();
    expect(html).toContain('data-testid="partner-kyc-decision-dialog"');
    expect(html).toContain(t('partner.kyc.approve.trigger'));
    expect(html).toContain(t('partner.kyc.reject.trigger'));
    expect(html).not.toContain(t('partner.reviews.neutral'));
  });

  it('ours-mode renders the single neutral line and no controls', async () => {
    await asAdmin();
    await setKyc('pa', 'ours');
    const ours = block(await page());
    expect(ours).not.toBeNull();
    expect(ours).toContain(t('partner.reviews.neutral'));
    expect(ours).not.toContain('data-testid="partner-kyc-decision-dialog"');
  });

  it.each(['pep_hit', 'watchlist_hit'] as const)('delegated: a customer with %s renders the SAME controls as one without', async (col) => {
    await asAdmin();
    for (const state of [
      { kyc_status: 'pending', kyc_review_state: 'pending_review' },
      { kyc_status: 'not_started', kyc_review_state: 'none' },
      { kyc_status: 'verified', kyc_review_state: 'approved' },
    ]) {
      await db.execute(sql`UPDATE customers SET pep_hit = false, watchlist_hit = false, kyc_status = ${state.kyc_status}, kyc_review_state = ${state.kyc_review_state} WHERE partner_id = 'pa'`);
      const ref = refA(); // one sealed ref (each seal is randomised) so only the customer differs
      const clean = await page(ref);
      await flag('pa', col);
      const hit = await page(ref);
      expect(hit).toBe(clean);
      expect(hit).toContain('data-testid="partner-kyc-decision-dialog"');
      expect(hit).not.toContain(t('partner.reviews.neutral'));
    }
  });

  it('a non-admin sees no decision block at all', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    const html = await page();
    expect(html).not.toContain('data-testid="partner-kyc-decision"');
    expect(html).not.toContain(t('partner.reviews.neutral'));
  });
});
