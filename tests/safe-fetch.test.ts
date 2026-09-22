/**
 * Program-Fix 22 (Task 12) — safeFetch: the only client that may carry a
 * settlement / reverse instruction. Local https server with a throwaway
 * self-signed certificate generated per run by `openssl` (no key is ever
 * committed) + an INJECTED resolver: no real DNS, no network. The connect-time `lookup` is exercised for real; the address
 * predicate is the real `isPublicAddress` except where a test needs the
 * loopback server to be dialled (then a predicate allowing only 127.0.0.1 is
 * injected — the spec's "public then private" stub would dial a real IP).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import dns from 'node:dns';
import { createSafeFetch, defaultResolve, MAX_ACK_BYTES, type ResolvedAddress } from '@/lib/safe-fetch';

// Node cannot mint an X.509 certificate itself, so a throwaway self-signed pair
// is generated into a temp dir per run. Explicit SANs: Node's checkServerIdentity
// refuses `*.tld` wildcards, so `*.example` would not match `rail.example`.
let CERT: Buffer;
let KEY: Buffer;
let tlsDir = '';
function mintTestCert(): void {
  tlsDir = mkdtempSync(join(tmpdir(), 'smartremit-safe-fetch-'));
  const key = join(tlsDir, 'key.pem');
  const cert = join(tlsDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', cert,
    '-subj', '/CN=rail.example/O=SmartRemit safe-fetch test (throwaway)',
    '-addext', 'subjectAltName=DNS:rail.example,DNS:other.example,DNS:evil.example,DNS:localhost,IP:127.0.0.1',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  KEY = readFileSync(key);
  CERT = readFileSync(cert);
}

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let tlsServer: https.Server;
let tlsPort = 0;
let plainServer: http.Server;
let plainPort = 0;
let seen: Seen[] = [];
let connections = 0;
let handler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ providerRef: 'rail-ok' }));
};

function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    handler(req, res, body);
  });
}

beforeAll(async () => {
  mintTestCert();
  tlsServer = https.createServer({ cert: CERT, key: KEY }, serve);
  tlsServer.on('connection', () => { connections++; });
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsPort = (tlsServer.address() as { port: number }).port;
  plainServer = http.createServer(serve);
  await new Promise<void>((r) => plainServer.listen(0, r));
  plainPort = (plainServer.address() as { port: number }).port;
});
afterAll(async () => {
  tlsServer.closeAllConnections();
  plainServer.closeAllConnections();
  await new Promise<void>((r) => tlsServer.close(() => r()));
  await new Promise<void>((r) => plainServer.close(() => r()));
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  connections = 0;
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ providerRef: 'rail-ok' }));
  };
});

const loopback: ResolvedAddress[] = [{ address: '127.0.0.1', family: 4 }];
const resolveLoopback = () => vi.fn(async (_host: string) => loopback);
/** The production-shaped client, except: loopback is dialable and the fixture CA is trusted. */
function client(over: Partial<Parameters<typeof createSafeFetch>[0]> = {}) {
  return createSafeFetch({
    resolve: resolveLoopback(),
    isPublicAddress: (ip) => ip === '127.0.0.1',
    ca: CERT,
    port: tlsPort,
    appOrigin: 'https://smartremit.test',
    production: true,
    ...over,
  });
}
const INSTRUCTION = JSON.stringify({ reference: 'tr_1', payout: { destination: '123456789012|HDFC0001234' } });
const post = (sf: typeof fetch, url: string, extra: RequestInit = {}) =>
  sf(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': 'abc' },
    body: INSTRUCTION,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  });

describe('safeFetch — the connect-time pin (acceptance test 4)', () => {
  it('a signed POST reaches the rail through the injected lookup, once, with identity encoding', async () => {
    const resolve = resolveLoopback();
    const sf = client({ resolve });
    const res = await post(sf, 'https://rail.example/settle');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providerRef: 'rail-ok' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toBe('rail.example');
    expect(connections).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/settle');
    expect(seen[0].body).toBe(INSTRUCTION);
    expect(seen[0].headers['x-signature']).toBe('abc');
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].headers['accept-encoding']).toBe('identity');
    expect(seen[0].headers.host).toBe('rail.example');
  });

  it.each([
    [[{ address: '127.0.0.1', family: 4 }]],
    [[{ address: '10.0.0.5', family: 4 }]],
    [[{ address: '169.254.169.254', family: 4 }]],
    [[{ address: '::1', family: 6 }]],
    [[{ address: '::ffff:7f00:1', family: 6 }]],
    [[{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]], // one bad address poisons the set
  ])('with the REAL predicate, a resolver answer of %j is refused before any byte is sent', async (addrs) => {
    const resolve = vi.fn(async () => addrs as ResolvedAddress[]);
    const sf = client({ resolve, isPublicAddress: undefined });
    await expect(post(sf, 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:private_address');
    expect(resolve).toHaveBeenCalledTimes(1); // the lookup IS the only resolution — no pre-check to rebind against
    expect(connections).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('rebinding across hops: the second hop resolves privately and is refused; the body never goes there', async () => {
    const resolve = vi
      .fn<(h: string) => Promise<ResolvedAddress[]>>()
      .mockResolvedValueOnce(loopback)
      .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    handler = (req, res) => {
      if (req.url === '/settle') {
        res.writeHead(307, { location: '/settle-v2' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('{}');
    };
    const sf = client({ resolve, isPublicAddress: (ip) => ip === '127.0.0.1' });
    await expect(post(sf, 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:private_address');
    expect(resolve).toHaveBeenCalledTimes(2); // every hop is looked up and validated afresh
    expect(seen.map((s) => s.url)).toEqual(['/settle']);
  });

  it('a resolver answer of no usable address is a sanitized fetch failure, never a hostname in the message', async () => {
    const sf = client({ resolve: vi.fn(async () => []) });
    const err = await post(sf, 'https://rail.example/settle').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('settlement_fetch_failed:ENOTFOUND');
    expect(connections).toBe(0);
  });

  it('the sync rule runs first: no resolution for http:, an IP literal or a single-label host', async () => {
    const resolve = resolveLoopback();
    const sf = client({ resolve });
    await expect(post(sf, 'http://rail.example/settle')).rejects.toThrow('settlement_url_refused:scheme');
    await expect(post(sf, 'https://10.0.0.5/settle')).rejects.toThrow('settlement_url_refused:ip_literal');
    await expect(post(sf, 'https://metadata/settle')).rejects.toThrow('settlement_url_refused:single_label');
    expect(resolve).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });

  it('a dev app-origin request over http succeeds with production: false and skips the lookup', async () => {
    const resolve = vi.fn(async () => { throw new Error('must not be called'); });
    const sf = createSafeFetch({ resolve, appOrigin: `http://localhost:${plainPort}`, production: false });
    const res = await post(sf, `http://localhost:${plainPort}/api/partner-rail`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ providerRef: 'rail-ok' });
    expect(resolve).not.toHaveBeenCalled();
    expect(seen[0].headers['accept-encoding']).toBe('identity');
    // The same URL is refused in production (invariant 5).
    const prod = createSafeFetch({ resolve, appOrigin: `http://localhost:${plainPort}`, production: true });
    await expect(post(prod, `http://localhost:${plainPort}/api/partner-rail`)).rejects.toThrow('settlement_url_refused:scheme');
  });
});

describe('safeFetch — redirects (acceptance test 5)', () => {
  it('a same-origin 307 → 200 is followed with method and body preserved; 308 too', async () => {
    handler = (req, res) => {
      if (req.url === '/settle') { res.writeHead(307, { location: '/v2/settle' }); res.end(); return; }
      if (req.url === '/v2/settle') { res.writeHead(308, { location: 'https://rail.example/v3/settle' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providerRef: 'after-redirect' }));
    };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providerRef: 'after-redirect' });
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', '/settle', INSTRUCTION],
      ['POST', '/v2/settle', INSTRUCTION],
      ['POST', '/v3/settle', INSTRUCTION],
    ]);
    for (const s of seen) expect(s.headers['accept-encoding']).toBe('identity');
  });

  it('a 307 to another host is redirect_cross_origin and the body is never sent there', async () => {
    handler = (_req, res) => { res.writeHead(307, { location: 'https://other.example/settle' }); res.end(); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:redirect_cross_origin');
    expect(seen).toHaveLength(1);
  });

  it('a 307 to a different port of the same host is cross-origin too', async () => {
    handler = (_req, res) => { res.writeHead(307, { location: 'https://rail.example:8443/settle' }); res.end(); };
    // The sync rule refuses the port before the origin compare — either way it is never followed.
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow(/settlement_url_refused:(port|redirect_cross_origin)/);
    expect(seen).toHaveLength(1);
  });

  it('a 307 to https://127.0.0.1/ is ip_literal', async () => {
    handler = (_req, res) => { res.writeHead(307, { location: 'https://127.0.0.1/settle' }); res.end(); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:ip_literal');
    expect(seen).toHaveLength(1);
  });

  it('three 307s give redirect_cap (two are followed, the third is refused)', async () => {
    let n = 0;
    handler = (_req, res) => { n++; res.writeHead(307, { location: `/hop${n}` }); res.end(); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:redirect_cap');
    expect(seen.map((s) => s.url)).toEqual(['/settle', '/hop1', '/hop2']);
  });

  it.each([301, 302, 303])('a %i is redirect_method — a signed POST never turns into a GET', async (status) => {
    handler = (_req, res) => { res.writeHead(status, { location: '/elsewhere' }); res.end(); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:redirect_method');
    expect(seen).toHaveLength(1);
  });

  it('a 307 without a usable Location is redirect_invalid', async () => {
    handler = (_req, res) => { res.writeHead(307); res.end(); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:redirect_invalid');
  });
});

describe('safeFetch — acks, body cap and deadline (acceptance test 6)', () => {
  it('a 204 ack resolves to an ok Response with an empty body (no throw)', async () => {
    handler = (_req, res) => { res.writeHead(204); res.end(); };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('an empty-body 202 resolves ok; res.json() rejects into the caller\'s non-JSON catch', async () => {
    handler = (_req, res) => { res.writeHead(202); res.end(); };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(202);
    await expect(res.json()).rejects.toThrow();
  });

  it.each([205, 304])('a %i is built with a null body and does not throw', async (status) => {
    handler = (_req, res) => { res.writeHead(status); res.end(); };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.status).toBe(status);
    expect(await res.text()).toBe('');
  });

  it('a non-2xx keeps status, statusText, headers and body for the caller', async () => {
    handler = (_req, res) => { res.writeHead(503, 'Down', { 'retry-after': '30', 'content-type': 'text/plain' }); res.end('rail down'); };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.statusText).toBe('Down');
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.text()).toBe('rail down');
  });

  it('an ack announcing > 64 KB is body_too_large before the body is read', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(1024 * 1024) });
      res.write('x'.repeat(1024));
      // never finishes — the client must have aborted on the header
    };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:body_too_large');
  });

  it('a 1 MB chunked ack is body_too_large (wire bytes counted, no content-length needed)', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(1024 * 1024)); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:body_too_large');
  });

  it('exactly 64 KB is accepted; one byte more is not', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('y'.repeat(MAX_ACK_BYTES)); };
    const ok = await post(client(), 'https://rail.example/settle');
    expect((await ok.text()).length).toBe(MAX_ACK_BYTES);
    handler = (_req, res) => { res.writeHead(200); res.end('y'.repeat(MAX_ACK_BYTES + 1)); };
    await expect(post(client(), 'https://rail.example/settle')).rejects.toThrow('settlement_url_refused:body_too_large');
  });

  it('a compressed ack is never decompressed (the cap counts wire bytes)', async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify({ providerRef: 'zipped' })));
    handler = (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' }); res.end(gz); };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.ok).toBe(true);
    await expect(res.json()).rejects.toThrow(); // raw gzip bytes, not JSON — caller keeps its fallback ref
  });

  it('a server that never answers is aborted by init.signal within the deadline, with the signal\'s reason', async () => {
    handler = () => { /* hold the request open */ };
    const started = Date.now();
    const err = await post(client(), 'https://rail.example/settle', { signal: AbortSignal.timeout(300) }).catch((e: Error) => e);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((err as Error).name).toBe('TimeoutError');
    expect(connections).toBe(1);
  });

  it('an already-aborted signal never opens a connection', async () => {
    const ac = new AbortController();
    ac.abort();
    const resolve = resolveLoopback();
    await expect(post(client({ resolve }), 'https://rail.example/settle', { signal: ac.signal })).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });

  it('a connection failure is a sanitized code — no URL, host or address in any error message', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const sf = client({ port: deadPort });
    const err = await post(sf, 'https://rail.example/settle').catch((e: Error) => e);
    expect((err as Error).message).toBe('settlement_fetch_failed:ECONNREFUSED');
  });

  it('a TLS certificate mismatch is a sanitized code as well', async () => {
    // The fixture has no SAN for this name — Node's hostname check fails.
    const sf = client();
    const err = await post(sf, 'https://nosan.example/settle').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^settlement_fetch_failed:[A-Z0-9_]+$/);
    expect((err as Error).message).not.toContain('nosan');
  });

  it('non-string bodies are refused with a fixed code (no partial send)', async () => {
    const sf = client();
    await expect(sf('https://rail.example/settle', { method: 'POST', body: new FormData() })).rejects.toThrow('settlement_fetch_failed:unsupported_body');
    expect(connections).toBe(0);
  });
});

describe('safeFetch — review follow-ups (PR #280)', () => {
  it('a header value Node rejects at request() time, WITH a signal set, is a fixed code (no TDZ ReferenceError)', async () => {
    // "\x01" passes undici's Headers but http.request() throws ERR_INVALID_CHAR synchronously.
    const err = await client()('https://rail.example/settle', {
      method: 'POST',
      headers: { 'x-signature': 'bad\x01value' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('settlement_fetch_failed:ERR_INVALID_CHAR');
    expect(connections).toBe(0);
  });

  it('a header value undici rejects is a fixed code too — never the echoed value', async () => {
    const err = await client()('https://rail.example/settle', {
      method: 'POST',
      headers: { 'x-signature': 'bad\x00value' },
      body: '{}',
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe('settlement_fetch_failed:invalid_request');
    expect((err as Error).message).not.toContain('bad');
  });

  it('a reason phrase with a control character does not throw in the Response constructor', async () => {
    handler = (req) => {
      req.socket.write('HTTP/1.1 200 a\x01b\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}');
      req.socket.end();
    };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('');
    expect(await res.json()).toEqual({});
  });

  it('a well-formed reason phrase is kept', async () => {
    handler = (_req, res) => { res.writeHead(202, 'Accepted Later'); res.end(); };
    const res = await post(client(), 'https://rail.example/settle');
    expect(res.statusText).toBe('Accepted Later');
  });

  it("Node's lookup hints (ADDRCONFIG) reach the resolver", async () => {
    const resolve = vi.fn(async (_host: string, _opts?: { hints?: number }) => loopback);
    await post(client({ resolve }), 'https://rail.example/settle');
    expect(resolve).toHaveBeenCalledTimes(1);
    const opts = resolve.mock.calls[0][1];
    expect(typeof opts?.hints).toBe('number');
    expect((opts!.hints! & dns.ADDRCONFIG) !== 0).toBe(true);
  });

  it('defaultResolve threads hints into dns.promises.lookup with all: true (mocked; no real DNS)', async () => {
    const spy = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    try {
      const out = await defaultResolve('rail.example', { hints: dns.ADDRCONFIG });
      expect(spy).toHaveBeenCalledWith('rail.example', { all: true, hints: dns.ADDRCONFIG });
      expect(out).toEqual([{ address: '93.184.216.34', family: 4 }]);
      await defaultResolve('rail.example');
      expect(spy).toHaveBeenLastCalledWith('rail.example', { all: true, hints: undefined });
    } finally {
      spy.mockRestore();
    }
  });
});
