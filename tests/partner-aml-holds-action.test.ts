import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';

// Fix pack 6 T19 (P17, P21, P23): the partner's AML hold-rule writer on /partner/settings,
// setAmlHoldRulesAction. Real gate (requirePartnerStaff over the real auth store on a fake Redis),
// real step-up (TOTP factor, the MFA store mocked as in tests/partner-settings-actions.test.ts),
// real writer on PGlite. Order: site host -> admin gate -> two-step sign-in -> step-up on EVERY
// save -> parse -> default tenant -> one transaction (row-locked corridor write + audit row +
// the live notice on a certified partner) -> poke.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value, 'x-forwarded-for': '203.0.113.7' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
// The action's enrolled read and the step-up's factor read agree on one flag (TOTP when enrolled).
const mfa = vi.hoisted(() => ({ enrolled: true, code: '123456' }));
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  getStaffMfaStore: () => ({
    isEnrolled: async () => mfa.enrolled,
    verifyCode: async (_u: string, c: string) => c === mfa.code,
  }),
  staffMfaEnrolled: async () => mfa.enrolled,
}));
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { staffStepUpKey } from '@/lib/staff-step-up';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { auditEvents, partners } from '@/db/schema';
import { t } from '@/lib/i18n';
import { createPartnerStore } from '@/lib/partner-store';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { CorridorComplianceRule, CountryCode } from '@/lib/types';

type CorridorComplianceMap = Partial<Record<CountryCode, CorridorComplianceRule>>;
import { PARTNER_ROUTES } from '@/app/partner/routes';
import { setAmlHoldRulesAction } from '@/app/partner/(app)/settings/actions';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALL = ['structuring', 'first_transfer', 'new_beneficiary'];

function form(country: string | null, rules: readonly string[] = [], code: string | null = mfa.code): FormData {
  const f = new FormData();
  if (country !== null) f.set('country', country);
  for (const r of rules) f.append('rules', r);
  if (code !== null) f.set(STEP_UP_FIELD, code);
  return f;
}
const save = (fd: FormData) => setAmlHoldRulesAction(null, fd);

async function signInAdmin(partnerId = 'pa', username = 'pa-admin'): Promise<void> {
  await signInAs(redis, cookieJar, { username, partnerId, role: 'admin' });
}
/** Mark the CURRENT cookie's session as stepped up just now. */
async function freshen(): Promise<void> {
  const token = cookieJar.get(SESSION_COOKIE)!;
  const user = await getAuthStore().getSessionUser(token);
  await redis.set(staffStepUpKey(token), `${user}:${Date.now()}`, { ex: 900 });
}

const cc = async (id: string) =>
  (await db.select({ c: partners.corridorCompliance }).from(partners).where(eq(partners.id, id)))[0]?.c as CorridorComplianceMap | null;
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const ruleAudits = async () => (await audits()).filter((r) => r.action === 'aml.hold_rules_set');
const outboxRows = async () =>
  (await db.execute(sql`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`)).rows as Array<{ kind: string; payload: Record<string, unknown>; dedupe_key: string }>;
/** Everything the writer could change (the step-up's own auth.stepup rows are not the writer's). */
const snapshot = async () => ({
  a: await cc('pa'),
  b: await cc('pb'),
  d: await cc(DEFAULT_PARTNER_ID),
  writes: (await audits()).filter((r) => !r.action.startsWith('auth.stepup')).length,
  outbox: (await outboxRows()).length,
});

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  mfa.enrolled = true;
  revalidatePath.mockClear();
  logWarnSpy.mockClear();
  pokeSpy.mockClear();
  db = await freshDb();
  await seedTwoTenants(db);
  await db.update(partners).set({ countries: ['US', 'GB'] }).where(eq(partners.id, 'pa'));
  await db.update(partners).set({ corridorCompliance: { US: { amlHolds: true, largeAmountUsd: 900 } } }).where(eq(partners.id, 'pb'));
});

describe('setAmlHoldRulesAction: gates', () => {
  it('the shared contract (tenant-only)', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: save,
      form: (id) => {
        const fd = form('US', id === 'pa' ? ['structuring'] : ['first_transfer']);
        fd.set('id', id);
        fd.set('partnerId', id);
        return fd;
      },
      ownId: 'pa',
      foreignId: 'pb',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
      tenantOnly: { foreignSnapshot: async () => ({ b: await cc('pb'), bAudits: (await audits()).filter((r) => r.partnerId === 'pb').length }) },
    });
    expect(await cc('pb')).toEqual({ US: { amlHolds: true, largeAmountUsd: 900 } });
  });

  it('a site host is refused (404) before the gate, nothing written', async () => {
    await signInAdmin();
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(save(form('US', ['structuring']))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await snapshot()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('an agent or a viewer is redirected; nothing written', async () => {
    const before = await snapshot();
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(save(form('US', ['structuring']))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it('an admin without two-step sign-in -> partner.settings.amlHolds.mfaRequired, no step-up asked, nothing written', async () => {
    mfa.enrolled = false;
    await signInAdmin();
    await freshen();
    const before = await snapshot();
    for (const fd of [form('US', ['structuring']), form('US', ['structuring'], null)]) {
      const r = await save(fd);
      expect(isStepUpRequired(r)).toBe(false);
      expect(r).toEqual({ ok: false, error: t('partner.settings.amlHolds.mfaRequired') });
    }
    expect(await snapshot()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('an enrolled admin with a fresh step-up is still asked (always: true): step_up_required, nothing written', async () => {
    await signInAdmin();
    await freshen();
    const before = await snapshot();
    const r = await save(form('US', ['structuring'], null));
    expect(r).toEqual({ ok: false, code: 'step_up_required', factor: 'totp', error: t('partner.stepUp.required.totp') });
    expect(await snapshot()).toEqual(before);
    // A wrong code is refused and audited as a failed step-up only.
    expect(isStepUpRequired(await save(form('US', ['structuring'], '000000')))).toBe(true);
    expect(await snapshot()).toEqual(before);
    // Then the TOTP code -> saved.
    expect(await save(form('US', ['structuring']))).toEqual({ ok: true });
    const rows = await audits();
    expect(rows.map((x) => x.action)).toEqual(['auth.stepup.failed', 'auth.stepup', 'aml.hold_rules_set']);
    expect(rows[1].meta).toMatchObject({ factor: 'totp', target: 'aml_rule.save', actorScope: 'partner' });
    expect(JSON.stringify(rows)).not.toContain(mfa.code);
  });

  it('the default tenant\'s admin is refused, nothing written', async () => {
    await signInAdmin(DEFAULT_PARTNER_ID, 'default-admin');
    const before = await snapshot();
    expect(await save(form('US', ['structuring']))).toEqual({ ok: false, error: t('partner.settings.amlHolds.invalid') });
    expect(await save(form('US', []))).toEqual({ ok: false, error: t('partner.settings.amlHolds.invalid') });
    expect(await snapshot()).toEqual(before);
    expect(await ruleAudits()).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });
});

describe('setAmlHoldRulesAction: input', () => {
  beforeEach(async () => {
    await signInAdmin();
  });

  it('invalid input -> partner.settings.amlHolds.invalid, nothing written', async () => {
    const before = await snapshot();
    const bad: FormData[] = [
      form('us', ['structuring']),
      form('IN', ['structuring']),
      form('FR', ['structuring']), // not served
      form(null, ['structuring']), // missing
      form('US', ['cluster']),
      form('US', ['structuring', 'bogus']),
    ];
    const file = form('US', ['structuring']);
    file.append('rules', new File(['structuring'], 'structuring'));
    bad.push(file);
    const twoCountries = form('US', ['structuring']);
    twoCountries.append('country', 'GB');
    bad.push(twoCountries);
    for (const fd of bad) {
      const r = (await save(fd)) as { ok: boolean; error?: string };
      expect(r).toEqual({ ok: false, error: t('partner.settings.amlHolds.invalid') });
    }
    expect(await snapshot()).toEqual(before);
    expect(await ruleAudits()).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it("rules ['new_beneficiary','structuring','structuring'] -> stored canonical and de-duplicated; other keys and corridors kept byte for byte", async () => {
    const prior = { US: { largeAmountUsd: 5000, watchlistExtra: ['x y'], aml: { band: 3 } }, GB: { velocityLimit: 4, amlHolds: true } };
    await db.update(partners).set({ corridorCompliance: prior }).where(eq(partners.id, 'pa'));
    expect(await save(form('US', ['new_beneficiary', 'structuring', 'structuring']))).toEqual({ ok: true });
    expect(await cc('pa')).toEqual({
      US: { largeAmountUsd: 5000, watchlistExtra: ['x y'], aml: { band: 3 }, amlHolds: true, amlHoldRules: ['structuring', 'new_beneficiary'] },
      GB: { velocityLimit: 4, amlHolds: true },
    });
    const p = await createPartnerStore(db).getPartner('pa');
    expect(resolveCorridorRules(p, 'US')).toMatchObject({ amlHolds: true, amlHoldRules: ['structuring', 'new_beneficiary'] });
    expect(revalidatePath.mock.calls).toEqual([[PARTNER_ROUTES.settings.href]]);
  });

  it('no rule ticked -> amlHolds DELETED, amlHoldRules [] stored; resolveCorridorRules(...).amlHolds false', async () => {
    await db.update(partners).set({ corridorCompliance: { US: { amlHolds: true, amlHoldRules: ['structuring'], velocityLimit: 7 } } }).where(eq(partners.id, 'pa'));
    expect(await save(form('US', []))).toEqual({ ok: true });
    const stored = await cc('pa');
    expect(stored).toEqual({ US: { velocityLimit: 7, amlHoldRules: [] } });
    expect(Object.hasOwn(stored!.US!, 'amlHolds')).toBe(false);
    const raw = (await db.execute(sql`SELECT corridor_compliance::text AS j FROM partners WHERE id = 'pa'`)).rows[0] as { j: string };
    expect(raw.j).not.toContain('amlHolds"');
    const p = await createPartnerStore(db).getPartner('pa');
    expect(resolveCorridorRules(p, 'US').amlHolds).toBe(false);
    expect(resolveCorridorRules(p, 'US').amlHoldRules).toEqual([]);
  });

  it('a stored riskSignals entry survives an AML rule save byte for byte (pack 6 P18)', async () => {
    const riskSignals = { enabled: true, amountUsd: 750, newAccountHours: 24, hold: ['chat_cue'] };
    await db.update(partners).set({ corridorCompliance: { US: { velocityLimit: 7, riskSignals } } }).where(eq(partners.id, 'pa'));
    expect(await save(form('US', ['structuring']))).toEqual({ ok: true });
    expect(await cc('pa')).toEqual({ US: { velocityLimit: 7, riskSignals, amlHolds: true, amlHoldRules: ['structuring'] } });
    const p = await createPartnerStore(db).getPartner('pa');
    expect(resolveCorridorRules(p, 'US').riskSignals).toEqual({ enabled: true, amountUsd: 750, newAccountHours: 24, hold: ['chat_cue'] });
  });
});

describe('setAmlHoldRulesAction: audit, notice and poke', () => {
  beforeEach(async () => {
    await signInAdmin();
  });

  it("one audit row aml.hold_rules_set { country, from, to, actorScope: 'partner' }, from/to the RESOLVED lists", async () => {
    // Absent entry -> from [].
    expect(await save(form('US', ['first_transfer']))).toEqual({ ok: true });
    // Holds on with no stored list (the platform switch) -> from all three.
    await db.update(partners).set({ corridorCompliance: { US: { amlHoldRules: ['first_transfer'], amlHolds: true }, GB: { amlHolds: true } } }).where(eq(partners.id, 'pa'));
    expect(await save(form('GB', ['structuring', 'new_beneficiary']))).toEqual({ ok: true });
    // A list -> from that list; to [] when every rule is off.
    expect(await save(form('US', []))).toEqual({ ok: true });
    const rows = await ruleAudits();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', subjectId: 'pa' });
    expect(rows.map((r) => r.meta)).toEqual([
      { country: 'US', from: [], to: ['first_transfer'], actorScope: 'partner' },
      { country: 'GB', from: ALL, to: ['structuring', 'new_beneficiary'], actorScope: 'partner' },
      { country: 'US', from: ['first_transfer'], to: [], actorScope: 'partner' },
    ]);
  });

  it("an uncertified partner: no outbox row; a certified partner: one ops.alert livectl:amlHoldRules:pa:<uuid> and one email livectlmail:...", async () => {
    await db.update(partners).set({ supportConfig: { complianceAlertEmail: 'compliance@pa.example' } }).where(eq(partners.id, 'pa'));
    expect(await save(form('US', ['structuring']))).toEqual({ ok: true });
    expect(await outboxRows()).toEqual([]);
    expect(pokeSpy).toHaveBeenCalledTimes(1);

    await certifyPartnerForTest(db, 'pa');
    pokeSpy.mockClear();
    expect(await save(form('US', ['structuring', 'first_transfer']))).toEqual({ ok: true });
    const o = await outboxRows();
    expect(o.map((r) => r.kind)).toEqual(['ops.alert', 'email.send']);
    expect(o[0].dedupe_key).toMatch(new RegExp(`^livectl:amlHoldRules:pa:${UUID}$`));
    expect(o[0].payload).toEqual({ message: 'SmartRemit ops: aml.hold_rules_set on partner pa by partner staff.' });
    expect(o[1].dedupe_key).toMatch(new RegExp(`^livectlmail:amlHoldRules:pa:${UUID}$`));
    expect(o[1].payload).toEqual({
      to: ['compliance@pa.example'],
      subject: 'SmartRemit: a live control changed for your workspace',
      text: 'Your AML hold rule setting was changed by your team (updated). Details are in your SmartRemit workspace.',
    });
    expect(pokeSpy).toHaveBeenCalledTimes(1);
    // No rule name, username or country in the notices.
    for (const v of ['structuring', 'first_transfer', 'pa-admin', '"US"']) expect(JSON.stringify(o)).not.toContain(v);
  });

  it('a DB error inside the transaction -> partner.settings.failed, logged by error name, nothing written', async () => {
    const before = await snapshot();
    const realTx = db.transaction.bind(db);
    db.transaction = (async (fn: Parameters<typeof db.transaction>[0]) =>
      realTx(async (tx) => {
        await fn(tx);
        throw new TypeError('boom with compliance@pa.example and structuring');
      })) as typeof db.transaction;
    try {
      expect(await save(form('US', ['structuring']))).toEqual({ ok: false, error: t('partner.settings.failed') });
    } finally {
      db.transaction = realTx;
    }
    expect(await snapshot()).toEqual(before);
    expect(logWarnSpy).toHaveBeenCalledWith('partner.settings.aml_rules', 'TypeError', { partnerId: 'pa' });
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('boom');
    expect(pokeSpy).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
