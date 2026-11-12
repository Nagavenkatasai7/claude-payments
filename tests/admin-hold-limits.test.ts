/**
 * Fix pack 7 T14a (P12, P13 platform call, P28, P29): the SmartRemit limits on
 * the admin release / reject of a held transfer, the pure control model the
 * compliance page renders (platformHoldControls), the platform refusal texts
 * and the audited escalate. Every uncertified owner (every tenant today) keeps
 * today's release and reject, byte for byte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifiedLiveControls, seedRealMoneyRail } from './helpers-live';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import { createStore, type Store } from '@/lib/store';
import type { Db } from '@/db/client';
import type { LiveControls } from '@/lib/live-controls';
import type { Partner, Staff, Transfer } from '@/lib/types';
import {
  AML_HOLD_REASON, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON, POSSIBLE_MATCH_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_SCREENING_REASON, VELOCITY_REASON,
  type CustomerScreeningFlags,
} from '@/lib/compliance-config';
import {
  canReleaseHeld, canRejectHeld, ESCALATE_NOT_HELD_REFUSAL, ESCALATE_NOT_QUEUE_REFUSAL, HOLD_CHANGED_REFUSAL, HOLD_REASON_REFUSAL,
  HOLD_REVIEW_RELOAD_REFUSAL, ORIGINATOR_INFO_RELEASE_REFUSAL, PARTNER_DECIDES_HOLD_REFUSAL, PLATFORM_RESCREEN_REFUSALS,
  platformHoldControls, platformHoldRefusal, RECIPIENT_IDENTITY_RELEASE_REFUSAL, RESCREEN_ONLY_RELEASE_REFUSAL,
} from '@/lib/dashboard-ops';
import { partnerMayRejectHold } from '@/lib/partner-reviews';
import { classReasonsFp, openHoldClasses, rowReasonsFp, classifyHold, type ReviewRowLite } from '@/lib/hold-queue';

// ── Mocks for the PGlite part ────────────────────────────────────────────────
let store: Store;
let db: Db;
const ADMIN: Staff = {
  username: 'plat-admin',
  name: 'Platform Admin',
  role: 'admin',
  permissions: { canCancel: true, canResend: true, canAssign: true, canRevealPii: true },
  passwordHash: 'HASH',
  createdAt: new Date().toISOString(),
};
const auth = vi.hoisted(() => ({ platformCalls: 0 }));
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ADMIN,
  requireStaff: async () => ADMIN,
  requirePlatformAdmin: async () => {
    auth.platformCalls += 1;
    return ADMIN;
  },
  requireScope: vi.fn(),
  getCurrentStaff: vi.fn(),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
const hostHeader = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: hostHeader.value }),
}));
const pokes = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => { pokes.n += 1; } };
});
// The admin-live-actions `gate` wrapper: bypass, or a fixed step-up answer (no session needed).
const STEP_TEXT = 'Enter the code from your authenticator app to continue.';
const gate = vi.hoisted(() => ({ bypass: false, calls: [] as string[] }));
vi.mock('@/lib/partner-step-up-gate', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-step-up-gate')>();
  return {
    ...actual,
    gateStaffStepUp: async (...a: Parameters<typeof actual.gateStaffStepUp>) => {
      gate.calls.push(a[2]);
      return gate.bypass ? null : { ok: false as const, error: STEP_TEXT, code: 'step_up_required' as const, factor: 'totp' as const };
    },
  };
});
// The owner read switch (tests/hold-release-seam.test.ts pattern).
const ownerRead = vi.hoisted(() => ({ mode: 'real' as 'real' | 'throw' | 'null' }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const repo = real.createPartnerRepo(...a);
      return {
        ...repo,
        getPartner: async (...g: Parameters<typeof repo.getPartner>) => {
          if (ownerRead.mode === 'throw') throw new Error('owner read failed');
          if (ownerRead.mode === 'null') return null;
          return repo.getPartner(...g);
        },
      };
    },
  };
});

// F4 (early review ED2): the admin reject consults canRejectHeld (the P12 rule); a pass-through spy.
const rejectRule = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/lib/dashboard-ops', async (orig) => {
  const real = await orig<typeof import('@/lib/dashboard-ops')>();
  return {
    ...real,
    canRejectHeld: (...a: Parameters<typeof real.canRejectHeld>) => {
      rejectRule.calls.push(a);
      return real.canRejectHeld(...a);
    },
  };
});

import { escalateHoldAction, rejectTransferAction, releaseTransferAction } from '@/app/admin-dashboard/actions';

// ── Pure part ────────────────────────────────────────────────────────────────
const CLEAR: CustomerScreeningFlags = { watchlistHit: null, pepHit: null, screeningWatchlistAt: null };
const PLATFORM = { kind: 'platform' } as const;
const PARTNER = { kind: 'partner', partnerId: 'acme' } as const;
type Owner = Pick<Partner, 'id' | 'status' | 'kycMode' | 'liveControls'>;
const withPosture = (holdDecider: 'partner' | 'smartremit_delegated', kycDecider: 'partner' | 'smartremit_procedures' = 'partner'): LiveControls => {
  const lc = certifiedLiveControls({ posture: true });
  return { ...lc, posture: { ...lc.posture!, holdDecider, kycDecider } };
};
const owner = (lc: LiveControls | undefined): Owner => ({ id: 'acme', status: 'active', kycMode: 'delegated', liveControls: lc });
const UNCERT = owner(undefined);
const QUEUE = owner(withPosture('partner'));
const DELEGATED = owner(withPosture('smartremit_delegated'));
const held = (reasons: string[], o: Partial<Pick<Transfer, 'complianceStatus'>> = {}) => ({
  status: 'in_review' as const,
  complianceStatus: o.complianceStatus ?? ('flagged' as const),
  complianceReasons: reasons,
});

describe('pack 7 T14a: canReleaseHeld / canRejectHeld (pure)', () => {
  it('canReleaseHeld platform: uncertified unchanged; queue owner refuses a partner class; delegated unchanged', () => {
    expect(canReleaseHeld(PLATFORM, UNCERT, held([LARGE_AMOUNT_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, UNCERT, held([AML_HOLD_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, UNCERT, held([LIST_UNAVAILABLE_REASON]), null)).toBe(false);
    expect(canReleaseHeld(PLATFORM, { kycMode: 'ours' }, held([LARGE_AMOUNT_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, {}, held([LARGE_AMOUNT_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, null, held([LARGE_AMOUNT_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, QUEUE, held([LARGE_AMOUNT_REASON]), null)).toBe(false);
    expect(canReleaseHeld(PLATFORM, QUEUE, held([AML_HOLD_REASON]), null)).toBe(false);
    expect(canReleaseHeld(PLATFORM, QUEUE, held([POSSIBLE_MATCH_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, QUEUE, held([LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]), null)).toBe(false);
    expect(canReleaseHeld(PLATFORM, QUEUE, held([SENDER_SCREENING_REASON]), null)).toBe(true);
    expect(canReleaseHeld(PLATFORM, DELEGATED, held([LARGE_AMOUNT_REASON]), null)).toBe(true);
  });

  it('canRejectHeld platform: false only when a queue owner\'s classes are all partner-decided; partner = partnerMayRejectHold', () => {
    for (const r of [LARGE_AMOUNT_REASON, AML_HOLD_REASON, POSSIBLE_MATCH_REASON, LIST_UNAVAILABLE_REASON, RECIPIENT_WATCHLIST_REASON, 'Legacy.']) {
      expect(canRejectHeld(PLATFORM, UNCERT, held([r]), CLEAR), r).toBe(true);
      expect(canRejectHeld(PLATFORM, DELEGATED, held([r]), CLEAR), r).toBe(true);
    }
    expect(canRejectHeld(PLATFORM, QUEUE, held([LARGE_AMOUNT_REASON]), CLEAR)).toBe(false);
    expect(canRejectHeld(PLATFORM, QUEUE, held([LARGE_AMOUNT_REASON, AML_HOLD_REASON]), CLEAR)).toBe(false);
    expect(canRejectHeld(PLATFORM, QUEUE, held([LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]), CLEAR)).toBe(true);
    // A later watchlist stamp is a platform class the platform can reject (R1).
    expect(canRejectHeld(PLATFORM, QUEUE, held([LARGE_AMOUNT_REASON]), { ...CLEAR, watchlistHit: true })).toBe(true);
    for (const [o, t, s] of [
      [{ kycMode: 'delegated' as const }, held([LARGE_AMOUNT_REASON]), CLEAR],
      [{ kycMode: 'ours' as const }, held([LARGE_AMOUNT_REASON]), CLEAR],
      [QUEUE, held([LARGE_AMOUNT_REASON]), CLEAR],
      [{ kycMode: 'delegated' as const }, held([POSSIBLE_MATCH_REASON]), CLEAR],
    ] as const) {
      expect(canRejectHeld(PARTNER, o, t, s)).toBe(partnerMayRejectHold(t, o, s));
    }
  });
});

const lite = (holdClass: ReviewRowLite['holdClass'], reasonsFp: string, o: Partial<ReviewRowLite> = {}): ReviewRowLite => ({
  holdClass, reasonsFp, step: 1, final: true, disposition: 'documents_verified', actor: 'plat', actorScope: 'platform',
  createdAt: new Date().toISOString(), ...o,
});

describe('pack 7 T14a: platformHoldControls (pure)', () => {
  it('uncertified -> legacy', () => {
    expect(platformHoldControls(UNCERT, held([LARGE_AMOUNT_REASON]), CLEAR, [])).toEqual({ mode: 'legacy' });
    expect(platformHoldControls(null, held([LARGE_AMOUNT_REASON]), CLEAR, [])).toEqual({ mode: 'legacy' });
  });

  it('queue LARGE -> review, partnerDecides, escalate, no forms; rowFp is rowReasonsFp', () => {
    const c = platformHoldControls(QUEUE, held([LARGE_AMOUNT_REASON]), CLEAR, []);
    expect(c).toEqual({
      mode: 'review', rowFp: rowReasonsFp([LARGE_AMOUNT_REASON]), forms: [], partnerDecides: true, escalate: true, waitsList: false,
    });
  });

  it('queue LARGE + POSSIBLE_MATCH -> one sanctions_review form', () => {
    const c = platformHoldControls(QUEUE, held([LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]), CLEAR, []);
    expect(c.mode === 'review' && c.forms).toEqual([
      { holdClass: 'sanctions_review', release: ['false_positive_match'], reject: ['confirmed_match', 'unable_to_clear'] },
    ]);
    expect(c.mode === 'review' && [c.partnerDecides, c.escalate]).toEqual([true, true]);
  });

  it('delegated LARGE -> one kyc form, nobody else decides', () => {
    const c = platformHoldControls(DELEGATED, held([LARGE_AMOUNT_REASON, VELOCITY_REASON]), CLEAR, []);
    expect(c).toEqual({
      mode: 'review', rowFp: rowReasonsFp([LARGE_AMOUNT_REASON, VELOCITY_REASON]),
      forms: [{ holdClass: 'kyc', release: ['documents_verified', 'activity_explained'], reject: ['customer_not_verified', 'activity_unexplained'] }],
      partnerDecides: false, escalate: false, waitsList: false,
    });
  });

  it('LIST_UNAVAILABLE -> waitsList and ONE list_wait reject form (M11)', () => {
    for (const o of [QUEUE, DELEGATED]) {
      const c = platformHoldControls(o, held([LIST_UNAVAILABLE_REASON]), CLEAR, []);
      expect(c.mode === 'review' && c.waitsList).toBe(true);
      expect(c.mode === 'review' && c.forms).toEqual([{ holdClass: 'list_wait', release: [], reject: ['unable_to_clear'] }]);
    }
    // With another platform class: reject forms only.
    const c = platformHoldControls(DELEGATED, held([LIST_UNAVAILABLE_REASON, LARGE_AMOUNT_REASON]), CLEAR, []);
    expect(c.mode === 'review' && c.forms).toEqual([
      { holdClass: 'kyc', release: [], reject: ['customer_not_verified', 'activity_unexplained'] },
      { holdClass: 'list_wait', release: [], reject: ['unable_to_clear'] },
    ]);
  });

  it('data_missing: rendered although nobody decides it (C3); release only once the data is on file', () => {
    for (const r of [RECIPIENT_IDENTITY_MISSING_REASON, ORIGINATOR_INFO_MISSING_REASON]) {
      const off = platformHoldControls(QUEUE, held([r]), CLEAR, []);
      expect(off.mode === 'review' && off.forms).toEqual([{ holdClass: 'data_missing', release: [], reject: ['data_not_provided'] }]);
      const on = platformHoldControls(QUEUE, held([r]), CLEAR, [], { dataOnFile: true });
      expect(on.mode === 'review' && on.forms).toEqual([{ holdClass: 'data_missing', release: ['data_received'], reject: ['data_not_provided'] }]);
    }
  });

  it('a blocked row of a certified owner -> one blocked reject form (C3)', () => {
    const c = platformHoldControls(DELEGATED, held([RECIPIENT_WATCHLIST_REASON], { complianceStatus: 'blocked' }), CLEAR, []);
    expect(c.mode === 'review' && c.forms).toEqual([{ holdClass: 'blocked', release: [], reject: ['confirmed_match'] }]);
  });

  it('queue [LARGE] + a later watchlist stamp -> one synthetic sender_watchlist form (R1 a)', () => {
    const flags: CustomerScreeningFlags = { ...CLEAR, watchlistHit: true, screeningFlaggedAt: new Date(Date.now() - 60_000).toISOString() };
    const c = platformHoldControls(QUEUE, held([LARGE_AMOUNT_REASON]), flags, []);
    expect(c.mode === 'review' && c.forms).toEqual([
      { holdClass: 'sender_watchlist', release: ['false_positive_match'], reject: ['confirmed_match', 'unable_to_clear'] },
    ]);
    expect(c.mode === 'review' && c.partnerDecides).toBe(true);
  });

  it('a FINAL review under the current classReasonsFp hides its form; under an old fp it does not', () => {
    const fp = classReasonsFp({ holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON] });
    const now = platformHoldControls(DELEGATED, held([LARGE_AMOUNT_REASON]), CLEAR, [lite('kyc', fp)]);
    expect(now.mode === 'review' && now.forms).toEqual([]);
    const old = platformHoldControls(DELEGATED, held([LARGE_AMOUNT_REASON]), CLEAR, [lite('kyc', 'v1|kyc|old')]);
    expect(old.mode === 'review' && old.forms.map((f) => f.holdClass)).toEqual(['kyc']);
    // A non-final step 1 keeps it open.
    const open = platformHoldControls(DELEGATED, held([LARGE_AMOUNT_REASON]), CLEAR, [lite('kyc', fp, { final: false })]);
    expect(open.mode === 'review' && open.forms.map((f) => f.holdClass)).toEqual(['kyc']);
  });

  it('openHoldClasses keeps the classes with no final row under their current fp (the sender fp carries the flag time)', () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const flags: CustomerScreeningFlags = { ...CLEAR, watchlistHit: true, screeningFlaggedAt: at };
    const classes = classifyHold([LARGE_AMOUNT_REASON], flags, { queue: false, partnerDecidesKyc: false });
    const sw = classes.find((c) => c.holdClass === 'sender_watchlist')!;
    expect(openHoldClasses(classes, [lite('sender_watchlist', classReasonsFp(sw, flags))], flags).map((c) => c.holdClass)).toEqual(['kyc']);
    expect(openHoldClasses(classes, [lite('sender_watchlist', classReasonsFp(sw, null))], flags).map((c) => c.holdClass)).toEqual(['kyc', 'sender_watchlist']);
  });
});

describe('pack 7 T14a: platformHoldRefusal (pure)', () => {
  const t = held([LARGE_AMOUNT_REASON]);
  it('maps every refusal to one fixed text', () => {
    for (const w of ['changed', 'closed', 'same_actor', 'disposition'] as const) expect(platformHoldRefusal(w, t)).toBe(HOLD_CHANGED_REFUSAL);
    for (const w of ['not_yours', 'waits_platform'] as const) expect(platformHoldRefusal(w, t)).toBe(PARTNER_DECIDES_HOLD_REFUSAL);
    expect(platformHoldRefusal('waits_list', t)).toBe(RESCREEN_ONLY_RELEASE_REFUSAL);
    expect(platformHoldRefusal('waits_data', held([RECIPIENT_IDENTITY_MISSING_REASON]))).toBe(RECIPIENT_IDENTITY_RELEASE_REFUSAL);
    expect(platformHoldRefusal('waits_data', held([ORIGINATOR_INFO_MISSING_REASON]))).toBe(ORIGINATOR_INFO_RELEASE_REFUSAL);
    expect(platformHoldRefusal('blocked', t)).toBe(PLATFORM_RESCREEN_REFUSALS.blocked);
  });
});

// ── PGlite part ──────────────────────────────────────────────────────────────
type Rows<T> = { rows: T[] };
async function count(table: 'hold_reviews' | 'audit_events' | 'outbox', id?: string): Promise<number> {
  const where =
    table === 'hold_reviews' ? sql`WHERE transfer_id = ${id ?? ''}` : table === 'audit_events' ? sql`WHERE subject_id = ${id ?? ''}` : sql``;
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} ${where}`)) as unknown as Rows<{ n: number }>;
  return r.rows[0].n;
}
async function snapshot(id: string) {
  return {
    status: (await store.getTransfer(id))?.status,
    reviews: await count('hold_reviews', id),
    audit: await count('audit_events', id),
    outbox: await count('outbox'),
  };
}
type ReviewRow = { hold_class: string; step: number; final: boolean; disposition: string; actor_scope: string; actor: string; reason: string };
async function reviewRows(id: string): Promise<ReviewRow[]> {
  const r = (await db.execute(sql`SELECT * FROM hold_reviews WHERE transfer_id = ${id} ORDER BY created_at, step`)) as unknown as Rows<ReviewRow>;
  return r.rows;
}
type AuditRow = { partner_id: string; actor: string; action: string; meta: Record<string, unknown> };
async function audits(id: string, action: string): Promise<AuditRow[]> {
  const r = (await db.execute(sql`SELECT partner_id, actor, action, meta FROM audit_events WHERE subject_id = ${id} AND action = ${action} ORDER BY id`)) as unknown as Rows<AuditRow>;
  return r.rows;
}
async function setReasons(id: string, reasons: string[]): Promise<Transfer> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
  return (await store.getTransfer(id))!;
}
const NOTE = 'Checked the documents on file for this hold.';
function form(t: Transfer, f: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  fd.set('id', t.id);
  for (const [k, v] of Object.entries(f)) if (v !== undefined) fd.set(k, v);
  return fd;
}
const full = (t: Transfer, holdClass: string, disposition: string, o: Record<string, string | undefined> = {}) =>
  form(t, { holdClass, disposition, rowFp: rowReasonsFp(t.complianceReasons), note: NOTE, ...o });
async function errorOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  gate.bypass = false;
  gate.calls = [];
  pokes.n = 0;
  ownerRead.mode = 'real';
  hostHeader.value = 'smartremit.ai';
  auth.platformCalls = 0;
  rejectRule.calls = [];
});

describe('pack 7 T14a: the admin release / reject actions', { retry: 0 }, () => {
  it('5. uncertified: release with id + note works as today; no review row; no step-up; a posted disposition is ignored', async () => {
    await seedPartner(db, 'acme');
    await seedRealMoneyRail(db, 'acme');
    const t = await heldRowFor(db, 'acme', 'kyc');
    await releaseTransferAction(form(t, { note: NOTE, holdClass: 'kyc', disposition: 'customer_not_verified', rowFp: 'junk' }));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect(await count('hold_reviews', t.id)).toBe(0);
    expect(gate.calls).toEqual([]);
    const rel = await audits(t.id, 'transfer.release');
    expect(rel).toHaveLength(1);
    expect(rel[0].meta).not.toHaveProperty('disposition');

    const t2 = await heldRowFor(db, 'acme', 'kyc', { id: 'held_kyc_two' });
    await rejectTransferAction(form(t2, { note: NOTE, holdClass: 'kyc', disposition: 'documents_verified' }));
    expect((await store.getTransfer(t2.id))?.status).toBe('cancelled');
    expect(await count('hold_reviews', t2.id)).toBe(0);
    expect(gate.calls).toEqual([]);
  });

  it('6. queue owner, kyc row: release and reject throw PARTNER_DECIDES, with or without holdClass kyc; nothing written; no step-up', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    for (const action of [releaseTransferAction, rejectTransferAction]) {
      expect(await errorOf(action(form(t, { note: NOTE })))).toBe(PARTNER_DECIDES_HOLD_REFUSAL);
      expect(await errorOf(action(full(t, 'kyc', action === releaseTransferAction ? 'documents_verified' : 'customer_not_verified'))))
        .toBe(PARTNER_DECIDES_HOLD_REFUSAL);
    }
    expect(await snapshot(t.id)).toEqual(before);
    expect(gate.calls).toEqual([]);
  });

  it('7. certified delegated, old tab (no holdClass / disposition / rowFp): RELOAD; nothing written; no step-up', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    expect(await errorOf(releaseTransferAction(form(t, { note: NOTE })))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(rejectTransferAction(form(t, { note: NOTE })))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await snapshot(t.id)).toEqual(before);
    expect(gate.calls).toEqual([]);
  });

  it('8. full fields, step-up not passed: throws the step-up text; gate.calls [hold.decide]; nothing written', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified')))).toBe(STEP_TEXT);
    expect(gate.calls).toEqual(['hold.decide']);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('9. step-up passed: release documents_verified -> paid with one platform review row; reject customer_not_verified -> cancelled', async () => {
    gate.bypass = true;
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    await releaseTransferAction(full(t, 'kyc', 'documents_verified'));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    const rows = await reviewRows(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hold_class: 'kyc', step: 1, final: true, actor_scope: 'platform', actor: 'plat-admin', reason: NOTE, disposition: 'documents_verified' });
    const rel = await audits(t.id, 'transfer.release');
    expect(rel).toHaveLength(1);
    expect(rel[0].meta).toMatchObject({ step: 1, disposition: 'documents_verified', holdClass: 'kyc', actorScope: 'platform' });
    expect(typeof rel[0].meta.reviewId).toBe('string');
    expect(gate.calls).toEqual(['hold.decide']);

    const t2 = await heldRowFor(db, 'acme', 'kyc', { id: 'held_kyc_two' });
    await rejectTransferAction(full(t2, 'kyc', 'customer_not_verified'));
    expect((await store.getTransfer(t2.id))?.status).toBe('cancelled');
    expect(await reviewRows(t2.id)).toHaveLength(1);
    expect((await audits(t2.id, 'transfer.reject'))[0].meta).toMatchObject({ disposition: 'customer_not_verified', holdClass: 'kyc', actorScope: 'platform' });
  });

  it('10. a wrong-direction or foreign disposition -> RELOAD; a short reason or a long digit run -> HOLD_REASON_REFUSAL; all before the step-up', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'customer_not_verified')))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(rejectTransferAction(full(t, 'kyc', 'documents_verified')))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'false_positive_match')))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'nonsense')))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(releaseTransferAction(full(t, 'nope', 'documents_verified')))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified', { rowFp: 'x'.repeat(1001) })))).toBe(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified', { note: '123456789' })))).toBe(HOLD_REASON_REFUSAL);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified', { note: 'Account 1234567890 checked.' })))).toBe(HOLD_REASON_REFUSAL);
    expect(gate.calls).toEqual([]);
    expect(await snapshot(t.id)).toEqual(before);
    // A 7-digit run passes the reason rule (it reaches the step-up).
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified', { note: 'Ticket 1234567 documents checked.' })))).toBe(STEP_TEXT);
  });

  it('11a. queue LARGE + POSSIBLE_MATCH: platform false_positive_match -> recorded, still in_review; holdClass kyc -> PARTNER_DECIDES', async () => {
    gate.bypass = true;
    await certifiedQueuePartner(db);
    const t0 = await heldRowFor(db, 'acme', 'sanctions_review');
    const t = await setReasons(t0.id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified')))).toBe(PARTNER_DECIDES_HOLD_REFUSAL);
    await releaseTransferAction(full(t, 'sanctions_review', 'false_positive_match'));
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await reviewRows(t.id)).toMatchObject([{ hold_class: 'sanctions_review', final: true, actor_scope: 'platform' }]);
    expect(await audits(t.id, 'transfer.hold.review')).toHaveLength(1);
  });

  it('11b. certified owner, blocked row: platform reject confirmed_match -> cancelled with one review row (C3)', async () => {
    gate.bypass = true;
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'blocked');
    await rejectTransferAction(full(t, 'blocked', 'confirmed_match'));
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect(await reviewRows(t.id)).toMatchObject([{ hold_class: 'blocked', disposition: 'confirmed_match' }]);
  });

  it('11c. certified owner, LIST_UNAVAILABLE row: platform reject unable_to_clear -> cancelled; platform release -> RESCREEN_ONLY (M11)', async () => {
    gate.bypass = true;
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'list_wait');
    const before = await snapshot(t.id);
    expect(await errorOf(releaseTransferAction(full(t, 'list_wait', 'unable_to_clear')))).toBe(RESCREEN_ONLY_RELEASE_REFUSAL);
    const t2 = await setReasons(t.id, [LIST_UNAVAILABLE_REASON, LARGE_AMOUNT_REASON]);
    expect(await errorOf(releaseTransferAction(full(t2, 'kyc', 'documents_verified')))).toBe(RESCREEN_ONLY_RELEASE_REFUSAL);
    expect(await snapshot(t.id)).toEqual(before);
    const t3 = await setReasons(t.id, [LIST_UNAVAILABLE_REASON]);
    await rejectTransferAction(full(t3, 'list_wait', 'unable_to_clear'));
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect(await reviewRows(t.id)).toMatchObject([{ hold_class: 'list_wait', disposition: 'unable_to_clear' }]);
  });

  it('11d. queue owner, [LARGE] + a later watchlist stamp: platform reject of the sender_watchlist class -> cancelled (R1 a)', async () => {
    gate.bypass = true;
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    // O3: the later stamp, set after heldRowFor (it re-saves the shared sender).
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() - interval '5 minutes'
      WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    await rejectTransferAction(full(t, 'sender_watchlist', 'confirmed_match'));
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect(await reviewRows(t.id)).toMatchObject([{ hold_class: 'sender_watchlist', actor_scope: 'platform' }]);
  });

  it('11e. a stale rowFp -> HOLD_CHANGED_REFUSAL, before the step-up', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified', { rowFp: rowReasonsFp([VELOCITY_REASON]) }))))
      .toBe(HOLD_CHANGED_REFUSAL);
    expect(gate.calls).toEqual([]);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('12. owner read throws or is null -> the generic permission text; nothing written', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    for (const mode of ['throw', 'null'] as const) {
      ownerRead.mode = mode;
      for (const action of [releaseTransferAction, rejectTransferAction]) {
        expect(await errorOf(action(full(t, 'kyc', 'documents_verified')))).toBe('You do not have permission to perform this action.');
      }
    }
    ownerRead.mode = 'real';
    expect(await snapshot(t.id)).toEqual(before);
    expect(gate.calls).toEqual([]);
  });

  it('F4.1 (ED2): queue owner, real-money [LARGE] row, platform reject of kyc: PARTNER_DECIDES, and canRejectHeld was consulted', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON]);
    const before = await snapshot(t.id);
    // The class LARGE_AMOUNT_REASON maps to (kyc), and the brief's literal 'large_amount' (not a class: no posted class).
    for (const holdClass of ['kyc', 'large_amount']) {
      rejectRule.calls = [];
      expect(await errorOf(rejectTransferAction(full(t, holdClass, 'customer_not_verified')))).toBe(PARTNER_DECIDES_HOLD_REFUSAL);
      expect(rejectRule.calls).toHaveLength(1);
      expect(rejectRule.calls[0][0]).toEqual({ kind: 'platform' });
      expect((rejectRule.calls[0][1] as Partner).id).toBe('acme');
      expect((rejectRule.calls[0][2] as Transfer).id).toBe(t.id);
    }
    expect(await snapshot(t.id)).toEqual(before);
    expect(gate.calls).toEqual([]);
  });

  it('F4.1b (ED2): a posted platform class the row does not carry on an all-partner row: only canRejectHeld refuses (PARTNER_DECIDES)', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON]);
    const before = await snapshot(t.id);
    expect(await errorOf(rejectTransferAction(full(t, 'sanctions_review', 'confirmed_match')))).toBe(PARTNER_DECIDES_HOLD_REFUSAL);
    expect(rejectRule.calls).toHaveLength(1);
    expect(await snapshot(t.id)).toEqual(before);
    expect(gate.calls).toEqual([]);
  });

  it('F4.1c (ED2): a release never consults the reject rule; a certified delegated reject does, and the rule allows it', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await errorOf(releaseTransferAction(full(t, 'kyc', 'documents_verified')))).toBe(STEP_TEXT);
    expect(rejectRule.calls).toEqual([]);
    // Certified delegated: the reject consults the rule, which allows it (kyc is platform-decided).
    expect(await errorOf(rejectTransferAction(full(t, 'kyc', 'customer_not_verified')))).toBe(STEP_TEXT);
    expect(rejectRule.calls).toHaveLength(1);
  });
});

describe('pack 7 T14a: escalateHoldAction', { retry: 0 }, () => {
  const day = () => new Date().toISOString().slice(0, 10);
  async function emails(): Promise<Array<{ dedupe_key: string; payload: { to: string[]; subject: string; text: string } }>> {
    const r = (await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`)) as unknown as Rows<{
      dedupe_key: string; payload: { to: string[]; subject: string; text: string };
    }>;
    return r.rows;
  }
  const setAddress = (addr: string) =>
    db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: addr })}::jsonb WHERE id = 'acme'`);

  it('refuses on a site host first', async () => {
    hostHeader.value = 'acme.smartremit.ai';
    await expect(escalateHoldAction(new FormData())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(auth.platformCalls).toBe(0);
  });

  it('a non-queue owner -> ESCALATE_NOT_QUEUE; a row no longer held -> ESCALATE_NOT_HELD; nothing written', async () => {
    await certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await errorOf(escalateHoldAction(form(t, {})))).toBe(ESCALATE_NOT_QUEUE_REFUSAL);
    expect(await audits(t.id, 'transfer.hold.escalate')).toHaveLength(0);

    await certifiedQueuePartner(db, { partnerId: 'beta' });
    const q = await heldRowFor(db, 'beta', 'kyc');
    await db.execute(sql`UPDATE transfers SET status = 'cancelled' WHERE id = ${q.id}`);
    expect(await errorOf(escalateHoldAction(form(q, {})))).toBe(ESCALATE_NOT_HELD_REFUSAL);
    expect(await audits(q.id, 'transfer.hold.escalate')).toHaveLength(0);
    expect(await count('outbox')).toBe(0);
  });

  it('success: one audit, one email to the compliance address, no state change, one poke; a second click the same day -> 2 audits, 1 email', async () => {
    await certifiedQueuePartner(db);
    await setAddress('compliance@acme.example');
    const t = await heldRowFor(db, 'acme', 'kyc');
    const outboxBefore = await count('outbox');
    await escalateHoldAction(form(t, {}));
    expect(auth.platformCalls).toBe(1);
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await count('hold_reviews', t.id)).toBe(0);
    const a = await audits(t.id, 'transfer.hold.escalate');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partner_id: 'acme', actor: 'plat-admin' });
    expect(a[0].meta).toMatchObject({ holdClasses: ['kyc'], actorScope: 'platform' });
    expect(await emails()).toEqual([{
      dedupe_key: `holdescalate:${t.id}:${day()}`,
      payload: {
        to: ['compliance@acme.example'],
        subject: 'SmartRemit: a held transfer waits for your decision',
        text: `Transfer ${t.id} is held and waits for your compliance team's decision in your SmartRemit workspace (Reviews). Do not share this notice with the customer.`,
      },
    }]);
    expect(await count('outbox')).toBe(outboxBefore + 1);
    expect(pokes.n).toBe(1);

    await escalateHoldAction(form(t, {}));
    expect(await audits(t.id, 'transfer.hold.escalate')).toHaveLength(2);
    expect(await emails()).toHaveLength(1);
  });

  it('no compliance address -> the audit only', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    await escalateHoldAction(form(t, {}));
    expect(await audits(t.id, 'transfer.hold.escalate')).toHaveLength(1);
    expect(await emails()).toHaveLength(0);
  });
});
