import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  FLAG_CACHE_TTL_MS,
  FLAG_DEFINITIONS,
  FLAG_KEYS,
  SendsPausedError,
  activeKillSwitches,
  invalidateFlagCache,
  isFlagOn,
  isKnownFlagKey,
  matchingRows,
  parseTenantScopeId,
  readFlag,
  tenantScopeId,
  type FlagContext,
} from '@/lib/flags';
import { createFeatureFlagRepo, type FlagRow } from '@/db/repos/feature-flag-repo';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Release safety Batch 2 part A: the flag table, isFlagOn and the sends.paused
// kill switch at the mint chokepoint.

const row = (over: Partial<FlagRow>): FlagRow => ({
  key: 'sends.paused',
  scopeType: 'global',
  scopeId: '',
  enabled: true,
  reason: 'test reason',
  updatedBy: 'admin',
  updatedAt: new Date(),
  ...over,
});

async function setFlag(db: Db, key: string, scopeType: 'global' | 'partner' | 'corridor', scopeId: string, enabled = true) {
  await createFeatureFlagRepo(db).upsert({ key, scopeType, scopeId, enabled, reason: 'test pause reason', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

describe('flag definitions', () => {
  it('defines the two kill switches with every scope', () => {
    expect([...FLAG_KEYS].sort()).toEqual(['agent.paused', 'agent.reply_guard', 'agent.tools', 'agent.tools.paused', 'paylinks.enabled', 'portal.skins', 'purpose.detect', 'rewards.enabled', 'sends.paused', 'settlement.paused', 'telegram.bot', 'voice.notes']);
    for (const k of ['sends.paused', 'settlement.paused'] as const) {
      expect(FLAG_DEFINITIONS[k].killSwitch).toBe(true);
      expect(FLAG_DEFINITIONS[k].scopes).toEqual(['global', 'partner', 'corridor']);
    }
  });

  // Site skins (owner go 2026-11-09): the switch of tgfl.smartremit.ai. One address, so global only.
  it('portal.skins is a global-only feature switch, off with no row, on with the global row', async () => {
    const def = FLAG_DEFINITIONS['portal.skins'];
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global']);
    expect(def.label).toBe('TGFL demo portal');
    const db = await freshDb();
    invalidateFlagCache(db);
    expect(await isFlagOn(db, 'portal.skins')).toBe(false);
    await setFlag(db, 'portal.skins', 'global', '');
    expect(await isFlagOn(db, 'portal.skins')).toBe(true);
    await setFlag(db, 'portal.skins', 'global', '', false);
    expect(await isFlagOn(db, 'portal.skins')).toBe(false);
  });

  it('B2: paylinks.enabled is an ordinary feature switch (global or one partner), off with no row', async () => {
    const def = FLAG_DEFINITIONS['paylinks.enabled'];
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global', 'partner']);
    const db = await freshDb();
    invalidateFlagCache(db);
    expect(await isFlagOn(db, 'paylinks.enabled', { partnerId: 'default' })).toBe(false);
    await setFlag(db, 'paylinks.enabled', 'partner', 'default');
    expect(await isFlagOn(db, 'paylinks.enabled', { partnerId: 'default' })).toBe(true);
    expect(await isFlagOn(db, 'paylinks.enabled', { partnerId: 'other' })).toBe(false);
  });

  it('Stage C1: agent.tools is "AI agent tools (test)", global or one partner, off with no row', async () => {
    const def = FLAG_DEFINITIONS['agent.tools'];
    expect(def.label).toBe('AI agent tools (test)');
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global', 'partner']);
    const db = await freshDb();
    invalidateFlagCache(db);
    expect(await isFlagOn(db, 'agent.tools', { partnerId: 'default' })).toBe(false);
    await setFlag(db, 'agent.tools', 'partner', 'default');
    expect(await isFlagOn(db, 'agent.tools', { partnerId: 'default' })).toBe(true);
    expect(await isFlagOn(db, 'agent.tools', { partnerId: 'other' })).toBe(false);
  });

  it('R32: agent.reply_guard is a feature switch (global, partner or corridor), off with no row (off = shadow, alerts only)', async () => {
    const def = FLAG_DEFINITIONS['agent.reply_guard'];
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global', 'partner', 'corridor']);
    expect(def.description).toMatch(/shadow/i);
    expect(def.description).toMatch(/replace/i);
    const db = await freshDb();
    invalidateFlagCache(db);
    expect(await isFlagOn(db, 'agent.reply_guard', { partnerId: 'default', corridor: 'IN' })).toBe(false);
    await setFlag(db, 'agent.reply_guard', 'corridor', 'MX');
    expect(await isFlagOn(db, 'agent.reply_guard', { partnerId: 'default', corridor: 'MX' })).toBe(true);
    expect(await isFlagOn(db, 'agent.reply_guard', { partnerId: 'default', corridor: 'IN' })).toBe(false);
    await setFlag(db, 'agent.reply_guard', 'partner', 'acme');
    expect(await isFlagOn(db, 'agent.reply_guard', { partnerId: 'acme' })).toBe(true);
  });

  // Fix pack 3 T7 (R26, contract 10): the two AI-agent kill switches.
  it('agent.paused and agent.tools.paused are kill switches, global or one partner, off with no row', async () => {
    expect(FLAG_DEFINITIONS['agent.paused']).toMatchObject({
      key: 'agent.paused',
      label: 'Pause the AI agent',
      bannerText: 'The AI agent is paused',
      description:
        'Customers get the fixed menu instead of the AI agent; HELP still reaches a person. Transfers, pay pages and notices continue.',
      killSwitch: true,
      scopes: ['global', 'partner'],
    });
    expect(FLAG_DEFINITIONS['agent.tools.paused']).toMatchObject({
      key: 'agent.tools.paused',
      label: 'Pause AI agent tools',
      bannerText: 'AI agent tools are paused',
      description:
        'Connected AI apps get "SmartRemit AI tools are switched off." and no new connection starts, whatever "AI agent tools (test)" says.',
      killSwitch: true,
      scopes: ['global', 'partner'],
    });
    const db = await freshDb();
    invalidateFlagCache(db);
    for (const k of ['agent.paused', 'agent.tools.paused'] as const) {
      expect(await isFlagOn(db, k, { partnerId: 'acme' })).toBe(false);
      await setFlag(db, k, 'partner', 'acme');
      expect(await isFlagOn(db, k, { partnerId: 'acme' })).toBe(true);
      expect(await isFlagOn(db, k, { partnerId: 'default' })).toBe(false);
      await setFlag(db, k, 'global', '');
      expect(await isFlagOn(db, k, { partnerId: 'default' })).toBe(true);
    }
    invalidateFlagCache(db);
  });

  it('partnerOperable and tenantCorridor: exactly sends.paused, settlement.paused (both true); agent.paused, agent.tools.paused (operable, no corridor); every other key false/false', () => {
    const table = Object.fromEntries(FLAG_KEYS.map((k) => [k, [FLAG_DEFINITIONS[k].partnerOperable, FLAG_DEFINITIONS[k].tenantCorridor]]));
    expect(table).toEqual({
      'sends.paused': [true, true],
      'settlement.paused': [true, true],
      'agent.paused': [true, false],
      'agent.tools.paused': [true, false],
      'voice.notes': [false, false],
      'purpose.detect': [false, false],
      'rewards.enabled': [false, false],
      'paylinks.enabled': [false, false],
      'telegram.bot': [false, false],
      'agent.tools': [false, false],
      'agent.reply_guard': [false, false],
      'portal.skins': [false, false],
    });
  });

  it('voice.notes is an ordinary feature switch (global or one partner), not a kill switch', () => {
    const def = FLAG_DEFINITIONS['voice.notes'];
    expect(def.label).toBe('Voice notes');
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global', 'partner']);
    expect(isKnownFlagKey('voice.notes')).toBe(true);
  });

  it('voice.notes is off with no row and on with a global or default-partner row', async () => {
    const db = await freshDb();
    expect(await isFlagOn(db, 'voice.notes', { partnerId: 'default' })).toBe(false);
    await setFlag(db, 'voice.notes', 'partner', 'default');
    expect(await isFlagOn(db, 'voice.notes', { partnerId: 'default' })).toBe(true);
    expect(await isFlagOn(db, 'voice.notes', { partnerId: 'acme' })).toBe(false);
  });

  it('purpose.detect is an ordinary feature switch (global or one partner) that says the purpose reaches the payout partner', () => {
    const def = FLAG_DEFINITIONS['purpose.detect'];
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global', 'partner']);
    expect(def.description).toMatch(/settlement instruction/i);
    expect(def.description).toMatch(/payout partner/i);
    // Required purpose (owner decision 2026-10-08): every customer, and the switch is only the bot's OFF switch.
    expect(def.description).not.toMatch(/DEMO_PHONES/);
    expect(def.description).toMatch(/every customer/i);
    expect(def.description).toMatch(/asks once/i);
    expect(def.description).toMatch(/Off[^.]*optional/i);
    expect(def.description).toMatch(/portal[^.]*Partner API[^.]*(always|whatever)/i);
    expect(def.label).toBe('Required purpose (bot)');
    expect(isKnownFlagKey('purpose.detect')).toBe(true);
  });

  it('purpose.detect is off with no row; a partner row is that partner only', async () => {
    const db = await freshDb();
    expect(await isFlagOn(db, 'purpose.detect', { partnerId: 'acme' })).toBe(false);
    await setFlag(db, 'purpose.detect', 'partner', 'acme');
    expect(await isFlagOn(db, 'purpose.detect', { partnerId: 'acme' })).toBe(true);
    expect(await isFlagOn(db, 'purpose.detect', { partnerId: 'default' })).toBe(false);
  });

  it('rewards.enabled (B3) is a feature switch (global or one partner), off with no row, demo-mode only', async () => {
    const def = FLAG_DEFINITIONS['rewards.enabled'];
    expect(def.killSwitch).toBe(false);
    expect(def.scopes).toEqual(['global', 'partner']);
    expect(def.description).toMatch(/DEMO_PHONES/);
    expect(def.description).toMatch(/First transfer free works either way/);
    const db = await freshDb();
    expect(await isFlagOn(db, 'rewards.enabled', { partnerId: 'default' })).toBe(false);
    await setFlag(db, 'rewards.enabled', 'partner', 'default');
    expect(await isFlagOn(db, 'rewards.enabled', { partnerId: 'default' })).toBe(true);
    expect(await isFlagOn(db, 'rewards.enabled', { partnerId: 'acme' })).toBe(false);
  });

  it('isKnownFlagKey accepts only defined keys', () => {
    expect(isKnownFlagKey('sends.paused')).toBe(true);
    expect(isKnownFlagKey('settlement.paused')).toBe(true);
    expect(isKnownFlagKey('sanctions.off')).toBe(false);
    expect(isKnownFlagKey('toString')).toBe(false);
    expect(isKnownFlagKey(undefined)).toBe(false);
  });
});

describe('matchingRows (pure)', () => {
  it('a global row matches every request', () => {
    expect(matchingRows([row({})], 'sends.paused', {})).toHaveLength(1);
    expect(matchingRows([row({})], 'sends.paused', { partnerId: 'acme', corridor: 'IN' })).toHaveLength(1);
  });

  it('a partner row matches only that partner (any of several)', () => {
    const rows = [row({ scopeType: 'partner', scopeId: 'acme' })];
    expect(matchingRows(rows, 'sends.paused', { partnerId: 'acme' })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { partnerId: ['default', 'acme'] })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { partnerId: 'default' })).toHaveLength(0);
    expect(matchingRows(rows, 'sends.paused', { partnerId: [null, undefined] })).toHaveLength(0);
    expect(matchingRows(rows, 'sends.paused', {})).toHaveLength(0);
  });

  it('a corridor row matches only that destination country, case-insensitive', () => {
    const rows = [row({ scopeType: 'corridor', scopeId: 'IN' })];
    expect(matchingRows(rows, 'sends.paused', { corridor: 'IN' })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { corridor: 'in' })).toHaveLength(1);
    expect(matchingRows(rows, 'sends.paused', { corridor: 'PH' })).toHaveLength(0);
    expect(matchingRows(rows, 'sends.paused', {})).toHaveLength(0);
  });

  it('ignores disabled rows and other keys', () => {
    expect(matchingRows([row({ enabled: false })], 'sends.paused', {})).toHaveLength(0);
    expect(matchingRows([row({ key: 'settlement.paused' })], 'sends.paused', {})).toHaveLength(0);
  });
});

// Fix pack 3 T7 (R26, contract 10): partner-set pauses are 'partner' rows whose
// scope id is `tenant:<id>` or `tenant:<id>:<CC>`.
describe('tenant scope ids (pure)', () => {
  it("tenantScopeId: 'tenant:acme', 'tenant:acme:IN'", () => {
    expect(tenantScopeId('acme')).toBe('tenant:acme');
    expect(tenantScopeId('acme', 'IN')).toBe('tenant:acme:IN');
  });

  it("parseTenantScopeId round-trips; lower-case cc normalised; refuses '', 'acme', 'tenant:', 'tenant:a b', 'tenant:x:ZZ', 'tenant:x:IN:y', a 129-char id", () => {
    expect(parseTenantScopeId(tenantScopeId('acme'))).toEqual({ partnerId: 'acme' });
    expect(parseTenantScopeId(tenantScopeId('acme', 'IN'))).toEqual({ partnerId: 'acme', corridor: 'IN' });
    expect(parseTenantScopeId('tenant:Acme_9-x:in')).toEqual({ partnerId: 'Acme_9-x', corridor: 'IN' });
    expect(parseTenantScopeId(`tenant:${'a'.repeat(128)}`)).toEqual({ partnerId: 'a'.repeat(128) });
    expect(parseTenantScopeId('tenant:acme')).not.toHaveProperty('corridor');
    for (const bad of ['', 'acme', 'tenant:', 'tenant:a b', 'tenant:x:ZZ', 'tenant:x:IN:y', `tenant:${'a'.repeat(129)}`, 'tenant:x:', 'Tenant:x']) {
      expect(parseTenantScopeId(bad), bad).toBeNull();
    }
  });
});

describe('matchingRows and tenant rows (pure)', () => {
  const tenantRow = (scopeId: string) => row({ key: 'settlement.paused', scopeType: 'partner', scopeId });

  it('a tenant row matches a partner in tenants', () => {
    const rows = [tenantRow('tenant:acme')];
    expect(matchingRows(rows, 'settlement.paused', { tenants: ['acme', 'railp'] })).toHaveLength(1);
    expect(matchingRows(rows, 'settlement.paused', { tenants: 'acme' })).toHaveLength(1);
    expect(matchingRows(rows, 'settlement.paused', { tenants: [null, undefined, 'other'] })).toHaveLength(0);
  });

  it('tenants absent = the ctx.partnerId set', () => {
    const rows = [tenantRow('tenant:acme')];
    expect(matchingRows(rows, 'settlement.paused', { partnerId: ['default', 'acme'] })).toHaveLength(1);
    expect(matchingRows(rows, 'settlement.paused', { partnerId: 'default' })).toHaveLength(0);
    expect(matchingRows(rows, 'settlement.paused', {})).toHaveLength(0);
  });

  it('with tenants [owner], a tenant row of the routed rail partner does not match, a platform partner row of it still does', () => {
    const ctx: FlagContext = { partnerId: ['acme', 'railp'], tenants: ['acme'] };
    expect(matchingRows([tenantRow('tenant:railp')], 'settlement.paused', ctx)).toHaveLength(0);
    expect(matchingRows([tenantRow('railp')], 'settlement.paused', ctx)).toHaveLength(1);
    expect(matchingRows([tenantRow('tenant:acme')], 'settlement.paused', ctx)).toHaveLength(1);
  });

  it('a tenant corridor row matches only that corridor', () => {
    const rows = [tenantRow('tenant:acme:IN')];
    expect(matchingRows(rows, 'settlement.paused', { partnerId: 'acme', corridor: 'IN' })).toHaveLength(1);
    expect(matchingRows(rows, 'settlement.paused', { partnerId: 'acme', corridor: 'in' })).toHaveLength(1);
    expect(matchingRows(rows, 'settlement.paused', { partnerId: 'acme', corridor: 'PH' })).toHaveLength(0);
    expect(matchingRows(rows, 'settlement.paused', { partnerId: 'acme' })).toHaveLength(0);
    expect(matchingRows(rows, 'settlement.paused', { partnerId: 'other', corridor: 'IN' })).toHaveLength(0);
  });

  it('an unparsable tenant: id never matches, even when ctx.partnerId equals the raw scope id', () => {
    for (const id of ['tenant:', 'tenant:a b', 'tenant:x:ZZ', 'tenant:x:IN:y']) {
      expect(matchingRows([tenantRow(id)], 'settlement.paused', { partnerId: id, tenants: [id] }), id).toHaveLength(0);
    }
  });

  // Rollback safety: the build before pack 3 ignores tenant rows (no partner id
  // starts 'tenant:'), so an Instant Rollback never pauses anyone by accident.
  it('legacy matcher pin: the pre-pack-3 rule (copied into the test as legacyMatchingRows) ignores tenant: rows', () => {
    function legacyMatchingRows(rows: readonly FlagRow[], key: string, ctx: { partnerId?: string | readonly (string | null | undefined)[] | null; corridor?: string | null } = {}): FlagRow[] {
      const partners = new Set(
        (Array.isArray(ctx.partnerId) ? ctx.partnerId : [ctx.partnerId]).filter(
          (p): p is string => typeof p === 'string' && p !== '',
        ),
      );
      const corridor = (ctx.corridor ?? '').toUpperCase();
      return rows.filter((r) => {
        if (!r.enabled || r.key !== key) return false;
        if (r.scopeType === 'global') return true;
        if (r.scopeType === 'partner') return partners.has(r.scopeId);
        if (r.scopeType === 'corridor') return corridor !== '' && r.scopeId.toUpperCase() === corridor;
        return false;
      });
    }
    const rows = [tenantRow('tenant:acme'), tenantRow('tenant:acme:IN')];
    expect(legacyMatchingRows(rows, 'settlement.paused', { partnerId: ['acme', 'railp'], corridor: 'IN' })).toHaveLength(0);
    expect(matchingRows(rows, 'settlement.paused', { partnerId: ['acme', 'railp'], corridor: 'IN' })).toHaveLength(2);
  });
});

describe('readFlag (Postgres)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    invalidateFlagCache(db);
  });
  afterEach(() => {
    invalidateFlagCache(db);
    vi.restoreAllMocks();
  });

  it("no rows 'off'; global row 'on'; tenant row 'on' for its tenant", async () => {
    expect(await readFlag(db, 'settlement.paused', { partnerId: 'acme' })).toBe('off');
    await createFeatureFlagRepo(db).upsert({
      key: 'settlement.paused', scopeType: 'partner', scopeId: tenantScopeId('acme'), enabled: true, reason: 'tenant pause', updatedBy: 'admin',
    });
    invalidateFlagCache(db);
    expect(await readFlag(db, 'settlement.paused', { partnerId: 'acme' })).toBe('on');
    expect(await readFlag(db, 'settlement.paused', { partnerId: 'other' })).toBe('off');
    await setFlag(db, 'sends.paused', 'global', '');
    expect(await readFlag(db, 'sends.paused', { partnerId: 'other' })).toBe('on');
  });

  it("a read failure is 'unknown', never throws, logs flags.read", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      select: () => {
        throw new Error('neon down');
      },
    } as unknown as Db;
    expect(await readFlag(broken, 'settlement.paused', { partnerId: 'acme' })).toBe('unknown');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('flags.read');
  });

  it("isFlagOn === (readFlag === 'on') and shares the 15 s snapshot", async () => {
    await setFlag(db, 'sends.paused', 'partner', tenantScopeId('acme'));
    const t0 = Date.now();
    const stop = captureQueries();
    const read = await readFlag(db, 'sends.paused', { partnerId: 'acme' }, t0);
    const on = await isFlagOn(db, 'sends.paused', { partnerId: 'acme' }, t0 + 1);
    const offRead = await readFlag(db, 'sends.paused', { partnerId: 'other' }, t0 + 2);
    const off = await isFlagOn(db, 'sends.paused', { partnerId: 'other' }, t0 + 3);
    const selects = stop().filter((q) => /feature_flags/.test(q.sql));
    expect([read, on, offRead, off]).toEqual(['on', true, 'off', false]);
    expect(selects).toHaveLength(1);
  });
});

describe('isFlagOn (Postgres)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    invalidateFlagCache(db);
  });
  afterEach(() => {
    invalidateFlagCache(db);
    vi.restoreAllMocks();
  });

  it('no rows ⇒ off', async () => {
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'default', corridor: 'IN' })).toBe(false);
  });

  it('reads global, partner and corridor rows', async () => {
    await setFlag(db, 'sends.paused', 'partner', 'acme');
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'acme' })).toBe(true);
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'default' })).toBe(false);
    await setFlag(db, 'sends.paused', 'corridor', 'PH');
    expect(await isFlagOn(db, 'sends.paused', { partnerId: 'default', corridor: 'PH' })).toBe(true);
    await setFlag(db, 'settlement.paused', 'global', '');
    expect(await isFlagOn(db, 'settlement.paused', {})).toBe(true);
  });

  it('an upsert turns a row off again (one row per key and scope)', async () => {
    await setFlag(db, 'sends.paused', 'global', '');
    expect(await isFlagOn(db, 'sends.paused')).toBe(true);
    await setFlag(db, 'sends.paused', 'global', '', false);
    expect(await isFlagOn(db, 'sends.paused')).toBe(false);
    expect(await createFeatureFlagRepo(db).listAll()).toHaveLength(1);
  });

  it('caches the snapshot for FLAG_CACHE_TTL_MS per instance', async () => {
    const t0 = 1_000_000;
    expect(await isFlagOn(db, 'sends.paused', {}, t0)).toBe(false);
    // A write without invalidation is invisible until the TTL passes.
    await createFeatureFlagRepo(db).upsert({
      key: 'sends.paused', scopeType: 'global', scopeId: '', enabled: true, reason: 'cache test', updatedBy: 'admin',
    });
    expect(await isFlagOn(db, 'sends.paused', {}, t0 + FLAG_CACHE_TTL_MS - 1)).toBe(false);
    expect(await isFlagOn(db, 'sends.paused', {}, t0 + FLAG_CACHE_TTL_MS)).toBe(true);
  });

  it('a read failure is off (fail open) and never throws', async () => {
    const broken = {
      select: () => {
        throw new Error('neon down');
      },
    } as unknown as Db;
    expect(await isFlagOn(broken, 'sends.paused')).toBe(false);
    expect(await activeKillSwitches(broken)).toEqual([]);
  });

  it('the CHECK constraints refuse an unknown scope type and a global row with a scope id', async () => {
    await expect(
      db.execute(sql`INSERT INTO feature_flags (key, scope_type, scope_id, enabled, updated_by) VALUES ('sends.paused','team','x',true,'a')`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO feature_flags (key, scope_type, scope_id, enabled, updated_by) VALUES ('sends.paused','global','x',true,'a')`),
    ).rejects.toThrow();
  });

  it('activeKillSwitches lists only enabled rows of known kill-switch keys', async () => {
    await setFlag(db, 'sends.paused', 'corridor', 'IN');
    await setFlag(db, 'settlement.paused', 'global', '', false);
    await createFeatureFlagRepo(db).upsert({
      key: 'unknown.key', scopeType: 'global', scopeId: '', enabled: true, reason: 'x', updatedBy: 'a',
    });
    invalidateFlagCache(db);
    const active = await activeKillSwitches(db);
    expect(active.map((r) => `${r.key}:${r.scopeType}:${r.scopeId}`)).toEqual(['sends.paused:corridor:IN']);
  });
});

describe('sends.paused at the mint chokepoint (createTransferWithOutcome)', () => {
  const base = {
    phone: '15551234567',
    amountSource: 50,
    sourceCurrency: 'USD' as const,
    partnerId: 'default',
    recipientName: 'Mom',
    recipientPhone: '919133001840',
    payoutMethod: 'upi' as const,
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer' as const,
    senderKycStatus: 'verified' as const,
  };

  async function makeStores() {
    const redis = fakeRedis();
    const db = await freshDb();
    invalidateFlagCache(db);
    return { db, store: createStore(redis, db), partnerStore: createPartnerStore(db), mvs: createMonthlyVolumeStore(createStore(redis, db)) };
  }

  beforeEach(() => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function countTransfers(db: Db): Promise<number> {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM transfers`);
    return Number((r as unknown as { rows: Array<{ n: number }> }).rows[0].n);
  }

  it('a global pause refuses the mint and writes nothing (no transfer, no audit row)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'global', '');
    await expect(createTransfer(store, partnerStore, mvs, base)).rejects.toBeInstanceOf(SendsPausedError);
    expect(await countTransfers(db)).toBe(0);
    const audits = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`);
    expect(Number((audits as unknown as { rows: Array<{ n: number }> }).rows[0].n)).toBe(0);
    invalidateFlagCache(db);
  });

  it('a partner pause refuses only that partner', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await setFlag(db, 'sends.paused', 'partner', 'acme');
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' })).rejects.toBeInstanceOf(SendsPausedError);
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.status).toBe('awaiting_payment');
    invalidateFlagCache(db);
  });

  it('a corridor pause refuses only that destination country (default IN)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'corridor', 'PH');
    const t = await createTransfer(store, partnerStore, mvs, base); // IN: not paused
    expect(t.status).toBe('awaiting_payment');
    await setFlag(db, 'sends.paused', 'corridor', 'IN');
    await expect(createTransfer(store, partnerStore, mvs, base)).rejects.toBeInstanceOf(SendsPausedError);
    invalidateFlagCache(db);
  });

  it('a pause on the routed rail partner refuses a routed mint', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'railco');
    await setFlag(db, 'sends.paused', 'partner', 'railco');
    const quote = {
      amountUsd: 50, feeUsd: 0, totalChargeUsd: 50, fxRate: 85, amountInr: 4250,
      amountSource: 50, feeSource: 0, totalChargeSource: 50,
    };
    await expect(
      createTransfer(store, partnerStore, mvs, { ...base, quote, settlementPartnerId: 'railco' }),
    ).rejects.toBeInstanceOf(SendsPausedError);
    invalidateFlagCache(db);
  });

  it('a tenant pause of the owner refuses the mint', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await setFlag(db, 'sends.paused', 'partner', tenantScopeId('acme'));
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' })).rejects.toBeInstanceOf(SendsPausedError);
    expect(await countTransfers(db)).toBe(0);
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.status).toBe('awaiting_payment');
    invalidateFlagCache(db);
  });

  it('a tenant pause of the ROUTED rail partner does not refuse (tenants [owner])', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'railco');
    await setFlag(db, 'sends.paused', 'partner', tenantScopeId('railco'));
    const quote = {
      amountUsd: 50, feeUsd: 0, totalChargeUsd: 50, fxRate: 85, amountInr: 4250,
      amountSource: 50, feeSource: 0, totalChargeSource: 50,
    };
    const t = await createTransfer(store, partnerStore, mvs, { ...base, quote, settlementPartnerId: 'railco' });
    expect(t.status).toBe('awaiting_payment');
    invalidateFlagCache(db);
  });

  it('a tenant corridor pause refuses only that corridor', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await seedPartner(db, 'acme');
    await setFlag(db, 'sends.paused', 'partner', tenantScopeId('acme', 'MX'));
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' }); // IN: not paused
    expect(t.status).toBe('awaiting_payment');
    await setFlag(db, 'sends.paused', 'partner', tenantScopeId('acme', 'IN'));
    await expect(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' })).rejects.toBeInstanceOf(SendsPausedError);
    invalidateFlagCache(db);
  });

  it('a sandbox (test-key) mint is never paused', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'global', '');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, environment: 'test' });
    expect(t.environment).toBe('test');
    invalidateFlagCache(db);
  });

  it('the refusal comes before the KYC backstop is bypassed: an unverified sender still gets kyc_required first', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await setFlag(db, 'sends.paused', 'global', '');
    await expect(
      createTransfer(store, partnerStore, mvs, { ...base, senderKycStatus: 'not_started' }),
    ).rejects.toThrow('kyc_required');
    invalidateFlagCache(db);
  });
});
