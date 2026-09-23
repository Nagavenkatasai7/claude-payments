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

// Program-Fix 47 — bound the scrubber's work on input the app does not control
// (provider error bodies). Two layers: the email pattern is bounded with
// non-overlapping labels and anchored to the start of a token, and scrub()
// caps its input at 8 KB, cut back to a boundary that cannot split a phone
// number or an email, with a visible marker.
describe('scrub — bounded work on hostile input (Program-Fix 47)', () => {
  const MAX = 8 * 1024;
  const time = (s: string) => {
    const t = performance.now();
    const out = scrub(s);
    return { out, ms: performance.now() - t };
  };

  it('pathological inputs of 8 KB or less aimed at the email pattern finish fast', () => {
    // Generous bound for a loaded CI runner; the bounded pattern takes well
    // under 1 ms on each of these locally.
    for (const s of [
      'a@' + 'a-'.repeat(2000) + '.',
      'a'.repeat(4000) + '@',
      'a@' + 'a.'.repeat(4000),
      'a@' + '.'.repeat(8000),
      'a@' + 'a'.repeat(8000),
    ]) {
      expect(s.length).toBeLessThanOrEqual(MAX);
      expect(time(s).ms).toBeLessThan(1000);
    }
  });

  it('a large hostile body is cut to 8 KB, finishes fast, and says it was cut', () => {
    const { out, ms } = time('a@' + 'a.'.repeat(50_000));
    expect(ms).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(MAX + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('input at or under 8 KB is not cut and gets no marker', () => {
    const s = 'x'.repeat(MAX);
    expect(scrub(s)).toBe(s);
  });

  it('a 7+ digit number straddling the cut is dropped, never partly exposed', () => {
    for (let pad = 1; pad <= 11; pad++) {
      // The number starts `pad` characters before the 8 KB mark.
      const s = 'y'.repeat(MAX - pad - 1) + ' ' + '15551234567' + ' tail';
      const out = scrub(s);
      expect(out.endsWith('…[truncated]')).toBe(true);
      expect(out).not.toMatch(/\d/);
    }
  });

  it('an email straddling the cut is dropped, never left half-unmasked', () => {
    const email = 'maria.lopez@example.com';
    for (let pad = 1; pad <= email.length; pad++) {
      const s = 'y'.repeat(MAX - pad - 1) + ' ' + email + ' tail';
      const out = scrub(s);
      expect(out.endsWith('…[truncated]')).toBe(true);
      expect(out).not.toContain('maria');
      expect(out).not.toContain('@');
    }
  });

  it('masks the whole local part, not just its last 64 characters', () => {
    // Without the token-start anchor a bounded {1,64} local part would match
    // only the tail of a longer one and leave the head in the log.
    expect(scrub(`id ${'b'.repeat(64)}@example.com x`)).toBe('id <email> x');
    const long = `${'c'.repeat(10)}${'b'.repeat(64)}@example.com`;
    expect(scrub(`id ${long} x`)).not.toContain('<email>');
    // RFC 5321 caps a local part at 64 octets, so a 65+ char one is not a real
    // address; it is left as-is rather than half-masked.
    expect(scrub(`id ${long} x`)).toBe(`id ${long} x`);
  });

  it('still masks ordinary and multi-label addresses', () => {
    expect(scrub('to a.b+c@mail.example.co.uk, cc x_y@ex-ample.io')).toBe('to <email>, cc <email>');
  });
});
