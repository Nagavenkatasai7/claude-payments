import { describe, it, expect, vi, afterEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { scrub, logError, logWarn, stackFrames, SCRUB_MAX_CHARS } from '@/lib/log';

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

  it('removes URL credentials whole, whatever characters the password holds', () => {
    // 2026-11-09 review of the DATABASE_URL leak: the email mask alone left
    // most of a password with URL sub-delimiters in the line.
    expect(scrub("dial postgresql://owner:ab!c*d$e'f(g)h@ep-x.example.com/db failed")).toBe(
      'dial postgresql://<redacted>@ep-x.example.com/db failed',
    );
    expect(scrub('redis rediss://default:tok_en@cache.example.com:6379 down')).toBe(
      'redis rediss://<redacted>@cache.example.com:6379 down',
    );
    // A password that holds an unescaped "@": everything up to the LAST "@" goes.
    expect(scrub('postgres://owner:p@ss@ep-x.example.com/db')).toBe('postgres://<redacted>@ep-x.example.com/db');
    // A URL with no credentials is untouched.
    expect(scrub('GET https://example.com/a?b=1 ok')).toBe('GET https://example.com/a?b=1 ok');
  });

  it('does not reach past the end of a URL host for an "@" that belongs to something else', () => {
    // The userinfo part of a URL cannot hold a quote, "?", "#" or angle bracket.
    expect(scrub('{"url":"https://api.example.com","note":"ok","to":"a@b.example"}')).toBe(
      '{"url":"https://api.example.com","note":"ok","to":"<email>"}',
    );
    expect(scrub('GET https://api.example.com?email=jane@example.com failed')).toBe(
      'GET https://api.example.com?email=<email> failed',
    );
  });

  it('removes URL credentials that the 8 KB cap cuts in half', () => {
    // The cut lands inside the password, so no "@" is left for the userinfo rule.
    const lead = 'x'.repeat(SCRUB_MAX_CHARS - 30);
    const out = scrub(`${lead} postgres://owner:Ab3!kQ9*zz7Wq${'p'.repeat(100)}@ep-x.example.com/db`);
    expect(out).not.toContain('Ab3!kQ9');
    expect(out.endsWith(' postgres://<redacted>…[truncated]')).toBe(true);
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

// 2026-11-10: a drizzle DrizzleQueryError carries the bound values (phones,
// names, emails, password hashes) in `params` and in its message, and the
// Postgres `detail` echoes key values. scrub() must drop all of them.
describe('scrub — database query errors keep no params and no detail', () => {
  const FAKES = ['+15551234567', '15551234567', '1234567', 'Ravi Traders', 'jane@example.com', 'already exists'];
  function queryError() {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "customers_phone_key"'), {
      code: '23505',
      detail: 'Key (phone)=(+15551234567) already exists.',
      constraint: 'customers_phone_key',
      table: 'customers',
    });
    return new DrizzleQueryError(
      'insert into "customers" ("phone", "name", "email") values ($1, $2, $3)',
      ['+15551234567', 'Ravi Traders', 'jane@example.com'],
      cause,
    );
  }
  const clean = (text: string) => {
    for (const v of FAKES) expect(text).not.toContain(v);
    expect(text).not.toMatch(/params: (?!<redacted>)/);
  };

  it('the error object becomes the fixed description with the SQLSTATE', () => {
    const out = scrub(queryError());
    clean(out);
    expect(out).toContain('db query failed [23505]');
    expect(out).toContain('constraint=customers_phone_key');
  });

  it('its message, alone, after a prefix, or inside an object', () => {
    const msg = queryError().message;
    for (const out of [scrub(msg), scrub(`prefix: ${msg}`), scrub({ note: msg })]) {
      clean(out);
      expect(out).toContain('params: <redacted>');
    }
  });

  it('a query error nested in an object goes through the same description', () => {
    const out = scrub({ step: 'mint', err: queryError() });
    clean(out);
    expect(out).toContain('db query failed [23505]');
  });

  it('logWarn with the error as the message and as a field', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = queryError();
    logWarn('transfer.upsert_recipient', err, { err });
    const raw = spy.mock.calls[0][0] as string;
    clean(raw);
    const line = JSON.parse(raw) as Record<string, string>;
    expect(line.msg).toContain('[23505]');
    expect(line.err).toContain('[23505]');
  });

  it('a non-query Error keeps "name: message", with any params tail cut', () => {
    expect(scrub(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
    const e = new Error('worker: Failed query: select 1\nparams: Ravi Traders');
    expect(scrub(e)).not.toContain('Ravi');
  });

  // Review 2026-11-10: a bare Postgres driver error (no drizzle wrapper) has
  // `detail` and `where` as own enumerable properties, so a JSON.stringify of
  // an object that holds it prints them.
  function driverError() {
    return Object.assign(new Error('duplicate key value violates unique constraint "customers_phone_key"'), {
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (phone)=(+15551234567) already exists.',
      where: 'SQL statement with Ravi Traders',
      constraint: 'customers_phone_key',
      table: 'customers',
    });
  }

  it('a bare driver error becomes its fixed description', () => {
    const out = scrub(driverError());
    clean(out);
    expect(out).toBe(
      'db error [23505] duplicate key value violates unique constraint "customers_phone_key" constraint=customers_phone_key table=customers',
    );
  });

  it('a driver error nested in an object loses detail and where', () => {
    const out = scrub({ step: 'mint', err: driverError() });
    clean(out);
    expect(out).toContain('db error [23505]');
    expect(out).not.toContain('detail');
  });

  it('logWarn with a bare driver error as a field', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWarn('transfer.upsert_recipient', 'failed', { err: driverError() });
    const raw = spy.mock.calls[0][0] as string;
    clean(raw);
    expect((JSON.parse(raw) as Record<string, string>).err).toContain('db error [23505]');
  });
});

// Review 2026-11-10: the two catch-alls in src/app/account/actions.ts lost the
// stack when they stopped printing the error object. stackFrames() gives the
// frames back without the header, because the header repeats the message.
describe('stackFrames: frames only, never the header', () => {
  it('returns the first frames of a normal error, joined on one line', () => {
    const out = stackFrames(new Error('boom'));
    expect(out).toMatch(/^at /);
    expect(out).not.toContain('boom');
    expect(out).not.toContain('\n');
    expect(out.split(' | ').length).toBeLessThanOrEqual(3);
    expect(stackFrames(new Error('boom'), 1).split(' | ').length).toBe(1);
  });

  it('a query error gives frames with none of the bound values', () => {
    const err = new DrizzleQueryError('select * from "customers" where "phone" = $1', ['+15551234567', 'Ravi Traders']);
    expect(err.stack).toContain('+15551234567'); // the raw stack does hold them
    const out = stackFrames(err);
    expect(out).toMatch(/^at /);
    expect(out).not.toContain('15551234567');
    expect(out).not.toContain('Ravi Traders');
    expect(out).not.toContain('Failed query');
  });

  it('returns nothing when the header cannot be found', () => {
    const err = new Error('first');
    void err.stack; // V8 formats the header on the first read of .stack
    err.message = 'changed after the stack was taken';
    expect(stackFrames(err)).toBe('');
    // A message line that looks like a frame must not come back as one.
    const tricky = new Error('x');
    tricky.stack = 'Error: other\n    at Ravi Traders (+15551234567)\n    at real (file.ts:1:1)';
    expect(stackFrames(tricky)).toBe('');
  });

  it('returns nothing for a non-error and never throws', () => {
    for (const v of [null, undefined, 'text', 42, {}, { stack: 'Error: x\n    at y' }]) expect(stackFrames(v)).toBe('');
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('no');
      },
    });
    expect(stackFrames(hostile)).toBe('');
  });
});

describe('fix pack 5 (P18): originator keys are redacted', () => {
  const KEYS = ['address', 'date_of_birth', 'senderAddress', 'senderDob', 'residentialAddress', 'dateOfBirth'];

  it('a value under an originator key becomes <redacted>; the other fields stay', () => {
    for (const key of KEYS) {
      const out = scrub({ [key]: '1 Test Street', id: 't1' });
      expect(out, key).toContain('<redacted>');
      expect(out, key).toContain('t1');
      expect(out, key).not.toContain('Test Street');
    }
  });

  it('a nested object is redacted too', () => {
    const out = scrub({ customer: { dateOfBirth: '1990-01-02', id: 'c1' } });
    expect(out).toBe('{"customer":{"dateOfBirth":"<redacted>","id":"c1"}}');
  });

  it('JSON text passed as a string is redacted by key', () => {
    expect(scrub('{"senderDob":"1990-01-02","x":1}')).toBe('{"senderDob":"<redacted>","x":1}');
    expect(scrub('{"address" : "1 Test Street","x":1}')).toBe('{"address":"<redacted>","x":1}');
    expect(scrub('{"senderAddress":"1 \\"Test\\" Street","x":1}')).toBe('{"senderAddress":"<redacted>","x":1}');
    expect(scrub('body {"dateOfBirth":"1990-01-0')).toBe('body {"dateOfBirth":"<redacted>"');
  });

  it('a top-level log field under an originator key is redacted in the line', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWarn('x', 'y', { senderDob: '1990-01-02', transferId: 't1' });
    const raw = spy.mock.calls[0][0] as string;
    expect(raw).toContain('"senderDob":"<redacted>"');
    expect(raw).toContain('t1');
    expect(raw).not.toContain('1990-01-02');
  });

  it('a null or absent originator value is not invented; unrelated dates and the existing masks are unchanged', () => {
    expect(scrub({ address: null, id: 't1' })).toBe('{"address":null,"id":"t1"}');
    expect(scrub({ paidAt: '2026-01-02' })).toBe('{"paidAt":"2026-01-02"}');
    expect(scrub('paidAt 2026-01-02')).toBe('paidAt 2026-01-02');
    expect(scrub({ email: 'a@example.com', phone: '15551234567' })).toBe('{"email":"<email>","phone":"…4567"}');
  });
});
