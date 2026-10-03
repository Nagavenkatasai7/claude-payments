import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { newTransferId } from '@/lib/id';
import type { Transfer } from '@/lib/types';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';

// Lost-features p4 C2: GET /account/continue/<kind>/<id> — the public hand-over for old /account
// receipt and ticket links. It reads ONLY the row's partner and forwards to that partner's portal
// sign-in with ?next=. Every other case (bad id, missing row, test row, internal ticket, a partner
// without a live portal, a lookup error, rate limited) is the identical redirect to /account/login.
// Non-apex host → 404. Nothing about the row other than "which portal" leaves the server.

const h = vi.hoisted(() => ({
  db: null as unknown,
  limited: false,
  limitCalls: [] as Array<{ scope: string; limit: number; windowSec?: number }>,
  origins: {} as Record<string, string | null>,
  originThrows: false,
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/ip-rate-limit')>()),
  isIpRateLimited: async (_headers: Headers, scope: string, limit: number, windowSec?: number) => {
    h.limitCalls.push({ scope, limit, windowSec });
    return h.limited;
  },
}));
vi.mock('@/lib/customer-portal-url', async (orig) => ({
  ...(await orig<typeof import('@/lib/customer-portal-url')>()),
  customerPortalOrigin: async (partnerId: string) => {
    if (h.originThrows) throw new Error('boom');
    return h.origins[partnerId] ?? null;
  },
}));

import { GET } from '@/app/account/continue/[kind]/[id]/route';

let db: Db;
const PHONE = '14155550101';
const LOGIN = 'https://smartremit.ai/account/login';

async function call(kind: string, id: string, host = 'smartremit.ai') {
  const req = new NextRequest(`https://smartremit.ai/account/continue/${kind}/${id}`, { headers: { host, 'x-forwarded-for': '203.0.113.9' } });
  return GET(req, { params: Promise.resolve({ kind, id }) });
}
const loc = (r: Response) => r.headers.get('location');

beforeEach(async () => {
  db = await freshDb();
  h.db = db;
  h.limited = false;
  h.limitCalls = [];
  h.originThrows = false;
  h.origins = { pa: 'https://acme.smartremit.ai', pb: null };
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('GET /account/continue/<kind>/<id>', () => {
  it("a portal partner's transfer → that portal's sign-in with next = the transfer page", async () => {
    const id = await seedLedgerSpend(db, { partnerId: 'pa', phone: PHONE, amountUsd: 10, status: 'paid' });
    const r = await call('receipt', id);
    expect(r.status).toBe(307);
    expect(loc(r)).toBe(`https://acme.smartremit.ai/portal/login?next=${encodeURIComponent(`/portal/transfers/${id}`)}`);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(h.limitCalls).toEqual([{ scope: 'legacy-link', limit: 30, windowSec: 3600 }]);
  });
  it("a portal partner's customer ticket → the help ticket page", async () => {
    const id = `tk_${newTransferId()}`;
    await createTicketRepo(db).createTicket({ id, partnerId: 'pa', kind: 'customer', customerPhone: PHONE, subject: 'Q', body: 'B' });
    expect(loc(await call('support', id))).toBe(`https://acme.smartremit.ai/portal/login?next=${encodeURIComponent(`/portal/help/tickets/${id}`)}`);
  });

  describe('every other case is the identical /account/login redirect', () => {
    it('a partner without a live portal', async () => {
      const id = await seedLedgerSpend(db, { partnerId: 'pb', phone: PHONE, amountUsd: 10, status: 'paid' });
      const r = await call('receipt', id);
      expect(r.status).toBe(307);
      expect(loc(r)).toBe(LOGIN);
    });
    it('a missing transfer and a missing ticket', async () => {
      expect(loc(await call('receipt', newTransferId()))).toBe(LOGIN);
      expect(loc(await call('support', `tk_${newTransferId()}`))).toBe(LOGIN);
    });
    it('a test-environment transfer', async () => {
      const id = newTransferId();
      const t = { id, phone: PHONE, amountUsd: 10, feeUsd: 0, totalChargeUsd: 10, fxRate: 85, amountInr: 850, recipientName: 'R',
        recipientPhone: '919000000000', payoutMethod: 'bank', payoutDestination: '000011112222|HDFC0000001', fundingMethod: 'bank_transfer',
        complianceStatus: 'cleared', complianceReasons: [], status: 'paid', createdAt: new Date().toISOString(), partnerId: 'pa',
        sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR', amountSource: 10, feeSource: 0,
        totalChargeSource: 10, environment: 'test' } as Transfer;
      await createTransferRepo(db).saveTransfer(t);
      expect(loc(await call('receipt', id))).toBe(LOGIN);
    });
    it('an internal ticket', async () => {
      const id = `tk_${newTransferId()}`;
      await createTicketRepo(db).createTicket({ id, partnerId: 'pa', kind: 'internal', openedBy: 'ops', subject: 'Q', body: 'B' });
      expect(loc(await call('support', id))).toBe(LOGIN);
    });
    it.each([
      ['receipt', 'abc'],
      ['receipt', 'a%2Fb%2Fcdef'],
      ['support', 'abc'],
      ['support', 'new'],
      ['history', 'AbCdEfGh12'],
      ['receipt', 'x'.repeat(65)],
    ])('a malformed target (%s/%s), with no lookup', async (kind, id) => {
      h.db = new Proxy({}, { get: () => { throw new Error('unexpected read'); } });
      expect(loc(await call(kind, id))).toBe(LOGIN);
    });
    it('a lookup error', async () => {
      const id = await seedLedgerSpend(db, { partnerId: 'pa', phone: PHONE, amountUsd: 10, status: 'paid' });
      h.db = new Proxy({}, { get: () => { throw new Error('db down'); } });
      expect(loc(await call('receipt', id))).toBe(LOGIN);
      h.db = db;
      h.originThrows = true;
      expect(loc(await call('receipt', id))).toBe(LOGIN);
    });
    it('rate limited (before any lookup)', async () => {
      const id = await seedLedgerSpend(db, { partnerId: 'pa', phone: PHONE, amountUsd: 10, status: 'paid' });
      h.limited = true;
      h.db = new Proxy({}, { get: () => { throw new Error('unexpected read'); } });
      expect(loc(await call('receipt', id))).toBe(LOGIN);
    });
  });

  it.each(['acme.smartremit.ai', 'api.smartremit.ai'])('a non-apex host (%s) → 404, no lookup, no limiter call', async (host) => {
    h.db = new Proxy({}, { get: () => { throw new Error('unexpected read'); } });
    const r = await call('receipt', 'AbCdEfGh12', host);
    expect(r.status).toBe(404);
    expect(h.limitCalls).toEqual([]);
  });
});
