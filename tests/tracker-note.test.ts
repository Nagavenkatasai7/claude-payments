import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTE_KINDS, NOTE_TEXT_MAX, NoteError, buildNote, noteId } from '../scripts/tracker/note.mjs';

type Any = any;

const NOW = new Date(Date.now()).toISOString();
const THREAD = 'cmsg_FixtureThreadA1';
const NOTE_CLI = join(__dirname, '..', 'scripts', 'tracker', 'note.mjs');
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

describe('note.mjs buildNote', () => {
  it('derives n-<sha1(threadId|kind|text)> so the same note twice is the same doc', () => {
    const a = buildNote({ kind: 'milestone', threadId: THREAD, text: 'Batch Z is live on main.', now: NOW });
    const b = buildNote({ kind: 'milestone', threadId: THREAD, text: 'Batch Z is live on main.', now: new Date(Date.now() - 60_000).toISOString() });
    expect(a.id).toBe(`n-${sha1(`${THREAD}|milestone|Batch Z is live on main.`)}`);
    expect(a.id).toBe(noteId(THREAD, 'milestone', 'Batch Z is live on main.'));
    expect(b.id).toBe(a.id);
    expect(buildNote({ kind: 'incident', threadId: THREAD, text: 'Batch Z is live on main.', now: NOW }).id).not.toBe(a.id);
  });

  it('builds the inbox doc: at, threadId, kind, text, refs, processedAt null', () => {
    const n = buildNote({ kind: 'decision', threadId: THREAD, text: '  The owner chose the free FX feed.  ', refs: { pr: [901] }, now: NOW });
    expect(n.doc).toEqual({ at: NOW, threadId: THREAD, kind: 'decision', text: 'The owner chose the free FX feed.', refs: { pr: [901] }, processedAt: null });
  });

  it('scrubs the text before hashing and storing (phone, email, long numbers)', () => {
    const n = buildNote({ kind: 'owner-step', threadId: THREAD, text: 'Call +919876543210 or mail someone@gmail.com about 12345678901234', now: NOW });
    expect(n.doc.text).not.toMatch(/9876543210|someone@gmail\.com|12345678901234/);
    expect(n.doc.text).toContain('3210');
    expect(n.id).toBe(noteId(THREAD, 'owner-step', n.doc.text));
  });

  it('prints one ArtifactData set op for the new id, with no if_version', () => {
    const n = buildNote({ kind: 'milestone', threadId: THREAD, text: 'Done.', now: NOW });
    expect(n.op).toEqual({ action: 'set', collection: 'inbox', doc_id: n.id, data: n.doc });
    expect('if_version' in n.op).toBe(false);
  });

  it('rejects an unknown kind, a bad thread id, empty or too-long text, and bad refs', () => {
    expect(NOTE_KINDS).toEqual(['milestone', 'decision', 'owner-step', 'incident']);
    const ok = { kind: 'milestone', threadId: THREAD, text: 'x', now: NOW };
    expect(() => buildNote({ ...ok, kind: 'agent' })).toThrow(NoteError);
    expect(() => buildNote({ ...ok, threadId: 'not-a-thread' })).toThrow(NoteError);
    expect(() => buildNote({ ...ok, text: '   ' })).toThrow(NoteError);
    expect(() => buildNote({ ...ok, text: 'y'.repeat(NOTE_TEXT_MAX + 1) })).toThrow(NoteError);
    expect(() => buildNote({ ...ok, refs: [1] as Any })).toThrow(NoteError);
    expect(() => buildNote({ ...ok, refs: { pr: ['x'] } as Any })).toThrow(NoteError);
  });
});

describe('note.mjs CLI', () => {
  it('writes one inbox doc file and prints one set op (exit 0)', () => {
    const out = mkdtempSync(join(tmpdir(), 'note-'));
    const stdout = execFileSync('node', [NOTE_CLI, '--kind', 'decision', '--thread', THREAD, '--text', 'Go for batch Z.', '--out', out], { encoding: 'utf8' });
    const op = JSON.parse(stdout.trim());
    expect(op.action).toBe('set');
    expect(op.collection).toBe('inbox');
    expect(op.if_version).toBeUndefined();
    const files = readdirSync(out);
    expect(files).toEqual([`inbox__${op.doc_id}.json`]);
    expect(JSON.parse(readFileSync(join(out, files[0]), 'utf8'))).toEqual(op.data);
  });

  it('exits 2 on an unknown kind and writes nothing', () => {
    const out = mkdtempSync(join(tmpdir(), 'note-'));
    let code = 0;
    try {
      execFileSync('node', [NOTE_CLI, '--kind', 'gossip', '--thread', THREAD, '--text', 'x', '--out', out], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = (e as Any).status;
    }
    expect(code).toBe(2);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('every tracker script runs without npm install', () => {
  it('scripts/tracker/*.mjs import only node: built-ins or relative files', () => {
    const dir = join(__dirname, '..', 'scripts', 'tracker');
    const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
    expect(files).toEqual(expect.arrayContaining(['collect.mjs', 'curate.mjs', 'note.mjs', 'seed-v2.mjs', 'ledger-io.mjs', 'sync-core.mjs']));
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      const specs = [
        ...src.matchAll(/^\s*import\s[^'"]*?['"]([^'"]+)['"]/gm),
        ...src.matchAll(/^\s*export\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm),
        ...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g),
      ].map((m) => m[1]);
      for (const s of specs) expect(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'), `${f} imports ${s}`).toBe(true);
    }
  });
});
