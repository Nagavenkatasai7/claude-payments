import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore, type KycCaseStore } from '@/lib/kyc-case-store';
import { createStore } from '@/lib/store';
import type { Customer } from '@/lib/types';

// pg-backed stores rebuilt per test (freshDb truncates); the hoisted mock
// factories must NOT construct them — the getters close over the lets lazily.
// Event dedup + audit stay on fakeRedis inside kcs.
let cs: CustomerStore;
let kcs: KycCaseStore;
// vi.hoisted so the (eager) whatsapp mock factory can reference it before init.
const notify = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/env', () => ({ env: { personaWebhookSecret: 'wbhsec_test' } }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig() as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig() as object), getKycCaseStore: () => kcs }));
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

beforeEach(async () => {
  const db = await freshDb();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  kcs = createKycCaseStore(fakeRedis(), cs);
  notify.mockClear();
});

describe('POST /api/persona-webhook', () => {
  it('401 on a bad signature (does not touch state)', async () => {
    await seed();
    const body = eventBody('inquiry.completed', 'evt_x');
    const res = await POST(req(body, 't=1,v1=bad'));
    expect(res.status).toBe(401);
    expect((await cs.getCustomer(PHONE))?.kycReviewState).toBeUndefined();
  });

  it('200 + moves a clean pass to pending_review (NEVER verified)', async () => {
    await seed();
    const body = eventBody('inquiry.completed', 'evt_1');
    const res = await POST(req(body, signed(body)));
    expect(res.status).toBe(200);
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycReviewState).toBe('pending_review');
    expect(c?.kycStatus).toBe('pending'); // gate field untouched
    expect(notify).toHaveBeenCalledWith(PHONE, 'received', undefined);
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
});
