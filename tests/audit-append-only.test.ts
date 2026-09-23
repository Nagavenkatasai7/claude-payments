import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Program-Fix 28 (compliance-12): audit_events is append-only. The database
// enforces it (drizzle/0019 trigger, pinned by tests/audit-append-only-db.test.ts);
// this static guard keeps failing the build early if any src/ code tries to
// update or delete audit rows. Comment lines (`//`, `*`, `/*`) are skipped, so
// prose that names the table (customers/actions.ts) is fine.

const ROOT = join(__dirname, '..', 'src');
const AUDIT_MUTATION_PATTERNS: RegExp[] = [
  /(update|delete)\(auditEvents\)/,
  /UPDATE\s+"?audit_events/i,
  /DELETE\s+FROM\s+"?audit_events/i,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Offending `file:line` hits in one source text (comment lines skipped). */
function auditMutations(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
    return AUDIT_MUTATION_PATTERNS.some((re) => re.test(line)) ? [`${file}:${i + 1}`] : [];
  });
}

describe('audit_events is append-only (static guard, Program-Fix 28)', () => {
  it('the guard catches every mutation shape and ignores comments', () => {
    expect(auditMutations('x.ts', 'await db.update(auditEvents).set({})')).toEqual(['x.ts:1']);
    expect(auditMutations('x.ts', 'await tx.delete(auditEvents)')).toEqual(['x.ts:1']);
    expect(auditMutations('x.ts', "sql`UPDATE audit_events SET at = now()`")).toEqual(['x.ts:1']);
    expect(auditMutations('x.ts', 'sql`update "audit_events" set x = 1`')).toEqual(['x.ts:1']);
    expect(auditMutations('x.ts', 'sql`DELETE FROM audit_events`')).toEqual(['x.ts:1']);
    expect(auditMutations('x.ts', '  // UPDATE audit_events is forbidden')).toEqual([]);
    expect(auditMutations('x.ts', ' * then the audit_events row (update, delete)')).toEqual([]);
    expect(auditMutations('x.ts', '/* DELETE FROM audit_events */')).toEqual([]);
    expect(auditMutations('x.ts', 'await db.insert(auditEvents).values(row)')).toEqual([]);
  });

  it('no file under src/ updates or deletes audit_events', () => {
    const hits = walk(ROOT).flatMap((f) => auditMutations(relative(ROOT, f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
