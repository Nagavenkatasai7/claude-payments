#!/usr/bin/env node
// Program Ledger journal: session-only capture of chat work (agent runs, merge/close commands,
// owner decisions and approvals). One JSON object per line in ~/.smartremit-ledger/journal.ndjson.
// sync.mjs turns new lines into events/j-<sha1> docs; `mark-flushed` records how far it got.
//
//   node scripts/tracker/journal.mjs add --kind decision --title "…" --detail "…" [--actor owner]
//        [--model "Opus 5"] [--result ok] [--refs '{"fix":[13],"pr":[261],"plan":"p1-w2"}'] [--at <iso>]
//   node scripts/tracker/journal.mjs mark-flushed <offset> [--main-sha <sha>]
//   node scripts/tracker/journal.mjs status
//
// Beside the journal: `flushed` (byte offset sync.mjs reached), `last-sync.json` ({mainSha, at},
// read by the Stop hook) and `agents.json` (main-thread agent launches by agentId, so the
// SubagentStop hook journals one finish row per agent; see hookToJournalEntries in sync-core.mjs).
// SMARTREMIT_LEDGER_DIR overrides the directory (tests). The directory is created lazily, so the
// cloud routine (where it does not exist) never fails.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOURNAL_ACTORS, JOURNAL_KINDS, JOURNAL_RESULTS, hookToJournalEntries, hookUsesAgents, pruneAgents, scrub, sliceJournal } from './sync-core.mjs';

export const ledgerDir = () => process.env.SMARTREMIT_LEDGER_DIR || join(homedir(), '.smartremit-ledger');
export const journalPath = () => join(ledgerDir(), 'journal.ndjson');
export const flushedPath = () => join(ledgerDir(), 'flushed');
export const lastSyncPath = () => join(ledgerDir(), 'last-sync.json');
export const agentsPath = () => join(ledgerDir(), 'agents.json');

/** Append one entry as a single line (O_APPEND: concurrent hooks do not interleave short lines). */
export function appendJournal(entry) {
  mkdirSync(ledgerDir(), { recursive: true });
  appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`);
}

export function journalSize() {
  try { return statSync(journalPath()).size; } catch { return 0; }
}

export function readFlushed() {
  try {
    const n = Number(readFileSync(flushedPath(), 'utf8').trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

export function readLastSync() {
  try {
    const o = JSON.parse(readFileSync(lastSyncPath(), 'utf8'));
    return o && typeof o.mainSha === 'string' ? o : null;
  } catch { return null; }
}

function writeAtomic(file, text) {
  mkdirSync(ledgerDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Complete journal lines past byte offset `from` (the unflushed part), for the Stop hook. */
export function readPendingLines(from) {
  try { return sliceJournal(readFileSync(journalPath()), from).lines; } catch { return []; }
}

/** agents.json as an object keyed by agentId; {} when missing or unreadable. */
export function readAgents() {
  try {
    const o = JSON.parse(readFileSync(agentsPath(), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

export function writeAgents(agents) {
  writeAtomic(agentsPath(), `${JSON.stringify(agents)}\n`);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let asideSeq = 0;

/**
 * Rename the lock dir at `lock` aside to a unique name, then delete it. Renaming is atomic, so of
 * several processes breaking the same stale lock only one moves it, and nobody deletes by path a
 * lock that someone else has just re-created. Returns true when the dir moved had inode
 * `expectIno`; if not (a fresh lock appeared in between), it is put back when the path is free.
 */
function takeLockAside(lock, expectIno) {
  const aside = `${lock}.aside-${process.pid}-${Date.now()}-${asideSeq++}`;
  try { renameSync(lock, aside); } catch { return false; }
  let movedIno = null;
  try { movedIno = statSync(aside).ino; } catch { /* vanished: nothing to restore */ }
  if (movedIno !== expectIno) {
    try { if (!existsSync(lock)) { renameSync(aside, lock); return false; } } catch { /* fall through: drop it */ }
  }
  try { rmSync(aside, { recursive: true, force: true }); } catch { /* best effort */ }
  return movedIno === expectIno;
}

/**
 * Run fn() holding agents.json.lock (mkdir is atomic), so concurrent SubagentStop hooks do not
 * lose each other's read-modify-write. A lock older than staleMs belongs to a crashed or stalled
 * holder and is broken by renaming it aside (takeLockAside). On release the lock is removed only
 * if it is still the one this call created: the same inode AND this call's token in lock/owner
 * (a freed inode number can be reused, e.g. on ext4), so a stalled holder never deletes the lock
 * of whoever broke it. After waitMs fn() runs anyway (best effort: a rare race beats a lost row).
 */
export function withAgentsLock(fn, { waitMs = 3000, staleMs = 2000 } = {}) {
  mkdirSync(ledgerDir(), { recursive: true });
  const lock = `${agentsPath()}.lock`;
  const deadline = Date.now() + waitMs;
  const owner = join(lock, 'owner');
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let heldIno = null;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
      heldIno = statSync(lock).ino;
      writeFileSync(owner, token);
      break;
    } catch (e) {
      if (heldIno !== null) break; // took the lock but could not write the token: hold it anyway
      if (e?.code !== 'EEXIST') break;
    }
    try {
      const st = statSync(lock);
      if (Date.now() - st.mtimeMs > staleMs) { takeLockAside(lock, st.ino); continue; }
    } catch { /* the lock vanished: retry after a pause, until the deadline */ }
    sleepSync(20);
  }
  try {
    return fn();
  } finally {
    if (heldIno !== null) {
      try {
        const mine = statSync(lock).ino === heldIno && readFileSync(owner, 'utf8') === token;
        if (mine) takeLockAside(lock, heldIno);
      } catch { /* already gone, or not ours any more */ }
    }
  }
}

/**
 * The journal hook's I/O for one hook input (the hook itself only parses stdin). Agent launches
 * and SubagentStops go through agents.json under the lock; the journal rows are appended BEFORE
 * agents.json is written, so a failed append leaves the agent unfinished and its next stop
 * journals the finish row. (The converse, an append that lands before a failed state write, can
 * at worst repeat a row; a lost row is the worse failure for the system of record.)
 * @param {any} input
 * @param {string} [now]
 * @returns {number} rows appended
 */
export function recordHookEvent(input, now = new Date().toISOString()) {
  if (!hookUsesAgents(input)) {
    const { entries } = hookToJournalEntries(input, now, {});
    for (const e of entries) appendJournal(e);
    return entries.length;
  }
  return withAgentsLock(() => {
    const step = hookToJournalEntries(input, now, readAgents());
    for (const e of step.entries) appendJournal(e);
    if (step.changed) writeAgents(pruneAgents(step.agents, now));
    return step.entries.length;
  });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(msg) {
  console.error(`journal.mjs: ${msg}`);
  process.exit(2);
}

function cmdAdd(args) {
  const kind = flag(args, '--kind');
  const title = flag(args, '--title');
  if (!kind || !JOURNAL_KINDS.includes(kind)) fail(`--kind must be one of: ${JOURNAL_KINDS.join(', ')}`);
  if (!title) fail('--title is required');
  const actor = flag(args, '--actor') ?? 'claude';
  if (!JOURNAL_ACTORS.includes(actor)) fail(`--actor must be one of: ${JOURNAL_ACTORS.join(', ')}`);
  const result = flag(args, '--result');
  if (result !== undefined && !JOURNAL_RESULTS.includes(result)) fail(`--result must be one of: ${JOURNAL_RESULTS.join(', ')}`);
  const at = flag(args, '--at') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) fail('--at must be an ISO date');
  let refs;
  const rawRefs = flag(args, '--refs');
  if (rawRefs !== undefined) {
    try { refs = JSON.parse(rawRefs); } catch { fail('--refs must be JSON, e.g. {"fix":[13],"pr":[261]}'); }
  }
  const model = flag(args, '--model');
  const entry = {
    at, kind, actor,
    ...(model ? { model: scrub(model) } : {}),
    title: scrub(title),
    detail: scrub(flag(args, '--detail') ?? ''),
    ...(refs ? { refs } : {}),
    ...(result ? { result } : {}),
  };
  appendJournal(entry);
  console.log(JSON.stringify({ appended: journalPath(), size: journalSize() }));
}

function cmdMarkFlushed(args) {
  const offset = Number(args[0]);
  if (!Number.isInteger(offset) || offset < 0) fail('usage: mark-flushed <byteOffset> [--main-sha <sha>]');
  const size = journalSize();
  writeAtomic(flushedPath(), `${offset}\n`);
  const sha = flag(args, '--main-sha');
  if (sha !== undefined) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) fail('--main-sha must be 7-40 hex characters');
    writeAtomic(lastSyncPath(), `${JSON.stringify({ mainSha: sha.slice(0, 7).toLowerCase(), at: new Date().toISOString() })}\n`);
  }
  console.log(JSON.stringify({ flushed: offset, journalSize: size, pendingBytes: Math.max(0, size - offset), ...(sha ? { lastSyncMainSha: sha.slice(0, 7).toLowerCase() } : {}) }));
}

function cmdStatus() {
  const size = journalSize();
  const flushed = readFlushed();
  let pendingLines = 0;
  if (size > flushed && existsSync(journalPath())) {
    const buf = readFileSync(journalPath()).subarray(flushed);
    for (const b of buf) if (b === 0x0a) pendingLines++;
  }
  console.log(JSON.stringify({ journal: journalPath(), size, flushed, pendingBytes: Math.max(0, size - flushed), pendingLines, lastSync: readLastSync(), agentsTracked: Object.keys(readAgents()).length }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'add') cmdAdd(rest);
  else if (cmd === 'mark-flushed') cmdMarkFlushed(rest);
  else if (cmd === 'status') cmdStatus();
  else fail('usage: journal.mjs add|mark-flushed|status (see the header of this file)');
}
