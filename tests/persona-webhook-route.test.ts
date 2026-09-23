import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fakeRedis, type FakeRedis } from './helpers';
import { outbox } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore, type KycCaseStore } from '@/lib/kyc-case-store';
import { createStore } from '@/lib/store';
import type { Customer, Partner } from '@/lib/types';

// pg-backed stores rebuilt per test (freshDb truncates); the hoisted mock
// factories must NOT construct them — the getters close over the lets lazily.
// Event dedup + audit stay on fakeRedis inside kcs.
let cs: CustomerStore;
let kcs: KycCaseStore;
// The partner the route resolves for the notify gate (sendGateActive). The
// suite default is gate ON (requireKycBeforeSend: true) — the legacy behavior
// the existing notify assertions pin; the gate-off test flips it per-test.
let partner: Partner;
// vi.hoisted so the (eager) whatsapp mock factory can reference it before init.
const notify = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/env', () => ({
  env: { personaWebhookSecret: 'wbhsec_test', fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY },
}));
// Program-Fix 35: the kycmatch ops alert is an outbox row on the ledger — the
// per-test PGlite (a lazy getter over the `db` let).
vi.mock('@/db/client', async (orig) => ({ ...(await orig() as object), getDb: () => db }));
const warn = vi.hoisted(() => vi.fn());
// A switch that makes the NEXT outbox enqueue throw (the alert-failure case).
const failEnqueue = vi.hoisted(() => ({ once: false }));
vi.mock('@/db/repos/outbox-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/outbox-repo')>();
  return {
    ...real,
    createOutboxRepo: (d: Parameters<typeof real.createOutboxRepo>[0]) => {
      const r = real.createOutboxRepo(d);
      return {
        ...r,
        enqueue: async (...a: Parameters<typeof r.enqueue>) => {
          if (failEnqueue.once) {
            failEnqueue.once = false;
            throw new Error('ledger down');
          }
          return r.enqueue(...a);
        },
      };
    },
  };
});
vi.mock('@/lib/log', async (orig) => ({ ...(await orig() as object), logWarn: warn }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => ({}) }));
// failSave: the NEXT saveCustomer on a tx-bound store (the durable apply) throws.
const failSave = vi.hoisted(() => ({ once: false }));
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return {
    ...real,
    getCustomerStore: () => cs,
    createCustomerStore: (...a: Parameters<typeof real.createCustomerStore>) => {
      const store = real.createCustomerStore(...a);
      const save = store.saveCustomer;
      store.saveCustomer = async (c) => {
        if (failSave.once) {
          failSave.once = false;
          throw new Error('db down');
        }
        return save(c);
      };
      return store;
    },
  };
});
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig() as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => partner, ensureDefaultPartner: async () => partner }),
}));
vi.mock('@/lib/whatsapp', () => ({ sendVerificationStatus: notify }));
vi.mock('next/server', async (orig) => ({ ...(await orig() as object), after: (fn: () => void) => fn() }));

import { POST } from '@/app/api/persona-webhook/route';

const PHONE = '15551230000';
const ISO = '2026-06-01T00:00:00.000Z';
const seed = (over: Partial<Customer> = {}) =>
  cs.saveCustomer({ senderPhone: PHONE, firstSeenAt: ISO, kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: ISO, updatedAt: ISO, ...over } as Customer);

const eventBody = (name: string, eventId: string) =>
  JSON.stringify({ data: { id: eventId, type: 'event', attributes: { name, 'created-at': '2026-06-02T20:00:00Z', payload: { data: { id: 'inq_1', attributes: { status: name.split('.')[1] ?? 'completed', 'reference-id': PHONE } } } } } });

function signed(body: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', 'wbhsec_test').update(`${t}.${body}`).digest('hex')}`;
}
const req = (body: string, header: string) =>
  ({ text: async () => body, headers: { get: (h: string) => (h.toLowerCase() === 'persona-signature' ? header : null) } }) as unknown as Parameters<typeof POST>[0];

let db: Awaited<ReturnType<typeof freshDb>>;
let redis: FakeRedis;
beforeEach(async () => {
  db = await freshDb();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  redis = fakeRedis();
  kcs = createKycCaseStore(redis, cs);
  partner = { id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active', requireKycBeforeSend: true, createdAt: ISO, updatedAt: ISO };
  notify.mockClear();
  warn.mockClear();
  failEnqueue.once = false;
  failSave.once = false;
});

describe('POST /api/persona-webhook', () => {
  it('401 on a bad signature (does not touch state)', async () => {
    await seed();
    const body = eventBody('inquiry.completed', 'evt_x');
    const res = await POST(req(body, 't=1,v1=bad'));
    expect(res.status).toBe(401);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBeUndefined();
  });

  it('200 + moves a clean pass to pending_review (NEVER verified)', async () => {
    await seed();
    const body = eventBody('inquiry.completed', 'evt_1');
    const res = await POST(req(body, signed(body)));
    expect(res.status).toBe(200);
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('pending_review');
    expect(c?.kycStatus).toBe('pending'); // gate field untouched
    expect(notify).toHaveBeenCalledWith(PHONE, 'received', undefined);
  });

  it('gate OFF ⇒ KYC state still advances but the customer is NOT messaged', async () => {
    partner = { id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active', createdAt: ISO, updatedAt: ISO }; // no requireKycBeforeSend ⇒ gate off
    await seed();
    const started = eventBody('inquiry.started', 'evt_off_1');
    await POST(req(started, signed(started)));
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('inquiry_started'); // Persona stays source of truth
    const completed = eventBody('inquiry.completed', 'evt_off_2');
    const res = await POST(req(completed, signed(completed)));
    expect(res.status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');
    expect(notify).not.toHaveBeenCalled(); // neither in_progress nor received
  });

  it('idempotent: a replayed event id is a no-op', async () => {
    await seed();
    const body = eventBody('inquiry.started', 'evt_dup');
    await POST(req(body, signed(body)));
    const res2 = await POST(req(body, signed(body)));
    const j = await res2.json();
    expect(j.deduped).toBe(true);
  });

  it('200 ignored when the referenced customer does not exist', async () => {
    const body = eventBody('inquiry.completed', 'evt_nocust');
    const res = await POST(req(body, signed(body)));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ignored).toBe(true);
  });

  it('two tenant rows for the phone: the completion binds to the row whose inquiry the TOOL path recorded, never the sibling (review item 1)', async () => {
    await seedPartner(db, 'acme');
    await seed({ createdAt: '2026-05-01T00:00:00.000Z' }); // default row, no inquiry
    await seed({ partnerId: 'acme', kycInquiryId: 'inq_1', kycProviderRef: 'inq_1' }); // tools.ts recorded inq_1 here
    const body = eventBody('inquiry.completed', 'evt_two_rows');
    const res = await POST(req(body, signed(body)));
    expect(res.status).toBe(200);
    expect((await cs.getCustomer('acme', PHONE))?.kycReviewState).toBe('pending_review');
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBeUndefined();
  });

  it('two tenant rows and NO recorded inquiry: the event is ignored (never guesses a tenant)', async () => {
    await seedPartner(db, 'acme');
    await seed({ createdAt: '2026-05-01T00:00:00.000Z' });
    await seed({ partnerId: 'acme' });
    const body = eventBody('inquiry.completed', 'evt_two_rows_none');
    const j = await (await POST(req(body, signed(body)))).json();
    expect(j.ignored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Program-Fix 35: report events. A report event's payload.data is the REPORT
// object (type 'report/<kind>', id 'rep_…', the inquiry under
// relationships.inquiry.data.id) and carries no phone
// (https://docs.withpersona.com/api-reference/reports/retrieve-a-report).
const reportBody = (name: string, eventId: string, inquiryId = 'inq_1', extraAttrs: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      id: eventId,
      type: 'event',
      attributes: {
        name,
        'created-at': '2026-06-02T20:05:00Z',
        payload: {
          data: {
            type: `report/${name.slice('report/'.length).split('.')[0]}`,
            id: 'rep_1',
            attributes: { status: 'ready', ...extraAttrs },
            relationships: { inquiry: { data: { type: 'inquiry', id: inquiryId } } },
          },
        },
      },
    },
  });

const kycAlerts = async () =>
  (await db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'))).filter((r) => (r.dedupeKey ?? '').startsWith('kycmatch:'));

const unboundAlerts = async () =>
  (await db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'))).filter((r) => (r.dedupeKey ?? '').startsWith('kycunbound:'));

const post = async (body: string) => POST(req(body, signed(body)));

describe('POST /api/persona-webhook — report events + release on failure (Program-Fix 35)', () => {
  it('loop proof: created → completed → PEP report (no reference-id) holds → a later approved cannot clear it → a human approves', async () => {
    await seed(); // no kycInquiryId yet: inquiry.created is what records it
    expect((await post(eventBody('inquiry.created', 'evt_loop_1'))).status).toBe(200);
    let c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('inquiry_started');
    expect(c?.kycInquiryId).toBe('inq_1');

    await post(eventBody('inquiry.completed', 'evt_loop_2'));
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');

    const pep = await post(reportBody('report/politically-exposed-person.matched', 'evt_loop_3'));
    expect(pep.status).toBe(200);
    expect((await pep.json()).ignored).toBeUndefined();
    c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('needs_review');
    expect(c?.pepHit).toBe(true);
    expect(c?.kycInquiryId).toBe('inq_1'); // never the rep_ id
    expect(c?.kycProviderRef).toBe('inq_1');
    expect(c?.kycStatus).toBe('pending');
    expect(await kycAlerts()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('persona.event', 'report/politically-exposed-person.matched', { matchKind: 'pep' });

    // A clean inquiry.approved delivered later (a NEW event id, not a dedupe) cannot clear the hold.
    const late = await post(eventBody('inquiry.approved', 'evt_loop_4'));
    expect(late.status).toBe(200);
    c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('needs_review');
    expect(c?.kycStatus).toBe('pending');

    // Only a human clears it.
    const approved = await kcs.review('default', PHONE, 'approve', 'staff-1', 'reviewed the PEP match');
    expect(approved?.kycStatus).toBe('verified');
    expect(approved?.kycReviewState).toBe('approved');
    expect(approved?.pepHit).toBe(true);
  });

  it('apply throws → 500 and the seen-mark is released → Persona\'s retry processes the event', async () => {
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    const body = reportBody('report/watchlist.matched', 'evt_throw_1');
    failSave.once = true;
    const first = await post(body);
    expect(first.status).toBe(500);
    expect(failSave.once).toBe(false); // the save really ran and threw
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');
    expect(await kycAlerts()).toHaveLength(0);

    const retry = await post(body);
    expect(retry.status).toBe(200);
    expect((await retry.json()).deduped).toBeUndefined();
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('needs_review');
    expect(c?.watchlistHit).toBe(true);
    expect(await kycAlerts()).toHaveLength(1);

    // …and once processed, a further delivery is deduped as before.
    expect((await (await post(body)).json()).deduped).toBe(true);
  });

  it('a throw in the customer lookup also releases the mark', async () => {
    await seed({ kycInquiryId: 'inq_1' });
    const body = reportBody('report/politically-exposed-person.matched', 'evt_throw_lookup');
    const spy = vi.spyOn(cs, 'findByKycInquiryId').mockRejectedValueOnce(new Error('db down'));
    expect((await post(body)).status).toBe(500);
    spy.mockRestore();
    expect((await post(body)).status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.pepHit).toBe(true);
  });

  it('save + alert commit together; a Redis audit failure AFTER the commit is best-effort → 200, not retried, one alert', async () => {
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    const body = reportBody('report/politically-exposed-person.matched', 'evt_audit_throw');
    // appendAudit = hgetall + hset, and runs only after the transaction committed.
    redis.hset = (async () => {
      throw new Error('redis down');
    }) as typeof redis.hset;

    const res = await post(body);
    expect(res.status).toBe(200);
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('needs_review');
    expect(c?.pepHit).toBe(true);
    expect(c?.kycInquiryId).toBe('inq_1');
    expect(await kycAlerts()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('kyc.persona.redis_audit', expect.anything(), { partnerId: 'default' });
    // Processed: a re-delivery is deduped (the mark was kept, not released).
    expect((await (await post(body)).json()).deduped).toBe(true);
    expect(await kycAlerts()).toHaveLength(1);
  });

  it('a thrown alert enqueue ROLLS BACK the customer save → 500, mark released → the retry commits state + one alert', async () => {
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    const body = reportBody('report/politically-exposed-person.matched', 'evt_rollback');
    failEnqueue.once = true;
    expect((await post(body)).status).toBe(500);
    expect(failEnqueue.once).toBe(false); // the enqueue really ran and threw
    const rolledBack = await cs.getCustomer('default', PHONE);
    expect(rolledBack?.kycReviewState).toBe('pending_review'); // the hold did NOT commit without its alert
    expect(rolledBack?.pepHit).toBeUndefined();
    expect(await kycAlerts()).toHaveLength(0);
    expect(await kcs.getAudit('default', PHONE)).toEqual([]);

    expect((await post(body)).status).toBe(200);
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('needs_review');
    expect(c?.pepHit).toBe(true);
    expect(await kycAlerts()).toHaveLength(1);
  });

  it('a report event never reads a reference-id as the phone: it binds by the inquiry relationship', async () => {
    const OTHER = '15559990000';
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    await cs.saveCustomer({ senderPhone: OTHER, firstSeenAt: ISO, kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: ISO, updatedAt: ISO, kycReviewState: 'pending_review' } as Customer);
    const body = reportBody('report/watchlist.matched', 'evt_ref', 'inq_1', { 'reference-id': OTHER });
    expect((await post(body)).status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('needs_review');
    expect((await cs.getCustomer('default', OTHER))?.kycReviewState).toBe('pending_review');
    expect(notify).not.toHaveBeenCalled(); // a hold never messages the customer
  });

  it('a non-match report event (.ready) on a pending_review customer changes nothing and sends nothing', async () => {
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    const res = await post(reportBody('report/politically-exposed-person.ready', 'evt_ready'));
    expect(res.status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');
    expect(notify).not.toHaveBeenCalled();
    expect(await kycAlerts()).toHaveLength(0);
  });

  it('an inquiry event with no reference-id binds by the recorded inquiry and notifies the bound customer\'s phone', async () => {
    await seed({ kycReviewState: 'inquiry_started', kycInquiryId: 'inq_1' });
    const body = JSON.stringify({ data: { id: 'evt_noref', type: 'event', attributes: { name: 'inquiry.completed', 'created-at': '2026-06-02T20:00:00Z', payload: { data: { type: 'inquiry', id: 'inq_1', attributes: { status: 'completed' } } } } } });
    expect((await post(body)).status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');
    expect(notify).toHaveBeenCalledWith(PHONE, 'received', undefined);
  });

  it('ambiguous inquiry id (two rows recorded it) is ignored and warned; nothing changes', async () => {
    await seedPartner(db, 'acme');
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    await seed({ partnerId: 'acme', kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    const res = await post(reportBody('report/politically-exposed-person.matched', 'evt_amb'));
    expect((await res.json()).ignored).toBe(true);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');
    expect((await cs.getCustomer('acme', PHONE))?.kycReviewState).toBe('pending_review');
    expect(warn).toHaveBeenCalledWith('persona.webhook.unbound', expect.anything(), expect.objectContaining({ candidates: 2 }));
    expect(await kycAlerts()).toHaveLength(0);
    // …but the unbound match raises ONE deduped alert: the event name and the count only.
    const unbound = await unboundAlerts();
    expect(unbound.map((r) => r.dedupeKey)).toEqual(['kycunbound:evt_amb']);
    const msg = String((unbound[0].payload as { message: string }).message);
    expect(msg).toContain('report/politically-exposed-person.matched');
    expect(msg).toContain('2 candidates');
    expect(msg).not.toContain(PHONE);
    expect(msg).not.toContain('inq_1');
  });

  it('an unknown inquiry id is ignored; a match raises the unbound alert (0 candidates)', async () => {
    await seed({ kycInquiryId: 'inq_1' });
    const res = await post(reportBody('report/watchlist.matched', 'evt_unknown', 'inq_zzz'));
    expect((await res.json()).ignored).toBe(true);
    expect((await cs.getCustomer('default', PHONE))?.watchlistHit).toBeUndefined();
    const unbound = await unboundAlerts();
    expect(unbound).toHaveLength(1);
    expect(String((unbound[0].payload as { message: string }).message)).toContain('0 candidates');
  });

  it('an unbound NON-match event raises no alert', async () => {
    const res = await post(reportBody('report/watchlist.ready', 'evt_unknown_ready', 'inq_zzz'));
    expect((await res.json()).ignored).toBe(true);
    expect(await unboundAlerts()).toHaveLength(0);
  });

  it('approved + PEP match: the flag is set, the state stays approved, one alert', async () => {
    await seed({ kycStatus: 'verified', kycReviewState: 'approved', kycInquiryId: 'inq_1' });
    const res = await post(reportBody('report/politically-exposed-person.matched', 'evt_appr_pep'));
    expect(res.status).toBe(200);
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('approved');
    expect(c?.kycStatus).toBe('verified');
    expect(c?.pepHit).toBe(true);
    const alerts = await kycAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupeKey).toBe('kycmatch:evt_appr_pep');
    // ids only: never the phone
    expect(JSON.stringify(alerts[0].payload)).not.toContain(PHONE);
    expect(String((alerts[0].payload as { message: string }).message)).toContain('the flag is recorded');
  });

  it('approved + another *.matched kind: no flag exists, so the alert never claims one', async () => {
    await seed({ kycStatus: 'verified', kycReviewState: 'approved', kycInquiryId: 'inq_1' });
    expect((await post(reportBody('report/adverse-media.matched', 'evt_appr_other'))).status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('approved');
    const alerts = await kycAlerts();
    expect(alerts).toHaveLength(1);
    const msg = String((alerts[0].payload as { message: string }).message);
    expect(msg).not.toContain('the flag is recorded');
    expect(msg).toContain('sending is NOT blocked');
  });

  it('a report event with no inquiry relationship is ignored AND warned (an envelope mismatch is visible in logs)', async () => {
    await seed({ kycReviewState: 'pending_review', kycInquiryId: 'inq_1' });
    const body = JSON.stringify({ data: { id: 'evt_norel', type: 'event', attributes: { name: 'report/watchlist.matched', 'created-at': '2026-06-02T20:05:00Z', payload: { data: { type: 'report/watchlist', id: 'rep_1', attributes: {} } } } } });
    expect((await (await post(body)).json()).ignored).toBe(true);
    expect(warn).toHaveBeenCalledWith('persona.webhook.unbound', 'report/watchlist.matched', { candidates: 0, reason: 'no_inquiry' });
  });

  it('approved + an inquiry.completed stays a no-op (human terminal wins)', async () => {
    await seed({ kycStatus: 'verified', kycReviewState: 'approved', kycInquiryId: 'inq_1' });
    expect((await post(eventBody('inquiry.completed', 'evt_appr_done'))).status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('approved');
    expect(await kycAlerts()).toHaveLength(0);
  });
});
