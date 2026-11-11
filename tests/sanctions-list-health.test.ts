import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import {
  checkSanctionsListHealth,
  listNotLiveDedupeKey,
  sanctionsListFitnessNow,
  sanctionsListStatus,
} from '@/lib/sanctions/list-health';
import { easternDay } from '@/lib/sanctions/list-loader';
import { setListSourceForTests, setOfacListSourceForTests } from '@/lib/providers/sanctions-provider';
import { SANCTIONS_SOURCES, type SanctionsSourceId } from '@/lib/sanctions/list-sets';
import { WATCHLIST } from '@/lib/compliance-config';
import { LIST_SET_NAMES, listSetList, primeListSet, primeOfacSource, restoreOfacSource } from './helpers-sanctions';

// Fix pack 2 T2 (R02): the sanctions list health check. The daily cron (and the
// mint, through the same dedupe key) raises ONE ops.alert per Eastern day when
// the list is not live AND at least one partner settles on a real-money (http)
// rail. The age is the DB checked_at; the alert carries counts and ages only.

const LIST = parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));
const HOUR = 3_600_000;

async function setRail(db: Db, partnerId: string, providerType: string) {
  await seedPartner(db, partnerId);
  await db.execute(sql`
    INSERT INTO partner_integrations (partner_id, payment_provider_type) VALUES (${partnerId}, ${providerType})
    ON CONFLICT (partner_id) DO UPDATE SET payment_provider_type = ${providerType}`);
}

async function loadList(db: Db, checkedAgoMs: number) {
  await createSanctionsListRepo(db).storeList(LIST);
  await db.execute(sql`UPDATE sanctions_list_versions SET checked_at = ${new Date(Date.now() - checkedAgoMs)}`);
}

async function alertRows(db: Db) {
  const r = await db.execute(sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
  return (r as unknown as { rows: Array<{ payload: Record<string, unknown>; dedupe_key: string }> }).rows;
}

describe('sanctions list health (fix pack 2 R02)', () => {
  let db: Db;
  const original = process.env.SANCTIONS_LIST;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(() => {
    restoreOfacSource(original);
    vi.restoreAllMocks();
  });

  it('the dedupe key is per Eastern day', () => {
    const now = new Date();
    expect(listNotLiveDedupeKey(now)).toBe(`sanctions-list-not-live:${easternDay(now.getTime())}`);
  });

  it('no http partner -> no alert', async () => {
    delete process.env.SANCTIONS_LIST;
    await setRail(db, 'simco', 'simulator');
    expect(await checkSanctionsListHealth(db, new Date())).toEqual({ alerted: false });
    expect(await alertRows(db)).toEqual([]);
  });

  it('http + mock setting -> one alert, still one on repeat', async () => {
    delete process.env.SANCTIONS_LIST;
    await setRail(db, 'acme', 'http');
    const now = new Date();
    expect(await checkSanctionsListHealth(db, now)).toEqual({ alerted: true });
    expect(await checkSanctionsListHealth(db, now)).toEqual({ alerted: false });
    const rows = await alertRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(listNotLiveDedupeKey(now));
    expect(Object.keys(rows[0].payload)).toEqual(['message']);
    expect(String(rows[0].payload.message)).toMatch(/sanctions list is not live/);
  });

  it('fresh -> none', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await setRail(db, 'acme', 'http');
    await loadList(db, HOUR);
    expect(await checkSanctionsListHealth(db, new Date())).toEqual({ alerted: false });
    expect(await alertRows(db)).toEqual([]);
  });

  it('40 h old -> one', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await setRail(db, 'acme', 'http');
    await loadList(db, 40 * HOUR);
    expect(await checkSanctionsListHealth(db, new Date())).toEqual({ alerted: true });
    const rows = await alertRows(db);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].payload.message)).toContain('40 h');
  });

  it('ofac-sdn with nothing loaded -> one', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await setRail(db, 'acme', 'http');
    expect(await checkSanctionsListHealth(db, new Date())).toEqual({ alerted: true });
  });

  // Pack 2 review R4 (E5): an active version whose stored entries do not
  // match its entry_count (a pruned row an older build re-activated) cannot
  // be screened on (loadList throws), so it is not live, and the daily
  // check alerts, however fresh its checked_at.
  it('fresh checked_at but the active version lost its entries -> not live, one alert', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await setRail(db, 'acme', 'http');
    await loadList(db, HOUR);
    await db.execute(sql`DELETE FROM sanctions_list_entries`);
    const s = await sanctionsListStatus(db, new Date());
    expect(s.fitness).toBe('not_live');
    expect(s.entryCount).toBe(LIST.entries.length);
    expect(await checkSanctionsListHealth(db, new Date())).toEqual({ alerted: true });
    expect(await alertRows(db)).toHaveLength(1);
  });

  it('a partial entry set (one row missing) is not live either', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await loadList(db, HOUR);
    await db.execute(sql`DELETE FROM sanctions_list_entries WHERE entry_id = ${LIST.entries[0].id}`);
    expect((await sanctionsListStatus(db, new Date())).fitness).toBe('not_live');
  });

  it('db error -> no throw', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await setRail(db, 'acme', 'http');
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      await expect(checkSanctionsListHealth(db, new Date())).resolves.toEqual({ alerted: false });
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
    const broken = { execute: () => { throw new Error('boom'); }, select: () => { throw new Error('boom'); } } as unknown as Db;
    await expect(checkSanctionsListHealth(broken, new Date())).resolves.toEqual({ alerted: false });
    expect(err).toHaveBeenCalled();
  });

  it('alert has no names', async () => {
    delete process.env.SANCTIONS_LIST;
    await setRail(db, 'acme', 'http');
    await loadList(db, 50 * HOUR);
    await checkSanctionsListHealth(db, new Date());
    const msg = String((await alertRows(db))[0].payload.message).toLowerCase();
    for (const entry of [...WATCHLIST, ...LIST.entries.flatMap((e) => e.names)]) {
      expect(msg).not.toContain(entry.toLowerCase());
    }
    expect(msg).toContain('1 partner');
  });

  it('sanctionsListStatus fields', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await setRail(db, 'acme', 'http');
    await setRail(db, 'beta', 'http');
    await setRail(db, 'simco', 'simulator');
    const empty = await sanctionsListStatus(db, new Date());
    expect(empty).toEqual({
      listSetting: 'ofac-sdn', version: null, checkedAt: null, entryCount: null, fitness: 'not_live', httpPartners: 2,
    });
    await loadList(db, 2 * HOUR);
    const s = await sanctionsListStatus(db, new Date());
    expect(s).toMatchObject({ listSetting: 'ofac-sdn', version: LIST.version, entryCount: LIST.entries.length, fitness: 'live', httpPartners: 2 });
    expect(Math.round((Date.now() - Date.parse(s.checkedAt!)) / HOUR)).toBe(2);
    // The mock setting can never be live, whatever is loaded.
    delete process.env.SANCTIONS_LIST;
    expect(await sanctionsListStatus(db, new Date())).toMatchObject({ listSetting: 'mock', fitness: 'not_live', version: LIST.version });
    // Stale by the clock passed in.
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    expect((await sanctionsListStatus(db, new Date(Date.now() + 35 * HOUR))).fitness).toBe('stale');
  });

  it('sanctionsListFitnessNow: mock not_live, fresh live, stale stale', async () => {
    delete process.env.SANCTIONS_LIST;
    expect(await sanctionsListFitnessNow(new Date())).toBe('not_live');
    primeOfacSource({ checkedAgoMs: HOUR });
    expect(await sanctionsListFitnessNow(new Date())).toBe('live');
    primeOfacSource({ checkedAgoMs: 37 * HOUR });
    expect(await sanctionsListFitnessNow(new Date())).toBe('stale');
  });

  it('sanctionsListFitnessNow error -> not_live', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    setOfacListSourceForTests({ load: async () => { throw new Error('down'); }, warm: async () => { throw new Error('down'); } });
    expect(await sanctionsListFitnessNow(new Date())).toBe('not_live');
    setOfacListSourceForTests({
      load: async () => LIST,
      checkedAt: () => { throw new Error('boom'); },
    });
    expect(await sanctionsListFitnessNow(new Date())).toBe('not_live');
  });
});

// Fix pack 5 T30 (R08, P27): under SANCTIONS_LIST=lists the fitness, the
// read-only status and the daily alert judge the WHOLE floor set (all four
// lists when no destination). Outside lists nothing changes.
describe('sanctions list health over the list set (fix pack 5 T30)', () => {
  let db: Db;
  const original = process.env.SANCTIONS_LIST;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(() => {
    restoreOfacSource(original);
    vi.restoreAllMocks();
  });

  /** Store every source's list and set each checked_at relative to now. */
  async function loadSet(ago: Partial<Record<SanctionsSourceId, number>> = {}, skip: SanctionsSourceId[] = []) {
    const repo = createSanctionsListRepo(db);
    for (const source of SANCTIONS_SOURCES) {
      if (skip.includes(source)) continue;
      await repo.storeList(listSetList(source));
      await db.execute(sql`UPDATE sanctions_list_versions SET checked_at = ${new Date(Date.now() - (ago[source] ?? HOUR))}
        WHERE source = ${source}`);
    }
  }

  it('sanctionsListFitnessNow under lists: every floor list live -> live; MHA 9 days -> stale; un-sc never loaded -> not_live; one servedListInfo throws -> not_live', async () => {
    primeListSet({});
    expect(await sanctionsListFitnessNow(new Date())).toBe('live');
    primeListSet({ checkedAgoMs: { 'in-mha-uapa': 9 * 24 * HOUR } });
    expect(await sanctionsListFitnessNow(new Date())).toBe('stale');
    primeListSet({ missing: ['un-sc'] });
    expect(await sanctionsListFitnessNow(new Date())).toBe('not_live');
    primeListSet({});
    setListSourceForTests('ofac-cons', { load: async () => LIST, checkedAt: () => { throw new Error('boom'); } });
    expect(await sanctionsListFitnessNow(new Date())).toBe('not_live');
  });

  it('sanctionsListStatus under lists: set fitness from the DB rows, four members in SANCTIONS_SOURCES order, top-level fields keep the ofac-sdn values', async () => {
    process.env.SANCTIONS_LIST = 'lists';
    await setRail(db, 'acme', 'http');
    const empty = await sanctionsListStatus(db, new Date());
    expect(empty).toEqual({
      listSetting: 'lists', version: null, checkedAt: null, entryCount: null, fitness: 'not_live', httpPartners: 1,
      members: SANCTIONS_SOURCES.map((source) => ({ source, version: null, checkedAt: null, entryCount: null, fitness: 'not_live' })),
    });

    await loadSet({ 'ofac-sdn': 2 * HOUR });
    const s = await sanctionsListStatus(db, new Date());
    expect(s.fitness).toBe('live');
    expect(s).toMatchObject({ listSetting: 'lists', version: LIST.version, entryCount: LIST.entries.length, httpPartners: 1 });
    expect(Math.round((Date.now() - Date.parse(s.checkedAt!)) / HOUR)).toBe(2);
    expect(s.members!.map((m) => m.source)).toEqual([...SANCTIONS_SOURCES]);
    for (const m of s.members!) {
      const list = listSetList(m.source);
      expect(m).toMatchObject({ version: list.version, entryCount: list.entries.length, fitness: 'live' });
      expect(typeof m.checkedAt).toBe('string');
    }

    // MHA 9 days old -> that member stale, and the set stale.
    await db.execute(sql`UPDATE sanctions_list_versions SET checked_at = ${new Date(Date.now() - 9 * 24 * HOUR)} WHERE source = 'in-mha-uapa'`);
    const stale = await sanctionsListStatus(db, new Date());
    expect(stale.fitness).toBe('stale');
    expect(stale.members!.find((m) => m.source === 'in-mha-uapa')!.fitness).toBe('stale');
    expect(stale.members!.find((m) => m.source === 'ofac-sdn')!.fitness).toBe('live');
  });

  it('a member whose stored entries miss its entry_count is not_live, and so is the set', async () => {
    process.env.SANCTIONS_LIST = 'lists';
    await loadSet();
    await db.execute(sql`DELETE FROM sanctions_list_entries WHERE entry_id = 'unsc:1'`);
    const s = await sanctionsListStatus(db, new Date());
    expect(s.members!.find((m) => m.source === 'un-sc')).toMatchObject({ fitness: 'not_live', entryCount: 1 });
    expect(s.members!.find((m) => m.source === 'ofac-cons')!.fitness).toBe('live');
    expect(s.fitness).toBe('not_live');
  });

  it('one source never loaded -> that member null and not_live, the set not_live', async () => {
    process.env.SANCTIONS_LIST = 'lists';
    await loadSet({}, ['ofac-cons']);
    const s = await sanctionsListStatus(db, new Date());
    expect(s.members!.find((m) => m.source === 'ofac-cons')).toEqual({
      source: 'ofac-cons', version: null, checkedAt: null, entryCount: null, fitness: 'not_live',
    });
    expect(s.fitness).toBe('not_live');
  });

  it('outside lists: members is absent and every field equals today\'s', async () => {
    await setRail(db, 'acme', 'http');
    await loadSet();
    for (const setting of [undefined, 'mock', 'ofac-sdn']) {
      if (setting === undefined) delete process.env.SANCTIONS_LIST;
      else process.env.SANCTIONS_LIST = setting;
      const s = await sanctionsListStatus(db, new Date());
      expect('members' in s).toBe(false);
      expect(Object.keys(s)).toEqual(['listSetting', 'version', 'checkedAt', 'entryCount', 'fitness', 'httpPartners']);
      expect(s.fitness).toBe(setting === 'ofac-sdn' ? 'live' : 'not_live');
    }
  });

  it('checkSanctionsListHealth under lists alerts once per day on the same key with the lists text; no names', async () => {
    process.env.SANCTIONS_LIST = 'lists';
    await setRail(db, 'acme', 'http');
    await loadSet({ 'in-mha-uapa': 9 * 24 * HOUR }, ['un-sc']);
    const now = new Date();
    expect(await checkSanctionsListHealth(db, now)).toEqual({ alerted: true });
    expect(await checkSanctionsListHealth(db, now)).toEqual({ alerted: false });
    const rows = await alertRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(listNotLiveDedupeKey(now));
    expect(Object.keys(rows[0].payload)).toEqual(['message']);
    const msg = String(rows[0].payload.message);
    expect(msg).toBe(
      `⚠️ SmartRemit ops: the sanctions list set is not live (not_live; setting lists; ` +
        `ofac-sdn ${LIST.version} checked 1 h ago, ofac-cons 2026-10-01 checked 1 h ago, ` +
        `un-sc none checked never, in-mha-uapa 2026-10-01 checked 216 h ago). ` +
        `1 partner(s) on a real-money rail hold every new transfer until every list is live. ` +
        `Check the sanctions lists page and the loader.`,
    );
    const lower = msg.toLowerCase();
    for (const name of [...WATCHLIST, ...LIST.entries.flatMap((e) => e.names), ...Object.values(LIST_SET_NAMES)]) {
      expect(lower).not.toContain(name.toLowerCase());
    }
  });

  it('under lists a live set raises nothing', async () => {
    process.env.SANCTIONS_LIST = 'lists';
    await setRail(db, 'acme', 'http');
    await loadSet();
    expect(await checkSanctionsListHealth(db, new Date())).toEqual({ alerted: false });
    expect(await alertRows(db)).toEqual([]);
  });

  it('the ofac-sdn text is unchanged outside lists', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await setRail(db, 'acme', 'http');
    await loadList(db, 40 * HOUR);
    await checkSanctionsListHealth(db, new Date());
    expect(String((await alertRows(db))[0].payload.message)).toBe(
      `⚠️ SmartRemit ops: the sanctions list is not live (stale; setting ofac-sdn; ` +
        `OFAC SDN version ${LIST.version}, last checked 40 h ago). ` +
        `1 partner(s) on a real-money rail hold every new transfer until it is. ` +
        `Check the sanctions list card on the compliance page and the loader.`,
    );
  });
});
