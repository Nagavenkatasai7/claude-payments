import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { validatePayoutFields } from '@/lib/payout-format';
import type { Db } from '@/db/client';

// Program-Fix 8: the hosted reference rail's ONE failure mode. A signed settle
// to an all-zero account still acks with a providerRef, then the delayed
// `rail.callback` row carries status 'failed' + reason 'account_unreachable'
// (same dedupe key `railcb:<ref>`). Any other account settles as before.

const SIGNING_SECRET = 'sign-secret';
let db: Db;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: SIGNING_SECRET }, webhookSecret: 'cb' },
      whatsapp: {},
    }),
  }),
}));

import { POST, isUnreachableAccount, UNREACHABLE_REASON } from '@/app/api/partner-rail/route';

function postInstruction(body: unknown) {
  const raw = JSON.stringify(body);
  const req = new NextRequest('http://localhost/api/partner-rail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': createHmac('sha256', SIGNING_SECRET).update(raw).digest('hex') },
    body: raw,
  });
  return POST(req);
}

type Cb = { dedupe_key: string | null; delayed: boolean; payload: Record<string, unknown> };
async function railCallbacks(): Promise<Cb[]> {
  const r = (await db.execute(
    sql`SELECT dedupe_key, next_attempt_at > now() + interval '5 seconds' AS delayed, payload FROM outbox WHERE kind = 'rail.callback' ORDER BY id`,
  )) as unknown as { rows: Cb[] };
  return r.rows;
}

const settle = (reference: string, destination: string, rail = 'bank') => ({
  reference, partner_id: 'default',
  corridor: { source: 'US', destination: 'IN' },
  payout: { rail, destination },
  recipient: { name: 'Anita', phone: '919876543210' },
  amount: { source: 100, currency: 'USD', destination: 8300, destination_currency: 'INR', fx_rate: 83 },
});

// The sentinel is asserted on the string the pay page ACTUALLY composes for
// IN (account LAST): the validator accepts it (≥6 digits; HDFC0001234 is a valid IFSC).
const composed = validatePayoutFields('IN', { accountNumber: '000000000000', ifsc: 'HDFC0001234' });
const ZERO_DEST = composed.ok ? composed.payoutDestination : '';

beforeEach(async () => { db = await freshDb(); });

describe('partner-rail — the all-zero-account failure mode (fix 8)', () => {
  it('the IN validator accepts the sentinel and composes the account LAST', () => {
    expect(composed.ok).toBe(true);
    expect(ZERO_DEST).toBe('HDFC0001234 000000000000');
    expect(isUnreachableAccount(ZERO_DEST)).toBe(true);
  });

  it('a signed settle to the sentinel account ACKS with a providerRef and queues a delayed failed/account_unreachable callback under railcb:<ref>', async () => {
    const res = await postInstruction(settle('zz_t1', ZERO_DEST));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, providerRef: 'simrail-zz_t1' });
    const cbs = await railCallbacks();
    expect(cbs).toHaveLength(1);
    expect(cbs[0].dedupe_key).toBe('railcb:zz_t1');
    expect(cbs[0].delayed).toBe(true);
    expect(cbs[0].payload).toEqual({ reference: 'zz_t1', partner_id: 'default', status: 'failed', reason: UNREACHABLE_REASON });
  });

  it('any other account is unchanged: the callback payload carries no status (the worker defaults to paid_out)', async () => {
    expect((await postInstruction(settle('ok_t1', 'HDFC0001234 123456789012'))).status).toBe(200);
    const cbs = await railCallbacks();
    expect(cbs).toHaveLength(1);
    expect(cbs[0].payload).toEqual({ reference: 'ok_t1', partner_id: 'default' });
  });

  it('isUnreachableAccount: only the LAST digit run counts, ≥6 zeros, strings only; a USDC address is never a sentinel', async () => {
    expect(isUnreachableAccount('000000000 12345678')).toBe(false); // routing zeros, real account
    expect(isUnreachableAccount('HDFC0001234 00000')).toBe(false);  // 5 zeros
    expect(isUnreachableAccount('0000000')).toBe(true);
    expect(isUnreachableAccount('')).toBe(false);
    expect(isUnreachableAccount(undefined)).toBe(false);
    expect(isUnreachableAccount(42)).toBe(false);
    // A USDC wallet ending in zeros settles normally (rail-gated, not string-gated).
    expect((await postInstruction(settle('u_t1', '0x8ba1f109551bD432803012645Ac136ddd000000', 'usdc'))).status).toBe(200);
    expect((await railCallbacks())[0].payload).toEqual({ reference: 'u_t1', partner_id: 'default' });
  });

  it('a UPI VPA that happens to start with zeros (000000@ybl) is NOT a sentinel: only the bank rail has an account number', async () => {
    expect((await postInstruction(settle('upi_t1', '000000@ybl', 'upi'))).status).toBe(200);
    expect((await railCallbacks())[0].payload).toEqual({ reference: 'upi_t1', partner_id: 'default' });
  });

  it('a reverse instruction never schedules a callback, sentinel or not', async () => {
    const res = await postInstruction({ reference: 'reverse-zz_t1', partner_id: 'default', action: 'reverse', payout: { rail: 'bank', destination: ZERO_DEST } });
    expect(res.status).toBe(200);
    expect(await railCallbacks()).toHaveLength(0);
  });
});
