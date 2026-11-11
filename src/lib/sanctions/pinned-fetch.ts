// Fix pack 5 list review L1-LF3 (LB6, LB4): the bounded download the NEW list
// loaders use (UN SC, un-sc-loader.ts; OFAC consolidated, ofac-cons-loader.ts).
// The SDN loader keeps fetchSlsExport (ofac-sdn-loader.ts) unchanged and never
// calls this file.
//
// Redirects (LB6): fetch is asked with redirect 'manual' and each hop is
// checked BEFORE it is requested: the Location is resolved against the URL
// that answered and must pass the loader's own `allowedUrl` (https on its
// pinned hosts). At most MAX_REDIRECT_HOPS hops. Node's fetch (undici, Node 22)
// answers a 3xx under redirect 'manual' with the real status and a readable
// Location header (type 'basic', not a browser's opaque redirect): checked
// against a node:http server on 127.0.0.1 on 2026-11-11.
//
// Size (LB4): the body is read from its stream and the byte count is checked
// per chunk, so a missing or false Content-Length cannot make the loader
// buffer past the cap. The bytes are decoded as UTF-8 once the read is done.
// The one abort signal covers every hop and the body read.
//
// Errors read '<label> fetch failed: ...' and never carry a URL (the UN blob
// URL carries a signed query).

/** Redirect hops followed before the download is refused. */
export const MAX_REDIRECT_HOPS = 3;

const USER_AGENT = 'SmartRemit-sanctions-loader/1.0 (+https://smartremit.ai)';
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface PinnedFetchOptions {
  /** Error prefix, e.g. 'UN SC' -> 'UN SC fetch failed: ...'. */
  label: string;
  /** Byte cap on the body. */
  maxBytes: number;
  /** One timeout for every hop and the body read. */
  timeoutMs: number;
  /** True only for an https URL on a host this loader trusts. */
  allowedUrl: (raw: string) => boolean;
}

/** Drop a body we will not read; a stub may have none. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/**
 * Read a response body with a byte cap: stops and cancels the stream as soon
 * as the count passes `maxBytes`, then decodes UTF-8 (BOM dropped, invalid
 * bytes replaced, as Response.text() does). A stub without a body is read
 * through arrayBuffer() with the same byte check.
 */
export async function readCappedText(res: Response, maxBytes: number, label: string): Promise<string> {
  const tooLarge = () => new Error(`${label} fetch failed: body too large`);
  let bytes: Uint8Array;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
  } else {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw tooLarge();
    bytes = new Uint8Array(buf);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Download `url` with the User-Agent, one abort signal, hand-followed pinned
 * redirects and a streamed byte cap. Returns the body text; the caller parses
 * it. A stub without res.url is a test (the final-URL check is skipped, as in
 * fetchSlsExport).
 */
export async function fetchPinnedText(url: string, fetchImpl: typeof fetch, opts: PinnedFetchOptions): Promise<string> {
  const { label, maxBytes, allowedUrl } = opts;
  const badHost = () => new Error(`${label} fetch failed: unexpected host after redirect`);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = url;
  let hops = 0;
  let res: Response;
  for (;;) {
    res = await fetchImpl(current, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUSES.has(res.status)) break;
    await discard(res);
    if (hops >= MAX_REDIRECT_HOPS) throw badHost();
    const location = res.headers?.get?.('location');
    if (!location) throw badHost();
    let next: string;
    try {
      const n = new URL(location, current);
      // L1-LR1 (LF3-D1): a Location with userinfo is refused here; undici
      // would throw a TypeError carrying the full URL (and its signed query).
      if (n.username || n.password) throw badHost();
      next = n.href;
    } catch {
      throw badHost();
    }
    if (!allowedUrl(next)) throw badHost();
    current = next;
    hops += 1;
  }
  if (!res.ok) {
    await discard(res);
    throw new Error(`${label} fetch failed: HTTP ${res.status}`);
  }
  if (res.url && !allowedUrl(res.url)) {
    await discard(res);
    throw badHost();
  }
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw new Error(`${label} fetch failed: body too large`);
  }
  return readCappedText(res, maxBytes, label);
}
