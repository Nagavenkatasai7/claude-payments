import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quoteGrounded } from '../scripts/tracker/curate-core.mjs';
import {
  ARCHIVE_PLANS,
  SEED_FORMAT,
  denyListHits,
  loadSeedInputs,
  planSeed,
  scrubHits,
  seedSources,
  seedToPatch,
} from '../scripts/tracker/seed-v2.mjs';

type Any = any;

// A SYNTHETIC fixture (invented workstreams, no real names, no phone or email). The real seed is
// private and never committed (the repo is public). Its dates are fixed inside the fixture and
// every time the seed derives comes from seed.asOf, never from the wall clock.
const FX = join(__dirname, 'fixtures', 'tracker-v2');
const ROOT = join(__dirname, '..');
const load = () => loadSeedInputs({ file: join(FX, 'seed.json'), sources: join(FX, 'sources'), db: join(FX, 'db'), project: join(FX, 'project') });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// Synthetic names only; the real deny list is passed at runtime (--deny <file>), never committed.
const DENY = ['Zorblat Quinn', 'Mirela Vantor'];

function allEvidence(seed: Any): Any[] {
  const out: Any[] = [...(seed.headline?.evidence ?? [])];
  for (const coll of ['workstreams', 'todos', 'decisions', 'issues', 'events']) {
    for (const item of seed[coll] ?? []) out.push(...(item.evidence ?? []), ...(item.doneEvidence ?? []), ...(item.answerEvidence ?? []));
  }
  return out;
}
const writesOf = (plan: Any) => plan.batches.flat();
const docOf = (plan: Any, collection: string, id: string) => plan.docs.find((d: Any) => d.collection === collection && d.id === id)?.data;

describe('the seed fixture', () => {
  it('uses the documented format', () => {
    const { seed } = load();
    expect(seed.format).toBe(SEED_FORMAT);
  });

  it('every evidence quote is grounded in the copied sources, a PR title or a db doc', () => {
    const inputs = load();
    const sources = seedSources(inputs);
    const ev = allEvidence(inputs.seed);
    expect(ev.length).toBeGreaterThan(10);
    for (const e of ev) expect(quoteGrounded(e, sources), JSON.stringify(e)).toBeNull();
  });

  it('scrub finds nothing (no phone, email, token or long number anywhere)', () => {
    expect(scrubHits(load().seed)).toEqual([]);
  });

  it('contains no name from a deny list passed at runtime', () => {
    expect(denyListHits(load().seed, DENY)).toEqual([]);
    const file = process.env.LEDGER_SEED_DENY_FILE;
    if (file && existsSync(file)) {
      const names = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      expect(denyListHits(load().seed, names)).toEqual([]);
    }
  });
});

describe('scrubHits and denyListHits', () => {
  it('scrubHits reports the path of a planted phone number and email', () => {
    const seed = clone(load().seed);
    seed.todos[0].why = 'Call +919876543210 first.';
    seed.issues[0].detail = 'Reported by someone@gmail.com';
    const hits = scrubHits(seed).map((h: Any) => h.path);
    expect(hits).toEqual(expect.arrayContaining(['todos[0].why', 'issues[0].detail']));
  });

  it('denyListHits matches whole names, case-insensitive, and reports the path', () => {
    const seed = clone(load().seed);
    seed.workstreams[1].summary = 'Waiting on zorblat quinn for the retry numbers.';
    expect(denyListHits(seed, DENY)).toEqual([{ path: 'workstreams[1].summary', name: 'Zorblat Quinn' }]);
    expect(denyListHits({ a: 'Zorblat Quinnley' }, DENY)).toEqual([]);
    expect(denyListHits({ a: 'x' }, [])).toEqual([]);
  });
});

describe('planSeed', () => {
  it('accepts the fixture: no errors, no rejected op', () => {
    const plan = planSeed(load());
    expect(plan.errors).toEqual([]);
    expect(plan.rejected).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it('turns the seed into ops of the curator patch format', () => {
    const ops = seedToPatch(load().seed).ops.map((o: Any) => o.op);
    expect(ops[0]).toBe('setHeadline');
    expect(ops.filter((o: string) => o === 'upsertWs')).toHaveLength(3);
    expect(ops).toEqual(expect.arrayContaining(['createTodo', 'openDecision', 'openIssue', 'resolveIssue', 'addEvent']));
    expect(ops.indexOf('upsertWs')).toBeLessThan(ops.indexOf('createTodo'));
  });

  it('rejects a seed whose quote is not in the sources', () => {
    const inputs = load();
    inputs.seed = clone(inputs.seed);
    inputs.seed.todos[0].evidence = [{ kind: 'mem', ref: 'MEMORY.md', quote: 'this sentence is not in memory at all' }];
    const plan = planSeed(inputs);
    expect(plan.ok).toBe(false);
    expect(plan.rejected[0].reason).toMatch(/quote not found/);
    expect(plan.batches).toEqual([]);
  });

  it('rejects an ungrounded doneEvidence or answerEvidence quote', () => {
    const inputs = load();
    inputs.seed = clone(inputs.seed);
    inputs.seed.decisions[1].answerEvidence = [{ kind: 'mem', ref: 'MEMORY.md', quote: 'the owner picked green, not blue' }];
    const plan = planSeed(inputs);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join('\n')).toMatch(/decisions\[1\]\.answerEvidence/);
  });

  it('refuses a seed with a planted phone number or a deny-listed name', () => {
    const a = load();
    a.seed = clone(a.seed);
    a.seed.workstreams[0].summary = 'Call +919876543210.';
    expect(planSeed(a).ok).toBe(false);
    const b = load();
    b.seed = clone(b.seed);
    b.seed.todos[0].why = 'Mirela Vantor asked for it.';
    b.denyNames = DENY;
    const plan = planSeed(b);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join('\n')).toMatch(/deny list/);
  });

  it('records the owner id (decide and closeTodo authority) in meta/sync; null when the seed has none', () => {
    expect(docOf(planSeed(load()), 'meta', 'sync').ownerId).toBeNull();
    const a = load();
    a.seed = clone(a.seed);
    a.seed.ownerId = 'user_FixtureOwner01';
    expect(docOf(planSeed(a), 'meta', 'sync').ownerId).toBe('user_FixtureOwner01');
    const b = load();
    b.seed = clone(b.seed);
    b.seed.ownerId = 'Fixture Owner';
    const plan = planSeed(b);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join('\n')).toMatch(/ownerId/);
  });

  it('refuses ids that already exist in the dump', () => {
    const inputs = load();
    inputs.dump.ids.add('ws/widget-launch');
    inputs.dump.ids.add('meta/sync');
    const plan = planSeed(inputs);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join('\n')).toMatch(/ws\/widget-launch/);
    expect(plan.errors.join('\n')).toMatch(/meta\/sync/);
    expect(plan.batches).toEqual([]);
  });

  it('writes new ids as sets with no version', () => {
    const plan = planSeed(load());
    const sets = writesOf(plan).filter((w: Any) => w.op === 'set');
    expect(sets.length).toBeGreaterThan(10);
    for (const w of sets) expect(w.if_version, `${w.collection}/${w.doc_id}`).toBeUndefined();
  });

  it('builds the v2 docs with the seed statuses and real timestamps', () => {
    const plan = planSeed(load());
    const asOf = '2026-01-15T12:00:00Z';
    const ws = docOf(plan, 'ws', 'widget-launch');
    expect(ws).toMatchObject({ key: 'widget-launch', status: 'live', startedAt: '2026-01-04T09:00:00Z', createdAt: asOf });
    expect(ws.facts.prs).toEqual([{ n: 901, state: 'merged', title: 'Widget launch: badge, theme and help text', mergedAt: '2026-01-09T15:00:00Z' }]);
    expect(ws.facts.threadIds).toEqual(['cmsg_FixtureThreadA1']);
    const done = docOf(plan, 'todo', 'widget-launch-rotate-signing-key');
    expect(done).toMatchObject({ status: 'done', doneAt: '2026-01-13T16:00:00Z', prevStatus: 'open', statusChangedAt: '2026-01-13T16:00:00Z' });
    expect(done.doneEvidence).toHaveLength(1);
    const decided = docOf(plan, 'decisions', 'widget-theme');
    expect(decided).toMatchObject({ status: 'decided', answer: 'Blue', askedAt: '2026-01-12T09:30:00Z', decidedAt: '2026-01-12T10:05:00Z' });
    expect(decided.answerEvidence).toHaveLength(1);
    expect(docOf(plan, 'decisions', 'gadget-retry-policy')).toMatchObject({ status: 'open', askedAt: '2026-01-14T10:00:00Z' });
    expect(docOf(plan, 'issues', 'stale-alert-noise')).toMatchObject({ status: 'resolved', inferred: true });
    expect(docOf(plan, 'docs', 'art-fixture-guide')).toMatchObject({ kind: 'guide', ws: 'widget-launch', firstSeenAt: asOf });
    expect(docOf(plan, 'meta', 'headline')).toMatchObject({ short: 'Widget live; gadget waits', asOf });
  });

  it('writes no chg-* rows for the seed itself, but one cur-* row per seeded event', () => {
    const plan = planSeed(load());
    const feed = plan.docs.filter((d: Any) => d.collection.startsWith('feed-'));
    expect(feed.some((d: Any) => d.id.startsWith('chg-'))).toBe(false);
    const cur = feed.filter((d: Any) => d.id.startsWith('cur-'));
    expect(cur).toHaveLength(1);
    expect(cur[0]).toMatchObject({ collection: 'feed-2026-01', data: { kind: 'decision', at: '2026-01-12T10:05:00Z', source: 'curator' } });
  });

  it('backfills gh-* and non-agent j-* legacy events from backfillFrom, ids unchanged', () => {
    const plan = planSeed(load());
    const ids = plan.docs.filter((d: Any) => d.collection === 'feed-2026-01').map((d: Any) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['gh-merge-901', 'j-0a1b2c3d4e5f6a7b']));
    expect(ids).not.toContain('j-ffffeeeeddddcccc'); // agent row
    expect(ids).not.toContain('20260110T100000-abc123'); // hand-written legacy id
    expect(plan.docs.some((d: Any) => d.id === 'gh-pr-open-880')).toBe(false); // before backfillFrom
  });

  it('produces meta/archive, meta/sync (alone, last) and meta/cursors at asOf - 24 h', () => {
    const plan = planSeed(load());
    expect(docOf(plan, 'meta', 'archive')).toMatchObject({ name: 'Fixture program 2026-01', fixesDone: 3, fixesTotal: 4 });
    const sync = docOf(plan, 'meta', 'sync');
    expect(sync).toMatchObject({ schema: 2, routineThreadId: 'cmsg_FixtureRoutine01', cutoverAt: '2026-01-15T12:00:00Z', runningSince: null, reconcileAt: null });
    expect(sync.docCount).toBe(plan.docCount);
    const last = plan.batches[plan.batches.length - 1];
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ op: 'set', collection: 'meta', doc_id: 'sync' });
    const cursors = docOf(plan, 'meta', 'cursors');
    expect(cursors.threads.cmsg_FixtureThreadB2).toEqual({ ws: 'gadget-sync', lastMsgId: null, lastAt: '2026-01-14T12:00:00.000Z', readAt: '2026-01-15T12:00:00Z' });
    expect(cursors.threads.cmsg_FixtureRoutine01.ws).toBe('ledger');
    expect(cursors.memory.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds pinned archive markers to meta/program, every backlog doc and the listed plans only', () => {
    expect(ARCHIVE_PLANS).toEqual(['ui-redesign', 'ui-m5-customer', 'p3', 'p4']);
    const plan = planSeed(load());
    const markers = writesOf(plan).filter((w: Any) => w.op === 'update');
    const byId = Object.fromEntries(markers.map((w: Any) => [`${w.collection}/${w.doc_id}`, w]));
    expect(Object.keys(byId).sort()).toEqual(['backlog/old-widget-copy', 'backlog/stale-alert-noise', 'meta/program', 'plans/p3', 'plans/ui-redesign']);
    expect(byId['meta/program'].if_version).toBe(7);
    expect(byId['plans/p3'].if_version).toBe(5);
    expect(byId['meta/program'].data).toEqual({ archivedAt: '2026-01-15T12:00:00Z', archiveNote: 'Frozen 2026-01-15; the current state is on the Today tab' });
    expect(plan.warnings.join('\n')).toMatch(/plans\/ui-m5-customer/);
  });

  it('refuses an archive marker without a version', () => {
    const inputs = load();
    delete inputs.dump.versions['plans/p3'];
    const plan = planSeed(inputs);
    expect(plan.ok).toBe(false);
    expect(plan.errors.join('\n')).toMatch(/plans\/p3/);
  });

  it('keeps every batch within 50 writes and counts the writes per collection', () => {
    const plan = planSeed(load());
    for (const b of plan.batches) expect(b.length).toBeLessThanOrEqual(50);
    const counted: Record<string, number> = {};
    for (const w of writesOf(plan)) if (w.op === 'set') counted[w.collection] = (counted[w.collection] ?? 0) + 1;
    expect(plan.counts).toEqual(counted);
    expect(plan.counts).toMatchObject({ ws: 3, todo: 2, decisions: 2, issues: 3, docs: 1 });
    expect(plan.counts.meta).toBe(4); // headline, archive, cursors, sync
  });
});

describe('seed-v2.mjs and curate.mjs seed (CLI)', () => {
  const args = (out: string) => ['--file', join(FX, 'seed.json'), '--sources', join(FX, 'sources'), '--db', join(FX, 'db'), '--project', join(FX, 'project'), '--out', out];

  it('seed-v2.mjs writes batch files and prints the expected counts', () => {
    const out = mkdtempSync(join(tmpdir(), 'seed-'));
    const line = execFileSync('node', [join(ROOT, 'scripts/tracker/seed-v2.mjs'), ...args(out)], { encoding: 'utf8' }).trim().split('\n').pop()!;
    const summary = JSON.parse(line);
    expect(summary.ok).toBe(true);
    expect(summary.counts).toMatchObject({ ws: 3, todo: 2 });
    const batches = readdirSync(out).filter((f) => /^batch-\d+\.json$/.test(f));
    expect(batches.length).toBe(summary.batches.length);
    const first = JSON.parse(readFileSync(join(out, 'batch-0.json'), 'utf8'));
    expect(first[0].file_path).toMatch(/__/);
    expect(first[0].data).toBeUndefined();
  });

  it('curate.mjs seed runs the same plan', () => {
    const out = mkdtempSync(join(tmpdir(), 'seed-'));
    const line = execFileSync('node', [join(ROOT, 'scripts/tracker/curate.mjs'), 'seed', ...args(out)], { encoding: 'utf8' }).trim().split('\n').pop()!;
    expect(JSON.parse(line)).toMatchObject({ ok: true, counts: { ws: 3 } });
  });

  it('exits 2 and writes no batch when the seed is refused', () => {
    const out = mkdtempSync(join(tmpdir(), 'seed-'));
    let code = 0;
    try {
      execFileSync('node', [join(ROOT, 'scripts/tracker/seed-v2.mjs'), '--file', join(FX, 'seed.json'), '--sources', join(FX, 'sources'), '--db', join(FX, 'db'), '--out', out], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = (e as Any).status;
    }
    // Without --project the thread ids in the seed are unknown, so the ops that cite them are rejected.
    expect(code).toBe(2);
    expect(readdirSync(out).filter((f) => f.startsWith('batch-'))).toEqual([]);
  });
});
