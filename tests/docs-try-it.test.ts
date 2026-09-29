import { describe, it, expect } from 'vitest';
import {
  TRY_IT_OPERATIONS,
  TRY_IT_LIVE_KEY_ERROR,
  TRY_IT_MAX_BODY_BYTES,
  forwardTarget,
  isSameOriginRequest,
  isTryItOperation,
  parseTryItRequest,
  type TryItParsed,
} from '@/lib/docs/try-it';
import { loadPartnerOpenApi } from '@/lib/openapi/load-spec';

// UI redesign M4 PR-5 (Task 5.1): the pure parse / validate / forward-build helpers behind the
// docs "Try it" proxy. Every crafted-input case from the plan's review focus is pinned here.
// Keys in this file are obviously fake.

const JSON_CT = 'application/json';
const FAKE_TEST_KEY = 'sr_test_FAKEfakeFAKEfake';
const req = (o: Record<string, unknown>) => JSON.stringify(o);
const ok = (raw: string, ct: string | null = JSON_CT) => {
  const r = parseTryItRequest(ct, raw);
  if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`);
  return r;
};

describe('parseTryItRequest: keys', () => {
  it('refuses a live key with the fixed sandbox-only message', () => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'listCorridors', key: 'sr_live_FAKEfakeFAKE' }))).toEqual({
      ok: false,
      status: 400,
      error: TRY_IT_LIVE_KEY_ERROR,
    });
  });

  it.each([
    ['no prefix', 'FAKEfakeFAKE'],
    ['a legacy pk_ id', 'pk_FAKEfake'],
    ['empty', ''],
    ['whitespace inside', 'sr_test_ab cd'],
    ['a newline (header injection)', 'sr_test_ab\r\nx-evil: 1'],
    ['a control char', 'sr_test_ab\u0000'],
    ['non-ASCII', 'sr_test_abé'],
    ['over 256 chars', `sr_test_${'a'.repeat(249)}`],
    ['not a string', 42],
    ['missing', undefined],
  ])('refuses a key that is %s', (_n, key) => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'listCorridors', key }))).toEqual({
      ok: false,
      status: 400,
      error: TRY_IT_LIVE_KEY_ERROR,
    });
  });

  it('accepts a sandbox key of exactly 256 chars', () => {
    expect(ok(req({ operationId: 'listCorridors', key: `sr_test_${'a'.repeat(248)}` })).key).toHaveLength(256);
  });
});

describe('parseTryItRequest: operations are a closed set', () => {
  it.each(['createTransaction', 'confirmTransaction', 'listSettlements', 'pushRate', 'createBeneficiary', 'listRates', '__proto__', 'constructor', 'toString', ''])(
    '%s → 400 Invalid request.',
    (operationId) => {
      expect(parseTryItRequest(JSON_CT, req({ operationId, key: FAKE_TEST_KEY }))).toEqual({ ok: false, status: 400, error: 'Invalid request.' });
    },
  );

  it('a non-string operationId → 400', () => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: ['listCorridors'], key: FAKE_TEST_KEY }))).toMatchObject({ ok: false, status: 400 });
  });

  it('isTryItOperation is a strict membership test (no prototype keys)', () => {
    for (const op of TRY_IT_OPERATIONS) expect(isTryItOperation(op)).toBe(true);
    for (const op of ['createTransaction', 'confirmTransaction', 'listSettlements', '__proto__', 'toString', '', 1, null]) expect(isTryItOperation(op)).toBe(false);
  });

  it('the allowlist is exactly the five read-only or stateless operations', () => {
    expect([...TRY_IT_OPERATIONS]).toEqual(['listCorridors', 'createQuote', 'validateBeneficiary', 'listTransactions', 'getTransaction']);
  });
});

describe('parseTryItRequest: path and query params', () => {
  it.each(['../x', 'a/b', 'a%2Fb', 'a%2fb', '..', '.', 'a\\b', 'a?b', 'a#b', 'a b', '', 'x'.repeat(65)])('getTransaction id %j → 400', (id) => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'getTransaction', key: FAKE_TEST_KEY, params: { id } }))).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid request.',
    });
  });

  it('getTransaction without an id → 400', () => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'getTransaction', key: FAKE_TEST_KEY }))).toMatchObject({ ok: false, status: 400 });
  });

  it.each(['-1', '1000', '1.5', 'abc', ''])('limit %j → 400', (limit) => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'listTransactions', key: FAKE_TEST_KEY, params: { limit } }))).toMatchObject({ ok: false, status: 400 });
  });

  it.each(['a b', 'é', '', 'x'.repeat(257), 'a\nb'])('cursor %j → 400', (cursor) => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'listTransactions', key: FAKE_TEST_KEY, params: { cursor } }))).toMatchObject({ ok: false, status: 400 });
  });

  it('params that are not an object → 400', () => {
    expect(parseTryItRequest(JSON_CT, req({ operationId: 'listTransactions', key: FAKE_TEST_KEY, params: 'limit=5' }))).toMatchObject({ ok: false, status: 400 });
  });
});

describe('parseTryItRequest: envelope', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', null])('content-type %j → 415', (ct) => {
    expect(parseTryItRequest(ct, req({ operationId: 'listCorridors', key: FAKE_TEST_KEY }))).toMatchObject({ ok: false, status: 415 });
  });

  it('accepts application/json with a charset', () => {
    expect(ok(req({ operationId: 'listCorridors', key: FAKE_TEST_KEY }), 'application/json; charset=utf-8').op).toBe('listCorridors');
  });

  it('16,385 bytes → 413; the byte count (not the char count) decides', () => {
    const padded = (n: number) => {
      const base = req({ operationId: 'listCorridors', key: FAKE_TEST_KEY, pad: '' });
      return base.replace('"pad":""', `"pad":"${'a'.repeat(n - base.length)}"`);
    };
    expect(padded(TRY_IT_MAX_BODY_BYTES)).toHaveLength(TRY_IT_MAX_BODY_BYTES);
    expect(parseTryItRequest(JSON_CT, padded(TRY_IT_MAX_BODY_BYTES)).ok).toBe(true);
    expect(parseTryItRequest(JSON_CT, padded(TRY_IT_MAX_BODY_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
    // 6,000 chars of a 3-byte character: under the char cap, over the byte cap.
    const multi = req({ operationId: 'listCorridors', key: FAKE_TEST_KEY, pad: '€'.repeat(6000) });
    expect(multi.length).toBeLessThan(TRY_IT_MAX_BODY_BYTES);
    expect(parseTryItRequest(JSON_CT, multi)).toMatchObject({ ok: false, status: 413 });
  });

  it.each(['not json', '[]', 'null', '"x"', '42', ''])('raw %j → 400 Invalid request.', (raw) => {
    expect(parseTryItRequest(JSON_CT, raw)).toEqual({ ok: false, status: 400, error: 'Invalid request.' });
  });

  it('a POST operation needs an object body; a GET ignores any body', () => {
    for (const body of [undefined, null, [], 'x', 1])
      expect(parseTryItRequest(JSON_CT, req({ operationId: 'createQuote', key: FAKE_TEST_KEY, body }))).toMatchObject({ ok: false, status: 400 });
    expect(ok(req({ operationId: 'createQuote', key: FAKE_TEST_KEY, body: { amount_source: 100 } })).body).toEqual({ amount_source: 100 });
    expect(ok(req({ operationId: 'listCorridors', key: FAKE_TEST_KEY, body: { a: 1 } })).body).toEqual({});
  });

  it('a rejection never echoes the key', () => {
    for (const key of ['sr_live_SECRETsecret', 'sr_test_SECRET\nx'])
      expect(JSON.stringify(parseTryItRequest(JSON_CT, req({ operationId: 'listCorridors', key })))).not.toContain('SECRET');
  });
});

describe('forwardTarget', () => {
  it('getTransaction → GET /api/partner/v1/transactions/abc with no search', () => {
    expect(forwardTarget(ok(req({ operationId: 'getTransaction', key: FAKE_TEST_KEY, params: { id: 'abc' } })))).toEqual({
      method: 'GET',
      path: '/api/partner/v1/transactions/abc',
      search: '',
      hasBody: false,
    });
  });

  it('listTransactions encodes limit and cursor', () => {
    const t = forwardTarget(ok(req({ operationId: 'listTransactions', key: FAKE_TEST_KEY, params: { limit: '5', cursor: 'a&b=c+d/%' } })));
    expect(t).toEqual({ method: 'GET', path: '/api/partner/v1/transactions', search: '?limit=5&cursor=a%26b%3Dc%2Bd%2F%25', hasBody: false });
    expect(new URLSearchParams(t.search).get('cursor')).toBe('a&b=c+d/%');
  });

  it('POST operations carry a body; GETs never do', () => {
    expect(forwardTarget(ok(req({ operationId: 'createQuote', key: FAKE_TEST_KEY, body: {} })))).toMatchObject({ method: 'POST', path: '/api/partner/v1/quote', hasBody: true });
    expect(forwardTarget(ok(req({ operationId: 'validateBeneficiary', key: FAKE_TEST_KEY, body: {} })))).toMatchObject({
      method: 'POST',
      path: '/api/partner/v1/beneficiaries/validate',
      hasBody: true,
    });
    expect(forwardTarget(ok(req({ operationId: 'listCorridors', key: FAKE_TEST_KEY })))).toEqual({ method: 'GET', path: '/api/partner/v1/corridors', search: '', hasBody: false });
  });

  it('every allowlisted operation is a sandbox operation in openapi.yaml, with the same method and path', () => {
    const spec = new Map(loadPartnerOpenApi().map((o) => [o.operationId, o]));
    for (const op of TRY_IT_OPERATIONS) {
      const s = spec.get(op);
      expect(s, op).toBeDefined();
      expect(s!.sandbox, op).toBe(true);
      const parsed: TryItParsed = { ok: true, op, key: FAKE_TEST_KEY, id: 'abc', query: {}, body: {} };
      const t = forwardTarget(parsed);
      expect(t.method, op).toBe(s!.method);
      expect(`/api/partner/v1${s!.path.replace('{id}', 'abc')}`, op).toBe(t.path);
    }
  });
});

describe('isSameOriginRequest', () => {
  const ORIGIN = 'https://smartremit.ai';
  const h = (o: Record<string, string>) => new Headers(o);
  it.each([
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'same-origin', origin: ORIGIN }, true],
    [{ 'sec-fetch-site': 'same-site', origin: ORIGIN }, false],
    [{ 'sec-fetch-site': 'cross-site', origin: ORIGIN }, false],
    [{ 'sec-fetch-site': 'none' }, false],
    [{ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' }, false],
    [{ origin: ORIGIN }, true],
    [{ origin: 'https://evil.example' }, false],
    [{ origin: 'https://acme.smartremit.ai' }, false],
    [{ origin: 'null' }, false],
    [{}, false],
  ] as const)('%j → %s', (headers, expected) => {
    expect(isSameOriginRequest(h(headers), ORIGIN)).toBe(expected);
  });
});
