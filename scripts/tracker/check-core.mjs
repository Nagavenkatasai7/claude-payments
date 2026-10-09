// Program Ledger v2, CHECK step: PURE functions (no I/O). curate.mjs check reads the dump, the
// project snapshot and this run's numbers, calls checkLedger, and writes meta/health (healthDoc).
// The page shows a red banner while ok is false; the routine posts one line per problem in its
// own thread only when the problem codes change. Tests: tests/tracker-check-core.test.ts.
//
// Node built-ins only (the routine runs this without npm install).
import { scrub } from './sync-core.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A merge after cutover that no ws lists is a problem once it is older than this. */
export const UNMAPPED_MERGE_GRACE_MS = 2 * HOUR;
/** Unread thread activity: amber after 3 h, red after 6 h. */
export const THREAD_DRIFT_AMBER_MS = 3 * HOUR;
export const THREAD_DRIFT_RED_MS = 6 * HOUR;
/** MEMORY.md changed this long after the curator last read it. */
export const MEMORY_DRIFT_MS = 26 * HOUR;
/** meta/state.syncedAt older than this: the hourly engine did not run. */
export const ENGINE_STALE_MS = 90 * MIN;
/** No reconcile (forced daily at 05 UTC) in this long. */
export const CURATOR_STALE_MS = 26 * HOUR;
/** The newest merge is this old and the headline still predates it. */
export const HEADLINE_BEHIND_MS = 6 * HOUR;
/** An open to-do with no update in this long. */
export const TODO_STALE_MS = 14 * DAY;
/** More than this share of the curator's ops rejected. */
export const REJECTED_RATIO_MAX = 0.3;
/** Ledger document count: amber at 18,000, red at 22,000. */
export const DOC_CAP_AMBER = 18_000;
export const DOC_CAP_RED = 22_000;

export const MESSAGE_MAX = 200;
const SEVERITY_RANK = { red: 0, amber: 1 };

const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };
const age = (ms) => (ms < HOUR ? `${Math.max(0, Math.floor(ms / MIN))} min` : ms < 2 * DAY ? `${Math.floor(ms / HOUR)} h` : `${Math.floor(ms / DAY)} d`);
const problem = (code, severity, section, message, ref = null) => ({ code, severity, section, message: scrub(message).slice(0, MESSAGE_MAX), ref });

/** Merge rows of the feed: [{n, at}], from gh-merge-<n> ids or kind 'merge' rows with refs.pr. */
function merges(feed) {
  const out = new Map();
  for (const row of feed ?? []) {
    const d = row?.data ?? row ?? {};
    const byId = String(row?.id ?? '').match(/^gh-merge-(\d+)$/);
    const nums = byId ? [Number(byId[1])] : d.kind === 'merge' && Array.isArray(d.refs?.pr) ? d.refs.pr : [];
    for (const n of nums) if (Number.isInteger(n) && time(d.at) > (out.get(n) ?? 0)) out.set(n, time(d.at));
  }
  return [...out].map(([n, at]) => ({ n, at }));
}

/**
 * Ledger health. Every input is optional; a missing one makes its rule fire only where the
 * absence itself is the problem (engine_stale, curator_stale).
 * ok is false when any problem is red. Problems: red first, then amber, in rule order.
 * @param {{
 *   now: string, cutoverAt?: string|null,
 *   state?: any, headline?: any, sync?: any, cursors?: any,
 *   ws?: Record<string, any>, todo?: Record<string, any>, decisions?: Record<string, any>,
 *   feed?: Array<{id: string, data?: any}>,
 *   threads?: Array<{threadId: string, title: string, bucket: string, lastActivityAt: string|null}>,
 *   memoryStat?: {mtime: string}|null,
 *   tools?: {threads: boolean, prs: boolean, artifacts: boolean}|null,
 *   curator?: {accepted: number, rejected: number}|null,
 *   prTitles?: Record<string, string>,
 *   docCount?: number,
 * }} input
 * @returns {{ok: boolean, problems: Array<{code: string, severity: 'red'|'amber', section: string, message: string, ref: string|null}>}}
 */
export function checkLedger(input) {
  const { state, headline, sync, cursors, ws = {}, todo = {}, decisions = {}, feed = [], threads = [], memoryStat, tools, curator, prTitles = {}, docCount, cutoverAt } = input;
  const now = time(input.now);
  const routine = sync?.routineThreadId ?? null;
  const problems = [];
  // A PR is mapped when collect lists it in a ws's facts (session key) or the curator attached it (prsCurated).
  const wsPrs = new Set(Object.values(ws).flatMap((w) => [...(w?.facts?.prs ?? []).map((p) => p?.n), ...(Array.isArray(w?.prsCurated) ? w.prsCurated : [])]));
  const allMerges = merges(feed);

  // unmapped_merge
  for (const m of allMerges.sort((a, b) => a.at - b.at || a.n - b.n)) {
    if (cutoverAt && m.at < time(cutoverAt)) continue;
    if (now - m.at <= UNMAPPED_MERGE_GRACE_MS || wsPrs.has(m.n)) continue;
    problems.push(problem('unmapped_merge', 'red', 'workstreams', `PR #${m.n} merged ${age(now - m.at)} ago; no workstream lists it`, `#${m.n}`));
  }

  // thread_drift
  for (const t of threads) {
    if (!t || t.threadId === routine) continue;
    const c = cursors?.threads?.[t.threadId];
    if (c?.lastAt && time(t.lastActivityAt) <= time(c.lastAt)) continue;
    const drift = now - time(t.lastActivityAt);
    if (drift <= THREAD_DRIFT_AMBER_MS) continue;
    problems.push(problem('thread_drift', drift > THREAD_DRIFT_RED_MS ? 'red' : 'amber', 'workstreams', `${t.title || t.threadId} has messages the ledger has not read (${age(drift)})`, t.threadId));
  }

  // memory_drift
  if (memoryStat?.mtime && time(memoryStat.mtime) - time(cursors?.memory?.readAt) > MEMORY_DRIFT_MS) {
    problems.push(problem('memory_drift', 'amber', 'sync', `MEMORY.md changed ${age(now - time(memoryStat.mtime))} ago; the curator last read it ${cursors?.memory?.readAt ? `${age(now - time(cursors.memory.readAt))} ago` : 'never'}`, 'MEMORY.md'));
  }

  // engine_stale
  if (now - time(state?.syncedAt) > ENGINE_STALE_MS) {
    problems.push(problem('engine_stale', 'red', 'release', state?.syncedAt ? `The engine last synced ${age(now - time(state.syncedAt))} ago` : 'The engine has never synced', 'meta/state'));
  }

  // curator_stale
  if (now - time(sync?.reconcileAt) > CURATOR_STALE_MS) {
    problems.push(problem('curator_stale', 'red', 'sync', sync?.reconcileAt ? `No curator reconcile for ${age(now - time(sync.reconcileAt))}` : 'The curator has never reconciled', 'meta/sync'));
  }

  // headline_behind
  const newest = allMerges.reduce((m, x) => (!m || x.at > m.at ? x : m), null);
  if (newest && now - newest.at > HEADLINE_BEHIND_MS && time(headline?.asOf) < newest.at) {
    problems.push(problem('headline_behind', 'amber', 'now', `The headline predates PR #${newest.n}, merged ${age(now - newest.at)} ago`, `#${newest.n}`));
  }

  // blocked_unexplained
  for (const t of threads) {
    if (!t || t.threadId === routine || t.bucket !== 'blocked') continue;
    const key = cursors?.threads?.[t.threadId]?.ws ?? Object.keys(ws).find((k) => (ws[k]?.facts?.threadIds ?? []).includes(t.threadId)) ?? null;
    const covers = (d) => d?.threadId === t.threadId || (key && d?.ws === key);
    const explained = Object.values(decisions).some((d) => d?.status === 'open' && covers(d)) || Object.values(todo).some((d) => (d?.status === 'open' || d?.status === 'acked') && covers(d));
    if (!explained) problems.push(problem('blocked_unexplained', 'red', 'decisions', `${t.title || t.threadId} is blocked, but no open decision or to-do says why`, t.threadId));
  }

  // todo_stale
  for (const id of Object.keys(todo).sort()) {
    const d = todo[id];
    if (d?.status !== 'open') continue;
    const since = now - time(d.updatedAt ?? d.createdAt);
    if (since > TODO_STALE_MS) problems.push(problem('todo_stale', 'amber', 'todo', `To-do "${d.title ?? id}" has had no update for ${age(since)}`, id));
  }

  // pr_title_drift
  const seen = new Set();
  for (const key of Object.keys(ws).sort()) {
    for (const p of ws[key]?.facts?.prs ?? []) {
      const current = prTitles[p?.n];
      if (!current || !p?.title || p.title === current || seen.has(p.n)) continue;
      seen.add(p.n);
      problems.push(problem('pr_title_drift', 'amber', 'workstreams', `Workstream ${key} shows an old title for PR #${p.n}`, `#${p.n}`));
    }
  }

  // pr_count_mismatch
  if (Number.isInteger(state?.openProgramPrs) && Number.isInteger(state?.programPrsFromThreads) && state.openProgramPrs !== state.programPrsFromThreads) {
    problems.push(problem('pr_count_mismatch', 'amber', 'release', `GitHub shows ${state.openProgramPrs} open program PRs; the project threads show ${state.programPrsFromThreads}`, 'meta/state'));
  }

  // threads_unreadable
  const avail = tools ?? sync?.toolsAvailable ?? null;
  const missing = avail ? ['threads', 'prs', 'artifacts'].filter((k) => avail[k] === false) : [];
  if (missing.length) problems.push(problem('threads_unreadable', 'amber', 'sync', `Project tools did not answer: ${missing.join(', ')}`, missing.join(',')));

  // rejected_ratio
  const acc = Number(curator?.accepted) || 0;
  const rej = Number(curator?.rejected) || 0;
  if (acc + rej > 0 && rej / (acc + rej) > REJECTED_RATIO_MAX) {
    problems.push(problem('rejected_ratio', 'amber', 'sync', `The curator had ${rej} of ${acc + rej} ops rejected`, null));
  }

  // doc_cap
  if (Number.isFinite(docCount) && docCount >= DOC_CAP_AMBER) {
    problems.push(problem('doc_cap', docCount >= DOC_CAP_RED ? 'red' : 'amber', 'sync', `The ledger holds ${docCount} documents (amber at ${DOC_CAP_AMBER}, red at ${DOC_CAP_RED})`, null));
  }

  // Stable sort: red first, rule order kept inside a severity.
  const sorted = problems.map((p, i) => [p, i]).sort((a, b) => SEVERITY_RANK[a[0].severity] - SEVERITY_RANK[b[0].severity] || a[1] - b[1]).map(([p]) => p);
  return { ok: !sorted.some((p) => p.severity === 'red'), problems: sorted };
}

const codesOf = (problems) => [...new Set((problems ?? []).map((p) => p?.code).filter(Boolean))].sort();

/**
 * The meta/health doc for this run, and whether the problem codes changed since the previous
 * one (the routine posts in its thread only then).
 * @param {{result: {ok: boolean, problems: any[]}, prev?: any, now: string, inputs?: Record<string, any>}} args
 * @returns {{doc: {at: string, ok: boolean, problems: any[], prevCodes: string[], inputs: Record<string, any>}, codes: string[], changed: boolean}}
 */
export function healthDoc({ result, prev, now, inputs = {} }) {
  const prevCodes = codesOf(prev?.problems);
  const codes = codesOf(result.problems);
  return {
    doc: { at: now, ok: result.ok, problems: result.problems, prevCodes, inputs },
    codes,
    changed: codes.join(',') !== prevCodes.join(','),
  };
}
