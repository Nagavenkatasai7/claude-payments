#!/usr/bin/env node
// Program Ledger auto-sync engine (CLI). Reads GitHub (read-only, via curl) and a dump of the
// ledger database, and writes the ArtifactData batches that bring the ledger up to date.
// Append-only: every write is a `set` of a NEW doc with a deterministic id, except meta/state,
// which is pinned with --state-version. Pure logic lives in sync-core.mjs (unit-tested).
//
//   node scripts/tracker/sync.mjs --db <dump dir> --state-version <n> --by <cloud|session> --out <dir>
//        [--journal <file>] [--journal-from <byteOffset>]
//
//   --db             ArtifactData list/get output (out_dir): <db>/<collection>/<id>.json for
//                    prs, prstate, fixstate, events, fixes, and meta/state.json
//   --state-version  meta/state's current version (0 = the doc does not exist yet)
//   --by             cloud → syncedBy "cloud routine"; session → "session"
//   --out            gets batch-N.json (ArtifactData batch `writes`), the doc files and summary.json;
//                    stale batch/doc files from an earlier run are removed first
//   --journal        journal.ndjson; --journal-from defaults to the `flushed` marker beside it
//
// GitHub auth: the auth header goes to curl through stdin (-K -), never argv or output. A token
// is used only when `gh auth token` gives one (locally). In the cloud routine `gh` is missing, so
// no header is sent and the egress proxy authenticates curl. LEDGER_GH_AUTH=none|gh forces a mode.
// Runs are read with event=push: a workflow_dispatch Smoke's head_sha is the dispatching branch's
// head, not the commit under test, so only push runs prove what production serves.
//
// Prints one JSON line: {mainSha, ci, smoke, prodServes, newDocs, batches, warnings, newOffset}.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { REPO, batchWrites, planSync, sliceJournal } from './sync-core.mjs';

const USAGE = 'usage: sync.mjs --db <dump dir> --state-version <n> --by <cloud|session> --out <dir> [--journal <file>] [--journal-from <byteOffset>]';
const COLLECTIONS = ['prs', 'prstate', 'fixstate', 'events', 'fixes'];

function fail(msg, code = 2) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// ---------- GitHub over curl ----------
function ghToken() {
  const mode = process.env.LEDGER_GH_AUTH || 'auto';
  if (mode === 'none') return null;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const token = !r.error && r.status === 0 ? r.stdout.trim() : '';
  if (token) return token;
  if (mode === 'gh') fail('LEDGER_GH_AUTH=gh but `gh auth token` returned no token');
  return null;
}

function ghGet(path, token) {
  const args = [
    '-sS', '--max-time', '30', '--retry', '2',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: smartremit-ledger-sync',
    '-w', '\n%{http_code}',
  ];
  if (token) args.push('-K', '-'); // the Authorization header arrives on stdin, never in argv
  args.push(`https://api.github.com${path}`);
  const r = spawnSync('curl', args, {
    encoding: 'utf8',
    input: token ? `header = "Authorization: Bearer ${token}"\n` : '',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error) throw new Error(`curl could not run for GET ${path}: ${r.error.code || 'error'}`);
  const out = r.stdout || '';
  const nl = out.lastIndexOf('\n');
  const status = Number(out.slice(nl + 1));
  const body = nl >= 0 ? out.slice(0, nl) : '';
  if (r.status !== 0 || !(status >= 200 && status < 300)) {
    let message = '';
    try { message = String(JSON.parse(body).message || ''); } catch { /* not JSON */ }
    throw new Error(`GitHub GET ${path} failed: HTTP ${status || 'none'}${message ? ` (${message.slice(0, 120)})` : ''}${r.status ? `, curl exit ${r.status}` : ''}`);
  }
  return JSON.parse(body);
}

function fetchGitHub() {
  const token = ghToken();
  const get = (p) => ghGet(p, token);
  const head = get(`/repos/${REPO}/branches/main`).commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(head || '')) throw new Error('GitHub returned no sha for main');
  return {
    auth: token ? 'gh' : 'none',
    mainSha: head.slice(0, 7),
    prs: get(`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=60`),
    openPrs: get(`/repos/${REPO}/pulls?state=open&per_page=100`),
    ciRuns: get(`/repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=20`).workflow_runs ?? [],
    smokeRuns: get(`/repos/${REPO}/actions/workflows/smoke.yml/runs?branch=main&event=push&per_page=30`).workflow_runs ?? [],
  };
}

// ---------- ledger dump ----------
// ArtifactData saves each doc's data only; tolerate a {data, version} wrapper just in case.
const unwrap = (d) => (d && typeof d === 'object' && d.data && typeof d.data === 'object' && 'version' in d ? d.data : d);

function readDump(db, warnings) {
  if (!existsSync(db)) fail(`--db ${db} does not exist`);
  const dump = { ids: new Set(), fixstate: [], fixes: [], events: [], prevState: null };
  for (const c of COLLECTIONS) {
    const dir = join(db, c);
    if (!existsSync(dir)) { warnings.push(`dump has no ${c}/ (treated as empty)`); continue; }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const id = basename(f, '.json');
      let data;
      try { data = unwrap(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { warnings.push(`unreadable dump file ${c}/${f} (id still counted as existing)`); }
      dump.ids.add(`${c}/${id}`);
      if (c === 'fixstate' && data) dump.fixstate.push(data);
      if (c === 'fixes' && data) dump.fixes.push(data);
      if (c === 'events') dump.events.push({ id, data: data ?? {} });
    }
  }
  const statePath = join(db, 'meta', 'state.json');
  if (existsSync(statePath)) {
    try { dump.prevState = unwrap(JSON.parse(readFileSync(statePath, 'utf8'))); } catch { warnings.push('unreadable meta/state.json'); }
  } else {
    warnings.push('dump has no meta/state.json: keys outside the engine\'s set will not be kept');
  }
  return dump;
}

// ---------- journal ----------
function readJournal(file, fromArg, warnings) {
  if (!file) return { lines: [], newOffset: null };
  let from = fromArg === undefined ? undefined : Number(fromArg);
  if (from === undefined) {
    try { from = Number(readFileSync(join(dirname(file), 'flushed'), 'utf8').trim()) || 0; } catch { from = 0; }
  }
  if (!Number.isInteger(from) || from < 0) fail('--journal-from must be a non-negative integer');
  if (!existsSync(file)) { warnings.push(`journal ${file} not found (nothing to flush)`); return { lines: [], newOffset: from }; }
  const slice = sliceJournal(readFileSync(file), from);
  warnings.push(...slice.warnings);
  return { lines: slice.lines, newOffset: slice.newOffset };
}

// ---------- output ----------
function cleanOut(out) {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) {
    if (/^batch-\d+\.json$/.test(f) || /^[a-z]+__.+\.json$/.test(f) || f === 'summary.json') rmSync(join(out, f));
  }
}

function main() {
  const db = arg('--db');
  const out = arg('--out');
  const by = arg('--by');
  const sv = arg('--state-version');
  if (!db || !out || !by || sv === undefined) fail(USAGE);
  if (by !== 'cloud' && by !== 'session') fail('--by must be cloud or session');
  const stateVersion = Number(sv);
  if (!Number.isInteger(stateVersion) || stateVersion < 0) fail('--state-version must be a non-negative integer (0 = meta/state does not exist yet)');

  const warnings = [];
  const dump = readDump(resolve(db), warnings);
  const journal = readJournal(arg('--journal'), arg('--journal-from'), warnings);
  let gh;
  try { gh = fetchGitHub(); } catch (e) { fail(e instanceof Error ? e.message : 'GitHub read failed', 1); }

  const plan = planSync({ gh, dump, journalLines: journal.lines, now: new Date().toISOString(), by });
  warnings.push(...plan.warnings);

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
    newOffset: journal.newOffset,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, auth: gh.auth, out: outDir }, null, 1));
  console.log(JSON.stringify(summary));
}

main();
