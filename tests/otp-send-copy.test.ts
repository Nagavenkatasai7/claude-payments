import { describe, it, expect } from 'vitest';
import {
  otpRequestErrorMessage, OTP_SEND_FAILED_MESSAGE, OTP_LOCKED_MESSAGE, OTP_RETRY_MESSAGE,
  OTP_RATE_EXPIRED_MESSAGE, OTP_RATE_EXPIRED_PAYMENT_PENDING_MESSAGE, OTP_FX_UNAVAILABLE_MESSAGE,
} from '@/lib/otp-send-copy';
import {
  PAY_FX_UNAVAILABLE_COPY, PAY_RATE_EXPIRED_COPY, PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY,
} from '@/lib/pay-outcome';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Program-Fix 25 PR B (§3.6): what the three OTP forms show when a code request
// is refused. Pure, so the forms (not unit-tested) share one tested mapping.
describe('otpRequestErrorMessage', () => {
  it('otp_send_failed → the "message us first, then Resend" guidance', () => {
    expect(OTP_SEND_FAILED_MESSAGE).toBe("We couldn't send the code to WhatsApp. Message us on WhatsApp first, then tap Resend.");
    expect(otpRequestErrorMessage('otp_send_failed')).toBe(OTP_SEND_FAILED_MESSAGE);
  });
  it('locked → the too-many-codes line', () => {
    expect(otpRequestErrorMessage('locked')).toBe(OTP_LOCKED_MESSAGE);
  });
  it('anything else (a limiter 429 with no reason, a 5xx) → a generic retry line', () => {
    expect(otpRequestErrorMessage(undefined)).toBe(OTP_RETRY_MESSAGE);
    expect(otpRequestErrorMessage('nope')).toBe(OTP_RETRY_MESSAGE);
    expect(otpRequestErrorMessage(42)).toBe(OTP_RETRY_MESSAGE);
  });
});

// Step 0 FX-2 (B4): the pay route refuses a stale rate on the code REQUEST,
// so the code button must show the rate copy, not "try again in a moment".
describe('otpRequestErrorMessage — Step 0 rate refusals', () => {
  it('maps the three rate reasons to the pay-outcome copy (strings duplicated, pinned equal)', () => {
    expect(otpRequestErrorMessage('rate_expired')).toBe(OTP_RATE_EXPIRED_MESSAGE);
    expect(otpRequestErrorMessage('rate_expired_payment_pending')).toBe(OTP_RATE_EXPIRED_PAYMENT_PENDING_MESSAGE);
    expect(otpRequestErrorMessage('fx_unavailable')).toBe(OTP_FX_UNAVAILABLE_MESSAGE);
    expect(OTP_RATE_EXPIRED_MESSAGE).toBe(PAY_RATE_EXPIRED_COPY);
    expect(OTP_RATE_EXPIRED_PAYMENT_PENDING_MESSAGE).toBe(PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY);
    expect(OTP_FX_UNAVAILABLE_MESSAGE).toBe(PAY_FX_UNAVAILABLE_COPY);
  });
  it('the module stays import-free (client components share it)', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/otp-send-copy.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
  });
});
