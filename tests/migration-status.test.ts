import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareMigrations, readAppliedMigrations, JOURNAL_ENTRIES } from '@/db/migration-status';
import { freshDb } from './helpers-db';

// The applied-vs-expected rule shared by GET /api/version/migrations and
// scripts/migration-status.ts: a journal entry is applied when some
// drizzle.__drizzle_migrations row has created_at === entry.when (the drizzle
// migrator inserts journalEntry.when as created_at: node_modules/drizzle-orm/
// migrator.js:22 + pg-core/dialect.js:67).

const ENTRIES = [
  { idx: 0, when: 1000, tag: '0000_a' },
  { idx: 1, when: 2000, tag: '0001_b' },
  { idx: 2, when: 3000, tag: '0002_c' },
];

describe('compareMigrations', () => {
  it('every entry applied: ok, nothing pending', () => {
    expect(compareMigrations(ENTRIES, [1000, 2000, 3000])).toEqual({
      expected: 3,
      applied: 3,
      pending: [],
      unknownApplied: [],
      ok: true,
    });
  });

  it('last entry missing: not ok, its tag is pending', () => {
    const r = compareMigrations(ENTRIES, [1000, 2000]);
    expect(r.ok).toBe(false);
    expect(r.pending).toEqual(['0002_c']);
    expect(r.applied).toBe(2);
  });

  it('matches created_at given as a string (Neon bigint), a number or a BigInt', () => {
    const r = compareMigrations(ENTRIES, ['1000', 2000, BigInt(3000)]);
    expect(r.ok).toBe(true);
    expect(r.pending).toEqual([]);
  });

  it('reports applied rows that are not in the journal without failing', () => {
    const r = compareMigrations(ENTRIES, [1000, 2000, 3000, '4000']);
    expect(r.unknownApplied).toEqual([4000]);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(3);
  });

  it('nothing applied: every tag pending', () => {
    const r = compareMigrations(ENTRIES, []);
    expect(r).toEqual({ expected: 3, applied: 0, pending: ['0000_a', '0001_b', '0002_c'], unknownApplied: [], ok: false });
  });
});

describe('JOURNAL_ENTRIES', () => {
  it('is the drizzle journal on disk (bundled at build time)', () => {
    const disk = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: Array<{ when: number; tag: string }>;
    };
    expect(JOURNAL_ENTRIES.length).toBe(disk.entries.length);
    expect(JOURNAL_ENTRIES.at(-1)?.tag).toBe(disk.entries.at(-1)?.tag);
    expect(JOURNAL_ENTRIES.at(-1)?.when).toBe(disk.entries.at(-1)?.when);
  });
});

describe('readAppliedMigrations (PGlite, migrated by drizzle-orm/pglite/migrator)', () => {
  it('a fully migrated database has every journal entry applied', async () => {
    const db = await freshDb();
    const applied = await readAppliedMigrations(db);
    expect(applied.length).toBe(JOURNAL_ENTRIES.length);
    const r = compareMigrations(JOURNAL_ENTRIES, applied);
    expect(r.pending).toEqual([]);
    expect(r.unknownApplied).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
