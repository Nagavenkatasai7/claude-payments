import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { blindIndex } from '@/lib/blind-index';

/**
 * joinWaitlistAction — the PUBLIC "Join waitlist" server action. Same seams
 * as tests/partners-action.test.ts: getDb → PGlite, getRedis → fakeRedis,
 * next/headers + next/navigation stubbed. redirect() throws by design, so
 * every call is asserted through `.rejects` with the destination.
 */

let db: Db;
const redis = fakeRedis();
let redisImpl = redis; // swapped for a broken client in the fail-open test
const redirectMock = vi.fn((p: string): never => {
  throw new Error(`REDIRECT:${p}`);
});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }),
}));
vi.mock('@/db/client', async (orig) => ({
  ...((await orig()) as object),
  getDb: () => db,
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redisImpl }));

import { joinWaitlistAction } from '@/app/waitlist-action';

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x));
    else f.set(k, v);
  }
  return f;
}

type Raw = Record<string, string | null>;
async function rows(): Promise<Raw[]> {
  const res = await db.execute(sql`SELECT * FROM waitlist_signups ORDER BY created_at, id`);
  return (res as unknown as { rows: Raw[] }).rows;
}

const VALID = {
  full_name: 'Asha Patel',
  email: 'Asha.Patel@Example.com',
  phone: '+1 (555) 123-4567',
  location: 'Fairfax, VA',
  destinations: ['IN', 'MX'],
  consent: 'yes',
  utm_source: 'newsletter',
  utm_campaign: 'sept',
};

const OK = 'REDIRECT:/?waitlist=ok#waitlist';
const ERR = 'REDIRECT:/?waitlist=err#waitlist';

beforeEach(async () => {
  db = await freshDb();
  redis.dump.clear();
  redirectMock.mockClear();
  errorSpy.mockClear();
  warnSpy.mockClear();
});

describe('joinWaitlistAction', () => {
  it('persists an encrypted, consented row with normalised identity + utm, then redirects ok', async () => {
    await expect(joinWaitlistAction(form(VALID))).rejects.toThrow(OK);
    const all = await rows();
    expect(all).toHaveLength(1);
    const r = all[0];
    expect(r.id).toMatch(/^wl_/);
    expect(r.email_bidx).toBe(blindIndex('email', 'asha.patel@example.com'));
    expect(r.phone_bidx).toBe(blindIndex('phone', '+15551234567'));
    expect(r.email_masked).toBe('a***@example.com');
    expect(r.phone_last4).toBe('4567');
    expect(r.name_initial).toBe('A.');
    expect(r.destinations).toEqual(['IN', 'MX']);
    expect(r.consent_text_version).toBe('v1');
    expect(r.consent_at).toBeTruthy();
    expect(r.utm_source).toBe('newsletter');
    expect(r.utm_campaign).toBe('sept');
    // Raw row: no plaintext PII anywhere.
    const dump = JSON.stringify(r);
    expect(dump).not.toMatch(/Asha|asha\.patel|15551234567|Fairfax/);
  });

  it('never logs PII: nothing reaches console on the happy path', async () => {
    await expect(joinWaitlistAction(form(VALID))).rejects.toThrow(OK);
    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(logged).not.toMatch(/Asha|asha\.patel|5551234567/);
  });

  it('honeypot: a filled "website" field looks ok but persists nothing', async () => {
    await expect(joinWaitlistAction(form({ ...VALID, website: 'http://spam.example' }))).rejects.toThrow(OK);
    expect(await rows()).toHaveLength(0);
  });

  it.each([
    ['bad email', { email: 'nope' }],
    ['bad phone', { phone: '12-34' }],
    ['no destinations', { destinations: [] }],
    ['unknown destinations only', { destinations: ['XX', 'Other'] }],
    ['no consent', { consent: '' }],
    ['consent=no', { consent: 'no' }],
    ['consent=on (a forged value, not the checkbox value)', { consent: 'on' }],
    ['phone with a 00 international prefix', { phone: '0044 7911 123456' }],
    ['no location', { location: '' }],
    ['short name', { full_name: 'A' }],
  ])('rejects %s with ?waitlist=err and persists nothing', async (_l, over) => {
    await expect(joinWaitlistAction(form({ ...VALID, ...over }))).rejects.toThrow(ERR);
    expect(await rows()).toHaveLength(0);
  });

  it('dedupes "+1 (571) 555-0123" against a later bare "5715550123" (ok, one row)', async () => {
    await expect(joinWaitlistAction(form({ ...VALID, phone: '+1 (571) 555-0123' }))).rejects.toThrow(OK);
    await expect(
      joinWaitlistAction(form({ ...VALID, email: 'other@example.com', phone: '5715550123' })),
    ).rejects.toThrow(OK);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].phone_bidx).toBe(blindIndex('phone', '+15715550123'));
  });

  it('dedupes silently on the same email in a different case/whitespace (ok, one row)', async () => {
    await expect(joinWaitlistAction(form(VALID))).rejects.toThrow(OK);
    await expect(
      joinWaitlistAction(form({ ...VALID, email: '  ASHA.PATEL@example.COM ', phone: '+1 555 999 0000' })),
    ).rejects.toThrow(OK);
    expect(await rows()).toHaveLength(1);
  });

  it('dedupes silently on the same phone in a different format (ok, one row)', async () => {
    await expect(joinWaitlistAction(form(VALID))).rejects.toThrow(OK);
    await expect(
      joinWaitlistAction(form({ ...VALID, email: 'other@example.com', phone: '555-123-4567' })), // 10 digits ⇒ +1
    ).rejects.toThrow(OK);
    await expect(
      joinWaitlistAction(form({ ...VALID, email: 'third@example.com', phone: '15551234567' })),
    ).rejects.toThrow(OK);
    expect(await rows()).toHaveLength(1);
  });

  it('rate-limits after 5 signups from one IP in the window (6th → ?waitlist=rate)', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        joinWaitlistAction(form({ ...VALID, email: `p${i}@example.com`, phone: `+1555000000${i}` })),
      ).rejects.toThrow(OK);
    }
    await expect(joinWaitlistAction(form({ ...VALID, email: 'p9@example.com', phone: '+15550000009' }))).rejects.toThrow(
      'REDIRECT:/?waitlist=rate#waitlist',
    );
    expect(await rows()).toHaveLength(5);
  });

  it('rate limiter FAILS OPEN: a limiter error never blocks a signup', async () => {
    redisImpl = { ...redis, incr: async () => { throw new Error('redis down'); } } as typeof redis;
    try {
      await expect(joinWaitlistAction(form(VALID))).rejects.toThrow(OK);
      expect(await rows()).toHaveLength(1);
    } finally {
      redisImpl = redis;
    }
  });
});
