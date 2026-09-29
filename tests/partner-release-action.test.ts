import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore, type Store } from '@/lib/store';
import type { Db } from '@/db/client';

// UI redesign M3-10, Task 10.2: releaseHoldAction — a MONEY write. It reuses the ONE release path
// (dashboard-ops releaseTransfer → settlement.releaseHold: the paid flip, the rail effect and the
// `transfer.release` audit row in one transaction). The M3-1 harness: real auth store on a fake
// Redis, real partner store + ledger on PGlite, a simulator rail for tenant A.
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

import { releaseHoldAction } from '@/app/partner/(app)/transfers/[id]/release-actions';
import { auditEvents, outbox, transfers } from '@/db/schema';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EDD_REQUIRED_REASON as EDD, LARGE_AMOUNT_REASON as LARGE, SCREENING_REASONS } from '@/lib/compliance-config';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { t } from '@/lib/i18n';

const REASON = 'Source of funds verified with the sender.';
const form = (id: string, reason = REASON) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('reason', reason);
  return fd;
};
const transferRow = async (id: string) => (await db.select().from(transfers).where(eq(transfers.id, id)))[0];
const count = async (table: typeof auditEvents | typeof outbox) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;
const outboxRows = async () => (await db.execute(sql`SELECT kind FROM outbox ORDER BY id`)) as unknown as { rows: Array<{ kind: string }> };
const releaseRows = () => db.select().from(auditEvents).where(eq(auditEvents.action, 'transfer.release')).orderBy(auditEvents.id);
const snapshot = async () => ({
  audit: await count(auditEvents),
  outbox: await count(outbox),
  ta: await transferRow('tr_heldA1'),
  tb: await transferRow('tr_heldB1'),
});

const setKyc = (id: string, mode: 'ours' | 'delegated') => db.execute(sql`UPDATE partners SET kyc_mode = ${mode} WHERE id = ${id}`);
const seedHeld = (id: string, partnerId: string, reasons: string[], o: Record<string, unknown> = {}) =>
  seedPartnerTransfer(db, { id, partnerId, status: 'in_review', complianceStatus: 'flagged', complianceReasons: reasons, paidAt: new Date().toISOString(), ...o });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  host.value = 'smartremit.ai';
  db = await freshDb();
  store = createStore(redis, db);
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  // Both tenants delegated, so a foreign-id refusal can only come from tenant scoping.
  await setKyc('pa', 'delegated');
  await setKyc('pb', 'delegated');
  await createIntegrationsRepo(db).saveIntegrations('pa', {
    kyc: {},
    payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example.test/instruct', signingSecret: 'sgn_m310' }, webhookSecret: 'whk_m310' },
    whatsapp: {},
  });
  await seedHeld('tr_heldA1', 'pa', [LARGE]);
  await seedHeld('tr_heldB1', 'pb', [LARGE]);
});

const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

describe('releaseHoldAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign id, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: releaseHoldAction,
      form: (id) => form(id),
      ownId: 'tr_heldA1',
      foreignId: 'tr_heldB1',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
    });
    // Item 4 released A's row only; B untouched.
    expect((await transferRow('tr_heldA1')).status).toBe('paid');
    expect((await transferRow('tr_heldB1')).status).toBe('in_review');
  });

  it.each(['agent', 'support', 'finance'] as const)('every non-admin role (%s) → REDIRECT:/partner, nothing changed', async (role) => {
    const before = await snapshot();
    await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
    await expect(releaseHoldAction(form('tr_heldA1'))).rejects.toThrow('REDIRECT:/partner');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses on a partner-site host before any read (refuseOnSiteHost first)', async () => {
    await asAdmin();
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(releaseHoldAction(form('tr_heldA1'))).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toEqual(before);
  });

  it('a missing id, a foreign id and a junk id return the SAME not-found result', async () => {
    await asAdmin();
    const missing = await releaseHoldAction(form('tr_nope99'));
    const foreign = await releaseHoldAction(form('tr_heldB1'));
    const junk = await releaseHoldAction(form("x' OR 1=1"));
    expect(missing).toEqual({ ok: false, error: t('partner.common.notFound') });
    expect(foreign).toEqual(missing);
    expect(junk).toEqual(missing);
    expect((await transferRow('tr_heldB1')).status).toBe('in_review');
  });
});

describe('releaseHoldAction: refusals (no money moves, no audit row, no outbox row)', () => {
  const refuses = async (fd: FormData, error: string) => {
    const before = await snapshot();
    const r = await releaseHoldAction(fd);
    expect(r).toEqual({ ok: false, error });
    expect(await snapshot()).toEqual(before);
  };
  const notAllowed = () => t('partner.release.notAllowed');

  it.each(SCREENING_REASONS)('a SCREENING/SANCTIONS hold (%j) is refused, even for a delegated partner and even mixed with an EDD reason', async (reason) => {
    await seedHeld('tr_scrA1', 'pa', [reason]);
    await seedHeld('tr_scrA2', 'pa', [LARGE, reason]);
    await asAdmin();
    await refuses(form('tr_scrA1'), notAllowed());
    await refuses(form('tr_scrA2'), notAllowed());
    expect((await transferRow('tr_scrA1')).status).toBe('in_review');
    expect((await transferRow('tr_scrA2')).status).toBe('in_review');
    expect(await count(auditEvents)).toBe(0);
    expect(await count(outbox)).toBe(0);
  });

  it('an AML hold is refused', async () => {
    await seedHeld('tr_amlA1', 'pa', [AML_HOLD_REASON]);
    await asAdmin();
    await refuses(form('tr_amlA1'), notAllowed());
  });

  it('an unknown or empty reasons list is refused (fail closed)', async () => {
    await seedHeld('tr_unkA1', 'pa', ['Something new.']);
    await seedHeld('tr_empA1', 'pa', []);
    await asAdmin();
    await refuses(form('tr_unkA1'), notAllowed());
    await refuses(form('tr_empA1'), notAllowed());
  });

  it("a kycMode 'ours' partner is refused (SmartRemit's own review stays platform-only)", async () => {
    await setKyc('pa', 'ours');
    await asAdmin();
    await refuses(form('tr_heldA1'), notAllowed());
  });

  it('a sanctions-BLOCKED compliance status is refused', async () => {
    await seedHeld('tr_blkA1', 'pa', [LARGE], { complianceStatus: 'blocked' });
    await asAdmin();
    await refuses(form('tr_blkA1'), notAllowed());
  });

  it('a transfer that is not in_review is refused', async () => {
    await seedPartnerTransfer(db, { id: 'tr_paidA1', partnerId: 'pa', status: 'paid', complianceStatus: 'flagged', complianceReasons: [LARGE] });
    await asAdmin();
    await refuses(form('tr_paidA1'), notAllowed());
  });

  it("the reason 'too short' (9 characters) and a blank reason are refused", async () => {
    await asAdmin();
    await refuses(form('tr_heldA1', 'too short'), t('partner.release.reasonTooShort'));
    await refuses(form('tr_heldA1', '   \n\t '), t('partner.release.reasonTooShort'));
    // Padding does not count: collapsed whitespace is under 10.
    await refuses(form('tr_heldA1', 'ok      ok'), t('partner.release.reasonTooShort'));
  });

  it('a reason carrying a phone or account number is refused (append-only audit meta stays free of it), and the error never echoes it', async () => {
    await asAdmin();
    await refuses(form('tr_heldA1', 'Called the sender on +1 415 555 0101 to confirm'), t('partner.release.reasonHasNumber'));
  });
});

describe('releaseHoldAction: success', () => {
  it('releases through the ONE settlement path: paid, exactly one settlement.instruct row, exactly one transfer.release row', async () => {
    await asAdmin();
    const r = await releaseHoldAction(form('tr_heldA1'));
    expect(r).toEqual({ ok: true });
    expect((await transferRow('tr_heldA1')).status).toBe('paid');
    expect((await outboxRows()).rows).toEqual([{ kind: 'settlement.instruct' }]);
    const rows = await releaseRows();
    expect(rows).toHaveLength(1);
    // R2: the row is settlement.ts's `transfer.release` (no actorScope; exempt from checklist item 6's actorScope).
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: 'transfer.release', subjectId: 'tr_heldA1' });
    expect(rows[0].meta).toMatchObject({ reason: REASON, previousStatus: 'in_review', newStatus: 'paid' });
    // Exactly one audit row in total: the action writes NO second row.
    expect(await count(auditEvents)).toBe(1);
    const meta = JSON.stringify(rows[0].meta);
    expect(meta).not.toMatch(/\+?\d{10,}/);
    expect(meta).not.toContain('000011112222');
    expect(meta).not.toContain('Samplesurname');
    expect(revalidated).toEqual(['/partner/transfers', '/partner/transfers/tr_heldA1']);
  });

  it('an edd_required hold is releasable (owner O1), and a velocity + large hold', async () => {
    await seedHeld('tr_eddA1', 'pa', [EDD]);
    await seedHeld('tr_velA1', 'pa', ['High transfer velocity.', LARGE]);
    await asAdmin();
    expect(await releaseHoldAction(form('tr_eddA1'))).toEqual({ ok: true });
    expect(await releaseHoldAction(form('tr_velA1'))).toEqual({ ok: true });
    expect((await transferRow('tr_eddA1')).status).toBe('paid');
    expect((await transferRow('tr_velA1')).status).toBe('paid');
  });

  it('a stored reason longer than 500 characters is cut to 500', async () => {
    await asAdmin();
    expect(await releaseHoldAction(form('tr_heldA1', 'a'.repeat(600)))).toEqual({ ok: true });
    const [row] = await releaseRows();
    expect((row.meta as { reason: string }).reason).toHaveLength(500);
  });
});

describe('releaseHoldAction: double submit', () => {
  it('a sequential second submit is refused with notAllowed and no second outbox/audit row', async () => {
    await asAdmin();
    expect(await releaseHoldAction(form('tr_heldA1'))).toEqual({ ok: true });
    expect(await releaseHoldAction(form('tr_heldA1'))).toEqual({ ok: false, error: t('partner.release.notAllowed') });
    expect(await count(outbox)).toBe(1);
    expect((await releaseRows()).length).toBe(1);
  });

  it('two concurrent submits: exactly one releases (the guarded claim), the other is refused with notAllowed', async () => {
    await asAdmin();
    const results = await Promise.all([releaseHoldAction(form('tr_heldA1')), releaseHoldAction(form('tr_heldA1'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: t('partner.release.notAllowed') }]);
    expect((await transferRow('tr_heldA1')).status).toBe('paid');
    expect(await count(outbox)).toBe(1);
    expect((await releaseRows()).length).toBe(1);
  });
});
