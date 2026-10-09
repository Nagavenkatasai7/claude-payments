import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PATCH_SCHEMA,
  PatchError,
  advanceCursors,
  applyOps,
  buildSources,
  chgId,
  contradictsEngine,
  curId,
  dedupeByTitle,
  feedMonth,
  foldAcks,
  isOwnerMessage,
  normalizeThreadMessages,
  planWrites,
  quoteGrounded,
  validatePatch,
} from '../scripts/tracker/curate-core.mjs';

// Relative dates only (CLAUDE.md fixture rule).
const NOW = Date.now();
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const now = new Date(NOW).toISOString();
const RUN = 'run-test-1';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

type Any = any;

// ---------- fixture: one fetched thread (fetch_thread shape), files, PRs, artifacts, inbox ----------
const T1 = 'cmsg_T1thread';
const T2 = 'cmsg_T2thread';
const thread1 = {
  thread_id: T1,
  messages: [
    { id: 'cmsg_owner_new', thread_id: T1, created_at: ago(1 * HOUR), author: 'user', author_id: 'user_01OWNER', body: 'I set the SMTP password in Vercel and the alert email arrived.' },
    { id: 'cmsg_agent_ok', thread_id: T1, created_at: ago(2 * HOUR), author: 'agent', body: 'Batch B merged as #483 and the smoke run passed on main.' },
    { id: 'cmsg_agent_plan', thread_id: T1, created_at: ago(3 * HOUR), author: 'agent', body: 'Next I will look at the SMTP settings for the alert email.' },
    { id: 'cmsg_owner_old', thread_id: T1, created_at: ago(48 * HOUR), author: 'user', author_id: 'user_01OWNER', body: 'Go with the free FX feed for now, we can switch later.' },
    { id: 'cmsg_status', thread_id: T1, created_at: ago(4 * HOUR), author: 'agent', body: JSON.stringify({ kind: 'status', text: 'Ledger build\n\n✓ Wrote the engine changes' }) },
  ],
  cursor: 'x',
  has_more: false,
};
const sources = buildSources({
  threads: [thread1],
  files: { 'MEMORY.md': 'Batch B is live in production since the merge.\nKNOWN BUGS: the mask glyph renders wrong on Android phones.' },
  prs: [{ n: 483, title: 'Batch B: order references, payment links' }, { n: 484, title: 'Follow-up work still in progress' }],
  artifacts: [{ id: 'art-1', title: 'Batch B Test Guide for the owner' }],
  inbox: { 'n-abc': { text: 'Owner approved the Stage C go decision today.' } },
});
const ev = (kind: string, ref: string, quote: string) => ({ kind, ref, quote });
const E_OWNER = ev('msg', 'cmsg_owner_new', 'I set the SMTP password in Vercel');
const E_AGENT_OK = ev('msg', 'cmsg_agent_ok', 'the smoke run passed on main');
const E_AGENT_PLAN = ev('msg', 'cmsg_agent_plan', 'Next I will look at the SMTP settings');
const E_OWNER_OLD = ev('msg', 'cmsg_owner_old', 'Go with the free FX feed for now');
const E_MEM = ev('mem', 'MEMORY.md', 'Batch B is live in production');
const E_PR483 = ev('pr', '483', 'Batch B: order references');
const E_PR484 = ev('pr', '#484', 'Follow-up work still in progress');

function baseDump(): Any {
  return {
    ws: {
      'batch-b': { key: 'batch-b', name: 'Batch B', status: 'working', summary: 'Building.', nextStep: 'Merge.', waitingOn: 'none', facts: { threadIds: [T1], prs: [] }, startedAt: ago(200 * HOUR), createdAt: ago(200 * HOUR), updatedAt: ago(20 * HOUR), prevStatus: null, statusChangedAt: ago(200 * HOUR), evidence: [] },
      'old-ws': { key: 'old-ws', name: 'Old work', status: 'done', summary: 'Shipped.', nextStep: '', waitingOn: 'none', facts: { threadIds: [], prs: [] }, startedAt: ago(900 * HOUR), createdAt: ago(900 * HOUR), updatedAt: ago(500 * HOUR), prevStatus: 'live', statusChangedAt: ago(500 * HOUR), evidence: [] },
    },
    todo: {
      'batch-b-smtp': { title: 'Set the SMTP password', why: 'Alerts fail.', steps: [], where: null, priority: 'now', ws: 'batch-b', threadId: T1, status: 'open', createdAt: ago(30 * HOUR), updatedAt: ago(30 * HOUR), prevStatus: null, statusChangedAt: ago(30 * HOUR), doneAt: null, evidence: [], doneEvidence: [], reopenReason: null },
      'batch-b-finished': { title: 'Approve the merge', why: '', steps: [], where: null, priority: 'now', ws: 'batch-b', threadId: T1, status: 'done', createdAt: ago(90 * HOUR), updatedAt: ago(60 * HOUR), prevStatus: 'open', statusChangedAt: ago(60 * HOUR), doneAt: ago(60 * HOUR), evidence: [], doneEvidence: [], reopenReason: null },
      'batch-b-acked': { title: 'Rotate the bot token', why: '', steps: [], where: null, priority: 'soon', ws: 'batch-b', threadId: T1, status: 'open', createdAt: ago(50 * HOUR), updatedAt: ago(50 * HOUR), prevStatus: null, statusChangedAt: ago(50 * HOUR), doneAt: null, evidence: [], doneEvidence: [], reopenReason: null },
    },
    acks: {
      'batch-b-acked--1': { todoId: 'batch-b-acked', action: 'done', at: ago(5 * HOUR), by: 'user_01OWNER', note: '' },
    },
    decisions: {
      'paid-fx-feed': { question: 'Use the paid FX feed?', options: [{ label: 'Free', consequence: 'ECB only' }, { label: 'Paid', consequence: 'Costs money' }], recommended: 'Free', status: 'open', askedAt: ago(72 * HOUR), decidedAt: null, answer: null, by: 'owner', threadId: T1, ws: 'batch-b', refs: { pr: [], artifact: null }, createdAt: ago(72 * HOUR), updatedAt: ago(72 * HOUR), prevStatus: null, statusChangedAt: ago(72 * HOUR), evidence: [], answerEvidence: [] },
      'fresh-q': { question: 'Ship on Friday?', options: [{ label: 'Yes', consequence: '' }, { label: 'No', consequence: '' }], recommended: 'No', status: 'open', askedAt: ago(0.5 * HOUR), decidedAt: null, answer: null, by: 'owner', threadId: T1, ws: 'batch-b', refs: { pr: [], artifact: null }, createdAt: ago(0.5 * HOUR), updatedAt: ago(0.5 * HOUR), prevStatus: null, statusChangedAt: ago(0.5 * HOUR), evidence: [], answerEvidence: [] },
    },
    issues: {
      'mask-glyph': { title: 'Mask glyph renders wrong', detail: '', kind: 'bug', severity: 'low', status: 'resolved', ws: null, openedAt: ago(300 * HOUR), resolvedAt: ago(100 * HOUR), resolution: 'Fixed.', createdAt: ago(300 * HOUR), updatedAt: ago(100 * HOUR), prevStatus: 'open', statusChangedAt: ago(100 * HOUR), evidence: [] },
    },
    docs: { 'art-1': { title: 'Batch B Test Guide for the owner', url: 'https://claude.ai/artifact/G', kind: 'other', status: 'current', ws: null, updatedAt: ago(3 * HOUR), firstSeenAt: ago(3 * HOUR) } },
    inbox: { 'n-abc': { at: ago(1 * HOUR), threadId: T2, kind: 'decision', text: 'Owner approved the Stage C go decision today.', refs: {}, processedAt: null } },
    meta: {
      headline: { text: 'Batch B is building.', short: 'Batch B building', asOf: ago(20 * HOUR), evidence: [], updatedAt: ago(20 * HOUR), runId: 'run-old' },
      cursors: { threads: { [T1]: { ws: 'batch-b', lastMsgId: 'cmsg_older', lastAt: ago(10 * HOUR), readAt: ago(10 * HOUR) } }, memory: { sha256: 'old', readAt: ago(30 * HOUR) }, reviews: {} },
    },
  };
}
const ghPrs = { 483: { state: 'merged', mergedAt: ago(2 * HOUR), title: 'Batch B: order references, payment links' }, 484: { state: 'open', mergedAt: null, title: 'Follow-up work still in progress' } };
const threads = { [T1]: { threadId: T1, title: 'Batch B' }, [T2]: { threadId: T2, title: 'Stage C' } };
const factsFor = (dump: Any = baseDump()) => ({ dump, prs: ghPrs, threads });

const one = (op: Any, dump: Any = baseDump()) => validatePatch({ ops: [op] }, sources, factsFor(dump));
const reasonOf = (op: Any, dump?: Any) => {
  const r = one(op, dump);
  expect(r.accepted).toHaveLength(0);
  expect(r.rejected).toHaveLength(1);
  return r.rejected[0].reason as string;
};
const accepts = (op: Any, dump?: Any) => {
  const r = one(op, dump);
  expect(r.rejected).toEqual([]);
  expect(r.accepted).toHaveLength(1);
  return r.accepted[0];
};

// ---------- sources ----------
describe('thread messages and sources', () => {
  it('owner = a message whose author kind is human (author "user", or from "human")', () => {
    expect(isOwnerMessage({ author: 'user' })).toBe(true);
    expect(isOwnerMessage({ from: 'human' })).toBe(true);
    expect(isOwnerMessage({ author: 'agent' })).toBe(false);
    expect(isOwnerMessage({ author: 'agent', author_name: 'user' })).toBe(false);
  });

  it('normalises fetch_thread output, unwrapping status-message JSON to its text', () => {
    const ms = normalizeThreadMessages(thread1);
    expect(ms[0]).toEqual({ id: 'cmsg_owner_new', threadId: T1, owner: true, authorId: 'user_01OWNER', createdAt: ago(1 * HOUR), text: 'I set the SMTP password in Vercel and the alert email arrived.' });
    expect(ms.find((m: Any) => m.id === 'cmsg_status').text).toBe('Ledger build\n\n✓ Wrote the engine changes');
  });

  it('PATCH_SCHEMA lists every op', () => {
    expect(Object.keys(PATCH_SCHEMA).sort()).toEqual(
      ['addEvent', 'classifyDoc', 'closeTodo', 'createTodo', 'decide', 'mapThread', 'openDecision', 'openIssue', 'processInbox', 'resolveIssue', 'setHeadline', 'updateIssue', 'updateTodo', 'upsertWs', 'withdraw'].sort(),
    );
  });
});

// ---------- quoteGrounded ----------
describe('quoteGrounded', () => {
  it('accepts a verbatim substring of the referenced message', () => {
    expect(quoteGrounded(E_OWNER, sources)).toBeNull();
  });
  it('normalises whitespace on both sides', () => {
    expect(quoteGrounded(ev('msg', 'cmsg_owner_new', 'I set   the SMTP\n password'), sources)).toBeNull();
    expect(quoteGrounded(ev('msg', 'cmsg_status', 'Ledger build ✓ Wrote the engine'), sources)).toBeNull();
  });
  it('rejects a quote that is not in the source (paraphrase)', () => {
    expect(quoteGrounded(ev('msg', 'cmsg_owner_new', 'I configured the SMTP password'), sources)).toMatch(/not found/);
  });
  it('rejects a quote under 12 or over 160 characters', () => {
    expect(quoteGrounded(ev('msg', 'cmsg_owner_new', 'I set the'), sources)).toMatch(/12-160/);
    expect(quoteGrounded(ev('mem', 'MEMORY.md', 'x'.repeat(161)), sources)).toMatch(/12-160/);
  });
  it('rejects a ref outside the fetched set', () => {
    expect(quoteGrounded(ev('msg', 'cmsg_not_fetched', 'I set the SMTP password'), sources)).toMatch(/fetched set/);
    expect(quoteGrounded(ev('file', 'reviews/other.md', 'Batch B is live in production'), sources)).toMatch(/fetched set/);
  });
  it('checks PR titles, artifact titles, memory files and inbox docs', () => {
    expect(quoteGrounded(E_PR483, sources)).toBeNull();
    expect(quoteGrounded(E_PR484, sources)).toBeNull();
    expect(quoteGrounded(ev('art', 'art-1', 'Batch B Test Guide'), sources)).toBeNull();
    expect(quoteGrounded(ev('mem', 'MEMORY.md', 'the mask glyph renders wrong'), sources)).toBeNull();
    expect(quoteGrounded(ev('inbox', 'n-abc', 'approved the Stage C go decision'), sources)).toBeNull();
  });
  it('rejects an unknown evidence kind', () => {
    expect(quoteGrounded(ev('web', 'x', 'Batch B is live in production'), sources)).toMatch(/kind/);
  });
});

// ---------- validatePatch: generic rejections ----------
describe('validatePatch rejections (one rule each)', () => {
  it('throws PatchError on a malformed patch (exit 2 in the CLI)', () => {
    expect(() => validatePatch(null, sources, factsFor())).toThrow(PatchError);
    expect(() => validatePatch({ ops: 'x' }, sources, factsFor())).toThrow(PatchError);
    expect(() => validatePatch('{', sources, factsFor())).toThrow(PatchError);
  });

  it('rejects an unknown op', () => {
    expect(reasonOf({ op: 'renameEverything', evidence: [E_OWNER] })).toMatch(/unknown op/);
  });

  it('rejects any op that would delete', () => {
    expect(reasonOf({ op: 'deleteTodo', id: 'batch-b-smtp', evidence: [E_OWNER] })).toMatch(/nothing deletes/);
    expect(reasonOf({ op: 'updateTodo', id: 'batch-b-smtp', delete: true, evidence: [E_OWNER] })).toMatch(/nothing deletes/);
  });

  it('rejects a schema failure: enum, length cap, slug, unknown field, missing field', () => {
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', status: 'shipped', evidence: [E_MEM] })).toMatch(/status/);
    expect(reasonOf({ op: 'createTodo', ws: 'batch-b', title: 'x'.repeat(91), priority: 'now', evidence: [E_OWNER] })).toMatch(/title/);
    expect(reasonOf({ op: 'upsertWs', key: 'Batch B!', name: 'B', status: 'working', evidence: [E_MEM] })).toMatch(/key/);
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', colour: 'red', evidence: [E_MEM] })).toMatch(/unknown field colour/);
    expect(reasonOf({ op: 'createTodo', ws: 'batch-b', priority: 'now', evidence: [E_OWNER] })).toMatch(/title/);
  });

  it('rejects an op with no evidence', () => {
    expect(reasonOf({ op: 'setHeadline', text: 'Batch B is live.', short: 'Batch B live', evidence: [] })).toMatch(/evidence/);
  });

  it('rejects text that scrub() would change (phone, email, token, long number)', () => {
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', summary: 'Call the partner on +919876543210.', evidence: [E_MEM] })).toMatch(/scrub/);
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', summary: 'Mail someone@gmail.com about it.', evidence: [E_MEM] })).toMatch(/scrub/);
  });

  it('rejects a quote that is not in the referenced source', () => {
    expect(reasonOf({ op: 'setHeadline', text: 'Batch B is live.', short: 'Batch B live', evidence: [ev('mem', 'MEMORY.md', 'Batch B shipped to everyone')] })).toMatch(/not found/);
  });

  it('rejects a ref outside this run\'s fetched set', () => {
    expect(reasonOf({ op: 'setHeadline', text: 'Batch B is live.', short: 'Batch B live', evidence: [ev('msg', 'cmsg_elsewhere', 'Batch B is live in production')] })).toMatch(/fetched set/);
  });

  it('rejects live or done citing a PR that GitHub does not show as merged', () => {
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', status: 'live', evidence: [E_PR484] })).toMatch(/#484.*not.*merged/);
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', status: 'done', prs: [484], evidence: [E_MEM] })).toMatch(/#484/);
    expect(accepts({ op: 'upsertWs', key: 'batch-b', status: 'live', evidence: [E_PR483, E_MEM] }).status).toBe('live');
    expect(contradictsEngine({ op: 'upsertWs', key: 'x', status: 'working', prs: [484], evidence: [] }, factsFor())).toBeNull();
  });

  it('rejects closeTodo without an owner message, a verification message or an ack', () => {
    expect(reasonOf({ op: 'closeTodo', id: 'batch-b-smtp', status: 'done', evidence: [E_AGENT_PLAN] })).toMatch(/owner/);
    expect(accepts({ op: 'closeTodo', id: 'batch-b-smtp', status: 'done', evidence: [E_OWNER] }).id).toBe('batch-b-smtp');
    expect(accepts({ op: 'closeTodo', id: 'batch-b-smtp', status: 'done', evidence: [E_AGENT_OK] }).id).toBe('batch-b-smtp');
    // The page's ack folds the to-do to 'acked'; that is enough authority, with no quote.
    expect(accepts({ op: 'closeTodo', id: 'batch-b-acked', status: 'done', evidence: [] }).id).toBe('batch-b-acked');
  });

  it('rejects decide without an owner message later than askedAt', () => {
    // Owner message older than askedAt.
    expect(reasonOf({ op: 'decide', id: 'fresh-q', answer: 'Yes', evidence: [E_OWNER] })).toMatch(/later than askedAt/);
    // Agent message only.
    expect(reasonOf({ op: 'decide', id: 'paid-fx-feed', answer: 'Free', evidence: [E_AGENT_OK] })).toMatch(/owner message/);
    const ok = accepts({ op: 'decide', id: 'paid-fx-feed', answer: 'Free', evidence: [E_OWNER_OLD] });
    expect(ok.decidedAt).toBe(ago(48 * HOUR));
  });

  it('rejects done -> open without a reopenReason', () => {
    expect(reasonOf({ op: 'updateTodo', id: 'batch-b-finished', status: 'open', evidence: [E_OWNER] })).toMatch(/reopenReason/);
    expect(accepts({ op: 'updateTodo', id: 'batch-b-finished', status: 'open', reopenReason: 'The owner says it failed again.', evidence: [E_OWNER] }).status).toBe('open');
    expect(reasonOf({ op: 'upsertWs', key: 'old-ws', status: 'working', evidence: [E_MEM] })).toMatch(/reopenReason/);
    expect(reasonOf({ op: 'updateIssue', id: 'mask-glyph', status: 'open', evidence: [ev('mem', 'MEMORY.md', 'the mask glyph renders wrong')] })).toMatch(/reopenReason/);
  });

  it('rejects ops on ids that do not exist, unknown threads and unknown workstreams', () => {
    expect(reasonOf({ op: 'updateTodo', id: 'nope-todo', why: 'x', evidence: [E_OWNER] })).toMatch(/does not exist/);
    expect(reasonOf({ op: 'mapThread', threadId: 'cmsg_unknown', ws: 'batch-b', evidence: [E_OWNER] })).toMatch(/unknown thread/);
    expect(reasonOf({ op: 'mapThread', threadId: T1, ws: 'no-such-ws', evidence: [E_OWNER] })).toMatch(/unknown ws/);
    expect(reasonOf({ op: 'createTodo', ws: 'no-such-ws', title: 'Do a thing now', priority: 'now', evidence: [E_OWNER] })).toMatch(/unknown ws/);
    expect(reasonOf({ op: 'classifyDoc', id: 'art-404', kind: 'plan', status: 'current', evidence: [E_OWNER] })).toMatch(/does not exist/);
    expect(reasonOf({ op: 'processInbox', id: 'n-missing' })).toMatch(/does not exist/);
  });

  it('rejects a createTodo whose id exists with a different title (no silent overwrite)', () => {
    expect(reasonOf({ op: 'createTodo', id: 'batch-b-smtp', ws: 'batch-b', title: 'Something else entirely', priority: 'now', evidence: [E_OWNER] })).toMatch(/exists/);
  });
});

// ---------- validatePatch: sequencing and dedupe ----------
describe('validatePatch sequencing and dedupe', () => {
  it('validates ops in order against the state after the earlier accepted ops', () => {
    const r = validatePatch(
      {
        ops: [
          { op: 'upsertWs', key: 'stage-c', name: 'Stage C', status: 'planned', evidence: [ev('inbox', 'n-abc', 'Stage C go decision')] },
          { op: 'createTodo', ws: 'stage-c', title: 'Check the alert email', priority: 'soon', evidence: [E_OWNER] },
          { op: 'closeTodo', id: 'stage-c-check-the-alert-email', status: 'done', evidence: [E_OWNER] },
        ],
      },
      sources,
      factsFor(),
    );
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((o: Any) => o.op)).toEqual(['upsertWs', 'createTodo', 'closeTodo']);
  });

  it('merges a duplicate title (normalised) into the existing item', () => {
    expect(dedupeByTitle(baseDump().todo, '  set the SMTP   password ', ['open', 'acked'])).toBe('batch-b-smtp');
    const a = accepts({ op: 'createTodo', ws: 'batch-b', title: 'Set the smtp password!', priority: 'soon', evidence: [E_OWNER] });
    expect(a.op).toBe('createTodo');
    expect(a.id).toBe('batch-b-smtp');
    expect(a.mergedInto).toBe('batch-b-smtp');
  });

  it('gives a new to-do a deterministic <ws>-<slug> id', () => {
    expect(accepts({ op: 'createTodo', ws: 'batch-b', title: 'Check the alert email', priority: 'soon', evidence: [E_OWNER] }).id).toBe('batch-b-check-the-alert-email');
  });
});

// ---------- foldAcks and advanceCursors ----------
describe('foldAcks', () => {
  it('folds an ack newer than the last status change into acked; ignores older acks and closed items', () => {
    const d = baseDump();
    const acks = { ...d.acks, 'batch-b-smtp--0': { todoId: 'batch-b-smtp', action: 'done', at: ago(40 * HOUR) }, 'batch-b-finished--9': { todoId: 'batch-b-finished', action: 'dismiss', at: ago(1 * HOUR) } };
    const todo = foldAcks(d.todo, acks);
    expect(todo['batch-b-acked'].status).toBe('acked');
    expect(todo['batch-b-smtp'].status).toBe('open'); // ack is older than the open (a reopen) time
    expect(todo['batch-b-finished'].status).toBe('done');
    expect(d.todo['batch-b-acked'].status).toBe('open'); // input not mutated
  });
});

describe('advanceCursors', () => {
  it('advances every fetched thread (readAt now, lastAt never goes back), keeps the ws mapping', () => {
    const c = baseDump().meta.cursors;
    const next = advanceCursors(c, { threads: [{ threadId: T1, lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR) }, { threadId: T2, lastMsgId: null, lastAt: ago(2 * HOUR) }], memory: { sha256: 'new' } }, now);
    expect(next.threads[T1]).toEqual({ ws: 'batch-b', lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR), readAt: now });
    expect(next.threads[T2]).toEqual({ lastMsgId: null, lastAt: ago(2 * HOUR), readAt: now });
    expect(next.memory).toEqual({ sha256: 'new', readAt: now });
    const back = advanceCursors(next, { threads: [{ threadId: T1, lastMsgId: 'cmsg_x', lastAt: ago(5 * HOUR) }] }, now);
    expect(back.threads[T1].lastAt).toBe(ago(1 * HOUR));
    expect(back.threads[T1].lastMsgId).toBe('cmsg_owner_new');
  });
});

// ---------- applyOps ----------
describe('applyOps', () => {
  const fetched = { threads: [{ threadId: T1, lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR) }] };
  const run = (ops: Any[], dump: Any = baseDump(), extra: Any = {}) => {
    const facts = { ...factsFor(dump), fetched, ...extra };
    const v = validatePatch({ ops }, sources, facts);
    expect(v.rejected).toEqual([]);
    return { v, out: applyOps(dump, v.accepted, facts, now, RUN) };
  };
  const changed = (out: Any) => out.changes.map((c: Any) => `${c.collection}/${c.id}`).sort();

  it('copies untouched docs forward unchanged and writes only what changed', () => {
    const dump = baseDump();
    const { out } = run([{ op: 'updateTodo', id: 'batch-b-smtp', why: 'Alert emails fail without it.', evidence: [E_OWNER] }], dump);
    expect(out.dump.ws).toEqual(dump.ws);
    expect(out.dump.decisions).toEqual(dump.decisions);
    expect(out.dump.issues).toEqual(dump.issues);
    // batch-b-acked folds to acked (status change) and cursors advance.
    expect(changed(out)).toEqual(expect.arrayContaining(['meta/cursors', 'todo/batch-b-acked', 'todo/batch-b-smtp']));
    expect(changed(out).filter((x: string) => !x.startsWith('feed-'))).toEqual(['meta/cursors', 'todo/batch-b-acked', 'todo/batch-b-smtp']);
  });

  it('stamps updatedAt only on a content change; createdAt never moves', () => {
    const dump = baseDump();
    const { out } = run([{ op: 'updateTodo', id: 'batch-b-smtp', why: 'Alert emails fail without it.', evidence: [E_OWNER] }], dump);
    const t = out.dump.todo['batch-b-smtp'];
    expect(t.updatedAt).toBe(now);
    expect(t.createdAt).toBe(dump.todo['batch-b-smtp'].createdAt);
    expect(t.statusChangedAt).toBe(dump.todo['batch-b-smtp'].statusChangedAt);
    expect(t.evidence).toEqual([E_OWNER]);
    // Same values again: no change, no evidence append, no stamp.
    const { out: same } = run([{ op: 'updateTodo', id: 'batch-b-smtp', why: 'Alerts fail.', evidence: [E_OWNER] }], dump);
    expect(same.dump.todo['batch-b-smtp']).toEqual(dump.todo['batch-b-smtp']);
    expect(changed(same)).not.toContain('todo/batch-b-smtp');
  });

  it('a status change stamps prevStatus and statusChangedAt and emits one deterministic chg-* row', () => {
    const { out } = run([{ op: 'closeTodo', id: 'batch-b-smtp', status: 'done', evidence: [E_OWNER] }]);
    const t = out.dump.todo['batch-b-smtp'];
    expect(t).toMatchObject({ status: 'done', prevStatus: 'open', statusChangedAt: now, doneAt: now, doneEvidence: [E_OWNER] });
    const id = 'chg-' + sha1(`todo|batch-b-smtp|open|done|${RUN}`).slice(0, 16);
    expect(chgId('todo', 'batch-b-smtp', 'open', 'done', RUN)).toBe(id);
    const row: Any = out.changes.find((c: Any) => c.id === id);
    expect(row.collection).toBe(feedMonth(now));
    expect(row.isNew).toBe(true);
    expect(row.data).toMatchObject({ at: now, kind: 'change', source: 'curator', refs: { todo: 'batch-b-smtp', ws: 'batch-b' } });
    expect(row.data.title.length).toBeLessThanOrEqual(140);
  });

  it('a new to-do gets createdAt/updatedAt now and a chg row from nothing to open', () => {
    const { out } = run([{ op: 'createTodo', ws: 'batch-b', title: 'Check the alert email', priority: 'soon', threadId: T1, evidence: [E_OWNER] }]);
    const t = out.dump.todo['batch-b-check-the-alert-email'];
    expect(t).toMatchObject({ title: 'Check the alert email', status: 'open', priority: 'soon', ws: 'batch-b', createdAt: now, updatedAt: now, prevStatus: null, statusChangedAt: now });
    expect(out.changes.some((c: Any) => c.id === chgId('todo', 'batch-b-check-the-alert-email', '', 'open', RUN))).toBe(true);
  });

  it('decide records answer, decidedAt from the owner message and answerEvidence', () => {
    const { out } = run([{ op: 'decide', id: 'paid-fx-feed', answer: 'Free', evidence: [E_OWNER_OLD] }]);
    expect(out.dump.decisions['paid-fx-feed']).toMatchObject({ status: 'decided', answer: 'Free', decidedAt: ago(48 * HOUR), answerEvidence: [E_OWNER_OLD], prevStatus: 'open' });
  });

  it('ws: narrative from ops, facts from collect, stubs added, needsCuration cleared', () => {
    const wsFacts = { 'batch-b': { threadIds: [T1], bucket: 'working', resolved: false, lastActivityAt: ago(1 * HOUR), prs: [{ n: 483, state: 'merged', title: 'Batch B', mergedAt: ago(2 * HOUR) }], artifacts: [] } };
    const stub = { key: 'new-idea', name: 'New idea', status: 'working', summary: '', nextStep: '', waitingOn: 'none', facts: { threadIds: [T2] }, startedAt: ago(5 * HOUR), needsCuration: true, createdAt: now, updatedAt: now, prevStatus: null, statusChangedAt: now, evidence: [] };
    const { out } = run([{ op: 'upsertWs', key: 'batch-b', status: 'live', summary: 'Batch B is live.', evidence: [E_PR483] }], baseDump(), { wsFacts, stubs: [stub] });
    expect(out.dump.ws['batch-b']).toMatchObject({ status: 'live', summary: 'Batch B is live.', facts: wsFacts['batch-b'], prevStatus: 'working', statusChangedAt: now, updatedAt: now });
    expect(out.dump.ws['new-idea']).toEqual(stub);
    expect(changed(out)).toContain('ws/new-idea');
  });

  it('curating a stub clears needsCuration', () => {
    const dump = baseDump();
    dump.ws['new-idea'] = { key: 'new-idea', name: 'New idea', status: 'working', summary: '', nextStep: '', waitingOn: 'none', facts: { threadIds: [T2] }, startedAt: ago(5 * HOUR), needsCuration: true, createdAt: ago(5 * HOUR), updatedAt: ago(5 * HOUR), prevStatus: null, statusChangedAt: ago(5 * HOUR), evidence: [] };
    const { out } = run([{ op: 'upsertWs', key: 'new-idea', summary: 'Stage C go decision recorded.', evidence: [ev('inbox', 'n-abc', 'Stage C go decision')] }], dump);
    expect(out.dump.ws['new-idea']).toMatchObject({ needsCuration: false, summary: 'Stage C go decision recorded.', updatedAt: now });
  });

  it('a merged duplicate keeps the existing title', () => {
    const { out } = run([{ op: 'createTodo', ws: 'batch-b', title: 'Set the smtp password!', priority: 'soon', evidence: [E_OWNER] }]);
    expect(out.dump.todo['batch-b-smtp']).toMatchObject({ title: 'Set the SMTP password', priority: 'soon' });
  });

  it('a facts-only change writes the ws doc without bumping updatedAt', () => {
    const dump = baseDump();
    const wsFacts = { 'batch-b': { ...dump.ws['batch-b'].facts, lastActivityAt: ago(1 * HOUR) } };
    const { out } = run([], dump, { wsFacts });
    expect(out.dump.ws['batch-b'].facts).toEqual(wsFacts['batch-b']);
    expect(out.dump.ws['batch-b'].updatedAt).toBe(dump.ws['batch-b'].updatedAt);
    expect(changed(out)).toContain('ws/batch-b');
  });

  it('cursors advance for every fetched thread even with zero accepted ops', () => {
    const { out } = run([]);
    expect(out.dump.meta.cursors.threads[T1]).toMatchObject({ lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR), readAt: now, ws: 'batch-b' });
    expect(changed(out)).toContain('meta/cursors');
  });

  it('mapThread writes the mapping into meta/cursors', () => {
    const { out } = run([{ op: 'mapThread', threadId: T2, ws: 'batch-b', evidence: [E_OWNER] }]);
    expect(out.dump.meta.cursors.threads[T2].ws).toBe('batch-b');
  });

  it('setHeadline writes meta/headline with asOf now; the same text again writes nothing', () => {
    const { out } = run([{ op: 'setHeadline', text: 'Batch B is live in production.', short: 'Batch B live', evidence: [E_MEM] }]);
    expect(out.dump.meta.headline).toEqual({ text: 'Batch B is live in production.', short: 'Batch B live', asOf: now, evidence: [E_MEM], updatedAt: now, runId: RUN });
    const again = applyOps(out.dump, [{ op: 'setHeadline', text: 'Batch B is live in production.', short: 'Batch B live', evidence: [E_MEM] }], { ...factsFor(out.dump), fetched }, now, 'run-later');
    expect(again.changes).toEqual([]);
  });

  it('addEvent writes a cur-* feed row with a deterministic id; processInbox stamps processedAt', () => {
    const { out } = run([
      { op: 'addEvent', kind: 'decision', title: 'Owner chose the free FX feed', at: ago(48 * HOUR), evidence: [E_OWNER_OLD] },
      { op: 'processInbox', id: 'n-abc' },
    ]);
    const id = curId(T1, 'cmsg_owner_old', 'decision', 'owner-chose-the-free-fx-feed');
    expect(id).toBe('cur-' + sha1(`${T1}|cmsg_owner_old|decision|owner-chose-the-free-fx-feed`).slice(0, 16));
    const row: Any = out.changes.find((c: Any) => c.id === id);
    expect(row.collection).toBe(feedMonth(ago(48 * HOUR)));
    expect(row.data).toMatchObject({ kind: 'decision', actor: 'owner', source: 'curator', at: ago(48 * HOUR), refs: { threadId: T1, msgId: 'cmsg_owner_old' } });
    expect(out.dump.inbox['n-abc'].processedAt).toBe(now);
  });

  it('classifyDoc and collect docs rows merge into one docs doc', () => {
    const docsRows = [{ id: 'art-1', isNew: false, data: { ...baseDump().docs['art-1'], title: 'Batch B Test Guide for the owner', updatedAt: ago(1 * HOUR) } }];
    const { out } = run([{ op: 'classifyDoc', id: 'art-1', ws: 'batch-b', kind: 'guide', status: 'current', evidence: [ev('art', 'art-1', 'Batch B Test Guide')] }], baseDump(), { docsRows });
    expect(out.dump.docs['art-1']).toMatchObject({ ws: 'batch-b', kind: 'guide', status: 'current', updatedAt: ago(1 * HOUR) });
    expect(changed(out).filter((x: string) => x.startsWith('docs/'))).toEqual(['docs/art-1']);
  });

  it('is deterministic: same inputs give the same output', () => {
    const ops = [{ op: 'closeTodo', id: 'batch-b-smtp', status: 'done', evidence: [E_OWNER] }];
    expect(run(ops).out).toEqual(run(ops).out);
  });
});

// ---------- planWrites ----------
describe('planWrites', () => {
  const fetched = { threads: [{ threadId: T1, lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR) }] };
  const ops = [
    { op: 'setHeadline', text: 'Batch B is live in production.', short: 'Batch B live', evidence: [E_MEM] },
    { op: 'closeTodo', id: 'batch-b-smtp', status: 'done', evidence: [E_OWNER] },
    { op: 'createTodo', ws: 'batch-b', title: 'Check the alert email', priority: 'soon', evidence: [E_OWNER] },
  ];
  const versions = { 'todo/batch-b-smtp': 4, 'todo/batch-b-acked': 2, 'meta/cursors': 7, 'meta/headline': 3 };
  const go = () => {
    const dump = baseDump();
    const facts = { ...factsFor(dump), fetched };
    const v = validatePatch({ ops }, sources, facts);
    expect(v.rejected).toEqual([]);
    return { facts, out: applyOps(dump, v.accepted, facts, now, RUN), accepted: v.accepted };
  };

  it('pins every overwrite with if_version and gives new ids no version', () => {
    const { out } = go();
    const writes = planWrites(out.changes, versions).flat();
    const byKey = Object.fromEntries(writes.map((w: Any) => [`${w.collection}/${w.doc_id}`, w]));
    expect(byKey['todo/batch-b-smtp']).toMatchObject({ op: 'set', if_version: 4 });
    expect(byKey['meta/cursors'].if_version).toBe(7);
    expect(byKey['todo/batch-b-check-the-alert-email'].op).toBe('set');
    expect('if_version' in byKey['todo/batch-b-check-the-alert-email']).toBe(false);
    for (const w of writes.filter((x: Any) => x.collection.startsWith('feed-'))) expect('if_version' in w).toBe(false);
  });

  it('refuses to overwrite an existing doc without a version', () => {
    const { out } = go();
    expect(() => planWrites(out.changes, { ...versions, 'todo/batch-b-smtp': undefined })).toThrow(/version/);
  });

  it('puts meta/cursors and meta/headline last, in the final batch', () => {
    const { out } = go();
    const batches = planWrites(out.changes, versions);
    const last = batches[batches.length - 1].map((w: Any) => `${w.collection}/${w.doc_id}`);
    expect(last).toEqual(['meta/cursors', 'meta/headline']);
    for (const b of batches.slice(0, -1)) for (const w of b) expect(w.collection === 'meta' && ['cursors', 'headline'].includes(w.doc_id)).toBe(false);
  });

  it('splits into batches of at most 50 writes and 900,000 bytes', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ collection: 'issues', id: `i-${i}`, isNew: true, data: { title: 'x', detail: 'y'.repeat(i === 7 ? 899_000 : 10) } }));
    const batches = planWrites(many, {});
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(50);
      expect(b.reduce((s: number, w: Any) => s + Buffer.byteLength(JSON.stringify(w)), 0)).toBeLessThanOrEqual(900_000);
    }
    expect(batches.flat()).toHaveLength(120);
  });

  it('a re-run on the result dump gives zero writes', () => {
    const { facts, out, accepted } = go();
    const again = applyOps(out.dump, accepted, { ...facts, dump: out.dump }, now, RUN);
    expect(again.changes).toEqual([]);
    expect(planWrites(again.changes, versions)).toEqual([]);
    // And re-validating the same patch on the result accepts nothing that changes anything.
    const v2 = validatePatch({ ops }, sources, { ...facts, dump: out.dump });
    expect(applyOps(out.dump, v2.accepted, { ...facts, dump: out.dump }, now, RUN).changes).toEqual([]);
  });
});

// ---------- review fixes (2026-10-08) ----------
describe('review fixes: authority and evidence', () => {
  const OWNER = 'user_01OWNER';
  const threadR = {
    thread_id: T1,
    messages: [
      { id: 'cmsg_req', thread_id: T1, created_at: ago(0.4 * HOUR), author: 'agent', body: 'Owner, please verify the payment link on your phone when you can.' },
      { id: 'cmsg_neg1', thread_id: T1, created_at: ago(0.4 * HOUR), author: 'agent', body: 'The smoke has not passed yet on main today.' },
      { id: 'cmsg_neg2', thread_id: T1, created_at: ago(0.4 * HOUR), author: 'agent', body: 'CI is not green on the branch yet, retrying.' },
      { id: 'cmsg_other_in_t1', thread_id: T1, created_at: ago(0.2 * HOUR), author: 'user', author_id: 'user_someone_else', body: 'Yes from me too, ship it on Friday.' },
      { id: 'cmsg_owner_yes', thread_id: T1, created_at: ago(0.1 * HOUR), author: 'user', author_id: OWNER, body: 'Yes, ship it on Friday as planned.' },
    ],
  };
  const threadT2 = {
    thread_id: T2,
    messages: [
      { id: 'cmsg_t2_ok', thread_id: T2, created_at: ago(0.3 * HOUR), author: 'agent', body: 'The smoke run passed on main for the other work.' },
      { id: 'cmsg_t2_human', thread_id: T2, created_at: ago(0.2 * HOUR), author: 'user', author_id: 'user_someone_else', body: 'No, hold everything until Monday please.' },
    ],
  };
  const feed = [
    { id: 'gh-smoke-77', data: { at: ago(1 * HOUR), kind: 'verify', actor: 'ci', title: 'Post-deploy smoke green on abc1234', detail: 'The smoke run passed.', result: 'ok', source: 'ci' } },
    { id: 'cur-b995e412f67fb0d8', data: { at: ago(1 * HOUR), kind: 'verify', actor: 'claude', title: 'Partner contract signed and verified by the owner', result: 'info', source: 'curator' } },
    { id: 'chg-0123456789abcdef', data: { at: ago(1 * HOUR), kind: 'change', actor: 'claude', title: 'To-do: Set the SMTP password: open -> done', result: 'info', source: 'curator' } },
    { id: 'j-abc', data: { at: ago(1 * HOUR), kind: 'verify', actor: 'owner', title: 'Owner checked the alert email on the phone', result: 'ok', source: 'journal' } },
  ];
  const rs = buildSources({ threads: [thread1, threadR, threadT2], prs: [{ n: 483, title: 'Batch B: order references, payment links' }], feed });
  const v = (op: Any, extra: Any = {}, dump: Any = baseDump()) => validatePatch({ ops: [op] }, rs, { ...factsFor(dump), ...extra });
  const rejectedWith = (op: Any, extra?: Any, dump?: Any) => {
    const r = v(op, extra, dump);
    expect(r.accepted).toEqual([]);
    return r.rejected[0]?.reason as string;
  };
  const acceptedOne = (op: Any, extra?: Any, dump?: Any) => {
    const r = v(op, extra, dump);
    expect(r.rejected).toEqual([]);
    return r.accepted[0];
  };

  it('feed evidence excludes the curator\'s own rows (cur-*, chg-*): the curator cannot quote itself', () => {
    expect(quoteGrounded(ev('feed', 'cur-b995e412f67fb0d8', 'Partner contract signed and verified'), rs)).toMatch(/fetched set/);
    expect(quoteGrounded(ev('feed', 'chg-0123456789abcdef', 'Set the SMTP password: open -> done'), rs)).toMatch(/fetched set/);
    expect(quoteGrounded(ev('feed', 'gh-smoke-77', 'Post-deploy smoke green on abc1234'), rs)).toBeNull();
    expect(quoteGrounded(ev('feed', 'j-abc', 'Owner checked the alert email'), rs)).toBeNull();
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('feed', 'cur-b995e412f67fb0d8', 'Partner contract signed and verified by the owner')] })).toMatch(/fetched set/);
  });

  it('a curator verify row cannot be quoted back next run to close a to-do (no laundering)', () => {
    // Run N: the curator invents a verify event grounded by an unrelated quote.
    const dump = baseDump();
    const facts = { ...factsFor(dump), fetched: { threads: [] } };
    const op = { op: 'addEvent', kind: 'verify', title: 'Partner contract signed and verified by the owner', at: ago(1 * HOUR), evidence: [ev('msg', 'cmsg_req', 'payment link on your phone')] };
    const vN = validatePatch({ ops: [op] }, rs, facts);
    expect(vN.rejected).toEqual([]);
    const outN = applyOps(dump, vN.accepted, facts, now, RUN);
    const row: Any = outN.changes.find((c: Any) => c.id.startsWith('cur-'));
    expect(row.data).toMatchObject({ source: 'curator', result: 'info' });
    // Run N+1: that row is in the dumped feed, but not in the fetched set.
    const next = buildSources({ threads: [thread1], feed: outN.changes.filter((c: Any) => c.collection.startsWith('feed-')).map((c: Any) => ({ id: c.id, data: c.data })) });
    const close = { op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('feed', row.id, 'Partner contract signed and verified by the owner')] };
    const r = validatePatch({ ops: [close] }, next, { ...factsFor(outN.dump) });
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/fetched set/);
  });

  it('keeps hand-written journal rows (even kind change) as evidence', () => {
    const s2 = buildSources({ feed: [{ id: 'j-legacy-1003', data: { kind: 'change', source: 'journal', title: 'New bot is live on the test number', result: 'ok' } }] });
    expect(quoteGrounded(ev('feed', 'j-legacy-1003', 'New bot is live on the test number'), s2)).toBeNull();
  });

  it('closeTodo: a request, a negation or a report from another thread is not verification', () => {
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('msg', 'cmsg_req', 'please verify the payment link')] })).toMatch(/owner message, a verification/);
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('msg', 'cmsg_neg1', 'The smoke has not passed yet')] })).toMatch(/owner message, a verification/);
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('msg', 'cmsg_neg2', 'CI is not green on the branch')] })).toMatch(/owner message, a verification/);
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('msg', 'cmsg_t2_ok', 'The smoke run passed on main')] })).toMatch(/owner message, a verification/);
    // A journal row is evidence, but not verification authority.
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('feed', 'j-abc', 'Owner checked the alert email')] })).toMatch(/owner message, a verification/);
  });

  it('closeTodo: a past-tense report in the to-do\'s thread, or an engine verify row, is verification', () => {
    expect(acceptedOne({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [E_AGENT_OK] }).id).toBe('batch-b-smtp');
    expect(acceptedOne({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('feed', 'gh-smoke-77', 'Post-deploy smoke green on abc1234')] }).id).toBe('batch-b-smtp');
  });

  it('closeTodo: with an ownerId set, another human is not the owner', () => {
    expect(rejectedWith({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [ev('msg', 'cmsg_other_in_t1', 'Yes from me too, ship it')] }, { ownerId: OWNER })).toMatch(/owner message/);
    expect(acceptedOne({ op: 'closeTodo', id: 'batch-b-smtp', evidence: [E_OWNER] }, { ownerId: OWNER }).id).toBe('batch-b-smtp');
  });

  it('decide: the owner message must be in the decision\'s thread, from the configured owner, and the answer must be an option or quoted', () => {
    // Another human, another thread.
    expect(rejectedWith({ op: 'decide', id: 'fresh-q', answer: 'Yes', evidence: [ev('msg', 'cmsg_t2_human', 'hold everything until Monday')] })).toMatch(/thread/);
    // Another human, the decision's thread, ownerId configured.
    expect(rejectedWith({ op: 'decide', id: 'fresh-q', answer: 'Yes', evidence: [ev('msg', 'cmsg_other_in_t1', 'Yes from me too, ship it')] }, { ownerId: OWNER })).toMatch(/owner message/);
    // An answer that is neither an option label nor in the quote.
    expect(rejectedWith({ op: 'decide', id: 'fresh-q', answer: 'Ship on Monday instead', evidence: [ev('msg', 'cmsg_owner_yes', 'Yes, ship it on Friday as planned')] }, { ownerId: OWNER })).toMatch(/answer/);
    const ok = acceptedOne({ op: 'decide', id: 'fresh-q', answer: 'Yes', evidence: [ev('msg', 'cmsg_owner_yes', 'Yes, ship it on Friday as planned')] }, { ownerId: OWNER });
    expect(ok.decidedAt).toBe(ago(0.1 * HOUR));
    expect(acceptedOne({ op: 'decide', id: 'fresh-q', answer: 'ship it on Friday', evidence: [ev('msg', 'cmsg_owner_yes', 'Yes, ship it on Friday as planned')] }, { ownerId: OWNER }).answer).toBe('ship it on Friday');
  });

  it('rejects phone and card numbers written in groups', () => {
    expect(rejectedWith({ op: 'upsertWs', key: 'batch-b', summary: 'Call the tester on +91 98765 43210', evidence: [E_PR483] })).toMatch(/scrub/);
    expect(rejectedWith({ op: 'upsertWs', key: 'batch-b', summary: 'Ring 703-555-0123 about it', evidence: [E_PR483] })).toMatch(/scrub/);
    expect(rejectedWith({ op: 'upsertWs', key: 'batch-b', summary: 'Test card 4111 1111 1111 1111 failed', evidence: [E_PR483] })).toMatch(/scrub/);
  });
});

describe('review fixes: acks confirmed in a later run', () => {
  const fetched = { threads: [{ threadId: T1, lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR) }] };
  it('the fold stores the ack id; a later run can still close the to-do on that ack', () => {
    const dump = baseDump();
    const facts1 = { ...factsFor(dump), fetched };
    const run1 = applyOps(dump, validatePatch({ ops: [] }, sources, facts1).accepted, facts1, now, RUN);
    expect(run1.dump.todo['batch-b-acked']).toMatchObject({ status: 'acked', ackId: 'batch-b-acked--1', statusChangedAt: now });
    // One hour later: statusChangedAt (the fold time) is newer than the ack itself.
    const later = new Date(NOW + HOUR).toISOString();
    const facts2 = { ...factsFor(run1.dump), now: later, fetched };
    const v2 = validatePatch({ ops: [{ op: 'closeTodo', id: 'batch-b-acked', status: 'done' }] }, sources, facts2);
    expect(v2.rejected).toEqual([]);
    expect(v2.accepted[0].ackId).toBe('batch-b-acked--1');
    const run2 = applyOps(run1.dump, v2.accepted, facts2, later, 'run-test-2');
    expect(run2.dump.todo['batch-b-acked']).toMatchObject({ status: 'done', doneAt: later });
    expect(run2.dump.todo['batch-b-acked'].doneEvidence).toEqual([{ kind: 'ack', ref: 'batch-b-acked--1', quote: '' }]);
  });

  it('a reopen clears the ack id, so the old ack no longer authorises a close', () => {
    const dump = baseDump();
    dump.todo['batch-b-acked'] = { ...dump.todo['batch-b-acked'], status: 'acked', ackId: 'batch-b-acked--1', statusChangedAt: ago(1 * HOUR) };
    const facts = { ...factsFor(dump), fetched };
    const v = validatePatch({ ops: [{ op: 'updateTodo', id: 'batch-b-acked', status: 'open', reopenReason: 'The token still works.', evidence: [E_OWNER] }, { op: 'closeTodo', id: 'batch-b-acked', status: 'done' }] }, sources, facts);
    expect(v.accepted.map((o: Any) => o.op)).toEqual(['updateTodo']);
    expect(v.rejected[0].reason).toMatch(/owner message, a verification message or an ack/);
    const out = applyOps(dump, v.accepted, facts, now, RUN);
    expect(out.dump.todo['batch-b-acked']).toMatchObject({ status: 'open', ackId: null });
  });
});

describe('review fixes: the curator can attach a PR to a workstream', () => {
  const fetched = { threads: [{ threadId: T1, lastMsgId: 'cmsg_owner_new', lastAt: ago(1 * HOUR) }] };
  it('upsertWs.prs is stored as ws.prsCurated (sorted, kept across runs); collect facts do not overwrite it', () => {
    const dump = baseDump();
    const wsFacts = { 'batch-b': { ...dump.ws['batch-b'].facts, prs: [] } };
    const facts = { ...factsFor(dump), fetched, wsFacts };
    const v = validatePatch({ ops: [{ op: 'upsertWs', key: 'batch-b', prs: [483], evidence: [E_PR483] }] }, sources, facts);
    expect(v.rejected).toEqual([]);
    const out = applyOps(dump, v.accepted, facts, now, RUN);
    expect(out.dump.ws['batch-b'].prsCurated).toEqual([483]);
    expect(out.dump.ws['batch-b'].facts.prs).toEqual([]);
    const v2 = validatePatch({ ops: [{ op: 'upsertWs', key: 'batch-b', prs: [484], evidence: [E_PR484] }] }, sources, { ...facts, dump: out.dump });
    const out2 = applyOps(out.dump, v2.accepted, { ...facts, dump: out.dump }, now, RUN);
    expect(out2.dump.ws['batch-b'].prsCurated).toEqual([483, 484]);
  });

  it('rejects a PR that GitHub does not know', () => {
    expect(reasonOf({ op: 'upsertWs', key: 'batch-b', prs: [999], evidence: [E_PR483] })).toMatch(/#999/);
  });
});

describe('the curator agent is checked in', () => {
  it('.claude/agents/ledger-curator.md exists and is not git-ignored', async () => {
    const { execFileSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..');
    expect(existsSync(join(root, '.claude/agents/ledger-curator.md'))).toBe(true);
    let ignored = true;
    try {
      execFileSync('git', ['check-ignore', '-q', '.claude/agents/ledger-curator.md'], { cwd: root, stdio: 'ignore' });
    } catch (e: Any) {
      ignored = e.status !== 1; // exit 1 = not ignored
    }
    expect(ignored).toBe(false);
  });
});
