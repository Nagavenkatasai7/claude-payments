/**
 * Fix pack 7 T27 (P25): the platform side of a partner that DECIDES KYC (partnerDecidesKyc:
 * certified for live money, signed posture kycDecider 'partner', kycMode 'delegated'). SmartRemit
 * staff stop deciding its customers' KYC (manual and review decisions, a create already verified or
 * grandfathered, the clear of a PEP-only sender hold) and record a recommendation instead: one
 * `kyc.recommend` audit row, no customer change. Watchlist and stamp-only flags stay SmartRemit's.
 * A plain certified partner and the default tenant behave exactly as today. Auth is mocked as in
 * tests/customers-actions-scope.test.ts (partner-scoped staff never reach /admin-dashboard in
 * production: requireStaff redirects them, so PARTNER_WORKSPACE_KYC_REFUSAL is defence in depth).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { certifiedQueuePartner } from './helpers-hold';
import { createStore, type Store } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { auditSubjectId } from '@/lib/customer-ref';
import { canDecideCustomerKyc } from '@/lib/compliance-config';
import { applyKycEvent } from '@/lib/kyc-state-machine';
import {
  PARTNER_DECIDES_KYC_REFUSAL,
  PARTNER_WORKSPACE_KYC_REFUSAL,
  PARTNER_CREATE_KYC_REFUSAL,
  PARTNER_PEP_CLEAR_REFUSAL,
  KYC_RECOMMENDATION_ONLY_REFUSAL,
  KYC_RECOMMENDATION_INVALID,
} from '@/lib/partner-kyc-decision';
import { HOLD_REASON_REFUSAL } from '@/lib/dashboard-ops';
import { KycCopilotPanel } from '@/app/admin-dashboard/customers/[ref]/kyc-copilot-panel';
import type { Db } from '@/db/client';
import type { Customer, Staff } from '@/lib/types';

const redis = fakeRedis();
let currentStaff: Staff;
let db: Db;
let store: Store;
const notify = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

class RedirectError extends Error {
  constructor(readonly to: string) { super(`NEXT_REDIRECT:${to}`); }
}

vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireScope: async () => ({ staff: currentStaff }),
  requireStaff: async () => currentStaff,
  // The REAL rule (src/lib/auth.ts requirePlatformAdmin): role admin AND no partnerId, else redirect.
  requirePlatformAdmin: async () => {
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new RedirectError('/admin-dashboard');
    return currentStaff;
  },
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
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
// The owner read: real on PGlite, with a switch for a failed or empty read (counted).
const ownerRead = vi.hoisted(() => ({ calls: 0, mode: 'real' as 'real' | 'throw' | 'null' }));
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => {
      const s = actual.createPartnerStore(db);
      return {
        ...s,
        getPartner: async (...a: Parameters<typeof s.getPartner>) => {
          ownerRead.calls += 1;
          if (ownerRead.mode === 'throw') throw new Error('connection reset');
          if (ownerRead.mode === 'null') return null;
          return s.getPartner(...a);
        },
      };
    },
  };
});
// A hook after the action's UNLOCKED flags read (the locked re-check test changes the row there).
const flagsHook = vi.hoisted(() => ({ afterUnlocked: null as null | (() => Promise<void>) }));
vi.mock('@/db/repos/customer-repo', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/customer-repo')>('@/db/repos/customer-repo');
  return {
    ...actual,
    readSenderScreeningFlags: async (...a: Parameters<typeof actual.readSenderScreeningFlags>) => {
      const r = await actual.readSenderScreeningFlags(...a);
      if (!a[3]?.forUpdate && flagsHook.afterUnlocked) {
        const h = flagsHook.afterUnlocked;
        flagsHook.afterUnlocked = null;
        await h();
      }
      return r;
    },
  };
});
vi.mock('@/lib/whatsapp', () => ({ sendVerificationStatus: notify }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

import {
  manualKycDecisionAction,
  reviewKycAction,
  createCustomerAction,
  clearSenderScreeningHoldAction,
  recordKycRecommendationAction,
} from '@/app/admin-dashboard/customers/actions';

const DECIDING = 'acme';
const PLAIN = 'plain';
const DEFAULT = 'default';
const PHONE = '15551234567';
const NEW_PHONE = '15557654321';
const REASON = 'documents checked against the file';
const H = 3_600_000;
const NO_PERMISSION = 'You do not have permission to perform this action.';

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'plat', name: 'Platform Admin', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    ...over,
  };
}

function makeCustomer(partnerId: string, over: Partial<Customer> = {}): Customer {
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  return {
    senderPhone: PHONE, firstSeenAt: tenDaysAgo, kycStatus: 'pending', senderCountry: 'US', partnerId,
    createdAt: tenDaysAgo, updatedAt: tenDaysAgo, ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function saveCustomer(partnerId: string, over: Partial<Customer> = {}): Promise<void> {
  await createCustomerStore(db, store).saveCustomer(makeCustomer(partnerId, over));
}

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
type AuditRow = { partner_id: string | null; actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
const auditRows = () => rows<AuditRow>(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events ORDER BY id`);
const outboxCount = async () => (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox`))[0].n;
const customerRow = async (partnerId: string, phone = PHONE) =>
  (await rows<Record<string, unknown>>(sql`SELECT * FROM customers WHERE partner_id = ${partnerId} AND phone = ${phone}`))[0];
const kycStatus = async (partnerId: string, phone = PHONE) =>
  (await createCustomerStore(db, store).getCustomer(partnerId, phone))?.kycStatus;

/** PEP-only: pep_hit, flagged an hour ago, no watchlist hit or stamp. */
async function pepOnly(partnerId: string): Promise<void> {
  await db.execute(sql`UPDATE customers SET pep_hit = true, watchlist_hit = false, screening_flagged_at = ${new Date(Date.now() - H)}
    WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
}
async function watchlist(partnerId: string, alsoPep = false): Promise<void> {
  const at = new Date(Date.now() - H);
  await db.execute(sql`UPDATE customers SET watchlist_hit = true, pep_hit = ${alsoPep}, screening_flagged_at = ${at}, screening_watchlist_at = ${at}
    WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
}
async function stampOnly(partnerId: string): Promise<void> {
  await db.execute(sql`UPDATE customers SET screening_flagged_at = ${new Date(Date.now() - H)} WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
}
async function shownFlag(partnerId: string): Promise<string> {
  return (await createCustomerStore(db, store).getCustomer(partnerId, PHONE))?.screeningFlaggedAt ?? '';
}
async function clearForm(partnerId: string): Promise<FormData> {
  return form({ phone: PHONE, partnerId, reason: 'match reviewed: a different person', screeningFlaggedAt: await shownFlag(partnerId) });
}
const screeningCleared = async (partnerId: string) =>
  (await rows<{ c: Date | null }>(sql`SELECT screening_cleared_at AS c FROM customers WHERE partner_id = ${partnerId} AND phone = ${PHONE}`))[0].c;

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  store = createStore(redis, db);
  await certifiedQueuePartner(db, { partnerId: DECIDING, kycMode: 'delegated' });
  await certifiedQueuePartner(db, { partnerId: PLAIN, kycMode: 'ours' });
  currentStaff = staff();
  ownerRead.calls = 0;
  ownerRead.mode = 'real';
  flagsHook.afterUnlocked = null;
  notify.mockClear();
});

describe('T27 manual and review decisions on a deciding partner', () => {
  it('1. platform admin: PARTNER_DECIDES_KYC_REFUSAL; customer unchanged; zero audit rows; no notify', async () => {
    await saveCustomer(DECIDING, { kycReviewState: 'pending_review' });
    const before = await customerRow(DECIDING);
    await expect(manualKycDecisionAction(form({ phone: PHONE, partnerId: DECIDING, decision: 'approve', reason: REASON }))).rejects.toThrow(PARTNER_DECIDES_KYC_REFUSAL);
    await expect(reviewKycAction(form({ phone: PHONE, partnerId: DECIDING, decision: 'approve', reason: REASON }))).rejects.toThrow(PARTNER_DECIDES_KYC_REFUSAL);
    await expect(reviewKycAction(form({ phone: PHONE, partnerId: DECIDING, decision: 'reject', reason: REASON }))).rejects.toThrow(PARTNER_DECIDES_KYC_REFUSAL);
    expect(await customerRow(DECIDING)).toEqual(before);
    expect(await auditRows()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('2. a partner-scoped admin of that partner (mocked past requireStaff): PARTNER_WORKSPACE_KYC_REFUSAL', async () => {
    await saveCustomer(DECIDING, { kycReviewState: 'pending_review' });
    currentStaff = staff({ username: 'pa', partnerId: DECIDING });
    await expect(manualKycDecisionAction(form({ phone: PHONE, decision: 'approve', reason: REASON }))).rejects.toThrow(PARTNER_WORKSPACE_KYC_REFUSAL);
    await expect(reviewKycAction(form({ phone: PHONE, decision: 'approve', reason: REASON }))).rejects.toThrow(PARTNER_WORKSPACE_KYC_REFUSAL);
    expect(await kycStatus(DECIDING)).toBe('pending');
    expect(await auditRows()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['throw', 'null'] as const)('3. the owner read %s: the permission text, nothing written (never "not certified")', async (mode) => {
    await saveCustomer(DECIDING, { kycReviewState: 'pending_review' });
    await saveCustomer(PLAIN, { kycReviewState: 'pending_review' });
    ownerRead.mode = mode;
    for (const pid of [DECIDING, PLAIN]) {
      await expect(manualKycDecisionAction(form({ phone: PHONE, partnerId: pid, decision: 'approve', reason: REASON }))).rejects.toThrow(NO_PERMISSION);
      await expect(reviewKycAction(form({ phone: PHONE, partnerId: pid, decision: 'approve', reason: REASON }))).rejects.toThrow(NO_PERMISSION);
      expect(await kycStatus(pid)).toBe('pending');
    }
    expect(await auditRows()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('T27 createCustomerAction for a deciding partner', () => {
  it.each(['verified', 'grandfathered'] as const)('4. kycStatus %s: PARTNER_CREATE_KYC_REFUSAL, no row', async (k) => {
    await expect(createCustomerAction(form({ phone: NEW_PHONE, partnerId: DECIDING, kycStatus: k, kycReason: REASON }))).rejects.toThrow(PARTNER_CREATE_KYC_REFUSAL);
    expect(await customerRow(DECIDING, NEW_PHONE)).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('4. not_started: created as today, with no extra owner read', async () => {
    await createCustomerAction(form({ phone: NEW_PHONE, partnerId: DECIDING, kycStatus: 'not_started' }));
    expect(await kycStatus(DECIDING, NEW_PHONE)).toBe('not_started');
    expect(ownerRead.calls).toBe(1); // today's "Selected partner not found." read only
    expect(await auditRows()).toEqual([]);
  });
});

describe('T27 clearSenderScreeningHoldAction on a deciding partner', () => {
  it('5. PEP-only flag: PARTNER_PEP_CLEAR_REFUSAL, nothing cleared', async () => {
    await saveCustomer(DECIDING);
    await pepOnly(DECIDING);
    await expect(clearSenderScreeningHoldAction(await clearForm(DECIDING))).rejects.toThrow(PARTNER_PEP_CLEAR_REFUSAL);
    expect(await screeningCleared(DECIDING)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('5. watchlist hit (with or without a PEP hit): cleared as today', async () => {
    await saveCustomer(DECIDING);
    await watchlist(DECIDING, true);
    await clearSenderScreeningHoldAction(await clearForm(DECIDING));
    expect(await screeningCleared(DECIDING)).not.toBeNull();
    expect((await auditRows()).map((r) => r.action)).toEqual(['customer.screening_hold.clear']);
  });

  it('5. stamp-only: cleared as today', async () => {
    await saveCustomer(DECIDING);
    await stampOnly(DECIDING);
    await clearSenderScreeningHoldAction(await clearForm(DECIDING));
    expect(await screeningCleared(DECIDING)).not.toBeNull();
    expect((await auditRows()).map((r) => r.action)).toEqual(['customer.screening_hold.clear']);
  });

  it('5. the PEP-only check runs again on the locked row (a watchlist hit removed between the read and the clear is refused)', async () => {
    await saveCustomer(DECIDING);
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, pep_hit = true, screening_flagged_at = ${new Date(Date.now() - H)}
      WHERE partner_id = ${DECIDING} AND phone = ${PHONE}`);
    flagsHook.afterUnlocked = async () => {
      await db.execute(sql`UPDATE customers SET watchlist_hit = false WHERE partner_id = ${DECIDING} AND phone = ${PHONE}`);
    };
    await expect(clearSenderScreeningHoldAction(await clearForm(DECIDING))).rejects.toThrow(PARTNER_PEP_CLEAR_REFUSAL);
    expect(flagsHook.afterUnlocked).toBeNull(); // the hook ran
    expect(await screeningCleared(DECIDING)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('5. the owner read fails: the permission text, nothing cleared', async () => {
    await saveCustomer(DECIDING);
    await watchlist(DECIDING);
    ownerRead.mode = 'throw';
    await expect(clearSenderScreeningHoldAction(await clearForm(DECIDING))).rejects.toThrow(NO_PERMISSION);
    expect(await screeningCleared(DECIDING)).toBeNull();
  });
});

describe('T27 recordKycRecommendationAction', () => {
  const rec = (over: Record<string, string> = {}) =>
    form({ phone: PHONE, partnerId: DECIDING, recommendation: 'approve', reason: 'reviewed: ok to approve', ...over });

  it('6. approve with a 20-char reason: ONE kyc.recommend row; customer byte-identical; zero outbox rows', async () => {
    await saveCustomer(DECIDING, { kycReviewState: 'pending_review' });
    await pepOnly(DECIDING);
    const before = await customerRow(DECIDING);
    const reason = 'checked: ok, approve';
    expect(reason).toHaveLength(20);
    await recordKycRecommendationAction(rec({ reason }));
    const a = await auditRows();
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({
      partner_id: DECIDING,
      actor: 'plat',
      action: 'kyc.recommend',
      subject_id: auditSubjectId(DECIDING, PHONE),
      meta: { recommendation: 'approve', reason },
    });
    expect(await customerRow(DECIDING)).toEqual(before);
    expect(await outboxCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('6b. reject is recorded the same way', async () => {
    await saveCustomer(DECIDING);
    await recordKycRecommendationAction(rec({ recommendation: 'reject' }));
    expect((await auditRows()).map((r) => r.meta)).toEqual([{ recommendation: 'reject', reason: 'reviewed: ok to approve' }]);
  });

  it('7. refusals write nothing', async () => {
    await saveCustomer(DECIDING);
    await saveCustomer(PLAIN);
    await saveCustomer(DEFAULT);
    await expect(recordKycRecommendationAction(rec({ partnerId: PLAIN }))).rejects.toThrow(KYC_RECOMMENDATION_ONLY_REFUSAL);
    await expect(recordKycRecommendationAction(rec({ partnerId: DEFAULT }))).rejects.toThrow(KYC_RECOMMENDATION_ONLY_REFUSAL);
    await expect(recordKycRecommendationAction(rec({ reason: 'too short' }))).rejects.toThrow(HOLD_REASON_REFUSAL);
    await expect(recordKycRecommendationAction(rec({ reason: 'account 123456789012 checked' }))).rejects.toThrow(HOLD_REASON_REFUSAL);
    await expect(recordKycRecommendationAction(rec({ recommendation: 'escalate' }))).rejects.toThrow(KYC_RECOMMENDATION_INVALID);
    await expect(recordKycRecommendationAction(rec({ phone: NEW_PHONE }))).rejects.toThrow('Customer not found.');
    currentStaff = staff({ username: 'pa', partnerId: DECIDING });
    await expect(recordKycRecommendationAction(rec())).rejects.toThrow(PARTNER_WORKSPACE_KYC_REFUSAL);
    currentStaff = staff({ username: 'pp', partnerId: PLAIN });
    await expect(recordKycRecommendationAction(rec())).rejects.toThrow(PARTNER_WORKSPACE_KYC_REFUSAL);
    expect(await auditRows()).toEqual([]);
    expect(await outboxCount()).toBe(0);
  });

  it('7. a customer of another tenant is "Customer not found."; a failed owner read is the permission text', async () => {
    await saveCustomer(PLAIN);
    await expect(recordKycRecommendationAction(rec())).rejects.toThrow('Customer not found.');
    await saveCustomer(DECIDING);
    ownerRead.mode = 'null';
    await expect(recordKycRecommendationAction(rec())).rejects.toThrow(NO_PERMISSION);
    expect(await auditRows()).toEqual([]);
  });
});

describe('T27 canDecideCustomerKyc with the owner', () => {
  it('8. platform: false for a deciding owner, true for a plain owner and for no owner', async () => {
    const ps = createPartnerStore(db);
    const c = makeCustomer(DECIDING);
    expect(canDecideCustomerKyc({ kind: 'platform' }, c, await ps.getPartner(DECIDING))).toBe(false);
    expect(canDecideCustomerKyc({ kind: 'platform' }, c, await ps.getPartner(PLAIN))).toBe(true);
    expect(canDecideCustomerKyc({ kind: 'platform' }, c, await ps.getPartner(DEFAULT))).toBe(true);
    expect(canDecideCustomerKyc({ kind: 'platform' }, c)).toBe(true);
    expect(canDecideCustomerKyc({ kind: 'platform' }, c, null)).toBe(true);
  });
});

describe('T27 a plain certified partner and the default tenant behave as today (golden rows)', () => {
  it.each([PLAIN, DEFAULT])('9. %s: manual, review, create and clear', async (pid) => {
    // manual
    await saveCustomer(pid);
    await manualKycDecisionAction(form({ phone: PHONE, partnerId: pid, decision: 'approve', reason: REASON }));
    expect(await kycStatus(pid)).toBe('verified');
    // review (a rejected customer back in review)
    await db.execute(sql`UPDATE customers SET kyc_review_state = 'pending_review' WHERE partner_id = ${pid} AND phone = ${PHONE}`);
    await reviewKycAction(form({ phone: PHONE, partnerId: pid, decision: 'reject', reason: REASON }));
    expect(await kycStatus(pid)).toBe('rejected');
    // create already verified
    await createCustomerAction(form({ phone: NEW_PHONE, partnerId: pid, kycStatus: 'verified', kycReason: REASON }));
    expect(await kycStatus(pid, NEW_PHONE)).toBe('verified');
    // clear a PEP-only flag (SmartRemit's to clear for a partner that does not decide)
    await pepOnly(pid);
    await clearSenderScreeningHoldAction(await clearForm(pid));
    expect(await screeningCleared(pid)).not.toBeNull();
    const a = await auditRows();
    expect(a.map((r) => [r.partner_id, r.actor, r.action])).toEqual([
      [pid, 'plat', 'kyc.manual_override.approve'],
      [pid, 'plat', 'kyc.review.reject'],
      [pid, 'plat', 'kyc.manual_override.create'],
      [pid, 'plat', 'customer.screening_hold.clear'],
    ]);
    expect(a[2].meta).toEqual({ previousStatus: null, newStatus: 'verified', reason: REASON, source: 'manual', reviewerName: 'Platform Admin (plat)' });
    expect(a[3].meta).toMatchObject({ pepHit: true, watchlistHit: false, kycStatus: 'rejected' });
  });

  it('9. the default tenant is never read for the owner', async () => {
    await saveCustomer(DEFAULT);
    await manualKycDecisionAction(form({ phone: PHONE, partnerId: DEFAULT, decision: 'approve', reason: REASON }));
    await createCustomerAction(form({ phone: NEW_PHONE, partnerId: DEFAULT, kycStatus: 'verified', kycReason: REASON }));
    await pepOnly(DEFAULT);
    await clearSenderScreeningHoldAction(await clearForm(DEFAULT));
    expect(ownerRead.calls).toBe(0);
  });
});

describe('T27 the automatic paths decide nothing', () => {
  it('10. applyKycEvent on inquiry.approved for a deciding partner customer: pending_review, kycStatus unchanged', () => {
    const delta = applyKycEvent(makeCustomer(DECIDING, { kycStatus: 'pending' }), {
      eventId: 'evt_1', name: 'inquiry.approved', createdAt: new Date().toISOString(),
      inquiryId: 'inq_1', referenceId: null, status: 'approved',
    });
    expect(delta.kycReviewState).toBe('pending_review');
    expect('kycStatus' in delta).toBe(false);
  });
});

describe('T27 fixed texts', () => {
  it('11. the refusal constants equal the P25 texts verbatim', () => {
    expect(PARTNER_DECIDES_KYC_REFUSAL).toBe('This partner decides KYC for its customers: record a recommendation instead.');
    expect(PARTNER_WORKSPACE_KYC_REFUSAL).toBe('Decide this customer in your partner workspace.');
    expect(PARTNER_CREATE_KYC_REFUSAL).toBe('This partner decides KYC: create the customer with KYC not started.');
    expect(PARTNER_PEP_CLEAR_REFUSAL).toBe('This partner decides this PEP flag: record a recommendation instead.');
    expect(KYC_RECOMMENDATION_ONLY_REFUSAL).toBe('Recommendations are only for a partner that decides KYC.');
    expect(KYC_RECOMMENDATION_INVALID).toBe('Invalid recommendation.');
  });
});

describe('T27 copilot panel mode', () => {
  it('default (decide) keeps today\'s text; recommend shows the recommendation text', () => {
    const decide = renderToStaticMarkup(createElement(KycCopilotPanel, { phone: PHONE, partnerId: PLAIN }));
    expect(decide).toContain('A suggestion only — you decide. Nothing here approves or rejects.');
    const recommend = renderToStaticMarkup(createElement(KycCopilotPanel, { phone: PHONE, partnerId: DECIDING, mode: 'recommend' }));
    expect(recommend).toContain('A suggestion only. This partner decides; use it to write your recommendation.');
    expect(recommend).not.toContain('you decide');
  });
});
