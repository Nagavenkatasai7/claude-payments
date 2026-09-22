import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIRST_PROGRAM_PR,
  LEGACY_FIX_MAP,
  buildState,
  currentFixStatuses,
  deriveFixStates,
  diffAgainstExisting,
  eventIds,
  fixesForPr,
  hookToJournalEntries,
  isProgramPr,
  journalToEvents,
  legacyEventKeys,
  normalizePr,
  normalizeRun,
  parseProgramFix,
  planSync,
  prDocs,
  prEvents,
  rank,
  runEvents,
  scrub,
  sliceJournal,
  splitBatches,
  stopDecision,
  batchWrites,
} from '../scripts/tracker/sync-core.mjs';

const REPO_URL = 'https://github.com/Nagavenkatasai7/claude-payments';
const SHA_A = 'aaaaaaa1111111111111111111111111111111111'.slice(0, 40);
const SHA_B = 'bbbbbbb2222222222222222222222222222222222'.slice(0, 40);
const SHA_C = 'ccccccc3333333333333333333333333333333333'.slice(0, 40);

type ApiPrOver = Record<string, unknown>;
const apiPr = (n: number, over: ApiPrOver = {}) => ({
  number: n,
  title: `PR ${n} title`,
  html_url: `${REPO_URL}/pull/${n}`,
  state: 'open',
  created_at: '2026-09-20T10:00:00Z',
  closed_at: null,
  merged_at: null,
  merge_commit_sha: 'fffffff0000000000000000000000000000000000'.slice(0, 40),
  body: '',
  user: { login: 'Nagavenkatasai7' },
  head: { ref: `fix/x/pr-${n}` },
  ...over,
});
const merged = (n: number, sha: string, at: string, body = '') =>
  apiPr(n, { state: 'closed', merged_at: at, closed_at: at, merge_commit_sha: sha, body });
const open = (n: number, body = '', createdAt = '2026-09-20T10:00:00Z') => apiPr(n, { body, created_at: createdAt });
const closed = (n: number, at: string) => apiPr(n, { state: 'closed', closed_at: at });

const apiRun = (id: number, sha: string, over: Record<string, unknown> = {}) => ({
  id,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: `${REPO_URL}/actions/runs/${id}`,
  created_at: '2026-09-21T10:00:00Z',
  updated_at: '2026-09-21T10:05:00Z',
  ...over,
});

describe('parseProgramFix', () => {
  it('reads a single fix number from its own line', () => {
    expect(parseProgramFix('Summary\n\nProgram-Fix: 6\n')).toEqual([6]);
  });
  it('reads a comma or space separated list', () => {
    expect(parseProgramFix('Program-Fix: 11, 6')).toEqual([6, 11]);
    expect(parseProgramFix('Program-Fix: 9 18')).toEqual([9, 18]);
  });
  it('treats "none (tooling)" as no fix', () => {
    expect(parseProgramFix('Program-Fix: none (tooling)')).toEqual([]);
  });
  it('unions several trailer lines, deduped and sorted', () => {
    expect(parseProgramFix('Program-Fix: 13\r\nmore\r\nProgram-Fix: 4, 13\r\n')).toEqual([4, 13]);
  });
  it('allows a trailing note, a # prefix and any letter case', () => {
    expect(parseProgramFix('Program-Fix: 13 (FX fails loud)')).toEqual([13]);
    expect(parseProgramFix('program-fix: #7')).toEqual([7]);
  });
  it('ignores a mention that is not on its own line, and empty bodies', () => {
    expect(parseProgramFix('see Program-Fix: 4 in the other PR')).toEqual([]);
    expect(parseProgramFix(null)).toEqual([]);
    expect(parseProgramFix(undefined)).toEqual([]);
    expect(parseProgramFix('')).toEqual([]);
  });
});

describe('fixesForPr and PR scope', () => {
  it('reuses the legacy map from snapshot.mjs and unions it with the trailer', () => {
    expect(LEGACY_FIX_MAP).toEqual({ 242: [1], 243: [3], 244: [2], 246: [3], 247: [2], 248: [2] });
    expect(fixesForPr(242, '')).toEqual([1]);
    expect(fixesForPr(243, 'Program-Fix: 5')).toEqual([3, 5]);
    expect(fixesForPr(300, 'Program-Fix: 9')).toEqual([9]);
  });
  it('keeps program PRs only: number >= 237, no dependabot author or branch, no loop/ branch', () => {
    expect(FIRST_PROGRAM_PR).toBe(237);
    expect(isProgramPr(normalizePr(apiPr(237)))).toBe(true);
    expect(isProgramPr(normalizePr(apiPr(236)))).toBe(false);
    expect(isProgramPr(normalizePr(apiPr(250, { user: { login: 'dependabot[bot]' } })))).toBe(false);
    expect(isProgramPr(normalizePr(apiPr(251, { head: { ref: 'dependabot/npm_and_yarn/next-16' } })))).toBe(false);
    expect(isProgramPr(normalizePr(apiPr(252, { head: { ref: 'loop/overnight-3' } })))).toBe(false);
  });
  it('normalizes state and only reports a merge sha for merged PRs', () => {
    expect(normalizePr(open(260))).toMatchObject({ number: 260, state: 'open', mergeSha: null, url: `${REPO_URL}/pull/260` });
    expect(normalizePr(merged(256, SHA_A, '2026-09-16T19:33:30Z'))).toMatchObject({ state: 'merged', mergeSha: 'aaaaaaa', mergedAt: '2026-09-16T19:33:30Z' });
    expect(normalizePr(closed(258, '2026-09-21T01:00:00Z'))).toMatchObject({ state: 'closed', mergeSha: null, closedAt: '2026-09-21T01:00:00Z' });
  });
});

describe('rank', () => {
  it('orders open < planned < in_progress < in_review < merged < done', () => {
    const order = ['open', 'planned', 'in_progress', 'in_review', 'merged', 'done'];
    for (let i = 1; i < order.length; i++) expect(rank(order[i])).toBeGreaterThan(rank(order[i - 1]));
    expect(rank('something-else')).toBeLessThan(rank('open'));
  });
});

describe('currentFixStatuses', () => {
  it('takes the latest fixstate doc per fix and falls back to fixes/fix-NN.status', () => {
    const cur = currentFixStatuses(
      [
        { fix: 4, status: 'in_review', at: '2026-09-16T18:41:00Z', prs: [255] },
        { fix: 4, status: 'merged', at: '2026-09-16T19:02:30Z', prs: [255] },
        { fix: 6, status: 'done', at: '2026-09-17T00:00:00Z', prs: [256], source: 'verification' },
      ],
      [
        { fix: 4, status: 'planned', prs: [] },
        { fix: 9, status: 'planned', prs: [240] },
        { fix: 6, status: 'merged', prs: [256] },
      ],
    );
    expect(cur.get(4)).toMatchObject({ status: 'merged' });
    expect(cur.get(6)).toMatchObject({ status: 'done' });
    expect(cur.get(9)).toMatchObject({ status: 'planned', prs: [240] });
  });
});

describe('deriveFixStates', () => {
  const prs = (list: ReturnType<typeof apiPr>[]) => list.map(normalizePr);

  it('writes in_review for an OPEN PR carrying Program-Fix, with ref pr<n>', () => {
    const docs = deriveFixStates(prs([open(261, 'Program-Fix: 13', '2026-09-21T22:14:53Z')]), new Map());
    expect(docs).toEqual([
      {
        collection: 'fixstate',
        id: 'fix-13-in_review-pr261',
        data: { fix: 13, status: 'in_review', at: '2026-09-21T22:14:53Z', prs: [261], mergeSha: null, source: 'github' },
      },
    ]);
  });

  it('writes merged for a MERGED PR, with ref = merge sha7 and a zero-padded fix id', () => {
    const docs = deriveFixStates(prs([merged(255, SHA_A, '2026-09-16T19:02:30Z', 'Program-Fix: 4')]), new Map());
    expect(docs.map((d: { id: string }) => d.id)).toEqual(['fix-04-merged-aaaaaaa']);
    expect(docs[0].data).toEqual({ fix: 4, status: 'merged', at: '2026-09-16T19:02:30Z', prs: [255], mergeSha: 'aaaaaaa', source: 'github' });
  });

  it('never writes done, whatever the inputs', () => {
    const input = prs([merged(255, SHA_A, '2026-09-16T19:02:30Z', 'Program-Fix: 4'), open(262, 'Program-Fix: 4')]);
    const docs = [
      ...deriveFixStates(input, new Map()),
      ...deriveFixStates(input, new Map([[4, { status: 'merged', prs: [] }]])),
      ...deriveFixStates(input, new Map([[4, { status: 'done', prs: [] }]])),
    ];
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) expect(d.data.status).not.toBe('done');
  });

  it('never writes a lower status than the fix already has', () => {
    const openPr = prs([open(262, 'Program-Fix: 4', '2026-09-21T00:00:00Z')]);
    expect(deriveFixStates(openPr, new Map([[4, { status: 'merged', prs: [255] }]]))).toEqual([]);
    expect(deriveFixStates(openPr, new Map([[4, { status: 'done', prs: [255] }]]))).toEqual([]);
    const mergedPr = prs([merged(255, SHA_A, '2026-09-16T19:02:30Z', 'Program-Fix: 4')]);
    expect(deriveFixStates(mergedPr, new Map([[4, { status: 'done', prs: [255] }]]))).toEqual([]);
  });

  it('allows an equal status with a new ref (a follow-up merge) and unions the PR list', () => {
    const docs = deriveFixStates(
      prs([merged(270, SHA_B, '2026-09-25T00:00:00Z', 'Program-Fix: 4')]),
      new Map([[4, { status: 'merged', prs: [255] }]]),
    );
    expect(docs.map((d: { id: string }) => d.id)).toEqual(['fix-04-merged-bbbbbbb']);
    expect(docs[0].data.prs).toEqual([255, 270]);
  });

  it('writes one doc per fix per run: the highest status, then the newest', () => {
    const docs = deriveFixStates(
      prs([
        merged(243, SHA_A, '2026-09-15T10:00:00Z'), // legacy map: fix 3
        merged(246, SHA_B, '2026-09-15T12:00:00Z'), // legacy map: fix 3
        open(280, 'Program-Fix: 3', '2026-09-22T00:00:00Z'),
      ]),
      new Map([[3, { status: 'planned', prs: [] }]]),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('fix-03-merged-bbbbbbb');
    expect(docs[0].data.prs).toEqual([243, 246, 280]);
  });

  it('ignores PRs closed without merge and PRs with no fix', () => {
    expect(deriveFixStates(prs([closed(258, '2026-09-21T01:00:00Z'), open(259)]), new Map())).toEqual([]);
  });

  it('uses the fixes/fix-NN.status fallback for the rank check', () => {
    const cur = currentFixStatuses([], [{ fix: 13, status: 'done', prs: [261] }]);
    expect(deriveFixStates(prs([merged(261, SHA_C, '2026-09-22T00:13:47Z', 'Program-Fix: 13')]), cur)).toEqual([]);
  });
});

describe('deterministic ids and events', () => {
  it('names events by source object, not by time', () => {
    expect(eventIds.prOpen(261)).toBe('gh-pr-open-261');
    expect(eventIds.merge(261)).toBe('gh-merge-261');
    expect(eventIds.prClosed(258)).toBe('gh-pr-closed-258');
    expect(eventIds.ci(35671070038)).toBe('gh-ci-35671070038');
    expect(eventIds.smoke(35669970103)).toBe('gh-smoke-35669970103');
    const line = '{"at":"2026-09-22T00:00:00Z","kind":"decision","title":"x"}';
    expect(eventIds.journal(line)).toBe('j-' + createHash('sha1').update(line).digest('hex').slice(0, 16));
  });

  it('builds open, merge and closed PR events with refs and source github', () => {
    const list = [
      merged(256, SHA_A, '2026-09-16T19:33:30Z', 'Program-Fix: 6'),
      closed(258, '2026-09-21T01:00:00Z'),
      open(261, 'Program-Fix: 13', '2026-09-21T22:14:53Z'),
    ].map(normalizePr);
    const ev = prEvents(list);
    expect(ev.map((e: { id: string }) => e.id)).toEqual([
      'gh-pr-open-256', 'gh-merge-256', 'gh-pr-open-258', 'gh-pr-closed-258', 'gh-pr-open-261',
    ]);
    const m = ev.find((e: { id: string }) => e.id === 'gh-merge-256');
    expect(m?.data).toMatchObject({
      at: '2026-09-16T19:33:30Z', kind: 'merge', actor: 'github', title: 'PR #256 merged',
      refs: { pr: [256], fix: [6], sha: 'aaaaaaa' }, result: 'ok', source: 'github',
    });
    expect(ev.find((e: { id: string }) => e.id === 'gh-pr-open-261')?.data).toMatchObject({ at: '2026-09-21T22:14:53Z', kind: 'pr', actor: 'github', source: 'github' });
    expect(ev.find((e: { id: string }) => e.id === 'gh-pr-closed-258')?.data).toMatchObject({ at: '2026-09-21T01:00:00Z', kind: 'pr', result: 'info' });
    for (const e of ev) expect(e.collection).toBe('events');
  });

  it('builds CI incidents for failed main runs only, and smoke verify/incident events', () => {
    const ci = [
      apiRun(1, SHA_A, { conclusion: 'failure' }),
      apiRun(2, SHA_B),
      apiRun(3, SHA_C, { status: 'in_progress', conclusion: null }),
      apiRun(4, SHA_C, { conclusion: 'cancelled' }),
    ].map(normalizeRun);
    const smoke = [
      apiRun(10, SHA_A),
      apiRun(11, SHA_B, { conclusion: 'failure' }),
      apiRun(12, SHA_C, { status: 'in_progress', conclusion: null }),
      apiRun(13, SHA_C, { event: 'workflow_dispatch' }),
    ].map(normalizeRun);
    const ev = runEvents(ci, smoke);
    expect(ev.map((e: { id: string }) => e.id)).toEqual(['gh-ci-1', 'gh-smoke-10', 'gh-smoke-11']);
    expect(ev[0].data).toMatchObject({ kind: 'incident', actor: 'ci', result: 'failed', source: 'ci', refs: { sha: 'aaaaaaa' } });
    expect(ev[1].data).toMatchObject({ kind: 'verify', actor: 'ci', title: 'Post-deploy smoke green on aaaaaaa', result: 'ok', source: 'ci' });
    expect(ev[2].data).toMatchObject({ kind: 'incident', actor: 'ci', result: 'failed', source: 'ci' });
  });

  it('is deterministic: the same input gives the same docs', () => {
    const list = [merged(256, SHA_A, '2026-09-16T19:33:30Z', 'Program-Fix: 6'), open(261, 'Program-Fix: 13')].map(normalizePr);
    expect(JSON.stringify([...prDocs(list), ...prEvents(list)])).toBe(JSON.stringify([...prDocs(list), ...prEvents(list)]));
  });
});

describe('prDocs', () => {
  it('creates prs/pr-<n> once and a prstate doc for the current state', () => {
    const docs = prDocs([merged(256, SHA_A, '2026-09-16T19:33:30Z', 'Program-Fix: 6'), open(261, 'Program-Fix: 13, 9')].map(normalizePr));
    expect(docs).toEqual([
      { collection: 'prs', id: 'pr-256', data: { number: 256, title: 'PR 256 title', url: `${REPO_URL}/pull/256`, createdAt: '2026-09-20T10:00:00Z', fix: 6 } },
      { collection: 'prstate', id: 'pr-256-merged', data: { number: 256, state: 'merged', at: '2026-09-16T19:33:30Z', mergeSha: 'aaaaaaa', fix: 6 } },
      { collection: 'prs', id: 'pr-261', data: { number: 261, title: 'PR 261 title', url: `${REPO_URL}/pull/261`, createdAt: '2026-09-20T10:00:00Z', fix: [9, 13] } },
      { collection: 'prstate', id: 'pr-261-open', data: { number: 261, state: 'open', at: '2026-09-20T10:00:00Z', mergeSha: null, fix: [9, 13] } },
    ]);
  });
});

describe('diffAgainstExisting and legacy events', () => {
  it('skips docs whose id exists and dedupes within the run', () => {
    const docs = [
      { collection: 'events', id: 'gh-merge-1', data: {} },
      { collection: 'events', id: 'gh-merge-2', data: {} },
      { collection: 'events', id: 'gh-merge-2', data: {} },
      { collection: 'prs', id: 'pr-1', data: {} },
    ];
    const out = diffAgainstExisting(docs, new Set(['events/gh-merge-1']));
    expect(out.map((d: { collection: string; id: string }) => `${d.collection}/${d.id}`)).toEqual(['events/gh-merge-2', 'prs/pr-1']);
  });

  it('skips generated events already recorded by hand or by the old snapshot', () => {
    const keys = legacyEventKeys([
      { id: '20260916T155433-388a79e8', data: { kind: 'merge', title: 'PR #250 merged', at: '2026-09-16T15:54:33Z' } },
      { id: '20260916T171800-pr254-merged', data: { kind: 'merge', title: 'PR #254 merged: outbox leases (fix 11)' } },
      { id: '20260916T165800-pr254-opened', data: { kind: 'plan', title: 'PR #254 opened: outbox leases (fix 11)' } },
      { id: '20260916T190600-smoke-6f78864', data: { kind: 'verify', title: 'Post-deploy smoke green on 6f78864 (fix 4)' } },
      { id: 'gh-merge-999', data: { kind: 'merge', title: 'PR #999 merged' } },
    ]);
    expect([...keys].sort()).toEqual(['merge:250', 'merge:254', 'pr-open:254', 'smoke:6f78864:ok']);
    const list = [merged(254, 'db2804d000000000000000000000000000000000', '2026-09-16T17:18:00Z'), open(261)].map(normalizePr);
    const smoke = [apiRun(7, '6f78864000000000000000000000000000000000'), apiRun(8, '6f78864000000000000000000000000000000000', { conclusion: 'failure' })].map(normalizeRun);
    const out = diffAgainstExisting([...prEvents(list), ...runEvents([], smoke)], new Set(), keys);
    expect(out.map((d: { id: string }) => d.id)).toEqual(['gh-pr-open-261', 'gh-smoke-8']);
  });
});

describe('journal slicing and events', () => {
  const line1 = JSON.stringify({ at: '2026-09-22T01:00:00Z', kind: 'decision', actor: 'owner', title: 'Ship it — café', detail: 'ok' });
  const line2 = JSON.stringify({ at: '2026-09-22T01:05:00Z', kind: 'approval', actor: 'owner', title: 'Approved PR #265', detail: 'd', refs: { pr: [265] } });

  it('reads complete lines after the offset and reports the byte offset after the last one', () => {
    const buf = Buffer.from(`${line1}\n${line2}\n{"partial":`, 'utf8');
    const a = sliceJournal(buf, 0);
    expect(a.lines).toEqual([line1, line2]);
    expect(a.newOffset).toBe(Buffer.byteLength(`${line1}\n${line2}\n`, 'utf8'));
    const b = sliceJournal(buf, Buffer.byteLength(`${line1}\n`, 'utf8'));
    expect(b.lines).toEqual([line2]);
    expect(b.newOffset).toBe(a.newOffset);
    expect(sliceJournal(buf, a.newOffset)).toMatchObject({ lines: [], newOffset: a.newOffset, warnings: [] });
  });

  it('re-reads from 0 with a warning when the offset is past the end or mid-line', () => {
    const buf = Buffer.from(`${line1}\n`, 'utf8');
    const past = sliceJournal(buf, 99999);
    expect(past.lines).toEqual([line1]);
    expect(past.warnings.join(' ')).toMatch(/offset/);
    const mid = sliceJournal(buf, 5);
    expect(mid.lines).toEqual([line1]);
    expect(mid.warnings.join(' ')).toMatch(/line boundary/);
  });

  it('turns lines into j-<sha1> events with source journal, scrubbed, skipping bad lines', () => {
    const bad = '{not json';
    const noTitle = JSON.stringify({ at: '2026-09-22T01:00:00Z', kind: 'decision' });
    const secret = JSON.stringify({ at: '2026-09-22T02:00:00Z', kind: 'decision', title: 'Call +919876543210', detail: 'token ghp_abcdefghijklmnopqrstuvwxyz0123 mail jane.doe@gmail.com', prompt: 'drop me' });
    const { events, warnings } = journalToEvents([line1, bad, noTitle, secret]);
    expect(events.map((e: { id: string }) => e.id)).toEqual([eventIds.journal(line1), eventIds.journal(secret)]);
    expect(warnings).toHaveLength(2);
    expect(events[0].data).toEqual({ at: '2026-09-22T01:00:00Z', kind: 'decision', actor: 'owner', title: 'Ship it — café', detail: 'ok', source: 'journal' });
    const s = events[1].data;
    expect(s.title).not.toContain('9876543210');
    expect(s.detail).not.toContain('ghp_');
    expect(s.detail).not.toContain('jane.doe@');
    expect(s).not.toHaveProperty('prompt');
    expect(s.actor).toBe('claude');
  });
});

describe('splitBatches', () => {
  const items = (n: number, bytes: number) => Array.from({ length: n }, (_, i) => ({ i, bytes }));
  it('splits by count (50 writes max)', () => {
    expect(splitBatches(items(120, 100), { maxWrites: 50, maxBytes: 900_000 }).map((b: unknown[]) => b.length)).toEqual([50, 50, 20]);
  });
  it('splits by bytes', () => {
    expect(splitBatches(items(5, 400_000), { maxWrites: 50, maxBytes: 900_000 }).map((b: unknown[]) => b.length)).toEqual([2, 2, 1]);
  });
  it('puts an oversized item alone and returns [] for nothing', () => {
    expect(splitBatches([{ bytes: 10 }, { bytes: 2_000_000 }, { bytes: 10 }], { maxWrites: 50, maxBytes: 900_000 }).map((b: unknown[]) => b.length)).toEqual([1, 1, 1]);
    expect(splitBatches([], { maxWrites: 50, maxBytes: 900_000 })).toEqual([]);
  });
  it('defaults to 50 writes and 900 KB', () => {
    expect(splitBatches(items(51, 1)).map((b: unknown[]) => b.length)).toEqual([50, 1]);
  });
});

describe('batchWrites', () => {
  const w = (collection: string, id: string, bytes = 100) => ({ write: { op: 'set', collection, doc_id: id, file_path: `/o/${collection}__${id}.json` }, bytes });
  it('puts meta/state alone in the LAST batch, so a version_mismatch retry resends only it', () => {
    const writes = [w('meta', 'state'), ...Array.from({ length: 51 }, (_, i) => w('events', `gh-merge-${i}`))];
    const batches = batchWrites(writes);
    expect(batches.map((b: unknown[]) => b.length)).toEqual([50, 1, 1]);
    expect(batches[batches.length - 1]).toEqual([{ op: 'set', collection: 'meta', doc_id: 'state', file_path: '/o/meta__state.json' }]);
    expect(batches.slice(0, -1).flat().some((x) => x.collection === 'meta')).toBe(false);
  });
  it('returns only the meta/state batch when nothing else is new, and strips sizes from entries', () => {
    const batches = batchWrites([w('meta', 'state')]);
    expect(batches).toEqual([[{ op: 'set', collection: 'meta', doc_id: 'state', file_path: '/o/meta__state.json' }]]);
    expect(batchWrites([w('events', 'a', 500_000), w('events', 'b', 500_000)]).map((b: unknown[]) => b.length)).toEqual([1, 1]);
  });
});

describe('buildState', () => {
  const base = {
    prev: { mainSha: 'old0000', currentPhase: 1, customKey: 'kept', syncedBy: 'Claude Code /tracker-sync' },
    mainSha: 'ccccccc',
    openPrs: 3,
    now: '2026-09-22T01:00:00.000Z',
    by: 'cloud',
  };
  const ci = [apiRun(20, SHA_C)].map(normalizeRun);

  it('says production serves mainSha when the latest push Smoke for it succeeded', () => {
    const s = buildState({ ...base, ciRuns: ci, smokeRuns: [apiRun(30, SHA_C), apiRun(29, SHA_B)].map(normalizeRun) });
    expect(s).toMatchObject({
      mainSha: 'ccccccc', ciMain: 'success', smokeMain: 'success', smokeNote: `${REPO_URL}/actions/runs/30`,
      prodServes: 'ccccccc', prodDeploy: 'ccccccc: production serves this commit (smoke verified)',
      openPrs: 3, syncedAt: '2026-09-22T01:00:00.000Z', syncedBy: 'cloud routine',
      program: 'SmartRemit upgrade program 2026-09', currentPhase: 1, customKey: 'kept',
    });
    expect(typeof s.prodServesNote).toBe('string');
  });

  it('falls back to the last sha with a successful push Smoke, with a note', () => {
    const s = buildState({
      ...base, by: 'session', ciRuns: ci,
      smokeRuns: [
        apiRun(31, SHA_C, { status: 'in_progress', conclusion: null }),
        apiRun(30, SHA_C, { event: 'workflow_dispatch' }), // not a push run: does not count
        apiRun(29, SHA_B),
        apiRun(28, SHA_A),
      ].map(normalizeRun),
    });
    expect(s.smokeMain).toBe('in_progress');
    expect(s.prodServes).toBe('bbbbbbb');
    expect(s.prodServesNote).toMatch(/bbbbbbb/);
    expect(s.prodDeploy).toMatch(/^ccccccc: /);
    expect(s.prodDeploy).toMatch(/bbbbbbb/);
    expect(s.syncedBy).toBe('session');
  });

  it('reports pending and no prod sha when there are no runs', () => {
    const s = buildState({ ...base, prev: null, ciRuns: [], smokeRuns: [] });
    expect(s).toMatchObject({ ciMain: 'pending', smokeMain: 'pending', prodServes: null, currentPhase: 1 });
    expect(s.smokeNote).toMatch(/No push smoke run/);
  });

  it('uses the latest run for mainSha (a re-run failure beats an older success)', () => {
    const s = buildState({ ...base, ciRuns: ci, smokeRuns: [apiRun(33, SHA_C, { conclusion: 'failure' }), apiRun(32, SHA_C), apiRun(29, SHA_B)].map(normalizeRun) });
    expect(s.smokeMain).toBe('failure');
    // Run 32 already waited until /api/version reported ccccccc, so production serves it; the re-run failed its tests.
    expect(s.prodServes).toBe('ccccccc');
    expect(s.prodDeploy).toMatch(/failure/);
  });
});

describe('planSync (end to end, pure)', () => {
  const gh = {
    mainSha: 'ccccccc',
    prs: [
      merged(256, SHA_A, '2026-09-16T19:33:30Z', 'Program-Fix: 6'),
      open(261, 'Program-Fix: 13', '2026-09-21T22:14:53Z'),
      apiPr(262, { user: { login: 'dependabot[bot]' } }),
      apiPr(200),
    ],
    openPrs: [open(261), apiPr(262, { user: { login: 'dependabot[bot]' } }), apiPr(207)],
    ciRuns: [apiRun(20, SHA_C)],
    smokeRuns: [apiRun(30, SHA_C)],
  };
  const emptyDump = { ids: new Set<string>(), fixstate: [], fixes: [{ fix: 6, status: 'planned', prs: [] }], events: [], prevState: { currentPhase: 1 } };

  it('plans the new docs plus meta/state last', () => {
    const plan = planSync({ gh, dump: emptyDump, journalLines: [], now: '2026-09-22T01:00:00.000Z', by: 'session' });
    const ids = plan.docs.map((d: { collection: string; id: string }) => `${d.collection}/${d.id}`);
    expect(ids).toContain('prs/pr-256');
    expect(ids).toContain('prstate/pr-261-open');
    expect(ids).toContain('fixstate/fix-06-merged-aaaaaaa');
    expect(ids).toContain('fixstate/fix-13-in_review-pr261');
    expect(ids).toContain('events/gh-merge-256');
    expect(ids).toContain('events/gh-smoke-30');
    expect(ids.some((x: string) => x.includes('262') || x.includes('pr-200'))).toBe(false);
    expect(ids[ids.length - 1]).toBe('meta/state');
    expect(plan.state.openPrs).toBe(2);
  });

  it('is idempotent: re-running against a dump holding its output plans only meta/state', () => {
    const first = planSync({ gh, dump: emptyDump, journalLines: [], now: '2026-09-22T01:00:00.000Z', by: 'session' });
    const docs = first.docs.filter((d: { collection: string }) => d.collection !== 'meta');
    const dump = {
      ids: new Set<string>(docs.map((d: { collection: string; id: string }) => `${d.collection}/${d.id}`)),
      fixstate: docs.filter((d: { collection: string }) => d.collection === 'fixstate').map((d: { data: unknown }) => d.data),
      fixes: emptyDump.fixes,
      events: docs.filter((d: { collection: string }) => d.collection === 'events'),
      prevState: first.state,
    };
    const second = planSync({ gh, dump, journalLines: [], now: '2026-09-22T02:00:00.000Z', by: 'cloud' });
    expect(second.docs.map((d: { collection: string; id: string }) => `${d.collection}/${d.id}`)).toEqual(['meta/state']);
  });
});

describe('scrub (port of build-corpus.py)', () => {
  it('masks phone numbers except +1555 test numbers', () => {
    expect(scrub('call +919876543210 now')).toBe('call +••••••••3210 now');
    expect(scrub('test +15551234567')).toBe('test +15551234567');
  });
  it('masks emails except org and test domains', () => {
    expect(scrub('mail jane.doe@gmail.com')).toBe('mail j…@gmail.com');
    expect(scrub('ops@smartremit.ai and a@example.com')).toBe('ops@smartremit.ai and a@example.com');
  });
  it('redacts token-like strings', () => {
    expect(scrub('sk-abcdefghijklmnopqrstuvwxyz')).toBe('<redacted-token>');
    expect(scrub('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('<redacted-token>');
    expect(scrub('github_pat_11ABCDEFG0123456789_abcdefghijkl')).toBe('<redacted-token>');
    expect(scrub('EAA' + 'x'.repeat(40))).toBe('<redacted-token>');
    expect(scrub('xoxb-1234567890-abcdefghijkl')).toBe('<redacted-token>');
  });
  it('is safe on non-strings', () => {
    expect(scrub(undefined)).toBe('');
    expect(scrub(null)).toBe('');
  });
});

describe('hookToJournalEntries', () => {
  const NOW = '2026-09-22T03:00:00.000Z';
  const agentInput = (status: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'Build fix 13', subagent_type: 'general-purpose', model: 'opus', prompt: 'SECRET PROMPT with +919876543210' },
    tool_response: { status, agentId: 'a1b2', resolvedModel: 'claude-opus-5', totalDurationMs: 61000 },
    ...extra,
  });

  it('journals a main-thread background Agent launch without the prompt', () => {
    const [e, ...rest] = hookToJournalEntries(agentInput('async_launched'), NOW);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ at: NOW, kind: 'agent', actor: 'claude', model: 'claude-opus-5', title: 'Agent started: Build fix 13', result: 'running' });
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });

  it('journals a foreground Agent completion as finished', () => {
    const [e] = hookToJournalEntries(agentInput('completed'), NOW);
    expect(e).toMatchObject({ title: 'Agent finished: Build fix 13', result: 'ok' });
  });

  it('falls back to the requested model, then the subagent type', () => {
    const noResolved = agentInput('async_launched');
    noResolved.tool_response = { status: 'async_launched', agentId: 'x', resolvedModel: '', totalDurationMs: 0 };
    expect(hookToJournalEntries(noResolved, NOW)[0].model).toBe('opus');
    const bare = { ...noResolved, tool_input: { description: 'd', subagent_type: 'Explore', prompt: 'p' } };
    expect(hookToJournalEntries(bare, NOW)[0].model).toBe('Explore');
  });

  it("skips a subagent's own tool calls", () => {
    expect(hookToJournalEntries(agentInput('async_launched', { agent_id: 'sub-1', agent_type: 'general-purpose' }), NOW)).toEqual([]);
    expect(hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'sub-1', tool_input: { command: 'gh pr merge 260 --squash' }, tool_response: { exit_code: 0 } }, NOW)).toEqual([]);
  });

  it('journals SubagentStop with a scrubbed 280-char detail', () => {
    const msg = 'Done. Contact jane.doe@gmail.com or +919876543210. ' + 'x'.repeat(400);
    const [e] = hookToJournalEntries({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', last_assistant_message: msg }, NOW);
    expect(e).toMatchObject({ at: NOW, kind: 'agent', title: 'Agent finished (Explore)', result: 'ok' });
    expect(e.detail.length).toBeLessThanOrEqual(280);
    expect(e.detail).not.toContain('jane.doe@');
    expect(e.detail).not.toContain('9876543210');
  });

  it('journals gh pr merge/close with the PR number and exit status', () => {
    const [m] = hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 260 --squash --delete-branch' }, tool_response: { exit_code: 0 } }, NOW);
    expect(m).toMatchObject({ kind: 'pr', actor: 'claude', refs: { pr: [260] }, result: 'ok' });
    expect(m.title).toMatch(/merge/);
    const [c] = hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr close https://github.com/o/r/pull/258 --comment "stale"' }, tool_response: { exit_code: 1 } }, NOW);
    expect(c).toMatchObject({ kind: 'pr', refs: { pr: [258] }, result: 'failed' });
    expect(hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr view 260' }, tool_response: { exit_code: 0 } }, NOW)).toEqual([]);
  });

  it('returns [] for malformed or unrelated input', () => {
    expect(hookToJournalEntries(null, NOW)).toEqual([]);
    expect(hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Edit' }, NOW)).toEqual([]);
    expect(hookToJournalEntries({ hook_event_name: 'Stop' }, NOW)).toEqual([]);
  });
});

describe('stopDecision (ledger-sync-due)', () => {
  const base = { stopHookActive: false, remote: false, journalSize: 100, flushedOffset: 100, remoteMainSha: 'ef0bc28b0435d829ea5839262b9151cc7ddcbdb4', lastSyncMainSha: 'ef0bc28' };
  it('does not block when nothing is due', () => {
    expect(stopDecision(base)).toBeNull();
  });
  it('blocks on unflushed journal entries with the exact reason', () => {
    expect(stopDecision({ ...base, journalSize: 250 })).toEqual({
      decision: 'block',
      reason: 'Ledger sync due: new journal entries. Run the tracker-sync skill (automated engine) now, then finish.',
    });
  });
  it('blocks when main moved since the last sync', () => {
    const d = stopDecision({ ...base, lastSyncMainSha: '37785e0' });
    expect(d?.decision).toBe('block');
    expect(d?.reason).toMatch(/ef0bc28/);
  });
  it('never blocks when stop_hook_active, in the cloud, or when ls-remote failed / no sync recorded', () => {
    expect(stopDecision({ ...base, journalSize: 999, stopHookActive: true })).toBeNull();
    expect(stopDecision({ ...base, journalSize: 999, remote: true })).toBeNull();
    expect(stopDecision({ ...base, remoteMainSha: null, lastSyncMainSha: '37785e0' })).toBeNull();
    expect(stopDecision({ ...base, lastSyncMainSha: null })).toBeNull();
  });
});
