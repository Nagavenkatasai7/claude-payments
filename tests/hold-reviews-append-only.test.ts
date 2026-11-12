import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Fix pack 7 T4 (P6): hold_reviews is append-only. The database enforces it
// (drizzle/0041 triggers, pinned by tests/pack7-migration.test.ts); this static
// guard fails the build early if any src/ code tries to update or delete a
// hold decision record. Comment lines (`//`, `*`, `/*`) are skipped.

const ROOT = join(__dirname, '..', 'src');
const HOLD_REVIEW_MUTATION_PATTERNS: RegExp[] = [
  /(update|delete)\(holdReviews\)/,
  /UPDATE\s+"?hold_reviews/i,
  /DELETE\s+FROM\s+"?hold_reviews/i,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Offending `file:line` hits in one source text (comment lines skipped). */
function holdReviewMutations(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
    return HOLD_REVIEW_MUTATION_PATTERNS.some((re) => re.test(line)) ? [`${file}:${i + 1}`] : [];
  });
}

describe('hold_reviews is append-only (static guard, fix pack 7)', () => {
  it('the guard catches every mutation shape and ignores comments', () => {
    expect(holdReviewMutations('x.ts', 'await db.update(holdReviews).set({})')).toEqual(['x.ts:1']);
    expect(holdReviewMutations('x.ts', 'await tx.delete(holdReviews)')).toEqual(['x.ts:1']);
    expect(holdReviewMutations('x.ts', "sql`UPDATE hold_reviews SET reason = 'x'`")).toEqual(['x.ts:1']);
    expect(holdReviewMutations('x.ts', 'sql`update "hold_reviews" set x = 1`')).toEqual(['x.ts:1']);
    expect(holdReviewMutations('x.ts', 'sql`DELETE FROM hold_reviews`')).toEqual(['x.ts:1']);
    expect(holdReviewMutations('x.ts', 'sql`delete from "hold_reviews" where id = $1`')).toEqual(['x.ts:1']);
    expect(holdReviewMutations('x.ts', '  // UPDATE hold_reviews is forbidden')).toEqual([]);
    expect(holdReviewMutations('x.ts', ' * then the hold_reviews row (update, delete)')).toEqual([]);
    expect(holdReviewMutations('x.ts', '/* DELETE FROM hold_reviews */')).toEqual([]);
    expect(holdReviewMutations('x.ts', 'await db.insert(holdReviews).values(row)')).toEqual([]);
  });

  it('no file under src/ updates or deletes hold_reviews', () => {
    const hits = walk(ROOT).flatMap((f) => holdReviewMutations(relative(ROOT, f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
