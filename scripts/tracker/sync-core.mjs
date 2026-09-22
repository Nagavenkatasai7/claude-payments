// Program Ledger auto-sync: PURE functions (no I/O). The CLI (sync.mjs), the journal helper
// (journal.mjs) and the Claude Code hooks (.claude/hooks/ledger-*.mjs) do the I/O around them.
// Tests: tests/tracker-sync-core.test.ts.
//
// Design: append-only. Every automated write is a `set` of a NEW doc with a deterministic id;
// an id that already exists is skipped. The only overwrite is meta/state (pinned by version).
import { createHash } from 'node:crypto';

/**
 * @typedef {{number: number, title: string, url: string, state: 'open'|'merged'|'closed', createdAt: string, mergedAt: string|null, closedAt: string|null, mergeSha: string|null, author: string, head: string, fixes: number[]}} Pr
 * @typedef {{id: number, sha: string, sha7: string|null, branch: string, event: string, status: string, conclusion: string|null, url: string, createdAt: string, updatedAt: string}} Run
 * @typedef {{collection: string, id: string, data: any, key?: string}} Doc
 * @typedef {{bytes?: number}} Sized
 */

export const REPO = 'Nagavenkatasai7/claude-payments';
export const PROGRAM = 'SmartRemit upgrade program 2026-09';
export const FIRST_PROGRAM_PR = 237;
// PRs merged before the `Program-Fix:` convention existed (same map as snapshot.mjs).
export const LEGACY_FIX_MAP = Object.freeze({ 242: [1], 243: [3], 244: [2], 246: [3], 247: [2], 248: [2] });

const STATUS_ORDER = ['open', 'planned', 'in_progress', 'in_review', 'merged', 'done'];
/** Fix status rank: open < planned < in_progress < in_review < merged < done; unknown = -1. */
export const rank = (status) => STATUS_ORDER.indexOf(status);

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const EVENT_KINDS = new Set(['decision', 'approval', 'agent', 'plan', 'review', 'pr', 'merge', 'deploy', 'migration', 'owner-step', 'verify', 'milestone', 'incident', 'security']);
const ACTORS = new Set(['owner', 'claude', 'agent', 'github', 'ci']);
const RESULTS = new Set(['ok', 'blocked', 'failed', 'running', 'info']);
export const JOURNAL_KINDS = [...EVENT_KINDS];
export const JOURNAL_ACTORS = [...ACTORS];
export const JOURNAL_RESULTS = [...RESULTS];

const uniqSorted = (xs) => [...new Set(xs.filter((x) => Number.isInteger(x)))].sort((a, b) => a - b);
const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };
const sha7 = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7).toLowerCase() : null);
const pad2 = (n) => String(n).padStart(2, '0');
const fixField = (fixes) => (fixes.length === 1 ? fixes[0] : fixes.length ? fixes : null);
const isoNoMs = (iso) => new Date(iso).toISOString().replace('.000Z', 'Z');

// ---------- scrub (port of scrub() in build-corpus.py, plus more token shapes) ----------
const TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /EAA[A-Za-z0-9]{30,}/g,
  /xox[bp]-[A-Za-z0-9-]{20,}/g,
];
/**
 * Mask phone numbers (except +1555 test numbers), non-org emails and token-like strings.
 * @param {unknown} text
 * @returns {string}
 */
export function scrub(text) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  s = s.replace(/\+(?!1555)(\d{6,13})(\d{4})\b/g, (_, a, b) => `+${'•'.repeat(a.length)}${b}`);
  s = s.replace(
    /\b([A-Za-z0-9._%+-]+)@(?!smartremit\.ai\b|example\.com\b|testing\.com\b)([A-Za-z0-9.-]+\.[a-z]{2,})\b/g,
    (_, local, domain) => `${local.slice(0, 1)}…@${domain}`,
  );
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer <redacted-token>');
  for (const re of TOKEN_PATTERNS) s = s.replace(re, '<redacted-token>');
  return s;
}

// ---------- PR trailers and scope ----------
const TRAILER = /^[ \t]*Program-Fix:[ \t]*(.*)$/gim;
/**
 * Fix numbers from `Program-Fix: <n>[, <n>…]` lines (own line, any case). "none (tooling)" → [].
 * @param {string|null|undefined} body
 * @returns {number[]}
 */
export function parseProgramFix(body) {
  if (typeof body !== 'string' || !body) return [];
  const out = [];
  for (const m of body.matchAll(TRAILER)) {
    const lead = m[1].replace(/\r$/, '').match(/^(#?\d+(?:[\s,]+#?\d+)*)/);
    if (!lead) continue;
    for (const tok of lead[1].split(/[\s,]+/)) {
      const n = Number(tok.replace('#', ''));
      if (Number.isInteger(n) && n > 0 && n < 1000) out.push(n);
    }
  }
  return uniqSorted(out);
}

export function fixesForPr(number, body) {
  return uniqSorted([...(LEGACY_FIX_MAP[number] || []), ...parseProgramFix(body)]);
}

/**
 * GitHub REST pull → the fields the ledger uses. The merge sha is reported for merged PRs only.
 * @param {any} p
 * @returns {Pr}
 */
export function normalizePr(p) {
  const mergedAt = p.merged_at || null;
  const state = mergedAt ? 'merged' : p.state === 'open' ? 'open' : 'closed';
  return {
    number: p.number,
    title: scrub(p.title ?? ''),
    url: p.html_url,
    state,
    createdAt: p.created_at,
    mergedAt,
    closedAt: p.closed_at || null,
    mergeSha: state === 'merged' ? sha7(p.merge_commit_sha) : null,
    author: p.user?.login ?? '',
    head: p.head?.ref ?? '',
    fixes: fixesForPr(p.number, p.body),
  };
}

/** Dependabot (author or branch) and the old overnight loop/ branches are not program work. */
export const isExcludedPr = (pr) => /dependabot/i.test(pr.author) || /^(dependabot|loop)\//.test(pr.head);
export const isProgramPr = (pr) => pr.number >= FIRST_PROGRAM_PR && !isExcludedPr(pr);

/**
 * GitHub REST workflow run → the fields the ledger uses.
 * @param {any} r
 * @returns {Run}
 */
export function normalizeRun(r) {
  return {
    id: r.id,
    sha: String(r.head_sha ?? '').toLowerCase(),
    sha7: sha7(r.head_sha),
    branch: r.head_branch,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion ?? null,
    url: r.html_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const isMainPush = (r) => r.branch === 'main' && r.event === 'push';
const newestFirst = (runs) => [...runs].sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);

// ---------- deterministic ids ----------
export const eventIds = {
  prOpen: (n) => `gh-pr-open-${n}`,
  merge: (n) => `gh-merge-${n}`,
  prClosed: (n) => `gh-pr-closed-${n}`,
  ci: (runId) => `gh-ci-${runId}`,
  smoke: (runId) => `gh-smoke-${runId}`,
  journal: (line) => `j-${createHash('sha1').update(line).digest('hex').slice(0, 16)}`,
};
export const fixStateId = (fix, status, ref) => `fix-${pad2(fix)}-${status}-${ref}`;

// ---------- fix status ----------
/**
 * Current status per fix: the latest `fixstate` doc (by `at`; a tie goes to the higher rank),
 * falling back to `fixes/fix-NN.status`. prs = union of both.
 * @param {any[]} [fixstateDocs]
 * @param {any[]} [fixDocs]
 * @returns {Map<number, {status: string, at: string|null, prs: number[]}>}
 */
export function currentFixStatuses(fixstateDocs = [], fixDocs = []) {
  const cur = new Map();
  for (const f of fixDocs) {
    const n = Number(f?.fix);
    if (Number.isInteger(n)) cur.set(n, { status: f.status ?? 'open', at: null, prs: uniqSorted(f.prs || []) });
  }
  const latest = new Map();
  for (const s of fixstateDocs) {
    const n = Number(s?.fix);
    if (!Number.isInteger(n)) continue;
    const prev = latest.get(n);
    if (!prev || time(s.at) > time(prev.at) || (time(s.at) === time(prev.at) && rank(s.status) > rank(prev.status))) latest.set(n, s);
  }
  for (const [n, s] of latest) {
    cur.set(n, { status: s.status, at: s.at ?? null, prs: uniqSorted([...(cur.get(n)?.prs || []), ...(s.prs || [])]) });
  }
  return cur;
}

/**
 * fixstate docs from program PRs: OPEN PR → in_review (ref pr<n>); MERGED PR → merged (ref sha7).
 * Never `done` (that needs verification evidence and is written by hand). Never lower than the
 * fix's current status. At most one doc per fix per run: the highest status, then the newest.
 * @param {Pr[]} prs
 * @param {Map<number, {status: string, prs?: number[]}>} [current]
 * @returns {Doc[]}
 */
export function deriveFixStates(prs, current = new Map()) {
  const cands = new Map();
  for (const pr of prs) {
    let c = null;
    if (pr.state === 'open') c = { status: 'in_review', ref: `pr${pr.number}`, at: pr.createdAt, pr: pr.number, mergeSha: null };
    else if (pr.state === 'merged' && pr.mergeSha) c = { status: 'merged', ref: pr.mergeSha, at: pr.mergedAt, pr: pr.number, mergeSha: pr.mergeSha };
    if (!c) continue;
    for (const f of pr.fixes) {
      if (!cands.has(f)) cands.set(f, []);
      cands.get(f).push(c);
    }
  }
  const docs = [];
  for (const fix of [...cands.keys()].sort((a, b) => a - b)) {
    const list = cands.get(fix);
    const cur = current.get(fix) ?? { status: 'open', prs: [] };
    const eligible = list
      .filter((c) => rank(c.status) >= rank(cur.status))
      .sort((a, b) => rank(b.status) - rank(a.status) || time(b.at) - time(a.at) || b.pr - a.pr);
    if (!eligible.length) continue;
    const top = eligible[0];
    docs.push({
      collection: 'fixstate',
      id: fixStateId(fix, top.status, top.ref),
      data: { fix, status: top.status, at: top.at, prs: uniqSorted([...(cur.prs || []), ...list.map((c) => c.pr)]), mergeSha: top.mergeSha, source: 'github' },
    });
  }
  return docs;
}

// ---------- PR docs and events ----------
const stateAt = (pr) => (pr.state === 'merged' ? pr.mergedAt : pr.state === 'closed' ? pr.closedAt : pr.createdAt);

/**
 * prs/pr-<n> (created once) and prstate/pr-<n>-<state> (the page takes the latest per number).
 * @param {Pr[]} prs
 * @returns {Doc[]}
 */
export function prDocs(prs) {
  const docs = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const fix = fixField(pr.fixes);
    docs.push({ collection: 'prs', id: `pr-${pr.number}`, data: { number: pr.number, title: pr.title, url: pr.url, createdAt: pr.createdAt, fix } });
    docs.push({ collection: 'prstate', id: `pr-${pr.number}-${pr.state}`, data: { number: pr.number, state: pr.state, at: stateAt(pr), mergeSha: pr.mergeSha, fix } });
  }
  return docs;
}

/**
 * gh-pr-open-<n>, gh-merge-<n>, gh-pr-closed-<n>. `key` (not stored) matches hand-written equivalents.
 * @param {Pr[]} prs
 * @returns {Doc[]}
 */
export function prEvents(prs) {
  const out = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const refs = { pr: [pr.number], fix: pr.fixes };
    const fixNote = pr.fixes.length ? ` (fix ${pr.fixes.join(', ')})` : '';
    out.push({
      collection: 'events', id: eventIds.prOpen(pr.number), key: `pr-open:${pr.number}`,
      data: { at: pr.createdAt, kind: 'pr', actor: 'github', title: `PR #${pr.number} opened`, detail: `${pr.title}${fixNote}`, refs, result: 'info', source: 'github' },
    });
    if (pr.state === 'merged') {
      out.push({
        collection: 'events', id: eventIds.merge(pr.number), key: `merge:${pr.number}`,
        data: { at: pr.mergedAt, kind: 'merge', actor: 'github', title: `PR #${pr.number} merged`, detail: `${pr.title}${fixNote}; ${pr.mergeSha}.`, refs: { ...refs, sha: pr.mergeSha }, result: 'ok', source: 'github' },
      });
    } else if (pr.state === 'closed') {
      out.push({
        collection: 'events', id: eventIds.prClosed(pr.number), key: `pr-closed:${pr.number}`,
        data: { at: pr.closedAt, kind: 'pr', actor: 'github', title: `PR #${pr.number} closed without merging`, detail: pr.title, refs, result: 'info', source: 'github' },
      });
    }
  }
  return out;
}

/**
 * gh-ci-<runId> for FAILED push CI runs on main; gh-smoke-<runId> for completed push Smoke runs on main.
 * @param {Run[]} ciRuns
 * @param {Run[]} smokeRuns
 * @returns {Doc[]}
 */
export function runEvents(ciRuns, smokeRuns) {
  const out = [];
  for (const r of ciRuns) {
    if (!isMainPush(r) || r.status !== 'completed' || !FAILED.has(r.conclusion)) continue;
    out.push({
      collection: 'events', id: eventIds.ci(r.id), key: `ci:${r.sha7}:failed`,
      data: { at: r.updatedAt || r.createdAt, kind: 'incident', actor: 'ci', title: `CI failed on main at ${r.sha7}`, detail: `CI ${r.conclusion}: ${r.url}`, refs: { sha: r.sha7 }, result: 'failed', source: 'ci' },
    });
  }
  for (const r of smokeRuns) {
    if (!isMainPush(r) || r.status !== 'completed') continue;
    if (r.conclusion === 'success') {
      out.push({
        collection: 'events', id: eventIds.smoke(r.id), key: `smoke:${r.sha7}:ok`,
        data: { at: r.updatedAt || r.createdAt, kind: 'verify', actor: 'ci', title: `Post-deploy smoke green on ${r.sha7}`, detail: `The push-triggered Smoke run waited until /api/version reported ${r.sha7}, then passed: production serves ${r.sha7}. ${r.url}`, refs: { sha: r.sha7 }, result: 'ok', source: 'ci' },
      });
    } else if (FAILED.has(r.conclusion)) {
      out.push({
        collection: 'events', id: eventIds.smoke(r.id), key: `smoke:${r.sha7}:failed`,
        data: { at: r.updatedAt || r.createdAt, kind: 'incident', actor: 'ci', title: `Post-deploy smoke failed on ${r.sha7}`, detail: `Smoke ${r.conclusion}: ${r.url}`, refs: { sha: r.sha7 }, result: 'failed', source: 'ci' },
      });
    }
  }
  return out;
}

/**
 * Keys of events recorded before this engine (hand-written or by snapshot.mjs), so the first run
 * does not duplicate them in the timeline. Engine ids (gh-*, j-*) are matched by id instead.
 * @param {Array<{id: string, data: any}>} [existing]
 * @returns {Set<string>}
 */
export function legacyEventKeys(existing = []) {
  const keys = new Set();
  for (const e of existing) {
    if (/^(gh-|j-)/.test(String(e?.id ?? ''))) continue;
    const t = String(e?.data?.title ?? '');
    let m;
    if ((m = t.match(/^PR #(\d+) merged\b/i))) keys.add(`merge:${m[1]}`);
    else if ((m = t.match(/^PR #(\d+) opened\b/i))) keys.add(`pr-open:${m[1]}`);
    else if ((m = t.match(/^PR #(\d+) closed\b/i))) keys.add(`pr-closed:${m[1]}`);
    else if ((m = t.match(/^Post-deploy smoke (green|passed|success|failed|failure|red)\b.*?\bon ([0-9a-f]{7})/i))) {
      keys.add(`smoke:${m[2].toLowerCase()}:${/^(green|passed|success)$/i.test(m[1]) ? 'ok' : 'failed'}`);
    } else if ((m = t.match(/^CI (?:failed|failure|red)\b.*?\b([0-9a-f]{7})\b/i))) keys.add(`ci:${m[1].toLowerCase()}:failed`);
  }
  return keys;
}

/**
 * New docs only: skip ids in the dump, duplicates within the run, and legacy-equivalent events. meta/state always passes.
 * @param {Doc[]} docs
 * @param {Set<string>} existingIds "collection/id"
 * @param {Set<string>} [legacyKeys]
 * @returns {Doc[]}
 */
export function diffAgainstExisting(docs, existingIds, legacyKeys = new Set()) {
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const k = `${d.collection}/${d.id}`;
    if (seen.has(k)) continue;
    const always = k === 'meta/state';
    if (!always && (existingIds.has(k) || (d.key && legacyKeys.has(d.key)))) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

// ---------- journal ----------
/**
 * Complete lines of the journal after byte offset `from`, and the byte offset just past the last
 * complete line (a partial trailing line is left for next time). A bad offset re-reads from 0:
 * journal ids are content hashes, so re-reading is idempotent.
 * @param {Buffer} buf
 * @param {number} [from]
 * @returns {{lines: string[], newOffset: number, warnings: string[]}}
 */
export function sliceJournal(buf, from = 0) {
  const warnings = [];
  let start = Number.isInteger(from) && from >= 0 ? from : 0;
  if (start > buf.length) {
    warnings.push(`journal offset ${start} is past the end (${buf.length} bytes); re-reading from 0`);
    start = 0;
  } else if (start > 0 && buf[start - 1] !== 0x0a) {
    warnings.push(`journal offset ${start} is not at a line boundary; re-reading from 0`);
    start = 0;
  }
  const rest = buf.subarray(start);
  const lastNl = rest.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], newOffset: start, warnings };
  const lines = rest.subarray(0, lastNl + 1).toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  return { lines, newOffset: start + lastNl + 1, warnings };
}

function cleanRefs(refs) {
  if (!refs || typeof refs !== 'object') return null;
  const out = {};
  const ints = (v) => uniqSorted([].concat(v ?? []).map(Number));
  if (refs.fix !== undefined) out.fix = ints(refs.fix);
  if (refs.pr !== undefined) out.pr = ints(refs.pr);
  if (typeof refs.plan === 'string' && /^[a-z0-9-]{1,20}$/i.test(refs.plan)) out.plan = refs.plan;
  if (typeof refs.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(refs.sha)) out.sha = refs.sha.slice(0, 7).toLowerCase();
  return Object.keys(out).length ? out : null;
}

/**
 * One `events/j-<sha1(line)[0:16]>` per journal line; unknown fields dropped, text scrubbed.
 * @param {string[]} lines
 * @returns {{events: Doc[], warnings: string[]}}
 */
export function journalToEvents(lines) {
  const events = [];
  const warnings = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { warnings.push(`journal line skipped (not JSON): ${eventIds.journal(line)}`); continue; }
    if (!o || typeof o !== 'object' || !o.title || !o.at || Number.isNaN(Date.parse(o.at))) {
      warnings.push(`journal line skipped (needs at and title): ${eventIds.journal(line)}`);
      continue;
    }
    const kind = typeof o.kind === 'string' && /^[a-z][a-z-]{0,19}$/.test(o.kind) ? o.kind : 'decision';
    const refs = cleanRefs(o.refs);
    const data = {
      at: isoNoMs(o.at),
      kind,
      actor: ACTORS.has(o.actor) ? o.actor : 'claude',
      ...(o.model ? { model: scrub(o.model).slice(0, 60) } : {}),
      title: scrub(o.title).slice(0, 200),
      detail: scrub(o.detail ?? '').slice(0, 2000),
      ...(refs ? { refs } : {}),
      ...(RESULTS.has(o.result) ? { result: o.result } : {}),
      source: 'journal',
    };
    events.push({ collection: 'events', id: eventIds.journal(line), data });
  }
  return { events, warnings };
}

// ---------- batches ----------
/**
 * Split writes (each with `bytes`) into ArtifactData batches: at most maxWrites entries and maxBytes each.
 * @template {Sized} T
 * @param {T[]} items
 * @param {{maxWrites?: number, maxBytes?: number}} [opts]
 * @returns {T[][]}
 */
export function splitBatches(items, { maxWrites = 50, maxBytes = 900_000 } = {}) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const it of items) {
    const b = it.bytes ?? 0;
    if (cur.length && (cur.length >= maxWrites || size + b > maxBytes)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += b;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * ArtifactData batches from sized writes ({write, bytes}). meta/state goes ALONE in the last
 * batch: on a version_mismatch the skill re-gets its version, re-runs the engine and resends only
 * that batch (the earlier batches created new docs; resending them would hit existing ids).
 * @param {Array<{write: {collection: string, doc_id: string} & Record<string, any>, bytes: number}>} sized
 * @param {{maxWrites?: number, maxBytes?: number}} [opts]
 * @returns {Array<Array<Record<string, any>>>}
 */
export function batchWrites(sized, opts = { maxWrites: 50, maxBytes: 900_000 }) {
  const isState = (x) => x.write.collection === 'meta' && x.write.doc_id === 'state';
  const batches = splitBatches(sized.filter((x) => !isState(x)), opts).map((b) => b.map((x) => x.write));
  const state = sized.filter(isState).map((x) => x.write);
  return state.length ? [...batches, state] : batches;
}

// ---------- meta/state ----------
/**
 * meta/state. prodServes: mainSha when the latest push Smoke for it succeeded (the smoke waits
 * until /api/version reports the commit, so success proves production serves it), else the newest
 * sha with a successful push Smoke.
 * Keeps every other key already in the doc.
 * @param {{prev?: any, mainSha: string, ciRuns?: Run[], smokeRuns?: Run[], openPrs: number, now: string, by: string}} args
 * @returns {Record<string, any>}
 */
export function buildState({ prev, mainSha, ciRuns = [], smokeRuns = [], openPrs, now, by }) {
  const forMain = (runs) => newestFirst(runs).find((r) => r.sha.startsWith(mainSha));
  const ciLatest = forMain(ciRuns.filter(isMainPush));
  const pushSmoke = newestFirst(smokeRuns.filter(isMainPush));
  const smokeLatest = forMain(pushSmoke);
  const runState = (r) => (r ? r.conclusion || r.status : 'pending');
  const smokeMain = runState(smokeLatest);
  const lastGood = pushSmoke.find((r) => r.conclusion === 'success');

  let smokeNote;
  if (smokeLatest) smokeNote = smokeLatest.url;
  else if (pushSmoke[0]) smokeNote = `No push smoke run for ${mainSha} yet; the latest was ${runState(pushSmoke[0])} on ${pushSmoke[0].sha7} (${pushSmoke[0].url}).`;
  else smokeNote = `No push smoke run for ${mainSha} yet.`;

  let prodServes;
  let prodServesNote;
  let prodDeploy;
  if (smokeLatest?.conclusion === 'success') {
    prodServes = mainSha;
    prodServesNote = `The push Smoke for ${mainSha} passed after /api/version reported the commit: production serves it (${smokeLatest.url}).`;
    prodDeploy = `${mainSha}: production serves this commit (smoke verified)`;
  } else {
    prodServes = lastGood ? lastGood.sha7 : null;
    const st = smokeLatest ? smokeMain : 'not started';
    prodServesNote = lastGood
      ? `Smoke for ${mainSha} is ${st}; the newest commit with a successful push Smoke is ${lastGood.sha7} (${lastGood.url}).`
      : `Smoke for ${mainSha} is ${st}; no successful push Smoke on record.`;
    if (lastGood && lastGood.sha7 === mainSha) prodDeploy = `${mainSha}: production serves this commit (an earlier smoke saw it on /api/version), but the latest smoke run is ${st}`;
    else if (FAILED.has(st)) prodDeploy = `${mainSha}: smoke ${st}, not verified in production${lastGood ? `; production last verified on ${lastGood.sha7}` : ''}`;
    else prodDeploy = `${mainSha}: not verified in production yet (smoke ${st})${lastGood ? `; production last verified on ${lastGood.sha7}` : ''}`;
  }

  return {
    ...(prev && typeof prev === 'object' ? prev : {}),
    mainSha,
    ciMain: runState(ciLatest),
    smokeMain,
    smokeNote,
    prodServes,
    prodServesNote,
    prodDeploy,
    openPrs,
    syncedAt: now,
    syncedBy: by === 'cloud' ? 'cloud routine' : by === 'session' ? 'session' : String(by),
    program: PROGRAM,
    currentPhase: Number.isInteger(prev?.currentPhase) ? prev.currentPhase : 1,
  };
}

// ---------- whole plan (pure) ----------
/**
 * Everything one sync writes, from already-fetched GitHub data and the ledger dump.
 * gh: {mainSha (sha7), prs, openPrs (REST pulls), ciRuns, smokeRuns (REST runs)}
 * dump: {ids: Set<"collection/id">, fixstate: data[], fixes: data[], events: {id,data}[], prevState}
 * Returns docs (new ones, then meta/state last), the state and warnings.
 * @param {{gh: {mainSha: string, prs: any[], openPrs: any[], ciRuns: any[], smokeRuns: any[]}, dump: {ids: Set<string>, fixstate: any[], fixes: any[], events: Array<{id: string, data: any}>, prevState: any}, journalLines?: string[], now: string, by: string}} args
 * @returns {{docs: Doc[], state: Record<string, any>, warnings: string[]}}
 */
export function planSync({ gh, dump, journalLines = [], now, by }) {
  const prs = gh.prs.map(normalizePr).filter(isProgramPr);
  const openPrs = gh.openPrs.map(normalizePr).filter((p) => p.state === 'open' && !isExcludedPr(p)).length;
  const ci = gh.ciRuns.map(normalizeRun);
  const smoke = gh.smokeRuns.map(normalizeRun);
  const journal = journalToEvents(journalLines);
  const docs = [
    ...prDocs(prs),
    ...deriveFixStates(prs, currentFixStatuses(dump.fixstate, dump.fixes)),
    ...prEvents(prs),
    ...runEvents(ci, smoke),
    ...journal.events,
  ];
  const state = buildState({ prev: dump.prevState, mainSha: gh.mainSha, ciRuns: ci, smokeRuns: smoke, openPrs, now, by });
  const fresh = diffAgainstExisting(docs, dump.ids, legacyEventKeys(dump.events));
  return { docs: [...fresh, { collection: 'meta', id: 'state', data: state }], state, warnings: journal.warnings };
}

// ---------- hooks ----------
function parseGhPrCommands(cmd) {
  const out = [];
  for (const m of cmd.matchAll(/\bgh\s+pr\s+(merge|close)\b([^;&|\n]*)/g)) {
    const url = m[2].match(/\/pull\/(\d+)/);
    const num = url ? url[1] : m[2].match(/(?:^|\s)#?(\d+)(?=\s|$)/)?.[1];
    out.push({ verb: m[1], pr: num ? Number(num) : null });
  }
  return out;
}

/**
 * Journal entries for one hook input. Main thread only (no agent_id) for PostToolUse; the
 * Agent prompt is never logged (it may hold sensitive context).
 * @param {any} input
 * @param {string} now
 * @returns {Array<{at: string, kind: string, actor: string, title: string, detail: string, model?: string, refs?: object, result?: string}>}
 */
export function hookToJournalEntries(input, now) {
  if (!input || typeof input !== 'object') return [];
  if (input.hook_event_name === 'SubagentStop') {
    const detail = scrub(input.last_assistant_message ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return [{ at: now, kind: 'agent', actor: 'agent', title: `Agent finished (${scrub(input.agent_type || 'agent').slice(0, 60)})`, detail, result: 'ok' }];
  }
  if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return [];
  const ti = input.tool_input || {};
  const tr = input.tool_response || {};
  if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    const finished = tr.status === 'completed';
    const model = tr.resolvedModel || ti.model || ti.subagent_type || '';
    const desc = scrub(ti.description || 'agent').slice(0, 120);
    const secs = finished && tr.totalDurationMs ? `, ${Math.round(tr.totalDurationMs / 1000)} s` : '';
    return [{
      at: now, kind: 'agent', actor: 'claude', ...(model ? { model: scrub(model).slice(0, 60) } : {}),
      title: `${finished ? 'Agent finished' : 'Agent started'}: ${desc}`,
      detail: `${scrub(ti.subagent_type || 'general-purpose').slice(0, 60)} agent${finished ? '' : ' launched'}${secs}`,
      result: finished ? 'ok' : 'running',
    }];
  }
  if (input.tool_name === 'Bash') {
    const code = Number.isInteger(tr.exit_code) ? tr.exit_code : Number.isInteger(tr.exitCode) ? tr.exitCode : null;
    return parseGhPrCommands(String(ti.command ?? '')).map(({ verb, pr }) => ({
      at: now, kind: 'pr', actor: 'claude',
      title: `gh pr ${verb}${pr ? ` #${pr}` : ''} run in a session`,
      detail: `Exit ${code ?? 'unknown'}. GitHub records the ${verb} itself; this row records who ran it and when.`,
      ...(pr ? { refs: { pr: [pr] } } : {}),
      result: code === 0 ? 'ok' : code === null ? (tr.interrupted ? 'failed' : 'info') : 'failed',
    }));
  }
  return [];
}

export const SYNC_DUE_JOURNAL = 'Ledger sync due: new journal entries. Run the tracker-sync skill (automated engine) now, then finish.';

/**
 * The ledger-sync-due Stop hook's decision. Blocks (once; stop_hook_active short-circuits) when
 * the journal has unflushed bytes, or main moved since the last recorded sync. Never blocks in
 * the cloud routine, when ls-remote failed (remoteMainSha null) or when no sync was recorded yet.
 * @param {{stopHookActive?: boolean, remote?: boolean, disabled?: boolean, journalSize: number, flushedOffset: number, remoteMainSha?: string|null, lastSyncMainSha?: string|null}} args
 * @returns {{decision: 'block', reason: string} | null}
 */
export function stopDecision({ stopHookActive, remote, disabled, journalSize, flushedOffset, remoteMainSha, lastSyncMainSha }) {
  if (stopHookActive || remote || disabled) return null;
  if (journalSize > flushedOffset) return { decision: 'block', reason: SYNC_DUE_JOURNAL };
  const last = typeof lastSyncMainSha === 'string' ? lastSyncMainSha.toLowerCase() : '';
  const head = typeof remoteMainSha === 'string' ? remoteMainSha.toLowerCase() : '';
  if (last.length >= 7 && /^[0-9a-f]{40}$/.test(head) && !head.startsWith(last)) {
    return { decision: 'block', reason: `Ledger sync due: main moved to ${head.slice(0, 7)} since the last sync (${last.slice(0, 7)}). Run the tracker-sync skill (automated engine) now, then finish.` };
  }
  return null;
}
