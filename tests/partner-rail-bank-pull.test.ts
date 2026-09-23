import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// The hosted reference rail accepts the cross-border DUAL-LEG bank_pull
// instruction (buyer-debit + seller-payout) and simulates it as ONE settlement —
// scheduling the same delayed `paid_out` callback the single-leg payout uses, so
// the forward loop (→ delivered → invoice paid) completes.

const SIGNING_SECRET = 'sign-secret';

let db: Db;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));
// fix 29: the v2 replay guard's Redis — an in-memory double.
vi.mock('@/lib/redis', async () => {
  const { fakeRedis } = await import('./helpers');
  const r = fakeRedis();
  return { getRedis: () => r };
});
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: SIGNING_SECRET }, webhookSecret: 'cb' },
      whatsapp: {},
    }),
  }),
}));

import { POST } from '@/app/api/partner-rail/route';

function sign(raw: string): string {
  return createHmac('sha256', SIGNING_SECRET).update(raw).digest('hex');
}

function postInstruction(body: unknown) {
  const raw = JSON.stringify(body);
  const req = new NextRequest('http://localhost/api/partner-rail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': sign(raw) },
    body: raw,
  });
  return POST(req);
}

async function railCallbacks(): Promise<Array<{ dedupe_key: string | null; delayed: boolean }>> {
  const r = (await db.execute(
    sql`SELECT dedupe_key, next_attempt_at > now() + interval '5 seconds' AS delayed FROM outbox WHERE kind = 'rail.callback' ORDER BY id`,
  )) as unknown as { rows: Array<{ dedupe_key: string | null; delayed: boolean }> };
  return r.rows;
}

beforeEach(async () => {
  db = await freshDb();
});

describe('partner-rail — cross-border dual-leg bank_pull', () => {
  it('accepts a SIGNED dual-leg instruction and schedules the delayed paid_out callback', async () => {
    const res = await postInstruction({
      reference: 'xb_t1',
      partner_id: 'default',
      corridor: { source: 'HK', destination: 'IN' },
      payout: { rail: 'bank', destination: '123456789 HDFC0001234' },
      amount: { source: 1010, currency: 'HKD', destination: 8500, destination_currency: 'INR', fx_rate: 8.42 },
      funding: { method: 'bank_debit', token: 'bankpull_abc', amount: 1010, currency: 'HKD', country: 'HK' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, providerRef: 'simrail-xb_t1', legs: 'dual' });

    const cbs = await railCallbacks();
    expect(cbs).toHaveLength(1);
    expect(cbs[0].dedupe_key).toBe('railcb:xb_t1');
    expect(cbs[0].delayed).toBe(true); // realistic settlement lag → forward loop completes
  });

  it('accepts a SIGNED usdc-payout instruction exactly like bank: ack + the same delayed paid_out callback', async () => {
    const res = await postInstruction({
      reference: 'usdc_t1',
      partner_id: 'default',
      corridor: { source: 'US', destination: 'HK' },
      // The USDC seller-payout leg: bare 0x wallet address on the wire.
      payout: { rail: 'usdc', destination: '0x8ba1f109551bD432803012645Ac136ddd64DBA72' },
      amount: { source: 128.4, currency: 'USD', destination: 1000, destination_currency: 'HKD', fx_rate: 7.788 },
      funding: { method: 'bank_debit', token: 'bankpull_abc', amount: 133.4, currency: 'USD', country: 'US' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, providerRef: 'simrail-usdc_t1', legs: 'dual' });

    const cbs = await railCallbacks();
    expect(cbs).toHaveLength(1);
    expect(cbs[0].dedupe_key).toBe('railcb:usdc_t1');
    expect(cbs[0].delayed).toBe(true); // same forward loop → delivered → invoice paid
  });

  it('fix 29: accepts the dual-leg instruction signed with the v2 header only', async () => {
    const raw = JSON.stringify({
      reference: 'xb_v2', partner_id: 'default',
      payout: { rail: 'bank', destination: '123456789 HDFC0001234' },
      amount: { source: 1010, currency: 'HKD', destination: 8500, destination_currency: 'INR', fx_rate: 8.42 },
      funding: { method: 'bank_debit', token: 'bankpull_abc', amount: 1010, currency: 'HKD', country: 'HK' },
    });
    const t = Math.floor(Date.now() / 1000);
    const res = await POST(new NextRequest('http://localhost/api/partner-rail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-smartremit-signature': `t=${t},v1=${createHmac('sha256', SIGNING_SECRET).update(`${t}.${raw}`).digest('hex')}` },
      body: raw,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, providerRef: 'simrail-xb_v2', legs: 'dual' });
  });

  it('rejects a tampered/unsigned dual-leg instruction (fail-closed)', async () => {
    const raw = JSON.stringify({
      reference: 'xb_t2', partner_id: 'default',
      funding: { method: 'bank_debit', token: 'x' },
    });
    const req = new NextRequest('http://localhost/api/partner-rail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': 'bogus' },
      body: raw,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await railCallbacks()).toHaveLength(0);
  });
});
