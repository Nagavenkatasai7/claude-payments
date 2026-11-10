import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { LiveReadiness, LiveReadinessFacts } from '@/lib/live-certification';
import type { Staff } from '@/lib/types';

// Fix pack 3 T10 (R15, R13; contract 12): the platform live-money actions on the admin partner
// page (certify, revoke, contract, counsel). Order: the site-host guard, requirePlatformAdmin, the
// ROUTE partner ('default' / unknown -> 'Partner not found.'), the actor's own staff MFA, the input,
// (certify) the readiness facts on the ROOT handle BEFORE any transaction, the step-up (always for
// certify and revoke), ONE transaction, a poke. The auth store is the REAL one here (Redis + the
// staff ledger on the same PGlite db), so a root-handle read inside the certify transaction would
// hang the single PGlite connection.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
const staffMfa = vi.hoisted(() => ({ enrolled: new Set<string>(), code: '123456' }));
const gate = vi.hoisted(() => ({ bypass: false, calls: [] as string[] }));
const seq = vi.hoisted(() => ({ events: [] as string[] }));
const readinessHook = vi.hoisted(() => ({ mode: 'real' as 'real' | 'ok' | 'notBuiltPass' }));
const factsHook = vi.hoisted(() => ({
  firstArgs: [] as unknown[],
  throws: false,
  override: null as null | ((partnerId: string) => Promise<LiveReadinessFacts>),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host, 'x-forwarded-for': '203.0.113.7' }),
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
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  getStaffMfaStore: () => ({
    isEnrolled: async (u: string) => staffMfa.enrolled.has(u),
    verifyCode: async (_u: string, c: string) => c === staffMfa.code,
  }),
  // The module's own staffMfaEnrolled reads its local getStaffMfaStore, so it is mocked on the same set.
  staffMfaEnrolled: async (u: string) => staffMfa.enrolled.has(u),
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-step-up-gate')>();
  return {
    ...actual,
    gateStaffStepUp: async (...a: Parameters<typeof actual.gateStaffStepUp>) => {
      gate.calls.push(a[2]);
      return gate.bypass ? null : actual.gateStaffStepUp(...a);
    },
  };
});
vi.mock('@/lib/sanctions/list-health', async (orig) => ({
  ...(await orig<typeof import('@/lib/sanctions/list-health')>()),
  sanctionsListFitnessNow: async () => 'live' as const,
}));
vi.mock('@/lib/live-certification', async (orig) => {
  const actual = await orig<typeof import('@/lib/live-certification')>();
  return {
    ...actual,
    liveReadiness: (...a: Parameters<typeof actual.liveReadiness>): LiveReadiness => {
      const r = actual.liveReadiness(...a);
      if (readinessHook.mode === 'ok') return { ok: true, lines: r.lines.map((l) => ({ ...l, state: 'pass' as const, ok: true })) };
      if (readinessHook.mode === 'notBuiltPass') {
        const lines = r.lines.map((l) => (l.state === 'not_built' ? { ...l, ok: true } : l));
        return { ok: lines.every((l) => l.ok), lines };
      }
      return r;
    },
  };
});
vi.mock('@/db/repos/live-certification-facts', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/live-certification-facts')>();
  return {
    ...actual,
    loadLiveReadinessFacts: async (...a: Parameters<typeof actual.loadLiveReadinessFacts>) => {
      factsHook.firstArgs.push(a[0]);
      seq.events.push('facts');
      if (factsHook.throws) throw new Error('facts down');
      if (factsHook.override) return factsHook.override(a[1]);
      return actual.loadLiveReadinessFacts(...a);
    },
  };
});
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));

import { updateLiveControlsKey } from '@/db/repos/partner-repo';
import { partnerGoLive } from '@/db/schema';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { getAuthStore } from '@/lib/auth-store';
import {
  certifyLiveAction,
  recordContractAction,
  recordCounselAction,
  revokeLiveAction,
} from '@/app/admin-dashboard/partners/go-live-actions';

const REASON = 'Every readiness line was reviewed today';
const USERS = ['acme-c1', 'acme-c2'];
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
const snapshot = async () =>
  JSON.stringify({
    lc: await rows(sql`SELECT id, live_controls FROM partners ORDER BY id`),
    audit: await rows(sql`SELECT id, action, partner_id FROM audit_events WHERE action <> 'auth.stepup' ORDER BY id`),
    outbox: await rows(sql`SELECT id FROM outbox ORDER BY id`),
  });
const liveAudits = () => rows<{ action: string; actor: string; meta: Record<string, unknown> }>(sql`SELECT action, actor, meta FROM audit_events WHERE action LIKE 'partner.live.%' ORDER BY id`);
const lcOf = async (id = 'acme') => (await rows<{ lc: Record<string, unknown> }>(sql`SELECT live_controls AS lc FROM partners WHERE id = ${id}`))[0].lc;
const platformAdmin = async (username = 'ops-admin'): Promise<Staff> => {
  staffMfa.enrolled.add(username);
  return signInAs(redis, cookieJar, { username, partnerId: undefined, role: 'admin' });
};
const certifyForm = (o: Record<string, string> = {}) => form({ reason: REASON, ...o });
const contractForm = (o: Record<string, string> = {}) => form({ ref: 'MSA-ACME-2026', signedOn: today(), ...o });
const counselForm = (o: Record<string, string> = {}) => form({ capability: 'b2b', counselRef: 'COUNSEL-B2B-1', ...o });
const ALL = [
  ['certify', certifyLiveAction, certifyForm],
  ['revoke', revokeLiveAction, certifyForm],
  ['contract', recordContractAction, contractForm],
  ['counsel', recordCounselAction, counselForm],
] as const;

/** Every built line ready on 'acme' (posture, contract, two listed users) and facts that pass. */
async function readyAcme(): Promise<void> {
  const now = new Date().toISOString();
  await updateLiveControlsKey(
    'acme',
    'posture',
    { version: 1, signedBy: 'acme-admin', signedAt: now, kycDecider: 'smartremit_procedures', holdDecider: 'partner', requireKycBeforeSend: true, fourEyesNonSanctions: true },
    db,
  );
  await updateLiveControlsKey('acme', 'contract', { ref: 'MSA-1', signedOn: today(), recordedBy: 'ops-admin', recordedAt: now }, db);
  await updateLiveControlsKey('acme', 'complianceUsers', USERS, db);
}
const passingFacts = (): LiveReadinessFacts => ({
  goLiveApproved: true,
  listFitness: 'live',
  ownWhatsapp: true,
  complianceStaff: USERS.map((username) => ({ username, partnerId: 'acme', role: 'admin' as const, active: true, mfaEnrolled: true })),
});

let txSpy: { mockRestore: () => void } | null = null;
afterEach(() => {
  txSpy?.mockRestore(); // freshDb may hand back the same db object: never stack wrappers
  txSpy = null;
});

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  pokeSpy.mockClear();
  staffMfa.enrolled = new Set();
  gate.bypass = true;
  gate.calls = [];
  seq.events = [];
  readinessHook.mode = 'real';
  factsHook.firstArgs = [];
  factsHook.throws = false;
  factsHook.override = null;
  db = await freshDb();
  await seedPartner(db, 'acme', 'Acme');
  const tx = db.transaction.bind(db);
  txSpy = vi.spyOn(db, 'transaction').mockImplementation(((...a: Parameters<Db['transaction']>) => {
    seq.events.push('tx');
    return tx(...a);
  }) as Db['transaction']);
});

describe('platform live actions: gates', () => {
  it('a site host is refused (404) before the gate, nothing written', async () => {
    await platformAdmin();
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    for (const [, action, f] of ALL) await expect(action('acme', f())).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('partner-scoped admin, agent, support -> redirected, nothing written', async () => {
    const before = await snapshot();
    for (const o of [
      { username: 'acme-admin', role: 'admin' as const, partnerId: 'acme' },
      { username: 'ops-agent', role: 'agent' as const },
      { username: 'ops-support', role: 'support' as const },
    ]) {
      staffMfa.enrolled.add(o.username);
      await signInAs(redis, cookieJar, { partnerId: undefined, ...o });
      for (const [, action, f] of ALL) await expect(action('acme', f())).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it("'default' or an unknown id -> 'Partner not found.', nothing written (all four)", async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    const before = await snapshot();
    for (const [, action, f] of ALL) {
      for (const id of ['default', 'nobody', '', '  ']) expect(await action(id, f())).toEqual({ ok: false, error: 'Partner not found.' });
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
    expect(factsHook.firstArgs).toEqual([]);
  });

  it('the route id is the only target: a forged partnerId / id field is never read', async () => {
    await platformAdmin();
    await seedPartner(db, 'globex');
    expect(await recordContractAction('acme', contractForm({ id: 'globex', partnerId: 'globex' }))).toEqual({ ok: true });
    expect((await lcOf('acme')).contract).toMatchObject({ ref: 'MSA-ACME-2026' });
    expect((await lcOf('globex')).contract).toBeUndefined();
  });

  it('no own MFA -> refused before the step-up (spy not called), nothing written', async () => {
    await signInAs(redis, cookieJar, { username: 'ops-admin', partnerId: undefined, role: 'admin' });
    const before = await snapshot();
    for (const [, action, f] of ALL) {
      expect(await action('acme', f())).toEqual({ ok: false, error: 'Turn on two-step verification for your own staff account first.' });
    }
    expect(gate.calls).toEqual([]);
    expect(factsHook.firstArgs).toEqual([]);
    expect(await snapshot()).toBe(before);
  });
});

describe('platform live actions: step-up', () => {
  beforeEach(() => {
    gate.bypass = false;
  });

  it('certify and revoke ask for the code even right after a step-up (always)', async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    expect(await recordContractAction('acme', contractForm({ [STEP_UP_FIELD]: staffMfa.code }))).toEqual({ ok: true });
    const before = await snapshot();
    expect(isStepUpRequired(await certifyLiveAction('acme', certifyForm()))).toBe(true);
    expect(isStepUpRequired(await revokeLiveAction('acme', certifyForm()))).toBe(true);
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual(['live.contract', 'live.certify', 'live.revoke']);
    // With the code, certify goes through.
    expect(await certifyLiveAction('acme', certifyForm({ [STEP_UP_FIELD]: staffMfa.code }))).toEqual({ ok: true });
  });

  it('contract and counsel accept a fresh step-up', async () => {
    await platformAdmin();
    expect(isStepUpRequired(await recordCounselAction('acme', counselForm()))).toBe(true);
    expect(await recordCounselAction('acme', counselForm({ [STEP_UP_FIELD]: staffMfa.code }))).toEqual({ ok: true });
    expect(await recordContractAction('acme', contractForm())).toEqual({ ok: true });
    expect(await recordCounselAction('acme', counselForm({ capability: 'usdc' }))).toEqual({ ok: true });
    expect(gate.calls).toEqual(['optin.counsel', 'optin.counsel', 'live.contract', 'optin.counsel']);
  });
});

describe('certifyLiveAction', () => {
  it('pack 3: not_ready (no record, no audit, no poke), even with every built line passing', async () => {
    await platformAdmin();
    await readyAcme();
    factsHook.override = async () => passingFacts();
    const before = await snapshot();
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: false, error: 'Not every readiness line passes. Nothing was changed.' });
    expect(await snapshot()).toBe(before);
    expect((await lcOf()).certification).toBeUndefined();
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('with liveReadiness stubbed ok -> certified, one audit, one poke', async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: true });
    expect((await lcOf()).certification).toMatchObject({ certifiedBy: 'ops-admin' });
    const a = await liveAudits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'partner.live.certify', actor: 'ops-admin' });
    expect(a[0].meta).toMatchObject({ reason: REASON, actorScope: 'platform' });
    expect(pokeSpy).toHaveBeenCalledTimes(1);
    expect(gate.calls).toEqual(['live.certify']);
  });

  it('the facts loader throws -> refused, nothing written, no step-up asked', async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    factsHook.throws = true;
    const before = await snapshot();
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: false, error: 'The readiness checks could not be read. Nothing was changed.' });
    expect(gate.calls).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(seq.events).toEqual(['facts']);
  });

  it('the facts loader is never called with a tx handle: its first argument is the root db, before db.transaction', async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    factsHook.override = async () => passingFacts(); // no reads of its own, so the only tx is the action's
    seq.events = [];
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: true });
    expect(factsHook.firstArgs).toHaveLength(1);
    expect(factsHook.firstArgs[0]).toBe(db);
    expect(seq.events).toEqual(['facts', 'tx']);
  });

  it('two listed compliance users, the REAL facts loader and the staff ledger on the same PGlite db: completes without hanging', { timeout: 10_000 }, async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    for (const username of USERS) {
      await getAuthStore().saveStaff({
        username,
        name: username,
        role: 'admin',
        partnerId: 'acme',
        permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
        passwordHash: 'x',
        createdAt: new Date().toISOString(),
      });
      staffMfa.enrolled.add(username);
    }
    await readyAcme();
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: true });
    expect((await lcOf()).certification).toMatchObject({ certifiedBy: 'ops-admin' });
  });

  it('readiness is recomputed on the LOCKED row: every line passes (not-built lines stubbed) -> certified', async () => {
    await platformAdmin();
    readinessHook.mode = 'notBuiltPass';
    await readyAcme();
    factsHook.override = async () => passingFacts();
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: true });
  });

  it('a compliance user removed between the facts read and the lock -> not_ready, nothing written', async () => {
    await platformAdmin();
    readinessHook.mode = 'notBuiltPass';
    await readyAcme();
    factsHook.override = async () => {
      const f = passingFacts();
      await updateLiveControlsKey('acme', 'complianceUsers', ['acme-c1'], db);
      return f;
    };
    const res = certifyLiveAction('acme', certifyForm());
    expect(await res).toEqual({ ok: false, error: 'Not every readiness line passes. Nothing was changed.' });
    expect((await lcOf()).certification).toBeUndefined();
    expect(await liveAudits()).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('a partner suspended between the facts read and the lock -> not_ready on the locked row', async () => {
    await platformAdmin();
    readinessHook.mode = 'notBuiltPass';
    await readyAcme();
    await db.insert(partnerGoLive).values({ partnerId: 'acme', requestedAt: new Date(), requestedBy: 'acme-admin', approvedAt: new Date(), approvedBy: 'ops' });
    factsHook.override = async () => {
      await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'acme'`);
      return passingFacts();
    };
    expect(await certifyLiveAction('acme', certifyForm())).toEqual({ ok: false, error: 'Not every readiness line passes. Nothing was changed.' });
  });

  it('a short reason on certify / revoke -> refused before the step-up and the facts', async () => {
    await platformAdmin();
    readinessHook.mode = 'ok';
    const before = await snapshot();
    for (const action of [certifyLiveAction, revokeLiveAction]) {
      const r = (await action('acme', form({ reason: 'too short' }))) as { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/reason/i);
      const r2 = (await action('acme', form())) as { ok: boolean; error: string };
      expect(r2.ok).toBe(false);
    }
    expect(gate.calls).toEqual([]);
    expect(factsHook.firstArgs).toEqual([]);
    expect(await snapshot()).toBe(before);
  });
});

describe('revokeLiveAction', () => {
  it('revoke a certified partner -> revoked, one audit, one poke', async () => {
    await platformAdmin();
    await certifyPartnerForTest(db, 'acme');
    expect(await revokeLiveAction('acme', certifyForm())).toEqual({ ok: true });
    expect((await lcOf()).certification).toMatchObject({ certifiedBy: 'test-admin', revokedBy: 'ops-admin' });
    const a = await liveAudits();
    expect(a.map((r) => r.action)).toEqual(['partner.live.revoke']);
    expect(a[0].meta).toEqual({ reason: REASON, actorScope: 'platform' });
    expect(pokeSpy).toHaveBeenCalledTimes(1);
    expect(factsHook.firstArgs).toEqual([]); // revoke never needs readiness
  });

  it("revoke an uncertified one -> 'This partner is not certified.', nothing written", async () => {
    await platformAdmin();
    const before = await snapshot();
    expect(await revokeLiveAction('acme', certifyForm())).toEqual({ ok: false, error: 'This partner is not certified.' });
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
  });
});

describe('recordContractAction', () => {
  it('empty ref, a bad date or a date after today (UTC) -> refused before the step-up', async () => {
    await platformAdmin();
    const before = await snapshot();
    for (const o of [{ ref: '' }, { ref: '   ' }, { ref: 'x'.repeat(201) }, { signedOn: '2026-02-30' }, { signedOn: 'soon' }, { signedOn: tomorrow() }] as Record<string, string>[]) {
      const r = (await recordContractAction('acme', contractForm(o))) as { ok: boolean };
      expect(r.ok, JSON.stringify(o)).toBe(false);
    }
    expect(gate.calls).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('ok -> recorded (one audit, one poke), the ref only in live_controls', async () => {
    await platformAdmin();
    expect(await recordContractAction('acme', contractForm())).toEqual({ ok: true });
    expect((await lcOf()).contract).toMatchObject({ ref: 'MSA-ACME-2026', signedOn: today(), recordedBy: 'ops-admin' });
    const a = await liveAudits();
    expect(a.map((r) => r.action)).toEqual(['partner.live.contract.record']);
    expect(JSON.stringify(a)).not.toContain('MSA-ACME');
    expect(JSON.stringify(await rows(sql`SELECT payload FROM outbox`))).not.toContain('MSA-ACME');
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('recordCounselAction', () => {
  it('an unknown capability or a missing ref -> refused before the step-up', async () => {
    await platformAdmin();
    const before = await snapshot();
    for (const o of [{ capability: 'routing' }, { capability: '' }, { counselRef: '' }, { counselRef: 'x'.repeat(201) }] as Record<string, string>[]) {
      const r = (await recordCounselAction('acme', counselForm(o))) as { ok: boolean };
      expect(r.ok, JSON.stringify(o)).toBe(false);
    }
    expect(gate.calls).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('set then clear', async () => {
    await platformAdmin();
    expect(await recordCounselAction('acme', counselForm())).toEqual({ ok: true });
    expect(((await lcOf()).optIns as Record<string, unknown>).b2b).toMatchObject({ counselRef: 'COUNSEL-B2B-1', counselBy: 'ops-admin' });
    expect(await recordCounselAction('acme', form({ capability: 'b2b', clear: '1' }))).toEqual({ ok: true });
    expect(((await lcOf()).optIns as Record<string, unknown>).b2b).toBeUndefined();
    const a = await liveAudits();
    expect(a.map((r) => r.meta)).toEqual([
      { capability: 'b2b', set: true, actorScope: 'platform' },
      { capability: 'b2b', set: false, actorScope: 'platform' },
    ]);
    expect(pokeSpy).toHaveBeenCalledTimes(2);
  });
});
