import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIRST_PROGRAM_PR,
  LEGACY_FIX_MAP,
  SYNC_STALE_MS,
  URGENT_JOURNAL_KINDS,
  buildState,
  currentFixStatuses,
  deriveFixStates,
  diffAgainstExisting,
  eventIds,
  fixesForPr,
  hookToJournalEntries,
  hookUsesAgents,
  isProgramPr,
  journalToEvents,
  legacyEventKeys,
  normalizePr,
  normalizeRun,
  parseProgramFix,
  planSync,
  prDocs,
  prEvents,
  pruneAgents,
  rank,
  runEvents,
  scrub,
  sliceJournal,
  splitBatches,
  stopDecision,
  urgentJournalKinds,
  batchWrites,
} from '../scripts/tracker/sync-core.mjs';

const REPO_URL = 'https://github.com/Nagavenkatasai7/claude-payments';
// Secret shapes scrub() must redact (review of #273). Fake values. The JWT is assembled at run
// time so no JWT-shaped literal sits in the repo for secret scanners to flag.
function fakeJwt() {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [part({ alg: 'HS256', typ: 'JWT' }), part({ sub: 'ledger-test', iat: 0 }), 'x'.repeat(43)].join('.');
}
const SECRETS = {
  anthropicKey: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcdefXYZ',
  awsKeyId: 'AKIAIOSFODNN7EXAMPLE',
  jwt: fakeJwt(),
  barePhone: '919876543210',
};
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

  it('redacts every secret shape in journal titles and details', () => {
    const all = Object.values(SECRETS).join(' | ');
    const line = JSON.stringify({ at: '2026-09-22T02:00:00Z', kind: 'decision', title: `t ${all}`, detail: `d ${all}` });
    const { events } = journalToEvents([line]);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(events[0].data.title, name).not.toContain(secret);
      expect(events[0].data.detail, name).not.toContain(secret);
    }
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
  it('redacts Anthropic keys, AWS access key ids and JWTs', () => {
    expect(scrub(`key ${SECRETS.anthropicKey} end`)).toBe('key <redacted-token> end');
    expect(scrub(`aws ${SECRETS.awsKeyId} here`)).toBe('aws <redacted-token> here');
    expect(scrub(`auth ${SECRETS.jwt} ok`)).toBe('auth <redacted-token> ok');
    expect(scrub('Authorization: Bearer ' + SECRETS.jwt)).toBe('Authorization: Bearer <redacted-token>');
  });
  it('masks bare 10+ digit numbers (phones, card numbers) but keeps +1555 test numbers, ids in URLs and short numbers', () => {
    expect(scrub(`call ${SECRETS.barePhone} now`)).toBe('call ••••••••3210 now');
    expect(scrub('us 2025550123, card 4111111111111111')).toBe('us ••••••0123, card ••••••••••••1111');
    expect(scrub('in +91-9876543210')).toBe('in +91-••••••3210');
    expect(scrub('test +15551234567 and 15551234567')).toBe('test +15551234567 and 15551234567');
    const run = 'https://github.com/o/r/actions/runs/35671070038';
    expect(scrub(`CI failure: ${run}`)).toBe(`CI failure: ${run}`);
    expect(scrub('PR #273, 2527 tests, 179 files, sha 2a23a11, agent a1f4204c6f0012488')).toBe('PR #273, 2527 tests, 179 files, sha 2a23a11, agent a1f4204c6f0012488');
  });
  it('is safe on non-strings', () => {
    expect(scrub(undefined)).toBe('');
    expect(scrub(null)).toBe('');
  });
});

describe('hookToJournalEntries', () => {
  const NOW = '2026-09-22T03:00:00.000Z';
  type Agents = Record<string, Record<string, unknown>>;
  const agentInput = (status: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'Build fix 13', subagent_type: 'general-purpose', model: 'opus', prompt: 'SECRET PROMPT with +919876543210' },
    tool_response: { status, agentId: 'a1b2', resolvedModel: 'claude-opus-5', totalDurationMs: 61000, prompt: 'SECRET PROMPT echoed back' },
    ...extra,
  });
  const stop = (agentId: string, msg: string, agentType = 'general-purpose') => ({
    hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, stop_hook_active: false, last_assistant_message: msg,
  });
  const launched = (agents: Agents = {}) => hookToJournalEntries(agentInput('async_launched'), NOW, agents).agents;

  it('journals a main-thread background Agent launch without the prompt and records it by agentId', () => {
    const r = hookToJournalEntries(agentInput('async_launched'), NOW, {});
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ at: NOW, kind: 'agent', actor: 'claude', model: 'claude-opus-5', title: 'Agent started: Build fix 13', result: 'running' });
    expect(r.changed).toBe(true);
    expect(r.agents).toEqual({ a1b2: { agentId: 'a1b2', description: 'Build fix 13', subagent_type: 'general-purpose', model: 'claude-opus-5', startedAt: NOW } });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('does not journal a second start for an agentId it already recorded', () => {
    const agents = launched();
    const again = hookToJournalEntries(agentInput('async_launched'), '2026-09-22T03:05:00.000Z', agents);
    expect(again).toEqual({ entries: [], agents, changed: false });
  });

  it('journals one start and one finish for a foreground Agent (its SubagentStop fired before this hook)', () => {
    const fg = agentInput('completed');
    fg.tool_response = { ...fg.tool_response, content: [{ type: 'text', text: 'Fixed it.\n\nMail jane.doe@gmail.com ' + 'y'.repeat(400) }] } as typeof fg.tool_response;
    const r = hookToJournalEntries(fg, NOW, {});
    expect(r.entries.map((e: { title: string }) => e.title)).toEqual(['Agent started: Build fix 13', 'Agent finished: Build fix 13']);
    expect(r.entries[0]).toMatchObject({ at: '2026-09-22T02:58:59.000Z', actor: 'claude', result: 'running' });
    expect(r.entries[1]).toMatchObject({ at: NOW, kind: 'agent', actor: 'agent', model: 'claude-opus-5', result: 'ok' });
    expect(r.entries[1].detail).toMatch(/^Fixed it\. Mail j…@gmail\.com y+$/);
    expect(r.entries[1].detail.length).toBeLessThanOrEqual(280);
    expect(r.agents.a1b2).toMatchObject({ startedAt: '2026-09-22T02:58:59.000Z', finishedAt: NOW });
    // A SubagentStop that arrives later (or a resume) adds no row.
    const late = hookToJournalEntries(stop('a1b2', 'closing text'), '2026-09-22T03:00:01.000Z', r.agents);
    expect(late.entries).toEqual([]);
  });

  it('falls back to the requested model, then the subagent type', () => {
    const noResolved = agentInput('async_launched');
    noResolved.tool_response = { status: 'async_launched', agentId: 'x', resolvedModel: '', totalDurationMs: 0, prompt: '' };
    expect(hookToJournalEntries(noResolved, NOW, {}).entries[0].model).toBe('opus');
    const bare = { ...noResolved, tool_input: { description: 'd', subagent_type: 'Explore', prompt: 'p' } };
    expect(hookToJournalEntries(bare, NOW, {}).entries[0].model).toBe('Explore');
  });

  it("skips a subagent's own tool calls, including the launches of its nested helpers", () => {
    expect(hookToJournalEntries(agentInput('async_launched', { agent_id: 'sub-1', agent_type: 'general-purpose' }), NOW, {})).toEqual({ entries: [], agents: {}, changed: false });
    expect(hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'sub-1', tool_input: { command: 'gh pr merge 260 --squash' }, tool_response: { exit_code: 0 } }, NOW, {}).entries).toEqual([]);
  });

  it('journals ONE finish row on the first SubagentStop of a recorded agent, titled with its description', () => {
    const msg = 'Done. Contact jane.doe@gmail.com or +919876543210.\n' + 'x'.repeat(400);
    const r = hookToJournalEntries(stop('a1b2', msg), '2026-09-22T03:10:00.000Z', launched());
    expect(r.entries).toHaveLength(1);
    const [e] = r.entries;
    expect(e).toMatchObject({ at: '2026-09-22T03:10:00.000Z', kind: 'agent', actor: 'agent', model: 'claude-opus-5', title: 'Agent finished: Build fix 13', result: 'ok' });
    expect(e.detail.length).toBeLessThanOrEqual(280);
    expect(e.detail).toMatch(/^Done\. Contact j…@gmail\.com or \+•+3210\. x+$/);
    expect(r.changed).toBe(true);
    expect(r.agents.a1b2).toMatchObject({ finishedAt: '2026-09-22T03:10:00.000Z', lastMessage: e.detail });
  });

  it('a later stop of the same agent only updates the stored last message', () => {
    const first = hookToJournalEntries(stop('a1b2', 'Reading outbox tests'), '2026-09-22T03:10:00.000Z', launched());
    const second = hookToJournalEntries(stop('a1b2', 'All green; PR #271 opened.'), '2026-09-22T03:40:00.000Z', first.agents);
    expect(second.entries).toEqual([]);
    expect(second.changed).toBe(true);
    expect(second.agents.a1b2).toMatchObject({ finishedAt: '2026-09-22T03:10:00.000Z', lastMessage: 'All green; PR #271 opened.' });
    const same = hookToJournalEntries(stop('a1b2', 'All green; PR #271 opened.'), '2026-09-22T03:41:00.000Z', second.agents);
    expect(same).toEqual({ entries: [], agents: second.agents, changed: false });
  });

  it('skips stops of unknown agents: nested helpers and internal agents with an empty agent_type', () => {
    const agents = launched();
    expect(hookToJournalEntries(stop('nested-9', 'Reading outbox-payload-secrets.test.ts static gate'), NOW, agents)).toEqual({ entries: [], agents, changed: false });
    expect(hookToJournalEntries(stop('c0ffee', 'Tracing fundingRef writes', ''), NOW, agents)).toEqual({ entries: [], agents, changed: false });
    expect(hookToJournalEntries({ hook_event_name: 'SubagentStop', last_assistant_message: 'no id' }, NOW, agents).entries).toEqual([]);
  });

  it('matches agent ids with or without an "agent-" prefix, and falls back to a plain detail when the message is empty', () => {
    const r = hookToJournalEntries(stop('agent-a1b2', ''), NOW, launched());
    expect(r.entries[0]).toMatchObject({ title: 'Agent finished: Build fix 13', detail: 'general-purpose agent finished' });
    const prefixed = agentInput('async_launched');
    prefixed.tool_response = { ...prefixed.tool_response, agentId: 'agent-ff01' };
    const rec = hookToJournalEntries(prefixed, NOW, {}).agents;
    expect(Object.keys(rec)).toEqual(['ff01']);
    expect(hookToJournalEntries(stop('ff01', 'ok'), NOW, rec).entries).toHaveLength(1);
  });

  it('never mutates the agents object it is given', () => {
    const agents = launched();
    const snapshot = JSON.stringify(agents);
    hookToJournalEntries(stop('a1b2', 'done'), NOW, agents);
    hookToJournalEntries(agentInput('async_launched', { tool_response: { status: 'async_launched', agentId: 'b2' } }), NOW, agents);
    expect(JSON.stringify(agents)).toBe(snapshot);
  });

  it('still journals a launch that carries no agentId (nothing to match its stop against)', () => {
    const r = hookToJournalEntries(agentInput('async_launched', { tool_response: { status: 'async_launched' } }), NOW, {});
    expect(r.entries.map((e: { title: string }) => e.title)).toEqual(['Agent started: Build fix 13']);
    expect(r.changed).toBe(false);
  });

  it('journals gh pr merge/close with the PR number and exit status', () => {
    const [m] = hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 260 --squash --delete-branch' }, tool_response: { exit_code: 0 } }, NOW, {}).entries;
    expect(m).toMatchObject({ kind: 'pr', actor: 'claude', refs: { pr: [260] }, result: 'ok' });
    expect(m.title).toMatch(/merge/);
    const [c] = hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr close https://github.com/o/r/pull/258 --comment "stale"' }, tool_response: { exit_code: 1 } }, NOW, {}).entries;
    expect(c).toMatchObject({ kind: 'pr', refs: { pr: [258] }, result: 'failed' });
    expect(hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr view 260' }, tool_response: { exit_code: 0 } }, NOW, {}).entries).toEqual([]);
  });

  it('reads a Bash PostToolUse with no exit code as exit 0 (a failed command fires PostToolUseFailure instead)', () => {
    const bash = (command: string, tr: Record<string, unknown>) =>
      hookToJournalEntries({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: tr }, NOW, {}).entries[0];
    // The shape Claude Code really sends for Bash: no exit code field.
    const real = { stdout: 'Squashed and merged', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
    const ok = bash('gh pr merge 273 --squash', real);
    expect(ok).toMatchObject({ kind: 'pr', title: 'gh pr merge #273 run in a session', refs: { pr: [273] }, result: 'ok' });
    expect(ok.detail).toMatch(/^Exit 0\b/);
    expect(bash('gh pr merge 273 --squash', { ...real, interrupted: true }).result).toBe('failed');
    // Still running in the background, or a non-zero exit Claude Code read as benign: exit unknown.
    expect(bash('gh pr merge 273 --squash', { ...real, backgroundTaskId: 'b1' }).result).toBe('info');
    expect(bash('gh pr merge 273 --squash', { ...real, returnCodeInterpretation: 'No matches found' }).result).toBe('info');
  });

  it('redacts each secret shape in the finish row AND in agents.json lastMessage (first and later stops, foreground runs)', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const first = hookToJournalEntries(stop('a1b2', `first ${secret} end`), NOW, launched());
      const later = hookToJournalEntries(stop('a1b2', `later ${secret} end`), NOW, first.agents);
      const fg = agentInput('completed');
      fg.tool_response = { ...fg.tool_response, content: [{ type: 'text', text: `fg ${secret} end` }] } as typeof fg.tool_response;
      const fgRun = hookToJournalEntries(fg, NOW, {});
      const texts = [first.entries[0].detail, first.agents.a1b2.lastMessage, later.agents.a1b2.lastMessage, fgRun.entries[1].detail, fgRun.agents.a1b2.lastMessage];
      expect(texts.every((t) => typeof t === 'string' && t.length > 0), name).toBe(true);
      for (const t of texts) expect(t, name).not.toContain(secret);
    }
  });

  it('returns no entries and no change for malformed or unrelated input', () => {
    for (const input of [null, { hook_event_name: 'PostToolUse', tool_name: 'Edit' }, { hook_event_name: 'Stop' }]) {
      expect(hookToJournalEntries(input, NOW, {})).toEqual({ entries: [], agents: {}, changed: false });
    }
    expect(hookToJournalEntries(agentInput('async_launched'), NOW).entries).toHaveLength(1);
  });
});

describe('hookUsesAgents', () => {
  it('is true only for main-thread Agent launches and SubagentStop', () => {
    expect(hookUsesAgents({ hook_event_name: 'PostToolUse', tool_name: 'Agent' })).toBe(true);
    expect(hookUsesAgents({ hook_event_name: 'PostToolUse', tool_name: 'Task' })).toBe(true);
    expect(hookUsesAgents({ hook_event_name: 'SubagentStop', agent_id: 'a1' })).toBe(true);
    expect(hookUsesAgents({ hook_event_name: 'PostToolUse', tool_name: 'Agent', agent_id: 'sub-1' })).toBe(false);
    expect(hookUsesAgents({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })).toBe(false);
    expect(hookUsesAgents(null)).toBe(false);
  });
});

describe('pruneAgents', () => {
  const NOW = '2026-09-22T12:00:00.000Z';
  it('drops finished agents after 24 h and unfinished ones after 7 days, keeping the rest', () => {
    const agents = {
      fresh: { startedAt: '2026-09-22T11:00:00.000Z' },
      doneRecent: { startedAt: '2026-09-21T10:00:00.000Z', finishedAt: '2026-09-21T13:00:00.000Z' },
      doneOld: { startedAt: '2026-09-21T09:00:00.000Z', finishedAt: '2026-09-21T11:00:00.000Z' },
      longRunning: { startedAt: '2026-09-17T12:00:00.000Z' },
      abandoned: { startedAt: '2026-09-15T11:00:00.000Z' },
      junk: 'not an object',
    };
    expect(Object.keys(pruneAgents(agents, NOW)).sort()).toEqual(['doneRecent', 'fresh', 'longRunning']);
    expect(agents).toHaveProperty('doneOld');
  });
  it('returns {} for a non-object state', () => {
    expect(pruneAgents(null, NOW)).toEqual({});
    expect(pruneAgents([1, 2], NOW)).toEqual({});
  });
});

describe('urgentJournalKinds', () => {
  it('lists the urgent kinds among journal lines, ignoring routine kinds and bad lines', () => {
    expect([...URGENT_JOURNAL_KINDS].sort()).toEqual(['incident', 'merge', 'migration']);
    const lines = [
      JSON.stringify({ kind: 'agent', title: 'Agent started: x' }),
      '{not json',
      JSON.stringify({ kind: 'owner-step', title: 'Owner rotated a key' }),
      JSON.stringify({ kind: 'approval', title: 'Approved' }),
      JSON.stringify({ kind: 'decision', title: 'Decided' }),
      JSON.stringify({ kind: 'verify', title: 'Verified' }),
      JSON.stringify({ kind: 'incident', title: 'Something broke' }),
      JSON.stringify({ kind: 'migration', title: 'Ran a migration' }),
      'null',
    ];
    // approval, decision, verify and owner-step are routine now (owner decision 2026-09-22): they wait for SYNC_STALE_MS.
    expect(urgentJournalKinds(lines)).toEqual(['incident', 'migration']);
    expect(urgentJournalKinds([JSON.stringify({ kind: 'pr' }), JSON.stringify({ kind: 'agent' })])).toEqual([]);
    expect(urgentJournalKinds([
      JSON.stringify({ kind: 'owner-step' }), JSON.stringify({ kind: 'approval' }),
      JSON.stringify({ kind: 'decision' }), JSON.stringify({ kind: 'verify' }),
    ])).toEqual([]);
    expect(urgentJournalKinds(undefined)).toEqual([]);
  });

  it('counts a successful session `gh pr merge` row (kind pr) as a merge, and no other pr row', () => {
    const row = (title: string, result?: string) => JSON.stringify({ kind: 'pr', actor: 'claude', title, ...(result ? { result } : {}) });
    expect(urgentJournalKinds([row('gh pr merge #273 run in a session', 'ok')])).toEqual(['merge']);
    expect(urgentJournalKinds([row('gh pr merge #273 run in a session', 'ok'), JSON.stringify({ kind: 'merge', title: 'm' })])).toEqual(['merge']);
    // Exit unknown (rows written before this change), failed, or no result: not proof of a merge.
    expect(urgentJournalKinds([row('gh pr merge #273 run in a session', 'info'), row('gh pr merge #274 run in a session', 'failed'), row('gh pr merge #275 run in a session')])).toEqual([]);
    expect(urgentJournalKinds([row('gh pr close #258 run in a session', 'ok'), row('gh pr merged? no', 'ok')])).toEqual([]);
  });
});

describe('stopDecision (ledger-sync-due)', () => {
  const NOW = '2026-09-22T03:00:00.000Z';
  const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
  const agentLine = JSON.stringify({ at: NOW, kind: 'agent', title: 'Agent started: x' });
  const base = {
    stopHookActive: false, remote: false, disabled: false,
    journalSize: 100, flushedOffset: 100, pendingLines: [] as string[],
    lastSyncAt: minutesAgo(2), now: NOW,
    remoteMainSha: 'ef0bc28b0435d829ea5839262b9151cc7ddcbdb4', lastSyncMainSha: 'ef0bc28',
  };
  const pending = { journalSize: 250, pendingLines: [agentLine] };

  it('does not block when nothing is due', () => {
    expect(stopDecision(base)).toBeNull();
  });

  it('(b) does not block on routine journal entries when the last sync was an hour ago or less', () => {
    expect(SYNC_STALE_MS).toBe(60 * 60 * 1000);
    expect(stopDecision({ ...base, ...pending })).toBeNull();
    expect(stopDecision({ ...base, ...pending, lastSyncAt: minutesAgo(60) })).toBeNull();
  });

  it('(b) blocks on unflushed journal entries once the last sync is more than an hour old', () => {
    const d = stopDecision({ ...base, ...pending, lastSyncAt: minutesAgo(61) });
    expect(d).toEqual({
      decision: 'block',
      reason: 'Ledger sync due: new journal entries and the last sync was 61 min ago. Run the tracker-sync skill (automated engine) now, then finish.',
    });
  });

  it('(b) treats approval, decision, verify and owner-step rows as routine: they wait for the hour, not an instant sync', () => {
    for (const kind of ['approval', 'decision', 'verify', 'owner-step']) {
      const line = JSON.stringify({ at: NOW, kind, title: `a ${kind}` });
      expect(stopDecision({ ...base, journalSize: 300, pendingLines: [line], lastSyncAt: minutesAgo(20) })).toBeNull();
      const d = stopDecision({ ...base, journalSize: 300, pendingLines: [line], lastSyncAt: minutesAgo(61) });
      expect(d).toEqual({
        decision: 'block',
        reason: 'Ledger sync due: new journal entries and the last sync was 61 min ago. Run the tracker-sync skill (automated engine) now, then finish.',
      });
    }
  });

  it('(b) treats a missing or unreadable last-sync time as overdue', () => {
    for (const lastSyncAt of [null, undefined, 'not a date']) {
      const d = stopDecision({ ...base, ...pending, lastSyncAt });
      expect(d?.decision).toBe('block');
      expect(d?.reason).toMatch(/no sync time on record/);
    }
  });

  it('(c) blocks at once when an unflushed line is an incident, merge or migration', () => {
    for (const kind of URGENT_JOURNAL_KINDS) {
      const line = JSON.stringify({ at: NOW, kind, title: `a ${kind}` });
      const d = stopDecision({ ...base, journalSize: 400, pendingLines: [agentLine, line], lastSyncAt: minutesAgo(1) });
      expect(d?.decision).toBe('block');
      expect(d?.reason).toBe(`Ledger sync due: the journal holds a new ${kind} entry. Run the tracker-sync skill (automated engine) now, then finish.`);
    }
  });

  it('(c) does not block on a pending verify row with a fresh sync: verify is routine now (owner decision 2026-09-22, was the #273 review repro)', () => {
    const verify = JSON.stringify({ at: NOW, kind: 'verify', actor: 'claude', title: 'Chrome walk-through of /pay green', result: 'ok' });
    expect(stopDecision({ ...base, journalSize: 300, pendingLines: [verify], lastSyncAt: minutesAgo(1) })).toBeNull();
  });

  it('(c) blocks on a session gh pr merge row even when ls-remote failed (no main-moved signal)', () => {
    const [row] = hookToJournalEntries({
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 273 --squash --delete-branch' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    }, NOW, {}).entries;
    const d = stopDecision({ ...base, journalSize: 300, pendingLines: [JSON.stringify(row)], lastSyncAt: minutesAgo(1), remoteMainSha: null });
    expect(d?.reason).toBe('Ledger sync due: the journal holds a new merge entry. Run the tracker-sync skill (automated engine) now, then finish.');
  });

  it('(c) ignores urgent kinds that are already flushed, and non-urgent rows', () => {
    const incident = JSON.stringify({ at: NOW, kind: 'incident', title: 'x' });
    expect(stopDecision({ ...base, pendingLines: [incident] })).toBeNull();
    const unknownExitMerge = JSON.stringify({ kind: 'pr', title: 'gh pr merge #1 run in a session', result: 'info' });
    const close = JSON.stringify({ kind: 'pr', title: 'gh pr close #2 run in a session', result: 'ok' });
    expect(stopDecision({ ...base, journalSize: 300, pendingLines: [unknownExitMerge, close, '{bad'] })).toBeNull();
  });

  it('(a) blocks when main moved since the last sync, even with routine entries pending and a fresh sync', () => {
    const d = stopDecision({ ...base, ...pending, lastSyncMainSha: '37785e0' });
    expect(d?.decision).toBe('block');
    expect(d?.reason).toMatch(/main moved to ef0bc28 since the last sync \(37785e0\)/);
  });

  it('(a) supports the two-phase hook: no network result first, then the ls-remote result', () => {
    const args = { ...base, ...pending, lastSyncMainSha: '37785e0' };
    expect(stopDecision({ ...args, remoteMainSha: null })).toBeNull();
    expect(stopDecision(args)?.decision).toBe('block');
  });

  it('never blocks when stop_hook_active, in the cloud, when disabled, or when ls-remote failed / no sync recorded', () => {
    const urgent = { journalSize: 999, pendingLines: [JSON.stringify({ at: NOW, kind: 'incident', title: 'x' })], lastSyncAt: null };
    expect(stopDecision({ ...base, ...urgent, stopHookActive: true })).toBeNull();
    expect(stopDecision({ ...base, ...urgent, remote: true })).toBeNull();
    expect(stopDecision({ ...base, ...urgent, disabled: true })).toBeNull();
    expect(stopDecision({ ...base, remoteMainSha: null, lastSyncMainSha: '37785e0' })).toBeNull();
    expect(stopDecision({ ...base, lastSyncMainSha: null })).toBeNull();
  });
});
