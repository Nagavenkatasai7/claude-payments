#!/usr/bin/env node
// Program Ledger v2: a thread's fast lane into the ledger. Prints ONE ArtifactData `set` of a new
// inbox/n-<sha1> doc (no version: the id is new). The hourly routine's curator reads unprocessed
// inbox docs as sources and marks them processedAt. No home-directory state, no network.
//
//   node scripts/tracker/note.mjs --kind <milestone|decision|owner-step|incident> --thread <cmsg_...>
//        --text '<what happened, at most 400 characters>' --out <dir> [--refs '<json>'] [--now <ISO>]
//
// The text is scrubbed (phone, email, token, long numbers masked) before it is hashed and stored.
// The id is n-<sha1(threadId|kind|scrubbed text)>: the same note sent twice is the same doc.
// Writes <out>/inbox__<id>.json and prints {"action":"set","collection":"inbox","doc_id":..,"data":..}.
// Send it with ArtifactData set (collection, doc_id, data or file_path) and NO if_version.
// Exit 2 on bad input (nothing written).
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from './sync-core.mjs';

export const NOTE_KINDS = Object.freeze(['milestone', 'decision', 'owner-step', 'incident']);
export const NOTE_TEXT_MAX = 400;
const THREAD_RE = /^cmsg_[A-Za-z0-9]+$/;
const REF_KEYS = new Set(['pr', 'sha', 'artifact', 'ws', 'todo', 'decision', 'msgId']);

export class NoteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoteError';
  }
}

/** n-<sha1(threadId|kind|text)> (full sha1). */
export const noteId = (threadId, kind, text) => `n-${createHash('sha1').update(`${threadId}|${kind}|${text}`).digest('hex')}`;

function checkRefs(refs) {
  if (refs === undefined || refs === null) return {};
  if (typeof refs !== 'object' || Array.isArray(refs)) throw new NoteError('--refs must be a JSON object');
  for (const [k, v] of Object.entries(refs)) {
    if (!REF_KEYS.has(k)) throw new NoteError(`--refs has an unknown key ${k} (allowed: ${[...REF_KEYS].join(', ')})`);
    if (k === 'pr') {
      if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n) && n > 0)) throw new NoteError('refs.pr must be a list of PR numbers');
    } else if (typeof v !== 'string' || !v || v.length > 100 || scrub(v) !== v) {
      throw new NoteError(`refs.${k} must be a short plain string`);
    }
  }
  return refs;
}

/**
 * Validate and build one inbox note. Pure.
 * @param {{kind: string, threadId: string, text: string, refs?: any, now: string}} args
 * @returns {{id: string, doc: any, op: {action: 'set', collection: 'inbox', doc_id: string, data: any}}}
 */
export function buildNote({ kind, threadId, text, refs, now }) {
  if (!NOTE_KINDS.includes(kind)) throw new NoteError(`--kind must be one of ${NOTE_KINDS.join('|')}`);
  if (typeof threadId !== 'string' || !THREAD_RE.test(threadId)) throw new NoteError('--thread must be a cmsg_ thread id');
  const clean = scrub(String(text ?? '')).replace(/\s+/g, ' ').trim();
  if (!clean) throw new NoteError('--text is empty');
  if (clean.length > NOTE_TEXT_MAX) throw new NoteError(`--text is over ${NOTE_TEXT_MAX} characters`);
  if (Number.isNaN(Date.parse(now ?? ''))) throw new NoteError('--now must be an ISO time');
  const id = noteId(threadId, kind, clean);
  const doc = { at: now, threadId, kind, text: clean, refs: checkRefs(refs), processedAt: null };
  return { id, doc, op: { action: 'set', collection: 'inbox', doc_id: id, data: doc } };
}

function main(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = get('--out');
  const fail = (msg) => { console.error(JSON.stringify({ error: msg })); process.exit(2); };
  if (!out) fail('usage: note.mjs --kind <kind> --thread <cmsg_...> --text <text> --out <dir> [--refs <json>] [--now <ISO>]');
  let refs;
  try { refs = get('--refs') === undefined ? undefined : JSON.parse(get('--refs')); } catch { fail('--refs is not valid JSON'); }
  let note;
  try {
    note = buildNote({ kind: get('--kind'), threadId: get('--thread'), text: get('--text'), refs, now: get('--now') ?? new Date().toISOString() });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `inbox__${note.id}.json`), JSON.stringify(note.doc, null, 1));
  console.log(JSON.stringify(note.op));
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main(process.argv.slice(2));
