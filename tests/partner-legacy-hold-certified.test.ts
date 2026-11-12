import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { certifiedLiveControls, certifyPartnerForTest } from './helpers-live';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore, type Store } from '@/lib/store';
import type { Db } from '@/db/client';

// Fix pack 7 T13 (P11, DP5): the legacy one-step partner release and reject (no review row, the
// release with no step-up) close for EVERY live-certified partner, whatever its posture. One rule,
// isPartnerReleasableHold, answers false first when reviewRecordApplies(owner); the actions, the
// page buttons and canReleaseHeld's partner branch follow it with today's generic copy. An owner
// with no id / status / liveControls reads as not certified, so every partner today is unchanged.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let store: Store;
let pgPartnerStore: PartnerStore;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai', 'x-forwarded-for': '203.0.113.9' }),
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
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (s: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, s) };
});

import { releaseHoldAction } from '@/app/partner/(app)/transfers/[id]/release-actions';
import { rejectHoldAction } from '@/app/partner/(app)/transfers/[id]/reject-actions';
import DetailPage from '@/app/partner/(app)/transfers/[id]/page';
import { auditEvents, outbox, transfers } from '@/db/schema';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { isPartnerReleasableHold, LARGE_AMOUNT_REASON as LARGE } from '@/lib/compliance-config';
import { partnerMayRejectHold } from '@/lib/partner-reviews';
import { canReleaseHeld } from '@/lib/dashboard-ops';
import { reviewRecordApplies, type ScopeOwner } from '@/lib/partner-decision-scope';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { t } from '@/lib/i18n';
import { isStepUpRequired } from '@/lib/staff-step-up-result';
import { hashPassword } from '@/lib/password';
import type { LiveControls } from '@/lib/live-controls';

// ---------------------------------------------------------------------------------------------
// Pure (no DB)
// ---------------------------------------------------------------------------------------------
const CLEAR = { watchlistHit: null, pepHit: null };
const held = { status: 'in_review' as const, complianceStatus: 'flagged' as const, complianceReasons: [LARGE] };
const ownerWith = (lc: LiveControls, o: { id?: string; status?: string } = {}) => ({
  id: o.id ?? 'acme',
  status: o.status ?? 'active',
  kycMode: 'delegated' as const,
  liveControls: lc,
});
const withPosture = (holdDecider: 'partner' | 'smartremit_delegated'): LiveControls => {
  const lc = certifiedLiveControls({ posture: true });
  return { ...lc, posture: { ...lc.posture!, holdDecider } };
};

describe('pack 7 T13: the legacy partner hold rule for a certified owner (pure)', () => {
  it('isPartnerReleasableHold -> false for a certified owner, with no posture, posture holdDecider partner, and smartremit_delegated', () => {
    for (const lc of [certifiedLiveControls(), withPosture('partner'), withPosture('smartremit_delegated')]) {
      expect(isPartnerReleasableHold(held, ownerWith(lc), CLEAR)).toBe(false);
    }
  });

  it('partnerMayRejectHold -> false and canReleaseHeld (partner scope) -> false', () => {
    const owner = ownerWith(certifiedLiveControls());
    expect(partnerMayRejectHold(held, owner, CLEAR)).toBe(false);
    expect(canReleaseHeld({ kind: 'partner', partnerId: 'acme' }, owner, held, CLEAR)).toBe(false);
  });

  it('the same owner with the certification revoked, or suspended -> true again (not certified: today\'s rule)', () => {
    const lc = certifiedLiveControls();
    const revoked: LiveControls = {
      ...lc,
      certification: { ...lc.certification!, revokedAt: new Date(Date.parse(lc.certification!.certifiedAt) + 1_000).toISOString() },
    };
    expect(isPartnerReleasableHold(held, ownerWith(revoked), CLEAR)).toBe(true);
    expect(isPartnerReleasableHold(held, ownerWith(lc, { status: 'suspended' }), CLEAR)).toBe(true);
    expect(partnerMayRejectHold(held, ownerWith(revoked), CLEAR)).toBe(true);
  });

  it('{ kycMode: delegated } with no id / status / liveControls -> true (the parity-test shape); reviewRecordApplies never throws on it', () => {
    const bare = { kycMode: 'delegated' };
    expect(() => reviewRecordApplies(bare as ScopeOwner)).not.toThrow();
    expect(reviewRecordApplies(bare as ScopeOwner)).toBe(false);
    expect(isPartnerReleasableHold(held, bare, CLEAR)).toBe(true);
    expect(partnerMayRejectHold(held, bare, CLEAR)).toBe(true);
  });

  it('the default tenant id with a certification record -> true (isLiveCertified is false for default)', () => {
    expect(isPartnerReleasableHold(held, ownerWith(certifiedLiveControls(), { id: DEFAULT_PARTNER_ID }), CLEAR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PGlite: the actions and the transfer page
// ---------------------------------------------------------------------------------------------
const REASON = 'Source of funds verified with the sender.';
const PASSWORD = 'correct horse battery staple';
const SENDER = '14155550101';
const form = (id: string) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('reason', REASON);
  return fd;
};
const transferRow = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0];
const count = async (table: typeof auditEvents | typeof outbox) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;
const auditCount = async (action: string) => (await db.select().from(auditEvents).where(eq(auditEvents.action, action))).length;
const detail = async (id: string) => renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
const asAdmin = async () =>
  signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin', passwordHash: await hashPassword(PASSWORD) });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  store = createStore(redis, db);
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'pa'`);
  await createIntegrationsRepo(db).saveIntegrations('pa', {
    kyc: {},
    payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example.test/instruct', signingSecret: 'sgn_t13' }, webhookSecret: 'whk_t13' },
    whatsapp: {},
  });
  await seedPartnerTransfer(db, {
    id: 'tr_heldA1',
    partnerId: 'pa',
    phone: SENDER,
    status: 'in_review',
    complianceStatus: 'flagged',
    complianceReasons: [LARGE],
    paidAt: new Date().toISOString(),
  });
  await createCustomerRepo(db, async () => null).ensureCustomer('pa', SENDER);
});

describe('pack 7 T13: a certified delegated partner gets no legacy release or reject', () => {
  it('releaseHoldAction -> notAllowed; still in_review; no transfer.release row; no outbox row', async () => {
    await certifyPartnerForTest(db, 'pa');
    await asAdmin();
    const outboxBefore = await count(outbox);
    expect(await releaseHoldAction(form('tr_heldA1'))).toEqual({ ok: false, error: t('partner.release.notAllowed') });
    expect((await transferRow('tr_heldA1')).status).toBe('in_review');
    expect(await auditCount('transfer.release')).toBe(0);
    expect(await count(outbox)).toBe(outboxBefore);
  });

  it('rejectHoldAction -> notAllowed BEFORE any step-up prompt (a stale session); still in_review; no funding.refund', async () => {
    await certifyPartnerForTest(db, 'pa');
    await asAdmin();
    const r = await rejectHoldAction(form('tr_heldA1'));
    expect(isStepUpRequired(r)).toBe(false);
    expect(r).toEqual({ ok: false, error: t('partner.reject.notAllowed') });
    expect((await transferRow('tr_heldA1')).status).toBe('in_review');
    expect(await auditCount('transfer.reject')).toBe(0);
    const kinds = ((await db.execute(sql`SELECT kind FROM outbox`)) as unknown as { rows: Array<{ kind: string }> }).rows.map((x) => x.kind);
    expect(kinds).not.toContain('funding.refund');
  });

  it('the transfer page shows no partner-release / partner-reject block, and shows the holdRelease line', async () => {
    await certifyPartnerForTest(db, 'pa');
    await asAdmin();
    const html = await detail('tr_heldA1');
    expect(html).not.toContain('data-testid="partner-release"');
    expect(html).not.toContain('data-testid="partner-reject"');
    expect(html).toContain(t('partner.transfers.holdRelease'));
  });

  it('control: the same partner uncertified releases as today, and the page offers the buttons', async () => {
    await asAdmin();
    const html = await detail('tr_heldA1');
    expect(html).toContain('data-testid="partner-release"');
    expect(html).toContain('data-testid="partner-reject"');
    expect(await releaseHoldAction(form('tr_heldA1'))).toEqual({ ok: true });
    expect((await transferRow('tr_heldA1')).status).toBe('paid');
    expect(await auditCount('transfer.release')).toBe(1);
  });
});
