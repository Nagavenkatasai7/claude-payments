import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Fix pack 5 T7 (R40, contract P2): rail_messages is append-only. The database
// enforces it (drizzle/0039 trigger, pinned by tests/rail-messages-append-only-db.test.ts);
// this static guard fails the build early if any src/ code tries to update or
// delete a rail record. The key-rotation re-seal lives in scripts/, outside src.
// Comment lines (`//`, `*`, `/*`) are skipped.

const ROOT = join(__dirname, '..', 'src');
const RAIL_MUTATION_PATTERNS: RegExp[] = [
  /(update|delete)\(railMessages\)/,
  /UPDATE\s+"?rail_messages/i,
  /DELETE\s+FROM\s+"?rail_messages/i,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Offending `file:line` hits in one source text (comment lines skipped). */
function railMutations(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
    return RAIL_MUTATION_PATTERNS.some((re) => re.test(line)) ? [`${file}:${i + 1}`] : [];
  });
}

describe('rail_messages is append-only (static guard, fix pack 5)', () => {
  it('the guard catches every mutation shape and ignores comments', () => {
    expect(railMutations('x.ts', 'await db.update(railMessages).set({})')).toEqual(['x.ts:1']);
    expect(railMutations('x.ts', 'await tx.delete(railMessages)')).toEqual(['x.ts:1']);
    expect(railMutations('x.ts', "sql`UPDATE rail_messages SET kind = 'x'`")).toEqual(['x.ts:1']);
    expect(railMutations('x.ts', 'sql`update "rail_messages" set x = 1`')).toEqual(['x.ts:1']);
    expect(railMutations('x.ts', 'sql`DELETE FROM rail_messages`')).toEqual(['x.ts:1']);
    expect(railMutations('x.ts', 'sql`delete from "rail_messages" where id = $1`')).toEqual(['x.ts:1']);
    expect(railMutations('x.ts', '  // UPDATE rail_messages is forbidden')).toEqual([]);
    expect(railMutations('x.ts', ' * then the rail_messages row (update, delete)')).toEqual([]);
    expect(railMutations('x.ts', '/* DELETE FROM rail_messages */')).toEqual([]);
    expect(railMutations('x.ts', 'await db.insert(railMessages).values(row)')).toEqual([]);
  });

  it('no file under src/ updates or deletes rail_messages', () => {
    const hits = walk(ROOT).flatMap((f) => railMutations(relative(ROOT, f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
