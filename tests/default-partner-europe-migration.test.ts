import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { findDestructive, parseOverride } from '../scripts/ci/migration-guard.mjs';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';
import type { Db } from '@/db/client';

// Europe (migration 0033): append HK, MX and the eight euro countries to the seeded `default`
// partner. A reviewed data UPDATE (not after-deploy), so the production build applies it.

const FILE = join(process.cwd(), 'drizzle/0033_default_partner_europe.sql');
const body = readFileSync(FILE, 'utf8');
type Rows<T> = { rows: T[] };
const countriesOf = async (db: Db, id: string): Promise<string[]> =>
  ((await db.execute(sql.raw(`SELECT countries FROM partners WHERE id = '${id}'`))) as unknown as Rows<{ countries: string[] }>).rows[0].countries;
const setCountries = (db: Db, id: string, list: string[]) =>
  db.execute(sql.raw(`UPDATE partners SET countries = '${JSON.stringify(list)}'::jsonb WHERE id = '${id}'`));
const apply = (db: Db) => db.execute(sql.raw(body));

describe('drizzle/0033_default_partner_europe.sql', () => {
  it('carries a reviewed guard marker that the build applies (not after-deploy)', () => {
    expect(findDestructive(body).map((f: { rule: string }) => f.rule)).toEqual(['update']);
    const override = parseOverride(body);
    expect(override).not.toBeNull();
    expect(override!.afterDeploy).toBe(false);
    expect(override!.reason.length).toBeGreaterThanOrEqual(10);
  });

  it('the journal carries it by tag at idx 33, after 0032', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0033_default_partner_europe');
    const prev = journal.entries.find((e) => e.tag === '0032_purpose_detail');
    expect(entry?.idx).toBe(33);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });
});

describe('0033 applied', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('turns the post-0006 default row into DEFAULT_PARTNER_COUNTRIES, existing order first', async () => {
    await setCountries(db, 'default', ['US', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);
    await apply(db);
    expect(await countriesOf(db, 'default')).toEqual(DEFAULT_PARTNER_COUNTRIES);
  });

  it('keeps a hand-added code and adds only the missing ones; a re-run is a no-op', async () => {
    await setCountries(db, 'default', ['US', 'CA', 'DE']);
    await apply(db);
    await apply(db);
    expect(await countriesOf(db, 'default')).toEqual(['US', 'CA', 'DE', 'HK', 'MX', 'FR', 'NL', 'IE', 'IT', 'ES', 'AT', 'BE']);
  });

  it('never touches another partner', async () => {
    await seedPartner(db, 'acme');
    await apply(db);
    expect(await countriesOf(db, 'acme')).toEqual(['US']);
  });
});
