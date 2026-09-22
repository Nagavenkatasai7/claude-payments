// I/O side of the Program Ledger journal (scripts/tracker/journal.mjs), against a temp
// SMARTREMIT_LEDGER_DIR: the agents.json lock, the journal-before-state write order of the
// journal hook, and the unflushed-lines reader used by the Stop hook.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentsPath,
  journalPath,
  readAgents,
  readPendingLines,
  recordHookEvent,
  withAgentsLock,
} from '../scripts/tracker/journal.mjs';

let dir: string;
const prevDir = process.env.SMARTREMIT_LEDGER_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-io-'));
  process.env.SMARTREMIT_LEDGER_DIR = dir;
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.SMARTREMIT_LEDGER_DIR;
  else process.env.SMARTREMIT_LEDGER_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => `${agentsPath()}.lock`;
const lockLeftovers = () => readdirSync(dir).filter((f) => f.startsWith('agents.json.lock'));
const journalRows = () => (existsSync(journalPath()) ? readFileSync(journalPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const minuteAgo = () => new Date(Date.now() - 60_000);

describe('withAgentsLock', () => {
  it('runs fn holding the lock, returns its value and removes the lock', () => {
    const seen: boolean[] = [];
    expect(withAgentsLock(() => { seen.push(existsSync(lockPath())); return 42; })).toBe(42);
    expect(seen).toEqual([true]);
    expect(lockLeftovers()).toEqual([]);
  });

  it('breaks a stale lock by renaming it aside, even when the stale lock dir is not empty', () => {
    mkdirSync(lockPath());
    writeFileSync(join(lockPath(), 'owner'), 'pid 1');
    utimesSync(lockPath(), minuteAgo(), minuteAgo());
    // Compare owner tokens, not inodes: ext4 hands the freed inode number to the next mkdir at once.
    let heldOwner = '';
    withAgentsLock(() => { heldOwner = readFileSync(join(lockPath(), 'owner'), 'utf8'); }, { waitMs: 1000, staleMs: 2000 });
    expect(heldOwner).not.toBe('');
    expect(heldOwner).not.toBe('pid 1');
    expect(lockLeftovers()).toEqual([]);
  });

  it('does not remove a lock it no longer holds (another process broke it and took a new one)', () => {
    withAgentsLock(() => {
      // Simulates B: finds this holder stale, renames its lock aside and creates its own.
      renameSync(lockPath(), `${lockPath()}.broken-by-b`);
      mkdirSync(lockPath());
    });
    expect(existsSync(lockPath())).toBe(true);
  });

  it('after waitMs runs fn anyway and leaves a live foreign lock in place', () => {
    mkdirSync(lockPath());
    let ran = false;
    withAgentsLock(() => { ran = true; }, { waitMs: 100, staleMs: 60_000 });
    expect(ran).toBe(true);
    expect(existsSync(lockPath())).toBe(true);
  });
});

describe('recordHookEvent', () => {
  const NOW = '2026-09-22T03:00:00.000Z';
  const launch = { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'Build fix 18', subagent_type: 'general-purpose', prompt: 'SECRET' }, tool_response: { status: 'async_launched', agentId: 'a1', prompt: 'SECRET' } };
  const stop = (msg: string) => ({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: msg });

  it('journals one start and one finish row per agent and keeps agents.json in step', () => {
    recordHookEvent(launch, NOW);
    recordHookEvent(stop('first'), '2026-09-22T03:01:00.000Z');
    recordHookEvent(stop('second'), '2026-09-22T03:02:00.000Z');
    expect(journalRows().map((r) => r.title)).toEqual(['Agent started: Build fix 18', 'Agent finished: Build fix 18']);
    expect(readAgents().a1).toMatchObject({ finishedAt: '2026-09-22T03:01:00.000Z', lastMessage: 'second' });
    expect(readFileSync(journalPath(), 'utf8') + readFileSync(agentsPath(), 'utf8')).not.toContain('SECRET');
    expect(lockLeftovers()).toEqual([]);
  });

  it('writes the journal row BEFORE agents.json: a failed append leaves the agent unfinished, so the next stop retries', () => {
    recordHookEvent(launch, NOW);
    rmSync(journalPath());
    mkdirSync(journalPath()); // appendFileSync now fails with EISDIR
    expect(() => recordHookEvent(stop('lost'), '2026-09-22T03:01:00.000Z')).toThrow();
    expect(readAgents().a1.finishedAt).toBeUndefined();
    rmSync(journalPath(), { recursive: true });
    recordHookEvent(stop('retried'), '2026-09-22T03:02:00.000Z');
    expect(journalRows()).toMatchObject([{ title: 'Agent finished: Build fix 18', detail: 'retried' }]);
    expect(readAgents().a1.finishedAt).toBe('2026-09-22T03:02:00.000Z');
  });

  it('journals gh pr rows without touching agents.json', () => {
    recordHookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 273 --squash' }, tool_response: { stdout: '', stderr: '', interrupted: false } }, NOW);
    expect(journalRows()).toMatchObject([{ kind: 'pr', title: 'gh pr merge #273 run in a session', result: 'ok' }]);
    expect(existsSync(agentsPath())).toBe(false);
  });
});

describe('readPendingLines', () => {
  it('returns the complete lines after the offset, and [] without a journal', () => {
    expect(readPendingLines(0)).toEqual([]);
    const a = JSON.stringify({ kind: 'agent', title: 'a' });
    const b = JSON.stringify({ kind: 'approval', title: 'b' });
    writeFileSync(journalPath(), `${a}\n${b}\n{"partial":`);
    expect(readPendingLines(0)).toEqual([a, b]);
    expect(readPendingLines(Buffer.byteLength(`${a}\n`))).toEqual([b]);
  });
});
