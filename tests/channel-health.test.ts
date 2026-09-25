import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import type { Db } from '@/db/client';
import {
  applyHealthMark,
  parseHealthMarks,
  healthEmailDedupeKey,
  summarizeChannelHealth,
  normalizeAlertEmail,
  recordChannelHealth,
  getChannelHealth,
  CHANNEL_HEALTH_ACTION,
} from '@/lib/channel-health';

// R2a: partner-visible WhatsApp channel health. Redis holds the live marks
// (last-at / count / Meta code per kind, 7-day TTL); audit_events holds one row
// per (partner, kind, hour); an alert email (when the partner set one) is ONE
// email.send per (partner, kind, UTC day). Only the Meta code is stored — never
// a token, phone or payload.

const NOW = new Date('2026-09-25T10:15:00.000Z');

describe('pure helpers', () => {
  it('applyHealthMark counts per kind and keeps the latest code', () => {
    let m = applyHealthMark({}, 'auth_error', 190, NOW.toISOString());
    m = applyHealthMark(m, 'auth_error', 0, '2026-09-25T10:16:00.000Z');
    m = applyHealthMark(m, 'dead_send', undefined, NOW.toISOString());
    expect(m).toEqual({
      auth_error: { at: '2026-09-25T10:16:00.000Z', count: 2, code: 0 },
      dead_send: { at: NOW.toISOString(), count: 1 },
    });
  });

  it('parseHealthMarks is defensive: garbage / unknown kinds / bad fields ⇒ dropped', () => {
    expect(parseHealthMarks(null)).toEqual({});
    expect(parseHealthMarks('not json')).toEqual({});
    expect(parseHealthMarks('[1,2]')).toEqual({});
    expect(
      parseHealthMarks(JSON.stringify({ auth_error: { at: 'x', count: 2, code: 190 }, evil: { at: 'x', count: 1 }, dead_send: { count: 'n' } })),
    ).toEqual({ auth_error: { at: 'x', count: 2, code: 190 } });
  });

  it('healthEmailDedupeKey is per partner, kind and UTC day', () => {
    expect(healthEmailDedupeKey('acme', 'auth_error', NOW)).toBe('partnerhealth:acme:auth_error:2026-09-25');
  });

  it('normalizeAlertEmail accepts one plain address, refuses CR/LF, lists and junk', () => {
    expect(normalizeAlertEmail('  Ops@Acme.example ')).toBe('Ops@Acme.example');
    expect(normalizeAlertEmail('')).toBeNull();
    expect(normalizeAlertEmail('a@b.example\r\nBcc: x@y.example')).toBeUndefined();
    expect(normalizeAlertEmail('a@b.example, c@d.example')).toBeUndefined();
    expect(normalizeAlertEmail('not-an-email')).toBeUndefined();
    expect(normalizeAlertEmail(`${'a'.repeat(250)}@b.example`)).toBeUndefined();
  });

  it('summarizeChannelHealth: own channel with no marks ⇒ ok, no items', () => {
    const s = summarizeChannelHealth({ channel: { kind: 'own', creds: { phoneNumberId: 'p', token: 't' }, warnings: [] }, marks: {}, now: NOW });
    expect(s.level).toBe('ok');
    expect(s.channelLabel).toBe('own number');
    expect(s.items).toEqual([]);
  });

  it('summarizeChannelHealth: incomplete channel ⇒ error with the missing fields', () => {
    const s = summarizeChannelHealth({ channel: { kind: 'incomplete', missing: ['phoneNumberId'] }, marks: {}, now: NOW });
    expect(s.level).toBe('error');
    expect(s.channelLabel).toBe('incomplete');
    expect(s.items[0].kind).toBe('incomplete_config');
    expect(s.items[0].message).toContain('Phone number ID');
  });

  it('summarizeChannelHealth: shared label; recent auth error ⇒ error; marks older than 7 days are ignored', () => {
    const s = summarizeChannelHealth({
      channel: { kind: 'shared' },
      marks: {
        auth_error: { at: '2026-09-25T09:00:00.000Z', count: 3, code: 190 },
        dead_send: { at: '2026-09-10T09:00:00.000Z', count: 1 },
      },
      now: NOW,
    });
    expect(s.channelLabel).toBe('shared SmartRemit number');
    expect(s.level).toBe('error');
    expect(s.items.map((i) => i.kind)).toEqual(['auth_error']);
    expect(s.items[0].count).toBe(3);
  });

  it('summarizeChannelHealth: own-channel warnings (no app secret) ⇒ warn', () => {
    const s = summarizeChannelHealth({ channel: { kind: 'own', creds: { phoneNumberId: 'p', token: 't' }, warnings: ['appSecret'] }, marks: {}, now: NOW });
    expect(s.level).toBe('warn');
    expect(s.items[0].kind).toBe('config_warning');
  });

  it('summarizeChannelHealth: no channel (Redis-only layout read) and no marks ⇒ ok', () => {
    expect(summarizeChannelHealth({ marks: {}, now: NOW }).level).toBe('ok');
  });
});

describe('recordChannelHealth (Redis + deduped audit + daily email)', { retry: 0 }, () => {
  let db: Db;
  let redis: FakeRedis;
  let store: ReturnType<typeof createStore>;
  const deps = () => ({ store, db, now: () => NOW });

  beforeEach(async () => {
    db = await freshDb();
    redis = fakeRedis();
    store = createStore(redis, db);
    await seedPartner(db, 'acme');
    await seedPartner(db, 'beta');
  });

  const healthRows = async (partnerId: string) =>
    (await createAuditRepo(db).listByPartner(partnerId)).filter((r) => r.action === CHANNEL_HEALTH_ACTION);
  const emailRows = async () =>
    (await db.execute(sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'email.send' ORDER BY id`)).rows as Array<{
      payload: { to: string[]; subject: string; text: string };
      dedupe_key: string;
    }>;

  it('writes the Redis mark every time, ONE audit row per (partner, kind, hour)', async () => {
    await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps());
    await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps());
    const marks = parseHealthMarks(await store.readChannelHealth('acme'));
    expect(marks.auth_error).toMatchObject({ count: 2, code: 190 });
    const rows = await healthRows('acme');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'acme', actorType: 'system', meta: { kind: 'auth_error', code: 190 } });
  });

  it('never writes anything for the default tenant', async () => {
    await recordChannelHealth('default', 'dead_send', {}, deps());
    expect(await store.readChannelHealth('default')).toBeNull();
    expect(await healthRows('default')).toHaveLength(0);
  });

  it('audit:false (a site that writes its own audit row) ⇒ Redis mark only', async () => {
    await recordChannelHealth('acme', 'no_phone', { audit: false }, deps());
    expect(parseHealthMarks(await store.readChannelHealth('acme')).no_phone).toMatchObject({ count: 1 });
    expect(await healthRows('acme')).toHaveLength(0);
  });

  it('no alert email set ⇒ no email row (banner only)', async () => {
    await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps());
    expect(await emailRows()).toHaveLength(0);
  });

  it('alert email set ⇒ ONE fixed-text email per (partner, kind, day), to that address only', async () => {
    await createPartnerRepo(db).updateSupportConfig('acme', (prev) => ({ ...prev, alertEmail: 'ops@acme.example' }));
    await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps());
    await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps());
    await recordChannelHealth('acme', 'no_phone', { audit: false }, deps()); // not an alertable kind
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe('partnerhealth:acme:auth_error:2026-09-25');
    expect(rows[0].payload.to).toEqual(['ops@acme.example']);
    expect(rows[0].payload.text).toContain('/admin-dashboard/partners/acme');
    expect(rows[0].payload.text).not.toMatch(/token\s*[:=]/i);
  });

  it('is best-effort: a Redis failure never throws', async () => {
    const broken = { ...store, readChannelHealth: async () => { throw new Error('redis down'); } } as typeof store;
    await expect(recordChannelHealth('acme', 'dead_send', {}, { store: broken, db, now: () => NOW })).resolves.toBe(false);
  });

  it('returns true only when it queued a NEW alert email (so the caller can poke the worker)', async () => {
    expect(await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps())).toBe(false); // no alert address
    await createPartnerRepo(db).updateSupportConfig('beta', (prev) => ({ ...prev, alertEmail: 'ops@beta.example' }));
    expect(await recordChannelHealth('beta', 'auth_error', { code: 190 }, deps())).toBe(true);
    expect(await recordChannelHealth('beta', 'auth_error', { code: 190 }, deps())).toBe(false); // same hour: deduped
    expect(await recordChannelHealth('beta', 'delivery_failed', { code: 131026 }, deps())).toBe(false); // not alertable
  });

  it('cross-tenant: A’s events never appear in B’s health read', async () => {
    await recordChannelHealth('acme', 'auth_error', { code: 190 }, deps());
    const b = await getChannelHealth('beta', { store, db, now: () => NOW, includeChannel: false });
    expect(b.marks).toEqual({});
    expect(b.events).toEqual([]);
    const a = await getChannelHealth('acme', { store, db, now: () => NOW, includeChannel: false });
    expect(a.events).toHaveLength(1);
    expect(a.marks.auth_error?.count).toBe(1);
  });
});

describe('clearHealthMarks / clearChannelHealthMarks', () => {
  it('drops only the given kinds', async () => {
    const { clearHealthMarks } = await import('@/lib/channel-health');
    const m = applyHealthMark(applyHealthMark({}, 'auth_error', 190, NOW.toISOString()), 'no_phone', undefined, NOW.toISOString());
    expect(Object.keys(clearHealthMarks(m, ['auth_error', 'incomplete_config']))).toEqual(['no_phone']);
  });

  it('clearChannelHealthMarks rewrites the Redis marks; a store failure never throws', async () => {
    const { clearChannelHealthMarks } = await import('@/lib/channel-health');
    let saved = JSON.stringify(applyHealthMark({}, 'auth_error', 190, NOW.toISOString()));
    const store = { readChannelHealth: async () => saved, writeChannelHealth: async (_p: string, j: string) => { saved = j; } };
    await clearChannelHealthMarks('acme', ['auth_error'], { store });
    expect(JSON.parse(saved)).toEqual({});
    const broken = { readChannelHealth: async () => { throw new Error('down'); }, writeChannelHealth: async () => {} };
    await expect(clearChannelHealthMarks('acme', ['auth_error'], { store: broken })).resolves.toBeUndefined();
  });
});

describe('parseChannelTest', () => {
  it('keeps ok/at/status/reason; drops junk', async () => {
    const { parseChannelTest } = await import('@/lib/channel-health');
    expect(parseChannelTest(null)).toBeNull();
    expect(parseChannelTest('x')).toBeNull();
    expect(parseChannelTest(JSON.stringify({ ok: 'yes', at: 'a' }))).toBeNull();
    expect(parseChannelTest(JSON.stringify({ ok: false, at: 'a', status: 401, reason: 'probe_failed', token: 'EAA' }))).toEqual({
      ok: false, at: 'a', status: 401, reason: 'probe_failed',
    });
  });
});

describe('channelBannerModel (the banner a page renders)', () => {
  it('ok ⇒ null (no banner, no layout row)', async () => {
    const { channelBannerModel } = await import('@/lib/channel-health');
    expect(channelBannerModel({ level: 'ok', items: [] }, 'acme')).toBeNull();
  });

  it('error ⇒ destructive banner linking to the partner WhatsApp tab, one line per item', async () => {
    const { channelBannerModel } = await import('@/lib/channel-health');
    const s = summarizeChannelHealth({
      channel: { kind: 'incomplete', missing: ['token'] },
      marks: { auth_error: { at: NOW.toISOString(), count: 2, code: 190 } },
      now: NOW,
    });
    const m = channelBannerModel(s, 'acme')!;
    expect(m.variant).toBe('destructive');
    expect(m.href).toBe('/admin-dashboard/partners/acme');
    expect(m.title).toMatch(/needs attention/i);
    expect(m.lines).toHaveLength(2);
    expect(m.lines[1]).toContain('×2');
  });

  it('warn ⇒ default banner', async () => {
    const { channelBannerModel } = await import('@/lib/channel-health');
    const s = summarizeChannelHealth({ marks: { no_phone: { at: NOW.toISOString(), count: 1 } }, now: NOW });
    expect(channelBannerModel(s, 'acme')!.variant).toBe('default');
  });
});
