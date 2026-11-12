/**
 * Fix pack 7 T11 (P10): decideHoldAction, the partner hold decision action.
 * Real gate (requirePartnerStaff over the real auth store on a fake Redis),
 * real step-up (TOTP factor, the MFA store mocked as in
 * tests/partner-aml-holds-action.test.ts), real decision core (decideHold)
 * and money seam on PGlite. Gates in P10's order: site host -> PARTNER_OPS ->
 * owner (holdQueueApplies) -> qualified compliance user (fresh staff read) ->
 * MFA -> the bound route id (owner tenant, 404) -> inputs -> the unlocked plan
 * -> the forced step-up on a FINAL step only -> decideHold. Every refusal
 * writes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { expectPartnerActionContract, signInAs } from './helpers-partner-app';
import { certifiedQueuePartner, heldRowFor, seedComplianceUsers } from './helpers-hold';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';
import { seedOriginatorForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
const jars = vi.hoisted(() => ({ als: null as null | { getStore(): Map<string, string> | undefined } }));
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
let db: Db;
let store: import('@/lib/store').Store;
const revalidated: string[] = [];

vi.mock('next/headers', () => ({
  cookies: async () => {
    const jar = jars.als?.getStore() ?? cookieJar;
    return {
      get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined),
      set: (n: string, v: string) => jar.set(n, v),
      delete: (a: string | { name: string }) => jar.delete(typeof a === 'string' ? a : a.name),
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    };
  },
  headers: async () => new Headers({ host: host.value, 'x-forwarded-for': '203.0.113.9' }),
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
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => store };
});
// The action's fresh staff re-read is the SECOND getStaff of a call (getCurrentStaff is the first).
const staffRead = vi.hoisted(() => ({ calls: 0, transform: null as null | ((s: Staff | null) => Staff | null) }));
vi.mock('@/lib/auth-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth-store')>();
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
vi.mock('@/lib/partner-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-store')>();
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
// The step-up factor is TOTP (enrolled); the action's own enrolled read has its own switch.
const mfa = vi.hoisted(() => ({ enrolled: true, throws: false, code: '123456' }));
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  getStaffMfaStore: () => ({
    isEnrolled: async () => true,
    verifyCode: async (_u: string, c: string) => c === mfa.code,
  }),
  staffMfaEnrolled: async () => {
    if (mfa.throws) throw new Error('redis down');
    return mfa.enrolled;
  },
}));
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));
// A switch that makes the money paths throw a chosen Error (the error-mapping cases).
const moneyThrow = vi.hoisted(() => ({ err: null as null | Error }));
vi.mock('@/lib/dashboard-ops', async (orig) => {
  const real = await orig<typeof import('@/lib/dashboard-ops')>();
  return {
    ...real,
    releaseTransfer: (...a: Parameters<typeof real.releaseTransfer>) => (moneyThrow.err ? Promise.reject(moneyThrow.err) : real.releaseTransfer(...a)),
    rejectTransfer: (...a: Parameters<typeof real.rejectTransfer>) => (moneyThrow.err ? Promise.reject(moneyThrow.err) : real.rejectTransfer(...a)),
  };
});
// A hook that runs once, right after the FIRST listForTransfer (the action's unlocked plan read).
const afterList = vi.hoisted(() => ({ once: null as null | (() => Promise<void>) }));
vi.mock('@/db/repos/hold-review-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/hold-review-repo')>();
  return {
    ...real,
    createHoldReviewRepo: (...a: Parameters<typeof real.createHoldReviewRepo>) => {
      const repo = real.createHoldReviewRepo(...a);
      return {
        ...repo,
        listForTransfer: async (...l: Parameters<typeof repo.listForTransfer>) => {
          const rows = await repo.listForTransfer(...l);
          const hook = afterList.once;
          afterList.once = null;
          if (hook) await hook();
          return rows;
        },
      };
    },
  };
});

import { decideHoldAction } from '@/app/partner/(app)/transfers/[id]/hold-decision-actions';
import { createStore } from '@/lib/store';
import { createAuthStore } from '@/lib/auth-store';
import { createCustomerStore } from '@/lib/customer-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { staffStepUpKey } from '@/lib/staff-step-up';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { t as tr } from '@/lib/i18n';
import { rowReasonsFp } from '@/lib/hold-queue';
import { decideHold } from '@/lib/hold-decision';
import { beginHold } from '@/lib/settlement';
import { PLATFORM_RESCREEN_REFUSALS } from '@/lib/dashboard-ops';
import {
  LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON, POSSIBLE_MATCH_REASON, RECIPIENT_WATCHLIST_REASON,
} from '@/lib/compliance-config';

const realJars = new AsyncLocalStorage<Map<string, string>>();
jars.als = realJars;

const REASON = 'Checked the documents on file for this hold.';
const H = 3_600_000;
const originalList = process.env.SANCTIONS_LIST;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  host.value = 'smartremit.ai';
  staffRead.calls = 0;
  staffRead.transform = null;
  ownerRead.calls = 0;
  ownerRead.mode = 'real';
  mfa.enrolled = true;
  mfa.throws = false;
  moneyThrow.err = null;
  afterList.once = null;
  logWarnSpy.mockReset();
  pokeSpy.mockReset();
  db = await freshDb();
  store = createStore(redis, db);
});
afterEach(() => {
  afterList.once = null;
  moneyThrow.err = null;
  restoreOfacSource(originalList);
});

type Rows<T> = { rows: T[] };
const q = async <T>(s: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(s)) as unknown as Rows<T>).rows;
const n = async (s: ReturnType<typeof sql>): Promise<number> => (await q<{ n: number }>(s))[0].n;
/** Everything a decision could write (the step-up's own auth.stepup.* rows are not the decision's). */
async function snapshot() {
  return {
    statuses: await q<{ id: string; status: string }>(sql`SELECT id, status FROM transfers ORDER BY id`),
    reviews: await n(sql`SELECT count(*)::int AS n FROM hold_reviews`),
    audit: await n(sql`SELECT count(*)::int AS n FROM audit_events WHERE action NOT LIKE 'auth.stepup%'`),
    outbox: await n(sql`SELECT count(*)::int AS n FROM outbox`),
  };
}
const outboxKinds = async () => (await q<{ kind: string }>(sql`SELECT kind FROM outbox ORDER BY id`)).map((r) => r.kind);
const audits = (id: string, action: string) =>
  q<{ actor: string; meta: Record<string, unknown> }>(sql`SELECT actor, meta FROM audit_events WHERE subject_id = ${id} AND action = ${action} ORDER BY id`);
const reviewRows = (id: string) =>
  q<{ hold_class: string; step: number; final: boolean; actor: string; actor_scope: string; evidence: Record<string, unknown> }>(
    sql`SELECT * FROM hold_reviews WHERE transfer_id = ${id} ORDER BY created_at, step`,
  );
const statusOf = async (id: string) => (await store.getTransfer(id))?.status;
async function setReasons(id: string, reasons: string[]): Promise<Transfer> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
  return (await store.getTransfer(id))!;
}

interface FormOpts {
  holdClass?: string;
  disposition?: string;
  reason?: string;
  rowFp?: string | null;
  code?: string | null;
  id?: string;
  screeningFlaggedAt?: string;
}
function form(t: Pick<Transfer, 'complianceReasons'>, o: FormOpts = {}): FormData {
  const fd = new FormData();
  fd.set('holdClass', o.holdClass ?? 'kyc');
  fd.set('disposition', o.disposition ?? 'documents_verified');
  fd.set('reason', o.reason ?? REASON);
  const fp = o.rowFp === undefined ? rowReasonsFp(t.complianceReasons) : o.rowFp;
  if (fp !== null) fd.set('rowFp', fp);
  if (o.code !== null) fd.set(STEP_UP_FIELD, o.code ?? mfa.code);
  if (o.id !== undefined) fd.set('id', o.id);
  if (o.screeningFlaggedAt !== undefined) fd.set('screeningFlaggedAt', o.screeningFlaggedAt);
  return fd;
}
const decide = (id: string, fd: FormData) => {
  staffRead.calls = 0;
  ownerRead.calls = 0;
  return decideHoldAction(id, null, fd);
};
const err = (key: Parameters<typeof tr>[0]): { ok: false; error: string } => ({ ok: false, error: tr(key) });

/** Sign `username` in on the default jar (or the given one). */
async function signIn(username: string, jar: Map<string, string> = cookieJar): Promise<void> {
  jar.set(SESSION_COOKIE, await createAuthStore(redis).createSession(username));
}
/** Mark the CURRENT session as stepped up just now (the 15-minute window). */
async function markFresh(): Promise<void> {
  const token = cookieJar.get(SESSION_COOKIE)!;
  const user = await createAuthStore(redis).getSessionUser(token);
  await redis.set(staffStepUpKey(token), `${user}:${Date.now()}`, { ex: 900 });
}
/** The default queue partner 'acme' with compliance users co-a and co-b (agents), co-a signed in. */
async function queue(o: Parameters<typeof certifiedQueuePartner>[1] = {}): Promise<void> {
  await certifiedQueuePartner(db, o);
  await seedComplianceUsers(db, o.partnerId ?? 'acme', o.users ?? ['co-a', 'co-b'], { redis });
  await signIn('co-a');
}
/** A refusal that asks no step-up and writes nothing. */
async function refuses(id: string, fd: FormData, expected: { ok: false; error: string }): Promise<void> {
  const before = await snapshot();
  const r = await decide(id, fd);
  expect(isStepUpRequired(r)).toBe(false);
  expect(r).toEqual(expected);
  expect(await snapshot()).toEqual(before);
}

describe('decideHoldAction: gate order and the shared contract (P10 1-2)', { retry: 0 }, () => {
  it('runs the shared partner action checklist (gate, role, foreign id, forged tenant fields)', async () => {
    await certifiedQueuePartner(db, { partnerId: 'pa', users: ['contract-allowed'] });
    await certifiedQueuePartner(db, { partnerId: 'pb', users: [] });
    const own = await heldRowFor(db, 'pa', 'kyc', { id: 'hd_own' });
    const foreign = await heldRowFor(db, 'pb', 'kyc', { id: 'hd_foreign' });
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: (fd) => decide(String(fd.get('id')), fd),
      form: (id) => form(id === own.id ? own : foreign, { id }),
      ownId: own.id,
      foreignId: foreign.id,
      allowedRole: 'admin',
      disallowedRole: 'support',
      snapshot,
    });
    expect(await statusOf(own.id)).toBe('paid');
    expect(await statusOf(foreign.id)).toBe('in_review');
  });

  it('refuses on a partner-site host before any read; anonymous -> /login; support and finance -> /partner', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    host.value = 'acme.smartremit.ai';
    await expect(decide(t.id, form(t))).rejects.toThrow('NOT_FOUND');
    expect([staffRead.calls, ownerRead.calls]).toEqual([0, 0]);
    host.value = 'smartremit.ai';
    cookieJar.clear();
    await expect(decide(t.id, form(t))).rejects.toThrow('REDIRECT:/login');
    for (const role of ['support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `acme-${role}`, partnerId: 'acme', role });
      await expect(decide(t.id, form(t))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await statusOf(t.id)).toBe('in_review');
  });
});

describe('decideHoldAction: the owner gate (P10 3)', { retry: 0 }, () => {
  it('an owner read that throws or returns null -> notAllowed, nothing written, no step-up', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    ownerRead.mode = 'throw';
    await refuses(t.id, form(t), err('partner.holdDecision.notAllowed'));
    ownerRead.mode = 'null';
    await refuses(t.id, form(t), err('partner.holdDecision.notAllowed'));
  });

  it("certified but holdDecider 'smartremit_delegated' -> notAllowed", async () => {
    await queue({ holdDecider: 'smartremit_delegated' });
    const t = await heldRowFor(db, 'acme', 'kyc');
    await refuses(t.id, form(t), err('partner.holdDecision.notAllowed'));
  });

  it('a signed posture without certification (a demo partner) -> notAllowed', async () => {
    await queue();
    await db.execute(sql`UPDATE partners SET live_controls = live_controls - 'certification' WHERE id = 'acme'`);
    const t = await heldRowFor(db, 'acme', 'kyc');
    await refuses(t.id, form(t), err('partner.holdDecision.notAllowed'));
  });

  it('an uncertified delegated partner -> notAllowed', async () => {
    await seedPartner(db, 'acme');
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'acme'`);
    await seedComplianceUsers(db, 'acme', ['co-a'], { redis });
    await signIn('co-a');
    const t = await heldRowFor(db, 'acme', 'kyc');
    await refuses(t.id, form(t), err('partner.holdDecision.notAllowed'));
  });
});

describe('decideHoldAction: the compliance user gate (P10 4)', { retry: 0 }, () => {
  it('an admin who is not a listed compliance user -> notCompliance (even without MFA)', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await signInAs(redis, cookieJar, { username: 'acme-admin', partnerId: 'acme', role: 'admin' });
    await refuses(t.id, form(t), err('partner.holdDecision.notCompliance'));
    mfa.enrolled = false;
    await refuses(t.id, form(t), err('partner.holdDecision.notCompliance'));
  });

  it('listed but (on the fresh read) suspended, of another tenant, role finance, or the read throws -> notCompliance', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const cases: Array<(s: Staff | null) => Staff | null> = [
      (s) => ({ ...s!, status: 'suspended' }),
      (s) => ({ ...s!, partnerId: 'pb' }),
      (s) => ({ ...s!, role: 'finance' }),
      () => null,
      () => {
        throw new Error('redis down');
      },
    ];
    for (const transform of cases) {
      staffRead.transform = transform;
      await refuses(t.id, form(t), err('partner.holdDecision.notCompliance'));
    }
  });

  it('listed, MFA not enrolled -> mfaRequired; the MFA read throws -> mfaRequired (fail closed)', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    mfa.enrolled = false;
    await refuses(t.id, form(t), err('partner.holdDecision.mfaRequired'));
    mfa.enrolled = true;
    mfa.throws = true;
    await refuses(t.id, form(t), err('partner.holdDecision.mfaRequired'));
  });
});

describe('decideHoldAction: the bound route id (P10 5)', { retry: 0 }, () => {
  it('another tenant, a missing id and a junk id give the SAME notFound; a body id that differs -> notFound', async () => {
    await queue();
    await certifiedQueuePartner(db, { partnerId: 'pb', users: [] });
    const own = await heldRowFor(db, 'acme', 'kyc', { id: 'hd_a1' });
    const other = await heldRowFor(db, 'acme', 'kyc', { id: 'hd_a2' });
    const foreign = await heldRowFor(db, 'pb', 'kyc', { id: 'hd_b1' });
    const nf = err('partner.common.notFound');
    await refuses(foreign.id, form(foreign), nf);
    await refuses('tr_nope99', form(own), nf);
    await refuses("x' OR 1=1", form(own), nf);
    await refuses(own.id, form(own, { id: other.id }), nf);
  });

  it('a routed row seen by its SETTLEMENT partner -> notFound', async () => {
    await queue();
    await certifiedQueuePartner(db, { partnerId: 'pb', users: ['pb-co'] });
    await seedComplianceUsers(db, 'pb', ['pb-co'], { redis });
    const t = await heldRowFor(db, 'acme', 'kyc', { routed: 'pb' });
    await signIn('pb-co');
    await refuses(t.id, form(t), err('partner.common.notFound'));
  });
});

describe('decideHoldAction: the inputs (P10 6)', { retry: 0 }, () => {
  it('an unknown class, a disposition the partner may not give, a missing or oversized rowFp -> invalid; reason rules', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const invalid = err('partner.holdDecision.invalid');
    await refuses(t.id, form(t, { holdClass: 'nope' }), invalid);
    await refuses(t.id, form(t, { disposition: 'false_positive_match' }), invalid);
    await refuses(t.id, form(t, { disposition: 'nope' }), invalid);
    await refuses(t.id, form(t, { rowFp: null }), invalid);
    await refuses(t.id, form(t, { rowFp: '' }), invalid);
    await refuses(t.id, form(t, { rowFp: 'x'.repeat(1001) }), invalid);
    await refuses(t.id, form(t, { reason: 'too short' }), err('partner.release.reasonTooShort'));
    await refuses(t.id, form(t, { reason: 'Sender account 000011112222 is closed' }), err('partner.release.reasonHasNumber'));
  });

  it('a sender_pep release without (or with an unreadable) screeningFlaggedAt -> invalid', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const invalid = err('partner.holdDecision.invalid');
    await refuses(t.id, form(t, { holdClass: 'sender_pep', disposition: 'pep_accepted_with_edd' }), invalid);
    await refuses(t.id, form(t, { holdClass: 'sender_pep', disposition: 'pep_accepted_with_edd', screeningFlaggedAt: 'not a time' }), invalid);
  });

  it('a sender_pep release with the reviewed screeningFlaggedAt clears and releases', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const f = await q<{ at: string | Date }>(sql`SELECT screening_flagged_at AS at FROM customers WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    const at = new Date(f[0].at).toISOString();
    expect(await decide(t.id, form(t, { holdClass: 'sender_pep', disposition: 'pep_accepted_with_edd', screeningFlaggedAt: at }))).toEqual({
      ok: true,
      outcome: 'released',
    });
    expect(await statusOf(t.id)).toBe('paid');
  });
});

describe('decideHoldAction: four-eyes sender_pep release (F1, early review EA1/EB1)', { retry: 0 }, () => {
  const pepClears = () =>
    q<{ meta: Record<string, unknown> }>(sql`SELECT meta FROM audit_events WHERE action = 'customer.screening_hold.clear' ORDER BY id`);
  const clearedAt = async (phone: string) =>
    (await q<{ at: string | Date | null }>(sql`SELECT screening_cleared_at AS at FROM customers WHERE partner_id = 'acme' AND phone = ${phone}`))[0].at;
  async function pepRow() {
    await queue({ fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const f = await q<{ at: string | Date }>(sql`SELECT screening_flagged_at AS at FROM customers WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    return { t, at: new Date(f[0].at).toISOString() };
  }
  const pepForm = (t: Transfer, at: string, code: string | null) =>
    form(t, { holdClass: 'sender_pep', disposition: 'pep_accepted_with_edd', screeningFlaggedAt: at, code });

  it('co-a step 1 is recorded WITHOUT the PEP clear; co-b step 2 (with the step-up) clears, audits the clear and releases', async () => {
    const { t, at } = await pepRow();
    const before = await clearedAt(t.phone);
    expect(await decide(t.id, pepForm(t, at, null))).toEqual({ ok: true, outcome: 'awaiting_second' });
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.step, r.final, r.actor])).toEqual([['sender_pep', 1, false, 'co-a']]);
    expect(await statusOf(t.id)).toBe('in_review');
    expect(await clearedAt(t.phone)).toEqual(before);
    expect(await pepClears()).toEqual([]);
    expect(await outboxKinds()).not.toContain('settlement.instruct');

    await signIn('co-b');
    expect(isStepUpRequired(await decide(t.id, pepForm(t, at, null)))).toBe(true);
    expect(await reviewRows(t.id)).toHaveLength(1);
    expect(await decide(t.id, pepForm(t, at, mfa.code))).toEqual({ ok: true, outcome: 'released' });
    expect((await reviewRows(t.id)).map((r) => [r.step, r.final, r.actor])).toEqual([[1, false, 'co-a'], [2, true, 'co-b']]);
    expect(await statusOf(t.id)).toBe('paid');
    expect(await clearedAt(t.phone)).not.toBeNull();
    const clears = await pepClears();
    expect(clears).toHaveLength(1);
    expect(clears[0].meta).toMatchObject({ via: 'hold_review', transferId: t.id, actorScope: 'partner', pepHit: true });
  });

  it('co-a may not be step 2 too (sameActor, nothing written, no clear)', async () => {
    const { t, at } = await pepRow();
    expect(await decide(t.id, pepForm(t, at, null))).toEqual({ ok: true, outcome: 'awaiting_second' });
    await refuses(t.id, pepForm(t, at, mfa.code), err('partner.holdDecision.sameActor'));
    expect(await pepClears()).toEqual([]);
    expect(await statusOf(t.id)).toBe('in_review');
  });
});

describe('decideHoldAction: the plan refusals, before any step-up (P10 7)', { retry: 0 }, () => {
  it('a stale rowFp -> changed', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await refuses(t.id, form(t, { rowFp: 'v1|stale', code: null }), err('partner.holdDecision.changed'));
  });

  it('a platform-decided class -> notYours', async () => {
    await queue({ kycMode: 'ours' });
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    await refuses(t.id, form(t, { holdClass: 'sender_pep', disposition: 'pep_rejected', code: null }), err('partner.holdDecision.notYours'));
  });

  it('list_wait -> waitsList; data_missing -> waitsData; a partner reject with a platform class open -> waitsPlatform; blocked -> notAllowed', async () => {
    await queue();
    const a = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'hd_list' })).id, [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    await refuses(a.id, form(a, { code: null }), err('partner.holdDecision.waitsList'));
    const b = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'hd_plat' })).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    await refuses(b.id, form(b, { disposition: 'customer_not_verified', code: null }), err('partner.holdDecision.waitsPlatform'));
    const c = await setReasons((await heldRowFor(db, 'acme', 'blocked', { id: 'hd_blk' })).id, [LARGE_AMOUNT_REASON, RECIPIENT_WATCHLIST_REASON]);
    await refuses(c.id, form(c, { code: null }), err('partner.holdDecision.notAllowed'));
    const d = await setReasons((await heldRowFor(db, 'acme', 'data_missing', { id: 'hd_data' })).id, [LARGE_AMOUNT_REASON, ORIGINATOR_INFO_MISSING_REASON]);
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${d.phone}`);
    await refuses(d.id, form(d, { code: null }), err('partner.holdDecision.waitsData'));
  });

  it('a class already closed -> closed', async () => {
    await queue();
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await decide(t.id, form(t))).toEqual({ ok: true, outcome: 'recorded' });
    await signIn('co-b');
    await refuses(t.id, form(t, { code: null }), err('partner.holdDecision.closed'));
  });

  it("the same user's second step -> sameActor", async () => {
    await queue({ fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decide(t.id, form(t, { code: null }))).toEqual({ ok: true, outcome: 'awaiting_second' });
    await refuses(t.id, form(t, { code: null }), err('partner.holdDecision.sameActor'));
  });
});

describe('decideHoldAction: the step-up and the decision (P10 8-10)', { retry: 0 }, () => {
  it('fourEyes false, a final release: the step-up is asked even on a fresh session; with the code: released in one transaction', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await markFresh();
    const before = await snapshot();
    const r = await decide(t.id, form(t, { code: null }));
    expect(isStepUpRequired(r)).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(pokeSpy).not.toHaveBeenCalled();

    expect(await decide(t.id, form(t))).toEqual({ ok: true, outcome: 'released' });
    expect(await statusOf(t.id)).toBe('paid');
    expect(await reviewRows(t.id)).toEqual([expect.objectContaining({ hold_class: 'kyc', final: true, actor: 'co-a', actor_scope: 'partner' })]);
    const rel = await audits(t.id, 'transfer.release');
    expect(rel).toHaveLength(1);
    expect(rel[0].actor).toBe('co-a');
    expect(rel[0].meta).toMatchObject({ actorScope: 'partner', holdClass: 'kyc', reason: REASON });
    expect(await outboxKinds()).toContain('settlement.instruct');
    expect(pokeSpy).toHaveBeenCalled();
    expect(revalidated).toEqual(expect.arrayContaining([`/partner/transfers/${t.id}`, '/partner/reviews']));
  });

  it('fourEyes true: step 1 needs no step-up (awaiting_second); co-a again -> sameActor; co-b is asked, then released', async () => {
    await queue({ fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decide(t.id, form(t, { code: null }))).toEqual({ ok: true, outcome: 'awaiting_second' });
    expect(await statusOf(t.id)).toBe('in_review');
    await refuses(t.id, form(t), err('partner.holdDecision.sameActor'));
    await signIn('co-b');
    expect(isStepUpRequired(await decide(t.id, form(t, { code: null })))).toBe(true);
    expect(await reviewRows(t.id)).toHaveLength(1);
    expect(await decide(t.id, form(t))).toEqual({ ok: true, outcome: 'released' });
    expect((await reviewRows(t.id)).map((r) => [r.step, r.final, r.actor])).toEqual([[1, false, 'co-a'], [2, true, 'co-b']]);
    expect(await statusOf(t.id)).toBe('paid');
  });

  it('a reject (customer_not_verified): asked, then rejected; cancelled; a charged row gets one funding.refund', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc', { fundingProvider: 'mock', fundingRef: 'mock_pi_hd_reject' });
    expect(isStepUpRequired(await decide(t.id, form(t, { disposition: 'customer_not_verified', code: null })))).toBe(true);
    expect(await decide(t.id, form(t, { disposition: 'customer_not_verified' }))).toEqual({ ok: true, outcome: 'rejected' });
    expect(await statusOf(t.id)).toBe('cancelled');
    expect((await outboxKinds()).filter((k) => k === 'funding.refund')).toHaveLength(1);
    expect(await audits(t.id, 'transfer.reject')).toHaveLength(1);
  });

  it('a mixed row (kyc + sanctions_review): the partner kyc release is recorded, still in_review, no rail row', async () => {
    await queue();
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await decide(t.id, form(t))).toEqual({ ok: true, outcome: 'recorded' });
    expect(await statusOf(t.id)).toBe('in_review');
    expect(await outboxKinds()).not.toContain('settlement.instruct');
    expect(await reviewRows(t.id)).toHaveLength(1);
  });

  it('two concurrent final submits by co-a and co-b: exactly one releases; the other is changed or notAllowed', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const jarA = new Map<string, string>();
    const jarB = new Map<string, string>();
    await signIn('co-a', jarA);
    await signIn('co-b', jarB);
    const [ra, rb] = await Promise.all([
      realJars.run(jarA, () => decideHoldAction(t.id, null, form(t))),
      realJars.run(jarB, () => decideHoldAction(t.id, null, form(t))),
    ]);
    const results = [ra, rb];
    expect(results.filter((r) => 'ok' in r && r.ok)).toEqual([{ ok: true, outcome: 'released' }]);
    const loser = results.find((r) => !r.ok);
    expect([err('partner.holdDecision.changed'), err('partner.holdDecision.notAllowed'), err('partner.holdDecision.closed')]).toContainEqual(loser);
    expect(await audits(t.id, 'transfer.release')).toHaveLength(1);
    expect(await reviewRows(t.id)).toHaveLength(1);
    expect(await statusOf(t.id)).toBe('paid');
  });

  it("R6: a plan made at step 1 (non-final) while another user's step 1 commits first -> changed, no row of co-a", async () => {
    await queue({ fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    afterList.once = async () => {
      const r = await decideHold(db, store, {
        transferId: t.id, ownerId: 'acme', holdClass: 'kyc', rowFp: rowReasonsFp(t.complianceReasons), disposition: 'documents_verified',
        reason: REASON, actor: 'co-b', actorScope: 'partner', evidence: {}, expectFinal: false,
      });
      expect(r).toEqual({ outcome: 'awaiting_second' });
    };
    expect(await decide(t.id, form(t, { code: null }))).toEqual(err('partner.holdDecision.changed'));
    expect((await reviewRows(t.id)).map((r) => r.actor)).toEqual(['co-b']);
  });

  it('R1 a: a LARGE row whose sender got a watchlist stamp after the hold: the reject waits for the platform; the kyc release is recorded', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    await refuses(t.id, form(t, { disposition: 'customer_not_verified', code: null }), err('partner.holdDecision.waitsPlatform'));
    expect(await decide(t.id, form(t))).toEqual({ ok: true, outcome: 'recorded' });
    expect(await statusOf(t.id)).toBe('in_review');
  });

  it('the evidence column holds only ids, versions, scores and enums', async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decide(t.id, form(t))).toEqual({ ok: true, outcome: 'released' });
    const ev = (await reviewRows(t.id))[0].evidence;
    expect(ev).toMatchObject({ listSource: 'ofac-sdn', listVersion: 'test-version' });
    const allowed = ['listSource', 'listVersion', 'screenedAt', 'maxScore', 'matchedEntryIds', 'amlKinds', 'amlRules', 'riskSignals', 'scamCategory'];
    for (const [k, v] of Object.entries(ev)) {
      expect(allowed).toContain(k);
      const values = Array.isArray(v) ? v : [v];
      for (const x of values) {
        if (typeof x === 'number') continue;
        expect(typeof x).toBe('string');
        expect(x as string).toMatch(/^[A-Za-z0-9._:#/+-]{1,128}$/);
      }
    }
    const text = JSON.stringify(ev);
    for (const leak of [REASON, t.phone, t.recipientName, 'Test Sender Placeholder']) expect(text).not.toContain(leak);
  });
});

describe('decideHoldAction: the error mapping (P10 9)', { retry: 0 }, () => {
  const partnerLogs = () => logWarnSpy.mock.calls.filter((c) => c[0] === 'partner.hold-decide');

  it('the identity refusal -> holdIdentity; the originator refusal -> holdOriginator (nothing written)', async () => {
    await queue();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'hd_ident' });
    await db.execute(sql`UPDATE transfers SET recipient_legal_name_enc = NULL WHERE id = ${a.id}`);
    let before = await snapshot();
    expect(await decide(a.id, form(a))).toEqual(err('partner.transfers.holdIdentity'));
    expect(await snapshot()).toEqual(before);

    const b = await heldRowFor(db, 'acme', 'kyc', { id: 'hd_orig' });
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${b.phone}`);
    before = await snapshot();
    expect(await decide(b.id, form(b))).toEqual(err('partner.transfers.holdOriginator'));
    expect(await snapshot()).toEqual(before);
    expect(partnerLogs()).toHaveLength(0);
  });

  it("any 'Cannot release' / 'Cannot reject' -> notAllowed; an unexpected throw -> failed and ONE logWarn of the error name", async () => {
    await queue();
    const t = await heldRowFor(db, 'acme', 'kyc');
    moneyThrow.err = new Error('Cannot release: transfer is not in_review (it moved concurrently)');
    expect(await decide(t.id, form(t))).toEqual(err('partner.holdDecision.notAllowed'));
    moneyThrow.err = new Error('Cannot reject: transfer is not in_review');
    expect(await decide(t.id, form(t, { disposition: 'customer_not_verified' }))).toEqual(err('partner.holdDecision.notAllowed'));
    expect(partnerLogs()).toHaveLength(0);
    moneyThrow.err = new TypeError(`boom ${t.phone} ${REASON}`);
    expect(await decide(t.id, form(t))).toEqual(err('partner.common.failed'));
    expect(partnerLogs()).toEqual([['partner.hold-decide', 'TypeError', { transferId: t.id }]]);
    const logged = JSON.stringify(logWarnSpy.mock.calls);
    for (const leak of [REASON, t.phone, 'boom']) expect(logged).not.toContain(leak);
    expect(await statusOf(t.id)).toBe('in_review');
  });

  describe('M13: the platform re-screen at release (newest screen older than 36 h)', () => {
    const SENDER_PHONE = '15551230000';
    async function heldStale(id: string, recipientName: string): Promise<Transfer> {
      const nowIso = new Date().toISOString();
      await createCustomerStore(db, store).saveCustomer({
        senderPhone: SENDER_PHONE, firstSeenAt: nowIso, kycStatus: 'verified', fullName: 'Alex Sender',
        senderCountry: 'US', partnerId: 'acme', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
      });
      await seedOriginatorForTest(db, 'acme', SENDER_PHONE, { address: true, dob: true });
      const t = {
        id, phone: SENDER_PHONE, amountUsd: 1500, feeUsd: 5, totalChargeUsd: 1505, fxRate: 83, amountInr: 124500,
        recipientName, recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234',
        fundingMethod: 'bank_transfer', status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
        createdAt: new Date(Date.now() - 41 * H).toISOString(), partnerId: 'acme', environment: 'live',
        sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
        amountSource: 1500, feeSource: 5, totalChargeSource: 1505, recipientLegalName: `${recipientName} Legal`,
      } as Transfer;
      await store.saveTransfer(t);
      await seedLiveEvidence(db, { id, partnerId: 'acme', recipientName, senderName: 'Alex Sender' }, { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) });
      expect(await beginHold(db, t, { addReasons: [LARGE_AMOUNT_REASON] })).toEqual({ kind: 'held' });
      return (await store.getTransfer(id))!;
    }
    void PLATFORM_RESCREEN_REFUSALS; // the three texts the cases below map (dashboard-ops.ts)

    it('the list is not live -> waitsList', async () => {
      primeOfacSource({ checkedAgoMs: 40 * H });
      await queue();
      const t = await heldStale('hd_rs_list', 'Anita');
      expect(await decide(t.id, form(t))).toEqual(err('partner.holdDecision.waitsList'));
      expect(await statusOf(t.id)).toBe('in_review');
      expect(await reviewRows(t.id)).toHaveLength(0);
      expect(partnerLogs()).toHaveLength(0);
    });

    it('the re-screen holds again (a possible match) -> changed', async () => {
      primeOfacSource({ checkedAgoMs: H });
      await queue();
      const t = await heldStale('hd_rs_review', 'Banco Ejemplo Nacionel');
      expect(await decide(t.id, form(t))).toEqual(err('partner.holdDecision.changed'));
      expect(await reviewRows(t.id)).toHaveLength(0);
      expect(partnerLogs()).toHaveLength(0);
    });

    it('the re-screen blocks (a match) -> changed', async () => {
      primeOfacSource({ checkedAgoMs: H });
      await queue();
      const t = await heldStale('hd_rs_block', 'Testa Fixturelli');
      expect(await decide(t.id, form(t))).toEqual(err('partner.holdDecision.changed'));
      expect((await store.getTransfer(t.id))?.complianceStatus).toBe('blocked');
      expect(await reviewRows(t.id)).toHaveLength(0);
      expect(partnerLogs()).toHaveLength(0);
    });
  });
});
