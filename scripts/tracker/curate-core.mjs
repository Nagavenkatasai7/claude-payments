// Program Ledger v2, CURATE step: PURE functions (no I/O). The curator agent proposes a patch;
// this code decides. curate.mjs reads the dump, the fetched threads and source files, and calls
// validatePatch -> applyOps -> planWrites. Tests: tests/tracker-curate-core.test.ts.
//
// Node built-ins only (the routine runs this without npm install).
//
// ---------- input shapes ----------
// Thread file (one per fetched thread) = the raw hearthbot fetch_thread result:
//   {thread_id, messages: [{id, thread_id, created_at, author: 'user'|'agent', author_id?, author_name?,
//    body, surface?}], cursor, has_more}
// An OWNER message is one whose author kind is human: author 'user' (or 'human'), or from 'human';
// when facts.ownerId (meta/sync.ownerId) is set, its author_id must also equal it.
// author_name is a self-chosen label and is never trusted. A status message body is JSON
// {kind, text}; its text is what a quote must match.
//
// sources (buildSources): the fetched set of this run, by evidence kind:
//   msg (thread messages), mem and file (copied MEMORY.md, memory topic and review files),
//   pr (PR titles), art (Artifact titles), feed (feed rows: title + detail; the curator's own
//   cur-* and chg-* rows are left out, so it cannot quote itself), inbox (inbox texts).
// facts: {dump, now?, ownerId?, prs: {<n>: {state, mergedAt, title}} (GitHub, engine), threads: {<threadId>: ...},
//   wsFacts?: {<key>: facts} (collect), stubs?: ws docs (collect), docsRows?: [{id, isNew, data}] (collect),
//   fetched?: {threads: [{threadId, lastMsgId, lastAt}], memory?: {sha256}, reviews?: {<file>: mtime}}}
// dump: {ws, todo, acks, decisions, issues, docs, inbox: {<id>: data}, meta: {headline, cursors},
//   'feed-YYYY-MM': {<id>: data}}
//
// patch: {ops: [{op, ...fields, evidence: [{kind, ref, quote}]}]}. See PATCH_SCHEMA.
import { createHash } from 'node:crypto';
import { scrub, splitBatches } from './sync-core.mjs';

export const QUOTE_MIN = 12;
export const QUOTE_MAX = 160;
export const MAX_EVIDENCE = 3;
/** Evidence kept on a doc (newest last). */
export const EVIDENCE_KEEP = 8;
export const MAX_OPS = 200;
export const EVIDENCE_KINDS = Object.freeze(['msg', 'mem', 'file', 'pr', 'art', 'feed', 'inbox']);
/** A message quote that reports a check (past tense or a state), for closeTodo authority. */
export const VERIFY_RE = /\b(verified|confirmed|passed|is live|works now|green)\b/i;
/** A quote with a negation, a request, a condition or an intent does not report a check. */
export const NOT_A_REPORT_RE = /\b(not|no|never|nothing|yet|please|pls|could|can|should|would|will|shall|must|need|needs|if|unless|until|when|once|try|confirm|verify)\b|n't\b|\?/i;
/** Feed sources the engine writes (GitHub and CI): their verify rows are verification authority. */
const ENGINE_SOURCES = new Set(['github', 'ci']);

export const WS_STATUS = Object.freeze(['working', 'waiting_owner', 'waiting_external', 'live', 'on_hold', 'planned', 'done', 'cancelled']);
export const WAITING_ON = Object.freeze(['owner', 'external', 'thread', 'none']);
export const TODO_STATUS = Object.freeze(['open', 'acked', 'done', 'dropped']);
export const PRIORITIES = Object.freeze(['now', 'soon', 'later']);
export const DECISION_STATUS = Object.freeze(['open', 'decided', 'withdrawn']);
export const ISSUE_KIND = Object.freeze(['bug', 'risk', 'debt']);
export const ISSUE_SEVERITY = Object.freeze(['high', 'medium', 'low']);
export const ISSUE_STATUS = Object.freeze(['open', 'resolved', 'wontfix']);
export const DOC_KIND = Object.freeze(['plan', 'guide', 'review', 'checklist', 'other']);
export const DOC_STATUS = Object.freeze(['current', 'accepted', 'superseded']);
// sync-core EVENT_KINDS minus 'agent' (no agent noise) and 'change' (code only). A curator row
// (source 'curator', result 'info') is never evidence (buildSources leaves cur-* and chg-* rows
// out) and never verification authority (closeTodo needs a GitHub / CI verify row), whatever its kind.
export const CURATOR_EVENT_KINDS = Object.freeze(['decision', 'approval', 'plan', 'review', 'pr', 'merge', 'deploy', 'migration', 'owner-step', 'verify', 'milestone', 'incident', 'security']);

/** The collections whose docs get createdAt / updatedAt / prevStatus / statusChangedAt stamps and chg-* rows. */
const SECTIONS = ['ws', 'todo', 'decisions', 'issues'];
const STAMPS = ['createdAt', 'updatedAt', 'prevStatus', 'statusChangedAt'];
const META_LAST = ['cursors', 'headline'];

// ---------- small helpers ----------
const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const ws = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normTitle = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s, max = 48) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => (x === undefined ? undefined : structuredClone(x));
/** JSON with sorted keys: equality and hashing that ignore key order. */
function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (isObj(x)) return `{${Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
const same = (a, b) => stable(a) === stable(b);
const prNum = (ref) => { const m = String(ref ?? '').match(/^#?(\d+)$/); return m ? Number(m[1]) : null; };

/** 'feed-YYYY-MM' (UTC) for a time. */
export const feedMonth = (at) => `feed-${new Date(time(at)).toISOString().slice(0, 7)}`;
/** chg-<sha1(section|key|from|to|runId)[0:16]>: one status change in one run. */
export const chgId = (section, key, from, to, runId) => `chg-${sha1(`${section}|${key}|${from ?? ''}|${to ?? ''}|${runId}`).slice(0, 16)}`;
/** cur-<sha1(threadId|msgId|kind|key)[0:16]>: a curator event. */
export const curId = (threadId, msgId, kind, key) => `cur-${sha1(`${threadId ?? ''}|${msgId ?? ''}|${kind}|${key}`).slice(0, 16)}`;

export class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchError';
  }
}

// ---------- messages and sources ----------
/**
 * True when the message author kind is human (the owner or another project member).
 * @param {any} m a raw fetch_thread message
 */
export function isOwnerMessage(m) {
  if (!isObj(m)) return false;
  const kind = String(m.author_kind ?? m.author ?? '').toLowerCase();
  return kind === 'user' || kind === 'human' || String(m.from ?? '').toLowerCase() === 'human';
}

/** The text a quote must match: a status message's text, else the body. */
function messageText(body) {
  const s = typeof body === 'string' ? body : '';
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (isObj(j) && typeof j.text === 'string') return j.text;
    } catch { /* plain body */ }
  }
  return s;
}

/**
 * fetch_thread output -> [{id, threadId, owner, authorId, createdAt, text}].
 * @param {any} raw
 */
export function normalizeThreadMessages(raw) {
  const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
  return msgs
    .filter((m) => isObj(m) && typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      threadId: typeof m.thread_id === 'string' ? m.thread_id : (raw.thread_id ?? null),
      owner: isOwnerMessage(m),
      authorId: typeof m.author_id === 'string' ? m.author_id : null,
      createdAt: m.created_at ?? null,
      text: messageText(m.body),
    }));
}

/** A feed row the curator (or code acting on its ops) wrote: never evidence. (Hand-written journal rows may have kind 'change'; they stay.) */
const isCuratorRow = (id, d) => /^(cur|chg)-/.test(String(id)) || d?.source === 'curator';

/**
 * The fetched set of this run, indexed by evidence kind.
 * @param {{threads?: any[], files?: Record<string, string>, prs?: Array<{n: number, title: string}>, artifacts?: Array<{id: string, title: string}>, feed?: Array<{id: string, data?: any}>, inbox?: Record<string, any>}} args
 */
export function buildSources({ threads = [], files = {}, prs = [], artifacts = [], feed = [], inbox = {} } = {}) {
  const msg = {};
  for (const t of threads) for (const m of normalizeThreadMessages(t)) msg[m.id] = m;
  const pr = {};
  for (const p of prs) if (Number.isInteger(p?.n)) pr[p.n] = String(p.title ?? '');
  const art = {};
  for (const a of artifacts) if (a?.id) art[a.id] = String(a.title ?? '');
  const feedText = {};
  for (const r of feed) {
    const d = r?.data ?? r;
    if (!r?.id || isCuratorRow(r.id, d)) continue;
    feedText[r.id] = { text: `${d?.title ?? ''} ${d?.detail ?? ''}`, kind: d?.kind ?? null, result: d?.result ?? null, source: d?.source ?? null };
  }
  const inboxText = {};
  for (const [id, d] of Object.entries(inbox)) inboxText[id] = String(d?.text ?? '');
  return { msg, file: { ...files }, pr, art, feed: feedText, inbox: inboxText };
}

function sourceText(e, sources) {
  switch (e.kind) {
    case 'msg': return sources.msg?.[e.ref]?.text;
    case 'mem':
    case 'file': return sources.file?.[e.ref];
    case 'pr': { const n = prNum(e.ref); return n === null ? undefined : sources.pr?.[n]; }
    case 'art': return sources.art?.[e.ref];
    case 'feed': return sources.feed?.[e.ref]?.text;
    case 'inbox': return sources.inbox?.[e.ref];
    default: return undefined;
  }
}

/**
 * null when the evidence quote is a verbatim (whitespace-normalised) substring of the referenced
 * source in this run's fetched set and is 12-160 characters; else the reason.
 * @param {{kind: string, ref: string, quote: string}} e
 * @param {ReturnType<typeof buildSources>} sources
 */
export function quoteGrounded(e, sources) {
  if (!isObj(e)) return 'evidence item is not an object';
  if (!EVIDENCE_KINDS.includes(e.kind)) return `evidence kind ${JSON.stringify(e.kind)} is not one of ${EVIDENCE_KINDS.join('|')}`;
  if (typeof e.ref !== 'string' || !e.ref || e.ref.length > 160) return 'evidence ref must be a non-empty string';
  const q = ws(e.quote);
  if (q.length < QUOTE_MIN || q.length > QUOTE_MAX) return `evidence quote must be ${QUOTE_MIN}-${QUOTE_MAX} characters (whitespace-normalised)`;
  const text = sourceText(e, sources);
  if (typeof text !== 'string') return `evidence ref ${e.kind}:${e.ref} is not in this run's fetched set`;
  if (!ws(text).includes(q)) return `evidence quote not found in ${e.kind}:${e.ref}`;
  return null;
}

/**
 * null unless the op contradicts the engine: status live or done (or a merge event) citing a PR
 * that GitHub does not show as merged.
 * @param {any} op
 * @param {{prs?: Record<string, {state?: string}>}} facts
 */
export function contradictsEngine(op, facts) {
  const cited = [];
  if (op.op === 'upsertWs' && (op.status === 'live' || op.status === 'done')) {
    cited.push(...(Array.isArray(op.prs) ? op.prs : []), ...(op.evidence ?? []).filter((e) => e?.kind === 'pr').map((e) => prNum(e.ref)));
  }
  if (op.op === 'addEvent' && op.kind === 'merge') cited.push(...(op.refs?.pr ?? []));
  for (const n of cited) {
    if (!Number.isInteger(n)) continue;
    if (facts?.prs?.[n]?.state !== 'merged') return `${op.op === 'upsertWs' ? `status ${op.status}` : 'merge event'} cites PR #${n}, which GitHub does not show as merged`;
  }
  return null;
}

/**
 * The id of an item in `docs` whose title (or question) matches `title` after normalisation
 * (case, punctuation, spacing), among the given statuses; else null.
 * @param {Record<string, any>} docs
 * @param {string} title
 * @param {string[]} statuses
 */
export function dedupeByTitle(docs, title, statuses) {
  const want = normTitle(title);
  if (!want) return null;
  for (const id of Object.keys(docs ?? {}).sort()) {
    const d = docs[id];
    if (statuses.includes(d?.status) && normTitle(d.title ?? d.question) === want) return id;
  }
  return null;
}

// ---------- schema ----------
const F = {
  str: (max, min = 1) => ({ t: 'str', min, max }),
  slug: (max = 48) => ({ t: 'slug', max }),
  id: (max = 100) => ({ t: 'id', max }),
  thread: () => ({ t: 'thread' }),
  iso: () => ({ t: 'iso' }),
  url: () => ({ t: 'url' }),
  en: (values) => ({ t: 'enum', values }),
  ints: (max = 20) => ({ t: 'ints', max }),
  strs: (maxItems, max) => ({ t: 'strs', maxItems, max }),
};
const req = (spec) => ({ ...spec, req: true });

/**
 * Every curator op and its fields (besides `op` and `evidence`). req = required.
 * Lengths are characters. Code, not the curator, sets ids it derives, stamps, askedAt and decidedAt.
 */
export const PATCH_SCHEMA = Object.freeze({
  setHeadline: { text: req(F.str(320)), short: req(F.str(40)) },
  upsertWs: { key: req(F.slug()), name: F.str(80), status: F.en(WS_STATUS), summary: F.str(400, 0), nextStep: F.str(200, 0), waitingOn: F.en(WAITING_ON), testGuide: F.str(300, 0), startedAt: F.iso(), prs: F.ints(), reopenReason: F.str(200) },
  mapThread: { threadId: req(F.thread()), ws: req(F.slug()) },
  createTodo: { id: F.slug(100), ws: req(F.slug()), title: req(F.str(90)), why: F.str(160, 0), steps: F.strs(8, 160), where: { t: 'where' }, priority: req(F.en(PRIORITIES)), threadId: F.thread() },
  updateTodo: { id: req(F.slug(100)), title: F.str(90), why: F.str(160, 0), steps: F.strs(8, 160), where: { t: 'where' }, priority: F.en(PRIORITIES), status: F.en(['open']), reopenReason: F.str(200) },
  closeTodo: { id: req(F.slug(100)), status: F.en(['done', 'dropped']) },
  openDecision: { id: F.slug(64), question: req(F.str(240)), options: { t: 'options', req: true }, recommended: F.str(60), threadId: F.thread(), ws: F.slug(), refs: { t: 'refs' }, reopenReason: F.str(200) },
  decide: { id: req(F.slug(64)), answer: req(F.str(200)) },
  withdraw: { id: req(F.slug(64)), reason: F.str(200, 0) },
  openIssue: { id: F.slug(64), title: req(F.str(140)), detail: F.str(300, 0), kind: req(F.en(ISSUE_KIND)), severity: req(F.en(ISSUE_SEVERITY)), ws: F.slug(), reopenReason: F.str(200) },
  updateIssue: { id: req(F.slug(64)), title: F.str(140), detail: F.str(300, 0), kind: F.en(ISSUE_KIND), severity: F.en(ISSUE_SEVERITY), ws: F.slug(), status: F.en(['open']), reopenReason: F.str(200) },
  resolveIssue: { id: req(F.slug(64)), status: F.en(['resolved', 'wontfix']), resolution: req(F.str(200)) },
  classifyDoc: { id: req(F.id()), ws: { t: 'slugOrNull' }, kind: F.en(DOC_KIND), status: F.en(DOC_STATUS) },
  addEvent: { kind: req(F.en(CURATOR_EVENT_KINDS)), title: req(F.str(140)), detail: F.str(280, 0), at: req(F.iso()), key: F.slug(64), threadId: F.thread(), refs: { t: 'refs' } },
  processInbox: { id: req(F.id()) },
});
// Ops that may carry no evidence (the authority is elsewhere: the inbox doc itself).
const EVIDENCE_OPTIONAL = new Set(['processInbox']);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const THREAD_RE = /^cmsg_[A-Za-z0-9]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function checkField(name, v, spec) {
  const bad = (why) => `${name} ${why}`;
  switch (spec.t) {
    case 'str':
      if (typeof v !== 'string') return bad('must be a string');
      if (v.trim().length < spec.min || v.length > spec.max) return bad(`must be ${spec.min}-${spec.max} characters`);
      return null;
    case 'slug': return typeof v === 'string' && v.length <= spec.max && SLUG_RE.test(v) ? null : bad(`must be a lowercase slug of at most ${spec.max} characters`);
    case 'slugOrNull': return v === null || (typeof v === 'string' && v.length <= 48 && SLUG_RE.test(v)) ? null : bad('must be a slug or null');
    case 'id': return typeof v === 'string' && v.length <= spec.max && ID_RE.test(v) ? null : bad('must be an id');
    case 'thread': return typeof v === 'string' && THREAD_RE.test(v) ? null : bad('must be a cmsg_ thread id');
    case 'iso': return typeof v === 'string' && ISO_RE.test(v) && time(v) > 0 ? null : bad('must be an ISO time');
    case 'url': return typeof v === 'string' && v.length <= 300 && /^https:\/\/[^\s]+$/.test(v) ? null : bad('must be an https URL');
    case 'enum': return spec.values.includes(v) ? null : bad(`must be one of ${spec.values.join('|')}`);
    case 'ints': return Array.isArray(v) && v.length <= spec.max && v.every((x) => Number.isInteger(x) && x > 0) ? null : bad('must be a list of PR numbers');
    case 'strs':
      if (!Array.isArray(v) || v.length > spec.maxItems) return bad(`must be a list of at most ${spec.maxItems}`);
      return v.every((x) => typeof x === 'string' && x.trim() && x.length <= spec.max) ? null : bad(`items must be 1-${spec.max} characters`);
    case 'where':
      if (!isObj(v) || Object.keys(v).some((k) => k !== 'label' && k !== 'url')) return bad('must be {label, url}');
      return checkField(`${name}.label`, v.label, F.str(60)) ?? (v.url === undefined || v.url === null ? null : checkField(`${name}.url`, v.url, F.url()));
    case 'options':
      if (!Array.isArray(v) || v.length < 2 || v.length > 4) return bad('must have 2-4 options');
      for (const o of v) {
        if (!isObj(o) || Object.keys(o).some((k) => k !== 'label' && k !== 'consequence')) return bad('items must be {label, consequence}');
        const r = checkField(`${name}.label`, o.label, F.str(60)) ?? checkField(`${name}.consequence`, o.consequence ?? '', F.str(200, 0));
        if (r) return r;
      }
      return null;
    case 'refs': {
      if (!isObj(v)) return bad('must be an object');
      const allowed = { pr: F.ints(), sha: F.str(40), threadId: F.thread(), msgId: F.id(), artifact: F.id(), ws: F.slug(), todo: F.slug(100), decision: F.slug(64) };
      for (const [k, x] of Object.entries(v)) {
        if (!allowed[k]) return bad(`has unknown key ${k}`);
        if (x === null) continue;
        const r = checkField(`${name}.${k}`, x, allowed[k]);
        if (r) return r;
      }
      return null;
    }
    default: return bad('has an unknown type');
  }
}

function checkSchema(op) {
  const spec = PATCH_SCHEMA[op.op];
  for (const k of Object.keys(op)) {
    if (k === 'op' || k === 'evidence') continue;
    if (!(k in spec)) return `unknown field ${k}`;
  }
  for (const [k, s] of Object.entries(spec)) {
    if (op[k] === undefined) { if (s.req) return `${k} is required`; continue; }
    const r = checkField(k, op[k], s);
    if (r) return r;
  }
  if (op.op === 'openDecision' && op.recommended !== undefined && !op.options.some((o) => o.label === op.recommended)) return 'recommended must be one of the option labels';
  const ev = op.evidence ?? [];
  if (!Array.isArray(ev)) return 'evidence must be a list';
  if (ev.length > MAX_EVIDENCE) return `evidence has more than ${MAX_EVIDENCE} items`;
  return null;
}

/** Every string inside a value, with its path. */
function strings(x, path = '') {
  if (typeof x === 'string') return [[path, x]];
  if (Array.isArray(x)) return x.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (isObj(x)) return Object.entries(x).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

// ---------- the working state ----------
const COLLS = ['ws', 'todo', 'acks', 'decisions', 'issues', 'docs', 'inbox'];
function workingCopy(dump) {
  const W = {};
  for (const [k, v] of Object.entries(dump ?? {})) W[k] = clone(v);
  for (const c of COLLS) W[c] = W[c] ?? {};
  W.meta = W.meta ?? {};
  return W;
}

/**
 * Fold the page's acks into to-do status 'acked': an ack (done or dismiss) newer than the to-do's
 * last status change moves an open to-do to acked and records the newest such ack as ackId (the
 * fold stamps statusChangedAt later than the ack, so later runs find the ack by id). Older acks
 * (before a reopen) are ignored. Returns a new todo collection; the input is not changed.
 * @param {Record<string, any>} todo
 * @param {Record<string, any>} acks
 */
export function foldAcks(todo, acks) {
  const out = clone(todo ?? {});
  for (const [todoId, t] of Object.entries(out)) {
    if (t?.status !== 'open') continue;
    const ackId = ackFor(acks, todoId, t.statusChangedAt ?? t.createdAt);
    if (ackId) Object.assign(t, { status: 'acked', ackId });
  }
  return out;
}

/** The ack id (newest) for to-do `id` later than `since`, if any. */
function ackFor(acks, id, since) {
  let best = null;
  for (const k of Object.keys(acks ?? {}).sort()) {
    const a = acks[k];
    if (a?.todoId === id && time(a.at) > time(since) && (!best || time(a.at) >= time(acks[best].at))) best = k;
  }
  return best;
}

/** The ack that authorises closing an acked to-do: the one the fold recorded, else one newer than its last status change. */
function ackOfAcked(acks, id, t) {
  if (t?.status !== 'acked') return null;
  if (t.ackId && acks?.[t.ackId]?.todoId === id) return t.ackId;
  return ackFor(acks, id, t.statusChangedAt ?? t.createdAt);
}

/**
 * Cursors after this run's reads: every fetched thread gets readAt = now; lastAt and lastMsgId
 * move forward only (never back); the ws mapping is kept. memory and reviews advance when read.
 * @param {any} cursors meta/cursors
 * @param {{threads?: Array<{threadId: string, lastMsgId?: string|null, lastAt?: string|null}>, memory?: {sha256: string}, reviews?: Record<string, string>}} fetched
 * @param {string} now ISO
 */
export function advanceCursors(cursors, fetched, now) {
  const out = clone(cursors ?? {}) ?? {};
  out.threads = out.threads ?? {};
  for (const f of fetched?.threads ?? []) {
    if (!f?.threadId) continue;
    const prev = out.threads[f.threadId] ?? {};
    const forward = !prev.lastAt || time(f.lastAt) > time(prev.lastAt);
    out.threads[f.threadId] = {
      ...prev,
      lastMsgId: forward ? (f.lastMsgId ?? prev.lastMsgId ?? null) : (prev.lastMsgId ?? null),
      lastAt: forward ? (f.lastAt ?? prev.lastAt ?? null) : prev.lastAt,
      readAt: now,
    };
  }
  if (fetched?.memory?.sha256) out.memory = { sha256: fetched.memory.sha256, readAt: now };
  if (fetched?.reviews) out.reviews = { ...(out.reviews ?? {}), ...fetched.reviews };
  return out;
}

const mergeEvidence = (prev, add) => {
  const seen = new Set();
  const all = [...(prev ?? []), ...(add ?? [])].filter((e) => {
    const k = `${e.kind}|${e.ref}|${ws(e.quote)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return all.slice(-EVIDENCE_KEEP);
};

/** Set the given fields on a doc; append evidence only when a field changed. Returns true on change. */
function setFields(doc, fields, evidence, evidenceField = 'evidence') {
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!same(doc[k], v)) { doc[k] = clone(v); changed = true; }
  }
  if (changed && evidence?.length) doc[evidenceField] = mergeEvidence(doc[evidenceField], evidence);
  return changed;
}

const pick = (op, keys) => Object.fromEntries(keys.filter((k) => op[k] !== undefined).map((k) => [k, op[k]]));
const emptyFacts = () => ({ threadIds: [], bucket: null, resolved: false, lastActivityAt: null, prs: [], artifacts: [] });

/**
 * Apply one (already validated) op to the working state W. Deterministic; idempotent (an op that
 * changes nothing leaves W as it was). Stamps are set later, by comparing with the dump.
 */
function applyOne(W, op, ctx) {
  const { now, runId } = ctx;
  const ev = op.evidence ?? [];
  switch (op.op) {
    case 'setHeadline': {
      const cur = W.meta.headline;
      if (cur && cur.text === op.text && cur.short === op.short) return;
      W.meta.headline = { text: op.text, short: op.short, asOf: now, evidence: clone(ev), updatedAt: now, runId };
      return;
    }
    case 'upsertWs': {
      const fields = pick(op, ['name', 'status', 'summary', 'nextStep', 'waitingOn', 'testGuide', 'startedAt', 'reopenReason']);
      const cur = W.ws[op.key];
      // PRs the curator attaches: kept apart from collect's facts.prs (recomputed every run), only added to.
      if (Array.isArray(op.prs) && op.prs.length) fields.prsCurated = [...new Set([...(cur?.prsCurated ?? []), ...op.prs])].sort((a, b) => a - b);
      if (!cur) {
        W.ws[op.key] = { key: op.key, name: op.name, status: op.status, summary: '', nextStep: '', waitingOn: 'none', facts: clone(ctx.wsFacts?.[op.key]) ?? emptyFacts(), startedAt: now, ...fields, evidence: mergeEvidence([], ev) };
        return;
      }
      if (setFields(cur, fields, ev) && cur.needsCuration) cur.needsCuration = false;
      return;
    }
    case 'mapThread': {
      const c = (W.meta.cursors = W.meta.cursors ?? { threads: {} });
      c.threads = c.threads ?? {};
      if (c.threads[op.threadId]?.ws !== op.ws) c.threads[op.threadId] = { ...(c.threads[op.threadId] ?? {}), ws: op.ws };
      return;
    }
    case 'createTodo':
    case 'updateTodo': {
      const cur = W.todo[op.id];
      // createTodo on an existing id (same normalised title, or a merged duplicate) keeps the title.
      const fields = pick(op, op.op === 'createTodo' ? ['why', 'steps', 'where', 'priority', 'threadId'] : ['title', 'why', 'steps', 'where', 'priority', 'threadId']);
      if (!cur) {
        W.todo[op.id] = { title: op.title, why: '', steps: [], where: null, priority: op.priority, ws: op.ws, threadId: null, status: 'open', doneAt: null, ...fields, evidence: mergeEvidence([], ev), doneEvidence: [], reopenReason: null };
        return;
      }
      if (op.op === 'updateTodo' && op.status === 'open' && cur.status !== 'open') {
        Object.assign(fields, { status: 'open', reopenReason: op.reopenReason ?? null, doneAt: null, ackId: null });
      }
      setFields(cur, fields, ev);
      return;
    }
    case 'closeTodo': {
      const cur = W.todo[op.id];
      const to = op.status ?? 'done';
      if (!cur || cur.status === to) return;
      const proof = op.ackId ? [...ev, { kind: 'ack', ref: op.ackId, quote: '' }] : ev;
      cur.status = to;
      cur.doneAt = now;
      cur.doneEvidence = mergeEvidence(cur.doneEvidence, proof);
      return;
    }
    case 'openDecision': {
      const cur = W.decisions[op.id];
      const fields = pick(op, op.mergedInto ? ['options', 'recommended', 'threadId', 'ws', 'refs'] : ['question', 'options', 'recommended', 'threadId', 'ws', 'refs']);
      if (!cur) {
        W.decisions[op.id] = { question: op.question, options: op.options, recommended: op.recommended ?? null, status: 'open', askedAt: op.askedAt ?? now, decidedAt: null, answer: null, by: 'owner', threadId: null, ws: null, refs: { pr: [], artifact: null }, ...fields, evidence: mergeEvidence([], ev), answerEvidence: [] };
        return;
      }
      if (cur.status !== 'open' && op.reopenReason) Object.assign(fields, { status: 'open', reopenReason: op.reopenReason, askedAt: op.askedAt ?? now, decidedAt: null, answer: null });
      setFields(cur, fields, ev);
      return;
    }
    case 'decide': {
      const cur = W.decisions[op.id];
      if (!cur || (cur.status === 'decided' && cur.answer === op.answer)) return;
      setFields(cur, { status: 'decided', answer: op.answer, decidedAt: op.decidedAt ?? now }, ev, 'answerEvidence');
      return;
    }
    case 'withdraw': {
      const cur = W.decisions[op.id];
      if (!cur || cur.status === 'withdrawn') return;
      setFields(cur, { status: 'withdrawn', answer: op.reason || null }, ev, 'answerEvidence');
      return;
    }
    case 'openIssue':
    case 'updateIssue': {
      const cur = W.issues[op.id];
      const fields = pick(op, op.mergedInto ? ['detail', 'kind', 'severity', 'ws'] : ['title', 'detail', 'kind', 'severity', 'ws']);
      if (!cur) {
        W.issues[op.id] = { title: op.title, detail: '', kind: op.kind, severity: op.severity, status: 'open', ws: null, openedAt: now, resolvedAt: null, resolution: null, ...fields, evidence: mergeEvidence([], ev) };
        return;
      }
      if (op.status === 'open' || (op.op === 'openIssue' && op.reopenReason)) {
        if (cur.status !== 'open') Object.assign(fields, { status: 'open', reopenReason: op.reopenReason ?? null, resolvedAt: null, resolution: null });
      }
      setFields(cur, fields, ev);
      return;
    }
    case 'resolveIssue': {
      const cur = W.issues[op.id];
      const to = op.status ?? 'resolved';
      if (!cur || (cur.status === to && cur.resolution === op.resolution)) return;
      setFields(cur, { status: to, resolution: op.resolution, resolvedAt: cur.status === to ? cur.resolvedAt : now }, ev);
      return;
    }
    case 'classifyDoc': {
      const cur = W.docs[op.id];
      if (cur) setFields(cur, pick(op, ['ws', 'kind', 'status']), []);
      return;
    }
    case 'addEvent': {
      const coll = feedMonth(op.at);
      const id = curId(op.threadId, op.msgId, op.kind, op.key);
      W[coll] = W[coll] ?? {};
      if (W[coll][id]) return;
      W[coll][id] = {
        at: op.at,
        kind: op.kind,
        actor: op.actor ?? 'claude',
        title: op.title,
        detail: op.detail ?? '',
        refs: { ...(op.refs ?? {}), ...(op.threadId ? { threadId: op.threadId } : {}), ...(op.msgId ? { msgId: op.msgId } : {}) },
        result: 'info',
        source: 'curator',
        evidence: clone(ev),
      };
      return;
    }
    case 'processInbox': {
      const cur = W.inbox[op.id];
      if (cur && !cur.processedAt) cur.processedAt = now;
      return;
    }
    default:
  }
}

// ---------- validatePatch ----------
const MSG_EV = (op, sources) => (op.evidence ?? []).filter((e) => e.kind === 'msg').map((e) => ({ ...sources.msg?.[e.ref], quote: e.quote })).filter((m) => m.id);
/** A human message, from the configured owner when facts.ownerId is set. */
const fromOwner = (m, facts) => Boolean(m?.owner) && (!facts?.ownerId || m.authorId === facts.ownerId);
/**
 * True when thread `threadId` belongs to an item (to-do or decision): its own threadId, or a
 * thread mapped to its ws (meta/cursors or ws facts). An item with neither is not tied to a thread.
 */
function inItemThread(W, item, threadId) {
  if (!item?.threadId && !item?.ws) return true;
  if (threadId && threadId === item.threadId) return true;
  if (!item.ws || !threadId) return false;
  return W.meta?.cursors?.threads?.[threadId]?.ws === item.ws || (W.ws[item.ws]?.facts?.threadIds ?? []).includes(threadId);
}
/** A quote that reports a check: a verify word, and no negation, request, condition or intent. */
const reportsCheck = (quote) => VERIFY_RE.test(quote ?? '') && !NOT_A_REPORT_RE.test(quote ?? '');

/**
 * Op-specific rules against the working state W (after the earlier accepted ops). Returns
 * {reason} to reject, or {op} (possibly rewritten: derived id, merge into a duplicate, derived
 * askedAt / decidedAt / actor).
 */
function checkRules(op, W, sources, facts) {
  const knownThread = (id) => !id || Boolean(facts?.threads?.[id]);
  const knownWs = (key) => Boolean(W.ws[key]);
  const reopen = (from, terminal) => terminal.includes(from) && !op.reopenReason;
  const msgs = MSG_EV(op, sources);
  switch (op.op) {
    case 'setHeadline': return { op };
    case 'upsertWs': {
      const cur = W.ws[op.key];
      if (!cur && (!op.name || !op.status)) return { reason: 'a new ws needs name and status' };
      const unknownPr = (op.prs ?? []).find((n) => !facts?.prs?.[n]);
      if (unknownPr !== undefined) return { reason: `prs cites PR #${unknownPr}, which neither GitHub nor the project list knows` };
      if (cur && op.status && op.status !== cur.status && cur.status === 'done' && op.status !== 'cancelled' && !op.reopenReason) return { reason: `ws ${op.key} is done; moving it to ${op.status} needs a reopenReason` };
      return { op };
    }
    case 'mapThread':
      if (!knownThread(op.threadId)) return { reason: `unknown thread ${op.threadId}` };
      if (!knownWs(op.ws)) return { reason: `unknown ws ${op.ws}` };
      return { op };
    case 'createTodo': {
      if (!knownWs(op.ws)) return { reason: `unknown ws ${op.ws}` };
      if (!knownThread(op.threadId)) return { reason: `unknown thread ${op.threadId}` };
      const dup = dedupeByTitle(W.todo, op.title, ['open', 'acked']);
      if (dup) return { op: { ...op, id: dup, mergedInto: dup } };
      const id = op.id ?? slug(`${op.ws}-${slug(op.title, 60)}`, 100);
      if (!id.startsWith(`${op.ws}-`)) return { reason: `to-do id must start with ${op.ws}-` };
      const cur = W.todo[id];
      if (cur && normTitle(cur.title) !== normTitle(op.title)) return { reason: `to-do ${id} exists with a different title` };
      return { op: { ...op, id } };
    }
    case 'updateTodo': {
      const cur = W.todo[op.id];
      if (!cur) return { reason: `to-do ${op.id} does not exist` };
      if (op.status === 'open' && cur.status !== 'open' && !op.reopenReason) return { reason: `to-do ${op.id} is ${cur.status}; reopening needs a reopenReason` };
      return { op };
    }
    case 'closeTodo': {
      const cur = W.todo[op.id];
      if (!cur) return { reason: `to-do ${op.id} does not exist` };
      const to = op.status ?? 'done';
      if (cur.status === to) return { op };
      const ackId = ackOfAcked(W.acks, op.id, cur);
      const owner = msgs.some((m) => fromOwner(m, facts));
      // Verification: a report in the to-do's own thread (or a thread of its ws), or an engine
      // (GitHub / CI) verify row that passed. Curator rows are not in the sources at all.
      const verify = msgs.some((m) => reportsCheck(m.quote) && inItemThread(W, cur, m.threadId))
        || (op.evidence ?? []).some((e) => {
          const f = e.kind === 'feed' ? sources.feed?.[e.ref] : null;
          return Boolean(f) && f.kind === 'verify' && f.result === 'ok' && ENGINE_SOURCES.has(f.source);
        });
      if (!owner && !verify && !ackId) return { reason: 'closeTodo needs an owner message, a verification message or an ack' };
      if (!(op.evidence ?? []).length && !ackId) return { reason: 'evidence is required' };
      return { op: ackId ? { ...op, ackId } : op };
    }
    case 'openDecision': {
      if (op.ws && !knownWs(op.ws)) return { reason: `unknown ws ${op.ws}` };
      if (!knownThread(op.threadId)) return { reason: `unknown thread ${op.threadId}` };
      const dup = dedupeByTitle(W.decisions, op.question, ['open']);
      const id = dup ?? op.id ?? slug(op.question, 64);
      if (!id) return { reason: 'cannot derive a decision id from the question' };
      const cur = W.decisions[id];
      if (cur && cur.status !== 'open' && !op.reopenReason) return { reason: `decision ${id} is ${cur.status}; reopening needs a reopenReason` };
      // askedAt comes from the earliest quoted message, never from the curator.
      const asked = msgs.map((m) => m.createdAt).filter(Boolean).sort((a, b) => time(a) - time(b))[0];
      return { op: { ...op, id, ...(dup ? { mergedInto: dup } : {}), ...(asked ? { askedAt: asked } : {}) } };
    }
    case 'decide': {
      const cur = W.decisions[op.id];
      if (!cur) return { reason: `decision ${op.id} does not exist` };
      if (cur.status === 'decided' && cur.answer === op.answer) return { op };
      if (cur.status !== 'open') return { reason: `decision ${op.id} is ${cur.status}, not open` };
      const later = msgs.filter((m) => fromOwner(m, facts) && time(m.createdAt) > time(cur.askedAt));
      if (!later.length) return { reason: 'decide needs an owner message later than askedAt' };
      const here = later.filter((m) => inItemThread(W, cur, m.threadId)).sort((a, b) => time(b.createdAt) - time(a.createdAt));
      if (!here.length) return { reason: `decide needs the owner message in the decision's thread (or a thread of ws ${cur.ws ?? '-'})` };
      const answer = normTitle(op.answer);
      const isOption = (cur.options ?? []).some((o) => normTitle(o?.label) === answer);
      const quoted = here.some((m) => normTitle(m.quote).includes(answer));
      if (!answer || (!isOption && !quoted)) return { reason: 'decide answer must be one of the option labels or appear in the quoted owner message' };
      return { op: { ...op, decidedAt: here[0].createdAt } };
    }
    case 'withdraw': {
      const cur = W.decisions[op.id];
      if (!cur) return { reason: `decision ${op.id} does not exist` };
      if (cur.status === 'decided') return { reason: `decision ${op.id} is decided; it cannot be withdrawn` };
      return { op };
    }
    case 'openIssue': {
      if (op.ws && !knownWs(op.ws)) return { reason: `unknown ws ${op.ws}` };
      const dup = dedupeByTitle(W.issues, op.title, ['open']);
      const id = dup ?? op.id ?? slug(op.title, 64);
      if (!id) return { reason: 'cannot derive an issue id from the title' };
      const cur = W.issues[id];
      if (cur && reopen(cur.status, ['resolved', 'wontfix'])) return { reason: `issue ${id} is ${cur.status}; reopening needs a reopenReason` };
      return { op: { ...op, id, ...(dup ? { mergedInto: dup } : {}) } };
    }
    case 'updateIssue': {
      const cur = W.issues[op.id];
      if (!cur) return { reason: `issue ${op.id} does not exist` };
      if (op.ws && !knownWs(op.ws)) return { reason: `unknown ws ${op.ws}` };
      if (op.status === 'open' && reopen(cur.status, ['resolved', 'wontfix'])) return { reason: `issue ${op.id} is ${cur.status}; reopening needs a reopenReason` };
      return { op };
    }
    case 'resolveIssue':
      if (!W.issues[op.id]) return { reason: `issue ${op.id} does not exist` };
      return { op };
    case 'classifyDoc':
      if (!W.docs[op.id]) return { reason: `doc ${op.id} does not exist` };
      if (op.ws && !knownWs(op.ws)) return { reason: `unknown ws ${op.ws}` };
      return { op };
    case 'addEvent': {
      if (!knownThread(op.threadId)) return { reason: `unknown thread ${op.threadId}` };
      const first = msgs[0];
      return {
        op: {
          ...op,
          key: op.key ?? slug(op.title, 64),
          threadId: op.threadId ?? first?.threadId ?? null,
          msgId: first?.id ?? null,
          actor: msgs.some((m) => fromOwner(m, facts)) ? 'owner' : 'claude',
        },
      };
    }
    case 'processInbox':
      if (!W.inbox[op.id]) return { reason: `inbox ${op.id} does not exist` };
      return { op };
    default:
      return { reason: `unknown op ${op.op}` };
  }
}

/**
 * Validate the curator's patch, op by op, in order. An op is checked against the state after the
 * earlier accepted ops (so createTodo then closeTodo in one patch works). Rejects: unknown op,
 * any delete, schema / enum / slug / length failures, text scrub() would change, evidence that is
 * missing, not grounded (12-160 chars, verbatim, ref in this run's fetched set), live/done citing
 * an unmerged PR, upsertWs.prs citing an unknown PR, closeTodo without owner / verification
 * (a report in the to-do's thread, or an engine verify row) / ack, decide without a later owner
 * message in the decision's thread or with an answer that is neither an option nor quoted, a
 * reopen without reopenReason, a create that would overwrite a different item.
 * Throws PatchError when the patch itself is malformed.
 * @param {unknown} patch
 * @param {ReturnType<typeof buildSources>} sources
 * @param {{dump: any, now?: string, ownerId?: string|null, prs?: Record<string, {state?: string, mergedAt?: string|null, title?: string}>, threads?: Record<string, any>, wsFacts?: Record<string, any>, stubs?: any[], docsRows?: Array<{id: string, data: any}>, fetched?: any}} facts
 * @returns {{accepted: any[], rejected: Array<{op: any, reason: string}>}}
 */
export function validatePatch(patch, sources, facts) {
  if (!isObj(patch) || !Array.isArray(patch.ops)) throw new PatchError('patch must be an object with an ops array');
  const W = workingCopy(facts?.dump);
  W.todo = foldAcks(W.todo, W.acks);
  for (const r of facts?.docsRows ?? []) W.docs[r.id] = { ...(W.docs[r.id] ?? {}), ...r.data };
  for (const s of facts?.stubs ?? []) if (s?.key && !W.ws[s.key]) W.ws[s.key] = clone(s);
  const accepted = [];
  const rejected = [];
  patch.ops.forEach((raw, i) => {
    const reject = (reason) => rejected.push({ op: raw, reason });
    if (i >= MAX_OPS) return reject(`more than ${MAX_OPS} ops`);
    if (!isObj(raw) || typeof raw.op !== 'string') return reject('op must be an object with an op name');
    if (/^(delete|remove|drop|purge|clear)/i.test(raw.op) || 'delete' in raw || 'remove' in raw) return reject('nothing deletes: the ledger is append-only');
    if (!PATCH_SCHEMA[raw.op]) return reject(`unknown op ${raw.op}`);
    const schema = checkSchema(raw);
    if (schema) return reject(schema);
    for (const [path, s] of strings(raw)) if (scrub(s) !== s) return reject(`scrub() would change ${path} (phone, email, token or long number)`);
    const ev = raw.evidence ?? [];
    if (!ev.length && !EVIDENCE_OPTIONAL.has(raw.op) && raw.op !== 'closeTodo') return reject('evidence is required');
    for (const e of ev) {
      const g = quoteGrounded(e, sources);
      if (g) return reject(g);
    }
    const c = contradictsEngine(raw, facts);
    if (c) return reject(c);
    const r = checkRules(raw, W, sources, facts);
    if (r.reason) return reject(r.reason);
    accepted.push(r.op);
    applyOne(W, r.op, { now: facts?.now ?? new Date(0).toISOString(), runId: 'validate', wsFacts: facts?.wsFacts });
  });
  return { accepted, rejected };
}

// ---------- applyOps ----------
const stripStamps = (d) => {
  const o = { ...d };
  for (const k of [...STAMPS, 'facts']) delete o[k];
  return o;
};
const SECTION_LABEL = { ws: 'Workstream', todo: 'To-do', decisions: 'Decision', issues: 'Issue' };
const REF_KEY = { ws: 'ws', todo: 'todo', decisions: 'decision', issues: null };

function chgRow(section, id, doc, from, to, now) {
  const name = doc.name ?? doc.title ?? doc.question ?? id;
  const title = scrub(`${SECTION_LABEL[section]}: ${name}: ${from || 'new'} -> ${to}`).slice(0, 140);
  const refs = {};
  if (REF_KEY[section]) refs[REF_KEY[section]] = id;
  if (section !== 'ws' && doc.ws) refs.ws = doc.ws;
  if (doc.threadId) refs.threadId = doc.threadId;
  return { at: now, kind: 'change', actor: 'claude', title, detail: '', refs, result: 'info', source: 'curator', section, key: id, from: from || null, to };
}

/**
 * Apply accepted ops to copies of the dumped docs. Deterministic (now and runId are passed in).
 * Order: collect's docs rows and ws stubs, the ack fold, cursor advance, the ops, collect's ws
 * facts; then stamps by comparing with the dump: a new doc gets createdAt, updatedAt and
 * statusChangedAt = now; a content change (facts and stamps aside) gets updatedAt = now; a status
 * change gets prevStatus and statusChangedAt and one chg-* feed row. Untouched docs are copied
 * forward unchanged and are not in `changes`.
 * @param {any} dump
 * @param {any[]} accepted
 * @param {{dump?: any, now?: string, prs?: any, threads?: any, wsFacts?: Record<string, any>, stubs?: any[], docsRows?: Array<{id: string, data: any}>, fetched?: any}} facts the validatePatch facts (dump, prs and threads are not used here)
 * @param {string} now ISO
 * @param {string} runId
 * @returns {{dump: any, changes: Array<{collection: string, id: string, data: any, isNew: boolean}>}}
 */
export function applyOps(dump, accepted, facts, now, runId) {
  const W = workingCopy(dump);
  for (const r of facts?.docsRows ?? []) W.docs[r.id] = { ...(W.docs[r.id] ?? {}), ...clone(r.data) };
  for (const s of facts?.stubs ?? []) if (s?.key && !W.ws[s.key]) W.ws[s.key] = clone(s);
  W.todo = foldAcks(W.todo, W.acks);
  if (facts?.fetched) W.meta.cursors = advanceCursors(W.meta.cursors, facts.fetched, now);
  for (const op of accepted) applyOne(W, op, { now, runId, wsFacts: facts?.wsFacts });
  for (const [key, f] of Object.entries(facts?.wsFacts ?? {})) if (W.ws[key]) W.ws[key].facts = clone(f);

  // Stamps and chg-* rows.
  const feed = [];
  for (const section of SECTIONS) {
    for (const id of Object.keys(W[section]).sort()) {
      const cur = W[section][id];
      const orig = dump?.[section]?.[id];
      if (!orig) {
        Object.assign(cur, { createdAt: cur.createdAt ?? now, updatedAt: cur.updatedAt ?? now, prevStatus: cur.prevStatus ?? null, statusChangedAt: cur.statusChangedAt ?? now });
        feed.push(chgRow(section, id, cur, '', cur.status, now));
        continue;
      }
      if (same(orig, cur)) continue;
      if (!same(stripStamps(orig), stripStamps(cur))) cur.updatedAt = now;
      if (orig.status !== cur.status) {
        cur.prevStatus = orig.status ?? null;
        cur.statusChangedAt = now;
        feed.push(chgRow(section, id, cur, orig.status, cur.status, now));
      }
    }
  }
  for (const row of feed) {
    const coll = feedMonth(row.at);
    const id = chgId(row.section, row.key, row.from, row.to, runId);
    W[coll] = W[coll] ?? {};
    if (!dump?.[coll]?.[id]) W[coll][id] = row;
  }

  // Everything that differs from the dump (acks are read-only here; meta: cursors and headline only).
  const changes = [];
  for (const coll of Object.keys(W).sort()) {
    if (coll === 'acks') continue;
    if (coll === 'meta') {
      for (const id of META_LAST) if (W.meta[id] !== undefined && !same(dump?.meta?.[id], W.meta[id])) changes.push({ collection: 'meta', id, data: W.meta[id], isNew: dump?.meta?.[id] === undefined });
      continue;
    }
    if (!isObj(W[coll])) continue;
    for (const id of Object.keys(W[coll]).sort()) {
      const before = dump?.[coll]?.[id];
      if (before === undefined || !same(before, W[coll][id])) changes.push({ collection: coll, id, data: W[coll][id], isNew: before === undefined });
    }
  }
  return { dump: W, changes };
}

// ---------- planWrites ----------
/**
 * ArtifactData batches for the changed docs: a pinned set (if_version from the dump) for an
 * existing doc, a set with no version for a new id. meta/cursors and meta/headline go last, in a
 * final batch of their own. Batches hold at most 50 writes and 900,000 bytes (splitBatches).
 * Throws when an existing doc has no version (never an unpinned overwrite).
 * @param {Array<{collection: string, id: string, data: any, isNew: boolean}>} changes
 * @param {Record<string, number|undefined>} versions "collection/id" -> version
 * @returns {Array<Array<{op: 'set', collection: string, doc_id: string, data: any, if_version?: number}>>}
 */
export function planWrites(changes, versions) {
  const toWrite = (c) => {
    const v = versions?.[`${c.collection}/${c.id}`];
    if (!c.isNew && !Number.isInteger(v)) throw new Error(`no version for existing doc ${c.collection}/${c.id}: refusing an unpinned overwrite`);
    const write = { op: 'set', collection: c.collection, doc_id: c.id, data: c.data, ...(Number.isInteger(v) ? { if_version: v } : {}) };
    return { write, bytes: Buffer.byteLength(JSON.stringify(write)) };
  };
  const isLast = (c) => c.collection === 'meta' && META_LAST.includes(c.id);
  const body = changes.filter((c) => !isLast(c)).map(toWrite);
  const last = META_LAST.map((id) => changes.find((c) => c.collection === 'meta' && c.id === id)).filter(Boolean).map(toWrite);
  return [...splitBatches(body), ...(last.length ? splitBatches(last) : [])].map((b) => b.map((x) => x.write));
}
