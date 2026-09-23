import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { fakeRedis } from './helpers';
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

vi.mock('@/lib/env', () => ({ env: { personaWebhookSecret: 'wbhsec_test' } }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig() as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig() as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => partner, ensureDefaultPartner: async () => partner }),
}));
vi.mock('@/lib/whatsapp', () => ({ sendVerificationStatus: notify }));
// Program-Fix 49A: the nudge leaves from the owning partner's own number.
const integrations = vi.hoisted(() => ({ current: { kyc: {}, payment: {}, whatsapp: {} } as Record<string, unknown> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => integrations.current }),
}));
// after() runs inline; its promise is collected so POST (below) can await the
// post-response notify before the assertions (Program-Fix 49A: the nudge now
// resolves the partner's creds first, so it is no longer synchronous).
const afterTasks = vi.hoisted(() => [] as unknown[]);
vi.mock('next/server', async (orig) => ({
  ...(await orig() as object),
  after: (fn: () => unknown) => { afterTasks.push(fn()); },
}));

import { POST as routePOST } from '@/app/api/persona-webhook/route';
const POST = async (r: Parameters<typeof routePOST>[0]) => {
  const res = await routePOST(r);
  await Promise.all(afterTasks.splice(0));
  return res;
};

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
beforeEach(async () => {
  db = await freshDb();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  kcs = createKycCaseStore(fakeRedis(), cs);
  partner = { id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active', requireKycBeforeSend: true, createdAt: ISO, updatedAt: ISO };
  notify.mockClear();
  integrations.current = { kyc: {}, payment: {}, whatsapp: {} };
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
    expect(notify).toHaveBeenCalledWith(PHONE, 'received', undefined, undefined); // no BYO creds ⇒ shared number
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

describe('POST /api/persona-webhook — consent + BYO creds (Program-Fix 49A)', () => {
  it('an opted-out customer gets NO KYC nudge (nonessential); the state still advances', async () => {
    await seed({ optedOutAt: '2026-06-01T12:00:00.000Z' });
    const body = eventBody('inquiry.completed', 'evt_optout');
    const res = await POST(req(body, signed(body)));
    expect(res.status).toBe(200);
    expect((await cs.getCustomer('default', PHONE))?.kycReviewState).toBe('pending_review');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a BYO partner\'s nudge carries that partner\'s creds', async () => {
    integrations.current = { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_byo', token: 'tok_byo' } };
    await seed();
    const body = eventBody('inquiry.completed', 'evt_byo');
    await POST(req(body, signed(body)));
    expect(notify).toHaveBeenCalledWith(PHONE, 'received', undefined, { phoneNumberId: 'pn_byo', token: 'tok_byo' });
  });
});

