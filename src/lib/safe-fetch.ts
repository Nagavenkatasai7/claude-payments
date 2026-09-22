// safe-fetch — the ONLY client that may carry a settlement / reverse
// instruction (decrypted payout destination + recipient legal name) to a
// partner-settable URL (Program-Fix 22, findings authz-04 / rail-13 / F69).
//
// It has fetch's signature so it drops into WorkerDeps.fetchFn unchanged, but
// it is built on node:https (node:http only for the local-dev app origin):
//   • the SYNC rule (settlement-url.ts) runs on the URL and on every redirect;
//   • a CONNECT-TIME `lookup` validates the address actually dialled — every
//     resolved address must be global unicast, so a DNS answer that flips to a
//     private range between "check" and "connect" cannot be exploited
//     (there is no separate pre-resolution to rebind against). SNI and the
//     certificate check keep using the hostname. Option `lookup` on
//     http.RequestOptions: node_modules/@types/node/http.d.ts:222; the
//     LookupFunction shape (single-address AND all:true callback forms):
//     node_modules/@types/node/net.d.ts:20; docs
//     https://nodejs.org/docs/latest-v22.x/api/http.html#httprequesturl-options-callback;
//   • redirects are MANUAL: at most 2, only 307/308 (method + body kept),
//     same origin only, each re-checked sync and at connect. 301/302/303 are
//     refused — a signed POST must never turn into a GET;
//   • `Accept-Encoding: identity` is sent and nothing is decompressed; the ack
//     body is capped at MAX_ACK_BYTES on the wire;
//   • it honours init.signal, so the caller's AbortSignal.timeout bounds the
//     whole chain, and rejects with the signal's reason like global fetch;
//   • every error is a FIXED code — `settlement_url_refused:<reason>` for a
//     refusal, `settlement_fetch_failed:<code>` for a network/TLS failure —
//     because these strings ride into outbox.last_error and ops alerts. Node's
//     own messages (`getaddrinfo ENOTFOUND <host>`, `connect ECONNREFUSED
//     <ip>:<port>`) are never surfaced.
//
// The default `safeFetch` resolves with dns.promises.lookup(host, { all: true })
// (node_modules/@types/node/dns.d.ts:104 LookupAllOptions). Tests inject a
// resolver, a predicate and a CA through createSafeFetch(); no test touches DNS.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { env } from '@/lib/env';
import { checkSettlementUrl, isPublicAddress as defaultIsPublicAddress } from '@/lib/settlement-url';

/** Largest ack body read from a rail, in wire bytes (an ack is `{ providerRef }` or empty). */
export const MAX_ACK_BYTES = 64 * 1024;
/** Same-origin 307/308 hops followed before `redirect_cap`. */
export const MAX_REDIRECTS = 2;

export type ResolvedAddress = { address: string; family: number };
export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchDeps {
  /** Hostname → every address. Default: dns.promises.lookup(host, { all: true }). */
  resolve?: Resolve;
  /** Default env.appBaseUrl (read per call). */
  appOrigin?: string;
  /** Default env.isProduction (read per call). */
  production?: boolean;
  // ── Test seams: the local-server suite needs loopback to be dialable and a
  // self-signed CA trusted. The default export never sets them. ──
  isPublicAddress?: (ip: string) => boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  /** Dial port override (the URL rule still requires the default port). */
  port?: number;
}

const REFUSAL = Symbol('settlement_url_refusal');

function refused(reason: string): Error {
  const err = new Error(`settlement_url_refused:${reason}`);
  (err as Error & { [REFUSAL]?: string })[REFUSAL] = reason;
  return err;
}

function isRefusal(err: unknown): err is Error {
  return err instanceof Error && (err as Error & { [REFUSAL]?: string })[REFUSAL] !== undefined;
}

/** Node's network/TLS errors carry the host or address in their message — keep the code only. */
function sanitized(err: unknown): Error {
  if (isRefusal(err)) return err;
  const raw = (err as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(raw) ? raw : 'unknown';
  return new Error(`settlement_fetch_failed:${code}`);
}

const defaultResolve: Resolve = async (hostname) => {
  const all = await dns.promises.lookup(hostname, { all: true });
  return all.map((a) => ({ address: a.address, family: a.family }));
};

interface Hop {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyToBuffer(body: BodyInit | null | undefined): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error('settlement_fetch_failed:unsupported_body');
}

export function createSafeFetch(deps: SafeFetchDeps = {}): typeof fetch {
  const resolve = deps.resolve ?? defaultResolve;
  const isPublicAddress = deps.isPublicAddress ?? defaultIsPublicAddress;
  // keepAlive OFF: every hop dials afresh, so every hop's lookup runs and the
  // pool can never hand a later request a socket validated for an earlier one.
  const httpsAgent = new https.Agent({ keepAlive: false });
  const httpAgent = new http.Agent({ keepAlive: false });

  // The validating lookup. net.connect calls it with { all: true } under
  // autoSelectFamily (Node ≥ 20) and with the single-address form otherwise;
  // both callback shapes are served. A private address anywhere in the answer
  // fails the WHOLE connect: no address of that answer is ever dialled.
  const lookup: LookupFunction = (hostname, options, callback) => {
    const want = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
    resolve(hostname).then(
      (addrs) => {
        const usable = addrs.filter((a) => want === 0 || a.family === want);
        if (usable.length === 0) {
          callback(Object.assign(new Error('lookup: no address'), { code: 'ENOTFOUND' }), []);
          return;
        }
        if (!usable.every((a) => isPublicAddress(a.address))) {
          callback(refused('private_address'), []);
          return;
        }
        if (options.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error('lookup failed');
        if (!(e as { code?: unknown }).code) Object.assign(e, { code: 'ENOTFOUND' });
        callback(e, []);
      },
    );
  };

  function hop(
    url: URL,
    devAppOrigin: boolean,
    method: string,
    headers: Record<string, string>,
    body: Buffer | null,
    signal: AbortSignal | undefined,
  ): Promise<Hop> {
    return new Promise<Hop>((resolveHop, rejectHop) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const fail = (err: unknown) => settle(() => rejectHop(sanitized(err)));
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;
      const options: https.RequestOptions = {
        method,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: deps.port ?? (url.port !== '' ? Number(url.port) : isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        // Host is the URL's own host (never derived from the dial port).
        headers: { ...headers, host: url.host },
        agent: isHttps ? httpsAgent : httpAgent,
        // Invariant 5: the local-dev app origin (localhost → 127.0.0.1) skips
        // the address check; every other request resolves through `lookup`.
        ...(devAppOrigin ? {} : { lookup }),
        ...(isHttps && deps.ca !== undefined ? { ca: deps.ca } : {}),
      };
      let req: http.ClientRequest;
      try {
        req = mod.request(options);
      } catch (err) {
        fail(err); // a sync throw (bad path/header char) is sanitized like any other failure
        return;
      }
      const onAbort = () => {
        req.destroy();
        settle(() => rejectHop(signal?.reason ?? new Error('settlement_fetch_failed:aborted')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', fail);
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_ACK_BYTES) {
          res.destroy();
          req.destroy();
          fail(refused('body_too_large'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_ACK_BYTES) {
            res.destroy();
            req.destroy();
            fail(refused('body_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('close', () => {
          if (!res.complete) fail(Object.assign(new Error('response truncated'), { code: 'ECONNRESET' }));
        });
        res.on('end', () => {
          settle(() =>
            resolveHop({
              status,
              statusText: res.statusMessage ?? '',
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        });
      });
      if (body) req.end(body);
      else req.end();
    });
  }

  return async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const appOrigin = deps.appOrigin ?? env.appBaseUrl;
    const production = deps.production ?? env.isProduction;
    const signal = init?.signal ?? undefined;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = bodyToBuffer(init?.body);
    const headers = headersToRecord(init?.headers);
    delete headers.host;
    headers['accept-encoding'] = 'identity';
    if (body) headers['content-length'] = String(body.length);

    let current = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let redirects = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('settlement_fetch_failed:aborted');
      const check = checkSettlementUrl(current, { appOrigin, production });
      if (!check.ok) throw refused(check.reason);
      const r = await hop(check.url, check.appOrigin, method, headers, body, signal);

      if (r.status === 307 || r.status === 308) {
        if (redirects >= MAX_REDIRECTS) throw refused('redirect_cap');
        const location = r.headers.location;
        if (typeof location !== 'string' || location === '') throw refused('redirect_invalid');
        let next: URL;
        try {
          next = new URL(location, check.url);
        } catch {
          throw refused('redirect_invalid');
        }
        // The next hop is re-checked by the loop (sync, then at connect); the
        // origin compare runs on top so a valid public host still cannot pull
        // the signed body off the configured rail.
        const nextCheck = checkSettlementUrl(next.href, { appOrigin, production });
        if (!nextCheck.ok) throw refused(nextCheck.reason);
        if (next.origin !== check.url.origin) throw refused('redirect_cross_origin');
        redirects += 1;
        current = next.href;
        continue;
      }
      if (r.status === 301 || r.status === 302 || r.status === 303) throw refused('redirect_method');
      // 1xx never reaches 'response' (node:http keeps waiting after 100/103),
      // and a status outside Response's range would throw in its constructor.
      if (r.status < 200 || r.status > 599) throw refused('unexpected_status');

      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(r.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
        else responseHeaders.append(key, value);
      }
      // new Response('', { status: 204 | 205 | 304 }) throws (checked on Node
      // 26.8.1); those statuses are built with a null body.
      const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
      // A fresh Uint8Array (ArrayBuffer-backed) satisfies BodyInit; ≤64 KB copy.
      return new Response(nullBody ? null : new Uint8Array(r.body), {
        status: r.status,
        statusText: r.statusText,
        headers: responseHeaders,
      });
    }
  };
}

/** Production wiring: real DNS, real predicate, system CAs. */
export const safeFetch: typeof fetch = createSafeFetch();
