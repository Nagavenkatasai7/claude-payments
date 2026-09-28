import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { TRY_IT_LIVE_KEY_ERROR } from '@/lib/docs/try-it';

// UI redesign M4 PR-5 (Task 5.2): POST /api/docs/try-it with the five partner handlers MOCKED.
// Proves the proxy's own gates: origin, IP limit, the closed op set, sandbox-key-only BEFORE the
// handler runs, the streamed 16 KB cap, the forwarded-header allowlist, and that neither the key
// nor a thrown error ever reaches a log or a response. tests/docs-try-it-guard.test.ts runs the
// REAL handlers and guard for tenant isolation. Keys here are obviously fake.

const h = vi.hoisted(() => ({
  seen: [] as Array<{ op: string; req: NextRequest; ctx?: { params: Promise<{ id: string }> } }>,
  throwWith: null as Error | null,
  limited: null as Response | null,
  respond: null as (() => Response) | null,
}));

function spy(op: string) {
  return async (req: NextRequest, ctx?: { params: Promise<{ id: string }> }) => {
    h.seen.push({ op, req, ctx });
    if (h.throwWith) throw h.throwWith;
    if (h.respond) return h.respond();
    return NextResponse.json({ ok: 1 }, { status: 200 });
  };
}

vi.mock('@/app/api/partner/v1/corridors/route', () => ({ GET: spy('listCorridors') }));
vi.mock('@/app/api/partner/v1/quote/route', () => ({ POST: spy('createQuote') }));
vi.mock('@/app/api/partner/v1/beneficiaries/validate/route', () => ({ POST: spy('validateBeneficiary') }));
vi.mock('@/app/api/partner/v1/transactions/route', () => ({ GET: spy('listTransactions'), POST: spy('createTransaction') }));
vi.mock('@/app/api/partner/v1/transactions/[id]/route', () => ({ GET: spy('getTransaction') }));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: vi.fn(async () => h.limited) }));

const { POST } = await import('@/app/api/docs/try-it/route');

const FAKE_TEST_KEY = 'sr_test_FAKEfakeFAKEfake';
const ORIGIN = 'https://smartremit.ai';

function call(
  payload: unknown,
  opts: { headers?: Record<string, string>; raw?: string | ReadableStream<Uint8Array>; url?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    origin: ORIGIN,
    host: 'smartremit.ai',
    ...opts.headers,
  };
  const body = opts.raw ?? JSON.stringify(payload);
  return POST(
    new NextRequest(opts.url ?? `${ORIGIN}/api/docs/try-it`, {
      method: 'POST',
      headers,
      body,
      ...(typeof body === 'string' ? {} : { duplex: 'half' }),
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
}

const consoleCalls: unknown[][] = [];
beforeEach(() => {
  h.seen = [];
  h.throwWith = null;
  h.limited = null;
  h.respond = null;
  consoleCalls.length = 0;
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
});
afterEach(() => {
  // Case 7 (no logging): across EVERY case in this file, no console call carries a key.
  expect(consoleCalls.map((a) => a.map(String).join(' ')).filter((s) => s.includes('sr_'))).toEqual([]);
  vi.restoreAllMocks();
});

describe('POST /api/docs/try-it (mocked partner handlers)', { retry: 0 }, () => {
  it('1. a live key is refused with the fixed message and the handler is never called', async () => {
    const res = await call({ operationId: 'listCorridors', key: 'sr_live_FAKEfakeFAKE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TRY_IT_LIVE_KEY_ERROR });
    expect(h.seen).toHaveLength(0);
  });

  it('2. a sandbox key is forwarded as a Bearer header and the upstream result is wrapped, no-store', async () => {
    const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ upstreamStatus: 200, retryAfter: null, body: { ok: 1 } });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].op).toBe('listCorridors');
    expect(h.seen[0].req.headers.get('authorization')).toBe(`Bearer ${FAKE_TEST_KEY}`);
    expect(h.seen[0].req.method).toBe('GET');
    expect(h.seen[0].req.nextUrl.pathname).toBe('/api/partner/v1/corridors');
  });

  it('3. a cross-site (or same-site, or foreign-origin) request is 403 and never dispatched', async () => {
    const variants: Record<string, string>[] = [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }];
    for (const headers of variants) {
      const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY }, { headers });
      expect(res.status).toBe(403);
    }
    expect(h.seen).toHaveLength(0);
  });

  it('4. the per-IP limiter response passes through (429) before any parsing', async () => {
    h.limited = NextResponse.json({ ok: false, error: 'Too many requests — please retry in a minute.' }, { status: 429, headers: { 'retry-after': '30' } });
    const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(h.seen).toHaveLength(0);
    const { enforceIpRateLimit } = await import('@/lib/ip-rate-limit');
    expect(enforceIpRateLimit).toHaveBeenLastCalledWith(expect.anything(), 'docs-tryit', 20);
  });

  it('5. a non-allowlisted operation (mint, confirm, settlements) is 400 and nothing is dispatched', async () => {
    for (const operationId of ['createTransaction', 'confirmTransaction', 'listSettlements', 'pushRate']) {
      const res = await call({ operationId, key: FAKE_TEST_KEY, params: { id: 'abc' }, body: {} });
      expect(res.status).toBe(400);
    }
    expect(h.seen).toHaveLength(0);
  });

  it('6. a throwing handler gives a fixed 502 with neither the error nor the key', async () => {
    h.throwWith = new Error(`boom ${FAKE_TEST_KEY}`);
    const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('boom');
    expect(text).not.toContain('sr_test_');
    expect(JSON.parse(text)).toEqual({ error: 'Try it is unavailable right now.' });
  });

  it('7. the route and helper sources carry no console or logger call', () => {
    for (const f of ['src/app/api/docs/try-it/route.ts', 'src/lib/docs/try-it.ts']) {
      const src = readFileSync(f, 'utf8');
      expect({ f, console: /\bconsole\./.test(src), logger: /from ['"]@\/lib\/log['"]/.test(src) }).toEqual({ f, console: false, logger: false });
    }
  });

  it('8. getTransaction passes the id as the route param; a smuggled id is 400', async () => {
    const res = await call({ operationId: 'getTransaction', key: FAKE_TEST_KEY, params: { id: 'abc' } });
    expect(res.status).toBe(200);
    expect(h.seen).toHaveLength(1);
    expect(await h.seen[0].ctx!.params).toEqual({ id: 'abc' });
    expect(h.seen[0].req.nextUrl.pathname).toBe('/api/partner/v1/transactions/abc');
    for (const id of ['../x', 'a/b', 'a%2Fb', '..%2F..%2Fsettlements']) {
      const bad = await call({ operationId: 'getTransaction', key: FAKE_TEST_KEY, params: { id } });
      expect(bad.status, id).toBe(400);
    }
    expect(h.seen).toHaveLength(1);
  });

  it('9. a declared content-length over 16 KB is 413 before the body is read', async () => {
    const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY }, { headers: { 'content-length': '20000' } });
    expect(res.status).toBe(413);
    expect(h.seen).toHaveLength(0);
  });

  it('9b. the cap is enforced while STREAMING: a 20,000-byte body with no content-length is 413', async () => {
    const big = JSON.stringify({ operationId: 'listCorridors', key: FAKE_TEST_KEY, pad: 'a'.repeat(20_000) });
    const enc = new TextEncoder().encode(big);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= enc.length) return c.close();
        c.enqueue(enc.slice(pulled, pulled + 4096));
        pulled += 4096;
      },
    });
    const res = await call(null, { raw: stream });
    expect(res.status).toBe(413);
    expect(h.seen).toHaveLength(0);
  });

  it('9c. a multi-byte body under 16,384 chars but over 16,384 bytes is 413', async () => {
    const raw = JSON.stringify({ operationId: 'listCorridors', key: FAKE_TEST_KEY, pad: '€'.repeat(6000) });
    expect(raw.length).toBeLessThan(16_384);
    const res = await call(null, { raw });
    expect(res.status).toBe(413);
    expect(h.seen).toHaveLength(0);
  });

  it('10. a non-JSON content type is 415 and never dispatched', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY }, { headers: { 'content-type': ct } });
      expect(res.status).toBe(415);
    }
    expect(h.seen).toHaveLength(0);
  });

  it('11. no client header reaches the handler: GET gets authorization only, POST adds content-type', async () => {
    const noisy = {
      cookie: 'sr_session=abc',
      'x-forwarded-for': '203.0.113.9',
      'idempotency-key': 'idem-1',
      'x-smartremit-signature': 'x',
      'x-middleware-subrequest': 'x',
      authorization: 'Bearer sr_live_FAKEfromHeader',
    };
    await call({ operationId: 'listTransactions', key: FAKE_TEST_KEY, params: { limit: '5', cursor: 'c1' } }, { headers: noisy });
    await call({ operationId: 'createQuote', key: FAKE_TEST_KEY, body: { amount_source: 100 } }, { headers: noisy });
    expect(h.seen.map((s) => s.op)).toEqual(['listTransactions', 'createQuote']);
    expect([...h.seen[0].req.headers.keys()].sort()).toEqual(['authorization']);
    expect(h.seen[0].req.headers.get('authorization')).toBe(`Bearer ${FAKE_TEST_KEY}`);
    expect(h.seen[0].req.nextUrl.search).toBe('?limit=5&cursor=c1');
    expect([...h.seen[1].req.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
    expect(h.seen[1].req.method).toBe('POST');
    expect(await h.seen[1].req.json()).toEqual({ amount_source: 100 });
  });

  it('12. the upstream status and retry-after are reported; a non-JSON upstream body becomes null', async () => {
    h.respond = () => new Response('oops', { status: 429, headers: { 'retry-after': '60' } });
    const res = await call({ operationId: 'createQuote', key: FAKE_TEST_KEY, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upstreamStatus: 429, retryAfter: '60', body: null });
  });

  it('12b. upstream headers (set-cookie and friends) are never passed through', async () => {
    h.respond = () => NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401, headers: { 'set-cookie': 'x=1', 'x-internal': 'y' } });
    const res = await call({ operationId: 'listCorridors', key: FAKE_TEST_KEY });
    expect(await res.json()).toEqual({ upstreamStatus: 401, retryAfter: null, body: { error: 'Invalid or revoked API key.' } });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
  });

  it('13. apex only: a partner-subdomain host is 404 and never dispatched', async () => {
    const res = await call(
      { operationId: 'listCorridors', key: FAKE_TEST_KEY },
      { url: 'https://acme.smartremit.ai/api/docs/try-it', headers: { host: 'acme.smartremit.ai', origin: 'https://acme.smartremit.ai' } },
    );
    expect(res.status).toBe(404);
    expect(h.seen).toHaveLength(0);
  });
});
