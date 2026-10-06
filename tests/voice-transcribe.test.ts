import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  oggOpusInfo,
  isOggOpusMime,
  isAllowedMediaUrl,
  azureSttUrl,
  transcribeVoiceNote,
  VOICE_MAX_BYTES,
  type TranscribeDeps,
} from '@/lib/voice-transcribe';
import { VOICE_MIN_CONFIDENCE } from '@/lib/voice-notes';
import { GRAPH_VERSION } from '@/lib/whatsapp';

// Step 1 voice notes: Meta media download + Azure AI Speech short-audio STT.
// Ogg fixtures are built in the test (no binary files). fetch is stubbed; the
// key and token are obvious fakes.

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // the worker.voice log lines
});
afterEach(() => vi.restoreAllMocks());

// ── Ogg builder (RFC 3533 page layout; RFC 7845 OpusHead) ────────────────────
function oggPage(o: { serial?: number; granule?: bigint; headerType?: number; packet: Uint8Array; seq?: number }): Uint8Array {
  const segs: number[] = [];
  let n = o.packet.length;
  while (n >= 255) { segs.push(255); n -= 255; }
  segs.push(n);
  const out = new Uint8Array(27 + segs.length + o.packet.length);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[4] = 0; // version
  out[5] = o.headerType ?? 0;
  dv.setBigInt64(6, o.granule ?? 0n, true);
  dv.setUint32(14, o.serial ?? 0x1234, true);
  dv.setUint32(18, o.seq ?? 0, true);
  out[26] = segs.length;
  out.set(segs, 27);
  out.set(o.packet, 27 + segs.length);
  return out;
}

function opusHead(preSkip = 312, inputRate = 16000, channels = 1): Uint8Array {
  const p = new Uint8Array(19);
  p.set(new TextEncoder().encode('OpusHead'), 0);
  p[8] = 1;
  p[9] = channels;
  const dv = new DataView(p.buffer);
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputRate, true);
  return p;
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** A minimal Ogg/Opus voice note of `seconds` (48 kHz granule clock). */
function oggOpus(seconds: number, o: { preSkip?: number; extra?: Uint8Array[] } = {}): Uint8Array<ArrayBuffer> {
  const preSkip = o.preSkip ?? 312;
  return concat(
    oggPage({ headerType: 0x02, packet: opusHead(preSkip), seq: 0 }),
    oggPage({ packet: new TextEncoder().encode('OpusTags\0\0\0\0'), seq: 1 }),
    ...(o.extra ?? []),
    oggPage({ headerType: 0x04, granule: BigInt(Math.round(seconds * 48000) + preSkip), packet: new Uint8Array(40), seq: 2 }),
  );
}

describe('oggOpusInfo', () => {
  it('reads the duration from the last page granule, pre-skip subtracted', () => {
    expect(oggOpusInfo(oggOpus(1))?.seconds).toBeCloseTo(1, 3);
    expect(oggOpusInfo(oggOpus(31))?.seconds).toBeCloseTo(31, 3);
    expect(oggOpusInfo(oggOpus(2, { preSkip: 3840 }))?.seconds).toBeCloseTo(2, 3);
    expect(oggOpusInfo(oggOpus(1))).toMatchObject({ inputRate: 16000, channels: 1 });
  });

  it('an "OggS" inside packet data is not a page (pages are walked, not searched)', () => {
    const fake = oggPage({ granule: 999_999_999n, packet: new Uint8Array(0) });
    const data = oggPage({ granule: 48000n + 312n, packet: concat(new Uint8Array(10), fake), seq: 2 });
    const b = concat(oggPage({ headerType: 0x02, packet: opusHead() }), data);
    expect(oggOpusInfo(b)?.seconds).toBeCloseTo(1, 3);
  });

  it('pages with granule -1 and pages of another stream are skipped', () => {
    const b = concat(
      oggOpus(3),
      oggPage({ granule: -1n, packet: new Uint8Array(5) }),
      oggPage({ serial: 0x9999, granule: 48000n * 100n, packet: new Uint8Array(5) }),
    );
    expect(oggOpusInfo(b)?.seconds).toBeCloseTo(3, 3);
  });

  it('non-Ogg, no OpusHead, a truncated page, a bad version or no granule ⇒ null', () => {
    expect(oggOpusInfo(new TextEncoder().encode('ID3 this is an mp3'))).toBeNull();
    expect(oggOpusInfo(new Uint8Array(0))).toBeNull();
    expect(oggOpusInfo(concat(oggPage({ headerType: 0x02, packet: new TextEncoder().encode('Speex   xxxxxxxxxxx') }), oggPage({ granule: 48000n, packet: new Uint8Array(4) })))).toBeNull();
    const good = oggOpus(1);
    expect(oggOpusInfo(good.slice(0, good.length - 5))).toBeNull();
    const badVersion = good.slice();
    badVersion[4] = 1;
    expect(oggOpusInfo(badVersion)).toBeNull();
    expect(oggOpusInfo(oggPage({ headerType: 0x02, packet: opusHead() }))).toBeNull();
  });
});

describe('isOggOpusMime / isAllowedMediaUrl / azureSttUrl', () => {
  it('only WhatsApp Ogg/Opus audio', () => {
    expect(isOggOpusMime('audio/ogg; codecs=opus')).toBe(true);
    expect(isOggOpusMime('audio/ogg')).toBe(true);
    expect(isOggOpusMime('audio/ogg;codecs=opus')).toBe(true);
    for (const m of ['', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/ogg; codecs=vorbis', 'video/ogg', 'audio/oggx']) {
      expect(isOggOpusMime(m), m).toBe(false);
    }
  });

  it('the download host is exactly lookaside.fbsbx.com over https', () => {
    expect(isAllowedMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&ext=2')).toBe(true);
    for (const u of [
      'http://lookaside.fbsbx.com/x',
      'https://lookaside.fbsbx.com.evil.example/x',
      'https://evil.example/lookaside.fbsbx.com',
      'https://user:pw@lookaside.fbsbx.com/x',
      'https://lookaside.fbsbx.com:8443/x',
      'https://xlookaside.fbsbx.com/x',
      'not a url',
      '',
    ]) expect(isAllowedMediaUrl(u), u).toBe(false);
  });

  it('the Azure short-audio URL: regional stt host, language and detailed format', () => {
    expect(azureSttUrl('eastus', 'en-IN')).toBe(
      'https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-IN&format=detailed',
    );
    expect(azureSttUrl('westus2', 'en-US')).toContain('language=en-US');
  });
});

// ── transcribeVoiceNote with a stubbed fetch ─────────────────────────────────
const MEDIA_ID = '777000111';
const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=777000111&ext=1';
const GRAPH_TOKEN = 'fake-graph-bearer';
const SPEECH_KEY = 'fake-speech-key';

type Reply = Response | Error;
interface Script { meta?: Reply[]; audio?: Reply[]; azure?: Reply[] }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const metaOk = (over: Record<string, unknown> = {}) =>
  json({ messaging_product: 'whatsapp', url: LOOKASIDE, mime_type: 'audio/ogg; codecs=opus', sha256: 'x', file_size: '2048', id: MEDIA_ID, ...over });
const azureOk = (display = 'Send 100 dollars to Mom', confidence = 0.92) =>
  json({ RecognitionStatus: 'Success', Offset: 0, Duration: 10_000_000, NBest: [{ Confidence: confidence, Display: display, Lexical: 'x', ITN: 'x', MaskedITN: 'x' }] });

function harness(script: Script, over: Partial<TranscribeDeps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queues = { meta: [...(script.meta ?? [metaOk()])], audio: [...(script.audio ?? [new Response(oggOpus(4))])], azure: [...(script.azure ?? [azureOk()])] };
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const q = url.startsWith('https://graph.facebook.com/') ? queues.meta : url.startsWith('https://lookaside.fbsbx.com/') ? queues.audio : queues.azure;
    const next = q.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  const deps: TranscribeDeps = {
    fetchFn: fetchFn as unknown as typeof fetch,
    graphToken: GRAPH_TOKEN,
    phoneNumberId: '1098765432',
    speech: { key: SPEECH_KEY, region: 'eastus', language: 'en-IN' },
    sleep: async () => {},
    ...over,
  };
  return { deps, calls, fetchFn };
}

const REF = { id: MEDIA_ID, mimeType: 'audio/ogg; codecs=opus' };
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe('transcribeVoiceNote', () => {
  it('happy path: Graph media lookup → lookaside download → Azure; secrets only go where they belong', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, calls } = harness({});
    const out = await transcribeVoiceNote(REF, deps);
    expect(out).toEqual({ kind: 'ok', transcript: 'Send 100 dollars to Mom' });

    expect(calls.map((c) => c.url)).toEqual([
      `https://graph.facebook.com/${GRAPH_VERSION}/${MEDIA_ID}?phone_number_id=1098765432`,
      LOOKASIDE,
      'https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-IN&format=detailed',
    ]);
    const [meta, audio, azure] = calls;
    expect(header(meta.init, 'authorization')).toBe(`Bearer ${GRAPH_TOKEN}`);
    expect(header(audio.init, 'authorization')).toBe(`Bearer ${GRAPH_TOKEN}`);
    expect(audio.init.redirect).toBe('error');
    expect(azure.init.method).toBe('POST');
    expect(header(azure.init, 'ocp-apim-subscription-key')).toBe(SPEECH_KEY);
    expect(header(azure.init, 'content-type')).toBe('audio/ogg; codecs=opus');
    expect(header(azure.init, 'accept')).toBe('application/json');
    expect(header(azure.init, 'authorization')).toBeNull(); // the Graph token never reaches Azure
    expect(JSON.stringify(meta.init) + JSON.stringify(audio.init)).not.toContain(SPEECH_KEY);
    expect(new Uint8Array(azure.init.body as Uint8Array)).toEqual(oggOpus(4)); // raw Ogg/Opus, no transcoding
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);

    // One log line: outcome and numbers only. Never the transcript, media id, URL or a secret.
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('worker.voice'));
    expect(lines).toHaveLength(1);
    for (const secret of ['Mom', MEDIA_ID, 'lookaside', GRAPH_TOKEN, SPEECH_KEY]) expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain('"msg":"ok"');
  });

  it('a non-Ogg mime type is unsupported before any fetch', async () => {
    const { deps, fetchFn } = harness({});
    expect(await transcribeVoiceNote({ id: MEDIA_ID, mimeType: 'audio/mpeg' }, deps)).toEqual({ kind: 'unsupported' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Graph metadata: id mismatch or no url ⇒ failed; a non-Ogg mime ⇒ unsupported; too big ⇒ too_long; nothing downloaded', async () => {
    for (const [over, kind] of [
      [{ id: '1' }, 'failed'],
      [{ url: 7 }, 'failed'],
      [{ mime_type: 'audio/mpeg' }, 'unsupported'],
      [{ file_size: String(VOICE_MAX_BYTES + 1) }, 'too_long'],
      [{ file_size: VOICE_MAX_BYTES + 1 }, 'too_long'],
    ] as const) {
      const { deps, calls } = harness({ meta: [metaOk(over)] });
      expect((await transcribeVoiceNote(REF, deps)).kind, JSON.stringify(over)).toBe(kind);
      expect(calls).toHaveLength(1);
    }
  });

  it('a download URL on another host is refused: the token is never sent there', async () => {
    const { deps, calls } = harness({ meta: [metaOk({ url: 'https://evil.example/a.ogg' })] });
    expect(await transcribeVoiceNote(REF, deps)).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(1);
  });

  it('Graph 4xx is final; Graph 5xx or a network error is retried once', async () => {
    const a = harness({ meta: [json({ error: {} }, 404)] });
    expect(await transcribeVoiceNote(REF, a.deps)).toEqual({ kind: 'failed' });
    expect(a.calls).toHaveLength(1);

    const b = harness({ meta: [json({}, 500), metaOk()] });
    expect((await transcribeVoiceNote(REF, b.deps)).kind).toBe('ok');

    const c = harness({ meta: [new TypeError('fetch failed'), metaOk()] });
    expect((await transcribeVoiceNote(REF, c.deps)).kind).toBe('ok');

    const d = harness({ meta: [json({}, 503), json({}, 503)] });
    expect(await transcribeVoiceNote(REF, d.deps)).toEqual({ kind: 'failed' });
    expect(d.calls).toHaveLength(2);
  });

  it('download caps: Content-Length or the streamed size over VOICE_MAX_BYTES ⇒ too_long, Azure never called', async () => {
    const big = new Uint8Array(VOICE_MAX_BYTES + 10);
    const a = harness({ audio: [new Response(new Uint8Array(10), { headers: { 'content-length': String(VOICE_MAX_BYTES + 1) } })] });
    expect(await transcribeVoiceNote(REF, a.deps)).toEqual({ kind: 'too_long' });
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) { for (let i = 0; i < big.length; i += 65536) ctl.enqueue(big.slice(i, i + 65536)); ctl.close(); },
    });
    const b = harness({ audio: [new Response(stream)] });
    expect(await transcribeVoiceNote(REF, b.deps)).toEqual({ kind: 'too_long' });
    expect(b.calls.some((c) => c.url.includes('speech.microsoft.com'))).toBe(false);
  });

  it('a note over 30 s is too_long and is not sent to Azure (not billed); unparseable audio is unsupported', async () => {
    const a = harness({ audio: [new Response(oggOpus(31))] });
    expect(await transcribeVoiceNote(REF, a.deps)).toEqual({ kind: 'too_long' });
    expect(a.calls).toHaveLength(2);
    const ok = harness({ audio: [new Response(oggOpus(30.2))] });
    expect((await transcribeVoiceNote(REF, ok.deps)).kind).toBe('ok'); // 0.5 s grace
    const b = harness({ audio: [new Response(new Uint8Array(new TextEncoder().encode('not ogg at all')))] });
    expect(await transcribeVoiceNote(REF, b.deps)).toEqual({ kind: 'unsupported' });
    expect(b.calls).toHaveLength(2);
  });

  it('Azure status codes: 401/403 auth_failed, 400 unclear, other 4xx failed (no retry)', async () => {
    for (const [status, want] of [
      [401, { kind: 'auth_failed', status: 401 }],
      [403, { kind: 'auth_failed', status: 403 }],
      [400, { kind: 'unclear' }],
      [404, { kind: 'failed' }],
      [415, { kind: 'failed' }],
    ] as const) {
      const h = harness({ azure: [json({}, status)] });
      expect(await transcribeVoiceNote(REF, h.deps), String(status)).toEqual(want);
      expect(h.calls).toHaveLength(3);
    }
  });

  it('Azure 429 / 5xx / a timeout get ONE retry, then failed', async () => {
    const a = harness({ azure: [json({}, 429), azureOk()] });
    expect((await transcribeVoiceNote(REF, a.deps)).kind).toBe('ok');
    const b = harness({ azure: [json({}, 500), json({}, 502)] });
    expect(await transcribeVoiceNote(REF, b.deps)).toEqual({ kind: 'failed' });
    expect(b.calls).toHaveLength(4);
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const c = harness({ azure: [timeout, azureOk()] });
    expect((await transcribeVoiceNote(REF, c.deps)).kind).toBe('ok');
  });

  it('only one retry per voice note in total', async () => {
    const h = harness({ meta: [json({}, 500), metaOk()], azure: [json({}, 503), azureOk()] });
    expect(await transcribeVoiceNote(REF, h.deps)).toEqual({ kind: 'failed' });
    expect(h.calls).toHaveLength(4);
  });

  it('no retry when the remaining budget cannot fit another try', async () => {
    let t = 0;
    const h = harness({ azure: [json({}, 503), azureOk()] }, { now: () => t, sleep: async () => { t += 100; } });
    const fetchFn = h.deps.fetchFn;
    h.deps.fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('speech.microsoft.com')) t += 13_000; // a slow first Azure call
      return fetchFn(input, init);
    }) as typeof fetch;
    expect(await transcribeVoiceNote(REF, h.deps)).toEqual({ kind: 'failed' });
    expect(h.calls).toHaveLength(3);
  });

  it('RecognitionStatus: NoMatch / silence / babble ⇒ unclear; Error is retried once', async () => {
    for (const status of ['NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout']) {
      const h = harness({ azure: [json({ RecognitionStatus: status })] });
      expect(await transcribeVoiceNote(REF, h.deps), status).toEqual({ kind: 'unclear' });
    }
    const e = harness({ azure: [json({ RecognitionStatus: 'Error' }), azureOk()] });
    expect((await transcribeVoiceNote(REF, e.deps)).kind).toBe('ok');
    const bad = harness({ azure: [new Response('not json', { status: 200 })] });
    expect(await transcribeVoiceNote(REF, bad.deps)).toEqual({ kind: 'failed' });
  });

  it('low confidence, no confidence or empty text ⇒ unclear (the English-only reply)', async () => {
    const low = harness({ azure: [azureOk('send money', VOICE_MIN_CONFIDENCE - 0.01)] });
    expect(await transcribeVoiceNote(REF, low.deps)).toEqual({ kind: 'unclear' });
    const at = harness({ azure: [azureOk('send money', VOICE_MIN_CONFIDENCE)] });
    expect((await transcribeVoiceNote(REF, at.deps)).kind).toBe('ok');
    const none = harness({ azure: [json({ RecognitionStatus: 'Success', DisplayText: 'hi' })] });
    expect(await transcribeVoiceNote(REF, none.deps)).toEqual({ kind: 'unclear' });
    const empty = harness({ azure: [azureOk('   ', 0.99)] });
    expect(await transcribeVoiceNote(REF, empty.deps)).toEqual({ kind: 'unclear' });
  });

  it('the transcript is cleaned: control characters dropped, capped at 2000 characters', async () => {
    const h = harness({ azure: [azureOk('hello\u0000 there\u0007 ' + 'x'.repeat(3000), 0.9)] });
    const out = await transcribeVoiceNote(REF, h.deps);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.transcript.startsWith('hello there ')).toBe(true);
    expect(out.transcript.length).toBe(2000);
  });

  it('an aborted row signal stops the work: failed, no retry', async () => {
    const ctl = new AbortController();
    const h = harness({});
    const fetchFn = h.deps.fetchFn;
    h.deps.fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await fetchFn(input, init);
      ctl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as typeof fetch;
    h.deps.signal = ctl.signal;
    expect(await transcribeVoiceNote(REF, h.deps)).toEqual({ kind: 'failed' });
    expect(h.calls).toHaveLength(1);
  });

  it('results never carry the key, the token or a URL', async () => {
    for (const script of [{}, { azure: [json({}, 401)] }, { meta: [metaOk({ url: 'https://evil.example/' })] }] as Script[]) {
      const h = harness(script);
      const s = JSON.stringify(await transcribeVoiceNote(REF, h.deps));
      for (const secret of [SPEECH_KEY, GRAPH_TOKEN, 'https://', MEDIA_ID]) expect(s).not.toContain(secret);
    }
  });
});
