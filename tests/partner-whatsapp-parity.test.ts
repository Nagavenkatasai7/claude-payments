import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { asc } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { EnvKeyProvider } from '@/lib/field-crypto';

// UI redesign M3-13: the move's parity proof. The legacy admin tab action and the new /partner
// action run the SAME core (src/lib/partner-whatsapp-config.ts). Twin tenants get the same input
// through each surface; the stored config, the audit meta (minus the partner surface's actorScope
// marker) and the Graph calls must match. Legacy rows stay unmarked (their suites pin that).
// UI M5: the legacy tab is SmartRemit-only, so its side runs as a platform admin configuring the
// twin tenant; a partner admin posting to it is sent to /partner (pinned at the end).

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
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))) };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createStore } from '@/lib/store';
import { saveWhatsappConfigAction, testWhatsappConnectionAction } from '@/app/admin-dashboard/partners/actions';
import { saveWhatsappAction, testWhatsappAction, disconnectWhatsappAction } from '@/app/partner/(app)/integrations/whatsapp/actions';

// Legacy tenant L, partner-surface tenant P. Distinct numbers (the pnid is unique per tenant).
const PN = { L: '1111111111111', P: '2222222222222' } as const;
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(username: string, partnerId: string | undefined): Promise<void> {
  const s: Staff = { username, name: username, role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const store = () => createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7)));
// The Graph stub answers with whichever number it was asked about.
const graph = (status = 200) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    const id = /\/(\d+)\?/.exec(url)?.[1];
    return new Response(JSON.stringify({ id }), { status });
  });

type Side = 'L' | 'P';
const tenant = (s: Side) => (s === 'L' ? 'tl' : 'tp');
const norm = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).replaceAll(PN.L, '<PN>').replaceAll(PN.P, '<PN>'));

async function run(side: Side, kind: 'save' | 'disconnect' | 'test', fields: Record<string, string> = {}): Promise<{ threw: string | null; result: unknown }> {
  const pid = tenant(side);
  if (side === 'L') await signInAs('ops-admin', undefined); // UI M5: the legacy tab is platform-only
  else await signInAs(`${pid}-admin`, pid);
  const f = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.replace('<PN>', PN[side])]));
  try {
    if (side === 'L') {
      if (kind === 'test') await testWhatsappConnectionAction(form({ id: pid }));
      else await saveWhatsappConfigAction(form({ id: pid, ...f, ...(kind === 'disconnect' ? { disconnect: 'on' } : {}) }));
      return { threw: null, result: null };
    }
    const action = kind === 'save' ? saveWhatsappAction : kind === 'test' ? testWhatsappAction : disconnectWhatsappAction;
    return { threw: null, result: await action(form(f)) };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e), result: null };
  }
}

async function stateOf(side: Side) {
  const pid = tenant(side);
  const rows = (await db.select().from(auditEvents).orderBy(asc(auditEvents.id))).filter((r) => r.partnerId === pid);
  const meta = rows.map((r) => {
    const m = r.meta as Record<string, unknown> | null;
    if (!m) return { action: r.action, meta: null };
    const { actorScope: _scope, ...rest } = m;
    return { action: r.action, meta: Object.keys(rest).length ? rest : null };
  });
  return norm({
    whatsapp: (await store().getIntegrations(pid)).whatsapp,
    audit: meta,
    lastTest: JSON.parse((await createStore(redis, db).readChannelTest(pid)) ?? 'null')?.ok ?? null,
  });
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedPartner(db, 'tl', 'Legacy Twin');
  await seedPartner(db, 'tp', 'Partner Twin');
});
afterEach(() => vi.unstubAllGlobals());

// Each scenario: [name, seed (per side), steps]. The legacy form re-submits the stored number
// (its page pre-fills it); the partner page cannot, and its blank number keeps the stored one.
const SCENARIOS: Array<[string, boolean, Array<[kind: 'save' | 'disconnect' | 'test', legacy: Record<string, string>, partner: Record<string, string>]>]> = [
  ['a full new config (Graph-verified)', false, [['save', { phoneNumberId: '<PN>', token: 'EAA-t', appSecret: 's', verifyToken: 'v' }, { phoneNumberId: '<PN>', token: 'EAA-t', appSecret: 's', verifyToken: 'v' }]]],
  ['an incomplete config (refused, no write)', false, [['save', { phoneNumberId: '<PN>', token: 'EAA-t' }, { phoneNumberId: '<PN>', token: 'EAA-t' }]]],
  ['only a new verify token (no probe)', true, [['save', { phoneNumberId: '<PN>', verifyToken: 'v2' }, { verifyToken: 'v2' }]]],
  ['a new token on a stored number (probed)', true, [['save', { phoneNumberId: '<PN>', token: 'EAA-new' }, { token: 'EAA-new' }]]],
  ['disconnect', true, [['disconnect', {}, {}]]],
  ['test connection (configured)', true, [['test', {}, {}]]],
  ['test connection (not configured)', false, [['test', {}, {}]]],
];

describe('legacy admin tab ≡ /partner surface (one core)', () => {
  it.each(SCENARIOS)('%s', async (_name, seeded, steps) => {
    for (const side of ['L', 'P'] as const) {
      if (seeded) {
        await store().saveIntegrations(tenant(side), { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN[side], token: 'EAA-stored', appSecret: 'stored-sec' } });
      }
    }
    const calls: Record<Side, unknown[]> = { L: [], P: [] };
    const outcomes: Record<Side, boolean[]> = { L: [], P: [] };
    for (const side of ['L', 'P'] as const) {
      const g = graph();
      vi.stubGlobal('fetch', g);
      for (const [kind, legacy, partner] of steps) {
        const r = await run(side, kind, side === 'L' ? legacy : partner);
        // Legacy throws a refusal; the partner surface returns { ok:false }. Both mean "refused".
        outcomes[side].push(side === 'L' ? r.threw === null : (r.result as { ok: boolean }).ok);
      }
      calls[side] = norm(g.mock.calls.map((c) => [c[0], (c[1] as RequestInit).headers]));
    }
    expect(outcomes.P).toEqual(outcomes.L);
    expect(calls.P).toEqual(calls.L);
    // Not vacuous: the probing scenarios really called Graph, the others really did not.
    expect(calls.L.length > 0).toBe(/Graph-verified|probed|\(configured\)/.test(_name));
    const [l, p] = [await stateOf('L'), await stateOf('P')];
    // The partner surface adds its own audit row for a connection test; legacy never audited one.
    p.audit = p.audit.filter((a: { action: string }) => a.action !== 'partner.whatsapp.test');
    expect(p).toEqual(l);
  });

  it('the partner rows carry actorScope = partner; the legacy rows stay unmarked', async () => {
    vi.stubGlobal('fetch', graph());
    await run('L', 'save', { phoneNumberId: '<PN>', token: 'EAA-t', appSecret: 's' });
    await run('P', 'save', { phoneNumberId: '<PN>', token: 'EAA-t', appSecret: 's' });
    const rows = await db.select().from(auditEvents).orderBy(asc(auditEvents.id));
    expect((rows.find((r) => r.partnerId === 'tl')!.meta as Record<string, unknown>).actorScope).toBeUndefined();
    expect((rows.find((r) => r.partnerId === 'tp')!.meta as Record<string, unknown>).actorScope).toBe('partner');
  });

  it('UI M5: a partner admin (own tenant or another) posting to the legacy tab is sent to /partner, nothing written', async () => {
    await store().saveIntegrations('tl', { kyc: {}, payment: {}, whatsapp: { phoneNumberId: PN.L, token: 'EAA-stored', appSecret: 'stored-sec' } });
    const g = graph();
    vi.stubGlobal('fetch', g);
    const before = JSON.stringify(await stateOf('L'));
    for (const pid of ['tl', 'tp']) {
      await signInAs(`${pid}-admin`, pid);
      await expect(saveWhatsappConfigAction(form({ id: 'tl', phoneNumberId: PN.L, token: 'EAA-new' }))).rejects.toThrow(/^REDIRECT:\/partner$/);
      await expect(saveWhatsappConfigAction(form({ id: 'tl', disconnect: 'on' }))).rejects.toThrow(/^REDIRECT:\/partner$/);
      await expect(testWhatsappConnectionAction(form({ id: 'tl' }))).rejects.toThrow(/^REDIRECT:\/partner$/);
    }
    expect(g).not.toHaveBeenCalled();
    expect(JSON.stringify(await stateOf('L'))).toBe(before);
    expect((await db.select().from(auditEvents)).length).toBe(0);
  });

  it('the code MOVED: the legacy actions no longer carry the probe or the integrations write', () => {
    const src = readFileSync('src/app/admin-dashboard/partners/actions.ts', 'utf8');
    expect(src).not.toContain('verifyPhoneNumberOwnership');
    expect(src).not.toContain('writeChannelTest');
    expect(src).not.toContain("action: 'partner.whatsapp.disconnect'");
    expect(src).toContain("from '@/lib/partner-whatsapp-config'");
    const partnerSrc = readFileSync('src/app/partner/(app)/integrations/whatsapp/actions.ts', 'utf8');
    expect(partnerSrc).not.toContain('verifyPhoneNumberOwnership');
    expect(partnerSrc).toContain("from '@/lib/partner-whatsapp-config'");
  });
});
