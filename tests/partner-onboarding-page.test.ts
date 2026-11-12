import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-20: /partner/onboarding. Admin only (agent/support/finance → /partner); the
// SESSION tenant's facts only; no secret, URL or phone number id ever reaches the HTML; a
// backfilled approved partner shows Live with no request button; a facts read failure shows the
// error state; viewing writes nothing.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  usePathname: () => '/partner/onboarding',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
// `afterFacts`: getPartner starts failing once the onboarding facts are loaded (the facts read
// goes through the same store), so only the posture card's own read fails.
const partnerFail = vi.hoisted(() => ({ on: false, afterFacts: false }));
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return {
    ...actual,
    getPartnerStore: () => {
      const real = actual.createPartnerStore(db);
      return { ...real, getPartner: (id: string) => (partnerFail.on ? Promise.reject(new Error('db down')) : real.getPartner(id)) };
    },
  };
});
const factsFail = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/partner-onboarding-facts', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/partner-onboarding-facts')>();
  return {
    ...actual,
    loadOnboardingFacts: async (...a: Parameters<typeof actual.loadOnboardingFacts>) => {
      if (factsFail.on) throw new Error('db down');
      const facts = await actual.loadOnboardingFacts(...a);
      if (partnerFail.afterFacts) partnerFail.on = true;
      return facts;
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, outbox, partnerGoLive } from '@/db/schema';
import { t } from '@/lib/i18n';
import OnboardingPage from '@/app/partner/(app)/onboarding/page';
import { ONBOARDING_SECRETS, seedOnboardingComplete } from './helpers-partner-onboarding';
import { certifyPartnerForTest } from './helpers-live';
import { sql } from 'drizzle-orm';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await OnboardingPage());
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
const radios = (html: string, name: string) =>
  [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`name="${name}"`))
    .map((tag) => [/value="([^"]*)"/.exec(tag)?.[1], / checked=""/.test(tag)]);
const stepStates = (html: string) => [...html.matchAll(/data-step="(\d)" data-done="(true|false)"/g)].map((m) => [Number(m[1]), m[2] === 'true']);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  factsFail.on = false;
  partnerFail.on = false;
  partnerFail.afterFacts = false;
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('/partner/onboarding: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support, finance → /partner', async () => {
    await expect(OnboardingPage()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(OnboardingPage()).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, role });
      await expect(OnboardingPage()).rejects.toThrow('REDIRECT:/partner');
    }
  });
});

describe('/partner/onboarding: the checklist', () => {
  it('B complete, A empty → A sees seven steps, none done, and no enabled request button', async () => {
    await seedOnboardingComplete(db, redis, 'pb', '111222333444');
    await signInAs({});
    const html = decode(await render());
    expect(stepStates(html)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, false]));
    expect(html).toContain(t('partner.onboarding.state.in_progress'));
    expect(html).toContain(t('partner.onboarding.request.blocked'));
    expect(html).toMatch(/data-testid="partner-onboarding-request"[^>]*disabled/);
  });
  it('A complete (1–6) → ready, the request button is enabled, templates show as confirmed', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const html = decode(await render());
    expect(stepStates(html)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, n !== 7]));
    expect(html).toContain(t('partner.onboarding.state.ready'));
    expect(html).not.toMatch(/data-testid="partner-onboarding-request"[^>]*disabled/);
    expect(html).toContain(t('partner.onboarding.attest.done'));
    expect(html).not.toContain('data-testid="partner-onboarding-attest-form"');
  });
  it('never renders a secret, the endpoint URL or the phone number id', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const html = decode(await render());
    for (const v of Object.values(ONBOARDING_SECRETS)) expect(html).not.toContain(v);
    expect(html).not.toContain('rail.example.com');
  });
  it('the attestation form shows until templates are attested', async () => {
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain('data-testid="partner-onboarding-attest-form"');
    expect(html).toContain('name="authentication"');
    expect(html).toContain('name="transfer_delivered"');
  });
  it('requested → waiting for SmartRemit, no request button', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await db.insert(partnerGoLive).values({ partnerId: 'pa', requestedAt: new Date(), requestedBy: 'pa-admin' });
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.onboarding.state.requested'));
    expect(html).toContain(t('partner.onboarding.requestedNote'));
    expect(html).not.toContain('data-testid="partner-onboarding-request"');
    expect(stepStates(html).at(-1)).toEqual([7, true]);
  });
  it('a backfilled approved partner → Live, informational, no request button', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pa', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.onboarding.state.live'));
    expect(html).toContain(t('partner.onboarding.liveNote'));
    expect(html).not.toContain('data-testid="partner-onboarding-request"');
    expect(html).toContain('data-informational="true"');
  });
  it('a facts read failure → the error state, not a checklist', async () => {
    factsFail.on = true;
    await signInAs({});
    const html = decode(await render());
    expect(html).toContain(t('partner.onboarding.unavailable'));
    expect(html).toContain('role="alert"');
    expect(stepStates(html)).toEqual([]);
  });
  it('viewing writes nothing', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await signInAs({});
    const before = [(await db.select().from(auditEvents)).length, (await db.select().from(outbox)).length, (await db.select().from(partnerGoLive)).length];
    await render();
    expect([(await db.select().from(auditEvents)).length, (await db.select().from(outbox)).length, (await db.select().from(partnerGoLive)).length]).toEqual(before);
  });
});

// Fix pack 3 T9 (R27): the compliance posture card. It follows the steps list (it is NOT an eighth
// step: no data-step), shows the form until signed, then who signed and when plus the forced-KYC note.
describe('/partner/onboarding: the posture card', () => {
  const POSTURE = 'data-testid="partner-live-posture"';
  const html2card = (html: string) => html.slice(html.indexOf(POSTURE));
  it('the posture card follows the steps list; the seven data-step entries are unchanged', async () => {
    await signInAs({});
    const html = decode(await render());
    expect(stepStates(html).map(([n]) => n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const card = html.indexOf(POSTURE);
    expect(card).toBeGreaterThan(html.indexOf('</ol>'));
    expect(html.slice(card)).not.toContain('data-step=');
    expect(html).toContain(t('partner.live.posture.title'));
  });
  it('unsigned -> the form, with the radio matching the platform kycMode pre-checked', async () => {
    await signInAs({});
    const html = decode(await render());
    const card = html.slice(html.indexOf(POSTURE));
    expect(card).toContain('data-testid="partner-live-posture-form"');
    expect(radios(card, 'kycDecider')).toEqual([['smartremit_procedures', true], ['partner', false]]);
    expect(radios(card, 'holdDecider')).toEqual([['partner', false], ['smartremit_delegated', false]]);
    expect(card).toContain('name="fourEyesNonSanctions"');
    expect(card).toContain(t('partner.live.posture.sign'));
    expect(card).not.toContain(t('partner.live.posture.forcedNote'));
  });
  // Pack 3 review Q1 (H1): the default tenant never signs a posture, so the card has no form.
  it("the default tenant -> one neutral line, no form", async () => {
    await signInAs({ username: 'def-admin', partnerId: 'default' });
    const html = decode(await render());
    const card = html.slice(html.indexOf(POSTURE));
    expect(card).toContain(t('partner.live.posture.defaultTenant'));
    expect(card).not.toContain('data-testid="partner-live-posture-form"');
    expect(card).not.toContain(t('partner.live.posture.sign'));
  });
  it("a delegated partner's form pre-checks 'partner'", async () => {
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'pa'`);
    await signInAs({});
    const html = decode(await render());
    expect(radios(html.slice(html.indexOf(POSTURE)), 'kycDecider')).toEqual([['smartremit_procedures', false], ['partner', true]]);
  });
  it('signed -> who and when, the forced-KYC note, no form', async () => {
    await certifyPartnerForTest(db, 'pa', { posture: true });
    await signInAs({});
    const html = decode(await render());
    const card = html.slice(html.indexOf(POSTURE));
    expect(card).toContain(t('partner.live.posture.signed', { who: 'test-partner-admin', date: new Date(Date.now() - 240_000).toISOString().slice(0, 10) }));
    expect(card).toContain(t('partner.live.posture.forcedNote'));
    expect(card).toContain(t('partner.live.posture.kycDecider.smartremit_procedures'));
    expect(card).toContain(t('partner.live.posture.holdDecider.partner'));
    expect(card).not.toContain('data-testid="partner-live-posture-form"');
    expect(card).not.toContain('test-contract');
    expect(card).not.toContain('test-counsel');
  });
  // Fix pack 7 T15 (P31, P3, M12): the copy states enforcement only "once live", and four-eyes
  // only "in your hold queue" (it is enforced where the partner decides, a queue partner). A
  // partner whose holds SmartRemit decides is never promised a partner-side second approver.
  it('copy truth: the posture copy says SmartRemit enforces it once live, never "does not enforce", never "must approve"', async () => {
    await signInAs({});
    let card = html2card(decode(await render()));
    const label = /name="fourEyesNonSanctions"[\s\S]*?<\/label>/.exec(card)?.[0] ?? card;
    expect(label).toMatch(/We commit that a second person approves the release of every hold that is not a sanctions match\./);
    expect(label).toMatch(/Once you are live, SmartRemit enforces this in your hold queue\./);
    expect(card).not.toMatch(/does not enforce/);
    expect(card).not.toMatch(/must approve/);

    await certifyPartnerForTest(db, 'pa', { posture: true });
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_set(live_controls, '{posture,fourEyesNonSanctions}', 'true'::jsonb) WHERE id = 'pa'`);
    card = html2card(decode(await render()));
    expect(card).toMatch(/A second person approves the release of every hold that is not a sanctions match\. SmartRemit enforces this in your hold queue while your signed posture says so\./);
    expect(card).not.toMatch(/SmartRemit decides your holds/);
    expect(card).toMatch(/Once you are live, this answer decides who releases or rejects your compliance holds\. Sanctions matches stay with SmartRemit\./);
    expect(card).not.toMatch(/does not enforce/);
    expect(card).not.toMatch(/records this answer/);
    expect(card).not.toMatch(/must approve/);

    await db.execute(sql`UPDATE partners SET live_controls = jsonb_set(live_controls, '{posture,holdDecider}', '"smartremit_delegated"'::jsonb) WHERE id = 'pa'`);
    card = html2card(decode(await render()));
    expect(card).toMatch(/SmartRemit decides your holds; a second SmartRemit approver is not enforced yet\./);
    expect(card).not.toMatch(/enforces this in your hold queue/);
    expect(card).toMatch(/Once you are live, this answer decides who releases or rejects your compliance holds\. Sanctions matches stay with SmartRemit\./);
    expect(card).not.toMatch(/does not enforce/);
    expect(card).not.toMatch(/records this answer/);
    expect(card).not.toMatch(/must approve/);
  });
  it('a partner read failure -> the card shows unavailable, the checklist still renders', async () => {
    partnerFail.afterFacts = true;
    await signInAs({});
    const html = decode(await render());
    expect(stepStates(html)).toHaveLength(7);
    const card = html.slice(html.indexOf(POSTURE));
    expect(card).toContain(t('partner.live.posture.unavailable'));
    expect(card).not.toContain('data-testid="partner-live-posture-form"');
  });
});
