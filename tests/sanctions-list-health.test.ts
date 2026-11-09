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
import { setOfacListSourceForTests } from '@/lib/providers/sanctions-provider';
import { WATCHLIST } from '@/lib/compliance-config';
import { primeOfacSource, restoreOfacSource } from './helpers-sanctions';

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
