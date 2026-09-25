import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
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
const pokes = vi.hoisted(() => ({ now: 0, delayed: [] as number[] }));
vi.mock('@/lib/outbox', () => ({
  pokeWorker: () => {
    pokes.now++;
  },
  pokeWorkerDelayed: (ms: number) => {
    pokes.delayed.push(ms);
  },
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: {
          signingSecret: SIGNING_SECRET,
          // fix 29: a rotation in its grace period
          previousSigningSecret: 'sign-old',
          previousSigningSecretUntil: new Date(Date.now() + 86_400_000).toISOString(),
        },
        webhookSecret: 'cb',
      },
      whatsapp: {},
    }),
  }),
}));
// fix 29: the v2 replay guard reads/writes Redis — an in-memory double here.
const railRedis = vi.hoisted(() => ({ r: null as null | import('@/lib/store').RedisLike }));
vi.mock('@/lib/redis', () => ({ getRedis: () => railRedis.r }));

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

beforeEach(async () => {
  db = await freshDb();
  railRedis.r = fakeRedis();
  pokes.now = 0;
  pokes.delayed = [];
});

// partner-demo R4: the callback row is due in SETTLE_DELAY_MS (12 s), but the
// immediate poke drains only READY rows. With the worker gate, an unmarked
// delayed row would wait for the :17/:47 backstop — and the stuck-paid sweep
// (15 min) would re-instruct it and raise a false alert. The rail therefore
// schedules a DELAYED poke (12 s + 5 s), which also marks the row due.
describe('partner-rail — delayed poke for the settle callback (partner-demo R4)', () => {
  it('a settle schedules an immediate poke AND a delayed poke at SETTLE_DELAY_MS + 5 s', async () => {
    expect((await postInstruction(settle('dp_t1', 'HDFC0001234 123456789012'))).status).toBe(200);
    expect(pokes.now).toBe(1);
    expect(pokes.delayed).toEqual([17_000]);
  });

  it('a reverse instruction queues no callback and schedules no delayed poke', async () => {
    await postInstruction({ reference: 'reverse-dp_t1', partner_id: 'default', action: 'reverse', payout: { rail: 'bank', destination: 'x' } });
    expect(pokes.delayed).toEqual([]);
  });
});

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
    expect(cbs[0].payload).toEqual({ reference: 'zz_t1', partner_id: 'default', status: 'failed', reason: UNREACHABLE_REASON, amount: { destination: 8300, destination_currency: 'INR' } });
  });

  it('any other account is unchanged: the callback payload carries no status (the worker defaults to paid_out)', async () => {
    expect((await postInstruction(settle('ok_t1', 'HDFC0001234 123456789012'))).status).toBe(200);
    const cbs = await railCallbacks();
    expect(cbs).toHaveLength(1);
    expect(cbs[0].payload).toEqual({ reference: 'ok_t1', partner_id: 'default', amount: { destination: 8300, destination_currency: 'INR' } });
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
    expect((await railCallbacks())[0].payload).toEqual({ reference: 'u_t1', partner_id: 'default', amount: { destination: 8300, destination_currency: 'INR' } });
  });

  it('a UPI VPA that happens to start with zeros (000000@ybl) is NOT a sentinel: only the bank rail has an account number', async () => {
    expect((await postInstruction(settle('upi_t1', '000000@ybl', 'upi'))).status).toBe(200);
    expect((await railCallbacks())[0].payload).toEqual({ reference: 'upi_t1', partner_id: 'default', amount: { destination: 8300, destination_currency: 'INR' } });
  });

  it('a reverse instruction never schedules a callback, sentinel or not', async () => {
    const res = await postInstruction({ reference: 'reverse-zz_t1', partner_id: 'default', action: 'reverse', payout: { rail: 'bank', destination: ZERO_DEST } });
    expect(res.status).toBe(200);
    expect(await railCallbacks()).toHaveLength(0);
  });
});

// Program-Fix 29: the reference rail verifies the timestamped header, guards
// replays, accepts the previous secret during a rotation, and echoes the amount.
describe('partner-rail — rail signature v2 (fix 29)', () => {
  const v2 = (raw: string, secret = SIGNING_SECRET, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  function postWith(body: unknown, headers: Record<string, string>) {
    const raw = JSON.stringify(body);
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace('$RAW_V2', v2(raw)).replace('$RAW_OLD', v2(raw, 'sign-old'))]));
    return POST(new NextRequest('http://localhost/api/partner-rail', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: raw,
    }));
  }

  it('a v2-only signed settle → 200 ack, and the callback row echoes the instruction amount', async () => {
    const res = await postWith(settle('v2_t1', 'HDFC0001234 123456789012'), { 'x-smartremit-signature': '$RAW_V2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, providerRef: 'simrail-v2_t1' });
    expect((await railCallbacks())[0].payload).toEqual({
      reference: 'v2_t1', partner_id: 'default', amount: { destination: 8300, destination_currency: 'INR' },
    });
  });

  it('a v1 made with the unexpired PREVIOUS signing secret verifies', async () => {
    expect((await postWith(settle('v2_t2', 'HDFC0001234 123456789012'), { 'x-smartremit-signature': '$RAW_OLD' })).status).toBe(200);
  });

  it('a bad v2 header next to a VALID legacy header → 401 (no fall-through)', async () => {
    const body = settle('v2_t3', 'HDFC0001234 123456789012');
    const raw = JSON.stringify(body);
    const res = await postWith(body, {
      'x-signature': createHmac('sha256', SIGNING_SECRET).update(raw).digest('hex'),
      'x-smartremit-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
    });
    expect(res.status).toBe(401);
    expect(await railCallbacks()).toHaveLength(0);
  });

  it('a stale v2 timestamp → 401', async () => {
    const body = settle('v2_t4', 'HDFC0001234 123456789012');
    const raw = JSON.stringify(body);
    const res = await postWith(body, { 'x-smartremit-signature': v2(raw, SIGNING_SECRET, Math.floor(Date.now() / 1000) - 3600) });
    expect(res.status).toBe(401);
  });

  it('the same v2 message twice → the second is a 200 duplicate with the same providerRef', async () => {
    const body = settle('v2_t5', 'HDFC0001234 123456789012');
    const raw = JSON.stringify(body);
    const h = { 'x-smartremit-signature': v2(raw) };
    expect((await postWith(body, h)).status).toBe(200);
    const again = await postWith(body, h);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true, providerRef: 'simrail-v2_t5' });
    expect(await railCallbacks()).toHaveLength(1);
  });

  it('an instruction with no or a malformed amount block is still accepted; the callback simply carries no amount', async () => {
    const { amount: _a, ...noAmount } = settle('v2_t6', 'HDFC0001234 123456789012');
    expect((await postWith(noAmount, { 'x-smartremit-signature': '$RAW_V2' })).status).toBe(200);
    expect((await railCallbacks())[0].payload).toEqual({ reference: 'v2_t6', partner_id: 'default' });
  });
});
