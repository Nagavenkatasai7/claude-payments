import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  PLATFORM_SEND_LIMITS,
  SEND_LIMIT_HARD_CEILING_CENTS,
  resolveEffectiveSendLimits,
  quoteCeilingUsd,
  validateSendLimitInput,
  SendBusyError,
  SendCapError,
} from '@/lib/send-limits';
import { MAX_USD } from '@/lib/fx';
import { T0_DAILY_CAP_CENTS, T1_DAILY_CAP_CENTS } from '@/lib/tier-rules';
import type { Partner, SendLimitOverride } from '@/lib/types';

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

// ── Program fix 16b (Task 10b): the audited raise — precedence, ceiling, expiry ──
const CUSTOMER_NONE = null;

describe('SEND_LIMIT_HARD_CEILING_CENTS (16b test 2: the ceiling)', () => {
  it('is $10,000 in code, frozen, and never an env variable', () => {
    expect(SEND_LIMIT_HARD_CEILING_CENTS).toBe(1_000_000);
    // git grep exits 1 on "no match" — that is the pass.
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', 'SEND_LIMIT', '--', '.env.example', 'src/lib/env.ts'], {
        cwd: process.cwd(), encoding: 'utf8',
      });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    expect(out.trim()).toBe('');
  });
});

describe('resolveEffectiveSendLimits (16b test 1: precedence per field)', () => {
  const now = new Date();

  it('no partner / no customer / no overrides ⇒ the platform ladder, sourced "platform"', () => {
    for (const r of [
      resolveEffectiveSendLimits(null, CUSTOMER_NONE, now),
      resolveEffectiveSendLimits(undefined, undefined, now),
      resolveEffectiveSendLimits(partner(), { }, now),
    ]) {
      expect(r).toMatchObject(PLATFORM_SEND_LIMITS);
      expect(r.source).toEqual({ perTransferCapCents: 'platform', t1DailyCapCents: 'platform', t0DailyCapCents: 'platform' });
    }
  });

  it('customer $7,000 beats partner $5,000 beats platform $2,999; clearing walks down the ladder', () => {
    const p = partner({ perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });
    const c = { sendLimitOverride: { perTransferCapCents: 700_000, t1DailyCapCents: 700_000 } };
    const withCustomer = resolveEffectiveSendLimits(p, c, now);
    expect(withCustomer.perTransferCapCents).toBe(700_000);
    expect(withCustomer.t1DailyCapCents).toBe(700_000);
    expect(withCustomer.maxUsd).toBe(7000);
    expect(withCustomer.source.perTransferCapCents).toBe('customer');
    expect(withCustomer.source.t1DailyCapCents).toBe('customer');

    const cleared = resolveEffectiveSendLimits(p, { sendLimitOverride: undefined }, now);
    expect(cleared.perTransferCapCents).toBe(500_000);
    expect(cleared.maxUsd).toBe(5000);
    expect(cleared.source.perTransferCapCents).toBe('partner');

    const both = resolveEffectiveSendLimits(partner(), CUSTOMER_NONE, now);
    expect(both.perTransferCapCents).toBe(299_900);
    expect(both.maxUsd).toBe(2999);
    expect(both.source.perTransferCapCents).toBe('platform');
  });

  it('a PARTIAL customer override (per-transfer only) takes T1 from the partner', () => {
    const p = partner({ t1DailyCapCents: 500_000 });
    const c = { sendLimitOverride: { perTransferCapCents: 400_000 } };
    const r = resolveEffectiveSendLimits(p, c, now);
    expect(r.perTransferCapCents).toBe(400_000);
    expect(r.source.perTransferCapCents).toBe('customer');
    expect(r.t1DailyCapCents).toBe(500_000);
    expect(r.source.t1DailyCapCents).toBe('partner');
    expect(r.t0DailyCapCents).toBe(50_000);
    expect(r.source.t0DailyCapCents).toBe('platform');
  });

  it('a value planted at $50,000 resolves to the $10,000 ceiling (clamped at read)', () => {
    const c = { sendLimitOverride: { perTransferCapCents: 5_000_000, t1DailyCapCents: 5_000_000 } };
    const r = resolveEffectiveSendLimits(partner(), c, now);
    expect(r.perTransferCapCents).toBe(1_000_000);
    expect(r.t1DailyCapCents).toBe(1_000_000);
    expect(r.maxUsd).toBe(10_000);
    const p = partner({ perTransferCapCents: 5_000_000, t1DailyCapCents: 5_000_000 });
    expect(resolveEffectiveSendLimits(p, CUSTOMER_NONE, now).t1DailyCapCents).toBe(1_000_000);
  });

  it('T0 stays tighten-only: a partner T0 of $200 applies, $800 clamps to the platform $500', () => {
    expect(resolveEffectiveSendLimits(partner({ t0DailyCapCents: 20_000 }), CUSTOMER_NONE, now).t0DailyCapCents).toBe(20_000);
    expect(resolveEffectiveSendLimits(partner({ t0DailyCapCents: 80_000 }), CUSTOMER_NONE, now).t0DailyCapCents).toBe(50_000);
    // A customer override never carries T0 (the tier gate is never raised per customer).
    const c = { sendLimitOverride: { t0DailyCapCents: 90_000, perTransferCapCents: 400_000 } as unknown as SendLimitOverride };
    expect(resolveEffectiveSendLimits(partner(), c, now).t0DailyCapCents).toBe(50_000);
  });

  it('garbage / non-positive / non-integer values fall through to the NEXT level, never to zero', () => {
    const p = partner({ perTransferCapCents: 400_000, t1DailyCapCents: 400_000 });
    const c = { sendLimitOverride: { perTransferCapCents: -5, t1DailyCapCents: 12.5 } as unknown as SendLimitOverride };
    const r = resolveEffectiveSendLimits(p, c, now);
    expect(r.perTransferCapCents).toBe(400_000);
    expect(r.source.perTransferCapCents).toBe('partner');
    expect(r.t1DailyCapCents).toBe(400_000);
    const strings = { sendLimitOverride: { perTransferCapCents: '700000' } as unknown as SendLimitOverride };
    expect(resolveEffectiveSendLimits(partner(), strings, now)).toMatchObject(PLATFORM_SEND_LIMITS);
    const notAnObject = { sendLimitOverride: 'raise' as unknown as SendLimitOverride };
    expect(resolveEffectiveSendLimits(partner('tight' as unknown as Partner['sendLimits']), notAnObject, now)).toMatchObject(PLATFORM_SEND_LIMITS);
  });

  it('a tightening below the platform is still honored at both levels', () => {
    const r = resolveEffectiveSendLimits(partner({ perTransferCapCents: 100_000 }), { sendLimitOverride: { t1DailyCapCents: 150_000 } }, now);
    expect(r.perTransferCapCents).toBe(100_000);
    expect(r.t1DailyCapCents).toBe(150_000);
    expect(r.maxUsd).toBe(1000);
  });

  it('never returns the frozen platform object itself, and never mutates it', () => {
    const r = resolveEffectiveSendLimits(null, null, now);
    expect(r).not.toBe(PLATFORM_SEND_LIMITS);
    expect(PLATFORM_SEND_LIMITS.perTransferCapCents).toBe(299_900);
    expect(Object.isFrozen(PLATFORM_SEND_LIMITS)).toBe(true);
  });
});

describe('quoteCeilingUsd (16b: the ceiling a quote() caller passes)', () => {
  it('never sits below the platform MAX_USD (a tightening stays a structured cap refusal); a raise lifts it', () => {
    const now = new Date();
    expect(quoteCeilingUsd(resolveEffectiveSendLimits(null, null, now))).toBe(2999);
    expect(quoteCeilingUsd(resolveEffectiveSendLimits(partner({ perTransferCapCents: 10_000 }), null, now))).toBe(2999);
    expect(quoteCeilingUsd(resolveEffectiveSendLimits(null, { sendLimitOverride: { perTransferCapCents: 500_000 } }, now))).toBe(5000);
    expect(quoteCeilingUsd(resolveEffectiveSendLimits(null, { sendLimitOverride: { perTransferCapCents: 5_000_000 } }, now))).toBe(10_000);
  });
});

describe('resolveEffectiveSendLimits (16b test 3: expiry lapses at read)', () => {
  it('a customer override expiring tomorrow applies today and lapses AT the expiry instant, falling back to the partner', () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();
    const p = partner({ perTransferCapCents: 500_000, t1DailyCapCents: 500_000 });
    const c = { sendLimitOverride: { perTransferCapCents: 700_000, t1DailyCapCents: 700_000, expiresAt: tomorrow } };
    expect(resolveEffectiveSendLimits(p, c, now).perTransferCapCents).toBe(700_000);
    const atExpiry = resolveEffectiveSendLimits(p, c, new Date(tomorrow));
    expect(atExpiry.perTransferCapCents).toBe(500_000);
    expect(atExpiry.t1DailyCapCents).toBe(500_000);
    expect(atExpiry.source.perTransferCapCents).toBe('partner');
    // An expired entry is skipped AS A WHOLE (its unexpired-looking sibling fields too).
    const partial = { sendLimitOverride: { perTransferCapCents: 700_000, expiresAt: tomorrow } };
    expect(resolveEffectiveSendLimits(p, partial, new Date(tomorrow)).perTransferCapCents).toBe(500_000);
  });

  it('an expired PARTNER default lapses too; a customer override outlives it', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
    const p = partner({ perTransferCapCents: 500_000, expiresAt: yesterday });
    expect(resolveEffectiveSendLimits(p, null, now)).toMatchObject(PLATFORM_SEND_LIMITS);
    const c = { sendLimitOverride: { perTransferCapCents: 400_000 } };
    expect(resolveEffectiveSendLimits(p, c, now).perTransferCapCents).toBe(400_000);
  });
});

describe('validateSendLimitInput (16b: the edge check)', () => {
  const now = new Date();
  const form = (v: Record<string, string>) => ({
    perTransferUsd: v.perTransferUsd ?? '',
    t1DailyUsd: v.t1DailyUsd ?? '',
    t0DailyUsd: v.t0DailyUsd ?? '',
    expiresAt: v.expiresAt ?? '',
    reason: v.reason ?? '',
    clear: v.clear === 'on',
  });

  it('a missing / blank reason is refused FIRST, before anything else is inspected', () => {
    expect(() => validateSendLimitInput(form({ perTransferUsd: '5000', t1DailyUsd: '5000' }), now)).toThrow('A reason is required.');
    expect(() => validateSendLimitInput(form({ perTransferUsd: 'garbage', reason: '   ' }), now)).toThrow('A reason is required.');
    expect(() => validateSendLimitInput(form({ clear: 'on' }), now)).toThrow('A reason is required.');
  });

  it('the reason is bounded: control characters stripped, whitespace collapsed, at most 200 characters', () => {
    const r = validateSendLimitInput(form({ perTransferUsd: '5000', t1DailyUsd: '5000', reason: '  QA\u0000 large\r\n amount \ttest  ' }), now);
    expect(r.reason).toBe('QA large amount test');
    expect(() => validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'x'.repeat(201) }), now)).toThrow(/200/);
    expect(validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'x'.repeat(200) }), now).reason).toHaveLength(200);
  });

  it('whole USD, > 0, <= $10,000: $10,001, $0, -1, 12.5 and "abc" are refused', () => {
    for (const bad of ['10001', '0', '-1', '12.5', 'abc', '1e3']) {
      expect(() => validateSendLimitInput(form({ perTransferUsd: bad, reason: 'r' }), now)).toThrow(/whole dollar amount between \$1 and \$10,000/);
      expect(() => validateSendLimitInput(form({ t1DailyUsd: bad, reason: 'r' }), now)).toThrow(/whole dollar amount between \$1 and \$10,000/);
    }
    expect(validateSendLimitInput(form({ perTransferUsd: '10000', reason: 'r' }), now).value).toEqual({ perTransferCapCents: 1_000_000 });
    expect(validateSendLimitInput(form({ perTransferUsd: '1', reason: 'r' }), now).value).toEqual({ perTransferCapCents: 100 });
  });

  it('T0 is tighten-only: at most the platform $500, and only when the caller allows the field', () => {
    expect(validateSendLimitInput(form({ t0DailyUsd: '200', reason: 'r' }), now, { allowT0: true }).value).toEqual({ t0DailyCapCents: 20_000 });
    expect(() => validateSendLimitInput(form({ t0DailyUsd: '800', reason: 'r' }), now, { allowT0: true })).toThrow(/between \$1 and \$500/);
    // A customer form never carries T0 — a posted value is ignored, not applied.
    expect(validateSendLimitInput(form({ perTransferUsd: '5000', t0DailyUsd: '200', reason: 'r' }), now).value).toEqual({ perTransferCapCents: 500_000 });
  });

  it('at least one limit is required unless clearing; clear=on yields null and ignores the figures', () => {
    expect(() => validateSendLimitInput(form({ reason: 'r' }), now)).toThrow('Enter at least one limit.');
    const cleared = validateSendLimitInput(form({ clear: 'on', perTransferUsd: '10001', reason: 'lapse' }), now);
    expect(cleared.value).toBeNull();
    expect(cleared.reason).toBe('lapse');
    expect(cleared.expiresAt).toBeUndefined();
  });

  it('expiry: a past instant is refused; a date-only value means the END of that day (UTC); a future ISO instant is kept', () => {
    const yesterday = new Date(now.getTime() - 86_400_000);
    expect(() => validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'r', expiresAt: yesterday.toISOString() }), now)).toThrow('Expiry must be in the future.');
    expect(() => validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'r', expiresAt: yesterday.toISOString().slice(0, 10) }), now)).toThrow('Expiry must be in the future.');
    expect(() => validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'r', expiresAt: 'not-a-date' }), now)).toThrow('Expiry must be a valid date.');
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const dateOnly = validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'r', expiresAt: tomorrow.toISOString().slice(0, 10) }), now);
    expect(dateOnly.expiresAt).toBe(`${tomorrow.toISOString().slice(0, 10)}T23:59:59.999Z`);
    expect(dateOnly.value).toEqual({ perTransferCapCents: 500_000, expiresAt: dateOnly.expiresAt });
    const iso = validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'r', expiresAt: tomorrow.toISOString() }), now);
    expect(iso.expiresAt).toBe(tomorrow.toISOString());
    // Today's date, entered late in the day, is still "in the future" until the end of the UTC day.
    const today = now.toISOString().slice(0, 10);
    const endOfToday = Date.parse(`${today}T23:59:59.999Z`);
    if (endOfToday > now.getTime()) {
      expect(validateSendLimitInput(form({ perTransferUsd: '5000', reason: 'r', expiresAt: today }), now).expiresAt).toBe(`${today}T23:59:59.999Z`);
    }
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
