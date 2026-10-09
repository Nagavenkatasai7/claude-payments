#!/usr/bin/env node
// Program Ledger auto-sync engine (CLI). Reads GitHub (read-only, via curl; github.mjs) and a dump
// of the ledger database, and writes the ArtifactData batches that bring the ledger up to date.
// Append-only: every write is a `set` of a NEW doc with a deterministic id, except meta/state,
// which is pinned with --state-version. Pure logic lives in sync-core.mjs (unit-tested).
//
//   node scripts/tracker/sync.mjs --db <dump dir> --state-version <n> --by <cloud|session> --out <dir>
//        [--project <dir>] [--journal <file>] [--journal-from <byteOffset>] [--lease check]
//   node scripts/tracker/sync.mjs --db <dump dir> --lease check
//
//   --db             ArtifactData list/get output (out_dir): <db>/<collection>/<id>.json for
//                    prs, prstate, fixstate, releases, feed-<this month>, feed-<previous month>
//                    (and fixes when present), plus meta/state.json and, when present, meta/sync.json
//                    (its cutoverAt limits the feed rows; its runningSince is the lease)
//   --state-version  meta/state's current version (0 = the doc does not exist yet)
//   --by             cloud → syncedBy "cloud routine"; session → "session"
//   --out            gets batch-N.json (ArtifactData batch `writes`), the doc files and summary.json;
//                    stale batch/doc files from an earlier run are removed first
//   --project        a hearthbot snapshot dir; its prs.json (list_project_prs) sets
//                    meta/state.programPrsFromThreads (null without it)
//   --journal        journal.ndjson (the owner's Mac); its rows become feed-YYYY-MM/j-* rows, agent
//                    rows dropped; --journal-from defaults to the `flushed` marker beside it
//   --lease check    refuse (exit 3, {"skipped":"run in progress"}) when meta/sync.runningSince in
//                    the dump is less than 20 min old. Alone with --db it only prints the lease
//                    status ({"lease":"free"}, exit 0); with the other flags the sync runs after it.
//
// Feed rows are planned only for `at` on or after the first day of the previous UTC month and on
// or after cutoverAt: older months are not dumped, so their ids could not be checked. Without
// meta/sync.cutoverAt (before the v2 seed) no feed row is planned and newOffset stays put.
//
// Prints one JSON line: {mainSha, ci, smoke, prodServes, newDocs, batches, warnings, newOffset}.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fetchGitHub } from './github.mjs';
import { batchWrites, feedMonths, leaseStatus, planSync, sliceJournal } from './sync-core.mjs';

const USAGE = 'usage: sync.mjs --db <dump dir> --state-version <n> --by <cloud|session> --out <dir> [--project <dir>] [--journal <file>] [--journal-from <byteOffset>] [--lease check]';
/** The collections the engine reads from the dump (events is no longer dumped: ledger v2). */
const collectionsFor = (now) => ['prs', 'prstate', 'fixstate', 'releases', ...feedMonths(now), 'fixes'];

function fail(msg, code = 2) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// ---------- ledger dump ----------
// ArtifactData saves each doc's data only; tolerate a {data, version} wrapper just in case.
const unwrap = (d) => (d && typeof d === 'object' && d.data && typeof d.data === 'object' && 'version' in d ? d.data : d);

function readMeta(db, id, warnings) {
  const path = join(db, 'meta', `${id}.json`);
  if (!existsSync(path)) return undefined;
  try { return unwrap(JSON.parse(readFileSync(path, 'utf8'))); } catch { warnings.push(`unreadable meta/${id}.json`); return null; }
}

function readDump(db, now, warnings) {
  if (!existsSync(db)) fail(`--db ${db} does not exist`);
  const dump = { ids: new Set(), fixstate: [], fixes: [], events: [], prevState: null, cutoverAt: null };
  for (const c of collectionsFor(now)) {
    const dir = join(db, c);
    if (!existsSync(dir)) { warnings.push(`dump has no ${c}/ (treated as empty)`); continue; }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const id = basename(f, '.json');
      let data;
      try { data = unwrap(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { warnings.push(`unreadable dump file ${c}/${f} (id still counted as existing)`); }
      dump.ids.add(`${c}/${id}`);
      if (c === 'fixstate' && data) dump.fixstate.push(data);
      if (c === 'fixes' && data) dump.fixes.push(data);
    }
  }
  const prevState = readMeta(db, 'state', warnings);
  if (prevState === undefined) warnings.push('dump has no meta/state.json: keys outside the engine\'s set will not be kept');
  else dump.prevState = prevState;
  const sync = readMeta(db, 'sync', warnings);
  if (typeof sync?.cutoverAt === 'string') {
    if (Number.isNaN(Date.parse(sync.cutoverAt))) warnings.push('meta/sync.cutoverAt is not a date (ignored)');
    else dump.cutoverAt = sync.cutoverAt;
  }
  return dump;
}

function readProject(dir, warnings) {
  if (!dir) return null;
  const path = join(resolve(dir), 'prs.json');
  if (!existsSync(path)) { warnings.push(`--project ${dir} has no prs.json (programPrsFromThreads stays null)`); return null; }
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { warnings.push(`unreadable ${path} (programPrsFromThreads stays null)`); return null; }
}

// ---------- lease ----------
// Exits 3 when the lease is held; returns when it is free.
function checkLease(db, now) {
  const dbDir = resolve(db);
  if (!existsSync(dbDir)) fail(`--db ${db} does not exist`);
  const status = leaseStatus(readMeta(dbDir, 'sync', []) ?? null, now);
  if (status.held) {
    console.log(JSON.stringify({ skipped: 'run in progress', runningSince: status.runningSince }));
    process.exit(3);
  }
  return status;
}

// ---------- journal ----------
function readJournal(file, fromArg, warnings) {
  if (!file) return { lines: [], newOffset: null, from: null };
  let from = fromArg === undefined ? undefined : Number(fromArg);
  if (from === undefined) {
    try { from = Number(readFileSync(join(dirname(file), 'flushed'), 'utf8').trim()) || 0; } catch { from = 0; }
  }
  if (!Number.isInteger(from) || from < 0) fail('--journal-from must be a non-negative integer');
  if (!existsSync(file)) { warnings.push(`journal ${file} not found (nothing to flush)`); return { lines: [], newOffset: from, from }; }
  const slice = sliceJournal(readFileSync(file), from);
  warnings.push(...slice.warnings);
  return { lines: slice.lines, newOffset: slice.newOffset, from };
}

// ---------- output ----------
function cleanOut(out) {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) {
    if (/^batch-\d+\.json$/.test(f) || /^[a-z0-9-]+__.+\.json$/.test(f) || f === 'summary.json') rmSync(join(out, f));
  }
}

function main() {
  const db = arg('--db');
  const out = arg('--out');
  const by = arg('--by');
  const sv = arg('--state-version');
  const lease = arg('--lease');
  const now = new Date().toISOString();
  if (lease !== undefined) {
    if (lease !== 'check') fail('--lease takes only: check');
    if (!db) fail(USAGE);
    const status = checkLease(db, now);
    if (!out && !by && sv === undefined) {
      console.log(JSON.stringify({ lease: 'free', runningSince: status.runningSince }));
      return;
    }
  }
  if (!db || !out || !by || sv === undefined) fail(USAGE);
  if (by !== 'cloud' && by !== 'session') fail('--by must be cloud or session');
  const stateVersion = Number(sv);
  if (!Number.isInteger(stateVersion) || stateVersion < 0) fail('--state-version must be a non-negative integer (0 = meta/state does not exist yet)');

  const warnings = [];
  const dump = readDump(resolve(db), now, warnings);
  const projectPrs = readProject(arg('--project'), warnings);
  const journal = readJournal(arg('--journal'), arg('--journal-from'), warnings);
  let gh;
  try { gh = fetchGitHub(); } catch (e) { fail(e instanceof Error ? e.message : 'GitHub read failed', e?.exitCode ?? 1); }

  const plan = planSync({ gh, dump, journalLines: journal.lines, now, by, projectPrs });
  warnings.push(...plan.warnings);
  // No cutoverAt: planSync wrote no feed rows, so the journal lines were not flushed. Keep the
  // offset where it was, so the next run after the seed flushes them.
  const newOffset = dump.cutoverAt || !journal.lines.length ? journal.newOffset : journal.from;

  const outDir = resolve(out);
  cleanOut(outDir);
  const sized = plan.docs.map((d) => {
    const file = join(outDir, `${d.collection}__${d.id}.json`);
    const json = JSON.stringify(d.data);
    writeFileSync(file, json);
    const pinned = d.collection === 'meta' && d.id === 'state' && stateVersion > 0;
    return { write: { op: 'set', collection: d.collection, doc_id: d.id, file_path: file, ...(pinned ? { if_version: stateVersion } : {}) }, bytes: Buffer.byteLength(json) + 400 };
  });
  // meta/state is alone in the LAST batch (see batchWrites): on version_mismatch, resend only it.
  const batches = batchWrites(sized, { maxWrites: 50, maxBytes: 900_000 });
  batches.forEach((b, i) => writeFileSync(join(outDir, `batch-${i}.json`), JSON.stringify(b, null, 1)));

  const summary = {
    mainSha: gh.mainSha,
    ci: plan.state.ciMain,
    smoke: plan.state.smokeMain,
    prodServes: plan.state.prodServes,
    newDocs: sized.length - 1,
    batches: batches.map((b) => b.length),
    warnings,
    newOffset,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, auth: gh.auth, out: outDir }, null, 1));
  console.log(JSON.stringify(summary));
}

main();
