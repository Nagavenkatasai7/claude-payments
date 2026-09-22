import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  PLATFORM_SEND_LIMITS,
  resolveSendLimits,
  SendBusyError,
  SendCapError,
} from '@/lib/send-limits';
import { MAX_USD } from '@/lib/fx';
import { T0_DAILY_CAP_CENTS, T1_DAILY_CAP_CENTS } from '@/lib/tier-rules';
import type { Partner } from '@/lib/types';

// Program fix 16 (Task 10): the platform ladder is the one before #234 —
// T0 $500/day, T1 $2,999/day, $2,999 per transfer, MAX_USD 2999 — and there
// is NO env override (large-amount testing is fix 16b's audited admin raise).

function partner(sendLimits?: Partner['sendLimits']): Partner {
  return {
    id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...(sendLimits ? { sendLimits } : {}),
  };
}

describe('PLATFORM_SEND_LIMITS (test 1: the ladder)', () => {
  it('is 50_000 / 299_900 / 299_900 / 2999 and frozen', () => {
    expect(PLATFORM_SEND_LIMITS).toEqual({
      t0DailyCapCents: 50_000,
      t1DailyCapCents: 299_900,
      perTransferCapCents: 299_900,
      maxUsd: 2999,
    });
    expect(Object.isFrozen(PLATFORM_SEND_LIMITS)).toBe(true);
  });

  it('tier-rules and fx derive from the ladder (one source of truth)', () => {
    expect(T0_DAILY_CAP_CENTS).toBe(PLATFORM_SEND_LIMITS.t0DailyCapCents);
    expect(T1_DAILY_CAP_CENTS).toBe(PLATFORM_SEND_LIMITS.t1DailyCapCents);
    expect(MAX_USD).toBe(PLATFORM_SEND_LIMITS.maxUsd);
  });

  it('no test override and no $999,999 constant survives in src', () => {
    // git grep exits 1 on "no match" — that is the pass.
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', 'SEND_CAP_TEST_OVERRIDE\\|999999\\|99_999_900', '--', 'src'], {
        cwd: process.cwd(), encoding: 'utf8',
      });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    expect(out.trim()).toBe('');
  });
});

describe('resolveSendLimits (test 2: a partner can only tighten)', () => {
  it('no partner / no override ⇒ the platform ladder', () => {
    expect(resolveSendLimits(null)).toEqual(PLATFORM_SEND_LIMITS);
    expect(resolveSendLimits(undefined)).toEqual(PLATFORM_SEND_LIMITS);
    expect(resolveSendLimits(partner())).toEqual(PLATFORM_SEND_LIMITS);
  });

  it('a lower per-transfer cap is honored; a HIGHER T1 cap is clamped to the platform', () => {
    const r = resolveSendLimits(partner({ perTransferCapCents: 100_000, t1DailyCapCents: 900_000 }));
    expect(r.perTransferCapCents).toBe(100_000);
    expect(r.t1DailyCapCents).toBe(299_900);
    expect(r.t0DailyCapCents).toBe(50_000);
    // The quote ceiling follows the tightened per-transfer cap.
    expect(r.maxUsd).toBe(1000);
  });

  it('a tighter T0 cap is honored and never above the platform T0', () => {
    expect(resolveSendLimits(partner({ t0DailyCapCents: 20_000 })).t0DailyCapCents).toBe(20_000);
    expect(resolveSendLimits(partner({ t0DailyCapCents: 80_000 })).t0DailyCapCents).toBe(50_000);
  });

  it('garbage and non-positive values fall back to the platform value', () => {
    const garbage = {
      perTransferCapCents: -5,
      t1DailyCapCents: 0,
      t0DailyCapCents: 12.5,
    } as unknown as Partner['sendLimits'];
    expect(resolveSendLimits(partner(garbage))).toEqual(PLATFORM_SEND_LIMITS);
    const strings = { perTransferCapCents: '100000', t1DailyCapCents: NaN } as unknown as Partner['sendLimits'];
    expect(resolveSendLimits(partner(strings))).toEqual(PLATFORM_SEND_LIMITS);
    const notAnObject = 'tight' as unknown as Partner['sendLimits'];
    expect(resolveSendLimits(partner(notAnObject))).toEqual(PLATFORM_SEND_LIMITS);
  });

  it('an expired override is ignored (fix 16b stores expiresAt; fix 16 already honors it)', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const expired = partner({ perTransferCapCents: 100_000, expiresAt: '2026-06-01T00:00:00.000Z' });
    expect(resolveSendLimits(expired, now)).toEqual(PLATFORM_SEND_LIMITS);
    const live = partner({ perTransferCapCents: 100_000, expiresAt: '2026-07-01T00:00:00.000Z' });
    expect(resolveSendLimits(live, now).perTransferCapCents).toBe(100_000);
  });

  it('never returns the frozen platform object itself, and never mutates it', () => {
    const r = resolveSendLimits(partner({ perTransferCapCents: 100_000 }));
    expect(r).not.toBe(PLATFORM_SEND_LIMITS);
    expect(PLATFORM_SEND_LIMITS.perTransferCapCents).toBe(299_900);
  });
});

describe('SendCapError / SendBusyError', () => {
  it('SendCapError carries the evaluation and a constant message (no figures)', () => {
    const ev = {
      withinCap: false as const, tier: 'T0' as const, dailyCapCents: 50_000, perTransferCapCents: 50_000,
      todayUsedCents: 45_000, todayRemainingCents: 5_000, reason: 'over_daily_cap' as const, dayOfWindow: 1,
    };
    const e = new SendCapError(ev);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('SendCapError');
    expect(e.message).toBe('send_cap_exceeded');
    expect(e.evaluation).toBe(ev);
  });

  it('SendBusyError is a retryable, constant-message error', () => {
    const e = new SendBusyError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('SendBusyError');
    expect(e.message).toBe('send_busy');
    expect(e.retryable).toBe(true);
  });
});
