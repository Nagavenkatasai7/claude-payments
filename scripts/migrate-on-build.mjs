#!/usr/bin/env node
/**
 * Apply pending drizzle migrations in the Vercel production build, before
 * `next build` (package.json "vercel-build"; Vercel's Next.js builder runs
 * `vercel-build` in place of `build` when it exists and no Build Command
 * override is set: vercel/vercel packages/next/src/index.ts getScriptName
 * ['vercel-build', 'now-build', 'build']).
 *
 * drizzle selects explicit column lists, so a build that goes live before its
 * migration breaks every query on the altered table (2026-06-11 outage).
 * Applying here means the deploy cannot go live without its migration: a
 * failed apply fails the build and the previous build keeps serving.
 *
 * Runs only when VERCEL_ENV=production and VERCEL_GIT_COMMIT_REF=main (both
 * available at build time: vercel.com/docs/environment-variables/system-environment-variables).
 * Everything else prints "skipped" and exits 0; local `npm run build` never
 * calls this script.
 *
 * What is applied: the journal entries newer than the newest applied row of
 * drizzle.__drizzle_migrations, which is exactly what drizzle's migrator
 * applies (node_modules/drizzle-orm/pg-core/dialect.js:56-62, created_at is
 * the journal `when`: migrator.js:22, dialect.js:67). Each pending file is
 * classified with the CI guard's own rules (scripts/ci/migration-guard.mjs):
 *   - additive, or a reviewed `allow-destructive` step without after-deploy: applied;
 *   - destructive without a valid marker: refused (CI blocks these already);
 *   - `allow-destructive after-deploy`: never applied here. Trailing ones wait
 *     for a manual apply (warning); one followed by any other pending entry
 *     fails the build, because that later entry could not be applied.
 *
 * How: one dedicated connection, statement_timeout 120 s, a session-level
 * pg_advisory_lock (so two builds never migrate at once), lock_timeout 10 s
 * for the DDL, pending re-read UNDER the lock, then drizzle's own migrator on
 * that same connection: all pending migrations run in one transaction
 * (dialect.js:60 session.transaction; on a PoolClient the neon-serverless
 * session runs it on that client, neon-serverless/session.js:178-193).
 * Never retried. The URL is never printed (host only).
 *
 * Env: VERCEL_ENV, VERCEL_GIT_COMMIT_REF, DATABASE_URL_UNPOOLED (fallback
 * DATABASE_URL, as drizzle.config.ts). Exit 0 done or skipped, 1 failed.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findDestructive, parseOverride } from './ci/migration-guard.mjs';

/** pg_advisory_lock key: ASCII "SMRTMIGR" as a signed bigint. */
export const LOCK_KEY = '6002544400382117714';
const MIN_REASON = 10;
const P = 'migrate-on-build:';

/** @typedef {{idx: number, when: number, tag: string}} Entry */
/**
 * @typedef {{
 *   query: (text: string) => Promise<{rows: any[]}>,
 *   migrate: (migrationsFolder: string) => Promise<void>,
 *   close: () => Promise<void>,
 * }} BuildDb
 */

/**
 * Why this build does not migrate, or null when it must.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function skipReason(env) {
  const target = env.VERCEL_ENV ?? '';
  const ref = env.VERCEL_GIT_COMMIT_REF ?? '';
  if (!target) return 'not a Vercel production build: VERCEL_ENV is unset';
  if (target !== 'production') return `VERCEL_ENV is ${target}, not production`;
  if (!ref) return 'production build without a git branch (VERCEL_GIT_COMMIT_REF is unset)';
  if (ref !== 'main') return `branch ${ref} is not main`;
  return null;
}

/** @param {Record<string, string | undefined>} env */
export function databaseUrl(env) {
  return env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || '';
}

/** @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).hostname || 'unknown host';
  } catch {
    return 'unknown host';
  }
}

/**
 * `message` with the connection string and its password removed.
 * @param {string} message @param {string} url
 */
export function redact(message, url) {
  let out = String(message);
  const secrets = [url];
  try {
    const u = new URL(url);
    if (u.password) secrets.push(u.password, decodeURIComponent(u.password));
  } catch {
    // not a URL: only the whole string is redacted
  }
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}

/**
 * A readable message for anything thrown: the WebSocket driver rejects a
 * failed connect with an ErrorEvent (not an Error) whose `message` holds the text.
 * @param {unknown} e
 */
export function errorText(e) {
  if (e instanceof Error) return e.message || e.name;
  if (e && typeof e === 'object') {
    const o = /** @type {{message?: unknown, error?: {message?: unknown}, type?: unknown}} */ (e);
    if (typeof o.message === 'string' && o.message) return o.message;
    if (typeof o.error?.message === 'string' && o.error.message) return o.error.message;
    if (typeof o.type === 'string' && o.type) return `${o.type} event`;
    return 'unknown error';
  }
  return String(e);
}

/**
 * Journal entries the drizzle migrator will apply (newer than the newest
 * applied row), and gap entries it never will (unapplied but older).
 * @param {Entry[]} entries @param {unknown[]} appliedCreatedAt
 * @returns {{pending: Entry[], skipped: Entry[]}}
 */
export function pendingEntries(entries, appliedCreatedAt) {
  const applied = appliedCreatedAt.map((v) => Number(v));
  const newest = Math.max(-Infinity, ...applied);
  const appliedSet = new Set(applied);
  return {
    pending: entries.filter((e) => Number(e.when) > newest),
    skipped: entries.filter((e) => Number(e.when) <= newest && !appliedSet.has(Number(e.when))),
  };
}

/**
 * One migration file under the CI guard's rules.
 * @param {string} sql
 * @returns {{kind: 'additive' | 'before-deploy' | 'after-deploy' | 'refused', why?: string}}
 */
export function classifyMigration(sql) {
  const findings = findDestructive(sql);
  if (findings.length === 0) return { kind: 'additive' };
  const marker = parseOverride(sql);
  if (marker && marker.reason.length >= MIN_REASON) return { kind: marker.afterDeploy ? 'after-deploy' : 'before-deploy' };
  const first = findings[0];
  const why = marker
    ? `its allow-destructive marker needs a reason of at least ${MIN_REASON} characters`
    : `line ${first.line} ${first.why} (${first.text}) and the file has no reviewed allow-destructive marker`;
  return { kind: 'refused', why };
}

/**
 * Which pending entries this build applies, which wait for a manual
 * after-deploy apply, and why it must not go on.
 * @param {Entry[]} pending @param {(tag: string) => string} readSql
 * @returns {{apply: Entry[], waiting: Entry[], errors: string[]}}
 */
export function planMigrations(pending, readSql) {
  const errors = [];
  const kinds = pending.map((e) => {
    let sql;
    try {
      sql = readSql(e.tag);
    } catch {
      errors.push(`drizzle/${e.tag}.sql is in the journal but could not be read.`);
      return 'refused';
    }
    const c = classifyMigration(sql);
    if (c.kind === 'refused') errors.push(`drizzle/${e.tag}.sql is destructive and was not applied: ${c.why}.`);
    return c.kind;
  });
  const firstAfter = kinds.indexOf('after-deploy');
  if (firstAfter < 0) return { apply: pending, waiting: [], errors };
  for (let i = firstAfter + 1; i < pending.length; i++) {
    if (kinds[i] !== 'after-deploy') {
      errors.push(
        `${pending[i].tag} comes after the after-deploy migration ${pending[firstAfter].tag}, which this build must not apply, so ${pending[i].tag} cannot be applied either. Apply ${pending[firstAfter].tag} by hand first (/migrate-prod), then redeploy.`,
      );
    }
  }
  return { apply: pending.slice(0, firstAfter), waiting: pending.slice(firstAfter), errors };
}

/** @param {BuildDb} db @returns {Promise<unknown[]>} */
async function readApplied(db) {
  const t = await db.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
  if (!t.rows[0]?.t) return [];
  const r = await db.query('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
  return r.rows.map((row) => row.created_at);
}

/**
 * The real connection: @neondatabase/serverless over WebSocket, like
 * src/db/client.ts, with one dedicated PoolClient so the advisory lock, the
 * SETs and drizzle's migrator share a session.
 * @param {string} url @returns {Promise<BuildDb>}
 */
async function neonOpenDb(url) {
  const [{ Pool, neonConfig }, { drizzle }, { migrate }, { default: ws }] = await Promise.all([
    import('@neondatabase/serverless'),
    import('drizzle-orm/neon-serverless'),
    import('drizzle-orm/neon-serverless/migrator'),
    import('ws'),
  ]);
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  const c = client;
  // A PoolClient is not a drizzle config object (utils.js isConfig), so this
  // binds the session to this one connection.
  const db = drizzle(c);
  return {
    query: (text) => c.query(text),
    migrate: (migrationsFolder) => migrate(db, { migrationsFolder }),
    close: async () => {
      c.release();
      await pool.end();
    },
  };
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   cwd?: string,
 *   out?: (line: string) => void,
 *   openDb?: (url: string) => Promise<BuildDb>,
 * }} opts
 * @returns {Promise<0 | 1>}
 */
export async function run({ env, cwd = process.cwd(), out = console.log, openDb = neonOpenDb }) {
  const reason = skipReason(env);
  if (reason) {
    out(`${P} skipped (${reason})`);
    return 0;
  }
  const url = databaseUrl(env);
  if (!url) {
    out(`${P} error: DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set for this production build, so its migrations cannot be applied. Failing the build so it does not go live without them.`);
    return 1;
  }
  const drizzleDir = join(cwd, 'drizzle');
  /** @type {Entry[]} */
  let entries;
  try {
    entries = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')).entries;
    if (!Array.isArray(entries)) throw new Error('no entries');
  } catch (e) {
    out(`${P} error: drizzle/meta/_journal.json is unreadable (${errorText(e)}).`);
    return 1;
  }

  out(`${P} database host ${hostOf(url)}`);
  /** @type {BuildDb | undefined} */
  let db;
  let locked = false;
  let tmp = '';
  try {
    db = await openDb(url);
    // statement_timeout also bounds the wait for the lock (another build migrating).
    await db.query(`SET statement_timeout = '120s'`);
    await db.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
    locked = true;
    await db.query(`SET lock_timeout = '10s'`);

    const { pending, skipped } = pendingEntries(entries, await readApplied(db));
    for (const e of skipped) {
      out(`${P} warning: ${e.tag} is not applied but is older than the newest applied migration; the migrator will never apply it.`);
    }
    const plan = planMigrations(pending, (tag) => readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8'));
    if (plan.errors.length > 0) {
      for (const msg of plan.errors) out(`${P} error: ${msg}`);
      return 1;
    }
    for (const e of plan.waiting) {
      out(`${P} warning: after-deploy migration ${e.tag} waits for a manual apply (/migrate-prod once this build is live).`);
    }
    if (plan.apply.length === 0) {
      out(`${P} nothing to apply`);
      return 0;
    }

    let folder = drizzleDir;
    if (plan.waiting.length > 0) {
      // The migrator applies every journal entry newer than the newest row,
      // so hand it a copy whose journal stops before the first after-deploy step.
      tmp = mkdtempSync(join(tmpdir(), 'migrate-on-build-'));
      folder = join(tmp, 'drizzle');
      cpSync(drizzleDir, folder, { recursive: true });
      const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8'));
      const stop = journal.entries.findIndex((/** @type {Entry} */ e) => e.tag === plan.waiting[0].tag);
      journal.entries = journal.entries.slice(0, stop);
      writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal, null, 2));
    }

    await db.migrate(folder);

    const nowApplied = new Set((await readApplied(db)).map((v) => Number(v)));
    const missing = plan.apply.filter((e) => !nowApplied.has(Number(e.when)));
    if (missing.length > 0) {
      out(`${P} error: the migrator finished but ${missing.map((e) => e.tag).join(', ')} is not recorded in drizzle.__drizzle_migrations.`);
      return 1;
    }
    for (const e of plan.apply) out(`${P} applied ${e.tag}`);
    return 0;
  } catch (e) {
    out(`${P} error: ${redact(errorText(e), url)}`);
    return 1;
  } finally {
    if (db && locked) {
      try {
        await db.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
      } catch {
        // closing the session releases it anyway
      }
    }
    if (db) {
      try {
        await db.close();
      } catch {
        // nothing left to do
      }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run({ env: process.env }).then(
    (code) => process.exit(code),
    (e) => {
      console.log(`${P} error: ${redact(errorText(e), databaseUrl(process.env))}`);
      process.exit(1);
    },
  );
}
