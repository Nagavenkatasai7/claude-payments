import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// CI's "Migration drift check" (.github/workflows/ci.yml:38-52) runs
// `drizzle-kit generate` against the LATEST drizzle/meta snapshot. Two ways it
// can pass while the tree is wrong (drizzle-kit 0.31.10, node_modules/drizzle-kit/bin.cjs):
//   • the newest migration ships without a snapshot (the 0014 incident, fixed in
//     b484a82) — generate then diffs against a stale snapshot;
//   • two snapshots name the same parent (two migrations authored in parallel) —
//     prepareMigrationFolder prints a collision and exits 0 writing nothing
//     (bin.cjs:8197-8230), so `git status drizzle/` is clean and the check is vacuous.
const META = join(__dirname, '..', 'drizzle', 'meta');

describe('drizzle/meta — the snapshot chain the drift check depends on', () => {
  const snapshots = readdirSync(META).filter((f) => f.endsWith('_snapshot.json')).sort();
  const journal = JSON.parse(readFileSync(join(META, '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  it('every snapshot points at the previous one (no fork, no collision)', () => {
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const f of snapshots) {
      const snap = JSON.parse(readFileSync(join(META, f), 'utf8')) as { id: string; prevId: string };
      expect({ file: f, prevId: snap.prevId }).toEqual({ file: f, prevId: prev });
      prev = snap.id;
    }
  });

  it('the newest journal entry has its own snapshot', () => {
    const last = journal.entries[journal.entries.length - 1];
    expect(snapshots[snapshots.length - 1]).toBe(`${last.tag.slice(0, 4)}_snapshot.json`);
  });
});
