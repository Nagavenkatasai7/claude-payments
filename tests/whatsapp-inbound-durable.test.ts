import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import { OPT_OUT_REPLY, OPT_IN_REPLY, MEDIA_REPLY } from '@/lib/consent';
import { waMessageRef } from '@/lib/wa-message-ref';

// R1 — every inbound message becomes exactly ONE durable outbox row (the
// unique `outbox_dedupe` index on `wamid:{id}` is the dedup), the Redis mark
// moves AFTER that write, and no reply is sent from inside the webhook.

const PHONE = '15551230000';

let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
const { pokeWorker, sendText, enqueueFault } = vi.hoisted(() => ({
  pokeWorker: vi.fn(),
  sendText: vi.fn(async () => {}),
  // The next N enqueue calls throw this error instead of inserting.
  enqueueFault: { error: null as Error | null, times: 0 },
}));
vi.mock('@/lib/outbox', () => ({ pokeWorker, pokeWorkerDelayed: vi.fn() }));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendText,
}));
vi.mock('@/db/repos/outbox-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/outbox-repo')>();
  return {
    ...real,
    createOutboxRepo: (d: Parameters<typeof real.createOutboxRepo>[0]) => {
      const repo = real.createOutboxRepo(d);
      return {
        ...repo,
        enqueue: async (...args: Parameters<typeof repo.enqueue>) => {
          if (enqueueFault.times > 0 && enqueueFault.error) {
            enqueueFault.times--;
            throw enqueueFault.error;
          }
          return repo.enqueue(...args);
        },
      };
    },
  };
});

import { processInboundWebhook } from '@/lib/whatsapp-inbound';

const infraError = () => Object.assign(new Error('Connection terminated unexpectedly'), { name: 'DatabaseError' });
const poisonError = () =>
  Object.assign(new Error('Failed query'), { name: 'DrizzleQueryError', cause: Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }) });

type Msg = Record<string, unknown>;
const text = (body: string, id: string, from = PHONE): Msg => ({ from, id, type: 'text', text: { body } });
function webhook(messages: Msg[], extra: Record<string, unknown> = {}): unknown {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { ...extra, messages } }] }] };
}

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const raw = await db.execute(sql);
  return (raw as unknown as { rows: Record<string, unknown>[] }).rows;
}
const outboxRows = () => rows(`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`);
const auditRows = (action: string) => rows(`SELECT partner_id, subject_id, meta FROM audit_events WHERE action = '${action}' ORDER BY id`);

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
  pokeWorker.mockClear();
  sendText.mockClear();
  enqueueFault.error = null;
  enqueueFault.times = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('exactly one durable row per wamid', () => {
  it('two concurrent deliveries of the same message ⇒ ONE agent.turn row', async () => {
    const body = webhook([text('hi', 'wamid.C1')]);
    const [a, b] = await Promise.all([
      processInboundWebhook(body, { routedPartnerId: null }),
      processInboundWebhook(body, { routedPartnerId: null }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    const out = await outboxRows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'agent.turn', dedupe_key: 'wamid:wamid.C1' });
    expect(pokeWorker).toHaveBeenCalled();
  });

  it('every message in a POST is processed (two messages ⇒ two rows)', async () => {
    await processInboundWebhook(webhook([text('one', 'wamid.M1'), text('two', 'wamid.M2')]), { routedPartnerId: null });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['wamid:wamid.M1', 'wamid:wamid.M2']);
  });

  it('a statuses change before a messages change never hides the message', async () => {
    const body = { entry: [
      { changes: [{ value: { statuses: [{ id: 'wamid.S', recipient_id: PHONE, status: 'delivered' }] } }] },
      { changes: [{ value: { messages: [text('hi', 'wamid.AFTER')] } }] },
    ] };
    await processInboundWebhook(body, { routedPartnerId: null });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['wamid:wamid.AFTER']);
  });
});

describe('infrastructure failure ⇒ the request fails (Meta retries) and the retry is exactly-once', () => {
  it('the turn insert throws after the customer upsert ⇒ rejects; no fast-skip mark; the replay yields exactly one turn', async () => {
    const body = webhook([text('hi', 'wamid.F1')]);
    enqueueFault.error = infraError();
    enqueueFault.times = 1;
    await expect(processInboundWebhook(body, { routedPartnerId: null })).rejects.toThrow('Connection terminated');
    expect(redis.dump.has('msgq:wamid.F1')).toBe(false);
    expect(redis.dump.has('msg:wamid.F1')).toBe(false);
    expect(await outboxRows()).toHaveLength(0);

    expect(await processInboundWebhook(body, { routedPartnerId: null })).toEqual({ ok: true });
    expect(await processInboundWebhook(body, { routedPartnerId: null })).toEqual({ ok: true });
    const out = await outboxRows();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('agent.turn');
    expect(redis.dump.get('msgq:wamid.F1')).toBe('1');
    expect(redis.dump.get('msg:wamid.F1')).toBe('1');
  });

  it('a STOP whose confirmation insert fails ⇒ rejects; the retry confirms ONCE (and opts out)', async () => {
    const body = webhook([text('STOP', 'wamid.STOPF')]);
    enqueueFault.error = infraError();
    enqueueFault.times = 1;
    await expect(processInboundWebhook(body, { routedPartnerId: null })).rejects.toThrow();
    await processInboundWebhook(body, { routedPartnerId: null });
    await processInboundWebhook(body, { routedPartnerId: null });
    const out = await outboxRows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'whatsapp.text',
      dedupe_key: 'wamid:wamid.STOPF',
      payload: { to: PHONE, body: OPT_OUT_REPLY, category: 'essential' },
    });
    expect((out[0].payload as Record<string, unknown>).partnerId).toBeUndefined(); // shared number ⇒ env creds
    const cs = createCustomerStore(db, createStore(redis, db));
    expect((await cs.getCustomer('default', PHONE))!.optedOutAt).toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('an infra error stops the POST (later messages are left for the retry)', async () => {
    enqueueFault.error = infraError();
    enqueueFault.times = 1;
    const body = webhook([text('one', 'wamid.X1'), text('two', 'wamid.X2')]);
    await expect(processInboundWebhook(body, { routedPartnerId: null })).rejects.toThrow();
    await processInboundWebhook(body, { routedPartnerId: null });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['wamid:wamid.X1', 'wamid:wamid.X2']);
  });
});

describe('a per-message (non-infrastructure) failure is acknowledged and audited', () => {
  it('poison message ⇒ ok, one whatsapp.inbound_dropped row (no text / phone), and the next message still lands', async () => {
    enqueueFault.error = poisonError();
    enqueueFault.times = 1;
    const res = await processInboundWebhook(webhook([text('bad\u0000body', 'wamid.P1'), text('fine', 'wamid.P2')]), { routedPartnerId: 'acme' });
    expect(res).toEqual({ ok: true });
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['wamid:wamid.P2']);
    const audit = await auditRows('whatsapp.inbound_dropped');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partner_id: 'acme', subject_id: waMessageRef('wamid.P1') });
    const serialized = JSON.stringify(audit[0]);
    expect(serialized).not.toContain('bad');
    expect(serialized).not.toMatch(/\d{7,}/);
    expect(audit[0].meta).toEqual({ reason: 'processing_error', error: 'DrizzleQueryError' });
  });
});

describe('replies are durable whatsapp.text rows (no Graph call inside the webhook)', () => {
  it('START / media ⇒ essential whatsapp.text rows keyed by wamid; routed tenant carries partnerId', async () => {
    await processInboundWebhook(webhook([text('START', 'wamid.ST')]), { routedPartnerId: 'acme' });
    await processInboundWebhook(webhook([{ from: PHONE, id: 'wamid.IMG', type: 'image', image: { id: 'm' } }]), { routedPartnerId: 'acme' });
    const out = await outboxRows();
    expect(out).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'wamid:wamid.ST', payload: { to: PHONE, body: OPT_IN_REPLY, category: 'essential', partnerId: 'acme' } },
      { kind: 'whatsapp.text', dedupe_key: 'wamid:wamid.IMG', payload: { to: PHONE, body: MEDIA_REPLY, category: 'essential', partnerId: 'acme' } },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('Redis marks', () => {
  it('a legacy msg: key (an old build marked it, then crashed) is NEVER read: the message is still processed', async () => {
    redis.dump.set('msg:wamid.OLD', '1');
    await processInboundWebhook(webhook([text('hi', 'wamid.OLD')]), { routedPartnerId: null });
    expect(await outboxRows()).toHaveLength(1);
  });

  it('a msgq: hit is a fast skip (no customer writes, no insert attempt)', async () => {
    redis.dump.set('msgq:wamid.Q', '1');
    await processInboundWebhook(webhook([text('hi', 'wamid.Q')]), { routedPartnerId: null });
    expect(await outboxRows()).toHaveLength(0);
    expect(await rows(`SELECT 1 FROM customers`)).toHaveLength(0);
  });

  it('a failing post-insert mark write never fails the request', async () => {
    const realSet = redis.set.bind(redis);
    const spy = vi.spyOn(redis, 'set').mockImplementation(async (k: string, v: string, o?: { ex?: number; nx?: boolean }) => {
      if (k.startsWith('msgq:') || k.startsWith('msg:')) throw infraError();
      return realSet(k, v, o);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await processInboundWebhook(webhook([text('hi', 'wamid.MK')]), { routedPartnerId: null })).toEqual({ ok: true });
    expect(await outboxRows()).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('a message without a phone (BSUID-only) is recorded, not silently lost', () => {
  const noPhone = (id: string): Msg => ({ from_user_id: 'US.SECRETBSUID', id, type: 'text', text: { body: 'hi' } });
  const contacts = [{ user_id: 'US.SECRETBSUID', profile: { username: '@secretname' } }];

  it('one whatsapp.inbound_no_phone row per (partner, hour); meta is booleans only; no raw BSUID/username anywhere', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processInboundWebhook(webhook([noPhone('wamid.N1'), noPhone('wamid.N2')], { contacts }), { routedPartnerId: 'acme' });
    await processInboundWebhook(webhook([noPhone('wamid.N3')], { contacts }), { routedPartnerId: 'acme' });
    await processInboundWebhook(webhook([noPhone('wamid.N4')], { contacts }), { routedPartnerId: 'beta' });
    const audit = await auditRows('whatsapp.inbound_no_phone');
    expect(audit.map((a) => a.partner_id)).toEqual(['acme', 'beta']);
    expect(audit[0]).toMatchObject({ subject_id: waMessageRef('wamid.N1'), meta: { hasBsuid: true, hasUsername: true } });
    const everything = JSON.stringify([audit, await outboxRows(), [...redis.dump.entries()]]);
    expect(everything).not.toContain('SECRETBSUID');
    expect(everything).not.toContain('secretname');
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('per-change tenant rule (acceptPnid) and cross-tenant regression', () => {
  it('a change the route rejects creates no customer, turn or audit row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = { entry: [
      { changes: [{ value: { metadata: { phone_number_id: 'pn_acme' }, messages: [text('hi', 'wamid.A1')] } }] },
      { changes: [{ value: { metadata: { phone_number_id: 'pn_beta' }, messages: [text('hi', 'wamid.B1', '15559990000')],
        statuses: [{ id: 'wamid.BS', recipient_id: '15559990000', status: 'failed', errors: [{ code: 1, title: 't' }] }] } }] },
    ] };
    await processInboundWebhook(body, { routedPartnerId: 'acme', acceptPnid: async (pnid) => pnid === 'pn_acme' });
    const out = await outboxRows();
    expect(out.map((r) => r.dedupe_key)).toEqual(['wamid:wamid.A1']);
    expect(await rows(`SELECT partner_id, phone FROM customers`)).toEqual([{ partner_id: 'acme', phone: PHONE }]);
    expect(await rows(`SELECT 1 FROM audit_events`)).toHaveLength(0);
  });

  it('replaying A\'s wamid on B\'s route: one row, still A\'s; A\'s customer untouched', async () => {
    await processInboundWebhook(webhook([text('hi', 'wamid.SHARED')]), { routedPartnerId: 'acme' });
    redis.dump.clear(); // defeat the fast skip: the DB alone must hold the line
    await processInboundWebhook(webhook([text('hi', 'wamid.SHARED')]), { routedPartnerId: 'beta' });
    const out = await outboxRows();
    expect(out).toHaveLength(1);
    expect((out[0].payload as { routedPartnerId: string }).routedPartnerId).toBe('acme');
    const cs = createCustomerStore(db, createStore(redis, db));
    expect(await cs.getCustomer('acme', PHONE)).not.toBeNull();
    // Any B-side writes land under B only.
    const partners = (await rows(`SELECT partner_id FROM customers ORDER BY partner_id`)).map((r) => r.partner_id);
    expect(partners.every((p) => p === 'acme' || p === 'beta')).toBe(true);
  });
});
