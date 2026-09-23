import { describe, it, expect } from 'vitest';
import { otpRequestErrorMessage, OTP_SEND_FAILED_MESSAGE, OTP_LOCKED_MESSAGE, OTP_RETRY_MESSAGE } from '@/lib/otp-send-copy';

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
