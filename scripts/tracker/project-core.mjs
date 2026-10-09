// Program Ledger v2, COLLECT step: PURE functions (no I/O). collect.mjs reads the raw hearthbot
// snapshot (list_thread_sessions, list_project_prs, list_project_artifacts) and the ledger dump,
// and calls these. Tests: tests/tracker-project-core.test.ts.
//
// Node built-ins only (the routine runs this without npm install).
//
// Raw input shapes (hearthbot, checked 2026-10-08):
//   list_thread_sessions -> {sessions: [{thread_id, session_id 'cse_<k>', title, status, status_bucket,
//                            resolved, created_at, last_activity_at, ...}], next_cursor?}
//                           (pass one page, or an array of pages)
//   list_project_prs     -> {pull_requests: [{number, title, state, url, session_id 'session_<k>', head_ref, ...}]}
//   list_project_artifacts -> {artifacts: [{artifact_id, url, title, updated_at}]}
//   A tool that failed is saved as {unavailable: true}.
// A thread and the PRs it opened share the session key <k> (the part after the first '_').
import { createHash } from 'node:crypto';
import { scrub } from './sync-core.mjs';

/** Threads read per curator run at most (owner answer 2). */
export const CURATE_THREAD_CAP = 6;
/** About 150k input tokens at bytes/4. */
export const CURATE_BYTE_BUDGET = 600_000;
/** Estimated bytes of one fetch_thread page (25 messages) when the size is not known. */
export const THREAD_EST_BYTES = 100_000;

const WS_SLUG_MAX = 48;
// Most urgent first: the ws bucket is the most urgent bucket of its threads.
const BUCKET_ORDER = ['blocked', 'working', 'review_ready', 'failed', 'completed'];

const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };
const sha = (alg, s) => createHash(alg).update(s).digest('hex');
const sessionKey = (id) => (typeof id === 'string' && id.includes('_') ? id.slice(id.indexOf('_') + 1) : null);
const str = (x) => (typeof x === 'string' ? x : '');

/** True when a saved tool result is usable (not missing, not {unavailable: true}). */
const usable = (raw, field) => {
  if (raw === null || raw === undefined) return false;
  // An array is several pages (or bare rows): usable when no element is a failure marker.
  if (Array.isArray(raw)) return raw.every((p) => p && typeof p === 'object' && p.unavailable !== true);
  return typeof raw === 'object' && raw.unavailable !== true && Array.isArray(raw[field]);
};

/** Rows of a raw result: one page, an array of pages, or a bare array of rows. */
function rowsOf(raw, field) {
  if (!raw || typeof raw !== 'object' || raw.unavailable === true) return [];
  if (Array.isArray(raw)) return raw.flatMap((p) => (p && typeof p === 'object' && Array.isArray(p[field]) ? p[field] : p && typeof p === 'object' && !(field in p) ? [p] : []));
  return Array.isArray(raw[field]) ? raw[field] : [];
}

/**
 * @param {{threads?: unknown, prs?: unknown, artifacts?: unknown}} raw
 * @returns {{threads: boolean, prs: boolean, artifacts: boolean}}
 */
export function toolsAvailable({ threads, prs, artifacts }) {
  return { threads: usable(threads, 'sessions'), prs: usable(prs, 'pull_requests'), artifacts: usable(artifacts, 'artifacts') };
}

/**
 * Lowercase ASCII slug, words joined by '-', at most 48 characters.
 * @param {unknown} text
 */
export function slugify(text) {
  return str(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, WS_SLUG_MAX).replace(/-+$/, '');
}

/**
 * @typedef {{threadId: string, sessionId: string|null, sessionKey: string|null, title: string, bucket: string, status: string, resolved: boolean, createdAt: string|null, lastActivityAt: string|null}} Thread
 */

/**
 * list_thread_sessions (one page or several) -> threads, one per thread id (the newest row wins).
 * @param {unknown} raw
 * @returns {Thread[]}
 */
export function normalizeThreads(raw) {
  const byId = new Map();
  for (const r of rowsOf(raw, 'sessions')) {
    if (!r || typeof r.thread_id !== 'string') continue;
    const t = {
      threadId: r.thread_id,
      sessionId: typeof r.session_id === 'string' ? r.session_id : null,
      sessionKey: sessionKey(r.session_id),
      title: scrub(str(r.title)).trim(),
      bucket: str(r.status_bucket) || 'working',
      status: str(r.status),
      resolved: r.resolved === true,
      createdAt: r.created_at ?? null,
      lastActivityAt: r.last_activity_at ?? null,
    };
    const prev = byId.get(t.threadId);
    if (!prev || time(t.lastActivityAt) >= time(prev.lastActivityAt)) byId.set(t.threadId, t);
  }
  return [...byId.values()];
}

/**
 * list_project_prs -> [{n, title, state, url, sessionKey, headRef}].
 * @param {unknown} raw
 */
export function normalizeProjectPrs(raw) {
  return rowsOf(raw, 'pull_requests')
    .filter((p) => p && Number.isInteger(p.number))
    .map((p) => ({ n: p.number, title: scrub(str(p.title)).trim(), state: str(p.state), url: str(p.url), sessionKey: sessionKey(p.session_id), headRef: str(p.head_ref) }));
}

/**
 * list_project_artifacts -> [{id, url, title, updatedAt}].
 * @param {unknown} raw
 */
export function normalizeArtifacts(raw) {
  return rowsOf(raw, 'artifacts')
    .filter((a) => a && typeof a.artifact_id === 'string')
    .map((a) => ({ id: a.artifact_id, url: str(a.url), title: scrub(str(a.title)).trim(), updatedAt: a.updated_at ?? null }));
}

/**
 * The ws key of a thread: the curator's mapping in meta/cursors when there is one (stable when
 * the thread is renamed), else the slug of its title, else thread-<sha1(threadId)[0:8]>.
 * @param {Thread} thread
 * @param {any} cursors meta/cursors
 */
export function wsKeyForThread(thread, cursors) {
  const mapped = cursors?.threads?.[thread.threadId]?.ws;
  if (typeof mapped === 'string' && mapped) return mapped;
  return slugify(thread.title) || `thread-${sha('sha1', thread.threadId).slice(0, 8)}`;
}

/**
 * ws.facts for every workstream that has a thread. PRs attach through the session key; the
 * GitHub (engine) state and mergedAt win over the project list. PRs that dropped off the project
 * list (it returns the newest ones only) are kept from the previous facts. Artifacts come from
 * docs rows the curator classified to the ws. The routine thread's own activity time is ignored
 * (it changes every hour), but the thread stays listed.
 * @param {{threads: Thread[], projectPrs: any[], ghPrs?: Record<string, {state?: string, mergedAt?: string|null, title?: string}>, docs?: Record<string, any>, cursors?: any, prevWs?: Record<string, any>, routineThreadId?: string|null}} args
 * @returns {{facts: Record<string, any>, unmapped: Array<{threadId: string, key: string}>}}
 */
export function deriveWsFacts({ threads, projectPrs = [], ghPrs = {}, docs = {}, cursors = {}, prevWs = {}, routineThreadId = null }) {
  const groups = new Map();
  const unmapped = [];
  const keyBySession = new Map();
  for (const t of [...threads].sort((a, b) => a.threadId.localeCompare(b.threadId))) {
    const key = wsKeyForThread(t, cursors);
    if (!cursors?.threads?.[t.threadId]?.ws) unmapped.push({ threadId: t.threadId, key });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
    if (t.sessionKey) keyBySession.set(t.sessionKey, key);
  }
  const listed = new Set(projectPrs.map((p) => p.n));
  const prsByKey = new Map();
  for (const p of projectPrs) {
    const key = p.sessionKey ? keyBySession.get(p.sessionKey) : undefined;
    if (!key) continue;
    const gh = ghPrs[p.n] ?? {};
    const row = { n: p.n, state: gh.state || p.state, title: p.title || gh.title || '', mergedAt: gh.mergedAt ?? null };
    if (!prsByKey.has(key)) prsByKey.set(key, new Map());
    prsByKey.get(key).set(p.n, row);
  }
  const facts = {};
  for (const [key, ts] of groups) {
    const prs = prsByKey.get(key) ?? new Map();
    for (const old of prevWs[key]?.facts?.prs ?? []) if (Number.isInteger(old?.n) && !listed.has(old.n) && !prs.has(old.n)) prs.set(old.n, old);
    const active = ts.filter((t) => t.threadId !== routineThreadId);
    const newest = active.reduce((m, t) => (time(t.lastActivityAt) > time(m) ? t.lastActivityAt : m), null);
    const bucket = BUCKET_ORDER.find((b) => active.some((t) => t.bucket === b)) ?? (active[0]?.bucket ?? ts[0]?.bucket ?? null);
    facts[key] = {
      threadIds: ts.map((t) => t.threadId),
      bucket,
      resolved: ts.every((t) => t.resolved),
      lastActivityAt: newest,
      prs: [...prs.values()].sort((a, b) => a.n - b.n),
      artifacts: Object.entries(docs)
        .filter(([, d]) => d?.ws === key)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, d]) => ({ id, url: str(d.url), title: str(d.title) })),
    };
  }
  return { facts, unmapped };
}

/**
 * The deterministic stub for an unmapped thread's new workstream (curator fills the narrative).
 * @param {string} key
 * @param {Thread} thread
 * @param {any} facts
 * @param {string} now ISO
 */
export function stubWs(key, thread, facts, now) {
  return {
    key,
    name: thread.title.slice(0, 80) || key,
    status: 'working',
    summary: '',
    nextStep: '',
    waitingOn: 'none',
    facts,
    startedAt: thread.createdAt,
    needsCuration: true,
    createdAt: now,
    updatedAt: now,
    prevStatus: null,
    statusChangedAt: now,
    evidence: [],
  };
}

/**
 * Threads to read this run: activity later than the cursor (or no cursor), routine thread
 * excluded, newest first, at most `cap` threads and about `byteBudget` bytes (THREAD_EST_BYTES
 * each unless a thread carries estBytes). At least one thread is taken. The rest carry over.
 * @param {Thread[]} threads
 * @param {any} cursors meta/cursors
 * @param {string|null} routineThreadId
 * @param {number} [cap]
 * @param {number} [byteBudget]
 * @returns {{selected: Array<{threadId: string, title: string, ws: string, lastActivityAt: string|null, stopAt: string|null, estBytes: number}>, carried: string[]}}
 */
export function changedThreads(threads, cursors, routineThreadId, cap = CURATE_THREAD_CAP, byteBudget = CURATE_BYTE_BUDGET) {
  const changed = threads
    .filter((t) => t.threadId !== routineThreadId)
    .filter((t) => {
      const c = cursors?.threads?.[t.threadId];
      return !c?.lastAt || time(t.lastActivityAt) > time(c.lastAt);
    })
    .sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt) || a.threadId.localeCompare(b.threadId));
  const selected = [];
  const carried = [];
  let bytes = 0;
  for (const t of changed) {
    const est = Number.isFinite(t.estBytes) ? t.estBytes : THREAD_EST_BYTES;
    if (selected.length < cap && (selected.length === 0 || bytes + est <= byteBudget)) {
      selected.push({ threadId: t.threadId, title: t.title, ws: wsKeyForThread(t, cursors), lastActivityAt: t.lastActivityAt, stopAt: cursors?.threads?.[t.threadId]?.lastMsgId ?? null, estBytes: est });
      bytes += est;
    } else {
      carried.push(t.threadId);
    }
  }
  return { selected, carried };
}

/**
 * The curator plan of one run. It skips (no curator) only when the inputs digest equals the one
 * stored by the last run, no reconcile is due, AND no thread has activity past its cursor. The
 * digest covers activity times, not cursors, so after a run that carried threads over the digest
 * does not change; the carried threads still show as past their cursor and are read next run.
 * @param {{threads: Thread[], cursors: any, routineThreadId?: string|null, digest: string, prevDigest?: string|null, reconcile: boolean, cap?: number, byteBudget?: number}} args
 * @returns {{skip: boolean, selected: ReturnType<typeof changedThreads>['selected'], carried: string[]}}
 */
export function curatePlan({ threads, cursors, routineThreadId = null, digest, prevDigest = null, reconcile, cap = CURATE_THREAD_CAP, byteBudget = CURATE_BYTE_BUDGET }) {
  const { selected, carried } = changedThreads(threads, cursors, routineThreadId, cap, byteBudget);
  const skip = digest === prevDigest && !reconcile && selected.length === 0;
  return skip ? { skip, selected: [], carried: [] } : { skip, selected, carried };
}

/**
 * docs rows from the project Artifact list: a new row for an unknown artifact (kind other,
 * status current, ws null), a refresh of title, url and updatedAt for a known one (curator
 * fields kept), nothing for an unchanged one.
 * @param {Array<{id: string, url: string, title: string, updatedAt: string|null}>} artifacts
 * @param {Record<string, any>} existing docs collection (id -> data)
 * @param {string} now ISO
 * @returns {Array<{id: string, isNew: boolean, data: any}>}
 */
export function docsRows(artifacts, existing, now) {
  const out = [];
  for (const a of artifacts) {
    const prev = existing?.[a.id];
    if (!prev) {
      out.push({ id: a.id, isNew: true, data: { title: a.title, url: a.url, kind: 'other', status: 'current', ws: null, updatedAt: a.updatedAt, firstSeenAt: now } });
    } else if (prev.title !== a.title || prev.updatedAt !== a.updatedAt || prev.url !== a.url) {
      out.push({ id: a.id, isNew: false, data: { ...prev, title: a.title, url: a.url, updatedAt: a.updatedAt } });
    }
  }
  return out;
}

/**
 * sha256 over every curator input, stable under reordering. The routine thread is excluded
 * (it changes every hour, which would defeat the quiet-hour skip).
 * @param {{threads: Thread[], routineThreadId?: string|null, memorySha256?: string|null, projectPrs?: Array<{n: number, state: string}>, artifacts?: Array<{id: string, updatedAt: string|null}>, ackIds?: string[], inboxIds?: string[]}} args
 */
export function inputsDigest({ threads, routineThreadId = null, memorySha256 = null, projectPrs = [], artifacts = [], ackIds = [], inboxIds = [] }) {
  const canon = {
    threads: threads
      .filter((t) => t.threadId !== routineThreadId)
      .map((t) => [t.threadId, t.bucket, t.lastActivityAt ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    memory: memorySha256 ?? null,
    prs: projectPrs.map((p) => [p.n, p.state]).sort((a, b) => Number(a[0]) - Number(b[0])),
    artifacts: artifacts.map((a) => [a.id, a.updatedAt ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    acks: [...ackIds].sort(),
    inbox: [...inboxIds].sort(),
  };
  return sha('sha256', JSON.stringify(canon));
}
