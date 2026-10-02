import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';

// Partner-dashboard merge 2f: the /partner/settings server actions (support portal, channel alert
// email, Reg E disclosure). Real gate (requirePartnerStaff over the real auth store on a fake
// Redis), real writers on PGlite. Each action runs the shared contract (tests/helpers-partner-app.ts)
// in its tenant-only form: the target IS the session's tenant, so a form naming B changes A only.
// The disclosure save also needs the 15-minute step-up (as in tests/partner-step-up-actions.test.ts).

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
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { hashPassword } from '@/lib/password';
import { staffStepUpKey } from '@/lib/staff-step-up';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { auditEvents, partners } from '@/db/schema';
import { t } from '@/lib/i18n';
import { MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';
import type { PartnerSupportConfig, Staff } from '@/lib/types';
import { PARTNER_ROUTES } from '@/app/partner/routes';
import { saveAlertEmailAction, saveDisclosureAction, saveSupportPortalAction } from '@/app/partner/(app)/settings/actions';

const DISCLOSURE = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
  deliveryEstimate: { businessDays: 2 },
};
const B_CONFIG: PartnerSupportConfig = { enableSupportPortal: true, autoAssign: 'round_robin', alertEmail: 'ops@bravo.example', disclosure: { licensedEntity: 'Bravo Remit LLC' } };

const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const disclosureForm = (over: Record<string, string> = {}) =>
  form({
    licensedEntity: 'Acme Money Services LLC',
    licenseIds: 'NMLS 000000',
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    regulatorName: 'State Department of Financial Services',
    regulatorPhone: '+1 800 555 0199',
    regulatorWebsite: 'https://regulator.example',
    deliveryBusinessDays: '2',
    ...over,
  });

const PASSWORD = 'correct horse battery staple';
async function signInAdmin(o: Partial<Staff> = {}): Promise<string> {
  await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin', passwordHash: await hashPassword(PASSWORD), ...o });
  return cookieJar.get(SESSION_COOKIE)!;
}
/** Mark the CURRENT cookie's session as stepped up just now (no-op when signed out). */
async function freshen(): Promise<void> {
  const token = cookieJar.get(SESSION_COOKIE);
  if (!token) return;
  const user = await getAuthStore().getSessionUser(token);
  if (user) await redis.set(staffStepUpKey(token), `${user}:${Date.now()}`, { ex: 900 });
}

const sc = async (id: string) => (await db.select({ c: partners.supportConfig }).from(partners).where(eq(partners.id, id)))[0]?.c as PartnerSupportConfig | null;
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const snapshot = async () => ({ a: await sc('pa'), b: await sc('pb'), audits: (await audits()).length });
const foreignSnapshot = async () => ({ b: await sc('pb'), bAudits: (await audits()).filter((r) => r.partnerId === 'pb').length });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  revalidatePath.mockClear();
  logWarnSpy.mockClear();
  db = await freshDb();
  await seedTwoTenants(db);
  await db.update(partners).set({ supportConfig: B_CONFIG }).where(eq(partners.id, 'pb'));
});

type Act = (fd: FormData) => Promise<unknown>;
const RUNNERS: Array<{ name: string; action: Act; form: (id: string) => FormData; auditAction: string }> = [
  {
    name: 'saveSupportPortalAction',
    action: saveSupportPortalAction,
    // Distinct values per call, so each successful call changes something.
    form: (id) => form(id === 'pa' ? { enableSupportPortal: 'on' } : {}),
    auditAction: 'partner.support_config',
  },
  {
    name: 'saveAlertEmailAction',
    action: saveAlertEmailAction,
    form: (id) => form({ alertEmail: id === 'pa' ? 'ops@acme.example' : 'alerts@acme.example' }),
    auditAction: 'partner.alert_email.update',
  },
  {
    name: 'saveDisclosureAction',
    action: async (fd) => {
      await freshen();
      return saveDisclosureAction(null, fd);
    },
    form: (id) => disclosureForm(id === 'pa' ? {} : { licensedEntity: 'Acme Remit Inc' }),
    auditAction: 'partner.disclosure_config',
  },
];

describe.each(RUNNERS)('$name: the shared /partner action contract', ({ action, form: mk, auditAction }) => {
  it('items 1-4: gate, agent refused, a form naming B acts on A only, forged tenant fields ignored', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: (fd) => {
        // The tenant-only form: any id / partnerId / partner field names the "target"; none is read.
        return action(fd);
      },
      form: (id) => {
        const fd = mk(id);
        fd.set('id', id);
        fd.set('partnerId', id);
        return fd;
      },
      ownId: 'pa',
      foreignId: 'pb',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
      tenantOnly: { foreignSnapshot },
    });
    expect(await sc('pb')).toEqual(B_CONFIG);
  });

  it('0. refuses on a partner-site host before anything else', async () => {
    await signInAdmin();
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(action(mk('pa'))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await snapshot()).toEqual(before);
  });

  it('support and finance are refused too (→ /partner), with no write', async () => {
    const before = await snapshot();
    for (const role of ['support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(action(mk('pa'))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('success → one audit row for A with actorScope partner, and only /partner/settings revalidated', async () => {
    await signInAdmin();
    expect(await action(mk('pa'))).toEqual({ ok: true });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: auditAction, subjectId: 'pa' });
    expect((rows[0].meta as { actorScope?: string }).actorScope).toBe('partner');
    expect(revalidatePath.mock.calls).toEqual([[PARTNER_ROUTES.settings.href]]);
  });
});

it('the actions use the settings route policy: admin only', () => {
  expect(PARTNER_ROUTES.settings.policy.roles).toEqual(['admin']);
});

describe('saveSupportPortalAction', () => {
  it('merges ONLY enableSupportPortal: autoAssign, the alert email and the disclosure are kept', async () => {
    await db.update(partners).set({ supportConfig: { enableSupportPortal: true, autoAssign: 'round_robin', alertEmail: 'ops@acme.example', disclosure: DISCLOSURE } }).where(eq(partners.id, 'pa'));
    await signInAdmin();
    expect(await saveSupportPortalAction(form())).toEqual({ ok: true });
    expect(await sc('pa')).toEqual({ enableSupportPortal: false, autoAssign: 'round_robin', alertEmail: 'ops@acme.example', disclosure: DISCLOSURE });
    expect((await audits())[0].meta).toEqual({ old: { enableSupportPortal: true }, new: { enableSupportPortal: false }, actorScope: 'partner' });
  });
  it('an autoAssign field is never read (platform-only knob, owner decision D8)', async () => {
    await signInAdmin();
    await saveSupportPortalAction(form({ enableSupportPortal: 'on', autoAssign: 'round_robin' }));
    expect(await sc('pa')).toEqual({ enableSupportPortal: true });
  });
});

describe('saveAlertEmailAction', () => {
  beforeEach(async () => {
    await signInAdmin();
  });
  it('saves a trimmed address and clears on blank; the audit rows hold no address', async () => {
    expect(await saveAlertEmailAction(form({ alertEmail: ' ops@acme.example ' }))).toEqual({ ok: true });
    expect((await sc('pa'))?.alertEmail).toBe('ops@acme.example');
    expect(await saveAlertEmailAction(form({ alertEmail: '' }))).toEqual({ ok: true });
    expect(await sc('pa')).not.toHaveProperty('alertEmail');
    const rows = await audits();
    expect(rows.map((r) => r.meta)).toEqual([
      { set: true, hadPrevious: false, actorScope: 'partner' },
      { set: false, hadPrevious: true, actorScope: 'partner' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('@');
  });
  it.each(['not an email', 'a@b.example, c@d.example', 'a@b.example\r\nBcc: x@y.example', `${'a'.repeat(300)}@acme.example`])(
    'refuses %j with the fixed copy, never echoing it, and writes nothing',
    async (bad) => {
      const before = await snapshot();
      const r = (await saveAlertEmailAction(form({ alertEmail: bad }))) as { ok: boolean; error?: string };
      expect(r).toEqual({ ok: false, error: t('partner.settings.alert.invalid') });
      expect(await snapshot()).toEqual(before);
    },
  );
  it('a missing field never clears a stored address', async () => {
    await saveAlertEmailAction(form({ alertEmail: 'ops@acme.example' }));
    const before = await snapshot();
    expect(await saveAlertEmailAction(form())).toEqual({ ok: false, error: t('partner.settings.alert.invalid') });
    expect(await snapshot()).toEqual(before);
  });
});

describe('saveDisclosureAction: validation and copy', () => {
  beforeEach(async () => {
    await signInAdmin();
    await freshen();
  });
  it('saves the block and keeps the support knobs and alert email', async () => {
    await db.update(partners).set({ supportConfig: { enableSupportPortal: false, alertEmail: 'ops@acme.example' } }).where(eq(partners.id, 'pa'));
    expect(await saveDisclosureAction(null, disclosureForm())).toEqual({ ok: true });
    expect(await sc('pa')).toEqual({ enableSupportPortal: false, alertEmail: 'ops@acme.example', disclosure: DISCLOSURE });
    expect((await audits())[0].meta).toEqual({ old: null, new: DISCLOSURE, actorScope: 'partner' });
  });
  it('an all-blank form clears the block', async () => {
    await db.update(partners).set({ supportConfig: { disclosure: DISCLOSURE } }).where(eq(partners.id, 'pa'));
    const blank = disclosureForm({ licensedEntity: '', licenseIds: '', phone: '', website: '', regulatorName: '', regulatorPhone: '', regulatorWebsite: '', deliveryBusinessDays: '' });
    expect(await saveDisclosureAction(null, blank)).toEqual({ ok: true });
    expect(await sc('pa')).toEqual({});
  });
  it.each([
    [{ phone: 'call us now' }, 'partner.settings.disclosure.error.providerPhone'],
    [{ regulatorPhone: '555-CALL-ME' }, 'partner.settings.disclosure.error.regulatorPhone'],
    [{ website: 'http://acme-evil.example' }, 'partner.settings.disclosure.error.providerWebsite'],
    [{ regulatorWebsite: 'javascript:alert(1)' }, 'partner.settings.disclosure.error.regulatorWebsite'],
    [{ deliveryBusinessDays: '99' }, 'partner.settings.disclosure.error.deliveryDays'],
    [{ regulatorName: '' }, 'partner.settings.disclosure.error.regulatorNameRequired'],
    [{ licensedEntity: '' }, 'partner.settings.disclosure.error.entityRequired'],
  ] as const)('%j → its fixed copy, never the input, and no write', async (over, key) => {
    const before = await snapshot();
    const r = (await saveDisclosureAction(null, disclosureForm(over))) as { ok: boolean; error?: string };
    expect(r).toEqual({ ok: false, error: t(key, { max: MAX_DELIVERY_BUSINESS_DAYS }) });
    for (const v of Object.values(over)) if (v) expect(r.error).not.toContain(v);
    expect(await snapshot()).toEqual(before);
  });
  it('a writer failure is the fixed "failed" copy, logged by error name only', async () => {
    const realTx = db.transaction.bind(db);
    db.transaction = (async () => {
      throw new Error('db exploded with ops@acme.example');
    }) as typeof db.transaction;
    try {
      expect(await saveDisclosureAction(null, disclosureForm())).toEqual({ ok: false, error: t('partner.settings.failed') });
    } finally {
      db.transaction = realTx;
    }
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('exploded');
  });
});

describe('saveDisclosureAction: the 15-minute step-up (target disclosure.save)', () => {
  it('a stale session → step_up_required (password factor), ZERO writes', async () => {
    await signInAdmin();
    const before = await snapshot();
    const r = await saveDisclosureAction(null, disclosureForm());
    expect(r).toEqual({ ok: false, code: 'step_up_required', factor: 'password', error: t('partner.stepUp.required.password') });
    expect(await snapshot()).toEqual(before);
  });
  it('an invalid form is refused with its copy BEFORE the step-up is asked for', async () => {
    await signInAdmin();
    const r = await saveDisclosureAction(null, disclosureForm({ licensedEntity: '' }));
    expect(isStepUpRequired(r)).toBe(false);
    expect(r).toMatchObject({ ok: false, error: t('partner.settings.disclosure.error.entityRequired') });
  });
  it('a step-up on ANOTHER session of the same user does not count', async () => {
    await signInAdmin();
    await freshen();
    cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession('pa-admin'));
    const before = await snapshot();
    expect(isStepUpRequired(await saveDisclosureAction(null, disclosureForm()))).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
  it('a Redis error on the step-up marker → refused, nothing written', async () => {
    await signInAdmin();
    await freshen();
    const get = redis.get.bind(redis);
    redis.get = async (k: string) => {
      if (k.startsWith('staff_stepup:')) throw new Error('redis down');
      return get(k);
    };
    try {
      const before = await snapshot();
      expect(await saveDisclosureAction(null, disclosureForm())).toEqual({ ok: false, error: t('partner.stepUp.unavailable') });
      expect(await snapshot()).toEqual(before);
    } finally {
      redis.get = get;
    }
  });
  it('retry with the password → saves in the same request; auth.stepup audited with target disclosure.save, no password anywhere', async () => {
    await signInAdmin();
    expect(await saveDisclosureAction(null, disclosureForm({ [STEP_UP_FIELD]: 'not my password' }))).toMatchObject({ code: 'step_up_required' });
    expect(await saveDisclosureAction(null, disclosureForm({ [STEP_UP_FIELD]: PASSWORD }))).toEqual({ ok: true });
    expect((await sc('pa'))?.disclosure).toEqual(DISCLOSURE);
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['auth.stepup.failed', 'auth.stepup', 'partner.disclosure_config']);
    expect(rows[1].meta).toMatchObject({ factor: 'password', target: 'disclosure.save', actorScope: 'partner' });
    const all = JSON.stringify([rows, logWarnSpy.mock.calls]);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('not my password');
  });
  it('the other settings saves are never gated by the step-up', async () => {
    await signInAdmin();
    expect(await saveSupportPortalAction(form({ enableSupportPortal: 'on' }))).toEqual({ ok: true });
    expect(await saveAlertEmailAction(form({ alertEmail: 'ops@acme.example' }))).toEqual({ ok: true });
  });
});
