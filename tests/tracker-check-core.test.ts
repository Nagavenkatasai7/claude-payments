import { describe, expect, it } from 'vitest';
import {
  CURATOR_STALE_MS,
  DOC_CAP_AMBER,
  DOC_CAP_RED,
  ENGINE_STALE_MS,
  HEADLINE_BEHIND_MS,
  MEMORY_DRIFT_MS,
  REJECTED_RATIO_MAX,
  THREAD_DRIFT_AMBER_MS,
  THREAD_DRIFT_RED_MS,
  TODO_STALE_MS,
  UNMAPPED_MERGE_GRACE_MS,
  checkLedger,
  healthDoc,
} from '../scripts/tracker/check-core.mjs';

type Any = any;

// Relative dates only (CLAUDE.md fixture rule): every time is an offset from NOW.
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const now = new Date(NOW).toISOString();
const T1 = 'cmsg_T1batchb';
const T2 = 'cmsg_T2fb';
const ROUTINE = 'cmsg_routine';

// A healthy ledger: no problem fires.
function healthy(): Any {
  return {
    now,
    cutoverAt: ago(2 * DAY),
    state: { syncedAt: ago(10 * MIN), openProgramPrs: 0, programPrsFromThreads: 0 },
    headline: { asOf: ago(1 * HOUR) },
    ws: {
      'batch-b': { facts: { threadIds: [T1], prs: [{ n: 482, state: 'merged', title: 'Pay page fixes' }, { n: 483, state: 'merged', title: 'Batch B: order references, payment links' }] } },
      'partner-feedback': { facts: { threadIds: [T2], prs: [] } },
    },
    todo: { 'batch-b-check': { title: 'Check the guide', status: 'open', ws: 'batch-b', threadId: T1, createdAt: ago(3 * DAY), updatedAt: ago(1 * DAY) } },
    decisions: {},
    feed: [
      { id: 'gh-merge-482', data: { at: ago(30 * HOUR), kind: 'merge', refs: { pr: [482] } } },
      { id: 'gh-merge-483', data: { at: ago(3 * HOUR), kind: 'merge', refs: { pr: [483] } } },
      { id: 'gh-ci-1', data: { at: ago(3 * HOUR), kind: 'deploy' } },
    ],
    threads: [
      { threadId: T1, title: 'Batch B build', bucket: 'working', lastActivityAt: ago(2 * HOUR) },
      { threadId: T2, title: 'Partner feedback', bucket: 'completed', lastActivityAt: ago(20 * HOUR) },
      { threadId: ROUTINE, title: 'Ledger sync', bucket: 'working', lastActivityAt: ago(1 * MIN) },
    ],
    cursors: { threads: { [T1]: { ws: 'batch-b', lastAt: ago(2 * HOUR) }, [T2]: { ws: 'partner-feedback', lastAt: ago(20 * HOUR) } }, memory: { readAt: ago(5 * HOUR) } },
    memoryStat: { mtime: ago(6 * HOUR) },
    sync: { routineThreadId: ROUTINE, reconcileAt: ago(10 * HOUR), toolsAvailable: { threads: true, prs: true, artifacts: true } },
    curator: { accepted: 7, rejected: 1 },
    prTitles: { 482: 'Pay page fixes', 483: 'Batch B: order references, payment links' },
    docCount: 1200,
  };
}
const codes = (r: Any) => r.problems.map((p: Any) => p.code);
const find = (r: Any, code: string) => r.problems.filter((p: Any) => p.code === code);

describe('checkLedger: healthy baseline', () => {
  it('reports no problems and ok for a current ledger', () => {
    expect(checkLedger(healthy())).toEqual({ ok: true, problems: [] });
  });

  it('exports the thresholds as constants', () => {
    expect([UNMAPPED_MERGE_GRACE_MS, THREAD_DRIFT_AMBER_MS, THREAD_DRIFT_RED_MS, MEMORY_DRIFT_MS, ENGINE_STALE_MS, CURATOR_STALE_MS, HEADLINE_BEHIND_MS, TODO_STALE_MS]).toEqual([
      2 * HOUR, 3 * HOUR, 6 * HOUR, 26 * HOUR, 90 * MIN, 26 * HOUR, 6 * HOUR, 14 * DAY,
    ]);
    expect([REJECTED_RATIO_MAX, DOC_CAP_AMBER, DOC_CAP_RED]).toEqual([0.3, 18_000, 22_000]);
  });
});

describe('unmapped_merge (red)', () => {
  // Modelled on #483 (Batch B), merged with no workstream listing it.
  it('fires for a merge after cutover, older than 2 h, that no ws lists', () => {
    const f = healthy();
    f.ws['batch-b'].facts.prs = f.ws['batch-b'].facts.prs.filter((p: Any) => p.n !== 483);
    const r = checkLedger(f);
    expect(r.ok).toBe(false);
    expect(find(r, 'unmapped_merge')).toEqual([{ code: 'unmapped_merge', severity: 'red', section: 'workstreams', message: 'PR #483 merged 3 h ago; no workstream lists it', ref: '#483' }]);
  });
  it('does not fire inside the 2 h grace or for a merge before cutover', () => {
    const f = healthy();
    f.ws['batch-b'].facts.prs = [];
    f.feed = [
      { id: 'gh-merge-483', data: { at: ago(UNMAPPED_MERGE_GRACE_MS - 5 * MIN), kind: 'merge', refs: { pr: [483] } } },
      { id: 'gh-merge-300', data: { at: ago(3 * DAY), kind: 'merge', refs: { pr: [300] } } },
    ];
    expect(codes(checkLedger(f))).not.toContain('unmapped_merge');
  });
  it('counts a PR the curator attached (ws.prsCurated) as mapped', () => {
    const f = healthy();
    f.ws['batch-b'].facts.prs = f.ws['batch-b'].facts.prs.filter((p: Any) => p.n !== 483);
    f.ws['batch-b'].prsCurated = [483];
    expect(codes(checkLedger(f))).not.toContain('unmapped_merge');
  });
});

describe('thread_drift (amber after 3 h, red after 6 h)', () => {
  it('fires amber when activity is newer than the cursor for more than 3 h', () => {
    const f = healthy();
    f.threads[1].lastActivityAt = ago(4 * HOUR);
    const [p] = find(checkLedger(f), 'thread_drift');
    expect(p).toMatchObject({ severity: 'amber', section: 'workstreams', ref: T2 });
    expect(p.message).toBe('Partner feedback has messages the ledger has not read (4 h)');
  });
  it('fires red after 6 h, and for a thread with no cursor at all', () => {
    const f = healthy();
    f.threads[1].lastActivityAt = ago(7 * HOUR);
    f.threads.push({ threadId: 'cmsg_new', title: 'New thread', bucket: 'working', lastActivityAt: ago(8 * HOUR) });
    const ps = find(checkLedger(f), 'thread_drift');
    expect(ps.map((p: Any) => [p.ref, p.severity])).toEqual([[T2, 'red'], ['cmsg_new', 'red']]);
  });
  it('does not fire under 3 h, when the cursor is current, or for the routine thread', () => {
    const f = healthy();
    f.threads[1].lastActivityAt = ago(2 * HOUR);
    f.threads[2].lastActivityAt = ago(10 * HOUR);
    expect(codes(checkLedger(f))).not.toContain('thread_drift');
  });
});

describe('memory_drift', () => {
  it('fires when MEMORY.md changed more than 26 h after the last read', () => {
    const f = healthy();
    f.cursors.memory.readAt = ago(40 * HOUR);
    f.memoryStat.mtime = ago(10 * HOUR);
    expect(find(checkLedger(f), 'memory_drift')[0]).toMatchObject({ severity: 'amber', section: 'sync' });
  });
  it('does not fire within 26 h', () => {
    const f = healthy();
    f.cursors.memory.readAt = ago(30 * HOUR);
    f.memoryStat.mtime = ago(10 * HOUR);
    expect(codes(checkLedger(f))).not.toContain('memory_drift');
  });
});

describe('engine_stale', () => {
  it('fires when meta/state.syncedAt is older than 90 min', () => {
    const f = healthy();
    f.state.syncedAt = ago(ENGINE_STALE_MS + MIN);
    const r = checkLedger(f);
    expect(find(r, 'engine_stale')[0]).toMatchObject({ severity: 'red', section: 'release' });
    expect(r.ok).toBe(false);
  });
  it('does not fire within 90 min', () => {
    const f = healthy();
    f.state.syncedAt = ago(ENGINE_STALE_MS - MIN);
    expect(codes(checkLedger(f))).not.toContain('engine_stale');
  });
});

describe('curator_stale', () => {
  it('fires when there was no reconcile in 26 h (or never)', () => {
    const f = healthy();
    f.sync.reconcileAt = ago(27 * HOUR);
    expect(find(checkLedger(f), 'curator_stale')[0]).toMatchObject({ severity: 'red', section: 'sync' });
    delete f.sync.reconcileAt;
    expect(codes(checkLedger(f))).toContain('curator_stale');
  });
  it('does not fire within 26 h', () => {
    const f = healthy();
    f.sync.reconcileAt = ago(25 * HOUR);
    expect(codes(checkLedger(f))).not.toContain('curator_stale');
  });
});

describe('headline_behind', () => {
  it('fires when the newest merge is over 6 h old and the headline predates it', () => {
    const f = healthy();
    f.feed[1].data.at = ago(7 * HOUR);
    f.headline.asOf = ago(9 * HOUR);
    expect(find(checkLedger(f), 'headline_behind')[0]).toMatchObject({ severity: 'amber', section: 'now', ref: '#483' });
  });
  it('does not fire when the headline is newer than the merge, or the merge is under 6 h old', () => {
    const f = healthy();
    f.feed[1].data.at = ago(7 * HOUR);
    f.headline.asOf = ago(6.5 * HOUR);
    expect(codes(checkLedger(f))).not.toContain('headline_behind');
    const g = healthy();
    g.headline.asOf = ago(20 * HOUR); // merge is 3 h old: the curator still has time
    expect(codes(checkLedger(g))).not.toContain('headline_behind');
  });
});

describe('blocked_unexplained', () => {
  it('fires for a blocked thread with no open decision or to-do', () => {
    const f = healthy();
    f.threads[1].bucket = 'blocked';
    expect(find(checkLedger(f), 'blocked_unexplained')[0]).toMatchObject({ severity: 'red', section: 'decisions', ref: T2 });
  });
  it('does not fire when an open decision or an open to-do covers the thread or its ws', () => {
    const f = healthy();
    f.threads[1].bucket = 'blocked';
    f.decisions = { 'fb-go': { status: 'open', threadId: T2, ws: 'partner-feedback' } };
    expect(codes(checkLedger(f))).not.toContain('blocked_unexplained');
    const g = healthy();
    g.threads[0].bucket = 'blocked';
    expect(codes(checkLedger(g))).not.toContain('blocked_unexplained'); // batch-b-check is open
    const h = healthy();
    h.threads[1].bucket = 'blocked';
    h.decisions = { 'fb-old': { status: 'decided', threadId: T2 } };
    expect(codes(checkLedger(h))).toContain('blocked_unexplained');
  });
});

describe('todo_stale (amber)', () => {
  it('fires for an open to-do with no update in 14 days', () => {
    const f = healthy();
    f.todo['batch-b-check'].updatedAt = ago(15 * DAY);
    expect(find(checkLedger(f), 'todo_stale')[0]).toMatchObject({ severity: 'amber', section: 'todo', ref: 'batch-b-check' });
  });
  it('does not fire for a recent update or a closed to-do', () => {
    const f = healthy();
    f.todo['batch-b-check'].updatedAt = ago(13 * DAY);
    expect(codes(checkLedger(f))).not.toContain('todo_stale');
    f.todo['batch-b-check'] = { ...f.todo['batch-b-check'], updatedAt: ago(30 * DAY), status: 'done' };
    expect(codes(checkLedger(f))).not.toContain('todo_stale');
  });
});

describe('pr_title_drift (amber)', () => {
  it('fires when a ws shows an older PR title than the current one', () => {
    const f = healthy();
    f.ws['batch-b'].facts.prs[1].title = 'Batch B (WIP)';
    expect(find(checkLedger(f), 'pr_title_drift')[0]).toMatchObject({ severity: 'amber', section: 'workstreams', ref: '#483' });
  });
  it('does not fire when titles match or the current title is unknown', () => {
    const f = healthy();
    f.prTitles = {};
    f.ws['batch-b'].facts.prs[1].title = 'Batch B (WIP)';
    expect(codes(checkLedger(f))).not.toContain('pr_title_drift');
  });
});

describe('pr_count_mismatch (amber)', () => {
  it('fires when openProgramPrs differs from programPrsFromThreads', () => {
    const f = healthy();
    f.state.openProgramPrs = 2;
    expect(find(checkLedger(f), 'pr_count_mismatch')[0]).toMatchObject({ severity: 'amber', section: 'release' });
  });
  it('does not fire when there is no project snapshot (null)', () => {
    const f = healthy();
    f.state.openProgramPrs = 2;
    f.state.programPrsFromThreads = null;
    expect(codes(checkLedger(f))).not.toContain('pr_count_mismatch');
  });
});

describe('threads_unreadable (amber)', () => {
  it('fires when a hearthbot tool is missing', () => {
    const f = healthy();
    f.sync.toolsAvailable.threads = false;
    const [p] = find(checkLedger(f), 'threads_unreadable');
    expect(p).toMatchObject({ severity: 'amber', section: 'sync' });
    expect(p.message).toContain('threads');
  });
  it('prefers this run\'s tools over meta/sync and does not fire when all answer', () => {
    const f = healthy();
    f.sync.toolsAvailable.threads = false;
    f.tools = { threads: true, prs: true, artifacts: true };
    expect(codes(checkLedger(f))).not.toContain('threads_unreadable');
  });
});

describe('rejected_ratio (amber)', () => {
  it('fires when more than 30% of ops were rejected', () => {
    const f = healthy();
    f.curator = { accepted: 6, rejected: 4 };
    expect(find(checkLedger(f), 'rejected_ratio')[0]).toMatchObject({ severity: 'amber', section: 'sync' });
  });
  it('does not fire at 30% or with no ops', () => {
    const f = healthy();
    f.curator = { accepted: 7, rejected: 3 };
    expect(codes(checkLedger(f))).not.toContain('rejected_ratio');
    f.curator = { accepted: 0, rejected: 0 };
    expect(codes(checkLedger(f))).not.toContain('rejected_ratio');
  });
});

describe('doc_cap (amber at 18,000, red at 22,000)', () => {
  it('fires amber at 18,000 docs and red at 22,000', () => {
    const f = healthy();
    f.docCount = DOC_CAP_AMBER;
    expect(find(checkLedger(f), 'doc_cap')[0].severity).toBe('amber');
    f.docCount = DOC_CAP_RED;
    expect(find(checkLedger(f), 'doc_cap')[0].severity).toBe('red');
  });
  it('does not fire under 18,000', () => {
    const f = healthy();
    f.docCount = DOC_CAP_AMBER - 1;
    expect(codes(checkLedger(f))).not.toContain('doc_cap');
  });
});

describe('problems: order, ok and scrubbing', () => {
  it('lists red before amber, ok is false only with a red problem, messages stay under 200 chars', () => {
    const f = healthy();
    f.todo['batch-b-check'].updatedAt = ago(20 * DAY);
    expect(checkLedger(f).ok).toBe(true); // amber only
    f.ws['batch-b'].facts.prs = [];
    f.threads[1].title = `Call +919876543210 ${'x'.repeat(300)}`;
    f.threads[1].lastActivityAt = ago(4 * HOUR);
    const r = checkLedger(f);
    expect(r.ok).toBe(false);
    const sev = r.problems.map((p: Any) => p.severity);
    expect(sev.indexOf('amber')).toBeGreaterThan(sev.lastIndexOf('red'));
    for (const p of r.problems) expect(p.message.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(r)).not.toContain('9876543210');
  });
});

describe('healthDoc', () => {
  it('builds meta/health with prevCodes and reports whether the codes changed', () => {
    const f = healthy();
    f.state.syncedAt = ago(2 * HOUR);
    const result = checkLedger(f);
    const inputs = { newestMergeAt: ago(3 * HOUR), threadsMaxActivityAt: ago(2 * HOUR), memoryMtime: ago(6 * HOUR), engineSyncedAt: ago(2 * HOUR), docCount: 1200 };
    const first = healthDoc({ result, prev: { problems: [] }, now, inputs });
    expect(first.doc).toEqual({ at: now, ok: false, problems: result.problems, prevCodes: [], inputs });
    expect(first.changed).toBe(true);
    expect(first.codes).toEqual(['engine_stale']);
    const second = healthDoc({ result, prev: first.doc, now, inputs });
    expect(second.doc.prevCodes).toEqual(['engine_stale']);
    expect(second.changed).toBe(false);
  });
});
