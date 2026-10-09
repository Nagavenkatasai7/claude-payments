import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findDestructive,
  maskSql,
  newJournalEntries,
  orderingProblems,
  parseOverride,
  runGuard,
} from '../scripts/ci/migration-guard.mjs';

// scripts/ci/migration-guard.mjs, the `migration safety` job in ci.yml.
// A PR's NEW drizzle/*.sql must be additive (expand), so the production build
// (scripts/migrate-on-build.mjs) can apply it while the old build still
// serves; a destructive (contract) step needs an explicit marker with a
// reason. The journal must stay consistent and ordered. The guard reads git
// only; it never calls production.

const root = join(__dirname, '..');

describe('maskSql', () => {
  it('keeps the length and the newlines, blanks comments and strings, and x-es identifiers', () => {
    const sql = `-- DROP TABLE x\nUPDATE "drop" SET a = 'DROP TABLE y'; /* RENAME\n */ SELECT 1;`;
    const masked = maskSql(sql);
    expect(masked.length).toBe(sql.length);
    expect(masked.split('\n').length).toBe(sql.split('\n').length);
    expect(masked).not.toMatch(/DROP|RENAME/);
    expect(masked).toMatch(/^\s+\nUPDATE "xxxx" SET a = '\s+';\s+SELECT 1;$/);
  });

  it('blanks dollar-quoted bodies and handles doubled quotes', () => {
    const masked = maskSql(`CREATE FUNCTION f() AS $$ DELETE FROM t; $$; SELECT 'it''s', "a""b";`);
    expect(masked).not.toMatch(/DELETE/);
    expect(masked).toMatch(/SELECT '\s+', "x+";$/);
    expect(maskSql(`DO $body$ BEGIN DROP TABLE t; END $body$;`)).not.toMatch(/DROP/);
  });
});

describe('findDestructive', () => {
  const rules = (sql: string) => findDestructive(sql).map((f: { rule: string }) => f.rule);

  it.each([
    ['ALTER TABLE "t" DROP COLUMN "c";', 'drop'],
    ['DROP TABLE "t";', 'drop'],
    ['DROP INDEX "i";', 'drop'],
    ['ALTER TABLE "t" DROP CONSTRAINT "k";', 'drop'],
    ['ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;', 'drop'],
    ['ALTER TABLE "t" RENAME COLUMN "a" TO "b";', 'rename'],
    ['ALTER TABLE "t" RENAME TO "u";', 'rename'],
    ['ALTER TYPE "e" RENAME VALUE \'a\' TO \'b\';', 'rename'],
    ['ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE integer;', 'type-change'],
    ['ALTER TABLE "t" ALTER COLUMN c TYPE bigint USING c::bigint;', 'type-change'],
    ['ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;', 'set-not-null'],
    ['ALTER TABLE "t" ADD COLUMN "c" text NOT NULL;', 'add-not-null-no-default'],
    ['ALTER TABLE "t" ADD COLUMN "c" text PRIMARY KEY;', 'add-not-null-no-default'],
    ['TRUNCATE "t";', 'truncate'],
    ['DELETE FROM "t" WHERE true;', 'delete'],
    ['UPDATE "t" SET "c" = 1;', 'update'],
  ])('flags %s as %s', (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it.each([
    'CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL, "c" text NOT NULL);',
    'ALTER TABLE "t" ADD COLUMN "c" text;',
    'ALTER TABLE "t" ADD COLUMN "c" text DEFAULT \'none\' NOT NULL;',
    'ALTER TABLE "t" ADD COLUMN "c" integer GENERATED ALWAYS AS (1) STORED NOT NULL;',
    'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
    'CREATE INDEX "i" ON "t" USING btree ("c");',
    'ALTER TABLE "t" ADD CONSTRAINT "fk" FOREIGN KEY ("p") REFERENCES "public"."p"("id") ON DELETE no action ON UPDATE no action;',
    'CREATE TRIGGER x BEFORE UPDATE OR DELETE ON "t" FOR EACH ROW EXECUTE FUNCTION f();',
    'INSERT INTO "t" ("drop_reason") VALUES (\'DROP TABLE t\');',
    '-- Rollback:\n--   DROP TABLE "t";\nCREATE TABLE "t" ("id" text);',
    'SET LOCAL lock_timeout = \'5s\';',
  ])('passes %s', (sql) => {
    expect(findDestructive(sql)).toEqual([]);
  });

  it('checks each ADD COLUMN clause of a multi-clause ALTER on its own', () => {
    const sql = 'ALTER TABLE "t" ADD COLUMN "a" text DEFAULT \'x\' NOT NULL, ADD COLUMN "b" text NOT NULL;';
    const found = findDestructive(sql);
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['add-not-null-no-default']);
    expect(found[0].text).toMatch(/"b"/);
  });

  it('reports the 1-based line of the statement', () => {
    const sql = 'CREATE TABLE "t" ("id" text);--> statement-breakpoint\n\nALTER TABLE "t"\n  DROP COLUMN "id";';
    expect(findDestructive(sql)).toEqual([expect.objectContaining({ rule: 'drop', line: 4 })]);
  });

  // Ground truth: the checked-in migrations. Additive ones pass; the ones that
  // rewrote data or swapped constraints are exactly the ones the guard flags.
  it('flags exactly the historic migrations that were not purely additive', () => {
    const files = readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(29);
    const flagged = files
      .filter((f) => findDestructive(readFileSync(join(root, 'drizzle', f), 'utf8')).length > 0)
      .map((f) => f.slice(0, 4));
    expect(flagged).toEqual(['0006', '0010', '0014', '0015', '0016', '0028']);
  });
});

describe('parseOverride', () => {
  it('reads the marker and its reason from a comment line', () => {
    expect(parseOverride('-- migration-guard: allow-destructive widen staff_role_check, a superset\nALTER TABLE "s" DROP CONSTRAINT "k";')).toEqual({
      reason: 'widen staff_role_check, a superset',
      afterDeploy: false,
    });
    expect(parseOverride('-- migration-guard: allow-destructive after-deploy drop "c", the new build no longer selects it\nALTER TABLE "t" DROP COLUMN "c";')).toEqual({
      reason: 'drop "c", the new build no longer selects it',
      afterDeploy: true,
    });
  });

  it('is null without a marker or inside a string, and has an empty reason for a bare marker', () => {
    expect(parseOverride('ALTER TABLE "t" DROP COLUMN "c";')).toBeNull();
    expect(parseOverride("SELECT '-- migration-guard: allow-destructive because';")).toBeNull();
    expect(parseOverride("SELECT 'a\n-- migration-guard: allow-destructive inside a string';")).toBeNull();
    expect(parseOverride('-- migration-guard: allow-destructive\nDROP TABLE t;')).toEqual({ reason: '', afterDeploy: false });
  });
});

describe('journal helpers', () => {
  const j = (...entries: Array<[string, number]>) => ({
    entries: entries.map(([tag, when], idx) => ({ idx, when, tag })),
  });

  it('newJournalEntries returns head entries whose tag the base does not have', () => {
    expect(newJournalEntries(j(['0000_a', 1]), j(['0000_a', 1], ['0001_b', 5]))).toEqual([{ idx: 1, when: 5, tag: '0001_b' }]);
    expect(newJournalEntries(j(['0000_a', 1]), j(['0000_a', 1]))).toEqual([]);
  });

  it('orderingProblems lists new entries not newer than every base entry (the migrator would skip them)', () => {
    const base = j(['0000_a', 10], ['0001_b', 20]);
    expect(orderingProblems(base, [{ idx: 2, when: 30, tag: '0002_c' }])).toEqual([]);
    expect(orderingProblems(base, [{ idx: 2, when: 15, tag: '0002_c' }])).toEqual([{ idx: 2, when: 15, tag: '0002_c' }]);
  });
});

// End to end over a throwaway git repo: the PR's diff is merge-base..head.
describe('runGuard', () => {
  let repo: string;
  let base: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  const commitAll = (msg: string) => {
    git('add', '-A');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const journal = (entries: Array<[string, number]>) =>
    writeFileSync(
      join(repo, 'drizzle/meta/_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: entries.map(([tag, when], idx) => ({ idx, version: '7', when, tag, breakpoints: true })) }, null, 2),
    );
  const sql = (tag: string, body: string) => writeFileSync(join(repo, 'drizzle', `${tag}.sql`), body);
  const env = (head: string, extra: Record<string, string> = {}) => ({
    EVENT_NAME: 'pull_request',
    PR_BASE_SHA: base,
    PR_HEAD_SHA: head,
    ...extra,
  });
  // The guard must never reach the network: any fetch fails the test.
  let fetchCalls: string[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    lines = [];
    fetchCalls = [];
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push(String(url));
      throw new Error('the guard must not call the network');
    }) as typeof fetch;
    repo = mkdtempSync(join(tmpdir(), 'mguard-'));
    git('init', '-q');
    mkdirSync(join(repo, 'drizzle/meta'), { recursive: true });
    sql('0000_a', 'CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL);');
    journal([['0000_a', 1000]]);
    base = commitAll('base');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    expect(fetchCalls).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes a PR without migration changes', async () => {
    writeFileSync(join(repo, 'README.md'), 'x');
    const head = commitAll('docs');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(0);
    expect(lines.join('\n')).toMatch(/No migration changes/);
  });

  it('skips (exit 0) on push and other events', async () => {
    expect(await runGuard({ env: { EVENT_NAME: 'push' }, cwd: repo, out })).toBe(0);
    expect(lines.join('\n')).toMatch(/::notice/);
  });

  it('fails closed (exit 2) when a range end is missing from the clone', async () => {
    const code = await runGuard({ env: env('1234567890abcdef1234567890abcdef12345678'), cwd: repo, out });
    expect(code).toBe(2);
  });

  it('passes an additive migration without asking production (the production build applies it)', async () => {
    sql('0001_b', 'ALTER TABLE "t" ADD COLUMN "c" text;');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('add 0001');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(0);
    expect(lines.join('\n')).not.toMatch(/::error/);
  });

  it('fails (exit 1) on a destructive new migration without a marker, with a file:line annotation', async () => {
    sql('0001_b', 'ALTER TABLE "t"\n  DROP COLUMN "id";');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('drop');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(1);
    expect(lines.join('\n')).toMatch(/::error file=drizzle\/0001_b\.sql,line=2,/);
  });

  it('a marked before-deploy step passes with a warning that the production build applies it', async () => {
    sql('0001_b', '-- migration-guard: allow-destructive widen the check to a superset of roles\nALTER TABLE "t" DROP CONSTRAINT "k";');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('check swap');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(0);
    expect(lines.join('\n')).toMatch(/::warning[^\n]*0001_b[^\n]*production build applies it/);
  });

  it('an after-deploy step passes with a warning that it needs a manual apply after the deploy', async () => {
    sql('0001_b', '-- migration-guard: allow-destructive after-deploy code stopped selecting "id" in this PR\nALTER TABLE "t" DROP COLUMN "id";');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('contract');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(0);
    expect(lines.join('\n')).toMatch(/::warning[^\n]*will NOT apply it[^\n]*AFTER this change is deployed/);
  });

  it('rejects a marker without a reason', async () => {
    sql('0001_b', '-- migration-guard: allow-destructive\nDROP TABLE "t";');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('contract');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(1);
  });

  it('fails a new journal entry older than the base\'s newest (the migrator would skip it)', async () => {
    sql('0001_b', 'ALTER TABLE "t" ADD COLUMN "c" text;');
    journal([['0000_a', 1000], ['0001_b', 500]]);
    const head = commitAll('old when');
    expect(await runGuard({ env: env(head), cwd: repo, out })).toBe(1);
    expect(lines.join('\n')).toMatch(/::error[^\n]*0001_b/);
  });

  it('fails a new .sql the journal does not list, and a journal entry with no .sql', async () => {
    sql('0001_b', 'ALTER TABLE "t" ADD COLUMN "c" text;');
    const head1 = commitAll('orphan sql');
    expect(await runGuard({ env: env(head1), cwd: repo, out })).toBe(1);
    rmSync(join(repo, 'drizzle/0001_b.sql'));
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head2 = commitAll('entry without sql');
    expect(await runGuard({ env: env(head2), cwd: repo, out })).toBe(1);
  });

  it('fails a deleted migration and warns on an edited one', async () => {
    sql('0000_a', 'CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL, "n" text);');
    const edited = commitAll('edit');
    expect(await runGuard({ env: env(edited), cwd: repo, out })).toBe(0);
    expect(lines.join('\n')).toMatch(/::warning file=drizzle\/0000_a\.sql/);
    rmSync(join(repo, 'drizzle/0000_a.sql'));
    const deleted = commitAll('delete');
    expect(await runGuard({ env: env(deleted), cwd: repo, out })).toBe(1);
  });

  it('uses merge-base..head, so main moving ahead does not count as this PR\'s change', async () => {
    git('checkout', '-q', '-b', 'pr');
    writeFileSync(join(repo, 'README.md'), 'x');
    const head = commitAll('pr work');
    git('checkout', '-q', '-');
    sql('0001_main', 'ALTER TABLE "t" DROP COLUMN "id";');
    journal([['0000_a', 1000], ['0001_main', 3000]]);
    const mainTip = commitAll('main moved');
    expect(await runGuard({ env: env(head, { PR_BASE_SHA: mainTip }), cwd: repo, out })).toBe(0);
  });

  it('fails a new entry older than a migration merged to main after the branch was cut', async () => {
    git('checkout', '-q', '-b', 'pr');
    sql('0001_b', 'ALTER TABLE "t" ADD COLUMN "c" text;');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('pr migration');
    git('checkout', '-q', '-');
    sql('0001_main', 'ALTER TABLE "t" ADD COLUMN "d" text;');
    journal([['0000_a', 1000], ['0001_main', 3000]]);
    const mainTip = commitAll('main migration');
    expect(await runGuard({ env: env(head, { PR_BASE_SHA: mainTip }), cwd: repo, out })).toBe(1);
    expect(lines.join('\n')).toMatch(/::error[^\n]*0001_b[^\n]*not newer/);
  });

  it('reads the merge-group range on merge_group events', async () => {
    sql('0001_b', 'ALTER TABLE "t" ADD COLUMN "c" text;');
    journal([['0000_a', 1000], ['0001_b', 2000]]);
    const head = commitAll('add 0001');
    const e = { EVENT_NAME: 'merge_group', MG_BASE_SHA: base, MG_HEAD_SHA: head };
    expect(await runGuard({ env: e, cwd: repo, out })).toBe(0);
  });
});
