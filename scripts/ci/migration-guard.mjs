#!/usr/bin/env node
/**
 * Migration safety gate for pull requests (ci.yml `migrations` job).
 *
 * Production applies additive migrations in the Vercel production build
 * (scripts/migrate-on-build.mjs, package.json "vercel-build"), before
 * `next build`, so a build never goes live ahead of its migration. drizzle
 * selects explicit column lists, so a build that reaches production before
 * its migration breaks every query on the altered table (2026-06-11 outage).
 * That build-time apply is safe only for migrations the build that is still
 * serving can live with, which this gate enforces:
 *
 * 1. Expand only. Every drizzle/*.sql the PR adds must be additive, so it can
 *    run while the old build still serves. A destructive (contract) statement
 *    (DROP, RENAME, a column type change, SET NOT NULL, ADD COLUMN NOT NULL
 *    without DEFAULT, TRUNCATE, DELETE, UPDATE) fails the PR unless the file
 *    carries a comment line
 *        -- migration-guard: allow-destructive [after-deploy] <reason>
 *    Without `after-deploy` the reviewed statement is applied by the
 *    production build like an additive one (e.g. widening a CHECK, as 0028
 *    did: the new build writes the new values), so check the live build works
 *    with it. With it, the build never applies the step: it is applied by
 *    hand AFTER the deploy (e.g. dropping a column the new build no longer
 *    selects); the post-deploy smoke checks it.
 * 2. Journal sanity. A new entry must be newer than every entry the base has
 *    (the drizzle migrator applies only `when` > the newest applied row,
 *    node_modules/drizzle-orm/pg-core/dialect.js:62, so an older one would be
 *    skipped forever); every new .sql has a journal entry and vice versa; an
 *    already-merged migration is never deleted (editing one only warns: the
 *    database never re-runs it).
 *
 *   node scripts/ci/migration-guard.mjs
 *
 * Env: EVENT_NAME (pull_request | merge_group; anything else skips),
 * PR_BASE_SHA/PR_HEAD_SHA or MG_BASE_SHA/MG_HEAD_SHA. Exit 0 pass, 1 a
 * finding, 2 the check could not run (fail-closed). It reads only git; it
 * never calls production.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MARKER = /^[ \t]*--[ \t]*migration-guard:[ \t]*allow-destructive\b(.*)$/im;
const MIN_REASON = 10;

/**
 * Comment, string, identifier and dollar-quoted ranges of `sql`, in order.
 * @param {string} sql
 * @returns {Array<{kind: 'comment' | 'string' | 'ident' | 'dollar', from: number, to: number}>}
 */
function sqlRanges(sql) {
  const ranges = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = sql.length;
      ranges.push({ kind: 'comment', from: i, to: j });
      i = j;
    } else if (c === '/' && n === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j < 0 ? sql.length : j + 2;
      ranges.push({ kind: 'comment', from: i, to: j });
      i = j;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      // The body only: the quotes themselves stay.
      ranges.push({ kind: c === '"' ? 'ident' : 'string', from: i + 1, to: Math.min(j, sql.length) });
      i = j + 1;
    } else if (c === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (!tag) {
        i++;
        continue;
      }
      const close = sql.indexOf(tag[0], i + tag[0].length);
      const end = close < 0 ? sql.length : close + tag[0].length;
      ranges.push({ kind: 'dollar', from: i, to: end });
      i = end;
    } else {
      i++;
    }
  }
  return ranges;
}

/**
 * Same-length copy of `sql` with comments and string/dollar-quoted bodies
 * blanked (newlines kept) and double-quoted identifier contents replaced by
 * `x`, so keyword rules never match inside text, comments or names.
 * @param {string} sql
 */
export function maskSql(sql) {
  const out = sql.split('');
  for (const r of sqlRanges(sql)) {
    const ch = r.kind === 'ident' ? 'x' : ' ';
    for (let k = r.from; k < r.to; k++) if (out[k] !== '\n') out[k] = ch;
  }
  return out.join('');
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** Rules that can match anywhere in a statement. */
const INLINE_RULES = [
  { rule: 'drop', re: /\bDROP\b(?!\s+NOT\s+NULL\b)/gi, why: 'drops a table, column, index, constraint or default' },
  { rule: 'rename', re: /\bRENAME\b/gi, why: 'renames something the running build still uses' },
  {
    rule: 'type-change',
    re: /\bALTER\s+COLUMN\s+(?:"x*"|[A-Za-z_][A-Za-z0-9_]*)\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
    why: 'changes a column type',
  },
  { rule: 'set-not-null', re: /\bSET\s+NOT\s+NULL\b/gi, why: 'makes a column NOT NULL, so the running build\'s inserts can fail' },
];

/** Rules keyed on the statement's first keyword. */
const LEADING_RULES = [
  { rule: 'truncate', re: /^TRUNCATE\b/i, why: 'deletes every row' },
  { rule: 'delete', re: /^DELETE\b/i, why: 'deletes rows' },
  { rule: 'update', re: /^UPDATE\b/i, why: 'rewrites existing rows' },
];

/**
 * Destructive (contract) statements in one migration file.
 * @param {string} sql
 * @returns {Array<{rule: string, line: number, text: string, why: string}>}
 */
export function findDestructive(sql) {
  const masked = maskSql(sql);
  const found = [];
  let start = 0;
  for (const piece of masked.split(';')) {
    const lead = piece.length - piece.trimStart().length;
    const stmtStart = start + lead;
    const stmt = piece.trim();
    const textOf = (from, to) => sql.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (stmt) {
      for (const r of LEADING_RULES) {
        if (r.re.test(stmt)) found.push({ rule: r.rule, line: lineAt(sql, stmtStart), text: textOf(stmtStart, start + piece.length), why: r.why });
      }
      for (const r of INLINE_RULES) {
        for (const m of piece.matchAll(r.re)) {
          found.push({ rule: r.rule, line: lineAt(sql, start + m.index), text: textOf(stmtStart, start + piece.length), why: r.why });
        }
      }
      // Each ADD COLUMN clause on its own: up to the next top-level clause.
      const adds = [...piece.matchAll(/\bADD\s+COLUMN\b/gi)];
      adds.forEach((m, k) => {
        const end = k + 1 < adds.length ? adds[k + 1].index : piece.length;
        let clause = piece.slice(m.index, end);
        const next = /,\s*(?:ADD|DROP|ALTER|RENAME)\b/i.exec(clause);
        if (next) clause = clause.slice(0, next.index);
        const notNull = /\bNOT\s+NULL\b/i.test(clause) || /\bPRIMARY\s+KEY\b/i.test(clause);
        if (notNull && !/\bDEFAULT\b/i.test(clause) && !/\bGENERATED\b/i.test(clause)) {
          found.push({
            rule: 'add-not-null-no-default',
            line: lineAt(sql, start + m.index),
            text: textOf(start + m.index, start + m.index + clause.length),
            why: 'adds a NOT NULL column without a DEFAULT, so the running build\'s inserts fail',
          });
        }
      });
    }
    start += piece.length + 1;
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * The override marker in one migration file, or null when there is none.
 * `reason` is '' for a marker without one. Only a real comment line counts
 * (not text inside a string).
 * @param {string} sql
 * @returns {{reason: string, afterDeploy: boolean} | null}
 */
export function parseOverride(sql) {
  const m = MARKER.exec(sql);
  if (!m) return null;
  // The marker must start a real comment, not sit inside a string.
  const offset = m.index + m[0].indexOf('--');
  if (!sqlRanges(sql).some((r) => r.kind === 'comment' && r.from === offset)) return null;
  const rest = m[1].trim();
  const afterDeploy = /^after-deploy\b/i.test(rest);
  return { reason: afterDeploy ? rest.replace(/^after-deploy\b/i, '').trim() : rest, afterDeploy };
}

/** @typedef {{idx: number, when: number, tag: string}} Entry */

/** @param {{entries: Entry[]}} base @param {{entries: Entry[]}} head @returns {Entry[]} */
export function newJournalEntries(base, head) {
  const known = new Set(base.entries.map((e) => e.tag));
  return head.entries.filter((e) => !known.has(e.tag)).map(({ idx, when, tag }) => ({ idx, when, tag }));
}

/** New entries the drizzle migrator would skip: not newer than the base's newest. */
export function orderingProblems(base, entries) {
  const newest = Math.max(0, ...base.entries.map((e) => Number(e.when)));
  return entries.filter((e) => Number(e.when) <= newest);
}

// GitHub workflow-command escaping (data and properties).
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const annotate = (level, msg, { file, line, title } = {}) => {
  const props = [file && `file=${escProp(file)}`, line && `line=${line}`, title && `title=${escProp(title)}`].filter(Boolean);
  return `::${level}${props.length ? ` ${props.join(',')}` : ''}::${esc(msg)}`;
};

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   cwd?: string,
 *   out?: (line: string) => void,
 * }} opts
 * @returns {Promise<0 | 1 | 2>}
 */
export async function runGuard({ env, cwd = process.cwd(), out = console.log }) {
  const event = env.EVENT_NAME ?? '';
  let baseRef;
  let headRef;
  if (event === 'pull_request') [baseRef, headRef] = [env.PR_BASE_SHA, env.PR_HEAD_SHA];
  else if (event === 'merge_group') [baseRef, headRef] = [env.MG_BASE_SHA, env.MG_HEAD_SHA];
  else {
    out(annotate('notice', `Migration guard runs on pull requests only (event: ${event || 'none'}); nothing checked.`, { title: 'Migration guard skipped' }));
    return 0;
  }

  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cannot = (msg) => {
    out(annotate('error', msg, { title: 'Migration guard could not run' }));
    return 2;
  };
  if (!/^[0-9a-f]{40}$/i.test(baseRef ?? '') || !/^[0-9a-f]{40}$/i.test(headRef ?? '')) {
    return cannot('The base and head commits of this change are missing from the event.');
  }
  let mergeBase;
  try {
    git('cat-file', '-e', `${baseRef}^{commit}`);
    git('cat-file', '-e', `${headRef}^{commit}`);
    mergeBase = git('merge-base', baseRef, headRef).trim();
  } catch {
    return cannot(`Commit ${baseRef.slice(0, 7)} or ${headRef.slice(0, 7)} is not in the clone (checkout needs fetch-depth: 0).`);
  }

  const readJournal = (ref) => {
    try {
      return JSON.parse(git('show', `${ref}:drizzle/meta/_journal.json`));
    } catch {
      return { entries: [] };
    }
  };
  const baseJournal = readJournal(mergeBase);
  const headJournal = readJournal(headRef);
  const added = newJournalEntries(baseJournal, headJournal);

  const changes = git('diff', '--name-status', '--no-renames', mergeBase, headRef, '--', 'drizzle/')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, path]) => /^drizzle\/[^/]+\.sql$/.test(path));

  let failed = false;
  const fail = (msg, where) => {
    failed = true;
    out(annotate('error', msg, where));
  };

  const addedSql = new Set();
  for (const [status, path] of changes) {
    if (status === 'A') addedSql.add(path);
    else if (status === 'D') {
      fail(`${path} is a merged migration and must not be deleted: databases that applied it keep it, and its journal history would no longer match.`, {
        file: path,
        title: 'Merged migration deleted',
      });
    } else {
      out(
        annotate('warning', `${path} was already merged. Editing it changes nothing in production (the database never re-runs it). Put the change in a new migration instead.`, {
          file: path,
          title: 'Merged migration edited',
        }),
      );
    }
  }

  const tagOf = (path) => path.slice('drizzle/'.length, -'.sql'.length);
  const addedTags = new Set(added.map((e) => e.tag));
  for (const path of addedSql) {
    if (!addedTags.has(tagOf(path))) {
      fail(`${path} is not in drizzle/meta/_journal.json, so drizzle-kit migrate would never apply it. Generate migrations with npx drizzle-kit generate.`, {
        file: path,
        title: 'Migration not in the journal',
      });
    }
  }
  for (const e of added) {
    if (!addedSql.has(`drizzle/${e.tag}.sql`)) {
      fail(`The journal lists ${e.tag} but this change adds no drizzle/${e.tag}.sql.`, { title: 'Journal entry without SQL' });
    }
  }
  // Ordering against the base branch's CURRENT tip, not the merge base: a
  // migration merged to main after this branch was cut is already applied in
  // production, so a new entry older than it would be skipped there.
  const tipJournal = readJournal(baseRef);
  for (const e of orderingProblems({ entries: [...baseJournal.entries, ...tipJournal.entries] }, added)) {
    fail(
      `${e.tag} has journal time ${e.when}, not newer than the newest migration on the base branch. The drizzle migrator only applies migrations newer than the last one applied, so production would skip it. Merge the current main into this branch, delete this migration and run npx drizzle-kit generate again.`,
      { file: `drizzle/${e.tag}.sql`, title: 'Migration would be skipped' },
    );
  }

  for (const path of [...addedSql].sort()) {
    const sql = readFileSafe(git, headRef, path);
    const findings = findDestructive(sql);
    if (findings.length === 0) continue;
    const marker = parseOverride(sql);
    if (marker && marker.reason.length >= MIN_REASON) {
      const when = marker.afterDeploy
        ? 'The production build will NOT apply it: apply it with /migrate-prod AFTER this change is deployed, once no live build uses what it changes.'
        : 'The production build applies it before the new code goes live, while the current build still serves, so check the current build works with it.';
      for (const f of findings) {
        out(
          annotate('warning', `Reviewed destructive statement (${marker.reason}): ${f.text}. ${when}`, {
            file: path,
            line: f.line,
            title: `Destructive migration allowed (${f.rule})`,
          }),
        );
      }
      continue;
    }
    for (const f of findings) {
      fail(
        `This statement ${f.why}: ${f.text}. New migrations must be additive so the production build can apply them while the current build still serves. Split it: add now, remove in a later PR. A deliberate, reviewed step needs a comment line "-- migration-guard: allow-destructive [after-deploy] <reason>" (reason at least ${MIN_REASON} characters).`,
        { file: path, line: f.line, title: `Destructive migration (${f.rule})` },
      );
    }
    if (marker) {
      fail(`The allow-destructive marker in ${path} needs a reason of at least ${MIN_REASON} characters.`, { file: path, title: 'Marker without a reason' });
    }
  }

  if (added.length === 0 && changes.length === 0) out('No migration changes in this pull request.');
  return failed ? 1 : 0;
}

function readFileSafe(git, ref, path) {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return '';
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runGuard({ env: process.env }).then(
    (code) => process.exit(code),
    (e) => {
      console.log(`::error title=Migration guard crashed::${esc(e instanceof Error ? e.message : String(e))}`);
      process.exit(2);
    },
  );
}
