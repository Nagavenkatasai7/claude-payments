#!/usr/bin/env node
// Program Ledger v2, CURATE and CHECK steps (CLI). No network, no secrets. The curator agent
// proposes a patch; curate-core decides (validatePatch -> applyOps -> planWrites); check-core
// computes meta/health. Pure logic lives in curate-core.mjs and check-core.mjs (unit-tested).
//
// apply: validate and apply the curator's patch.
//   node scripts/tracker/curate.mjs apply --db <dump dir> --facts <collect>/facts.json --out <dir>
//        [--threads <dir>] [--sources <dir>] [--patch <patch.json>] [--project <dir>] [--now <ISO>] [--run-id <id>]
//   --db       the v2 dump: meta (headline, cursors), ws, todo, acks, decisions, issues, docs, inbox,
//              feed-<this month>, feed-<previous month>, with <db>/versions.json (ledger-io.mjs)
//   --facts    collect.mjs facts.json (threads, ws facts, stubs, docs rows, GitHub PR facts, now, runId)
//   --threads  <threadId>.json files: raw fetch_thread results (one page, or a list of pages)
//   --sources  copies of MEMORY.md, memory topic files and review files (ref = path relative to it)
//   --patch    the curator's patch.json; without it, only cursors, facts, stubs and docs rows apply
//   --project  accepted for symmetry with check (facts.json already holds the snapshot)
//   now and runId default to the ones in facts.json, so applying the same patch to the same dump
//   twice gives the same docs (the second apply over the applied result writes nothing).
//   Writes batch-N.json (pinned set for an existing doc, set without version for a new id;
//   meta/cursors and meta/headline last), accepted.json, rejected.json, summary.json and after/
//   (the changed docs as a dump overlay with predicted versions, for check and dry runs).
//   Exit 0 with or without rejections. Exit 2 when the patch is malformed (not JSON, or no ops
//   list): nothing from the curator is written; summary.json says malformed.
//
// check: ledger health and the run record.
//   node scripts/tracker/curate.mjs check --db <dump dir> --out <dir> [--facts <collect>/facts.json]
//        [--curate <apply out dir>] [--engine <sync.mjs out dir>] [--project <dir>] [--memory <dir>]
//        [--doc-count <n>] [--now <ISO>]
//   Reads the dump, overlaid with the engine's doc files and apply's after/. Writes batch-0.json
//   (meta/health and runs/<today UTC>, pinned when they exist), close-0.json (the lease-clearing
//   pinned set of meta/sync with the close fields) and summary.json {ok, codes, prevCodes,
//   changedCodes, problems, sync, runsEntry}. Exit 0.
//
// seed: the one-time seed; same flags as seed-v2.mjs (--file --sources --db --out [--project] [--deny]).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkLedger, healthDoc } from './check-core.mjs';
import { PatchError, applyOps, buildSources, normalizeThreadMessages, planWrites, validatePatch } from './curate-core.mjs';
import { arg, cleanOut, fail, readDump, readEngineDocs, readJson, walkFiles, writeBatchFiles, writeOverlay } from './ledger-io.mjs';
import { normalizeProjectPrs, normalizeThreads, toolsAvailable } from './project-core.mjs';
import { runSeed } from './seed-v2.mjs';
import { feedMonths } from './sync-core.mjs';

const V2 = ['ws', 'todo', 'acks', 'decisions', 'issues', 'docs', 'inbox'];
/** Run records kept per day (one hourly run each). */
const RUNS_PER_DAY = 24;
const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function readFacts(path) {
  if (!path) return null;
  if (!existsSync(path)) fail(`--facts ${path} does not exist`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fail(`--facts ${path} is not valid JSON`); }
}

/** The thread files of this run: raw fetch_thread results, merged per thread. */
function readThreads(dir, warnings) {
  const out = [];
  if (!dir) return out;
  if (!existsSync(dir)) { warnings.push(`--threads ${dir} does not exist (no thread read)`); return out; }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { warnings.push(`unreadable thread file ${f} (skipped)`); continue; }
    const pages = Array.isArray(raw) ? raw : [raw];
    const threadId = pages.find((p) => typeof p?.thread_id === 'string')?.thread_id ?? f.replace(/\.json$/, '');
    const seen = new Set();
    const messages = [];
    for (const p of pages) for (const m of Array.isArray(p?.messages) ? p.messages : []) if (m?.id && !seen.has(m.id)) { seen.add(m.id); messages.push(m); }
    out.push({ thread_id: threadId, messages, bytes: Buffer.byteLength(JSON.stringify(raw)) });
  }
  return out;
}

/** GitHub facts per PR (engine first), with the project list's state where the engine has none. */
function prFacts(facts) {
  const out = {};
  for (const [n, f] of Object.entries(facts?.ghPrs ?? {})) out[n] = { ...f };
  for (const p of facts?.projectPrs ?? []) {
    const cur = out[p.n] ?? { state: null, mergedAt: null, title: '' };
    out[p.n] = { ...cur, state: cur.state ?? p.state, title: cur.title || p.title };
  }
  return out;
}

// ---------- apply ----------
function apply(argv) {
  const db = arg(argv, '--db');
  const out = arg(argv, '--out');
  const facts = readFacts(arg(argv, '--facts'));
  if (!db || !out || !facts) fail('usage: curate.mjs apply --db <dump dir> --facts <facts.json> --out <dir> [--threads <dir>] [--sources <dir>] [--patch <patch.json>]');
  if (!existsSync(db)) fail(`--db ${db} does not exist`);
  const now = arg(argv, '--now') ?? facts.now;
  const runId = arg(argv, '--run-id') ?? facts.runId;
  if (Number.isNaN(Date.parse(now ?? ''))) fail('no valid now (facts.json or --now)');
  const warnings = [];
  const outDir = resolve(out);
  cleanOut(outDir, ['accepted.json', 'rejected.json', 'after']);
  const ranAt = new Date().toISOString();

  const months = feedMonths(now);
  const { docs: D, versions } = readDump([db], ['meta', ...V2, ...months], warnings);
  const dump = {};
  for (const c of V2) dump[c] = D[c];
  for (const m of months) dump[m] = D[m];
  dump.meta = {};
  for (const id of ['headline', 'cursors']) if (D.meta[id] !== undefined) dump.meta[id] = D.meta[id];

  const threads = readThreads(arg(argv, '--threads'), warnings);
  const files = {};
  for (const f of walkFiles(arg(argv, '--sources'))) files[f.rel] = readFileSync(f.abs, 'utf8');

  const malformed = (error) => {
    const summary = { runId, at: ranAt, malformed: true, error, accepted: 0, rejected: 0, new: 0, changed: 0, batches: [] };
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
    console.error(JSON.stringify({ error: `patch malformed: ${error}` }));
    process.exit(2);
  };
  let patch = { ops: [] };
  const patchPath = arg(argv, '--patch');
  if (patchPath) {
    if (!existsSync(patchPath)) malformed(`${patchPath} does not exist`);
    try { patch = JSON.parse(readFileSync(patchPath, 'utf8')); } catch (e) { malformed(`not valid JSON (${e instanceof Error ? e.message : e})`); }
  }

  // The fetched set of this run.
  const listed = Object.fromEntries((facts.threads ?? []).map((t) => [t.threadId, t]));
  const fetchedThreads = threads.map((t) => {
    const msgs = normalizeThreadMessages(t);
    const newest = msgs.reduce((m, x) => (!m || time(x.createdAt) > time(m.createdAt) ? x : m), null);
    const activity = listed[t.thread_id]?.lastActivityAt ?? null;
    const lastAt = time(activity) >= time(newest?.createdAt) ? activity : (newest?.createdAt ?? null);
    return { threadId: t.thread_id, lastMsgId: newest?.id ?? null, lastAt };
  });
  const fetched = { threads: fetchedThreads };
  if (files['MEMORY.md'] !== undefined) fetched.memory = { sha256: createHash('sha256').update(readFileSync(walkFiles(arg(argv, '--sources')).find((f) => f.rel === 'MEMORY.md').abs)).digest('hex') };
  const reviewsRead = {};
  for (const rel of Object.keys(files)) {
    const m = rel.match(/^reviews\/(.+)$/);
    if (m && facts.reviews?.[m[1]]) reviewsRead[m[1]] = facts.reviews[m[1]];
  }
  if (Object.keys(reviewsRead).length) fetched.reviews = reviewsRead;

  const prs = prFacts(facts);
  const artTitles = [...(facts.artifacts ?? []).map((a) => ({ id: a.id, title: a.title })), ...Object.entries(D.docs).map(([id, d]) => ({ id, title: d?.title ?? '' }))];
  const feedRows = months.flatMap((m) => Object.entries(D[m]).map(([id, data]) => ({ id, data })));
  const sources = buildSources({
    threads,
    files,
    prs: Object.entries(prs).map(([n, f]) => ({ n: Number(n), title: f.title ?? '' })),
    artifacts: artTitles,
    feed: feedRows,
    inbox: D.inbox,
  });
  const vfacts = {
    dump,
    now,
    ownerId: typeof facts.ownerId === 'string' && facts.ownerId ? facts.ownerId : null,
    prs,
    threads: listed,
    wsFacts: facts.wsFacts ?? {},
    stubs: facts.stubs ?? [],
    docsRows: facts.docsRows ?? [],
    fetched,
  };

  let result;
  try {
    result = validatePatch(patch, sources, vfacts);
  } catch (e) {
    if (e instanceof PatchError) malformed(e.message);
    throw e;
  }
  const { accepted, rejected } = result;
  const applied = applyOps(dump, accepted, vfacts, now, runId);
  const changes = applied.changes.filter((c) => {
    if (!/^feed-\d{4}-\d{2}$/.test(c.collection) || months.includes(c.collection)) return true;
    warnings.push(`${c.collection}/${c.id} skipped: that feed month is not dumped, so the id cannot be checked`);
    return false;
  });
  let batches;
  try {
    batches = planWrites(changes, versions);
  } catch (e) {
    fail(`${e instanceof Error ? e.message : e}; add the version to <db>/versions.json`, 1);
  }
  const sizes = writeBatchFiles(outDir, batches);
  writeOverlay(join(outDir, 'after'), changes, versions);
  writeFileSync(join(outDir, 'accepted.json'), JSON.stringify(accepted, null, 1));
  writeFileSync(join(outDir, 'rejected.json'), JSON.stringify(rejected, null, 1));
  const inputBytes = threads.reduce((s, t) => s + t.bytes, 0) + Object.values(files).reduce((s, x) => s + Buffer.byteLength(x), 0);
  const summary = {
    runId,
    at: ranAt,
    malformed: false,
    accepted: accepted.length,
    rejected: rejected.length,
    new: changes.filter((c) => c.isNew).length,
    changed: changes.filter((c) => !c.isNew).length,
    batches: sizes,
    threadsRead: threads.length,
    threads: threads.map((t) => t.thread_id),
    sourcesRead: Object.keys(files).length,
    inputBytes,
    rejectedOps: rejected.map((r) => ({ op: isObj(r.op) ? r.op.op ?? null : null, id: isObj(r.op) ? (r.op.id ?? r.op.key ?? null) : null, reason: r.reason })),
    warnings,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, out: outDir }, null, 1));
  console.log(JSON.stringify({ runId, accepted: summary.accepted, rejected: summary.rejected, new: summary.new, changed: summary.changed, batches: sizes, threadsRead: summary.threadsRead, warnings }));
}

// ---------- check ----------
function check(argv) {
  const db = arg(argv, '--db');
  const out = arg(argv, '--out');
  if (!db || !out) fail('usage: curate.mjs check --db <dump dir> --out <dir> [--facts <facts.json>] [--curate <dir>] [--engine <dir>] [--project <dir>] [--memory <dir>] [--doc-count <n>] [--now <ISO>]');
  if (!existsSync(db)) fail(`--db ${db} does not exist`);
  const facts = readFacts(arg(argv, '--facts'));
  const now = arg(argv, '--now') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) fail('--now must be an ISO time');
  const warnings = [];
  const curateDir = arg(argv, '--curate');
  const engineDir = arg(argv, '--engine');
  const curate = curateDir ? readJson(join(curateDir, 'summary.json'), null) : null;
  const engine = engineDir ? readJson(join(engineDir, 'summary.json'), null) : null;
  if (curateDir && !curate) warnings.push(`--curate ${curateDir} has no summary.json (curator counted as not run)`);

  const months = feedMonths(now);
  const today = now.slice(0, 10);
  const layers = [db, curateDir ? join(curateDir, 'after') : null].filter((d) => d && existsSync(d));
  const { docs: D } = readDump(layers, ['meta', 'ws', 'todo', 'decisions', 'runs', ...months], warnings);
  // The engine's fresh docs (meta/state, feed rows) were written after the dump was taken.
  for (const [key, data] of Object.entries(readEngineDocs(engineDir))) {
    const [c, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    if (c === 'meta' || months.includes(c)) D[c][id] = data;
  }
  const versionsDb = readDump([db], [], warnings).versions;
  const state = D.meta.state ?? null;
  const sync = D.meta.sync ?? {};
  const projectDir = arg(argv, '--project');
  const rawThreads = projectDir ? readJson(join(projectDir, 'threads.json'), { unavailable: true }) : null;
  const threads = facts?.threads ?? (rawThreads ? normalizeThreads(rawThreads) : []);
  const tools = facts?.toolsAvailable ?? (projectDir ? toolsAvailable({ threads: rawThreads, prs: readJson(join(projectDir, 'prs.json'), { unavailable: true }), artifacts: readJson(join(projectDir, 'artifacts.json'), { unavailable: true }) }) : null);
  const projectPrs = facts?.projectPrs ?? (projectDir ? normalizeProjectPrs(readJson(join(projectDir, 'prs.json'), { unavailable: true })) : []);
  const memDir = arg(argv, '--memory');
  let memoryStat = facts?.memory?.mtime ? { mtime: facts.memory.mtime } : null;
  if (!memoryStat && memDir && existsSync(join(memDir, 'MEMORY.md'))) memoryStat = { mtime: statSync(join(memDir, 'MEMORY.md')).mtime.toISOString() };

  const curatorRan = Boolean(curate && !curate.malformed);
  const feed = months.flatMap((m) => Object.entries(D[m]).map(([id, data]) => ({ id, data })));
  const prevHealth = D.meta.health ?? null;
  const prevRuns = D.runs[today] ?? null;

  // docCount: the previous count plus every new doc this run planned (an estimate between
  // seeds; --doc-count overrides it with a real count).
  const dc = arg(argv, '--doc-count');
  const isNewHealth = !versionsDb['meta/health'] && !D.meta.health;
  const isNewRuns = !prevRuns;
  const docCount = dc !== undefined ? Number(dc) : (Number(sync.docCount) || 0) + (Number(facts?.newDocs) || 0) + (curatorRan ? Number(curate.new) || 0 : 0) + (Number(engine?.newDocs) || 0) + (isNewHealth ? 1 : 0) + (isNewRuns ? 1 : 0);

  const syncNext = {
    ...sync,
    schema: 2,
    runningSince: null,
    runId: facts?.runId ?? sync.runId ?? null,
    engineAt: state?.syncedAt ?? sync.engineAt ?? null,
    collectAt: facts?.now ?? sync.collectAt ?? null,
    curatorAt: curatorRan ? curate.at : (sync.curatorAt ?? null),
    reconcileAt: curatorRan && facts?.reconcile ? curate.at : (sync.reconcileAt ?? null),
    threadsRead: curatorRan ? curate.threadsRead : 0,
    threadsCarried: facts?.carried?.length ?? 0,
    claimsAccepted: curatorRan ? curate.accepted : 0,
    claimsRejected: curatorRan ? curate.rejected : 0,
    inputsDigest: curatorRan || facts?.skip ? facts?.inputsDigest ?? sync.inputsDigest ?? null : (sync.inputsDigest ?? null),
    toolsAvailable: tools ?? sync.toolsAvailable ?? null,
    docCount,
  };
  const result = checkLedger({
    now,
    cutoverAt: sync.cutoverAt ?? null,
    state,
    headline: D.meta.headline ?? null,
    sync: syncNext,
    cursors: D.meta.cursors ?? null,
    ws: D.ws,
    todo: D.todo,
    decisions: D.decisions,
    feed,
    threads,
    memoryStat,
    tools,
    curator: curatorRan ? { accepted: curate.accepted, rejected: curate.rejected } : null,
    prTitles: Object.fromEntries(projectPrs.map((p) => [p.n, p.title])),
    docCount,
  });
  const merges = feed.filter((r) => /^gh-merge-\d+$/.test(r.id) || r.data?.kind === 'merge').map((r) => r.data?.at).filter(Boolean).sort();
  const activity = threads.filter((t) => t.threadId !== sync.routineThreadId).map((t) => t.lastActivityAt).filter(Boolean).sort();
  const health = healthDoc({
    result,
    prev: prevHealth,
    now,
    inputs: { newestMergeAt: merges.at(-1) ?? null, threadsMaxActivityAt: activity.at(-1) ?? null, memoryMtime: memoryStat?.mtime ?? null, engineSyncedAt: state?.syncedAt ?? null, docCount },
  });

  const runsEntry = {
    runId: syncNext.runId,
    startedAt: sync.runningSince ?? facts?.now ?? null,
    endedAt: now,
    engine: engine ? { newDocs: engine.newDocs ?? 0, warnings: engine.warnings ?? [] } : null,
    curator: curate
      ? { threads: curate.threads ?? [], accepted: curate.accepted ?? 0, rejected: curate.rejectedOps ?? [], ...(curate.malformed ? { note: 'patch malformed' } : {}) }
      : { threads: [], accepted: 0, rejected: [], ...(facts?.skip ? { note: 'skipped: inputs unchanged' } : {}) },
    check: { ok: result.ok, codes: health.codes },
    tokensEstimate: curate ? Math.round((Number(curate.inputBytes) || 0) / 4) : 0,
  };
  const runs = { runs: [...(prevRuns?.runs ?? []).filter((r) => r?.runId !== runsEntry.runId), runsEntry].slice(-RUNS_PER_DAY) };

  const outDir = resolve(out);
  cleanOut(outDir, ['close-0.json']);
  const pinned = (collection, id) => (Number.isInteger(versionsDb[`${collection}/${id}`]) ? { if_version: versionsDb[`${collection}/${id}`] } : {});
  for (const [c, id, exists] of [['meta', 'health', Boolean(D.meta.health)], ['runs', today, Boolean(prevRuns)], ['meta', 'sync', Boolean(D.meta.sync)]]) {
    if (exists && !pinned(c, id).if_version) fail(`${c}/${id} exists but <db>/versions.json has no version for it (never an unpinned write)`, 1);
  }
  const sizes = writeBatchFiles(outDir, [[
    { op: 'set', collection: 'meta', doc_id: 'health', data: health.doc, ...pinned('meta', 'health') },
    { op: 'set', collection: 'runs', doc_id: today, data: runs, ...pinned('runs', today) },
  ]]);
  writeBatchFiles(outDir, [[{ op: 'set', collection: 'meta', doc_id: 'sync', data: syncNext, ...pinned('meta', 'sync') }]], 'close');
  const summary = {
    ok: result.ok,
    codes: health.codes,
    prevCodes: health.doc.prevCodes,
    changedCodes: health.changed,
    problems: result.problems,
    sync: syncNext,
    runsEntry,
    batches: sizes,
    warnings,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, out: outDir }, null, 1));
  console.log(JSON.stringify({ ok: result.ok, codes: health.codes, changedCodes: health.changed, problems: result.problems.length, docCount, batches: sizes, close: 'close-0.json', warnings }));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'apply') apply(rest);
else if (cmd === 'check') check(rest);
else if (cmd === 'seed') process.exit(runSeed(rest));
else fail('usage: curate.mjs <apply|check|seed> ... (see the header of scripts/tracker/curate.mjs)');
