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
  enqueueFault: { error: null as Error | null, times: 0, skip: 0 },
}));
// The next N audit inserts throw (review fix 7).
const auditFault = vi.hoisted(() => ({ times: 0 }));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (d: Parameters<typeof real.createAuditRepo>[0]) => {
      const repo = real.createAuditRepo(d);
      return {
        ...repo,
        record: async (...args: Parameters<typeof repo.record>) => {
          if (auditFault.times > 0) {
            auditFault.times--;
            throw Object.assign(new Error('audit down'), { code: '08006' });
          }
          return repo.record(...args);
        },
      };
    },
  };
});
// Consent-write fault injection (review fix 4): the named method throws once.
const customerFault = vi.hoisted(() => ({ method: '' as string, error: null as Error | null }));
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  const wrap = <T extends object>(cs: T): T =>
    new Proxy(cs, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (prop === customerFault.method && customerFault.error) {
            const e = customerFault.error;
            customerFault.error = null;
            return Promise.reject(e);
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return {
    ...real,
    getCustomerStore: (...args: Parameters<typeof real.getCustomerStore>) => wrap(real.getCustomerStore(...args)),
  };
});
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
          if (enqueueFault.skip > 0) {
            enqueueFault.skip--;
            return repo.enqueue(...args);
          }
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
  enqueueFault.skip = 0;
  auditFault.times = 0;
  customerFault.method = '';
  customerFault.error = null;
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
    // R2a: the partner-visible channel-health mark (Redis only; the audit row above is the ledger record).
    expect(JSON.parse(redis.dump.get('wahealth:acme') ?? '{}').no_phone).toMatchObject({ count: 3 });
    expect(JSON.parse(redis.dump.get('wahealth:beta') ?? '{}').no_phone).toMatchObject({ count: 1 });
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
    // Exactly: A's row, plus B's own row from B's pipeline (the phone is B's customer too). No row moved.
    expect(await rows(`SELECT partner_id, phone FROM customers ORDER BY partner_id`)).toEqual([
      { partner_id: 'acme', phone: PHONE },
      { partner_id: 'beta', phone: PHONE },
    ]);
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);
const at = (m: Msg, sec: number): Msg => ({ ...m, timestamp: String(sec) });
const customer = async (tenant = 'default') => createCustomerStore(db, createStore(redis, db)).getCustomer(tenant, PHONE);

describe('consent ordering: a replayed START never undoes a later STOP (review fix 3)', () => {
  it('a START sent BEFORE the stored opt-out ⇒ still opted out, no confirmation row, acknowledged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processInboundWebhook(webhook([at(text('STOP', 'wamid.STOP_T'), nowSec())]), { routedPartnerId: null });
    const optedOutAt = (await customer())!.optedOutAt!;
    const res = await processInboundWebhook(webhook([at(text('START', 'wamid.START_OLD'), nowSec() - 120)]), { routedPartnerId: null });
    expect(res).toEqual({ ok: true });
    expect((await customer())!.optedOutAt).toBe(optedOutAt);
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['wamid:wamid.STOP_T']);
  });

  it('a START sent in the same second as, or after, the opt-out ⇒ resumes and confirms', async () => {
    await processInboundWebhook(webhook([at(text('STOP', 'wamid.STOP_S'), nowSec())]), { routedPartnerId: null });
    await processInboundWebhook(webhook([at(text('START', 'wamid.START_S'), nowSec())]), { routedPartnerId: null });
    expect((await customer())!.optedOutAt).toBeUndefined();
    expect((await outboxRows()).map((r) => (r.payload as { body: string }).body)).toEqual([OPT_OUT_REPLY, OPT_IN_REPLY]);
  });

  it('a START without a timestamp keeps today\'s behaviour (resumes)', async () => {
    await processInboundWebhook(webhook([text('STOP', 'wamid.STOP_N')]), { routedPartnerId: null });
    await processInboundWebhook(webhook([text('START', 'wamid.START_N')]), { routedPartnerId: null });
    expect((await customer())!.optedOutAt).toBeUndefined();
  });
});

// R7 binding rule: 500 ONLY for infrastructure errors — consent included.
describe('consent-branch failures (round 2: infra ⇒ 500, anything else ⇒ 200 + audit + ops alert)', () => {
  const opsAlerts = async () => (await outboxRows()).filter((r) => r.kind === 'ops.alert');

  it.each([
    ['STOP', 'setOptedOut', 'stop'],
    ['STOP', 'ensureCustomer', 'stop'],
    ['START', 'clearOptedOut', 'start'],
  ])('%s whose %s throws an INFRASTRUCTURE error ⇒ rejects (500); the retry applies it once', async (word, method) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (word === 'START') await processInboundWebhook(webhook([text('STOP', 'wamid.PRE')]), { routedPartnerId: null });
    customerFault.method = method;
    customerFault.error = infraError();
    const body = webhook([text(word, `wamid.CF_${method}`)]);
    await expect(processInboundWebhook(body, { routedPartnerId: null })).rejects.toThrow();
    expect(redis.dump.has(`msgq:wamid.CF_${method}`)).toBe(false);
    expect(await processInboundWebhook(body, { routedPartnerId: null })).toEqual({ ok: true });
    const c = await customer();
    if (word === 'STOP') expect(c!.optedOutAt).toBeDefined();
    else expect(c!.optedOutAt).toBeUndefined();
    expect((await outboxRows()).filter((r) => r.dedupe_key === `wamid:wamid.CF_${method}`)).toHaveLength(1);
    expect(await auditRows('whatsapp.consent_failed')).toHaveLength(0);
    expect(await opsAlerts()).toHaveLength(0);
  });

  it.each([
    ['STOP', 'setOptedOut', 'stop'],
    ['START', 'clearOptedOut', 'start'],
  ])('%s whose %s throws a NON-infrastructure error ⇒ ok (200), one consent_failed audit row (kind + error name only), one ops alert', async (word, method, kind) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (word === 'START') await processInboundWebhook(webhook([text('STOP', 'wamid.PRE2')]), { routedPartnerId: 'acme' });
    customerFault.method = method;
    customerFault.error = new TypeError('unexpected 15551230000');
    const res = await processInboundWebhook(webhook([text(word, `wamid.NI_${method}`)]), { routedPartnerId: 'acme' });
    expect(res).toEqual({ ok: true });
    const audit = await auditRows('whatsapp.consent_failed');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partner_id: 'acme', subject_id: waMessageRef(`wamid.NI_${method}`), meta: { kind, error: 'TypeError' } });
    expect(await auditRows('whatsapp.inbound_dropped')).toHaveLength(0);
    const alerts = await opsAlerts();
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify([audit, alerts])).not.toMatch(/\d{7,}/);
    expect(JSON.stringify(alerts)).not.toContain('unexpected');
  });

  it('the ops alert is deduped per (tenant, hour); the audit row is per message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const id of ['wamid.D1', 'wamid.D2']) {
      customerFault.method = 'setOptedOut';
      customerFault.error = new TypeError('x');
      await processInboundWebhook(webhook([text('STOP', id)]), { routedPartnerId: 'acme' });
    }
    customerFault.method = 'setOptedOut';
    customerFault.error = new TypeError('x');
    await processInboundWebhook(webhook([text('STOP', 'wamid.D3')]), { routedPartnerId: 'beta' });
    expect(await auditRows('whatsapp.consent_failed')).toHaveLength(3);
    expect(await opsAlerts()).toHaveLength(2);
  });

  it('a STOP whose confirmation insert fails with a NON-infrastructure error ⇒ ok, consent_failed (the opt-out itself landed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueFault.error = poisonError();
    enqueueFault.times = 1;
    expect(await processInboundWebhook(webhook([text('STOP', 'wamid.CF_ENQ')]), { routedPartnerId: null })).toEqual({ ok: true });
    expect((await customer())!.optedOutAt).toBeDefined();
    expect(await auditRows('whatsapp.consent_failed')).toHaveLength(1);
  });

  it('the audit and alert are best-effort: their failure still acknowledges', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    customerFault.method = 'setOptedOut';
    customerFault.error = new TypeError('x');
    auditFault.times = 1;
    expect(await processInboundWebhook(webhook([text('STOP', 'wamid.BE')]), { routedPartnerId: null })).toEqual({ ok: true });
  });
});

describe('opted_out_at is the STOP\'s send time (round 2)', () => {
  it('a STOP sent at t=10 but processed later stores t=10; a START sent at t=12 is NOT stale', async () => {
    const t10 = nowSec() - 50;
    await processInboundWebhook(webhook([at(text('STOP', 'wamid.ST10'), t10)]), { routedPartnerId: null });
    expect(Date.parse((await customer())!.optedOutAt!)).toBe(t10 * 1000);
    await processInboundWebhook(webhook([at(text('START', 'wamid.ST12'), t10 + 2)]), { routedPartnerId: null });
    expect((await customer())!.optedOutAt).toBeUndefined();
  });

  it('a START sent before the STOP\'s send time is stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t10 = nowSec() - 50;
    await processInboundWebhook(webhook([at(text('STOP', 'wamid.SS10'), t10)]), { routedPartnerId: null });
    await processInboundWebhook(webhook([at(text('START', 'wamid.SS09'), t10 - 1)]), { routedPartnerId: null });
    expect((await customer())!.optedOutAt).toBeDefined();
  });
});

describe('NUL bytes never reach a jsonb payload (review fix 5)', () => {
  it('messageText with \\u0000 is stored without it (the real insert would reject it otherwise)', async () => {
    await processInboundWebhook(webhook([text('hi\u0000there\u0000', 'wamid.NUL')]), { routedPartnerId: null });
    const out = await outboxRows();
    expect(out).toHaveLength(1);
    expect((out[0].payload as { messageText: string }).messageText).toBe('hithere');
    expect(await rows(`SELECT 1 FROM audit_events`)).toHaveLength(0);
  });
});

describe('no-phone hourly claim is released when the audit insert fails (review fix 7)', () => {
  it('a failed insert DELs the claim, so the next no-phone message in the hour is recorded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noPhone = (id: string): Msg => ({ from_user_id: 'US.X', id, type: 'text', text: { body: 'hi' } });
    auditFault.times = 1;
    await processInboundWebhook(webhook([noPhone('wamid.NP1')]), { routedPartnerId: 'acme' });
    expect(await auditRows('whatsapp.inbound_no_phone')).toHaveLength(0);
    expect([...redis.dump.keys()].some((k) => k.startsWith('wanophone:'))).toBe(false);
    await processInboundWebhook(webhook([noPhone('wamid.NP2')]), { routedPartnerId: 'acme' });
    expect(await auditRows('whatsapp.inbound_no_phone')).toHaveLength(1);
  });
});

describe('the worker is poked even when a later message throws (review fix 8)', () => {
  it('first message queued, second hits an infra error ⇒ rejects AND pokes', async () => {
    const body = webhook([text('one', 'wamid.PK1'), text('two', 'wamid.PK2')]);
    enqueueFault.skip = 1;
    enqueueFault.error = infraError();
    enqueueFault.times = 1;
    await expect(processInboundWebhook(body, { routedPartnerId: null })).rejects.toThrow();
    expect((await outboxRows()).map((r) => r.dedupe_key)).toEqual(['wamid:wamid.PK1']);
    expect(pokeWorker).toHaveBeenCalled();
  });
});

describe('R2b: Meta-reported errors on a SIGNED webhook feed the tenant\'s channel health', () => {
  const failedStatus = (code: number, id = 'wamid.FS1') => ({
    statuses: [{ id, recipient_id: PHONE, status: 'failed', errors: [{ code, title: 'x' }] }],
  });
  const marks = (p: string) => JSON.parse(redis.dump.get(`wahealth:${p}`) ?? '{}');
  const emailRows = async () => (await outboxRows()).filter((r) => r.kind === 'email.send');

  it('a failed status with an auth code (190) ⇒ auth_error mark + hourly health row + ONE alert email + a poke', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createPartnerRepo } = await import('@/db/repos/partner-repo');
    await createPartnerRepo(db).updateSupportConfig('acme', (prev) => ({ ...prev, alertEmail: 'ops@acme.example' }));
    await processInboundWebhook(webhook([], failedStatus(190, 'wamid.FS1')), { routedPartnerId: 'acme' });
    await processInboundWebhook(webhook([], failedStatus(190, 'wamid.FS2')), { routedPartnerId: 'acme' });
    expect(marks('acme').auth_error).toMatchObject({ count: 2, code: 190 });
    expect(await auditRows('whatsapp.channel_health')).toHaveLength(1);
    const emails = await emailRows();
    expect(emails).toHaveLength(1);
    expect(emails[0].dedupe_key).toMatch(/^partnerhealth:acme:auth_error:/);
    expect(pokeWorker).toHaveBeenCalledTimes(1);
  });

  it('a failed status with a delivery code ⇒ delivery_failed mark only (its own audit row already exists), no email, no poke', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createPartnerRepo } = await import('@/db/repos/partner-repo');
    await createPartnerRepo(db).updateSupportConfig('acme', (prev) => ({ ...prev, alertEmail: 'ops@acme.example' }));
    await processInboundWebhook(webhook([], failedStatus(131026)), { routedPartnerId: 'acme' });
    expect(marks('acme').delivery_failed).toMatchObject({ count: 1, code: 131026 });
    expect(await auditRows('whatsapp.channel_health')).toHaveLength(0);
    expect(await auditRows('whatsapp.delivery_failed')).toHaveLength(1);
    expect(await emailRows()).toHaveLength(0);
    expect(pokeWorker).not.toHaveBeenCalled();
  });

  it('value.errors ⇒ auth_error for an auth code, delivery_failed otherwise (hourly health row, code only)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processInboundWebhook(webhook([], { errors: [{ code: 190, title: 'token 15551230000' }] }), { routedPartnerId: 'acme' });
    await processInboundWebhook(webhook([], { errors: [{ code: 131000, title: 'Something' }] }), { routedPartnerId: 'beta' });
    expect(marks('acme').auth_error).toMatchObject({ count: 1, code: 190 });
    expect(marks('beta').delivery_failed).toMatchObject({ count: 1, code: 131000 });
    const rows = await auditRows('whatsapp.channel_health');
    expect(rows.map((r) => [r.partner_id, r.meta])).toEqual([
      ['acme', { kind: 'auth_error', code: 190 }],
      ['beta', { kind: 'delivery_failed', code: 131000 }],
    ]);
    expect(JSON.stringify([rows, [...redis.dump.entries()]])).not.toContain('15551230000');
  });

  it('the default tenant (the shared number) gets no channel-health mark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processInboundWebhook(webhook([], { ...failedStatus(190), errors: [{ code: 190 }] }), { routedPartnerId: null });
    expect(redis.dump.has('wahealth:default')).toBe(false);
    expect(await auditRows('whatsapp.channel_health')).toHaveLength(0);
  });
});
