import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCK_KEY,
  classifyMigration,
  databaseUrl,
  errorText,
  hostOf,
  pendingEntries,
  planMigrations,
  redact,
  run,
  buildGate,
} from '../scripts/migrate-on-build.mjs';

// scripts/migrate-on-build.mjs runs in the Vercel production build
// (package.json "vercel-build"): it applies the pending drizzle migrations
// before `next build`, so a build never goes live ahead of its migration.

const PROD = { VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_COMMIT_REF: 'main' };
const URL_ = 'postgresql://owner:pw-s3cret@ep-x-direct.us-east-2.aws.neon.tech/db?sslmode=require';

// Vercel's Next.js builder runs `vercel-build` instead of `build` when it
// exists, unless a Build Command override is set (vercel/vercel
// packages/next/src/index.ts getScriptName(['vercel-build', 'now-build', 'build'])).
describe('wiring', () => {
  const root = join(__dirname, '..');
  it('vercel-build migrates, then builds; build stays plain; vercel.json sets no buildCommand', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['vercel-build']).toBe('node scripts/migrate-on-build.mjs && next build');
    expect(pkg.scripts.build).toBe('next build');
    expect(JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).buildCommand).toBeUndefined();
  });
});

describe('buildGate', () => {
  it('runs for a production build of main from GitHub', () => {
    expect(buildGate(PROD)).toEqual({ action: 'run' });
  });

  it('skips anything that is not a production build', () => {
    expect(buildGate({ VERCEL_ENV: 'preview', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_COMMIT_REF: 'main' })).toEqual({ action: 'skip', reason: expect.stringMatching(/preview/) });
    expect(buildGate({ VERCEL_ENV: 'development' })).toEqual({ action: 'skip', reason: expect.stringMatching(/development/) });
    expect(buildGate({})).toEqual({ action: 'skip', reason: expect.stringMatching(/not a Vercel production build/) });
  });

  // On Vercel (VERCEL=1) a missing VERCEL_ENV means system variables are not
  // exposed to the build; skipping would let a production build go live unmigrated.
  it('fails a Vercel build that cannot see VERCEL_ENV', () => {
    const g = buildGate({ VERCEL: '1' });
    expect(g.action).toBe('fail');
    expect('reason' in g ? g.reason : '').toMatch(/System Environment Variables/);
    expect(buildGate({ VERCEL: '1', MIGRATE_ON_BUILD_SKIP: '1' }).action).toBe('override');
  });

  // A production build that is not main from GitHub (CLI `vercel deploy --prod`,
  // a promoted CLI preview) could go live without its migration: fail it.
  it.each([
    [{ VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_COMMIT_REF: 'feat/x' }, /feat\/x/],
    [{ VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'github' }, /VERCEL_GIT_COMMIT_REF/],
    [{ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' }, /VERCEL_GIT_PROVIDER/],
    [{ VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'gitlab', VERCEL_GIT_COMMIT_REF: 'main' }, /gitlab/],
  ])('fails a production build that is not main from GitHub: %o', (env, why) => {
    const g = buildGate(env);
    expect(g.action).toBe('fail');
    const reason = 'reason' in g ? g.reason : '';
    expect(reason).toMatch(why);
    expect(reason).toMatch(/MIGRATE_ON_BUILD_SKIP=1/);
  });

  it('MIGRATE_ON_BUILD_SKIP=1 overrides only that failure', () => {
    const cli = { VERCEL_ENV: 'production', MIGRATE_ON_BUILD_SKIP: '1' };
    expect(buildGate(cli)).toEqual({ action: 'override', reason: expect.stringMatching(/VERCEL_GIT_PROVIDER/) });
    expect(buildGate({ ...cli, MIGRATE_ON_BUILD_SKIP: 'true' }).action).toBe('fail');
    // A normal production build of main still migrates.
    expect(buildGate({ ...PROD, MIGRATE_ON_BUILD_SKIP: '1' })).toEqual({ action: 'run' });
  });
});

describe('databaseUrl / hostOf / redact', () => {
  it('prefers the unpooled URL, like drizzle.config.ts', () => {
    expect(databaseUrl({ DATABASE_URL_UNPOOLED: 'a', DATABASE_URL: 'b' })).toBe('a');
    expect(databaseUrl({ DATABASE_URL: 'b' })).toBe('b');
    expect(databaseUrl({ DATABASE_URL_UNPOOLED: '', DATABASE_URL: 'b' })).toBe('b');
    expect(databaseUrl({})).toBe('');
  });

  it('hostOf names the host only', () => {
    expect(hostOf(URL_)).toBe('ep-x-direct.us-east-2.aws.neon.tech');
    expect(hostOf('not a url')).toBe('unknown host');
  });

  it('redact removes the URL and its password from a message', () => {
    expect(redact(`connect failed: ${URL_}`, URL_)).not.toMatch(/pw-s3cret|owner:/);
    expect(redact('password authentication failed near pw-s3cret', URL_)).not.toContain('pw-s3cret');
    expect(redact('plain error', URL_)).toBe('plain error');
  });
});

describe('errorText', () => {
  it('reads Errors, the driver\'s ErrorEvent shape, and anything else', () => {
    expect(errorText(new Error('relation "t" already exists'))).toBe('relation "t" already exists');
    expect(errorText({ type: 'error', message: 'connect ECONNREFUSED 127.0.0.1:443' })).toBe('connect ECONNREFUSED 127.0.0.1:443');
    expect(errorText({ type: 'error', error: { message: 'boom' } })).toBe('boom');
    expect(errorText({ type: 'close' })).toBe('close event');
    expect(errorText({})).toBe('unknown error');
    expect(errorText('text')).toBe('text');
  });
});

describe('pendingEntries', () => {
  const e = (tag: string, when: number) => ({ idx: 0, when, tag });
  const entries = [e('0000_a', 100), e('0001_b', 200), e('0002_c', 300)];

  it('is every entry newer than the newest applied row (the drizzle migrator rule)', () => {
    expect(pendingEntries(entries, ['100']).pending.map((x: { tag: string }) => x.tag)).toEqual(['0001_b', '0002_c']);
    expect(pendingEntries(entries, [100, '200']).pending.map((x: { tag: string }) => x.tag)).toEqual(['0002_c']);
    expect(pendingEntries(entries, [100, 200, 300]).pending).toEqual([]);
    expect(pendingEntries(entries, []).pending).toHaveLength(3);
  });

  it('reports a gap (unapplied but older than the newest applied) as skipped, never pending', () => {
    const r = pendingEntries(entries, [100, 300]);
    expect(r.pending).toEqual([]);
    expect(r.skipped.map((x: { tag: string }) => x.tag)).toEqual(['0001_b']);
  });

  it('a database ahead of the journal (rollback build) has nothing pending', () => {
    expect(pendingEntries(entries, [100, 200, 300, 400]).pending).toEqual([]);
  });
});

const ADDITIVE = 'ALTER TABLE "t" ADD COLUMN "c" text;';
const UNMARKED = 'ALTER TABLE "t" DROP COLUMN "c";';
const BEFORE = '-- migration-guard: allow-destructive widen the check to a superset of roles\nALTER TABLE "t" DROP CONSTRAINT "k";';
const AFTER = '-- migration-guard: allow-destructive after-deploy the new build no longer selects "c"\nALTER TABLE "t" DROP COLUMN "c";';
const SHORT = '-- migration-guard: allow-destructive too short\nDROP TABLE "t";';

describe('classifyMigration', () => {
  it.each([
    [ADDITIVE, 'additive'],
    [BEFORE, 'before-deploy'],
    [AFTER, 'after-deploy'],
    [UNMARKED, 'refused'],
    [SHORT, 'refused'],
    ['-- migration-guard: allow-destructive\nDROP TABLE "t";', 'refused'],
  ])('%s → %s', (sql, kind) => {
    expect(classifyMigration(sql).kind).toBe(kind);
  });

  it('an after-deploy marker on purely additive SQL is just additive (same as the CI guard)', () => {
    expect(classifyMigration(`-- migration-guard: allow-destructive after-deploy nothing destructive here\n${ADDITIVE}`).kind).toBe('additive');
  });
});

describe('planMigrations', () => {
  const e = (tag: string, when: number) => ({ idx: 0, when, tag });
  const plan = (files: Record<string, string>) =>
    planMigrations(
      Object.keys(files).map((tag, i) => e(tag, 1000 + i)),
      (tag: string) => files[tag],
    );
  const tags = (xs: Array<{ tag: string }>) => xs.map((x) => x.tag);

  it('applies additive and reviewed before-deploy migrations', () => {
    const p = plan({ '0001_a': ADDITIVE, '0002_b': BEFORE });
    expect(p.errors).toEqual([]);
    expect(tags(p.apply)).toEqual(['0001_a', '0002_b']);
    expect(p.waiting).toEqual([]);
  });

  it('refuses an unmarked destructive migration, naming the file', () => {
    const p = plan({ '0001_a': ADDITIVE, '0002_b': UNMARKED });
    expect(p.errors.join('\n')).toMatch(/drizzle\/0002_b\.sql/);
  });

  it('refuses a marker whose reason is under 10 characters', () => {
    expect(plan({ '0001_a': SHORT }).errors.join('\n')).toMatch(/0001_a/);
  });

  it('leaves trailing after-deploy entries waiting and applies everything before them', () => {
    const p = plan({ '0001_a': ADDITIVE, '0002_b': AFTER, '0003_c': AFTER });
    expect(p.errors).toEqual([]);
    expect(tags(p.apply)).toEqual(['0001_a']);
    expect(tags(p.waiting)).toEqual(['0002_b', '0003_c']);
  });

  it('fails when a non-after-deploy entry follows a pending after-deploy one', () => {
    const p = plan({ '0001_a': AFTER, '0002_b': ADDITIVE });
    expect(p.errors.join('\n')).toMatch(/0002_b[^\n]*0001_a|0001_a[^\n]*0002_b/);
  });

  it('fails when a pending migration file is missing', () => {
    const p = planMigrations([e('0001_a', 1)], () => {
      throw new Error('ENOENT');
    });
    expect(p.errors.join('\n')).toMatch(/0001_a/);
  });
});

// run() end to end with a fake database: a query log, the applied rows, and a
// migrate() that "applies" every journal entry newer than the newest row, as
// node_modules/drizzle-orm/pg-core/dialect.js:62 does.
describe('run', () => {
  let cwd: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);

  const journal = (entries: Array<[string, number]>) =>
    writeFileSync(
      join(cwd, 'drizzle/meta/_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: entries.map(([tag, when], idx) => ({ idx, version: '7', when, tag, breakpoints: true })) }),
    );
  const sql = (tag: string, body: string) => writeFileSync(join(cwd, 'drizzle', `${tag}.sql`), body);

  type Fake = {
    log: string[];
    applied: number[];
    migratedFolders: string[];
    closed: boolean;
    openedWith: string[];
    open: (url: string) => Promise<{ query: (t: string) => Promise<{ rows: unknown[] }>; migrate: (f: string) => Promise<void>; close: () => Promise<void> }>;
  };
  const fakeDb = (applied: number[], opts: { failOn?: RegExp; migrateError?: Error; onLock?: () => void } = {}): Fake => {
    const f: Fake = {
      log: [],
      applied: [...applied],
      migratedFolders: [],
      closed: false,
      openedWith: [],
      open: async (url: string) => {
        f.openedWith.push(url);
        return {
          query: async (text: string) => {
            f.log.push(text);
            if (opts.failOn?.test(text)) throw new Error(`boom on ${text}`);
            if (/pg_advisory_lock/.test(text)) opts.onLock?.();
            if (/to_regclass/.test(text)) return { rows: [{ t: f.applied.length ? 'drizzle.__drizzle_migrations' : null }] };
            if (/FROM drizzle\.__drizzle_migrations/.test(text)) return { rows: f.applied.map((w) => ({ created_at: String(w) })) };
            return { rows: [] };
          },
          migrate: async (folder: string) => {
            f.log.push('MIGRATE');
            f.migratedFolders.push(folder);
            if (opts.migrateError) throw opts.migrateError;
            const j = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
            const last = Math.max(-Infinity, ...f.applied);
            for (const e of j.entries) {
              readFileSync(join(folder, `${e.tag}.sql`), 'utf8');
              if (e.when > last) f.applied.push(e.when);
            }
          },
          close: async () => {
            f.log.push('CLOSE');
            f.closed = true;
          },
        };
      },
    };
    return f;
  };

  const go = (env: Record<string, string | undefined>, db: Fake) => run({ env, cwd, out, openDb: db.open });
  const prodEnv = { ...PROD, DATABASE_URL_UNPOOLED: URL_ };

  beforeEach(() => {
    lines = [];
    cwd = mkdtempSync(join(tmpdir(), 'mob-'));
    mkdirSync(join(cwd, 'drizzle/meta'), { recursive: true });
    sql('0000_a', 'CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL);');
    sql('0001_b', ADDITIVE);
    journal([['0000_a', 1000], ['0001_b', 2000]]);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it.each([
    [{ VERCEL_ENV: 'preview', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_COMMIT_REF: 'main', DATABASE_URL_UNPOOLED: URL_ }],
    [{ VERCEL_ENV: 'development', DATABASE_URL_UNPOOLED: URL_ }],
    [{}],
  ])('skips (exit 0, one line, no connection) outside a production build: %o', async (env) => {
    const db = fakeDb([1000]);
    expect(await go(env, db)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^migrate-on-build: skipped \(.+\)$/);
    expect(db.openedWith).toEqual([]);
  });

  it.each([
    [{ VERCEL_ENV: 'production', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_COMMIT_REF: 'fix/x', DATABASE_URL_UNPOOLED: URL_ }],
    [{ VERCEL_ENV: 'production', DATABASE_URL_UNPOOLED: URL_ }],
  ])('fails (exit 1, no connection) a production build that is not main from GitHub: %o', async (env) => {
    const db = fakeDb([1000]);
    expect(await go(env, db)).toBe(1);
    expect(lines.join('\n')).toMatch(/^migrate-on-build: error: .*MIGRATE_ON_BUILD_SKIP=1/m);
    expect(db.openedWith).toEqual([]);
  });

  it('MIGRATE_ON_BUILD_SKIP=1 lets such a build through with a loud warning (exit 0, no connection)', async () => {
    const db = fakeDb([1000]);
    expect(await go({ VERCEL_ENV: 'production', DATABASE_URL_UNPOOLED: URL_, MIGRATE_ON_BUILD_SKIP: '1' }, db)).toBe(0);
    expect(lines.join('\n')).toMatch(/^migrate-on-build: WARNING: .*MIGRATE_ON_BUILD_SKIP=1.*NOT/m);
    expect(db.openedWith).toEqual([]);
  });

  it('fails closed (exit 1) in production without a database URL', async () => {
    const db = fakeDb([1000]);
    expect(await go({ ...PROD }, db)).toBe(1);
    expect(lines.join('\n')).toMatch(/DATABASE_URL_UNPOOLED/);
    expect(db.openedWith).toEqual([]);
  });

  it('applies the pending additive migration and prints one line per tag, never the URL', async () => {
    const db = fakeDb([1000]);
    expect(await go(prodEnv, db)).toBe(0);
    expect(db.openedWith).toEqual([URL_]);
    expect(lines).toContain('migrate-on-build: applied 0001_b');
    expect(db.applied).toEqual([1000, 2000]);
    expect(lines.join('\n')).not.toMatch(/pw-s3cret|owner:/);
    expect(lines.join('\n')).toContain('ep-x-direct.us-east-2.aws.neon.tech');
    expect(db.closed).toBe(true);
  });

  it('takes the advisory lock before reading pending, sets the timeouts, migrates, then unlocks and closes', async () => {
    const db = fakeDb([1000]);
    await go(prodEnv, db);
    const at = (re: RegExp) => db.log.findIndex((l) => re.test(l));
    expect(at(new RegExp(`pg_advisory_lock\\(${LOCK_KEY}\\)`))).toBeGreaterThanOrEqual(0);
    expect(at(/statement_timeout = '120s'/)).toBeLessThan(at(/pg_advisory_lock/));
    expect(at(/pg_advisory_lock/)).toBeLessThan(at(/lock_timeout = '10s'/));
    // 120 s only bounds the wait for the lock; the migration itself gets 30 s per statement.
    expect(at(/pg_advisory_lock/)).toBeLessThan(at(/statement_timeout = '30s'/));
    expect(at(/statement_timeout = '30s'/)).toBeLessThan(at(/^MIGRATE$/));
    expect(at(/lock_timeout = '10s'/)).toBeLessThan(at(/FROM drizzle\.__drizzle_migrations/));
    expect(at(/FROM drizzle\.__drizzle_migrations/)).toBeLessThan(at(/^MIGRATE$/));
    expect(at(/^MIGRATE$/)).toBeLessThan(at(new RegExp(`pg_advisory_unlock\\(${LOCK_KEY}\\)`)));
    expect(db.log[db.log.length - 1]).toBe('CLOSE');
  });

  it('re-reads pending under the lock: another build that migrated meanwhile leaves nothing to apply', async () => {
    const db = fakeDb([1000], { onLock: () => db.applied.push(2000) });
    expect(await go(prodEnv, db)).toBe(0);
    expect(lines).toContain('migrate-on-build: nothing to apply');
    expect(db.migratedFolders).toEqual([]);
  });

  it('nothing to apply when the database is current', async () => {
    const db = fakeDb([1000, 2000]);
    expect(await go(prodEnv, db)).toBe(0);
    expect(lines).toContain('migrate-on-build: nothing to apply');
    expect(db.migratedFolders).toEqual([]);
    expect(db.log).toContainEqual(expect.stringMatching(/pg_advisory_unlock/));
  });

  it('refuses an unmarked destructive pending migration (exit 1, nothing migrated, lock released)', async () => {
    sql('0002_c', UNMARKED);
    journal([['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000]]);
    const db = fakeDb([1000]);
    expect(await go(prodEnv, db)).toBe(1);
    expect(lines.join('\n')).toMatch(/drizzle\/0002_c\.sql/);
    expect(db.migratedFolders).toEqual([]);
    expect(db.log).toContainEqual(expect.stringMatching(/pg_advisory_unlock/));
    expect(db.closed).toBe(true);
  });

  it('applies a reviewed before-deploy step', async () => {
    sql('0002_c', BEFORE);
    journal([['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000]]);
    const db = fakeDb([1000]);
    expect(await go(prodEnv, db)).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(['migrate-on-build: applied 0001_b', 'migrate-on-build: applied 0002_c']));
  });

  it('skips a trailing after-deploy step with a warning, migrating a truncated copy of drizzle/', async () => {
    sql('0002_c', AFTER);
    journal([['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000]]);
    const db = fakeDb([1000]);
    expect(await go(prodEnv, db)).toBe(0);
    expect(db.applied).toEqual([1000, 2000]);
    expect(lines).toContain('migrate-on-build: applied 0001_b');
    expect(lines.join('\n')).toMatch(/after-deploy migration 0002_c waits for a manual apply/);
    const folder = db.migratedFolders[0];
    expect(folder).not.toBe(join(cwd, 'drizzle'));
    // The temp copy is removed afterwards; the checkout's journal is untouched.
    expect(existsSync(folder)).toBe(false);
    expect(JSON.parse(readFileSync(join(cwd, 'drizzle/meta/_journal.json'), 'utf8')).entries).toHaveLength(3);
  });

  it('only after-deploy pending: nothing to apply, the warning, exit 0', async () => {
    sql('0002_c', AFTER);
    journal([['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000]]);
    const db = fakeDb([1000, 2000]);
    expect(await go(prodEnv, db)).toBe(0);
    expect(db.migratedFolders).toEqual([]);
    expect(lines.join('\n')).toMatch(/after-deploy migration 0002_c waits for a manual apply/);
  });

  it('fails (exit 1) when an entry follows a pending after-deploy step', async () => {
    sql('0002_c', AFTER);
    sql('0003_d', ADDITIVE);
    journal([['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000], ['0003_d', 4000]]);
    const db = fakeDb([1000]);
    expect(await go(prodEnv, db)).toBe(1);
    expect(lines.join('\n')).toMatch(/0003_d/);
    expect(db.migratedFolders).toEqual([]);
  });

  it('a migrator error fails the build (exit 1, redacted message), releases the lock and closes, and is not retried', async () => {
    const db = fakeDb([1000], { migrateError: new Error(`relation exists (${URL_})`) });
    expect(await go(prodEnv, db)).toBe(1);
    expect(db.migratedFolders).toHaveLength(1);
    const text = lines.join('\n');
    expect(text).toMatch(/migrate-on-build: error/);
    expect(text).not.toMatch(/pw-s3cret|owner:/);
    expect(db.log).toContainEqual(expect.stringMatching(/pg_advisory_unlock/));
    expect(db.closed).toBe(true);
  });

  it('an error before the lock is taken does not try to unlock, but still closes', async () => {
    const db = fakeDb([1000], { failOn: /pg_advisory_lock/ });
    expect(await go(prodEnv, db)).toBe(1);
    expect(db.log.some((l) => /pg_advisory_unlock/.test(l))).toBe(false);
    expect(db.closed).toBe(true);
  });

  it('a failed connection exits 1 without printing the URL', async () => {
    const open = async () => {
      throw new Error(`could not connect to ${URL_}`);
    };
    expect(await run({ env: prodEnv, cwd, out, openDb: open })).toBe(1);
    expect(lines.join('\n')).not.toMatch(/pw-s3cret|owner:/);
  });

  it('fails when the migrator returns without recording a planned tag', async () => {
    const db = fakeDb([1000]);
    const open = async (url: string) => ({ ...(await db.open(url)), migrate: async () => {} });
    expect(await run({ env: prodEnv, cwd, out, openDb: open })).toBe(1);
    expect(lines.join('\n')).toMatch(/0001_b/);
  });

  it('fails (exit 1) on a gap entry the migrator will never apply, naming each tag, and migrates nothing', async () => {
    sql('0002_c', ADDITIVE);
    sql('0003_d', ADDITIVE);
    journal([['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000], ['0003_d', 4000]]);
    const db = fakeDb([2000]);
    expect(await go(prodEnv, db)).toBe(1);
    const text = lines.join('\n');
    expect(text).toMatch(/error[^\n]*0000_a/);
    expect(db.migratedFolders).toEqual([]);
    expect(db.log).toContainEqual(expect.stringMatching(/pg_advisory_unlock/));
    const db2 = fakeDb([1000, 3000]);
    lines = [];
    expect(await go(prodEnv, db2)).toBe(1);
    expect(lines.join('\n')).toMatch(/error[^\n]*0001_b/);
    expect(lines.join('\n')).not.toMatch(/0000_a/);
  });
});

// The real migrator (drizzle's pg-core dialect) on PGlite: the truncated
// journal really stops before the after-deploy step, and everything pending
// goes in.
describe('run against PGlite with drizzle\'s migrator', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mob-pg-'));
    mkdirSync(join(cwd, 'drizzle/meta'), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('applies 0000 and 0001, leaves the after-deploy 0002 for later', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    writeFileSync(join(cwd, 'drizzle/0000_a.sql'), 'CREATE TABLE "t" ("id" text PRIMARY KEY NOT NULL, "c" text);');
    writeFileSync(join(cwd, 'drizzle/0001_b.sql'), 'ALTER TABLE "t" ADD COLUMN "d" text;');
    writeFileSync(join(cwd, 'drizzle/0002_c.sql'), AFTER);
    writeFileSync(
      join(cwd, 'drizzle/meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1000, tag: '0000_a', breakpoints: true },
          { idx: 1, version: '7', when: 2000, tag: '0001_b', breakpoints: true },
          { idx: 2, version: '7', when: 3000, tag: '0002_c', breakpoints: true },
        ],
      }),
    );
    const pg = new PGlite();
    const db = drizzle(pg);
    const lines: string[] = [];
    const code = await run({
      env: { ...PROD, DATABASE_URL: 'postgresql://u:p@localhost/db' },
      cwd,
      out: (l: string) => lines.push(l),
      openDb: async () => ({
        query: (text: string) => pg.query(text),
        migrate: (folder: string) => migrate(db, { migrationsFolder: folder }),
        close: async () => {},
      }),
    });
    expect(lines).toEqual(expect.arrayContaining(['migrate-on-build: applied 0000_a', 'migrate-on-build: applied 0001_b']));
    expect(code).toBe(0);
    const cols = await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 't' ORDER BY column_name`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(['c', 'd', 'id']);
    const applied = await pg.query<{ created_at: string }>('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
    expect(applied.rows.map((r) => Number(r.created_at))).toEqual([1000, 2000]);
    await pg.close();
  }, 30_000);
});
