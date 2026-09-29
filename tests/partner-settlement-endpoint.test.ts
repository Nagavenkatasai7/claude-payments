import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// UI redesign M3-15a: the partner settlement-webhook core (endpoint URL, rail-secret rotation with
// the 7-day overlap, signed test ping). NOT a 'use server' module: callers gate and pass the
// session tenant. These tests pin the rules the plan lists (M3.md "15a Tasks").

const logWarnSpy = vi.hoisted(() => vi.fn());
const logErrorSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy, logError: logErrorSpy }));

import { auditEvents, partnerWebhookDeliveries } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { RAIL_SECRET_GRACE_MS, railSecrets, type PartnerIntegrations } from '@/lib/partner-integrations';
import { createSafeFetch } from '@/lib/safe-fetch';
import { RAIL_SIG_HEADER } from '@/lib/providers/rail-signature';
import {
  PING_LIMIT,
  SMARTREMIT_HOSTS,
  isSmartRemitHost,
  listRecentPings,
  rotateRailSecret,
  saveSettlementEndpoint,
  sendTestPing,
} from '@/lib/partner-settlement-endpoint';

let db: Db;
const redis = fakeRedis();
const actor = { username: 'pa-admin', actorScope: 'partner' as const };
const APP = 'https://smartremit.ai';
const prodOpts = { appOrigin: APP, production: true };
const store = () => createPartnerIntegrationsStore(db);
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const pings = (pid: string) => db.select().from(partnerWebhookDeliveries).where(eq(partnerWebhookDeliveries.partnerId, pid));

const SIGN_OLD = 'a'.repeat(64);
const HOOK_OLD = 'b'.repeat(64);
function httpRail(extra: Partial<PartnerIntegrations['payment']> = {}, pnid = '123456'): PartnerIntegrations {
  return {
    kyc: { providerType: 'persona', apiKey: 'kyc-key', webhookSecret: 'kyc-hook' },
    payment: {
      providerType: 'http',
      credentials: { settlementUrl: 'https://rail.example.com/instruct', signingSecret: SIGN_OLD, other: 'keep-me' },
      webhookSecret: HOOK_OLD,
      ...extra,
    },
    whatsapp: { phoneNumberId: pnid, token: 'wa-token', verifyToken: 'wa-verify', appSecret: 'wa-app' },
  };
}

beforeEach(async () => {
  redis.dump.clear();
  logWarnSpy.mockClear();
  logErrorSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await store().saveIntegrations('pa', httpRail());
  await store().saveIntegrations('pb', httpRail({}, '654321'));
});

describe('isSmartRemitHost', () => {
  it('lists the platform hosts in ONE exported constant', () => {
    expect(SMARTREMIT_HOSTS).toEqual(['smartremit.ai', 'claude-payments.vercel.app']);
  });
  it.each([
    ['smartremit.ai', true],
    ['acme.smartremit.ai', true],
    ['a.b.smartremit.ai', true],
    ['claude-payments.vercel.app', true],
    ['claude-payments-git-x-team.vercel.app', true],
    ['app.example.test', true], // the appOrigin host below
    ['notsmartremit.ai', false],
    ['smartremit.ai.evil.com', false],
    ['rail.example.com', false],
    ['other.vercel.app', false],
  ])('%s → %s', (host, expected) => {
    expect(isSmartRemitHost(host, 'https://app.example.test')).toBe(expected);
  });
});

describe('saveSettlementEndpoint', () => {
  it.each([
    'http://rail.example.com/x',
    'https://10.0.0.1/x',
    'https://[::1]/',
    'https://user@rail.example.com/',
    'https://x.internal/',
    'https://rail.example.com:8443/',
    'https://rail.example.com/' + 'a'.repeat(3000),
    'https://smartremit.ai/api/worker',
    'https://acme.smartremit.ai/x',
    'https://claude-payments.vercel.app/x',
    `${APP}/api/partner-rail`,
    '',
    'not a url',
  ])('refuses case %# with the one generic reason and writes nothing', async (url) => {
    const before = JSON.stringify(await store().getIntegrations('pa'));
    const r = await saveSettlementEndpoint(db, 'pa', actor, url, prodOpts);
    expect(r).toEqual({ ok: false, reason: 'invalid_url' });
    expect(JSON.stringify(await store().getIntegrations('pa'))).toBe(before);
    expect(await audits()).toHaveLength(0);
  });

  it('refuses the app origin even outside production when it is https', async () => {
    const r = await saveSettlementEndpoint(db, 'pa', actor, 'https://app.example.test/api/partner-rail', { appOrigin: 'https://app.example.test', production: false });
    expect(r).toEqual({ ok: false, reason: 'invalid_url' });
  });

  it('saves a valid public https URL with ONE audit row whose meta is { host, actorScope } only; every other secret and config is untouched', async () => {
    const r = await saveSettlementEndpoint(db, 'pa', actor, '  https://new-rail.example.com/v2/instruct?tok=zzz  ', prodOpts);
    expect(r).toEqual({ ok: true });
    const after = await store().getIntegrations('pa');
    const expected = httpRail();
    expected.payment.credentials = { ...expected.payment.credentials!, settlementUrl: 'https://new-rail.example.com/v2/instruct?tok=zzz' };
    expect(after).toEqual(expected);
    const now = new Date();
    expect(railSecrets(after.payment, 'signing', now)).toEqual([SIGN_OLD]);
    expect(railSecrets(after.payment, 'webhook', now)).toEqual([HOOK_OLD]);
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: 'partner.settlement_endpoint.update', subjectId: 'pa' });
    expect(a[0].meta).toEqual({ host: 'new-rail.example.com', actorScope: 'partner' });
  });

  it('a simulator or mock rail → not_partner_rail, nothing written', async () => {
    await store().saveIntegrations('pa', { ...httpRail(), payment: { ...httpRail().payment, providerType: 'simulator' } });
    const before = JSON.stringify(await store().getIntegrations('pa'));
    expect(await saveSettlementEndpoint(db, 'pa', actor, 'https://new-rail.example.com/x', prodOpts)).toEqual({ ok: false, reason: 'not_partner_rail' });
    expect(JSON.stringify(await store().getIntegrations('pa'))).toBe(before);
    await store().saveIntegrations('pa', { kyc: {}, payment: {}, whatsapp: {} });
    expect(await saveSettlementEndpoint(db, 'pa', actor, 'https://new-rail.example.com/x', prodOpts)).toEqual({ ok: false, reason: 'not_partner_rail' });
    expect(await audits()).toHaveLength(0);
  });

  it('partner B is untouched', async () => {
    const before = JSON.stringify(await store().getIntegrations('pb'));
    await saveSettlementEndpoint(db, 'pa', actor, 'https://new-rail.example.com/x', prodOpts);
    expect(JSON.stringify(await store().getIntegrations('pb'))).toBe(before);
  });
});

describe('rotateRailSecret', () => {
  it.each(['signing', 'webhook'] as const)('%s: new + old both active during the grace, only new after now + 7d + 1ms', async (kind) => {
    const now = new Date();
    const r = await rotateRailSecret(db, 'pa', actor, kind, { now: () => now });
    if (!r.ok) throw new Error('expected ok');
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.graceUntil).toBe(new Date(now.getTime() + RAIL_SECRET_GRACE_MS).toISOString());
    const after = await store().getIntegrations('pa');
    const old = kind === 'signing' ? SIGN_OLD : HOOK_OLD;
    expect(railSecrets(after.payment, kind, now)).toEqual([r.secret, old]);
    expect(railSecrets(after.payment, kind, new Date(now.getTime() + RAIL_SECRET_GRACE_MS + 1))).toEqual([r.secret]);
    // the other kind is untouched
    const other = kind === 'signing' ? 'webhook' : 'signing';
    expect(railSecrets(after.payment, other, now)).toEqual([other === 'signing' ? SIGN_OLD : HOOK_OLD]);
    // the rest of the row is intact
    expect(after.payment.credentials?.settlementUrl).toBe('https://rail.example.com/instruct');
    expect(after.payment.credentials?.other).toBe('keep-me');
    expect(after.payment.providerType).toBe('http');
    expect(after.whatsapp).toEqual(httpRail().whatsapp);
    expect(after.kyc).toEqual(httpRail().kyc);
  });

  it('the webhook kind writes the CURRENT secret to payment.webhookSecret, not the credentials blob', async () => {
    const r = await rotateRailSecret(db, 'pa', actor, 'webhook');
    if (!r.ok) throw new Error('expected ok');
    const after = await store().getIntegrations('pa');
    expect(after.payment.webhookSecret).toBe(r.secret);
    expect(Object.values(after.payment.credentials ?? {})).not.toContain(r.secret);
    expect(after.payment.credentials?.previousWebhookSecret).toBe(HOOK_OLD);
  });

  it('a first mint (no old secret) is not a rotation: no grace', async () => {
    await store().saveIntegrations('pa', httpRail({ credentials: { settlementUrl: 'https://rail.example.com/i' }, webhookSecret: undefined }));
    const r = await rotateRailSecret(db, 'pa', actor, 'signing');
    if (!r.ok) throw new Error('expected ok');
    expect(r.graceUntil).toBeNull();
    expect(railSecrets((await store().getIntegrations('pa')).payment, 'signing', new Date())).toEqual([r.secret]);
  });

  it('writes ONE audit row { kind, graceUntil, actorScope }; the secret is in neither the audit nor any log', async () => {
    const r = await rotateRailSecret(db, 'pa', actor, 'signing');
    if (!r.ok) throw new Error('expected ok');
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', action: 'partner.settlement_secret.rotate', subjectId: 'pa' });
    expect(a[0].meta).toEqual({ kind: 'signing', graceUntil: r.graceUntil, actorScope: 'partner' });
    const everything = JSON.stringify([a, logWarnSpy.mock.calls, logErrorSpy.mock.calls]);
    expect(everything).not.toContain(r.secret);
    expect(everything).not.toContain(SIGN_OLD);
  });

  it('a simulator rail → not_partner_rail, nothing written', async () => {
    await store().saveIntegrations('pa', { ...httpRail(), payment: { ...httpRail().payment, providerType: 'simulator' } });
    const before = JSON.stringify(await store().getIntegrations('pa'));
    expect(await rotateRailSecret(db, 'pa', actor, 'signing')).toEqual({ ok: false, reason: 'not_partner_rail' });
    expect(JSON.stringify(await store().getIntegrations('pa'))).toBe(before);
    expect(await audits()).toHaveLength(0);
  });

  it('partner B is untouched', async () => {
    const before = JSON.stringify(await store().getIntegrations('pb'));
    await rotateRailSecret(db, 'pa', actor, 'signing');
    expect(JSON.stringify(await store().getIntegrations('pb'))).toBe(before);
  });
});

describe('sendTestPing', () => {
  const ok = (status = 200) => vi.fn(async (..._a: Parameters<typeof fetch>) => new Response(null, { status }));
  const deps = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) => ({ fetchFn, redis, ...prodOpts, ...extra });

  it('a stubbed 200 → ok with latencyMs ≥ 0; the row carries no URL and no body; one audit row', async () => {
    const f = ok(200);
    const r = await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch));
    expect(r).toMatchObject({ ok: true, outcome: 'ok', httpStatus: 200 });
    if (!r.ok) throw new Error();
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const rows = await pings('pa');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ping', outcome: 'ok', httpStatus: 200, attempt: 1, subjectId: null, outboxId: null });
    expect(JSON.stringify(rows)).not.toContain('rail.example.com');
    expect(JSON.stringify(rows)).not.toContain('"type"');
    expect(JSON.stringify(rows)).not.toContain('created"');
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', action: 'webhook.test', subjectId: 'pa' });
    expect(a[0].meta).toEqual({ outcome: 'ok', httpStatus: 200, actorScope: 'partner' });
  });

  it('POSTs the ping body signed with EVERY active signing secret (current + previous in grace), to the stored URL, with a timeout', async () => {
    const now = new Date();
    const rot = await rotateRailSecret(db, 'pa', actor, 'signing', { now: () => now });
    if (!rot.ok) throw new Error();
    const f = ok(204);
    await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch, { now: () => now }));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://rail.example.com/instruct');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body)).toEqual(['type', 'id', 'created']);
    expect(body.type).toBe('ping');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.created).toBe(Math.floor(now.getTime() / 1000));
    const sig = new Headers(init?.headers).get(RAIL_SIG_HEADER) ?? '';
    expect(sig.match(/v1=/g)).toHaveLength(2);
  });

  it('a 500 → http_error with httpStatus 500', async () => {
    const r = await sendTestPing(db, 'pa', actor, deps(ok(500) as unknown as typeof fetch));
    expect(r).toMatchObject({ ok: true, outcome: 'http_error', httpStatus: 500 });
    expect((await pings('pa'))[0]).toMatchObject({ outcome: 'http_error', httpStatus: 500 });
  });

  it('a timeout → network, no status', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const r = await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch));
    expect(r).toMatchObject({ ok: true, outcome: 'network', httpStatus: null });
    expect((await pings('pa'))[0]).toMatchObject({ outcome: 'network', httpStatus: null });
  });

  it('a host that resolves to 10.0.0.1 → refused by safeFetch at connect time; no request is made', async () => {
    await store().saveIntegrations('pa', httpRail({ credentials: { settlementUrl: 'https://rebind.example.com/x', signingSecret: SIGN_OLD } }));
    const resolve = vi.fn(async () => [{ address: '10.0.0.1', family: 4 }]);
    const r = await sendTestPing(db, 'pa', actor, deps(createSafeFetch({ resolve, ...prodOpts })));
    expect(resolve).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, outcome: 'refused', httpStatus: null });
    expect((await pings('pa'))[0]).toMatchObject({ outcome: 'refused' });
  });

  it.each(['https://smartremit.ai/api/worker', 'http://rail.example.com/x', 'https://10.0.0.1/x'])(
    'a stored URL that fails the partner rules (%s) is refused BEFORE any request',
    async (url) => {
      await store().saveIntegrations('pa', httpRail({ credentials: { settlementUrl: url, signingSecret: SIGN_OLD } }));
      const f = ok(200);
      const r = await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch));
      expect(f).not.toHaveBeenCalled();
      expect(r).toMatchObject({ ok: true, outcome: 'refused' });
    },
  );

  it(`the ${PING_LIMIT.limit + 1}th ping in the window → rate_limited, no request, no row, no audit`, async () => {
    const now = new Date('2026-09-29T12:00:30Z'); // a fixed instant inside one window
    const f = ok(200);
    for (let i = 0; i < PING_LIMIT.limit; i++) {
      expect((await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch, { now: () => now }))).ok).toBe(true);
    }
    const r = await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch, { now: () => now }));
    expect(r).toEqual({ ok: false, reason: 'rate_limited' });
    expect(f).toHaveBeenCalledTimes(PING_LIMIT.limit);
    expect(await pings('pa')).toHaveLength(PING_LIMIT.limit);
    expect(await audits()).toHaveLength(PING_LIMIT.limit);
    // another tenant has its own budget
    expect((await sendTestPing(db, 'pb', actor, deps(f as unknown as typeof fetch, { now: () => now }))).ok).toBe(true);
  });

  it('the limit is 5 per 10 minutes', () => {
    expect(PING_LIMIT).toMatchObject({ limit: 5, windowSec: 600 });
  });

  it('a limiter error fails closed', async () => {
    const broken = { ...redis, incr: async () => { throw new Error('down'); } };
    const f = ok(200);
    expect(await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch, { redis: broken }))).toEqual({ ok: false, reason: 'rate_limited' });
    expect(f).not.toHaveBeenCalled();
  });

  it('a simulator rail → not_partner_rail; no endpoint → no_endpoint; no signing secret → no_signing_secret; none sends', async () => {
    const f = ok(200);
    await store().saveIntegrations('pa', { ...httpRail(), payment: { ...httpRail().payment, providerType: 'simulator' } });
    expect(await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch))).toEqual({ ok: false, reason: 'not_partner_rail' });
    await store().saveIntegrations('pa', httpRail({ credentials: { signingSecret: SIGN_OLD } }));
    expect(await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch))).toEqual({ ok: false, reason: 'no_endpoint' });
    await store().saveIntegrations('pa', httpRail({ credentials: { settlementUrl: 'https://rail.example.com/i' } }));
    expect(await sendTestPing(db, 'pa', actor, deps(f as unknown as typeof fetch))).toEqual({ ok: false, reason: 'no_signing_secret' });
    expect(f).not.toHaveBeenCalled();
    expect(await pings('pa')).toHaveLength(0);
  });

  it('never reads the response body', async () => {
    const res = new Response('{"secret":"leak"}', { status: 200 });
    const text = vi.spyOn(res, 'text');
    const json = vi.spyOn(res, 'json');
    await sendTestPing(db, 'pa', actor, deps((async () => res) as unknown as typeof fetch));
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('listRecentPings returns THIS tenant only, newest first, at most N, without URL or body', async () => {
    const f = ok(200);
    await sendTestPing(db, 'pb', actor, deps(f as unknown as typeof fetch));
    for (let i = 0; i < 3; i++) await sendTestPing(db, 'pa', actor, deps(ok(200 + i) as unknown as typeof fetch));
    const list = await listRecentPings(db, 'pa', 2);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.httpStatus)).toEqual([202, 201]);
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'httpStatus', 'latencyMs', 'outcome']);
  });
});
