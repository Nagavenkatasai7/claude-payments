#!/usr/bin/env node
// Program Ledger v2: the ONE-TIME seed (CLI + the pure planSeed it runs). Turns a seed JSON file
// (format in scripts/tracker/LEDGER-SCHEMA.md, "Seed file") into ArtifactData batches:
//   - ws, todo, decisions, issues, docs, meta/headline: built through the curator patch format,
//     checked by curate-core.validatePatch (schema, scrub, verbatim quotes) and applied by applyOps;
//   - feed-YYYY-MM: one cur-* row per seeded event, plus a backfill of the legacy gh-* and
//     non-agent j-* events from backfillFrom, with their ids unchanged;
//   - meta/archive, meta/cursors (thread cursors at asOf - 24 h) and meta/sync (alone, last);
//   - pinned `update` archive markers {archivedAt, archiveNote} on meta/program, every backlog doc
//     and the plans in ARCHIVE_PLANS.
// Every other write is a `set` of a NEW id; an id that exists in the dump refuses the whole seed.
// The seed data is private (the repo is public): it is never committed.
//
//   node scripts/tracker/seed-v2.mjs --file <seed.json> --sources <dir> --db <dump dir> --out <dir>
//        [--project <hearthbot snapshot dir>] [--deny <names file>]
//   (node scripts/tracker/curate.mjs seed takes the same flags)
//
//   --sources  copies of the quote sources: MEMORY.md and memory topic files (evidence kind mem or
//              file, ref = the path relative to this dir), review files (e.g. reviews/x.md)
//   --db       a dump of the live ledger (every collection, with versions.json; see ledger-io.mjs)
//   --project  threads.json, prs.json, artifacts.json (thread ids in the seed must be listed here)
//   --deny     a file of names (one per line, # comments) that must not appear anywhere in the seed
//
// Exit 0: batch-N.json files (send in order) and summary.json; prints one JSON line with the
// expected doc counts per collection. Exit 2: refused (errors and rejected ops printed), no batch.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_KINDS, applyOps, buildSources, quoteGrounded, validatePatch } from './curate-core.mjs';
import { cleanOut, listDumpIds, readDump, readJson, walkFiles, writeBatchFiles } from './ledger-io.mjs';
import { normalizeArtifacts, normalizeProjectPrs, normalizeThreads, toolsAvailable } from './project-core.mjs';
import { feedDocs, scrub, splitBatches } from './sync-core.mjs';

export const SEED_FORMAT = 'ledger-seed/1';
/** The plans whose docs are wrong for v2 and get an archive marker (spec: migration step 4). */
export const ARCHIVE_PLANS = Object.freeze(['ui-redesign', 'ui-m5-customer', 'p3', 'p4']);
const DAY = 24 * 3_600_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const THREAD_RE = /^cmsg_[A-Za-z0-9]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** The legacy collections read from the dump (besides the existence check over every id). */
const DUMP_COLLS = ['prs', 'prstate', 'events', 'backlog', 'plans', 'meta'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isIso = (s) => typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };

/** Every string inside a value, with its path (a[0].b). */
function strings(x, path = '') {
  if (typeof x === 'string') return [[path, x]];
  if (Array.isArray(x)) return x.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (isObj(x)) return Object.entries(x).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

/**
 * Strings that scrub() would change (phone, email, token, long number), with their paths.
 * @param {unknown} value
 * @returns {Array<{path: string, before: string, after: string}>}
 */
export function scrubHits(value) {
  return strings(value).filter(([, s]) => scrub(s) !== s).map(([path, s]) => ({ path, before: s, after: scrub(s) }));
}

/**
 * Names from a deny list that appear in any string of `value` (whole words, case-insensitive).
 * The list is passed at runtime (--deny <file>); it is never committed.
 * @param {unknown} value
 * @param {string[]} names
 * @returns {Array<{path: string, name: string}>}
 */
export function denyListHits(value, names) {
  const res = (names ?? []).map((n) => String(n).trim()).filter(Boolean).map((n) => [n, new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu')]);
  const hits = [];
  for (const [path, s] of strings(value)) for (const [name, re] of res) if (re.test(s)) hits.push({ path, name });
  return hits;
}

// ---------- seed -> patch ----------
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
// Fields of each seed item that are op fields (the rest, such as status, doneAt, answer and
// askedAt, are applied after validation because the curator may not set them directly).
const WS_OP = ['key', 'name', 'status', 'summary', 'nextStep', 'waitingOn', 'testGuide', 'startedAt', 'prs'];
const TODO_OP = ['id', 'ws', 'title', 'why', 'steps', 'where', 'priority', 'threadId'];
const DEC_OP = ['id', 'question', 'options', 'recommended', 'threadId', 'ws', 'refs'];
const ISSUE_OP = ['id', 'title', 'detail', 'kind', 'severity', 'ws'];
const EVENT_OP = ['kind', 'title', 'detail', 'at', 'key', 'threadId', 'refs'];

/**
 * The seed as a curator patch: setHeadline, upsertWs (first, so the ws exist), createTodo,
 * openDecision, openIssue (+ resolveIssue for a resolved or wontfix one), addEvent.
 * @param {any} seed
 * @returns {{ops: any[]}}
 */
export function seedToPatch(seed) {
  const ops = [];
  if (seed?.headline) ops.push({ op: 'setHeadline', ...pick(seed.headline, ['text', 'short']), evidence: seed.headline.evidence ?? [] });
  for (const w of seed?.workstreams ?? []) ops.push({ op: 'upsertWs', ...pick(w, WS_OP), evidence: w.evidence ?? [] });
  for (const t of seed?.todos ?? []) ops.push({ op: 'createTodo', ...pick(t, TODO_OP), evidence: t.evidence ?? [] });
  for (const d of seed?.decisions ?? []) ops.push({ op: 'openDecision', ...pick(d, DEC_OP), evidence: d.evidence ?? [] });
  for (const i of seed?.issues ?? []) {
    ops.push({ op: 'openIssue', ...pick(i, ISSUE_OP), evidence: i.evidence ?? [] });
    if (i.status === 'resolved' || i.status === 'wontfix') ops.push({ op: 'resolveIssue', id: i.id, status: i.status, resolution: i.resolution, evidence: i.resolutionEvidence ?? i.evidence ?? [] });
  }
  for (const e of seed?.events ?? []) ops.push({ op: 'addEvent', ...pick(e, EVENT_OP), evidence: e.evidence ?? [] });
  return { ops };
}

/** Shape errors of the seed file itself (the op fields are checked by validatePatch). */
function seedErrors(seed) {
  const errs = [];
  if (!isObj(seed)) return ['the seed is not a JSON object'];
  if (seed.format !== SEED_FORMAT) errs.push(`format must be ${SEED_FORMAT}`);
  for (const k of ['asOf', 'cutoverAt', 'backfillFrom']) if (!isIso(seed[k])) errs.push(`${k} must be an ISO time`);
  if (!THREAD_RE.test(seed.routineThreadId ?? '')) errs.push('routineThreadId must be a cmsg_ thread id');
  if (seed.ownerId !== undefined && seed.ownerId !== null && !/^user_[A-Za-z0-9]+$/.test(String(seed.ownerId))) errs.push('ownerId must be a user_ account id (or null)');
  if (typeof seed.archiveNote !== 'string' || !seed.archiveNote.trim() || seed.archiveNote.length > 200) errs.push('archiveNote must be 1-200 characters');
  if (!isObj(seed.archive)) errs.push('archive must be an object');
  if (!isObj(seed.headline)) errs.push('headline is required');
  for (const k of ['workstreams', 'todos', 'decisions', 'issues', 'docs', 'events']) if (seed[k] !== undefined && !Array.isArray(seed[k])) errs.push(`${k} must be a list`);
  for (const [tid, ws] of Object.entries(seed.threadMap ?? {})) if (!THREAD_RE.test(tid) || !SLUG_RE.test(String(ws))) errs.push(`threadMap ${tid} -> ${ws} is not a thread id -> ws key`);
  const ids = (k) => (seed[k] ?? []).map((x) => x?.id);
  for (const k of ['todos', 'decisions', 'issues']) {
    (seed[k] ?? []).forEach((x, i) => { if (!SLUG_RE.test(x?.id ?? '')) errs.push(`${k}[${i}].id must be a slug (the seed names its ids)`); });
    const seen = new Set();
    for (const id of ids(k)) { if (seen.has(id)) errs.push(`${k}: duplicate id ${id}`); seen.add(id); }
  }
  (seed.todos ?? []).forEach((t, i) => {
    if (t.status !== undefined && !['open', 'done', 'dropped'].includes(t.status)) errs.push(`todos[${i}].status must be open|done|dropped`);
    if ((t.status === 'done' || t.status === 'dropped') && t.doneAt !== undefined && !isIso(t.doneAt)) errs.push(`todos[${i}].doneAt must be an ISO time`);
    if (t.status === 'done' && !(t.doneEvidence ?? []).length) errs.push(`todos[${i}] is done: doneEvidence is required`);
  });
  (seed.decisions ?? []).forEach((d, i) => {
    if (!isIso(d.askedAt)) errs.push(`decisions[${i}].askedAt must be an ISO time (the real time it was asked)`);
    if (d.status !== undefined && !['open', 'decided', 'withdrawn'].includes(d.status)) errs.push(`decisions[${i}].status must be open|decided|withdrawn`);
    if (d.status === 'decided') {
      if (typeof d.answer !== 'string' || !d.answer.trim() || d.answer.length > 200) errs.push(`decisions[${i}].answer must be 1-200 characters`);
      if (!isIso(d.decidedAt) || time(d.decidedAt) < time(d.askedAt)) errs.push(`decisions[${i}].decidedAt must be an ISO time not before askedAt`);
      if (!(d.answerEvidence ?? []).length) errs.push(`decisions[${i}] is decided: answerEvidence is required`);
    }
  });
  (seed.issues ?? []).forEach((x, i) => {
    if (x.status !== undefined && !['open', 'resolved', 'wontfix'].includes(x.status)) errs.push(`issues[${i}].status must be open|resolved|wontfix`);
  });
  (seed.docs ?? []).forEach((d, i) => {
    if (!ID_RE.test(d?.id ?? '') || d.id.length > 100) errs.push(`docs[${i}].id must be an id`);
    if (typeof d?.title !== 'string' || !d.title.trim() || d.title.length > 140) errs.push(`docs[${i}].title must be 1-140 characters`);
    if (!/^https:\/\/\S+$/.test(d?.url ?? '')) errs.push(`docs[${i}].url must be an https URL`);
    if (!['plan', 'guide', 'review', 'checklist', 'other'].includes(d?.kind)) errs.push(`docs[${i}].kind must be plan|guide|review|checklist|other`);
    if (!['current', 'accepted', 'superseded'].includes(d?.status)) errs.push(`docs[${i}].status must be current|accepted|superseded`);
    if (d?.ws !== null && d?.ws !== undefined && !(seed.workstreams ?? []).some((w) => w.key === d.ws)) errs.push(`docs[${i}].ws ${d.ws} is not a seeded workstream`);
  });
  for (const [i, w] of (seed.workstreams ?? []).entries()) for (const n of w?.prs ?? []) if (!Number.isInteger(n)) errs.push(`workstreams[${i}].prs must be PR numbers`);
  return errs;
}

// ---------- inputs ----------
/** GitHub facts per PR from the engine collections: the latest prstate wins, prs gives the title. */
function prFacts(dump, projectPrs) {
  const out = {};
  for (const p of Object.values(dump.docs.prs ?? {})) if (Number.isInteger(p?.number)) out[p.number] = { state: null, mergedAt: null, title: p.title ?? '' };
  const rank = { open: 0, closed: 1, merged: 2 };
  const best = {};
  for (const s of Object.values(dump.docs.prstate ?? {})) {
    if (!Number.isInteger(s?.number)) continue;
    const r = rank[s.state] ?? -1;
    if (best[s.number] === undefined || r > best[s.number]) {
      best[s.number] = r;
      out[s.number] = { ...(out[s.number] ?? {}), state: s.state, mergedAt: s.state === 'merged' ? (s.at ?? null) : null, title: s.title || out[s.number]?.title || '' };
    }
  }
  for (const p of projectPrs) {
    const cur = out[p.n] ?? { state: null, mergedAt: null, title: '' };
    out[p.n] = { ...cur, state: cur.state ?? p.state, title: p.title || cur.title };
  }
  return out;
}

/**
 * Read every input of the seed from disk. I/O only.
 * @param {{file: string, sources: string, db: string, project?: string, deny?: string}} paths
 */
export function loadSeedInputs({ file, sources, db, project, deny }) {
  /** @type {string[]} */
  const warnings = [];
  const seed = JSON.parse(readFileSync(file, 'utf8'));
  /** @type {Record<string, string>} */
  const files = {};
  for (const f of walkFiles(sources)) files[f.rel] = readFileSync(f.abs, 'utf8');
  const dump = readDump([db], DUMP_COLLS, warnings);
  dump.ids = listDumpIds(resolve(db));
  const proj = project
    ? {
        threads: readJson(join(project, 'threads.json'), { unavailable: true }),
        prs: readJson(join(project, 'prs.json'), { unavailable: true }),
        artifacts: readJson(join(project, 'artifacts.json'), { unavailable: true }),
      }
    : null;
  const denyNames = deny ? readFileSync(deny, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
  return { seed, files, dump, project: proj, denyNames, warnings };
}

/**
 * The fetched set the seed's quotes are checked against: the source files (mem and file), PR
 * titles (engine prs/prstate and the project list), Artifact titles (project list and the seeded
 * docs), and db docs as feed sources (legacy events by id, backlog docs as backlog/<id>).
 */
export function seedSources({ files, dump, project, seed }) {
  const projectPrs = project ? normalizeProjectPrs(project.prs) : [];
  const facts = prFacts(dump, projectPrs);
  const prs = Object.entries(facts).map(([n, f]) => ({ n: Number(n), title: f.title }));
  const artifacts = [...(project ? normalizeArtifacts(project.artifacts) : []).map((a) => ({ id: a.id, title: a.title })), ...(seed?.docs ?? []).map((d) => ({ id: d.id, title: d.title }))];
  const feed = [
    ...Object.entries(dump.docs.events ?? {}).map(([id, data]) => ({ id, data })),
    ...Object.entries(dump.docs.backlog ?? {}).map(([id, data]) => ({ id: `backlog/${id}`, data: { title: data?.title ?? '', detail: data?.detail ?? '', kind: null } })),
  ];
  return buildSources({ files, prs, artifacts, feed });
}

// ---------- planSeed ----------
const groundAll = (evidence, sources, path, errors) => {
  if (!Array.isArray(evidence) || !evidence.length) { errors.push(`${path} needs at least one evidence item`); return; }
  evidence.forEach((e, i) => {
    if (!EVIDENCE_KINDS.includes(e?.kind)) errors.push(`${path}[${i}]: unknown evidence kind`);
    const g = quoteGrounded(e, sources);
    if (g) errors.push(`${path}[${i}]: ${g}`);
  });
};

/**
 * Plan the seed. Pure (inputs come from loadSeedInputs).
 * @param {{seed: any, files: Record<string, string>, dump: {docs: Record<string, Record<string, any>>, versions: Record<string, number>, ids: Set<string>}, project?: any, denyNames?: string[], warnings?: string[]}} inputs
 * @returns {{ok: boolean, errors: string[], rejected: any[], warnings: string[], docs: Array<{collection: string, id: string, data: any}>, batches: any[][], counts: Record<string, number>, docCount: number}}
 */
export function planSeed(inputs) {
  const { seed, files = {}, dump, project = null, denyNames = [] } = inputs;
  const warnings = [...(inputs.warnings ?? [])];
  const refuse = (errors, rejected = []) => ({ ok: false, errors, rejected, warnings, docs: [], batches: [], counts: {}, docCount: 0 });

  const errors = seedErrors(seed);
  for (const h of scrubHits(seed)) errors.push(`scrub() would change ${h.path} (phone, email, token or long number)`);
  for (const h of denyListHits(seed, denyNames)) errors.push(`${h.path} contains a name from the deny list`);
  if (errors.length) return refuse(errors);

  const asOf = seed.asOf;
  const threads = project ? normalizeThreads(project.threads) : [];
  const projectPrs = project ? normalizeProjectPrs(project.prs) : [];
  const ghPrs = prFacts(dump, projectPrs);
  const sources = seedSources({ files, dump, project, seed });
  const threadById = Object.fromEntries(threads.map((t) => [t.threadId, t]));

  // 1. The curator gate: schema, scrub, verbatim quotes, engine contradictions.
  const patch = seedToPatch(seed);
  const { accepted, rejected } = validatePatch(patch, sources, { dump: {}, now: asOf, prs: ghPrs, threads: threadById });
  // Evidence the gate does not see: closing and answering evidence.
  (seed.todos ?? []).forEach((t, i) => { if (t.status === 'done' || t.status === 'dropped') { if (t.doneEvidence?.length || t.status === 'done') groundAll(t.doneEvidence, sources, `todos[${i}].doneEvidence`, errors); } });
  (seed.decisions ?? []).forEach((d, i) => { if (d.status === 'decided' || d.answerEvidence?.length) groundAll(d.answerEvidence, sources, `decisions[${i}].answerEvidence`, errors); });
  for (const [tid, key] of Object.entries(seed.threadMap ?? {})) {
    if (project && !threadById[tid]) errors.push(`threadMap: thread ${tid} is not in the project thread list`);
    if (!(seed.workstreams ?? []).some((w) => w.key === key)) errors.push(`threadMap: ws ${key} is not a seeded workstream`);
  }
  if (rejected.length || errors.length) return refuse(errors, rejected);

  // 2. Apply as the curator would (stamps = asOf), then the seed's own statuses and real times.
  const { dump: W } = applyOps({}, accepted, { wsFacts: {} }, asOf, 'seed');
  for (const w of seed.workstreams ?? []) {
    const doc = W.ws[w.key];
    doc.facts = {
      threadIds: Object.entries(seed.threadMap ?? {}).filter(([, k]) => k === w.key).map(([t]) => t).sort(),
      bucket: null,
      resolved: false,
      lastActivityAt: null,
      prs: (w.prs ?? []).map((n) => ({ n, state: ghPrs[n]?.state ?? null, title: ghPrs[n]?.title ?? '', mergedAt: ghPrs[n]?.mergedAt ?? null })),
      artifacts: (seed.docs ?? []).filter((d) => d.ws === w.key).map((d) => ({ id: d.id, url: d.url, title: d.title })),
    };
    if (w.inferred) doc.inferred = true;
  }
  for (const t of seed.todos ?? []) {
    const doc = W.todo[t.id];
    if (t.inferred) doc.inferred = true;
    if (t.status === 'done' || t.status === 'dropped') {
      const at = t.doneAt ?? asOf;
      Object.assign(doc, { status: t.status, doneAt: at, doneEvidence: structuredClone(t.doneEvidence ?? []), prevStatus: 'open', statusChangedAt: at });
    }
  }
  for (const d of seed.decisions ?? []) {
    const doc = W.decisions[d.id];
    doc.askedAt = d.askedAt;
    if (d.status === 'decided' || d.status === 'withdrawn') {
      const at = d.decidedAt ?? asOf;
      Object.assign(doc, { status: d.status, answer: d.answer ?? null, decidedAt: d.status === 'decided' ? at : null, answerEvidence: structuredClone(d.answerEvidence ?? []), prevStatus: 'open', statusChangedAt: at });
    }
  }
  for (const i of seed.issues ?? []) if (i.inferred) W.issues[i.id].inferred = true;

  /** @type {Array<{collection: string, id: string, data: any}>} */
  const docs = [];
  for (const c of ['ws', 'todo', 'decisions', 'issues']) for (const id of Object.keys(W[c] ?? {}).sort()) docs.push({ collection: c, id, data: W[c][id] });
  for (const d of seed.docs ?? []) docs.push({ collection: 'docs', id: d.id, data: { title: d.title, url: d.url, kind: d.kind, status: d.status, ws: d.ws ?? null, updatedAt: d.updatedAt ?? null, firstSeenAt: asOf } });

  // 3. Feed: cur-* rows from the events (no chg-* rows for the seed), then the legacy backfill.
  const feed = [];
  for (const coll of Object.keys(W).filter((c) => c.startsWith('feed-')).sort()) {
    for (const id of Object.keys(W[coll]).sort()) if (!id.startsWith('chg-')) feed.push({ collection: coll, id, data: W[coll][id] });
  }
  const legacy = Object.entries(dump.docs.events ?? {})
    .filter(([id, d]) => /^(gh-|j-)/.test(id) && d?.kind !== 'agent' && time(d?.at) >= time(seed.backfillFrom))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, data]) => ({ id, collection: 'events', data }));
  const back = feedDocs(legacy, { now: asOf, cutoverAt: seed.backfillFrom });
  warnings.push(...back.warnings);
  for (const d of back.docs) {
    const { key: _key, ...data } = d.data;
    feed.push({ collection: d.collection, id: d.id, data });
  }
  docs.push(...feed);

  // 4. meta docs.
  const memoryText = files['MEMORY.md'];
  const cursors = { threads: {}, memory: memoryText === undefined ? null : { sha256: createHash('sha256').update(memoryText).digest('hex'), readAt: asOf }, reviews: {} };
  const lastAt = new Date(time(asOf) - DAY).toISOString();
  const threadIds = new Set([...threads.map((t) => t.threadId), ...Object.keys(seed.threadMap ?? {})]);
  for (const tid of [...threadIds].sort()) {
    const ws = seed.threadMap?.[tid];
    cursors.threads[tid] = { ...(ws ? { ws } : {}), lastMsgId: null, lastAt, readAt: asOf };
  }
  docs.push({ collection: 'meta', id: 'headline', data: W.meta.headline });
  docs.push({ collection: 'meta', id: 'archive', data: { ...seed.archive, archivedAt: asOf } });
  docs.push({ collection: 'meta', id: 'cursors', data: cursors });

  // 5. Archive markers (pinned updates of existing docs).
  const markerData = { archivedAt: asOf, archiveNote: seed.archiveNote };
  const targets = ['meta/program', ...Object.keys(dump.docs.backlog ?? {}).sort().map((id) => `backlog/${id}`), ...ARCHIVE_PLANS.map((p) => `plans/${p}`)];
  const markers = [];
  for (const t of targets) {
    if (!dump.ids.has(t)) { warnings.push(`archive marker skipped: ${t} is not in the dump`); continue; }
    const v = dump.versions[t];
    if (!Number.isInteger(v)) { errors.push(`archive marker for ${t} needs its version in versions.json (never an unpinned write)`); continue; }
    const [collection, doc_id] = t.split('/');
    markers.push({ op: 'update', collection, doc_id, data: markerData, if_version: v });
  }

  // 6. Refuse ids that exist; count; meta/sync alone in the last batch.
  const syncDoc = {
    schema: 2,
    routineThreadId: seed.routineThreadId,
    // The owner's account id: decide and closeTodo accept only this human's messages (null = any human).
    ownerId: seed.ownerId ?? null,
    cutoverAt: seed.cutoverAt,
    seededAt: asOf,
    runId: null,
    runningSince: null,
    engineAt: null,
    collectAt: null,
    curatorAt: null,
    reconcileAt: null,
    threadsRead: 0,
    threadsCarried: 0,
    claimsAccepted: 0,
    claimsRejected: 0,
    inputsDigest: null,
    toolsAvailable: project ? toolsAvailable(project) : null,
    docCount: 0,
  };
  const all = [...docs, { collection: 'meta', id: 'sync', data: syncDoc }];
  for (const d of all) if (dump.ids.has(`${d.collection}/${d.id}`)) errors.push(`${d.collection}/${d.id} already exists in the dump: the seed only creates new ids`);
  const seen = new Set();
  for (const d of all) { const k = `${d.collection}/${d.id}`; if (seen.has(k)) errors.push(`${k} is produced twice`); seen.add(k); }
  if (errors.length) return refuse(errors);
  const docCount = dump.ids.size + all.length;
  syncDoc.docCount = docCount;

  const sized = (w) => ({ write: w, bytes: Buffer.byteLength(JSON.stringify(w)) + 200 });
  const body = docs.map((d) => sized({ op: 'set', collection: d.collection, doc_id: d.id, data: d.data }));
  const batches = [
    ...splitBatches(body),
    ...(markers.length ? splitBatches(markers.map(sized)) : []),
    [sized({ op: 'set', collection: 'meta', doc_id: 'sync', data: syncDoc })],
  ].map((b) => b.map((x) => x.write));
  const counts = {};
  for (const d of all) counts[d.collection] = (counts[d.collection] ?? 0) + 1;
  return { ok: true, errors: [], rejected: [], warnings, docs: all, batches, counts, docCount };
}

// ---------- CLI ----------
/**
 * The CLI (also `curate.mjs seed`). Returns the exit code.
 * @param {string[]} argv
 */
export function runSeed(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const [file, sources, db, out] = ['--file', '--sources', '--db', '--out'].map(get);
  if (!file || !sources || !db || !out) {
    console.error(JSON.stringify({ error: 'usage: seed-v2.mjs --file <seed.json> --sources <dir> --db <dump dir> --out <dir> [--project <dir>] [--deny <file>]' }));
    return 2;
  }
  for (const [flag, p] of [['--file', file], ['--sources', sources], ['--db', db], ['--project', get('--project')], ['--deny', get('--deny')]]) {
    if (p && !existsSync(p)) { console.error(JSON.stringify({ error: `${flag} ${p} does not exist` })); return 2; }
  }
  let inputs;
  try {
    inputs = loadSeedInputs({ file, sources, db, project: get('--project'), deny: get('--deny') });
  } catch (e) {
    console.error(JSON.stringify({ error: `cannot read the seed inputs: ${e instanceof Error ? e.message : e}` }));
    return 2;
  }
  const plan = planSeed(inputs);
  const outDir = resolve(out);
  cleanOut(outDir, ['rejected.json']);
  if (!plan.ok) {
    writeFileSync(join(outDir, 'rejected.json'), JSON.stringify({ errors: plan.errors, rejected: plan.rejected }, null, 1));
    console.error(JSON.stringify({ ok: false, errors: plan.errors, rejected: plan.rejected.map((r) => ({ op: r.op?.op, id: r.op?.id ?? r.op?.key, reason: r.reason })) }));
    return 2;
  }
  const sizes = writeBatchFiles(outDir, plan.batches);
  const summary = { ok: true, counts: plan.counts, docCount: plan.docCount, batches: sizes, markers: plan.batches.flat().filter((w) => w.op === 'update').length, warnings: plan.warnings };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, out: outDir }, null, 1));
  console.log(JSON.stringify(summary));
  return 0;
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exit(runSeed(process.argv.slice(2)));
