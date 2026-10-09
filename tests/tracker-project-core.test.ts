import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CURATE_BYTE_BUDGET,
  CURATE_THREAD_CAP,
  THREAD_EST_BYTES,
  changedThreads,
  curatePlan,
  deriveWsFacts,
  docsRows,
  inputsDigest,
  normalizeArtifacts,
  normalizeProjectPrs,
  normalizeThreads,
  slugify,
  stubWs,
  toolsAvailable,
  wsKeyForThread,
} from '../scripts/tracker/project-core.mjs';

// Relative dates only (CLAUDE.md fixture rule): every time is an offset from NOW.
const NOW = Date.now();
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const nowIso = new Date(NOW).toISOString();

const ROUTINE = 'cmsg_routine000000000000000000';

// Raw rows shaped like hearthbot list_thread_sessions / list_project_prs / list_project_artifacts.
function session(n: number, over: Record<string, unknown> = {}) {
  return {
    created_at: ago(72 * HOUR),
    last_activity_at: ago(n * HOUR),
    resolved: false,
    resolved_at: null,
    session_id: `cse_01SESSION${n}`,
    status: 'active',
    status_bucket: 'working',
    status_category: 'working',
    thread_id: `cmsg_thread${n}`,
    title: `Thread number ${n}`,
    ...over,
  };
}

describe('normalizeThreads', () => {
  it('maps hearthbot rows to camelCase threads with the session key suffix', () => {
    const [t] = normalizeThreads({ sessions: [session(1, { title: 'Batch B build' })] });
    expect(t).toEqual({
      threadId: 'cmsg_thread1',
      sessionId: 'cse_01SESSION1',
      sessionKey: '01SESSION1',
      title: 'Batch B build',
      bucket: 'working',
      status: 'active',
      resolved: false,
      createdAt: ago(72 * HOUR),
      lastActivityAt: ago(1 * HOUR),
    });
  });

  it('accepts several pages (next_cursor) and keeps the newest row per thread', () => {
    const pages = [
      { sessions: [session(1), session(2)], next_cursor: 'x' },
      { sessions: [session(3), { ...session(2), last_activity_at: ago(0.5 * HOUR) }] },
    ];
    const ts = normalizeThreads(pages);
    expect(ts.map((t: { threadId: string }) => t.threadId).sort()).toEqual(['cmsg_thread1', 'cmsg_thread2', 'cmsg_thread3']);
    expect(ts.find((t: { threadId: string }) => t.threadId === 'cmsg_thread2')?.lastActivityAt).toBe(ago(0.5 * HOUR));
  });

  it('scrubs titles (no phone numbers or emails reach the ledger)', () => {
    const [t] = normalizeThreads({ sessions: [session(1, { title: 'Call +919876543210 about it' })] });
    expect(t.title).not.toContain('9876543210');
  });

  it('returns [] for an unavailable tool result', () => {
    expect(normalizeThreads({ unavailable: true })).toEqual([]);
    expect(normalizeThreads(null)).toEqual([]);
  });
});

describe('normalizeProjectPrs and normalizeArtifacts', () => {
  it('normalises project PRs with the session key suffix', () => {
    const [p] = normalizeProjectPrs({
      pull_requests: [{ session_id: 'session_01SESSION1', number: 483, title: 'Batch B', state: 'merged', url: 'https://github.com/o/r/pull/483', head_ref: 'claude/x' }],
    });
    expect(p).toEqual({ n: 483, title: 'Batch B', state: 'merged', url: 'https://github.com/o/r/pull/483', sessionKey: '01SESSION1', headRef: 'claude/x' });
  });

  it('normalises artifacts', () => {
    const [a] = normalizeArtifacts({ artifacts: [{ artifact_id: 'a-1', url: 'https://claude.ai/artifact/X', title: 'Plan', updated_at: ago(HOUR) }] });
    expect(a).toEqual({ id: 'a-1', url: 'https://claude.ai/artifact/X', title: 'Plan', updatedAt: ago(HOUR) });
  });

  it('toolsAvailable is false only for a missing or unavailable result', () => {
    expect(toolsAvailable({ threads: { sessions: [] }, prs: { unavailable: true }, artifacts: undefined })).toEqual({ threads: true, prs: false, artifacts: false });
  });
});

describe('wsKeyForThread', () => {
  it('uses the cursor mapping when there is one (stable across title renames)', () => {
    const [t] = normalizeThreads({ sessions: [session(1, { title: 'Renamed title' })] });
    expect(wsKeyForThread(t, { threads: { cmsg_thread1: { ws: 'batch-b' } } })).toBe('batch-b');
  });

  it('falls back to the slug of the title', () => {
    const [t] = normalizeThreads({ sessions: [session(1, { title: "Sam's customer flow: feedback!" })] });
    expect(wsKeyForThread(t, {})).toBe('sam-s-customer-flow-feedback');
    expect(wsKeyForThread(t, { threads: {} })).toBe(wsKeyForThread(t, undefined));
  });

  it('slugify caps the length and gives a hash key for an empty title', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(48);
    const [t] = normalizeThreads({ sessions: [session(1, { title: '!!!' })] });
    const key = wsKeyForThread(t, {});
    expect(key).toMatch(/^thread-[0-9a-f]{8}$/);
    expect(wsKeyForThread(t, {})).toBe(key);
  });
});

describe('deriveWsFacts', () => {
  const threads = normalizeThreads({
    sessions: [
      session(1, { title: 'Batch B build', status_bucket: 'working' }),
      session(5, { thread_id: 'cmsg_thread1b', session_id: 'cse_01SESSION1b', title: 'Batch B review', status_bucket: 'blocked' }),
      session(2, { title: 'Ledger', thread_id: ROUTINE, session_id: 'cse_01ROUTINE', last_activity_at: ago(0) }),
    ],
  });
  const cursors = { threads: { cmsg_thread1: { ws: 'batch-b' }, cmsg_thread1b: { ws: 'batch-b' }, [ROUTINE]: { ws: 'ledger' } } };
  const projectPrs = normalizeProjectPrs({
    pull_requests: [
      { session_id: 'session_01SESSION1', number: 483, title: 'Batch B: final title', state: 'merged', url: 'u' },
      { session_id: 'session_01SESSION1b', number: 484, title: 'Batch B follow-up', state: 'open', url: 'u' },
      { session_id: 'session_01NOBODY', number: 485, title: 'Orphan', state: 'open', url: 'u' },
    ],
  });
  const ghPrs = { 483: { state: 'merged', mergedAt: ago(3 * HOUR), title: 'Batch B (WIP)' } };
  const docs = { 'art-1': { title: 'Batch B Test Guide', url: 'https://claude.ai/artifact/G', ws: 'batch-b' }, 'art-2': { title: 'Other', url: 'x', ws: null } };

  it('groups threads by ws key and attaches PRs via the session id suffix', () => {
    const { facts } = deriveWsFacts({ threads, projectPrs, ghPrs, docs, cursors, prevWs: {}, routineThreadId: ROUTINE });
    expect(facts['batch-b'].threadIds).toEqual(['cmsg_thread1', 'cmsg_thread1b']);
    expect(facts['batch-b'].prs).toEqual([
      { n: 483, state: 'merged', title: 'Batch B: final title', mergedAt: ago(3 * HOUR) },
      { n: 484, state: 'open', title: 'Batch B follow-up', mergedAt: null },
    ]);
    expect(facts['batch-b'].artifacts).toEqual([{ id: 'art-1', url: 'https://claude.ai/artifact/G', title: 'Batch B Test Guide' }]);
  });

  it('bucket is the most urgent one (blocked first); lastActivityAt is the newest; resolved only when all are', () => {
    const { facts } = deriveWsFacts({ threads, projectPrs, ghPrs, docs, cursors, prevWs: {}, routineThreadId: ROUTINE });
    expect(facts['batch-b'].bucket).toBe('blocked');
    expect(facts['batch-b'].lastActivityAt).toBe(ago(1 * HOUR));
    expect(facts['batch-b'].resolved).toBe(false);
  });

  it("ignores the routine thread's own activity time (it changes every hour)", () => {
    const { facts } = deriveWsFacts({ threads, projectPrs, ghPrs, docs, cursors, prevWs: {}, routineThreadId: ROUTINE });
    expect(facts.ledger.threadIds).toEqual([ROUTINE]);
    expect(facts.ledger.lastActivityAt).toBeNull();
  });

  it('keeps earlier PRs that dropped off the project PR list', () => {
    const prevWs = { 'batch-b': { facts: { prs: [{ n: 470, state: 'merged', title: 'Old', mergedAt: ago(200 * HOUR) }] } } };
    const { facts } = deriveWsFacts({ threads, projectPrs, ghPrs, docs, cursors, prevWs, routineThreadId: ROUTINE });
    expect(facts['batch-b'].prs.map((p: { n: number }) => p.n)).toEqual([470, 483, 484]);
  });

  it('reports unmapped threads with their slug key', () => {
    const t2 = normalizeThreads({ sessions: [session(7, { title: 'New idea' })] });
    const { facts, unmapped } = deriveWsFacts({ threads: t2, projectPrs: [], ghPrs: {}, docs: {}, cursors: {}, prevWs: {}, routineThreadId: ROUTINE });
    expect(unmapped).toEqual([{ threadId: 'cmsg_thread7', key: 'new-idea' }]);
    expect(facts['new-idea'].threadIds).toEqual(['cmsg_thread7']);
  });
});

describe('stubWs', () => {
  it('is deterministic: working, needsCuration, named after the thread', () => {
    const [t] = normalizeThreads({ sessions: [session(7, { title: 'New idea' })] });
    const facts = { threadIds: ['cmsg_thread7'], bucket: 'working', resolved: false, lastActivityAt: ago(7 * HOUR), prs: [], artifacts: [] };
    const a = stubWs('new-idea', t, facts, nowIso);
    expect(a).toEqual({
      key: 'new-idea',
      name: 'New idea',
      status: 'working',
      summary: '',
      nextStep: '',
      waitingOn: 'none',
      facts,
      startedAt: t.createdAt,
      needsCuration: true,
      createdAt: nowIso,
      updatedAt: nowIso,
      prevStatus: null,
      statusChangedAt: nowIso,
      evidence: [],
    });
    expect(stubWs('new-idea', t, facts, nowIso)).toEqual(a);
  });
});

describe('changedThreads', () => {
  const threads = normalizeThreads({
    sessions: [session(1), session(2), session(3), session(4), session(5), session(6), session(7), session(8), { ...session(0), thread_id: ROUTINE }],
  });

  it('lists threads with activity after their cursor, newest first, and excludes the routine thread', () => {
    const cursors = { threads: { cmsg_thread1: { lastAt: ago(0.5 * HOUR), lastMsgId: 'm1' }, cmsg_thread2: { lastAt: ago(10 * HOUR), lastMsgId: 'm2' } } };
    const r = changedThreads(threads, cursors, ROUTINE, 3, CURATE_BYTE_BUDGET);
    expect(r.selected.map((t: { threadId: string }) => t.threadId)).toEqual(['cmsg_thread2', 'cmsg_thread3', 'cmsg_thread4']);
    expect(r.selected[0].stopAt).toBe('m2');
    expect(r.selected[1].stopAt).toBeNull();
    expect(r.carried).toEqual(['cmsg_thread5', 'cmsg_thread6', 'cmsg_thread7', 'cmsg_thread8']);
    expect(r.selected.some((x: { threadId: string }) => x.threadId === ROUTINE)).toBe(false);
    expect(r.carried).not.toContain(ROUTINE);
  });

  it('defaults to the 6-thread cap', () => {
    expect(CURATE_THREAD_CAP).toBe(6);
    const r = changedThreads(threads, {}, ROUTINE);
    expect(r.selected).toHaveLength(6);
    expect(r.carried).toHaveLength(2);
  });

  it('stops at the byte budget but always takes at least one thread', () => {
    const r = changedThreads(threads, {}, ROUTINE, 6, THREAD_EST_BYTES * 2);
    expect(r.selected).toHaveLength(2);
    const one = changedThreads(threads, {}, ROUTINE, 6, 10);
    expect(one.selected).toHaveLength(1);
    expect(one.carried).toHaveLength(7);
  });
});

describe('curatePlan (the quiet-hour skip)', () => {
  const threads = normalizeThreads({
    sessions: [session(1), session(2), session(3), session(4), session(5), session(6), session(7), session(8), { ...session(0), thread_id: ROUTINE }],
  });
  const digest = inputsDigest({ threads, routineThreadId: ROUTINE });
  // After a run that read the 6 newest threads: their cursors sit at their activity time.
  const afterRun = { threads: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`cmsg_thread${n}`, { lastAt: ago(n * HOUR), lastMsgId: `m${n}` }])) };

  it('does not skip while carried threads wait, even when the digest is unchanged', () => {
    const r = curatePlan({ threads, cursors: afterRun, routineThreadId: ROUTINE, digest, prevDigest: digest, reconcile: false });
    expect(r.skip).toBe(false);
    expect(r.selected.map((t: { threadId: string }) => t.threadId)).toEqual(['cmsg_thread7', 'cmsg_thread8']);
    expect(r.carried).toEqual([]);
  });

  it('skips when the digest is unchanged, no reconcile is due and every thread is read', () => {
    const all = { threads: { ...afterRun.threads, cmsg_thread7: { lastAt: ago(7 * HOUR) }, cmsg_thread8: { lastAt: ago(8 * HOUR) } } };
    expect(curatePlan({ threads, cursors: all, routineThreadId: ROUTINE, digest, prevDigest: digest, reconcile: false })).toEqual({ skip: true, selected: [], carried: [] });
    expect(curatePlan({ threads, cursors: all, routineThreadId: ROUTINE, digest, prevDigest: digest, reconcile: true }).skip).toBe(false);
    expect(curatePlan({ threads, cursors: all, routineThreadId: ROUTINE, digest, prevDigest: 'other', reconcile: false }).skip).toBe(false);
  });

  it('caps the selection like changedThreads', () => {
    const r = curatePlan({ threads, cursors: {}, routineThreadId: ROUTINE, digest, prevDigest: null, reconcile: false });
    expect(r.selected).toHaveLength(CURATE_THREAD_CAP);
    expect(r.carried).toHaveLength(2);
  });
});

describe('docsRows', () => {
  const arts = normalizeArtifacts({
    artifacts: [
      { artifact_id: 'a-new', url: 'https://claude.ai/artifact/N', title: 'New plan', updated_at: ago(HOUR) },
      { artifact_id: 'a-old', url: 'https://claude.ai/artifact/O', title: 'Renamed', updated_at: ago(2 * HOUR) },
      { artifact_id: 'a-same', url: 'https://claude.ai/artifact/S', title: 'Same', updated_at: ago(5 * HOUR) },
    ],
  });
  const existing = {
    'a-old': { title: 'Old name', url: 'https://claude.ai/artifact/O', kind: 'plan', status: 'accepted', ws: 'batch-b', updatedAt: ago(30 * HOUR), firstSeenAt: ago(40 * HOUR) },
    'a-same': { title: 'Same', url: 'https://claude.ai/artifact/S', kind: 'guide', status: 'current', ws: 'x', updatedAt: ago(5 * HOUR), firstSeenAt: ago(9 * HOUR) },
  };

  it('adds new rows, refreshes title and updatedAt, keeps curator fields, skips unchanged rows', () => {
    const rows = docsRows(arts, existing, nowIso);
    expect(rows).toEqual([
      { id: 'a-new', isNew: true, data: { title: 'New plan', url: 'https://claude.ai/artifact/N', kind: 'other', status: 'current', ws: null, updatedAt: ago(HOUR), firstSeenAt: nowIso } },
      { id: 'a-old', isNew: false, data: { ...existing['a-old'], title: 'Renamed', updatedAt: ago(2 * HOUR) } },
    ]);
    // Re-run against the result: nothing to write.
    const after = { ...existing, 'a-new': rows[0].data, 'a-old': rows[1].data };
    expect(docsRows(arts, after, nowIso)).toEqual([]);
  });
});

describe('inputsDigest', () => {
  const base = {
    threads: normalizeThreads({ sessions: [session(1), session(2)] }),
    routineThreadId: ROUTINE,
    memorySha256: 'abc',
    projectPrs: [{ n: 1, state: 'open' }, { n: 2, state: 'merged' }],
    artifacts: [{ id: 'a', updatedAt: ago(1) }, { id: 'b', updatedAt: ago(2) }],
    ackIds: ['t1--1', 't2--2'],
    inboxIds: ['n-1'],
  };

  it('is a sha256 hex', () => {
    expect(inputsDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable under reordering of every list', () => {
    const shuffled = {
      ...base,
      threads: [...base.threads].reverse(),
      projectPrs: [...base.projectPrs].reverse(),
      artifacts: [...base.artifacts].reverse(),
      ackIds: [...base.ackIds].reverse(),
    };
    expect(inputsDigest(shuffled)).toBe(inputsDigest(base));
  });

  it('ignores the routine thread', () => {
    const withRoutine = { ...base, threads: [...base.threads, ...normalizeThreads({ sessions: [{ ...session(0), thread_id: ROUTINE }] })] };
    expect(inputsDigest(withRoutine)).toBe(inputsDigest(base));
  });

  it('changes when an input changes', () => {
    const d = inputsDigest(base);
    expect(inputsDigest({ ...base, memorySha256: 'abd' })).not.toBe(d);
    expect(inputsDigest({ ...base, ackIds: [...base.ackIds, 't3--3'] })).not.toBe(d);
    expect(inputsDigest({ ...base, inboxIds: [] })).not.toBe(d);
    expect(inputsDigest({ ...base, projectPrs: [{ n: 1, state: 'merged' }, { n: 2, state: 'merged' }] })).not.toBe(d);
    const t = [...base.threads];
    t[0] = { ...t[0], bucket: 'blocked' };
    expect(inputsDigest({ ...base, threads: t })).not.toBe(d);
  });

  it('hashes with node:crypto sha256 (no npm imports)', () => {
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});

describe('v2 core modules use Node built-ins only', () => {
  it('imports nothing but node: modules and local ./ files (the routine runs them without npm install)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['project-core.mjs', 'curate-core.mjs', 'check-core.mjs']) {
      const src = readFileSync(new URL(`../scripts/tracker/${f}`, import.meta.url), 'utf8');
      const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) expect(s.startsWith('node:') || s.startsWith('./'), `${f} imports ${s}`).toBe(true);
    }
  });
});
