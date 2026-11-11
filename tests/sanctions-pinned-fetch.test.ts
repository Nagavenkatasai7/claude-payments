// Fix pack 5 list review L1-LF3 (LB6, LB4): the pinned, capped download the
// NEW list loaders (UN SC, OFAC consolidated) use. The SDN loader keeps its own
// fetchSlsExport and is not covered here. Nothing touches the network: fetch
// is a stub that records every URL it is asked for.
import { describe, it, expect, vi } from 'vitest';
import { fetchPinnedText, readCappedText, MAX_REDIRECT_HOPS } from '@/lib/sanctions/pinned-fetch';

const START = 'https://lists.example.test/start.xml';
const allowedUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'lists.example.test' || u.hostname === 'files.example.test');
  } catch {
    return false;
  }
};
const OPTS = { label: 'TEST', maxBytes: 1000, timeoutMs: 5000, allowedUrl };
const BAD_HOST = 'TEST fetch failed: unexpected host after redirect';

type Answer = { status: number; location?: string | null; body?: string };
/** A stub fetch answering from `routes`; unknown URLs answer 404. Records every call. */
function stub(routes: Record<string, Answer>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    void _init;
    const a = routes[url] ?? { status: 404 };
    const headers = new Headers();
    if (a.location) headers.set('location', a.location);
    // A real Response: 3xx answers carry no body here, like a bare redirect.
    return new Response(a.status >= 300 && a.status < 400 ? null : (a.body ?? ''), { status: a.status, headers });
  });
}
const calledUrls = (f: ReturnType<typeof stub>) => f.mock.calls.map((c) => c[0]);
const message = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message,
  );

describe('fetchPinnedText: redirects followed by hand (LB6)', () => {
  it('asks with redirect manual, the same abort signal on every hop, and follows allowed https hops (relative and absolute)', async () => {
    const f = stub({
      [START]: { status: 302, location: '/next.xml?sig=secret' },
      'https://lists.example.test/next.xml?sig=secret': { status: 307, location: 'https://files.example.test/final.xml?sig=secret2' },
      'https://files.example.test/final.xml?sig=secret2': { status: 200, body: '<ok/>' },
    });
    await expect(fetchPinnedText(START, f as unknown as typeof fetch, OPTS)).resolves.toBe('<ok/>');
    expect(calledUrls(f)).toEqual([
      START,
      'https://lists.example.test/next.xml?sig=secret',
      'https://files.example.test/final.xml?sig=secret2',
    ]);
    const inits = f.mock.calls.map((c) => c[1] as RequestInit);
    expect(inits.every((i) => i.redirect === 'manual')).toBe(true);
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
    expect(inits.every((i) => i.signal === inits[0].signal)).toBe(true);
  });

  it.each([
    ['an internal http address', 'http://169.254.169.254/latest/meta-data/'],
    ['an internal https address', 'https://169.254.169.254/latest/meta-data/'],
    ['http on an allowed host', 'http://files.example.test/final.xml'],
    ['another host', 'https://evil.example/final.xml'],
    ['a look-alike host', 'https://files.example.test.evil.example/final.xml'],
    ['a protocol-relative other host', '//evil.example/x'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('refuses a hop to %s and never requests it', async (_what, location) => {
    const f = stub({ [START]: { status: 302, location }, [location]: { status: 200, body: '<ok/>' } });
    await expect(message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS))).resolves.toBe(BAD_HOST);
    expect(calledUrls(f)).toEqual([START]);
  });

  it('refuses a redirect with no Location', async () => {
    const f = stub({ [START]: { status: 301, location: null } });
    await expect(message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS))).resolves.toBe(BAD_HOST);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it(`follows at most ${MAX_REDIRECT_HOPS} hops; a fourth redirect fails and is never requested`, async () => {
    expect(MAX_REDIRECT_HOPS).toBe(3);
    const hop = (n: number) => `https://lists.example.test/h${n}`;
    const three = stub({
      [START]: { status: 302, location: hop(1) },
      [hop(1)]: { status: 302, location: hop(2) },
      [hop(2)]: { status: 302, location: hop(3) },
      [hop(3)]: { status: 200, body: 'three' },
    });
    await expect(fetchPinnedText(START, three as unknown as typeof fetch, OPTS)).resolves.toBe('three');
    const four = stub({
      [START]: { status: 302, location: hop(1) },
      [hop(1)]: { status: 302, location: hop(2) },
      [hop(2)]: { status: 302, location: hop(3) },
      [hop(3)]: { status: 302, location: hop(4) },
      [hop(4)]: { status: 200, body: 'four' },
    });
    await expect(message(fetchPinnedText(START, four as unknown as typeof fetch, OPTS))).resolves.toBe(BAD_HOST);
    expect(calledUrls(four)).not.toContain(hop(4));
  });

  it('never prints a URL or its query string in the error', async () => {
    const f = stub({ [START]: { status: 302, location: 'https://evil.example/x?sig=signed-secret' } });
    const msg = await message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS));
    expect(msg).toBe(BAD_HOST);
    expect(msg).not.toMatch(/sig|evil|https?:/);
  });

  it('a non-redirect non-2xx answer is an HTTP fetch error', async () => {
    const f = stub({ [START]: { status: 503 } });
    await expect(message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS))).resolves.toBe('TEST fetch failed: HTTP 503');
  });

  it('a final res.url off the allowed hosts is still refused (a stub without res.url is a test)', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, url: 'https://evil.example/x', headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(1) }));
    await expect(message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS))).resolves.toBe(BAD_HOST);
  });

  it('a declared Content-Length over the cap is refused before the body is read', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '1001' }), body: null, arrayBuffer }));
    await expect(message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS))).resolves.toBe('TEST fetch failed: body too large');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

/** A stream of `chunks` chunks of `size` 'a' bytes that counts pulls and notes a cancel. */
function countingStream(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(new Uint8Array(size).fill(97));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe('readCappedText: the byte cap applies while the body streams (LB4)', () => {
  it('refuses an oversized streamed body with no Content-Length and cancels the stream before its end', async () => {
    const { stream, state } = countingStream(100, 64);
    const res = new Response(stream);
    expect(res.headers.get('content-length')).toBeNull();
    await expect(message(readCappedText(res, 1000, 'TEST'))).resolves.toBe('TEST fetch failed: body too large');
    expect(state.cancelled).toBe(true);
    // 1000 bytes cap / 64-byte chunks: the 16th chunk passes the cap.
    expect(state.pulled).toBeLessThan(20);
  });

  it('a Content-Length that lies does not lift the cap (through fetchPinnedText)', async () => {
    const { stream, state } = countingStream(100, 64);
    const f = vi.fn(async () => new Response(stream, { headers: { 'content-length': '10' } }));
    await expect(message(fetchPinnedText(START, f as unknown as typeof fetch, OPTS))).resolves.toBe('TEST fetch failed: body too large');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(20);
  });

  it('a body of exactly the cap passes; one byte more fails', async () => {
    const exact = 'x'.repeat(1000);
    await expect(readCappedText(new Response(exact), 1000, 'TEST')).resolves.toBe(exact);
    await expect(message(readCappedText(new Response(`${exact}x`), 1000, 'TEST'))).resolves.toBe('TEST fetch failed: body too large');
  });

  it('counts bytes, not UTF-16 units, and decodes UTF-8 across chunk boundaries', async () => {
    // 'é' is 2 bytes and 1 UTF-16 unit: 600 of them are 1200 bytes, over a 1000-byte cap.
    await expect(message(readCappedText(new Response('é'.repeat(600)), 1000, 'TEST'))).resolves.toBe('TEST fetch failed: body too large');
    // 500 of them are exactly 1000 bytes; split the bytes mid-character over two chunks.
    const bytes = new TextEncoder().encode('é'.repeat(500));
    const split = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 501));
        c.enqueue(bytes.slice(501));
        c.close();
      },
    });
    await expect(readCappedText(new Response(split), 1000, 'TEST')).resolves.toBe('é'.repeat(500));
  });

  it('a stub without a body falls back to arrayBuffer with the same byte check', async () => {
    const asBuffer = (s: string) => ({ body: null, arrayBuffer: async () => new TextEncoder().encode(s).buffer }) as unknown as Response;
    await expect(readCappedText(asBuffer('é'.repeat(500)), 1000, 'TEST')).resolves.toBe('é'.repeat(500));
    await expect(message(readCappedText(asBuffer('é'.repeat(501)), 1000, 'TEST'))).resolves.toBe('TEST fetch failed: body too large');
  });
});
