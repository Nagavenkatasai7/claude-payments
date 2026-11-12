import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { certifiedQueuePartner, eventRail, heldRowFor } from './helpers-hold';
import {
  createOutboxRepo,
  PARTNER_EVENT_BACKOFF_CAP_SEC,
  PARTNER_EVENT_MAX_ATTEMPTS,
  INSTRUCT_BACKOFF_CAP_SEC,
  INSTRUCT_MAX_ATTEMPTS,
  MAX_ATTEMPTS,
  BACKOFF_CAP_SEC,
  retryBackoffSec,
  retryPolicy,
} from '@/db/repos/outbox-repo';
import { createHoldReviewRepo } from '@/db/repos/hold-review-repo';
import { railMessages } from '@/db/schema';
import { railBodySha256 } from '@/db/repos/rail-message-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { enqueuePartnerEvent, PartnerEventDeliveryError } from '@/lib/partner-events';
import { railRecordAlertKey } from '@/lib/instruct-errors';
import { invalidateFlagCache } from '@/lib/flags';
import { ctx } from '@/lib/crypto-context';
import { decryptField, defaultProvider } from '@/lib/field-crypto';
import { verifyRailSignature } from '@/lib/providers/rail-signature';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 7 T21 (P17, P18, P20, P29): the 'partner.event' outbox kind. The worker
// builds the signed, ids-only body at drain, records it sealed in rail_messages
// (kind 'event') BEFORE the POST, and POSTs it to the OWNER's events URL (else its
// settlement URL). Ineligible rows complete without a send; an unusable http rail
// completes with ONE alert per partner per day; a non-2xx or network failure is a
// charged retry (24 attempts, 30-minute cap) with one coalesced alert per partner
// per hour from attempt 3. An unknown event type waits uncharged (O7).

const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: Parameters<typeof real.logWarn>) => { logWarnSpy(...a); return real.logWarn(...a); } };
});

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();
let recordDown = false;
let rowsAtFetch: number[] = [];

/** The real db, except that an insert into rail_messages throws while `recordDown`. */
function recordingDb(target: object = db): Db {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table === railMessages && recordDown) throw Object.assign(new Error('x'), { name: 'NeonDbError' });
          return (t as Db).insert(table as never);
        };
      }
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
          (t as unknown as { transaction: (f: (tx: object) => unknown, ...r: unknown[]) => unknown }).transaction((tx) => fn(recordingDb(tx)), ...rest);
      }
      const v = Reflect.get(t, prop, receiver);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Db;
}

function deps(): WorkerDeps {
  return {
    db: recordingDb(),
    store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

type RecRow = {
  id: string; partner_id: string | null; rail_partner_id: string | null; transfer_id: string | null;
  direction: number; kind: string; body_enc: string; body_sha256: string; signature_header: string | null;
};
async function records(): Promise<RecRow[]> {
  return ((await db.execute(sql`SELECT * FROM rail_messages ORDER BY created_at, id`)) as unknown as { rows: RecRow[] }).rows;
}
async function countRecords(): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM rail_messages`)) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0].n);
}
type RowState = { id: number; status: string; attempts: number; last_error: string | null; created_at: string };
async function eventRows(): Promise<RowState[]> {
  const r = (await db.execute(sql`SELECT id, status, attempts, last_error, created_at FROM outbox WHERE kind = 'partner.event' ORDER BY id`)) as unknown as { rows: RowState[] };
  return r.rows;
}
async function alerts(): Promise<Array<{ k: string; message: string }>> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k, payload->>'message' AS message FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string; message: string }>;
  };
  return r.rows;
}
const open = (r: RecRow) => decryptField(r.body_enc, defaultProvider(), ctx.railMessage(r.id, 1, 'event'));
const hour = () => Math.floor(Date.now() / 3_600_000);
const day = () => new Date().toISOString().slice(0, 10);
/** Make every partner.event row due again (the DB clock decides the claim). */
const due = () => db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '1 minute' WHERE kind = 'partner.event'`);
const posted = () => fetchFn.mock.calls as Array<[string, RequestInit & { headers: Record<string, string> }]>;
const postedBody = (i = 0) => JSON.parse(String(posted()[i][1].body)) as Record<string, unknown> & { data: Record<string, unknown> };

/** Every key in a JSON value, at any depth. */
function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** The body id (randomUUID) and the clock values are checked by FORMAT only (O10). */
const TIME_KEYS = new Set(['screened_at', 'decided_at']);
/** Every key and every other string or number of a POSTed body misses every leak value. */
function scanBodyValues(v: unknown, leaks: string[], path: string): void {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      for (const l of leaks) expect(k, path).not.toContain(l);
      if (path === 'body' && k === 'id') {
        expect(x, `${path}.${k}`).toMatch(UUID_RE);
        continue;
      }
      if (path === 'body' && k === 'created') {
        expect(Number.isSafeInteger(x), `${path}.${k}`).toBe(true);
        continue;
      }
      if (TIME_KEYS.has(k)) {
        expect(x, `${path}.${k}`).toMatch(ISO_RE);
        continue;
      }
      scanBodyValues(x, leaks, `${path}.${k}`);
    }
  } else if (typeof v === 'string' || typeof v === 'number') {
    for (const l of leaks) expect(String(v), path).not.toContain(l);
  }
}

async function heldMatch(partnerId = 'acme', id?: string): Promise<Transfer> {
  return heldRowFor(db, partnerId, 'sanctions_review', id ? { id } : {});
}
const queueMatch = (transferId: string) => enqueuePartnerEvent(db, { type: 'screening.potential_match', transferId });

beforeEach(async () => {
  recordDown = false;
  rowsAtFetch = [];
  logWarnSpy.mockClear();
  db = await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await certifiedQueuePartner(db);
  await eventRail(db, 'acme', { eventsUrl: 'https://events.acme.example/hook' });
  fetchFn.mockReset();
  fetchFn.mockImplementation(async () => {
    rowsAtFetch.push(await countRecords());
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  invalidateFlagCache(db);
});

describe('retryPolicy: partner.event (P17)', { retry: 0 }, () => {
  it('retryPolicy(partner.event) is { maxAttempts: 24, backoffCapSec: 1800 }; other kinds unchanged', () => {
    expect(retryPolicy('partner.event')).toEqual({ maxAttempts: 24, backoffCapSec: 1800 });
    expect(PARTNER_EVENT_MAX_ATTEMPTS).toBe(24);
    expect(PARTNER_EVENT_BACKOFF_CAP_SEC).toBe(1800);
    expect(retryPolicy('settlement.instruct')).toEqual({ maxAttempts: INSTRUCT_MAX_ATTEMPTS, backoffCapSec: INSTRUCT_BACKOFF_CAP_SEC });
    for (const kind of ['rail.callback', 'funding.refund', '']) {
      expect(retryPolicy(kind)).toEqual({ maxAttempts: MAX_ATTEMPTS, backoffCapSec: BACKOFF_CAP_SEC });
    }
  });

  it('the 23 waits of partner.event sum to between 6.5 h and 7.5 h', () => {
    let sum = 0;
    for (let n = 1; n <= 23; n++) sum += retryBackoffSec('partner.event', n);
    expect(sum).toBeGreaterThan(6.5 * 3600);
    expect(sum).toBeLessThan(7.5 * 3600);
  });
});

describe('partner.event worker case (P18)', { retry: 0 }, () => {
  it('potential match: ONE signed POST to eventsUrl with the ids-only body; the row is done', async () => {
    const t = await heldMatch();
    await db.execute(sql`UPDATE transfers SET client_reference = 'ord-77' WHERE id = ${t.id}`);
    expect(await queueMatch(t.id)).toBe(true);
    const payload = ((await db.execute(sql`SELECT payload FROM outbox WHERE kind = 'partner.event'`)) as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0].payload;
    expect(Object.keys(payload).sort()).toEqual(['eventId', 'transferId', 'type']);
    const res = await drainOnce(deps(), 'w1');
    expect(res.processed).toBeGreaterThanOrEqual(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = posted()[0];
    expect(url).toBe('https://events.acme.example/hook');
    expect(init.method).toBe('POST');
    const body = postedBody();
    expect(Object.keys(body).sort()).toEqual(['created', 'data', 'id', 'partner_id', 'type']);
    expect(body.type).toBe('screening.potential_match');
    expect(body.id).toBe(payload.eventId);
    expect(body.partner_id).toBe('acme');
    const [row] = await eventRows();
    expect(body.created).toBe(Math.floor(new Date(row.created_at).getTime() / 1000));
    expect(body.data).toMatchObject({
      transfer_id: t.id,
      client_reference: 'ord-77',
      list_source: 'ofac-sdn',
      list_version: 'test-version',
      decision: 'possible_match',
    });
    expect(typeof body.data.screened_at).toBe('string');
    expect(body.data.parties).toEqual([{ role: 'recipient', matched: false, score: 0, matched_entry_id: null }]);
    const v = verifyRailSignature(String(init.body), new Headers(init.headers), ['evt-secret'], Date.now(), { route: 'test' });
    expect(v.ok).toBe(true);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(row.status).toBe('done');
  });

  it('no eventsUrl: the POST goes to the settlement URL', async () => {
    await eventRail(db, 'acme', { eventsUrl: null });
    const t = await heldMatch();
    await queueMatch(t.id);
    await drainOnce(deps(), 'w1');
    expect(posted()[0][0]).toBe('https://rail.acme.example/settle');
  });

  it('the record is written BEFORE the POST with the exact bytes and hash', async () => {
    const t = await heldMatch();
    await queueMatch(t.id);
    await drainOnce(deps(), 'w1');
    expect(rowsAtFetch).toEqual([1]);
    const [r] = await records();
    expect(r).toMatchObject({ partner_id: 'acme', rail_partner_id: 'acme', transfer_id: t.id, kind: 'event' });
    expect(Number(r.direction)).toBe(1);
    const [, init] = posted()[0];
    expect(open(r)).toBe(init.body);
    expect(r.body_sha256).toBe(railBodySha256(String(init.body)));
    expect(r.signature_header).toBe(init.headers['x-smartremit-signature']);
  });

  it('the record fails: no POST; row failed (attempts 1); one railrecord:<hour> alert; no partnerevent alert', async () => {
    recordDown = true;
    const t = await heldMatch();
    await queueMatch(t.id);
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    const [row] = await eventRows();
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    const a = await alerts();
    expect(a.filter((x) => x.k === railRecordAlertKey())).toHaveLength(1);
    expect(a.some((x) => x.k.startsWith('partnerevent'))).toBe(false);
    expect(logWarnSpy).toHaveBeenCalledWith('outbox.rail-record', 'NeonDbError', { transferId: t.id, kind: 'event' });
  });

  it('rail answers 500: charged retry; from attempt 3 ONE partnerevent:<partner>:<hour> alert; a second failure adds none', async () => {
    fetchFn.mockImplementation(async () => new Response('nope', { status: 500 }));
    const t = await heldMatch();
    await queueMatch(t.id);
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    let [row] = await eventRows();
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.last_error).toContain('500');
    expect(row.last_error).not.toContain('events.acme.example');
    expect(row.last_error).not.toContain('https://');
    expect((await alerts()).some((x) => x.k.startsWith('partnerevent:'))).toBe(false);
    await db.execute(sql`UPDATE outbox SET attempts = 2 WHERE kind = 'partner.event'`);
    await due();
    await drainOnce(deps(), 'w1');
    [row] = await eventRows();
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    let pe = (await alerts()).filter((x) => x.k === `partnerevent:acme:${hour()}`);
    expect(pe).toHaveLength(1);
    expect(pe[0].message).toContain('attempt 3 of 24');
    expect(pe[0].message).toContain('last answer 500');
    expect(pe[0].message).toContain('about 7 hours');
    expect(pe[0].message).not.toContain('events.acme.example');
    await due();
    await drainOnce(deps(), 'w1');
    pe = (await alerts()).filter((x) => x.k.startsWith('partnerevent:'));
    expect(pe).toHaveLength(1);
    expect((await eventRows())[0].attempts).toBe(4);
    expect((await alerts()).some((x) => x.k.startsWith('railfail:'))).toBe(false);
  });

  it('a network error: the alert says last answer network', async () => {
    fetchFn.mockImplementation(async () => {
      throw new TypeError('fetch failed https://events.acme.example/hook');
    });
    const t = await heldMatch();
    await queueMatch(t.id);
    await db.execute(sql`UPDATE outbox SET attempts = 2 WHERE kind = 'partner.event'`);
    await drainOnce(deps(), 'w1');
    const [row] = await eventRows();
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    expect(row.last_error).toBe('partner_event_rejected:network');
    const pe = (await alerts()).filter((x) => x.k === `partnerevent:acme:${hour()}`);
    expect(pe).toHaveLength(1);
    expect(pe[0].message).toContain('last answer network');
  });

  it('PartnerEventDeliveryError carries the partner and the answer, never a URL', () => {
    const e = new PartnerEventDeliveryError('acme', 502);
    expect(e).toMatchObject({ name: 'PartnerEventDeliveryError', partnerId: 'acme', answer: 502, message: 'partner_event_rejected:502' });
  });

  it('at attempt 24 the row is dead: the normal dead:<id> alert, no partnerevent alert', async () => {
    fetchFn.mockImplementation(async () => new Response('nope', { status: 503 }));
    const t = await heldMatch();
    await queueMatch(t.id);
    await db.execute(sql`UPDATE outbox SET attempts = 23 WHERE kind = 'partner.event'`);
    expect((await drainOnce(deps(), 'w1')).dead).toBe(1);
    const [row] = await eventRows();
    expect(row).toMatchObject({ status: 'dead', attempts: 24 });
    const a = await alerts();
    expect(a.map((x) => x.k)).toEqual([`dead:${row.id}`]);
  });

  it('poison reclaim uses this policy (M10): attempts 9..24 are RUN; past 24 dead-lettered without running', async () => {
    const t = await heldMatch();
    await queueMatch(t.id);
    // A reclaimed row (claimed and killed): status processing with an expired lease.
    await db.execute(sql`UPDATE outbox SET attempts = 9, status = 'processing', locked_at = now() - interval '1 hour', lease_until = now() - interval '1 minute' WHERE kind = 'partner.event'`);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await eventRows())[0]).toMatchObject({ status: 'done', attempts: 10 });

    const t2 = await heldMatch('acme', 'held_poison_2');
    await queueMatch(t2.id);
    await db.execute(sql`UPDATE outbox SET attempts = 24, status = 'processing', locked_at = now() - interval '1 hour', lease_until = now() - interval '1 minute' WHERE kind = 'partner.event' AND status <> 'done'`);
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await eventRows())[1]).toMatchObject({ status: 'dead', attempts: 25 });
  });

  it.each(['mock', 'simulator', 'sandbox'] as const)('%s: done, no POST, no record, no alert', async (which) => {
    const t = await heldMatch();
    await queueMatch(t.id);
    if (which === 'sandbox') await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${t.id}`);
    else await eventRail(db, 'acme', { providerType: which, eventsUrl: 'https://events.acme.example/hook' });
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await countRecords()).toBe(0);
    expect((await eventRows()).map((r) => r.status)).toEqual(['done']);
    expect(await alerts()).toEqual([]);
  });

  it('http rail with no URL, no signing secret or a refused URL: done, no POST, ONE partnerevent-unsent alert per partner per day', async () => {
    const key = `partnerevent-unsent:acme:${day()}`;
    const cases: Array<Parameters<typeof eventRail>[2]> = [
      { eventsUrl: null, settlementUrl: null },
      { signingSecret: null },
      { eventsUrl: 'http://events.acme.example/hook' },
      { eventsUrl: 'https://smartremit.ai/hook' },
    ];
    let i = 0;
    for (const c of cases) {
      await eventRail(db, 'acme', c);
      const t = await heldMatch('acme', `held_unsent_${i++}`);
      await queueMatch(t.id);
      await drainOnce(deps(), 'w1');
      const a = (await alerts()).filter((x) => x.k === key);
      expect(a).toHaveLength(1);
      expect(a[0].message).toBe(
        '⚠️ SmartRemit ops: compliance events for partner acme are not being sent: its rail has no usable events or settlement URL, or no signing secret. Fix it on the partner\'s webhooks page; events are not retried.',
      );
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await countRecords()).toBe(0);
    expect((await eventRows()).every((r) => r.status === 'done')).toBe(true);
    expect((await alerts()).filter((x) => x.k.startsWith('partnerevent'))).toHaveLength(1);
  });

  it('uncertified owner at drain: done, no POST, no alert', async () => {
    const t = await heldMatch();
    await queueMatch(t.id);
    await db.execute(sql`UPDATE partners SET live_controls = live_controls - 'certification' WHERE id = 'acme'`);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await eventRows())[0].status).toBe('done');
    expect(await alerts()).toEqual([]);
  });

  it('a routed row: the owner\'s integrations and URL are used; the rail partner is never called', async () => {
    await certifiedQueuePartner(db, { partnerId: 'railp' });
    await eventRail(db, 'railp', { eventsUrl: 'https://events.railp.example/hook' });
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { routed: 'railp' });
    await queueMatch(t.id);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(posted()[0][0]).toBe('https://events.acme.example/hook');
    expect(postedBody().partner_id).toBe('acme');
    const v = verifyRailSignature(String(posted()[0][1].body), new Headers(posted()[0][1].headers), ['evt-secret'], Date.now(), { route: 'test' });
    expect(v.ok).toBe(true);
    const [r] = await records();
    expect(r).toMatchObject({ partner_id: 'acme', rail_partner_id: 'acme' });
  });

  it('the integrations read throws: charged retry, no POST', async () => {
    const t = await heldMatch();
    await queueMatch(t.id);
    await db.execute(sql`UPDATE partner_integrations SET payment_credentials_enc = 'not-a-ciphertext' WHERE partner_id = 'acme'`);
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await eventRows())[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('hold.disposition: the body carries the review facts and never the reason text', async () => {
    const t = await heldMatch();
    const ins = await createHoldReviewRepo(db).insert({
      transferId: t.id, partnerId: 'acme', holdClass: 'sanctions_review', reasonsFp: 'fp1', step: 1, final: true,
      disposition: 'false_positive_match', reason: 'Documents checked for this customer', evidence: {},
      actor: 'co-a', actorScope: 'partner',
    });
    const review = (await createHoldReviewRepo(db).getById('acme', ins!.id))!;
    expect(await enqueuePartnerEvent(db, { type: 'hold.disposition', transferId: t.id, reviewId: ins!.id })).toBe(true);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = postedBody();
    expect(body.type).toBe('hold.disposition');
    expect(body.data).toEqual({
      transfer_id: t.id,
      client_reference: null,
      hold_class: 'sanctions_review',
      step: 1,
      final: true,
      disposition: 'false_positive_match',
      actor_scope: 'partner',
      decided_at: review.createdAt,
    });
    expect(String(posted()[0][1].body)).not.toContain('Documents checked');
    expect(open((await records())[0])).not.toContain('Documents checked');
  });

  it('missing transfer, missing review row or no possible_match evidence: done, no POST, one logWarn with ids only', async () => {
    await enqueuePartnerEvent(db, { type: 'screening.potential_match', transferId: 'tr_missing' });
    const t = await heldMatch();
    await enqueuePartnerEvent(db, { type: 'hold.disposition', transferId: t.id, reviewId: '00000000-0000-4000-8000-000000000000' });
    const clean = await heldRowFor(db, 'acme', 'aml', { id: 'held_aml_1' });
    await queueMatch(clean.id);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await eventRows()).map((r) => r.status)).toEqual(['done', 'done', 'done']);
    const warns = logWarnSpy.mock.calls.filter((c) => c[0] === 'outbox.partner-event');
    expect(warns).toEqual([
      ['outbox.partner-event', 'subject missing', { transferId: 'tr_missing', type: 'screening.potential_match' }],
      ['outbox.partner-event', 'subject missing', { transferId: t.id, type: 'hold.disposition' }],
      ['outbox.partner-event', 'subject missing', { transferId: clean.id, type: 'screening.potential_match' }],
    ]);
    expect(await alerts()).toEqual([]);
  });

  /** Queues one match and one disposition event, drains, and scans both POSTed bodies. */
  async function deepScanPosted(): Promise<void> {
    const t = await heldMatch();
    await db.execute(sql`UPDATE transfers SET client_reference = 'ord-9' WHERE id = ${t.id}`);
    await queueMatch(t.id);
    const ins = await createHoldReviewRepo(db).insert({
      transferId: t.id, partnerId: 'acme', holdClass: 'sanctions_review', reasonsFp: 'fp1', step: 1, final: true,
      disposition: 'confirmed_match', reason: 'Reason text', evidence: {}, actor: 'co-a', actorScope: 'partner',
    });
    await enqueuePartnerEvent(db, { type: 'hold.disposition', transferId: t.id, reviewId: ins!.id });
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [, init] of posted()) {
      const keys = deepKeys(JSON.parse(String(init.body)));
      for (const banned of ['name', 'phone', 'amount', 'reference', 'payout', 'inputHash', 'listHash', 'listBaseHash', 'reason']) {
        expect(keys).not.toContain(banned);
      }
      scanBodyValues(JSON.parse(String(init.body)), ['Test Recipient', '15551239876', '919800000999', '123456789012', 'Reason text'], 'body');
    }
  }

  it('deep scan of every POSTed body: no name, phone, amount, reference, payout, hash or reason key', async () => {
    await deepScanPosted();
  });

  it('a random event id that happens to contain a leak digit run still passes the deep scan (F5)', async () => {
    let n = 0;
    // Every id the code draws here ends in '123456789012'; each is still unique.
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockImplementation(() => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-123456789012` as `${string}-${string}-${string}-${string}-${string}`);
    try {
      await deepScanPosted();
      expect(posted().map(([, init]) => (JSON.parse(String(init.body)) as { id: string }).id).every((id) => id.endsWith('123456789012'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });


  it('unknown event type (O7): no POST, no record, released uncharged; one unknownkind alert per day', async () => {
    await outbox.enqueue('partner.event', { type: 'complaint.opened', transferId: 'tr_x', eventId: 'e1' }, { dedupeKey: 'complaint.opened:tr_x' });
    await db.execute(sql`UPDATE outbox SET attempts = 5 WHERE kind = 'partner.event'`);
    const r = await drainOnce(deps(), 'w1');
    expect(r.released).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await countRecords()).toBe(0);
    expect((await eventRows())[0]).toMatchObject({ status: 'pending', attempts: 5 });
    const key = `unknownkind:partner.event.complaint.opened:${day()}`;
    expect((await alerts()).filter((x) => x.k === key)).toHaveLength(1);
    await due();
    await drainOnce(deps(), 'w1');
    expect((await alerts()).filter((x) => x.k.startsWith('unknownkind:'))).toHaveLength(1);
    expect((await eventRows())[0]).toMatchObject({ status: 'pending', attempts: 5 });
  });
});
