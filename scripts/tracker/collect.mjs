#!/usr/bin/env node
// Program Ledger v2, COLLECT step (CLI). Deterministic, no network, no secrets. Reads the raw
// hearthbot snapshot and the v2 dump, and writes what the curator and curate.mjs need.
// Pure logic lives in project-core.mjs (unit-tested).
//
//   node scripts/tracker/collect.mjs --db <dump dir> --project <snapshot dir> --out <dir>
//        [--memory <memory dir>] [--reviews <reviews dir>] [--reconcile] [--now <ISO>] [--run-id <id>]
//
//   --db       ArtifactData dump (see ledger-io.mjs): meta (sync, cursors), ws, docs, acks, inbox,
//              prs and prstate (engine), plus <db>/versions.json
//   --project  threads.json (list_thread_sessions, all pages), prs.json (list_project_prs),
//              artifacts.json (list_project_artifacts); a failed tool is saved as {"unavailable": true}
//   --memory   the project memory dir (MEMORY.md and topic files); its sha256 goes in the digest
//   --reviews  the review files dir (*.md)
//   --reconcile  force the daily reconcile (it is automatic at 05 UTC and after 24 h without one)
//
// Writes to --out:
//   facts.json          everything curate.mjs apply and check need (threads, ws facts, stubs, docs
//                       rows, GitHub PR facts, digest, reconcile, the selected and carried threads)
//   curate-input.json   {runId, skip, reconcile, threads: [{threadId, cursorMsgId, title, ws,
//                       lastActivityAt}], carried, sources: [{path, as, kind}]}
//                       The routine fetches each listed thread (newest_first, limit 25, stop at
//                       cursorMsgId) to <threads>/<threadId>.json and copies each source to <sources>/<as>.
//   batch-N.json        ArtifactData batches: ws stubs for unmapped threads (new ids, no version)
//                       and docs rows for new or changed project Artifacts (pinned when they exist)
//   summary.json        and one printed JSON line.
// Exit 0 (warnings in the summary); 2 on bad flags or unreadable input.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planWrites } from './curate-core.mjs';
import { arg, cleanOut, fail, hasFlag, readDump, readJson, writeBatchFiles } from './ledger-io.mjs';
import {
  curatePlan,
  deriveWsFacts,
  docsRows,
  inputsDigest,
  normalizeArtifacts,
  normalizeProjectPrs,
  normalizeThreads,
  stubWs,
  toolsAvailable,
} from './project-core.mjs';

const HOUR = 3_600_000;
/** The daily reconcile hour (UTC) and the longest gap between two reconciles. */
const RECONCILE_HOUR_UTC = 5;
const RECONCILE_MAX_GAP_MS = 24 * HOUR;
const COLLS = ['meta', 'ws', 'docs', 'acks', 'inbox', 'prs', 'prstate'];

const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? 0 : t; };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** GitHub (engine) facts per PR: the furthest prstate wins (merged > closed > open). */
function ghPrFacts(prsDocs = {}, prstateDocs = {}) {
  const out = {};
  for (const p of Object.values(prsDocs)) if (Number.isInteger(p?.number)) out[p.number] = { state: null, mergedAt: null, title: p.title ?? '' };
  const rank = { open: 0, closed: 1, merged: 2 };
  const best = {};
  for (const s of Object.values(prstateDocs)) {
    if (!Number.isInteger(s?.number)) continue;
    const r = rank[s.state] ?? -1;
    if (best[s.number] !== undefined && r <= best[s.number]) continue;
    best[s.number] = r;
    out[s.number] = { state: s.state ?? null, mergedAt: s.state === 'merged' ? (s.at ?? null) : null, title: s.title || out[s.number]?.title || '' };
  }
  return out;
}

function readProject(dir, warnings) {
  const raw = {};
  for (const [k, f] of [['threads', 'threads.json'], ['prs', 'prs.json'], ['artifacts', 'artifacts.json']]) {
    const p = join(dir, f);
    try {
      raw[k] = readJson(p, undefined);
      if (raw[k] === undefined) { warnings.push(`--project has no ${f} (treated as unavailable)`); raw[k] = { unavailable: true }; }
    } catch {
      warnings.push(`unreadable ${p} (treated as unavailable)`);
      raw[k] = { unavailable: true };
    }
  }
  return raw;
}

const mdFiles = (dir) => (dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile()).sort() : []);
const mtimeIso = (p) => statSync(p).mtime.toISOString();

function main(argv) {
  const db = arg(argv, '--db');
  const project = arg(argv, '--project');
  const out = arg(argv, '--out');
  if (!db || !project || !out) fail('usage: collect.mjs --db <dump dir> --project <snapshot dir> --out <dir> [--memory <dir>] [--reviews <dir>] [--reconcile] [--now <ISO>] [--run-id <id>]');
  if (!existsSync(db)) fail(`--db ${db} does not exist`);
  if (!existsSync(project)) fail(`--project ${project} does not exist`);
  const now = arg(argv, '--now') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) fail('--now must be an ISO time');
  const runId = arg(argv, '--run-id') ?? `run-${now.slice(0, 13).replace(/[-:]/g, '')}`;
  const memoryDir = arg(argv, '--memory');
  const reviewsDir = arg(argv, '--reviews');
  const warnings = [];

  const { docs: D, versions } = readDump([db], COLLS, warnings);
  const sync = D.meta.sync ?? null;
  const cursors = D.meta.cursors ?? { threads: {} };
  const routineThreadId = sync?.routineThreadId ?? null;
  if (!sync) warnings.push('dump has no meta/sync (not seeded yet?): routineThreadId and cutoverAt unknown');

  const raw = readProject(resolve(project), warnings);
  const tools = toolsAvailable(raw);
  for (const [k, ok] of Object.entries(tools)) if (!ok) warnings.push(`project tool ${k} unavailable`);
  const threads = normalizeThreads(raw.threads);
  const projectPrs = normalizeProjectPrs(raw.prs);
  const artifacts = normalizeArtifacts(raw.artifacts);
  const ghPrs = ghPrFacts(D.prs, D.prstate);

  // Docs rows first, so ws facts list the Artifacts the curator already classified.
  const rows = tools.artifacts ? docsRows(artifacts, D.docs, now) : [];
  const docsAfter = { ...D.docs };
  for (const r of rows) docsAfter[r.id] = r.data;
  const { facts: wsFacts, unmapped } = deriveWsFacts({ threads, projectPrs, ghPrs, docs: docsAfter, cursors, prevWs: D.ws, routineThreadId });

  // A deterministic stub per unmapped workstream key (one per key; the routine thread gets none).
  const stubs = [];
  const threadById = Object.fromEntries(threads.map((t) => [t.threadId, t]));
  for (const u of unmapped) {
    if (u.threadId === routineThreadId || D.ws[u.key] || stubs.some((s) => s.key === u.key)) continue;
    stubs.push(stubWs(u.key, threadById[u.threadId], wsFacts[u.key], now));
  }

  // Memory and review files.
  let memory = null;
  const sources = [];
  const memPath = memoryDir ? join(memoryDir, 'MEMORY.md') : null;
  if (memPath && existsSync(memPath)) memory = { path: resolve(memPath), sha256: sha256(readFileSync(memPath)), mtime: mtimeIso(memPath) };
  else if (memoryDir) warnings.push(`--memory ${memoryDir} has no MEMORY.md`);
  const reviews = {};
  for (const f of mdFiles(reviewsDir)) reviews[f] = mtimeIso(join(reviewsDir, f));

  const lastReconcile = time(sync?.reconcileAt);
  const reconcile = hasFlag(argv, '--reconcile') || new Date(now).getUTCHours() === RECONCILE_HOUR_UTC || !lastReconcile || time(now) - lastReconcile >= RECONCILE_MAX_GAP_MS;
  const ackIds = Object.keys(D.acks).sort();
  const inboxIds = Object.keys(D.inbox).filter((id) => !D.inbox[id]?.processedAt).sort();
  const digest = inputsDigest({ threads, routineThreadId, memorySha256: memory?.sha256 ?? null, projectPrs, artifacts, ackIds, inboxIds });
  // Not a skip while any thread is past its cursor (threads carried over from the last run).
  const { skip, selected, carried } = curatePlan({ threads, cursors, routineThreadId, digest, prevDigest: sync?.inputsDigest ?? null, reconcile });
  if (!skip) {
    const memChanged = memory && memory.sha256 !== cursors?.memory?.sha256;
    if (memory && (reconcile || memChanged)) sources.push({ path: memory.path, as: 'MEMORY.md', kind: 'mem' });
    if (reconcile && memoryDir) {
      const readAt = time(cursors?.memory?.readAt);
      for (const f of mdFiles(memoryDir)) {
        if (f === 'MEMORY.md') continue;
        const p = join(memoryDir, f);
        if (statSync(p).mtimeMs > readAt) sources.push({ path: resolve(p), as: `memory/${f}`, kind: 'mem' });
      }
    }
    if (reconcile) {
      for (const [f, m] of Object.entries(reviews)) if (cursors?.reviews?.[f] !== m) sources.push({ path: resolve(join(reviewsDir, f)), as: `reviews/${f}`, kind: 'file' });
    }
  }

  // Writes: stubs (new ids) and docs rows (new, or pinned refresh).
  const changes = [
    ...stubs.map((s) => ({ collection: 'ws', id: s.key, data: s, isNew: true })),
    ...rows.map((r) => ({ collection: 'docs', id: r.id, data: r.data, isNew: r.isNew })),
  ].filter((c) => {
    if (c.isNew || Number.isInteger(versions[`${c.collection}/${c.id}`])) return true;
    warnings.push(`${c.collection}/${c.id} changed but versions.json has no version for it (skipped; never an unpinned write)`);
    return false;
  });
  const batches = planWrites(changes, versions);

  const outDir = resolve(out);
  cleanOut(outDir, ['facts.json', 'curate-input.json']);
  const sizes = writeBatchFiles(outDir, batches);
  const facts = {
    schema: 2,
    now,
    runId,
    routineThreadId,
    ownerId: sync?.ownerId ?? null,
    cutoverAt: sync?.cutoverAt ?? null,
    reconcile,
    skip,
    inputsDigest: digest,
    prevDigest: sync?.inputsDigest ?? null,
    toolsAvailable: tools,
    threads,
    projectPrs,
    artifacts,
    ghPrs,
    wsFacts,
    unmapped,
    stubs,
    docsRows: rows,
    selected,
    carried,
    memory,
    reviews,
    sources,
    newDocs: changes.filter((c) => c.isNew).length,
  };
  writeFileSync(join(outDir, 'facts.json'), JSON.stringify(facts, null, 1));
  const input = {
    runId,
    skip,
    reconcile,
    threads: selected.map((t) => ({ threadId: t.threadId, cursorMsgId: t.stopAt, title: t.title, ws: t.ws, lastActivityAt: t.lastActivityAt })),
    carried,
    sources,
  };
  writeFileSync(join(outDir, 'curate-input.json'), JSON.stringify(input, null, 1));
  const summary = {
    runId,
    skip,
    reconcile,
    threads: threads.length,
    changed: selected.length,
    carried: carried.length,
    sources: sources.length,
    stubs: stubs.length,
    docsNew: rows.filter((r) => r.isNew).length,
    docsChanged: rows.filter((r) => !r.isNew).length,
    batches: sizes,
    tools,
    warnings,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ ...summary, out: outDir }, null, 1));
  console.log(JSON.stringify(summary));
}

main(process.argv.slice(2));
