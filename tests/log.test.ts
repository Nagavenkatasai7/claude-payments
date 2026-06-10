import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrub, logError, logWarn } from '@/lib/log';

afterEach(() => vi.restoreAllMocks());

describe('scrub — the PII backstop for money-path logs', () => {
  it('masks phone numbers and account numbers to last-4', () => {
    expect(scrub('sender 15551234567 paid')).toBe('sender …4567 paid');
    expect(scrub('account 123456789012 ifsc HDFC0001234')).toBe('account …9012 ifsc HDFC…1234');
  });

  it('masks emails entirely', () => {
    expect(scrub('user maria.lopez+x@example.com failed')).toBe('user <email> failed');
  });

  it('leaves dates, times, short numbers AND 6-digit provider error codes alone', () => {
    expect(scrub('at 2026-06-09T10:30:00Z attempt 3 code 503')).toBe(
      'at 2026-06-09T10:30:00Z attempt 3 code 503',
    );
    // Meta delivery-failure codes are 6 digits — ops needs them readable.
    expect(scrub('delivery failed code=131056')).toBe('delivery failed code=131056');
  });

  it('stringifies Errors and objects before scrubbing', () => {
    expect(scrub(new Error('rail rejected 123456789012'))).toBe('Error: rail rejected …9012');
    expect(scrub({ phone: '15551234567' })).toBe('{"phone":"…4567"}');
  });
});

describe('logError / logWarn — one scrubbed JSON line', () => {
  it('emits structured JSON with scrubbed message AND fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('pay.route', new Error('charge failed for 15551234567'), { phone: '15551234567' });
    const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, string>;
    expect(line.level).toBe('error');
    expect(line.scope).toBe('pay.route');
    expect(line.msg).toContain('…4567');
    expect(line.phone).toBe('…4567');
    expect(JSON.stringify(line)).not.toContain('15551234567');
  });

  it('logWarn goes to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWarn('whatsapp.delivery_failed', 'code=131056', { recipient: '919876543210' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0] as string).not.toContain('919876543210');
  });
});
