import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrub, logError, logWarn } from '@/lib/log';

afterEach(() => vi.restoreAllMocks());

describe('scrub — the PII backstop for money-path logs', () => {
  it('masks phone numbers and bare long digit runs to last-4', () => {
    expect(scrub('sender 15551234567 paid')).toBe('sender …4567 paid');
    expect(scrub('ref 123456789012 failed')).toBe('ref …9012 failed');
  });

  // R49: the inbound-redact patterns run first, so the numbers the 7-digit
  // mask cannot see (spaced card groups, 3-2-4 SSNs, PAN, IFSC, 4-4-4 Aadhaar)
  // never reach a log line either.
  it('hides account, card, SSN, PAN, IFSC, Aadhaar and IBAN numbers whole', () => {
    expect(scrub('account 123456789012 ifsc HDFC0001234')).toBe('account [account number hidden] ifsc [IFSC hidden]');
    expect(scrub('card 4111 1111 1111 1111 declined')).toBe('card [card number hidden] declined');
    expect(scrub('card 4111-1111-1111-1111')).toBe('card [card number hidden]');
    expect(scrub('ssn 123-45-6789')).toBe('ssn [SSN hidden]');
    expect(scrub('pan ABCPE1234F')).toBe('pan [PAN hidden]');
    expect(scrub('uid 2345 6789 0125')).toBe('uid [Aadhaar number hidden]');
    expect(scrub('iban GB82 WEST 1234 5698 7654 32')).toBe('iban [IBAN hidden]');
    expect(scrub(new Error('rail rejected a/c 50100123456789 IFSC SBIN0001234'))).toBe(
      'Error: rail rejected a/c [account number hidden] IFSC [IFSC hidden]',
    );
  });

  it('still keeps short numbers and 6-digit provider codes readable after the redaction pass', () => {
    expect(scrub('Meta error (#131056) for account')).toBe('Meta error (#131056) for account');
    expect(scrub('attempt 3 of 8, code 503, sent 2,500.00')).toBe('attempt 3 of 8, code 503, sent 2,500.00');
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

  it('a spaced card number straddling the cut is dropped, never partly exposed (R49)', () => {
    const card = '4111 1111 1111 1111';
    for (let pad = 1; pad <= card.length; pad++) {
      const s = 'y'.repeat(MAX - pad - 1) + ' ' + card + ' tail';
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

  it('masks the whole address however long its parts are (no half-masking, no pass-through)', () => {
    expect(scrub(`id ${'b'.repeat(64)}@example.com x`)).toBe('id <email> x');
    // A local part longer than RFC 5321's 64 is still PII in a log line.
    expect(scrub(`id ${'c'.repeat(10)}${'b'.repeat(64)}@example.com x`)).toBe('id <email> x');
    // More than 8 domain labels.
    expect(scrub(`id user@${'a.'.repeat(12)}example.com x`)).toBe('id <email> x');
    // A domain label longer than 63 characters.
    expect(scrub(`id user@${'d'.repeat(80)}.example.com x`)).toBe('id <email> x');
  });

  it('still masks ordinary and multi-label addresses', () => {
    expect(scrub('to a.b+c@mail.example.co.uk, cc x_y@ex-ample.io')).toBe('to <email>, cc <email>');
  });
});

describe('scrub — the R49 keyword filler cannot backtrack exponentially (review fix)', () => {
  it('8 KB of a/c + "nonono…" segments scrub in under 250 ms', () => {
    const seg = 'a/c' + 'no'.repeat(27) + 'x 1 ';
    const t = performance.now();
    scrub(seg.repeat(Math.ceil(8192 / seg.length)));
    expect(performance.now() - t).toBeLessThan(250);
  });
});
