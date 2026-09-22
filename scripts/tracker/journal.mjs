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
// SMARTREMIT_LEDGER_DIR overrides the directory (tests). The directory is created lazily, so the
// cloud routine (where it does not exist) never fails.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOURNAL_ACTORS, JOURNAL_KINDS, JOURNAL_RESULTS, scrub } from './sync-core.mjs';

export const ledgerDir = () => process.env.SMARTREMIT_LEDGER_DIR || join(homedir(), '.smartremit-ledger');
export const journalPath = () => join(ledgerDir(), 'journal.ndjson');
export const flushedPath = () => join(ledgerDir(), 'flushed');
export const lastSyncPath = () => join(ledgerDir(), 'last-sync.json');

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
  console.log(JSON.stringify({ journal: journalPath(), size, flushed, pendingBytes: Math.max(0, size - flushed), pendingLines, lastSync: readLastSync() }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'add') cmdAdd(rest);
  else if (cmd === 'mark-flushed') cmdMarkFlushed(rest);
  else if (cmd === 'status') cmdStatus();
  else fail('usage: journal.mjs add|mark-flushed|status (see the header of this file)');
}
