// Program Ledger auto-sync: PURE functions (no I/O). The CLI (sync.mjs), the journal helper
// (journal.mjs) and the Claude Code hooks (.claude/hooks/ledger-*.mjs) do the I/O around them.
// Tests: tests/tracker-sync-core.test.ts.
//
// Design: append-only. Every automated write is a `set` of a NEW doc with a deterministic id;
// an id that already exists is skipped. The only overwrite is meta/state (pinned by version).
// Ledger v2: timeline rows go to `feed-YYYY-MM` (the month of their `at`), not `events`; the
// engine also writes `releases` and the prstate title. Only rows inside emitWindow are planned,
// so a month that was not dumped is never re-sent.
import { createHash } from 'node:crypto';

/**
 * @typedef {{number: number, title: string, url: string, state: 'open'|'merged'|'closed', createdAt: string, mergedAt: string|null, closedAt: string|null, mergeSha: string|null, author: string, head: string, fixes: number[]}} Pr
 * @typedef {{id: number, sha: string, sha7: string|null, branch: string, event: string, status: string, conclusion: string|null, url: string, createdAt: string, updatedAt: string}} Run
 * @typedef {{collection: string, id: string, data: any, key?: string}} Doc
 * @typedef {{bytes?: number}} Sized
 */

export const REPO = 'Nagavenkatasai7/claude-payments';
export const FIRST_PROGRAM_PR = 237;
// PRs merged before the `Program-Fix:` convention existed.
export const LEGACY_FIX_MAP = Object.freeze({ 242: [1], 243: [3], 244: [2], 246: [3], 247: [2], 248: [2] });

const STATUS_ORDER = ['open', 'planned', 'in_progress', 'in_review', 'merged', 'done'];
/** Fix status rank: open < planned < in_progress < in_review < merged < done; unknown = -1. */
export const rank = (status) => STATUS_ORDER.indexOf(status);

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
// 'change' rows (chg-*) are written by code only (curate.mjs), so the journal CLI does not offer it.
const JOURNAL_KIND_LIST = ['decision', 'approval', 'agent', 'plan', 'review', 'pr', 'merge', 'deploy', 'migration', 'owner-step', 'verify', 'milestone', 'incident', 'security'];
const EVENT_KINDS = new Set([...JOURNAL_KIND_LIST, 'change']);
const ACTORS = new Set(['owner', 'claude', 'agent', 'github', 'ci']);
const RESULTS = new Set(['ok', 'blocked', 'failed', 'running', 'info']);
const FEED_SOURCES = new Set(['github', 'ci', 'curator', 'code', 'note', 'journal']);
export const FEED_TITLE_MAX = 140;
export const FEED_DETAIL_MAX = 280;
export const JOURNAL_KINDS = [...JOURNAL_KIND_LIST];
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
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic keys (sk-ant-api03-…): the hyphens defeat the generic sk- rule
  /sk-[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs (base64url header.payload.signature)
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /EAA[A-Za-z0-9]{30,}/g,
  /xox[bp]-[A-Za-z0-9-]{20,}/g,
];
// Bare runs of 10+ digits (phone and card numbers without "+"): keep the last 4. Not after a word
// char, "/", "=" or "+" (ids in URLs such as /actions/runs/35671070038, query values, and
// +numbers, which the rule above handles); 1555… test numbers are kept. A run after "#" or "."
// is masked too ("ref #98765432101").
const BARE_DIGITS = /(?<![\w/=+])(?!1555)(\d{6,})(\d{4})(?!\w)/g;
// Formatted numbers: digit groups joined by a space, "-", "." or parentheses, with an optional
// leading "+" ("+91 98765 43210", "+1 (703) 555-0123", "703-555-0123", "4111 1111 1111 1111").
// maskGrouped decides which candidates are phone or card numbers.
const GROUPED = /(?<![\w/=+.-])(\+?)(\(?\d[\d(). \t-]*\d)(?![\w])/g;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
/**
 * One GROUPED candidate -> masked (every digit but the last 4 becomes "•"), or unchanged when it
 * is not a phone or card number: fewer than 10 digits (8 with "+") or more than 19, a separator
 * run longer than 2 characters, a last group under 4 digits (dates with times, PR lists, short
 * numbers), an ISO date, or a 1555… test number.
 */
function maskGrouped(match, plus, body) {
  const digits = body.replace(/\D/g, '');
  if (!/\D/.test(body)) return match; // unbroken runs: the "+" and bare rules own them
  if (digits.length < (plus ? 8 : 10) || digits.length > 19) return match;
  if (/\D{3,}/.test(body) || ISO_DATE.test(body) || digits.startsWith('1555')) return match;
  const groups = body.split(/\D+/).filter(Boolean);
  if (groups[groups.length - 1].length < 4) return match;
  let keep = 4;
  const masked = [...body].reverse().map((ch) => (/\d/.test(ch) ? (keep-- > 0 ? ch : '•') : ch)).reverse().join('');
  return `${plus}${masked}`;
}
/**
 * Mask phone numbers (except +1555 test numbers), bare 10+ digit numbers, phone and card numbers
 * written in groups (spaces, hyphens, dots, parentheses), non-org emails and token-like strings
 * (API keys, AWS key ids, JWTs, bearer tokens).
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
  // Last, so a digit run inside a token is already gone with the token.
  s = s.replace(BARE_DIGITS, (_, a, b) => `${'•'.repeat(a.length)}${b}`);
  s = s.replace(GROUPED, maskGrouped);
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
const runState = (r) => (r ? r.conclusion || r.status : 'pending');

// ---------- open-PR split and the project cross-check ----------
const isDependabot = (pr) => /dependabot/i.test(pr.author ?? '') || /^dependabot\//.test(pr.head ?? '');
const OPEN_PROJECT_STATES = new Set(['open', 'draft', 'queued']);

/**
 * Open PRs in three counts: program (number >= 237, not dependabot, not a loop/ branch), bot
 * (dependabot author or branch) and older (everything else: pre-program numbers such as #207 and
 * #222, and loop/ branches). PRs that are not open are ignored.
 * @param {Pr[]} prs normalized PRs
 * @returns {{program: number, bot: number, older: number}}
 */
export function splitOpenPrs(prs) {
  const out = { program: 0, bot: 0, older: 0 };
  for (const pr of prs) {
    if (pr.state !== 'open') continue;
    if (isDependabot(pr)) out.bot++;
    else if (isProgramPr(pr)) out.program++;
    else out.older++;
  }
  return out;
}

/**
 * Distinct open program PRs that project threads opened (hearthbot list_project_prs: open, draft
 * or queued; number >= 237; not a loop/ branch). A cross-check for meta/state.openProgramPrs.
 * @param {any} snapshot `{pull_requests: [...]}` or the array itself
 * @returns {number|null} null when the input is not a snapshot
 */
export function countOpenProjectPrs(snapshot) {
  const list = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.pull_requests) ? snapshot.pull_requests : null;
  if (!list) return null;
  const open = new Set();
  for (const p of list) {
    const n = Number(p?.number);
    if (!Number.isInteger(n) || !OPEN_PROJECT_STATES.has(p?.state)) continue;
    if (!isProgramPr({ number: n, author: '', head: String(p?.head_ref ?? '') })) continue;
    open.add(n);
  }
  return open.size;
}

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
 * prs/pr-<n> (created once) and prstate/pr-<n>-<state> (the page takes the latest per number;
 * each prstate doc keeps the title the PR had when it reached that state).
 * @param {Pr[]} prs
 * @returns {Doc[]}
 */
export function prDocs(prs) {
  const docs = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const fix = fixField(pr.fixes);
    docs.push({ collection: 'prs', id: `pr-${pr.number}`, data: { number: pr.number, title: pr.title, url: pr.url, createdAt: pr.createdAt, fix } });
    docs.push({ collection: 'prstate', id: `pr-${pr.number}-${pr.state}`, data: { number: pr.number, state: pr.state, at: stateAt(pr), mergeSha: pr.mergeSha, fix, title: pr.title } });
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

// ---------- releases ----------
const SMOKE_RESULT = (c) => (c === 'success' ? 'success' : FAILED.has(c) ? 'failure' : c === 'cancelled' ? 'cancelled' : null);

/**
 * releases/rel-<sha7>-<smokeRunId>: one per completed push Smoke on main (success, failure or
 * cancelled; other conclusions are skipped). prs = the PRs whose merge commit is that sha, with
 * the title they have when the doc is written (append-only, so it keeps the merge-time title).
 * ciMain = the latest push CI run for that sha (conclusion or status; 'pending' when none).
 * @param {Pr[]} prs normalized PRs (all of them, dependabot included: they ship too)
 * @param {Run[]} smokeRuns
 * @param {Run[]} [ciRuns]
 * @returns {Doc[]}
 */
export function releaseDocs(prs, smokeRuns, ciRuns = []) {
  const ci = newestFirst(ciRuns.filter(isMainPush));
  const out = [];
  for (const r of newestFirst(smokeRuns).reverse()) {
    if (!isMainPush(r) || r.status !== 'completed' || !r.sha7) continue;
    const smoke = SMOKE_RESULT(r.conclusion);
    if (!smoke) continue;
    const shipped = prs
      .filter((p) => p.state === 'merged' && p.mergeSha === r.sha7)
      .sort((a, b) => a.number - b.number)
      .map((p) => ({ n: p.number, title: p.title }));
    out.push({
      collection: 'releases',
      id: `rel-${r.sha7}-${r.id}`,
      data: { sha7: r.sha7, at: r.updatedAt || r.createdAt, prs: shipped, ciMain: runState(ci.find((c) => c.sha === r.sha)), smoke, smokeUrl: r.url },
    });
  }
  return out;
}

// ---------- feed (v2 timeline) ----------
const monthOf = (t) => { const d = new Date(t); return `feed-${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; };
const prevMonthStart = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); };

/**
 * The feed collection for a row: 'feed-YYYY-MM' from the UTC month of `at`; null when `at` is not a date.
 * @param {unknown} at
 * @returns {string|null}
 */
export function feedCollection(at) {
  const t = Date.parse(typeof at === 'string' ? at : '');
  return Number.isNaN(t) ? null : monthOf(t);
}

/**
 * The feed collections the engine dumps and may write: [this month, previous month] (UTC).
 * @param {string} now
 * @returns {string[]}
 */
export function feedMonths(now) {
  const t = Date.parse(now);
  return [monthOf(t), monthOf(prevMonthStart(t))];
}

/**
 * True when the engine may emit a feed row at `at`: on or after the first day of the previous
 * UTC month (the oldest dumped month) and on or after cutoverAt (older rows live in the frozen
 * events collection, which is not dumped any more). While cutoverAt is not a date (no meta/sync:
 * the v2 seed has not run), nothing is emitted: rows written then would duplicate the frozen
 * events and collide with the ids the seed backfills.
 * @param {unknown} at
 * @param {string} now
 * @param {string|null|undefined} cutoverAt
 * @returns {boolean}
 */
export function emitWindow(at, now, cutoverAt) {
  const t = Date.parse(typeof at === 'string' ? at : '');
  if (Number.isNaN(t) || t < prevMonthStart(Date.parse(now))) return false;
  const cut = Date.parse(typeof cutoverAt === 'string' ? cutoverAt : '');
  return !Number.isNaN(cut) && t >= cut;
}

const clampFeed = (data) => ({
  ...data,
  title: String(data.title ?? '').slice(0, FEED_TITLE_MAX),
  ...(data.detail !== undefined ? { detail: String(data.detail).slice(0, FEED_DETAIL_MAX) } : {}),
});
const toFeedDoc = (d) => ({ ...d, collection: feedCollection(d.data?.at), data: clampFeed(d.data) });

/**
 * Event docs → feed docs: each goes to the feed month of its `at`, with title and detail clamped
 * to the feed caps. Rows outside emitWindow, and rows validateEvent rejects, are dropped
 * (the latter with a warning). Without a cutoverAt no row is emitted (one warning).
 * `key` is kept for legacy matching.
 * @param {Doc[]} events
 * @param {{now: string, cutoverAt?: string|null}} opts
 * @returns {{docs: Doc[], warnings: string[]}}
 */
export function feedDocs(events, { now, cutoverAt = null }) {
  const docs = [];
  const warnings = [];
  if (Number.isNaN(Date.parse(typeof cutoverAt === 'string' ? cutoverAt : ''))) {
    if (events.length) warnings.push(`meta/sync.cutoverAt is not set (v2 seed not run?): ${events.length} feed row(s) not written`);
    return { docs, warnings };
  }
  for (const e of events) {
    if (!emitWindow(e.data?.at, now, cutoverAt)) continue;
    const d = toFeedDoc(e);
    const v = validateEvent(d.data);
    if (!v.ok) { warnings.push(`feed row ${e.id} skipped: ${v.errors.join('; ')}`); continue; }
    docs.push(d);
  }
  return { docs, warnings };
}

/**
 * Checks one feed row (the journalToEvents rules, made strict for v2): `at` is a date; kind is a
 * known kind ('change' included); actor is known; title is non-empty and at most 140 chars;
 * detail at most 280; result and source, when present, are known; refs, when present, is an
 * object; title and detail are already scrubbed (scrub() would not change them).
 * @param {any} e
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEvent(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, errors: ['not an object'] };
  const errors = [];
  if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) errors.push('at is not a date');
  if (!EVENT_KINDS.has(e.kind)) errors.push(`unknown kind ${JSON.stringify(e.kind)}`);
  if (!ACTORS.has(e.actor)) errors.push(`unknown actor ${JSON.stringify(e.actor)}`);
  if (typeof e.title !== 'string' || !e.title.trim()) errors.push('title is empty');
  else if (e.title.length > FEED_TITLE_MAX) errors.push(`title is over ${FEED_TITLE_MAX} chars`);
  if (e.detail !== undefined && typeof e.detail !== 'string') errors.push('detail is not a string');
  else if (typeof e.detail === 'string' && e.detail.length > FEED_DETAIL_MAX) errors.push(`detail is over ${FEED_DETAIL_MAX} chars`);
  if (e.result !== undefined && !RESULTS.has(e.result)) errors.push(`unknown result ${JSON.stringify(e.result)}`);
  if (e.source !== undefined && !FEED_SOURCES.has(e.source)) errors.push(`unknown source ${JSON.stringify(e.source)}`);
  if (e.refs !== undefined && (e.refs === null || typeof e.refs !== 'object' || Array.isArray(e.refs))) errors.push('refs is not an object');
  for (const f of ['title', 'detail']) {
    if (typeof e[f] === 'string' && scrub(e[f]) !== e[f]) errors.push(`${f} is not scrubbed (phone, email, token or long number)`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------- lease ----------
/** The soft lease in meta/sync: a run whose runningSince is younger than this is still running. */
export const LEASE_MS = 20 * 60 * 1000;

/**
 * Whether meta/sync.runningSince holds the lease at `now`: held when it is a date less than
 * LEASE_MS old. A value more than LEASE_MS in the future (clock trouble) does not hold it, so a
 * bad write cannot block the ledger forever.
 * @param {any} sync meta/sync data (or null)
 * @param {string} now
 * @param {number} [leaseMs]
 * @returns {{held: boolean, runningSince: string|null, ageMs: number|null}}
 */
export function leaseStatus(sync, now, leaseMs = LEASE_MS) {
  const rs = typeof sync?.runningSince === 'string' ? sync.runningSince : null;
  const t = Date.parse(rs ?? '');
  if (rs === null || Number.isNaN(t)) return { held: false, runningSince: rs, ageMs: null };
  const ageMs = time(now) - t;
  return { held: ageMs < leaseMs && ageMs > -leaseMs, runningSince: rs, ageMs };
}

/**
 * Keys of events recorded before this engine (hand-written or by the old snapshot script), so the first run
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
 * With target 'feed' (ledger v2): agent rows are dropped, and each row goes to
 * `feed-YYYY-MM/j-…` (the month of its `at`), clamped to the feed caps; a row validateEvent
 * still rejects (an unknown kind) is skipped with a warning.
 * @param {string[]} lines
 * @param {{target?: 'events'|'feed'}} [opts]
 * @returns {{events: Doc[], warnings: string[]}}
 */
export function journalToEvents(lines, { target = 'events' } = {}) {
  const feed = target === 'feed';
  const events = [];
  const warnings = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { warnings.push(`journal line skipped (not JSON): ${eventIds.journal(line)}`); continue; }
    if (!o || typeof o !== 'object' || !o.title || !o.at || Number.isNaN(Date.parse(o.at))) {
      warnings.push(`journal line skipped (needs at and title): ${eventIds.journal(line)}`);
      continue;
    }
    if (feed && o.kind === 'agent') continue;
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
    const doc = { collection: 'events', id: eventIds.journal(line), data };
    if (!feed) { events.push(doc); continue; }
    const f = toFeedDoc(doc);
    const v = validateEvent(f.data);
    if (v.ok) events.push(f);
    else warnings.push(`journal line skipped (${v.errors.join('; ')}): ${doc.id}`);
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
 * sha with a successful push Smoke. prodPrTitles: the PRs merged at the prodServes sha ({n, title}).
 * openProgramPrs / openBotPrs / openOlderPrs come from openSplit (splitOpenPrs), null when absent;
 * programPrsFromThreads is the project-snapshot cross-check (null without a snapshot).
 * Keeps every other key already in the doc, except the v1 keys program and currentPhase.
 * @param {{prev?: any, mainSha: string, ciRuns?: Run[], smokeRuns?: Run[], openPrs: number, openSplit?: {program: number, bot: number, older: number}|null, prs?: Pr[], programPrsFromThreads?: number|null, now: string, by: string}} args
 * @returns {Record<string, any>}
 */
export function buildState({ prev, mainSha, ciRuns = [], smokeRuns = [], openPrs, openSplit = null, prs = [], programPrsFromThreads = null, now, by }) {
  const forMain = (runs) => newestFirst(runs).find((r) => r.sha.startsWith(mainSha));
  const ciLatest = forMain(ciRuns.filter(isMainPush));
  const pushSmoke = newestFirst(smokeRuns.filter(isMainPush));
  const smokeLatest = forMain(pushSmoke);
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

  const kept = { ...(prev && typeof prev === 'object' ? prev : {}) };
  delete kept.program; // v1 keys, removed from the doc in ledger v2
  delete kept.currentPhase;
  const prodPrTitles = prodServes
    ? prs.filter((p) => p.state === 'merged' && p.mergeSha === prodServes).sort((a, b) => a.number - b.number).map((p) => ({ n: p.number, title: p.title }))
    : [];
  return {
    ...kept,
    mainSha,
    ciMain: runState(ciLatest),
    smokeMain,
    smokeNote,
    smokeUrl: smokeLatest ? smokeLatest.url : null,
    prodServes,
    prodServesNote,
    prodDeploy,
    prodPrTitles,
    openPrs,
    openProgramPrs: openSplit ? openSplit.program : null,
    openBotPrs: openSplit ? openSplit.bot : null,
    openOlderPrs: openSplit ? openSplit.older : null,
    programPrsFromThreads: Number.isInteger(programPrsFromThreads) ? programPrsFromThreads : null,
    syncedAt: now,
    syncedBy: by === 'cloud' ? 'cloud routine' : by === 'session' ? 'session' : String(by),
  };
}

// ---------- whole plan (pure) ----------
/**
 * Everything one sync writes, from already-fetched GitHub data and the ledger dump.
 * gh: {mainSha (sha7), prs, openPrs (REST pulls), ciRuns, smokeRuns (REST runs)}
 * dump: {ids: Set<"collection/id">, fixstate: data[], fixes: data[], events?: {id,data}[],
 *        prevState, cutoverAt?} (cutoverAt comes from meta/sync; events is legacy and may be empty)
 * projectPrs: the hearthbot list_project_prs snapshot, or null (then programPrsFromThreads is null).
 * Writes prs, prstate (with title), fixstate (archive path), releases, feed rows (gh-* and the
 * journal's j-*, agent rows dropped, only inside emitWindow) and meta/state last.
 * @param {{gh: {mainSha: string, prs: any[], openPrs: any[], ciRuns: any[], smokeRuns: any[]}, dump: {ids: Set<string>, fixstate: any[], fixes: any[], events?: Array<{id: string, data: any}>, prevState: any, cutoverAt?: string|null}, journalLines?: string[], now: string, by: string, projectPrs?: any}} args
 * @returns {{docs: Doc[], state: Record<string, any>, warnings: string[]}}
 */
export function planSync({ gh, dump, journalLines = [], now, by, projectPrs = null }) {
  const all = gh.prs.map(normalizePr);
  const prs = all.filter(isProgramPr);
  const openList = gh.openPrs.map(normalizePr).filter((p) => p.state === 'open');
  const openPrs = openList.filter((p) => !isExcludedPr(p)).length;
  const ci = gh.ciRuns.map(normalizeRun);
  const smoke = gh.smokeRuns.map(normalizeRun);
  const journal = journalToEvents(journalLines, { target: 'feed' });
  const feed = feedDocs([...prEvents(prs), ...runEvents(ci, smoke), ...journal.events], { now, cutoverAt: dump.cutoverAt ?? null });
  const docs = [
    ...prDocs(prs),
    ...deriveFixStates(prs, currentFixStatuses(dump.fixstate, dump.fixes)),
    ...releaseDocs(all, smoke, ci),
    ...feed.docs,
  ];
  const state = buildState({
    prev: dump.prevState, mainSha: gh.mainSha, ciRuns: ci, smokeRuns: smoke, openPrs,
    openSplit: splitOpenPrs(openList), prs: all,
    programPrsFromThreads: projectPrs == null ? null : countOpenProjectPrs(projectPrs),
    now, by,
  });
  const fresh = diffAgainstExisting(docs, dump.ids, legacyEventKeys(dump.events ?? []));
  return { docs: [...fresh, { collection: 'meta', id: 'state', data: state }], state, warnings: [...journal.warnings, ...feed.warnings] };
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

export const AGENT_DETAIL_MAX = 280;
const HOUR_MS = 60 * 60 * 1000;
/** Agent ids as keys: the Agent tool's `tool_response.agentId` and SubagentStop's `agent_id` (an optional `agent-` prefix is ignored). */
const agentKey = (id) => (typeof id === 'string' ? id.trim().replace(/^agent-/, '') : '');
const oneLine = (text, max) => scrub(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isAgentTool = (input) => input.hook_event_name === 'PostToolUse' && (input.tool_name === 'Agent' || input.tool_name === 'Task');
const contentText = (content) => (Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

/**
 * Exit code of a Bash call seen by PostToolUse. Claude Code's Bash tool_response has no exit code
 * field ({stdout, stderr, interrupted, isImage, noOutputExpected, …}), but PostToolUse fires only
 * after a tool completes successfully: a command that exits non-zero fires PostToolUseFailure,
 * with "Exit code N" in `error` (https://code.claude.com/docs/en/hooks.md, PostToolUse and
 * PostToolUseFailure). So no field means 0, except: interrupted → null (failed);
 * backgroundTaskId (still running) or returnCodeInterpretation (a non-zero exit Claude Code
 * read as benign, e.g. grep's "No matches found") → null (unknown). An explicit exit_code wins.
 * @param {any} tr
 * @returns {number|null}
 */
function bashExitCode(tr) {
  if (Number.isInteger(tr.exit_code)) return tr.exit_code;
  if (Number.isInteger(tr.exitCode)) return tr.exitCode;
  if (tr.interrupted || tr.backgroundTaskId || tr.returnCodeInterpretation) return null;
  return 0;
}

/**
 * True when the hook input needs the agents state (~/.smartremit-ledger/agents.json): a
 * main-thread Agent launch (no agent_id) or a SubagentStop. Other inputs skip the state file.
 * @param {any} input
 * @returns {boolean}
 */
export function hookUsesAgents(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.hook_event_name === 'SubagentStop') return true;
  return isAgentTool(input) && !input.agent_id;
}

/**
 * Journal entries for one hook input, and the next agents state. Pure: `agents` is never mutated.
 * - PostToolUse Agent on the MAIN thread (no agent_id): records {agentId, description,
 *   subagent_type, model, startedAt} under tool_response.agentId and journals "Agent started".
 *   A foreground run (status "completed") has already stopped, and its SubagentStop fired before
 *   this hook while its id was unknown, so this one call journals both its start and its finish.
 * - SubagentStop: journals "Agent finished: <description>" (detail: the scrubbed first 280 chars
 *   of last_assistant_message) only for a recorded agent not yet finished, then marks it finished.
 *   A later stop of the same agent only updates lastMessage. Unknown ids (nested helpers,
 *   Claude Code's internal agents) are skipped.
 * - PostToolUse Bash on the main thread: `gh pr merge|close` rows.
 * The Agent prompt (tool_input.prompt, tool_response.prompt) is never logged or stored.
 * @param {any} input
 * @param {string} now
 * @param {Record<string, any>} [agents]
 * @returns {{entries: Array<{at: string, kind: string, actor: string, title: string, detail: string, model?: string, refs?: object, result?: string}>, agents: Record<string, any>, changed: boolean}}
 */
export function hookToJournalEntries(input, now, agents = {}) {
  const none = { entries: [], agents, changed: false };
  if (!input || typeof input !== 'object') return none;

  if (input.hook_event_name === 'SubagentStop') {
    const id = agentKey(input.agent_id);
    const rec = id && Object.hasOwn(agents, id) ? agents[id] : null;
    if (!rec || typeof rec !== 'object') return none;
    const lastMessage = oneLine(input.last_assistant_message, AGENT_DETAIL_MAX);
    if (rec.finishedAt) {
      if (rec.lastMessage === lastMessage) return none;
      return { entries: [], agents: { ...agents, [id]: { ...rec, lastMessage } }, changed: true };
    }
    const entry = {
      at: now, kind: 'agent', actor: 'agent', ...(rec.model ? { model: rec.model } : {}),
      title: `Agent finished: ${rec.description || 'agent'}`,
      detail: lastMessage || `${rec.subagent_type || 'general-purpose'} agent finished`,
      result: 'ok',
    };
    return { entries: [entry], agents: { ...agents, [id]: { ...rec, finishedAt: now, lastMessage } }, changed: true };
  }

  if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return none;
  const ti = input.tool_input || {};
  const tr = input.tool_response || {};

  if (isAgentTool(input)) {
    const id = agentKey(tr.agentId);
    if (id && Object.hasOwn(agents, id)) return none;
    const description = scrub(ti.description || 'agent').slice(0, 120);
    const subagentType = scrub(ti.subagent_type || 'general-purpose').slice(0, 60);
    const model = scrub(tr.resolvedModel || ti.model || ti.subagent_type || '').slice(0, 60);
    const modelField = model ? { model } : {};
    const finished = tr.status === 'completed';
    const ms = Number.isFinite(tr.totalDurationMs) && tr.totalDurationMs > 0 ? tr.totalDurationMs : 0;
    const startedAt = finished && ms && !Number.isNaN(Date.parse(now)) ? new Date(Date.parse(now) - ms).toISOString() : now;
    const entries = [{
      at: startedAt, kind: 'agent', actor: 'claude', ...modelField,
      title: `Agent started: ${description}`,
      detail: `${subagentType} agent launched${finished ? ' (foreground)' : ''}`,
      result: 'running',
    }];
    const rec = { agentId: id, description, subagent_type: subagentType, ...modelField, startedAt };
    if (finished) {
      const lastMessage = oneLine(contentText(tr.content), AGENT_DETAIL_MAX);
      entries.push({
        at: now, kind: 'agent', actor: 'agent', ...modelField,
        title: `Agent finished: ${description}`,
        detail: lastMessage || `${subagentType} agent finished${ms ? `, ${Math.round(ms / 1000)} s` : ''}`,
        result: 'ok',
      });
      Object.assign(rec, { finishedAt: now, lastMessage });
    }
    return id ? { entries, agents: { ...agents, [id]: rec }, changed: true } : { entries, agents, changed: false };
  }

  if (input.tool_name === 'Bash') {
    const code = bashExitCode(tr);
    const entries = parseGhPrCommands(String(ti.command ?? '')).map(({ verb, pr }) => ({
      at: now, kind: 'pr', actor: 'claude',
      title: `gh pr ${verb}${pr ? ` #${pr}` : ''} run in a session`,
      detail: `Exit ${code ?? 'unknown'}. GitHub records the ${verb} itself; this row records who ran it and when.`,
      ...(pr ? { refs: { pr: [pr] } } : {}),
      result: code === 0 ? 'ok' : code === null ? (tr.interrupted ? 'failed' : 'info') : 'failed',
    }));
    return { entries, agents, changed: false };
  }
  return none;
}

/**
 * The agents state without stale records: finished agents go 24 h after they finished,
 * unfinished ones 7 days after they started (a background agent can run for hours).
 * @param {any} agents
 * @param {string} now
 * @param {{finishedTtlMs?: number, openTtlMs?: number}} [opts]
 * @returns {Record<string, any>}
 */
export function pruneAgents(agents, now, { finishedTtlMs = 24 * HOUR_MS, openTtlMs = 7 * 24 * HOUR_MS } = {}) {
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return {};
  const t = time(now);
  const out = {};
  for (const [id, rec] of Object.entries(agents)) {
    if (!rec || typeof rec !== 'object') continue;
    const age = rec.finishedAt ? t - time(rec.finishedAt) : t - time(rec.startedAt);
    if (age <= (rec.finishedAt ? finishedTtlMs : openTtlMs)) out[id] = rec;
  }
  return out;
}

/**
 * Journal kinds the owner wants on the page promptly: an unflushed one makes the Stop hook block
 * at once. `approval`, `decision`, `verify` and `owner-step` were urgent before 2026-09-22; the
 * owner then decided routine rows can wait for SYNC_STALE_MS instead (the Stop hook was blocking
 * too often and draining usage) — keep this list to what truly cannot wait.
 */
export const URGENT_JOURNAL_KINDS = Object.freeze(['incident', 'merge', 'migration']);
/**
 * A session `gh pr merge` row that succeeded (kind pr, result ok, as hookToJournalEntries writes
 * it): urgent like a merge row. The main-moved rule alone cannot catch it when ls-remote fails.
 * @param {any} o a parsed journal line
 */
export const isSessionMerge = (o) => o?.kind === 'pr' && o.result === 'ok' && /^gh pr merge\b/.test(String(o.title ?? ''));
/** Routine journal entries wait until the last sync is older than this. */
export const SYNC_STALE_MS = 60 * 60 * 1000;
const SYNC_DUE_TAIL = 'Run the tracker-sync skill (automated engine) now, then finish.';

/**
 * The urgent kinds (URGENT_JOURNAL_KINDS) among journal lines, deduped and sorted; a successful
 * session `gh pr merge` row counts as 'merge'. Bad lines are ignored.
 * @param {string[]|undefined} lines
 * @returns {string[]}
 */
export function urgentJournalKinds(lines) {
  const found = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    try {
      const o = JSON.parse(line);
      if (URGENT_JOURNAL_KINDS.includes(o?.kind)) found.add(o.kind);
      else if (isSessionMerge(o)) found.add('merge');
    } catch { /* not JSON: sync.mjs warns about it; it cannot make a sync urgent */ }
  }
  return [...found].sort();
}

/**
 * The ledger-sync-due Stop hook's decision. Blocks (once; stop_hook_active short-circuits) when
 * (c) an unflushed journal line is an urgent kind (URGENT_JOURNAL_KINDS) or a successful session
 *     `gh pr merge` (isSessionMerge), or
 * (b) the journal has unflushed bytes and the last sync (last-sync.json `at`) is more than
 *     60 minutes old or unknown, or
 * (a) main moved since the last recorded sync (remoteMainSha from ls-remote vs lastSyncMainSha).
 * The journal checks need no network, so the hook calls this with remoteMainSha null first and
 * runs ls-remote only when that returns null. Never blocks in the cloud routine, when disabled,
 * or on (a) when ls-remote failed (remoteMainSha null) or no sync was recorded yet.
 * @param {{stopHookActive?: boolean, remote?: boolean, disabled?: boolean, journalSize: number, flushedOffset: number, pendingLines?: string[], lastSyncAt?: string|null, now: string, remoteMainSha?: string|null, lastSyncMainSha?: string|null}} args
 * @returns {{decision: 'block', reason: string} | null}
 */
export function stopDecision({ stopHookActive, remote, disabled, journalSize, flushedOffset, pendingLines = [], lastSyncAt, now, remoteMainSha, lastSyncMainSha }) {
  if (stopHookActive || remote || disabled) return null;
  if (journalSize > flushedOffset) {
    const urgent = urgentJournalKinds(pendingLines);
    if (urgent.length) return { decision: 'block', reason: `Ledger sync due: the journal holds a new ${urgent.join(', ')} entry. ${SYNC_DUE_TAIL}` };
    const last = typeof lastSyncAt === 'string' ? Date.parse(lastSyncAt) : NaN;
    if (Number.isNaN(last)) return { decision: 'block', reason: `Ledger sync due: new journal entries and no sync time on record. ${SYNC_DUE_TAIL}` };
    const age = time(now) - last;
    if (age > SYNC_STALE_MS) return { decision: 'block', reason: `Ledger sync due: new journal entries and the last sync was ${Math.floor(age / 60_000)} min ago. ${SYNC_DUE_TAIL}` };
  }
  const last = typeof lastSyncMainSha === 'string' ? lastSyncMainSha.toLowerCase() : '';
  const head = typeof remoteMainSha === 'string' ? remoteMainSha.toLowerCase() : '';
  if (last.length >= 7 && /^[0-9a-f]{40}$/.test(head) && !head.startsWith(last)) {
    return { decision: 'block', reason: `Ledger sync due: main moved to ${head.slice(0, 7)} since the last sync (${last.slice(0, 7)}). ${SYNC_DUE_TAIL}` };
  }
  return null;
}
