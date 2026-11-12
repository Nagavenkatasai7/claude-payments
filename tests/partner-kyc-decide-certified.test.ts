/**
 * Fix pack 7 T26 (P24, P22): decideKycAction's branch for a partner that DECIDES KYC
 * (partnerDecidesKyc: certified for live money, signed posture kycDecider 'partner', kycMode
 * 'delegated'). Real gate (requirePartnerStaff over the real auth store on a fake Redis), real
 * owner read, real customer store and kyc-case-store on PGlite; the step-up gate is mocked (its
 * own suite covers it) and records every call. Order: site host -> PARTNER_OPS -> owner (a
 * failed or empty read refuses) -> not deciding: PARTNER_ADMIN and today's path -> qualified
 * compliance user (fresh staff read, then MFA) -> ref (session tenant) -> decision + reason ->
 * the flag (watchlist or stamp-only: SmartRemit decides) -> the offer -> disposition / EDD ->
 * the flag time -> the forced step-up 'kyc.decide' -> review (PEP-only approve clears the hold in
 * the same transaction). Every refusal writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import { certifiedQueuePartner, seedComplianceUsers } from './helpers-hold';
import { createStore, type Store } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer, Staff } from '@/lib/types';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
let db: Db;
let store: Store;
const revalidated: string[] = [];
const notify = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: true })));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
    getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
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
// The action's fresh staff re-read is the SECOND getStaff of a call (getCurrentStaff is the first).
const staffRead = vi.hoisted(() => ({ calls: 0, transform: null as null | ((s: Staff | null) => Staff | null) }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return {
    ...actual,
    getAuthStore: () => {
      const s = actual.createAuthStore(redis);
      return {
        ...s,
        getStaff: async (u: string) => {
          const row = await s.getStaff(u);
          staffRead.calls += 1;
          return staffRead.transform && staffRead.calls >= 2 ? staffRead.transform(row) : row;
        },
      };
    },
  };
});
// The action's owner read is the SECOND getPartner of a call (getCurrentStaff's tenant check is the first).
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
          if (ownerRead.calls >= 2 && ownerRead.mode === 'throw') throw new Error('connection reset');
          if (ownerRead.calls >= 2 && ownerRead.mode === 'null') return null;
          return s.getPartner(...a);
        },
      };
    },
  };
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
const mfa = vi.hoisted(() => ({ enrolled: true }));
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis), staffMfaEnrolled: async () => mfa.enrolled };
});
const gate = vi.hoisted(() => ({
  calls: [] as Array<{ target: string; opts: unknown; username: string }>,
  result: null as null | { ok: false; error: string; code?: string; factor?: string },
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/partner-step-up-gate')>()),
  gatePartnerStepUp: async (ctx: { username: string }, _fd: FormData, target: string, opts?: unknown) => {
    gate.calls.push({ target, opts, username: ctx.username });
    return gate.result;
  },
}));
const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logSpy }));
vi.mock('@/lib/whatsapp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp')>('@/lib/whatsapp');
  return { ...actual, sendVerificationStatus: notify };
});

import { decideKycAction } from '@/app/partner/(app)/customers/[ref]/kyc-actions';
import CustomerDetailPage from '@/app/partner/(app)/customers/[ref]/page';
import { EDD_NOTE_MAX, KycComplianceDialog } from '@/app/partner/(app)/customers/[ref]/kyc-compliance-dialog';
import { sealCustomerRef } from '@/lib/customer-ref';
import { KYC_DISPOSITIONS } from '@/lib/partner-reviews';
import { KYC_EDD_NOTE_MAX } from '@/lib/partner-kyc-decision';
import { CATALOGUES } from '@/lib/i18n/catalogues';
import { t } from '@/lib/i18n';

const P = 'acme';
const PHONE = '15551230000';
const REASON = 'Identity documents checked against the selfie.';
const ref = () => sealCustomerRef(P, PHONE);
const STEP_UP = { ok: false as const, error: 'step up', code: 'step_up_required', factor: 'totp' };
const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;

const form = (o: Record<string, string> = {}, r = ref()) => {
  const fd = new FormData();
  fd.set('ref', r);
  fd.set('decision', 'approve');
  fd.set('reason', REASON);
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const seedCustomer = (partnerId: string, o: Partial<Customer> = {}) => {
  const iso = ago(3 * 86_400_000).toISOString();
  return createCustomerStore(db, store).saveCustomer({
    senderPhone: PHONE,
    firstSeenAt: iso,
    kycStatus: 'pending',
    kycReviewState: 'pending_review',
    senderCountry: 'US',
    partnerId,
    createdAt: iso,
    updatedAt: iso,
    ...o,
  } as Customer);
};
type Row = { kyc_status: string; screening_flagged_at: Date | null; screening_cleared_at: Date | null };
const row = async (partnerId = P) =>
  ((await db.execute(sql`SELECT kyc_status, screening_flagged_at, screening_cleared_at FROM customers WHERE partner_id = ${partnerId} AND phone = ${PHONE}`)) as unknown as {
    rows: Row[];
  }).rows[0];
type AuditRow = { partner_id: string; actor: string; action: string; meta: Record<string, unknown> };
const audits = async () =>
  ((await db.execute(sql`SELECT partner_id, actor, action, meta FROM audit_events WHERE action LIKE 'kyc.%' OR action LIKE 'customer.screening%' ORDER BY id`)) as unknown as {
    rows: AuditRow[];
  }).rows;
const auditCount = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;
const snapshot = async () => ({ c: await row(), audit: await auditCount() });

/** A PEP-only flag an hour ago; returns the flag time as ISO (what the page posts). */
const pepOnly = async (partnerId = P) => {
  const at = ago(HOUR);
  await db.execute(sql`UPDATE customers SET pep_hit = true, screening_flagged_at = ${at.toISOString()}::timestamptz WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
  return at.toISOString();
};

const signIn = (username: string) => signInAs(redis, cookieJar, { username, name: `Compliance ${username}`, partnerId: P, role: 'agent' });
/** co-a: a listed, active agent of this tenant with two-step enrolled, signed in. */
const asCo = async () => {
  await seedComplianceUsers(db, P, ['co-a'], { redis });
  await signIn('co-a');
};

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  notify.mockClear();
  logSpy.mockClear();
  host.value = 'smartremit.ai';
  staffRead.calls = 0;
  staffRead.transform = null;
  ownerRead.calls = 0;
  ownerRead.mode = 'real';
  mfa.enrolled = true;
  gate.calls = [];
  gate.result = null;
  db = await freshDb();
  store = createStore(redis, db);
  await certifiedQueuePartner(db, { partnerId: P, kycMode: 'delegated', users: ['co-a'] });
  await seedCustomer(P);
});

const refuses = async (fd: FormData, error: string) => {
  const before = await snapshot();
  staffRead.calls = 0;
  ownerRead.calls = 0;
  expect(await decideKycAction(fd)).toEqual({ ok: false, error });
  expect(await snapshot()).toEqual(before);
  expect(gate.calls).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
};

describe('decideKycAction, deciding partner: success', { retry: 0 }, () => {
  it('1. qualified agent co-a approves a pending_review customer with no flag: verified; ONE kyc.review.approve row, actorScope partner; no disposition key', async () => {
    await asCo();
    expect(await decideKycAction(form({ disposition: 'pep_accepted_with_edd' }))).toEqual({ ok: true });
    expect((await row()).kyc_status).toBe('verified');
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['kyc.review.approve']);
    expect(rows[0]).toMatchObject({ partner_id: P, actor: 'co-a' });
    expect(rows[0].meta).toMatchObject({ actorScope: 'partner', source: 'persona_review', reason: REASON, newStatus: 'verified' });
    expect(Object.hasOwn(rows[0].meta, 'disposition')).toBe(false);
    expect(gate.calls).toEqual([{ target: 'kyc.decide', opts: { always: true }, username: 'co-a' }]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(revalidated).toContain('/partner/reviews');
  });

  it('2. PEP-only, pep_accepted_with_edd + eddDone + a note, the posted flag time equals the row: verified, cleared, rows clear then kyc.*', async () => {
    const flaggedAt = await pepOnly();
    await asCo();
    const fd = form({ disposition: 'pep_accepted_with_edd', eddDone: 'on', eddNote: 'Source of wealth documents reviewed.', screeningFlaggedAt: flaggedAt });
    expect(await decideKycAction(fd)).toEqual({ ok: true });
    const c = await row();
    expect(c.kyc_status).toBe('verified');
    expect(c.screening_cleared_at).not.toBeNull();
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['customer.screening_hold.clear', 'kyc.review.approve']);
    expect(rows[0].meta).toMatchObject({ actorScope: 'partner', via: 'kyc_decision', pepHit: true, watchlistHit: false });
    expect(rows[1].meta).toMatchObject({
      actorScope: 'partner',
      disposition: 'pep_accepted_with_edd',
      eddDone: true,
      eddNote: 'Source of wealth documents reviewed.',
    });
  });

  it('9b. reject of a PEP-only customer: rejected, ONE kyc.* row, screening_cleared_at unchanged', async () => {
    const flaggedAt = await pepOnly();
    await asCo();
    expect(await decideKycAction(form({ decision: 'reject', disposition: 'reject', screeningFlaggedAt: flaggedAt }))).toEqual({ ok: true });
    const c = await row();
    expect(c.kyc_status).toBe('rejected');
    expect(c.screening_cleared_at).toBeNull();
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['kyc.review.reject']);
    expect(rows[0].meta).toMatchObject({ disposition: 'reject', actorScope: 'partner' });
  });
});

describe('decideKycAction, deciding partner: refusals (nothing written)', { retry: 0 }, () => {
  it('3. PEP-only: disposition missing or wrong, eddDone missing -> dispositionRequired; a long or number-shaped note -> eddNoteInvalid', async () => {
    const flaggedAt = await pepOnly();
    await asCo();
    const req = t('partner.kyc.dispositionRequired');
    await refuses(form({ screeningFlaggedAt: flaggedAt }), req);
    await refuses(form({ disposition: 'reject', screeningFlaggedAt: flaggedAt }), req);
    await refuses(form({ disposition: 'pep_accepted_with_edd', screeningFlaggedAt: flaggedAt }), req);
    const bad = t('partner.kyc.eddNoteInvalid');
    await refuses(form({ disposition: 'pep_accepted_with_edd', eddDone: 'on', eddNote: 'x'.repeat(300), screeningFlaggedAt: flaggedAt }), bad);
    await refuses(form({ disposition: 'pep_accepted_with_edd', eddDone: 'on', eddNote: 'Account 123456789012 checked', screeningFlaggedAt: flaggedAt }), bad);
  });

  it('4. PEP-only, the posted flag time is stale or missing -> changed', async () => {
    const flaggedAt = await pepOnly();
    await db.execute(sql`UPDATE customers SET screening_flagged_at = now() WHERE partner_id = ${P}`);
    await asCo();
    const changed = t('partner.kyc.changed');
    await refuses(form({ disposition: 'false_positive', screeningFlaggedAt: flaggedAt }), changed);
    await refuses(form({ disposition: 'false_positive' }), changed);
  });

  it('5. a watchlist hit and a stamp-only flag -> platformDecides; the step-up is never called; a fixed log tag only', async () => {
    await asCo();
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = ${P}`);
    await refuses(form(), t('partner.kyc.platformDecides'));
    await refuses(form({ decision: 'reject', disposition: 'reject' }), t('partner.kyc.platformDecides'));
    await db.execute(sql`UPDATE customers SET watchlist_hit = false, pep_hit = false WHERE partner_id = ${P}`);
    await refuses(form(), t('partner.kyc.platformDecides'));
    expect(logSpy).toHaveBeenCalledWith('partner.kyc.decide', 'platform', { partnerId: P });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(PHONE);
  });

  it('13. a PEP stamp after a stale save: pepHit with a NEWER watchlist stamp -> platformDecides', async () => {
    const flaggedAt = await pepOnly();
    await db.execute(sql`UPDATE customers SET screening_watchlist_at = now() WHERE partner_id = ${P}`);
    await asCo();
    await refuses(form({ disposition: 'false_positive', screeningFlaggedAt: flaggedAt }), t('partner.kyc.platformDecides'));
  });

  it('6. a listed admin without two-step -> mfaRequired; an unlisted agent, a suspended listed user -> notCompliance', async () => {
    await seedComplianceUsers(db, P, ['co-a'], { redis, role: 'admin' });
    await signInAs(redis, cookieJar, { username: 'co-a', name: 'Compliance co-a', partnerId: P, role: 'admin' });
    mfa.enrolled = false;
    await refuses(form(), t('partner.kyc.mfaRequired'));
    mfa.enrolled = true;
    staffRead.transform = (s) => ({ ...s!, status: 'suspended' });
    await refuses(form(), t('partner.kyc.notCompliance'));
    staffRead.transform = null;
    await signInAs(redis, cookieJar, { username: 'x-agent', partnerId: P, role: 'agent' });
    await refuses(form(), t('partner.kyc.notCompliance'));
    mfa.enrolled = false;
    await refuses(form(), t('partner.kyc.notCompliance')); // not listed never learns about the MFA rule
  });

  it('7. the step-up runs after every validation with (kyc.decide, { always: true }); a step_up_required result is returned as-is, nothing written', async () => {
    const flaggedAt = await pepOnly();
    await asCo();
    gate.result = STEP_UP;
    const before = await snapshot();
    expect(await decideKycAction(form({ disposition: 'false_positive', screeningFlaggedAt: flaggedAt }))).toEqual(STEP_UP);
    expect(await snapshot()).toEqual(before);
    expect(gate.calls).toEqual([{ target: 'kyc.decide', opts: { always: true }, username: 'co-a' }]);
    // A bad reason or decision is refused BEFORE the step-up (no code spent).
    gate.calls = [];
    await refuses(form({ reason: 'short' }), t('partner.kyc.reasonTooShort'));
    await refuses(form({ decision: 'override' }), t('partner.kyc.invalidDecision'));
  });

  it('8. the owner read throws or returns null -> notAllowed; a support role is redirected by PARTNER_OPS first', async () => {
    await asCo();
    ownerRead.mode = 'throw';
    await refuses(form(), t('partner.kyc.notAllowed'));
    ownerRead.mode = 'null';
    await refuses(form(), t('partner.kyc.notAllowed'));
    ownerRead.mode = 'real';
    await signInAs(redis, cookieJar, { username: 'acme-support', partnerId: P, role: 'support' });
    ownerRead.calls = 0;
    await expect(decideKycAction(form())).rejects.toThrow('REDIRECT:/partner');
    expect(ownerRead.calls).toBe(1); // only getCurrentStaff's tenant read: the gate fired before the owner read
  });

  it('9. a ref sealed for partner B -> notFound (tenant)', async () => {
    await seedPartner(db, 'pb');
    await seedCustomer('pb');
    await asCo();
    await refuses(form({}, sealCustomerRef('pb', PHONE)), t('partner.customers.notFound'));
    await refuses(form({}, 'junk'), t('partner.customers.notFound'));
    expect((await row('pb')).kyc_status).toBe('pending');
  });
});

describe('decideKycAction: a partner that does not decide KYC keeps today’s path', { retry: 0 }, () => {
  const uncertified = async () => {
    await db.execute(sql`UPDATE partners SET live_controls = '{}'::jsonb WHERE id = ${P}`);
  };

  it('10. uncertified delegated: an agent (even a listed one) is redirected by PARTNER_ADMIN; an admin approve writes today’s meta exactly', async () => {
    await uncertified();
    await asCo();
    await expect(decideKycAction(form())).rejects.toThrow('REDIRECT:/partner');
    expect(await auditCount()).toBe(0);
    await signInAs(redis, cookieJar, { username: 'acme-admin', name: 'Pat Admin', partnerId: P, role: 'admin' });
    expect(await decideKycAction(form({ disposition: 'false_positive', eddDone: 'on', eddNote: 'Should be dropped.' }))).toEqual({ ok: true });
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['kyc.review.approve']);
    // The golden: the meta today's options (no extraMeta, no pepClear) write.
    expect(rows[0].meta).toEqual({
      previousStatus: 'pending',
      newStatus: 'verified',
      reason: REASON,
      source: 'persona_review',
      reviewerName: 'Pat Admin (acme-admin)',
      actorScope: 'partner',
    });
    expect(gate.calls).toEqual([]);
  });

  it('10b. uncertified delegated: a PEP flag still gets the fixed referred result, never platformDecides', async () => {
    await uncertified();
    const flaggedAt = await pepOnly();
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: P, role: 'admin' });
    await refuses(form({ disposition: 'false_positive', screeningFlaggedAt: flaggedAt }), t('partner.kyc.referred'));
  });
});

describe('KYC dispositions and the dialog', () => {
  it('11. every KYC_DISPOSITIONS value has an en.ts label partner.kyc.disposition.<d>', () => {
    const en = CATALOGUES.en as Record<string, string>;
    for (const d of KYC_DISPOSITIONS) expect(typeof en[`partner.kyc.disposition.${d}`], d).toBe('string');
  });

  it('the new copy names no list, score or customer detail', () => {
    for (const k of ['notCompliance', 'mfaRequired', 'platformDecides', 'dispositionRequired', 'eddNoteInvalid', 'changed'] as const) {
      expect(t(`partner.kyc.${k}`).toLowerCase()).not.toMatch(/ofac|sdn|score|watchlist|sanction/);
    }
  });

  it('the dialog: PEP fields only with pepFlag; the note is bounded by KYC_EDD_NOTE_MAX; the flag time rides hidden', () => {
    const plain = renderToStaticMarkup(createElement(KycComplianceDialog, { customerRef: 'r1', decisions: ['approve', 'reject'], pepFlag: false, flaggedAt: '' }));
    expect(plain).toContain('data-testid="partner-kyc-compliance-dialog"');
    expect(plain).not.toContain('name="disposition"');
    expect(plain).not.toContain('name="screeningFlaggedAt"');
    const iso = ago(HOUR).toISOString();
    const pep = renderToStaticMarkup(createElement(KycComplianceDialog, { customerRef: 'r1', decisions: ['approve', 'reject'], pepFlag: true, flaggedAt: iso }));
    for (const d of KYC_DISPOSITIONS) expect(pep).toContain(`value="${d}"`);
    expect(pep).toContain('name="eddDone"');
    expect(EDD_NOTE_MAX).toBe(KYC_EDD_NOTE_MAX);
    expect(pep).toContain(`maxLength="${KYC_EDD_NOTE_MAX}"`);
    expect(pep).toContain(`name="screeningFlaggedAt" value="${iso}"`);
    expect(pep).toContain(t('partner.kyc.dispositionLegend'));
  });
});

describe('/partner/customers/[ref] for a deciding partner', { retry: 0 }, () => {
  const page = async () => renderToStaticMarkup(await CustomerDetailPage({ params: Promise.resolve({ ref: ref() }) }));

  it('a qualified user sees the compliance dialog; on a PEP-only customer the disposition fields and the PEP note', async () => {
    await asCo();
    let html = await page();
    expect(html).toContain('data-testid="partner-kyc-decision"');
    expect(html).toContain('data-testid="partner-kyc-compliance-dialog"');
    expect(html).not.toContain('name="disposition"');
    expect(html).not.toContain(t('partner.kyc.pepFlagNote'));
    const flaggedAt = await pepOnly();
    html = await page();
    expect(html).toContain('name="disposition"');
    expect(html).toContain(t('partner.kyc.pepFlagNote'));
    expect(html).toContain(`value="${flaggedAt}"`);
  });

  it('a qualified user on a watchlist customer sees the platformDecides note and no controls', async () => {
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = ${P}`);
    await asCo();
    const html = await page();
    expect(html).toContain(t('partner.kyc.platformDecides'));
    expect(html).not.toContain('data-testid="partner-kyc-compliance-dialog"');
  });

  it('a non-qualified admin sees the notCompliance note, no controls and no flag', async () => {
    await pepOnly();
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: P, role: 'admin' });
    const html = await page();
    expect(html).toContain(t('partner.kyc.notCompliance'));
    expect(html).not.toContain('data-testid="partner-kyc-compliance-dialog"');
    expect(html).not.toContain('data-testid="partner-kyc-decision-dialog"');
    expect(html).not.toContain(t('partner.kyc.pepFlagNote'));
  });
});
