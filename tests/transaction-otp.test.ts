import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createTransactionOtpStore } from '@/lib/transaction-otp';

const redis = fakeRedis();
let nowMs = 1_700_000_000_000;
const store = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 123456 });
const TX = 'draft_abc';
const PHONE = '15551230000';

beforeEach(() => {
  redis.dump.clear();
  nowMs = 1_700_000_000_000;
});

describe('transaction-otp', () => {
  it('issues a 6-digit code; verifies for the SAME tx+phone; consumes on success', async () => {
    const issued = await store.issue(TX, PHONE);
    expect(issued.ok && issued.code).toBe('123456');
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true });
    // single-use: a second verify fails
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });

  it('rejects a code from a DIFFERENT transaction or a DIFFERENT phone', async () => {
    await store.issue(TX, PHONE);
    expect((await store.verify('draft_other', PHONE, '123456')).ok).toBe(false);
    expect((await store.verify(TX, '19999999999', '123456')).ok).toBe(false);
  });

  it('expires after the TTL', async () => {
    await store.issue(TX, PHONE);
    nowMs += 11 * 60 * 1000;
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });

  it('burns after 5 wrong guesses', async () => {
    await store.issue(TX, PHONE);
    for (let i = 0; i < 5; i++) await store.verify(TX, PHONE, '000000');
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false); // burned even with the right code
  });

  it('30-s resend cooldown returns ok:false without a new code', async () => {
    await store.issue(TX, PHONE);
    expect((await store.issue(TX, PHONE)).ok).toBe(false);
  });
});
