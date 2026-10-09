import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  DONE_WINDOW_MS,
  FRESH_MS,
  HEALTH_STALE_MS,
  SINCE_DEFAULT_MS,
  SINCE_LIMIT,
  STALE_MS,
  VISIT_SESSION_MS,
  activityRows,
  ageLabel,
  askRules,
  changedSince,
  docsByWs,
  effectiveTodoStatus,
  esc,
  feedMonthName,
  fmtUtc,
  freshness,
  groupWorkstreams,
  healthBanner,
  healthPill,
  lastCheckedAt,
  latestPrTitle,
  openPrSplit,
  safeUrl,
  shippedWindow,
  sortTodos,
  testGuideFor,
  utcDay,
  visitPlan,
} from '../scripts/tracker/page/page-logic.mjs';
import { buildPageHtml } from '../scripts/tracker/build-page.mjs';

type Any = any;

// Relative dates only (CLAUDE.md fixture rule): every time is an offset from NOW.
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const now = new Date(NOW).toISOString();

const goodState = (over: Any = {}) => ({
  mainSha: 'abc1234',
  prodServes: 'abc1234',
  ciMain: 'success',
  smokeMain: 'success',
  syncedAt: ago(10 * MIN),
  ...over,
});

describe('esc and safeUrl', () => {
  it('escapes every HTML-significant character (DB rows are untrusted)', () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    expect(esc(null)).toBe('');
    expect(esc(42)).toBe('42');
  });
  it('allows only https links', () => {
    expect(safeUrl('https://claude.ai/artifact/x')).toBe('https://claude.ai/artifact/x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('http://example.test/')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });
});

describe('ageLabel and fmtUtc', () => {
  it('labels ages in min, h and d', () => {
    expect(ageLabel(20_000)).toBe('just now');
    expect(ageLabel(12 * MIN)).toBe('12 min');
    expect(ageLabel(3 * HOUR + 5 * MIN)).toBe('3 h');
    expect(ageLabel(47 * HOUR)).toBe('47 h');
    expect(ageLabel(3 * DAY)).toBe('3 d');
    expect(ageLabel(Number.NaN)).toBe('unknown');
  });
  it('formats a UTC time the same way in every browser time zone', () => {
    expect(fmtUtc('2026-10-08T21:41:09Z')).toBe('Oct 8 21:41Z');
    expect(fmtUtc('2026-01-02T03:04:00Z')).toBe('Jan 2 03:04Z');
    expect(fmtUtc('nope')).toBe('unknown time');
  });
});

describe('freshness', () => {
  it('is fresh up to FRESH_MS, aging up to STALE_MS, then stale', () => {
    expect(FRESH_MS).toBe(70 * MIN);
    expect(STALE_MS).toBe(90 * MIN);
    expect(freshness(ago(12 * MIN), now)).toMatchObject({ level: 'fresh', label: 'checked 12 min ago' });
    expect(freshness(ago(70 * MIN), now).level).toBe('fresh');
    expect(freshness(ago(71 * MIN), now).level).toBe('aging');
    expect(freshness(ago(90 * MIN), now).level).toBe('aging');
    expect(freshness(ago(91 * MIN), now)).toMatchObject({ level: 'stale', label: 'checked 1 h ago' });
  });
  it('is unknown when there is no time', () => {
    expect(freshness(null, now)).toMatchObject({ level: 'unknown', label: 'not checked yet' });
  });
  it('takes the newest of the engine and curator times', () => {
    expect(lastCheckedAt({ state: { syncedAt: ago(50 * MIN) }, sync: { engineAt: ago(40 * MIN), curatorAt: ago(5 * MIN) } })).toBe(ago(5 * MIN));
    expect(lastCheckedAt({ state: { syncedAt: ago(50 * MIN) }, sync: null })).toBe(ago(50 * MIN));
    expect(lastCheckedAt({ state: null, sync: null })).toBeNull();
  });
});

describe('healthPill', () => {
  const health = { at: ago(20 * MIN), ok: true, problems: [] };
  it('is green with production, the headline short name and the smoke result', () => {
    const p = healthPill({ state: goodState(), headline: { short: 'Batch B' }, health, sync: null, now });
    expect(p.tone).toBe('good');
    expect(p.text).toBe('Production abc1234 · Batch B · smoke passed');
  });
  it('is red when smoke failed on main', () => {
    const p = healthPill({ state: goodState({ smokeMain: 'failure', prodServes: 'old0001' }), headline: null, health, sync: null, now });
    expect(p.tone).toBe('red');
    expect(p.text).toBe('Production old0001 · smoke failed');
    expect(p.reasons.join(' ')).toMatch(/smoke failed/i);
  });
  it('is red when CI failed on main or ledger health is not ok', () => {
    expect(healthPill({ state: goodState({ ciMain: 'failure' }), headline: null, health, sync: null, now }).tone).toBe('red');
    const bad = { at: ago(5 * MIN), ok: false, problems: [{ code: 'engine_stale', severity: 'red', message: 'x' }] };
    expect(healthPill({ state: goodState(), headline: null, health: bad, sync: null, now }).tone).toBe('red');
  });
  it('is amber when production is behind main, smoke is running, the data is stale or health is old', () => {
    expect(healthPill({ state: goodState({ prodServes: 'old0001', smokeMain: 'in_progress' }), headline: null, health, sync: null, now })).toMatchObject({ tone: 'amber', text: 'Production old0001 · smoke running' });
    expect(healthPill({ state: goodState({ syncedAt: ago(3 * HOUR) }), headline: null, health, sync: null, now }).tone).toBe('amber');
    expect(healthPill({ state: goodState(), headline: null, health: { ...health, at: ago(3 * HOUR) }, sync: null, now }).tone).toBe('amber');
    const amberOnly = { at: ago(5 * MIN), ok: true, problems: [{ code: 'todo_stale', severity: 'amber', message: 'x' }] };
    expect(healthPill({ state: goodState(), headline: null, health: amberOnly, sync: null, now }).tone).toBe('amber');
  });
  it('says production is unknown before the first engine run', () => {
    const p = healthPill({ state: null, headline: null, health: null, sync: null, now });
    expect(p.tone).toBe('amber');
    expect(p.text).toBe('Production unknown · smoke unknown');
  });
});

describe('healthBanner', () => {
  it('is hidden when health is ok and recent', () => {
    expect(healthBanner({ at: ago(30 * MIN), ok: true, problems: [{ code: 'todo_stale', severity: 'amber', message: 'old to-do' }] }, now).show).toBe(false);
  });
  it('shows one line per problem, red first, when health is not ok', () => {
    const b = healthBanner({
      at: ago(5 * MIN), ok: false,
      problems: [
        { code: 'todo_stale', severity: 'amber', section: 'todo', message: 'A to-do has not changed in 15 d', ref: 'x' },
        { code: 'unmapped_merge', severity: 'red', section: 'ws', message: 'PR #484 merged 3 h ago; no workstream lists it', ref: '484' },
      ],
    }, now);
    expect(b.show).toBe(true);
    expect(b.tone).toBe('red');
    expect(b.lines.map((l: Any) => l.code)).toEqual(['unmapped_merge', 'todo_stale']);
  });
  it('shows when the last check is older than HEALTH_STALE_MS, even if it was ok', () => {
    expect(HEALTH_STALE_MS).toBe(2 * HOUR);
    const b = healthBanner({ at: ago(2 * HOUR + MIN), ok: true, problems: [] }, now);
    expect(b.show).toBe(true);
    expect(b.tone).toBe('red');
    expect(b.lines[0]).toMatchObject({ code: 'health_stale' });
    expect(b.lines[0].message).toMatch(/2 h ago/);
  });
  it('shows when the health check has never run', () => {
    const b = healthBanner(null, now);
    expect(b.show).toBe(true);
    expect(b.lines[0].code).toBe('health_missing');
  });
});

describe('visitPlan (Since your last visit)', () => {
  it('uses lastVisitAt from the visit doc and writes now', () => {
    const p = visitPlan({ doc: { lastVisitAt: ago(5 * HOUR), prevVisitAt: ago(30 * HOUR) }, localLast: null, now });
    expect(p).toMatchObject({ since: ago(5 * HOUR), source: 'db' });
    expect(p.write).toEqual({ lastVisitAt: now, prevVisitAt: ago(5 * HOUR) });
  });
  it('keeps the earlier baseline when the page is reopened within VISIT_SESSION_MS', () => {
    expect(VISIT_SESSION_MS).toBe(30 * MIN);
    const p = visitPlan({ doc: { lastVisitAt: ago(5 * MIN), prevVisitAt: ago(9 * HOUR) }, localLast: null, now });
    expect(p.since).toBe(ago(9 * HOUR));
    expect(p.write).toEqual({ lastVisitAt: now, prevVisitAt: ago(9 * HOUR) });
  });
  it('falls back to localStorage, then to 48 h', () => {
    expect(visitPlan({ doc: null, localLast: ago(3 * HOUR), now })).toMatchObject({ since: ago(3 * HOUR), source: 'local' });
    expect(SINCE_DEFAULT_MS).toBe(48 * HOUR);
    expect(visitPlan({ doc: null, localLast: 'junk', now })).toMatchObject({ since: ago(48 * HOUR), source: 'default' });
  });
});

describe('changedSince', () => {
  const rows = [
    { id: 'chg-1', at: ago(1 * HOUR), kind: 'change', title: 'Workstream: Batch B: working -> live' },
    { id: 'gh-merge-1', at: ago(2 * HOUR), kind: 'merge', title: 'PR #1 merged' },
    { id: 'gh-smoke-1', at: ago(3 * HOUR), kind: 'deploy', title: 'Smoke passed' },
    { id: 'cur-1', at: ago(4 * HOUR), kind: 'decision', title: 'Owner chose a' },
    { id: 'j-1', at: ago(5 * HOUR), kind: 'approval', title: 'Go' },
    { id: 'chg-old', at: ago(30 * HOUR), kind: 'change', title: 'Old' },
  ];
  it('keeps change, decision, approval and deploy rows after the visit, newest first', () => {
    const r = changedSince(rows, ago(10 * HOUR));
    expect(r.rows.map((x: Any) => x.id)).toEqual(['chg-1', 'gh-smoke-1', 'cur-1', 'j-1']);
    expect(r.total).toBe(4);
  });
  it('caps the list at SINCE_LIMIT and reports the total', () => {
    expect(SINCE_LIMIT).toBe(8);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, at: ago((i + 1) * MIN), kind: 'change', title: 't' }));
    const r = changedSince(many, ago(DAY));
    expect(r.rows).toHaveLength(8);
    expect(r.total).toBe(12);
    expect(changedSince(many, ago(DAY), { limit: Infinity }).rows).toHaveLength(12);
  });
  it('accepts {id, data} rows', () => {
    expect(changedSince([{ id: 'x', data: { at: ago(MIN), kind: 'change', title: 't' } }], ago(HOUR)).rows[0]).toMatchObject({ id: 'x', kind: 'change' });
  });
});

describe('effectiveTodoStatus and sortTodos (acks)', () => {
  const todo = (over: Any = {}) => ({ id: 't1', title: 'Check the guide', status: 'open', priority: 'now', createdAt: ago(3 * DAY), statusChangedAt: ago(3 * DAY), ...over });
  it('is open with no ack', () => {
    expect(effectiveTodoStatus(todo(), [])).toMatchObject({ status: 'open', ack: null });
  });
  it('turns an open to-do into acked when an ack is newer than its last status change', () => {
    const e = effectiveTodoStatus(todo(), [{ id: 't1--1', todoId: 't1', action: 'done', at: ago(HOUR) }]);
    expect(e.status).toBe('acked');
    expect(e.label).toBe('Done, waiting for check');
    const d = effectiveTodoStatus(todo(), [{ id: 't1--2', todoId: 't1', action: 'dismiss', at: ago(HOUR) }]);
    expect(d.label).toBe('Dismissed, waiting for check');
  });
  it('ignores an ack from before a reopen', () => {
    const e = effectiveTodoStatus(todo({ statusChangedAt: ago(HOUR), reopenReason: 'The guide still shows the old link' }), [{ todoId: 't1', action: 'done', at: ago(2 * HOUR) }]);
    expect(e.status).toBe('open');
    expect(e.label).toMatch(/Reopened/);
  });
  it('keeps showing the ack the routine folded (ackId) after statusChangedAt moved past it', () => {
    const acks = [{ id: 't1--2', todoId: 't1', action: 'dismiss', at: ago(2 * HOUR) }];
    const e = effectiveTodoStatus(todo({ status: 'acked', ackId: 't1--2', statusChangedAt: ago(HOUR) }), acks);
    expect(e.status).toBe('acked');
    expect(e.ack).toMatchObject({ id: 't1--2' });
    expect(e.label).toBe('Dismissed, waiting for check');
  });
  it('ignores acks for other to-dos', () => {
    expect(effectiveTodoStatus(todo(), [{ todoId: 'other', action: 'done', at: ago(MIN) }]).status).toBe('open');
  });
  it('keeps the curator status when it is acked, done or dropped', () => {
    expect(effectiveTodoStatus(todo({ status: 'acked' }), []).label).toBe('Done, waiting for check');
    expect(effectiveTodoStatus(todo({ status: 'done' }), [{ todoId: 't1', action: 'done', at: ago(MIN) }]).status).toBe('done');
    expect(effectiveTodoStatus(todo({ status: 'dropped' }), []).status).toBe('dropped');
  });
  it('groups Now, Soon and Later, oldest first, acked after open, closed apart', () => {
    const list = [
      todo({ id: 'a', priority: 'now', createdAt: ago(1 * DAY) }),
      todo({ id: 'b', priority: 'now', createdAt: ago(5 * DAY) }),
      todo({ id: 'c', priority: 'now', createdAt: ago(9 * DAY) }),
      todo({ id: 'd', priority: 'soon', createdAt: ago(2 * DAY) }),
      todo({ id: 'e', priority: 'weird', createdAt: ago(2 * DAY) }),
      todo({ id: 'f', priority: 'later', status: 'done', createdAt: ago(2 * DAY) }),
    ];
    const g = sortTodos(list, [{ todoId: 'c', action: 'done', at: ago(MIN) }]);
    expect(g.now.map((t: Any) => t.id)).toEqual(['b', 'a', 'c']);
    expect(g.now[2].effective.status).toBe('acked');
    expect(g.soon.map((t: Any) => t.id)).toEqual(['d']);
    expect(g.later.map((t: Any) => t.id)).toEqual(['e']);
    expect(g.closed.map((t: Any) => t.id)).toEqual(['f']);
  });
});

describe('groupWorkstreams', () => {
  const ws = (key: string, over: Any = {}) => ({ key, name: key, status: 'working', facts: { lastActivityAt: ago(HOUR) }, updatedAt: ago(HOUR), ...over });
  it('groups Waiting on you, Moving, Waiting on others, On hold or planned and Done (30 days, collapsed)', () => {
    const groups = groupWorkstreams([
      ws('owner', { status: 'waiting_owner' }),
      ws('owner2', { status: 'live', waitingOn: 'owner' }),
      ws('blocked', { status: 'working', facts: { bucket: 'blocked', lastActivityAt: ago(HOUR) } }),
      ws('build', { status: 'working', facts: { lastActivityAt: ago(2 * HOUR) } }),
      ws('live', { status: 'live', facts: { lastActivityAt: ago(30 * MIN) } }),
      ws('ext', { status: 'waiting_external' }),
      ws('hold', { status: 'on_hold' }),
      ws('plan', { status: 'planned' }),
      ws('done', { status: 'done', statusChangedAt: ago(3 * DAY) }),
      ws('cancel', { status: 'cancelled', statusChangedAt: ago(10 * DAY) }),
      ws('olddone', { status: 'done', statusChangedAt: ago(40 * DAY) }),
    ], now);
    const by = Object.fromEntries(groups.map((g: Any) => [g.key, g]));
    expect(groups.map((g: Any) => g.label)).toEqual(['Waiting on you', 'Moving', 'Waiting on others', 'On hold or planned', 'Done in the last 30 days']);
    expect(by.owner.items.map((w: Any) => w.key).sort()).toEqual(['blocked', 'owner', 'owner2']);
    expect(by.moving.items.map((w: Any) => w.key)).toEqual(['live', 'build']);
    expect(by.others.items.map((w: Any) => w.key)).toEqual(['ext']);
    expect(by.parked.items.map((w: Any) => w.key).sort()).toEqual(['hold', 'plan']);
    expect(by.done.items.map((w: Any) => w.key)).toEqual(['done', 'cancel']);
    expect(by.done.collapsed).toBe(true);
    expect(by.done.olderHidden).toBe(1);
    expect(DONE_WINDOW_MS).toBe(30 * DAY);
  });
  it('treats an unknown status as moving', () => {
    const g = groupWorkstreams([ws('stub', { status: undefined, needsCuration: true })], now);
    expect(g.find((x: Any) => x.key === 'moving')!.items[0].key).toBe('stub');
  });
});

describe('shippedWindow and openPrSplit', () => {
  it('keeps releases from the last 14 days, newest first, and marks failed smoke red', () => {
    const r = shippedWindow([
      { id: 'rel-a', sha7: 'aaaaaaa', at: ago(2 * DAY), smoke: 'success', prs: [{ n: 1, title: 'One' }] },
      { id: 'rel-b', sha7: 'bbbbbbb', at: ago(1 * HOUR), smoke: 'failure', prs: [] },
      { id: 'rel-c', sha7: 'ccccccc', at: ago(15 * DAY), smoke: 'success', prs: [] },
    ], now);
    expect(r.map((x: Any) => x.id)).toEqual(['rel-b', 'rel-a']);
    expect(r[0].red).toBe(true);
    expect(r[1].red).toBe(false);
    expect(shippedWindow([{ id: 'x', at: ago(3 * DAY) }], now, 2)).toEqual([]);
  });
  it('splits open PRs program, dependabot and older, and flags a thread count mismatch', () => {
    expect(openPrSplit({ openProgramPrs: 2, openBotPrs: 9, openOlderPrs: 17, programPrsFromThreads: 2 })).toEqual({ program: 2, bot: 9, older: 17, fromThreads: 2, mismatch: false });
    expect(openPrSplit({ openProgramPrs: 2, openBotPrs: 0, openOlderPrs: 0, programPrsFromThreads: 1 }).mismatch).toBe(true);
    expect(openPrSplit({ openProgramPrs: null })).toEqual({ program: null, bot: null, older: null, fromThreads: null, mismatch: false });
  });
});

describe('feedMonthName, utcDay and testGuideFor', () => {
  it('names feed months in UTC, stepping back across a year end', () => {
    expect(feedMonthName('2026-10-08T22:00:00Z', 0)).toBe('feed-2026-10');
    expect(feedMonthName('2026-10-08T22:00:00Z', 1)).toBe('feed-2026-09');
    expect(feedMonthName('2026-01-31T23:59:00Z', 1)).toBe('feed-2025-12');
    expect(feedMonthName('2026-03-01T00:30:00Z', 14)).toBe('feed-2025-01');
  });
  it('gives the UTC day for the runs doc id', () => {
    expect(utcDay('2026-10-08T23:59:59Z')).toBe('2026-10-08');
    expect(utcDay(Date.UTC(2026, 0, 2, 1))).toBe('2026-01-02');
  });
  it('finds the test guide of the workstream that lists a shipped PR', () => {
    const ws = [
      { key: 'a', facts: { prs: [{ n: 1 }], artifacts: [{ id: 'x', url: 'https://claude.ai/artifact/x', title: 'Batch A plan' }, { id: 'g', url: 'https://claude.ai/artifact/g', title: 'Batch A test guide' }] } },
      { key: 'b', testGuide: { url: 'https://claude.ai/artifact/tg', title: 'B guide' }, facts: { prs: [{ n: 2 }] } },
      { key: 'c', testGuide: 'javascript:alert(1)', facts: { prs: [{ n: 3 }] } },
    ];
    expect(testGuideFor([1], ws)).toEqual({ url: 'https://claude.ai/artifact/g', title: 'Batch A test guide' });
    expect(testGuideFor([2], ws)).toEqual({ url: 'https://claude.ai/artifact/tg', title: 'B guide' });
    expect(testGuideFor([3], ws)).toBeNull();
    expect(testGuideFor([9], ws)).toBeNull();
  });
});

describe('latestPrTitle', () => {
  it('prefers the newest prstate title, then releases, prod titles and workstream facts', () => {
    const src = {
      prstate: [
        { number: 5, state: 'open', at: ago(3 * DAY), title: 'Old title' },
        { number: 5, state: 'merged', at: ago(DAY), title: 'New title' },
      ],
      releases: [{ prs: [{ n: 6, title: 'From release' }] }],
      state: { prodPrTitles: [{ n: 7, title: 'From prod' }] },
      ws: [{ facts: { prs: [{ n: 8, title: 'From ws' }] } }],
    };
    expect(latestPrTitle(5, src)).toBe('New title');
    expect(latestPrTitle(6, src)).toBe('From release');
    expect(latestPrTitle(7, src)).toBe('From prod');
    expect(latestPrTitle(8, src)).toBe('From ws');
    expect(latestPrTitle(9, src)).toBe('PR #9');
  });
});

describe('activityRows', () => {
  const rows = [
    { id: 'gh-merge-1', at: ago(1 * HOUR), kind: 'merge', actor: 'github', source: 'github', title: 'merged' },
    { id: 'gh-ci-1', at: ago(2 * HOUR), kind: 'incident', actor: 'ci', source: 'ci', title: 'CI failed' },
    { id: 'cur-1', at: ago(3 * HOUR), kind: 'decision', actor: 'owner', source: 'curator', title: 'decided' },
    { id: 'j-1', at: ago(4 * HOUR), kind: 'agent', actor: 'agent', source: 'journal', title: 'agent noise' },
    { id: 'n-1', at: ago(5 * HOUR), kind: 'milestone', actor: 'claude', source: 'note', title: 'note' },
  ];
  it('drops agent rows and sorts newest first', () => {
    expect(activityRows(rows, 'all').map((r: Any) => r.id)).toEqual(['gh-merge-1', 'gh-ci-1', 'cur-1', 'n-1']);
  });
  it('filters People and GitHub', () => {
    expect(activityRows(rows, 'github').map((r: Any) => r.id)).toEqual(['gh-merge-1', 'gh-ci-1']);
    expect(activityRows(rows, 'people').map((r: Any) => r.id)).toEqual(['cur-1', 'n-1']);
  });
  it('caps at ACTIVITY_LIMIT and de-duplicates ids across months', () => {
    expect(ACTIVITY_LIMIT).toBe(100);
    const many = Array.from({ length: 130 }, (_, i) => ({ id: `r${i}`, at: ago(i * MIN), kind: 'change', title: 't' }));
    expect(activityRows([...many, many[0]], 'all')).toHaveLength(100);
    expect(activityRows([...many, many[0]], 'all', Infinity)).toHaveLength(130);
  });
});

describe('docsByWs', () => {
  it('groups documents by workstream name, newest first, with an Unfiled group last', () => {
    const g = docsByWs(
      [
        { id: 'a', title: 'Plan A', ws: 'batch-b', updatedAt: ago(2 * DAY) },
        { id: 'b', title: 'Guide B', ws: 'batch-b', updatedAt: ago(1 * DAY) },
        { id: 'c', title: 'Loose', updatedAt: ago(DAY) },
        { id: 'd', title: 'Other', ws: 'gone', updatedAt: ago(DAY) },
      ],
      [{ key: 'batch-b', name: 'Batch B' }],
    );
    expect(g.map((x: Any) => x.name)).toEqual(['Batch B', 'gone', 'Unfiled']);
    expect(g[0].items.map((d: Any) => d.id)).toEqual(['b', 'a']);
  });
});

describe('askRules', () => {
  it('is built at call time from the headline and its asOf', () => {
    const r = askRules({ text: 'Batch B is live. Stage C waits on your go.', asOf: ago(3 * HOUR) }, now);
    expect(r).toContain('Batch B is live. Stage C waits on your go.');
    expect(r).toContain(fmtUtc(ago(3 * HOUR)));
    expect(r).toContain('3 h old');
    expect(r).toMatch(/only from the tools/i);
    expect(r).not.toMatch(/Oct 6 demo/);
  });
  it('says so when there is no headline yet', () => {
    expect(askRules(null, now)).toMatch(/No headline has been written yet/);
  });
});

describe('the built page', () => {
  it('ledger-page.html is up to date (run: node scripts/tracker/build-page.mjs)', () => {
    const committed = readFileSync(new URL('../scripts/tracker/ledger-page.html', import.meta.url), 'utf8');
    expect(committed === buildPageHtml(), 'scripts/tracker/ledger-page.html differs from the build output').toBe(true);
  });
  it('inlines page-logic with no import or export left, and keeps the publish skeleton out', () => {
    const html = buildPageHtml();
    expect(html).not.toMatch(/^\s*(import|export)\s/m);
    expect(html).not.toContain('@@PAGE_LOGIC@@');
    expect(html).toContain('function healthPill(');
    expect(html.startsWith('<title>')).toBe(true);
    expect(html).not.toMatch(/<!doctype|<html|<head>|<body/i);
  });
  it('writes only acks, chats and the viewer visit doc', () => {
    const html = buildPageHtml();
    const writes = [...html.matchAll(/\.doc\(([^)]*)\)\s*\.(set|update|delete)\(/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w, w).toMatch(/^'(acks|chats)\/'|^visitPath/);
    expect(html).not.toMatch(/collection\([^)]*\)\s*\.add\(/);
  });
  it('loads no external script and holds no phone number or email', () => {
    const html = buildPageHtml();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/\+\d{10,}/);
    expect(html).not.toMatch(/[\w.-]+@[\w-]+\.(com|ai|edu|org|net)\b/);
  });
  it('page-logic and build-page use Node built-ins only', () => {
    const logic = readFileSync(new URL('../scripts/tracker/page/page-logic.mjs', import.meta.url), 'utf8');
    expect(logic).not.toMatch(/^\s*import\s/m);
    const build = readFileSync(new URL('../scripts/tracker/build-page.mjs', import.meta.url), 'utf8');
    for (const m of build.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) expect(m[1].startsWith('node:'), m[1]).toBe(true);
  });
});
