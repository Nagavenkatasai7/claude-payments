import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildErrorReport,
  parseSentryDsn,
  reportRequestError,
  stripUrlQueries,
} from '@/lib/error-report';
import { onRequestError } from '@/instrumentation';

// Program-Fix 26 (obs-01): server errors go to Sentry by plain fetch, scrubbed,
// and only when SENTRY_DSN is set. Assertions are made on the EGRESS (the body
// handed to fetch), not only on the builder.

const DSN = 'https://pubkey123@o1.ingest.example.test/4501';
const REQUEST = {
  path: '/pay/tr_abc?token=SECRET_TOKEN_1',
  method: 'POST',
  headers: { cookie: 'sid=COOKIE_VALUE', authorization: 'Bearer AUTH_VALUE' },
};
const CONTEXT = {
  routerKind: 'App Router' as const,
  routePath: '/app/pay/[id]/page',
  routeType: 'render' as const,
  renderSource: 'server-rendering' as const,
  revalidateReason: undefined,
};

function hostileError(): Error {
  const err = new Error(
    'lookup failed for 15551234567 jane.doe@example.org at https://smartremit.ai/pay/x?token=abc and /verify/y?code=zzz',
  );
  err.stack = 'Error: STACK_SENTINEL\n    at secret (/var/task/app.js:1:1)';
  (err as Error & { cause?: unknown }).cause = new Error('CAUSE_SENTINEL 15559990000');
  (err as Error & { digest?: string }).digest = '2380467093';
  return err;
}

function sentBody(fetchFn: ReturnType<typeof vi.fn>): string {
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  return String(init.body);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('stripUrlQueries', () => {
  it('drops the query string and fragment from every URL, absolute or path-only', () => {
    expect(stripUrlQueries('see https://smartremit.ai/pay/x?token=abc now')).toBe('see https://smartremit.ai/pay/x now');
    expect(stripUrlQueries('at /reset/y?code=1#frag.')).toBe('at /reset/y');
    expect(stripUrlQueries('http://a.test/p#t=1 and http://b.test/q?x=1')).toBe('http://a.test/p and http://b.test/q');
    expect(stripUrlQueries('no urls here')).toBe('no urls here');
  });
});

describe('buildErrorReport', () => {
  it('scrubs phones and emails, strips URL queries, never carries stack, cause, path or headers', () => {
    const r = buildErrorReport(hostileError(), REQUEST, CONTEXT);
    const s = JSON.stringify(r);
    expect(r.message).toContain('…4567');
    expect(r.message).toContain('<email>');
    expect(r.message).toContain('https://smartremit.ai/pay/x');
    expect(s).not.toContain('15551234567');
    expect(s).not.toContain('jane.doe');
    expect(s).not.toContain('token=abc');
    expect(s).not.toContain('code=zzz');
    expect(s).not.toContain('STACK_SENTINEL');
    expect(s).not.toContain('CAUSE_SENTINEL');
    expect(s).not.toContain('SECRET_TOKEN_1');
    expect(s).not.toContain('COOKIE_VALUE');
    expect(s).not.toContain('AUTH_VALUE');
    expect(r).toMatchObject({ routePath: '/app/pay/[id]/page', routeType: 'render', method: 'POST', digest: '2380467093' });
  });

  it('a thrown plain object never leaks its stack or cause (only a string message is taken)', () => {
    const r = buildErrorReport({ message: 'boom', stack: 'STACK_SENTINEL', cause: 'CAUSE_SENTINEL' }, REQUEST, CONTEXT);
    expect(r.message).toBe('boom');
    expect(JSON.stringify(r)).not.toMatch(/STACK_SENTINEL|CAUSE_SENTINEL/);
    const odd = buildErrorReport({ nested: { stack: 'STACK_SENTINEL' } }, REQUEST, CONTEXT);
    expect(JSON.stringify(odd)).not.toContain('STACK_SENTINEL');
  });

  it('drops a digest or method that is not a plain token', () => {
    const err = Object.assign(new Error('x'), { digest: 'NEXT_REDIRECT;replace;/pay/x?token=abc;307' });
    const r = buildErrorReport(err, { ...REQUEST, method: 'GET /x?y=1' }, CONTEXT);
    expect(r.digest).toBeUndefined();
    expect(r.method).toBeUndefined();
  });
});

describe('parseSentryDsn', () => {
  it('derives the envelope endpoint and public key (develop.sentry.dev authentication rules)', () => {
    expect(parseSentryDsn(DSN)).toEqual({
      dsn: DSN,
      publicKey: 'pubkey123',
      envelopeUrl: 'https://o1.ingest.example.test/api/4501/envelope/',
    });
    expect(parseSentryDsn('https://k@sentry.example.test/prefix/7')!.envelopeUrl).toBe(
      'https://sentry.example.test/prefix/api/7/envelope/',
    );
  });

  it('unset, empty or unparseable → null', () => {
    for (const bad of [undefined, '', 'not-a-dsn', 'https://sentry.example.test/1', 'ftp://k@h.test/1', 'https://k@h.test/notanumber']) {
      expect(parseSentryDsn(bad)).toBeNull();
    }
  });
});

describe('reportRequestError', () => {
  it('SENTRY_DSN unset → 0 fetches', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    const fetchFn = vi.fn();
    await reportRequestError(buildErrorReport(hostileError(), REQUEST, CONTEXT), fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('SENTRY_DSN = not-a-dsn → 0 fetches', async () => {
    vi.stubEnv('SENTRY_DSN', 'not-a-dsn');
    const fetchFn = vi.fn();
    await reportRequestError(buildErrorReport(hostileError(), REQUEST, CONTEXT), fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends ONE envelope (header, event item, event) to the DSN endpoint with a deadline; the body holds no PII, query, stack or cause', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await reportRequestError(buildErrorReport(hostileError(), REQUEST, CONTEXT), fetchFn as unknown as typeof fetch);
    const body = sentBody(fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://o1.ingest.example.test/api/4501/envelope/');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-sentry-envelope');
    expect(headers['x-sentry-auth']).toMatch(/^Sentry sentry_version=7, sentry_key=pubkey123, sentry_client=/);

    const lines = body.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const envHeader = JSON.parse(lines[0]) as Record<string, unknown>;
    const item = JSON.parse(lines[1]) as Record<string, unknown>;
    const event = JSON.parse(lines[2]) as Record<string, unknown>;
    expect(envHeader.dsn).toBe(DSN);
    expect(envHeader.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item).toEqual({ type: 'event' });
    expect(event.event_id).toBe(envHeader.event_id);
    expect(event.level).toBe('error');

    for (const leak of ['15551234567', '15559990000', 'jane.doe', 'token=abc', 'code=zzz', 'STACK_SENTINEL', 'CAUSE_SENTINEL', 'SECRET_TOKEN_1', 'COOKIE_VALUE', 'AUTH_VALUE', '/var/task']) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('never throws: a rejecting fetch resolves quietly', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = vi.fn(async () => { throw new TypeError('network down'); });
    await expect(
      reportRequestError(buildErrorReport(new Error('x'), REQUEST, CONTEXT), fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});

describe('instrumentation onRequestError', () => {
  it('logs a scrubbed line and resolves even when fetch rejects and err is hostile', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const hostile = new Proxy({}, { get() { throw new Error('hostile getter'); } });
    await expect(onRequestError(hostile, REQUEST, CONTEXT)).resolves.toBeUndefined();
    await expect(onRequestError(hostileError(), REQUEST, CONTEXT)).resolves.toBeUndefined();
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).toContain('request.error');
    expect(logged).not.toContain('15551234567');
    expect(logged).not.toContain('token=abc');
    expect(logged).not.toContain('STACK_SENTINEL');
  });

  it('with SENTRY_DSN unset it never calls fetch', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.spyOn(globalThis, 'fetch');
    await onRequestError(hostileError(), REQUEST, CONTEXT);
    expect(f).not.toHaveBeenCalled();
  });
});
