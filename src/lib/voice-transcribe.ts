import { GRAPH_VERSION, MEDIA_ID_RE } from './whatsapp';
import { logWarn } from './log';
import {
  VOICE_MAX_SECONDS,
  VOICE_MIN_CONFIDENCE,
  type VoiceOutcome,
  type VoiceRef,
} from './voice-notes';

// voice-transcribe — Step 1: one WhatsApp voice note → English text.
//
//   1. Meta Graph: GET /<GRAPH_VERSION>/<MEDIA_ID>?phone_number_id=<PNID> with
//      the shared number's bearer token → { url, mime_type, sha256, file_size,
//      id, messaging_product }. Then GET <url> with the same bearer token.
//      "Media URLs expire after 5 minutes"; a failed download answers 404 and
//      the fix is "get a new media URL and download it again"; webhook media
//      ids expire after 7 days; OGG audio is "audio/ogg (OPUS codecs only …;
//      mono input only)", 16 MB max.
//      https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
//      (fetched 2026-10-05).
//   2. Microsoft Azure AI Speech, "Speech to text REST API for short audio":
//      POST https://<region>.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
//           ?language=<locale>&format=detailed
//      headers Ocp-Apim-Subscription-Key, Content-Type "audio/ogg; codecs=opus",
//      Accept application/json; body = the raw Ogg/Opus bytes (no transcoding).
//      ≤ 60 s of audio. Statuses 200 / 400 (bad language or audio) / 401 (bad
//      key or endpoint) / 403 (no key). Response RecognitionStatus (Success,
//      NoMatch, InitialSilenceTimeout, BabbleTimeout, Error) and, for detailed,
//      NBest[] { Confidence 0..1, Display, Lexical, ITN, MaskedITN }.
//      https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
//      (fetched 2026-10-05; that page shows the resource custom-domain host).
//      The regional host form {region}.stt.speech.microsoft.com is from
//      https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link
//      ("Construct endpoint URL"). 429 = throttled (F0 allows ONE concurrent
//      request; "implement retry logic … to handle 429 errors"):
//      https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
//
// Failure handling (owner decisions 2026-10-05): Azure 401/403 ⇒ auth_failed
// (the worker raises the deduped sttauth alert); 400 ⇒ unclear; 429, 5xx,
// RecognitionStatus Error, a timeout or a network error ⇒ ONE retry inside
// this call (never a row-level retry, which would hold the customer's later
// turns), then failed. A download that fails transiently (incl. Meta's 404)
// is retried from the media lookup, since the URL may have expired.
//
// The bytes live in memory only. One log line per note: the outcome and
// numbers (bytes, seconds, ms, rate, retried, a fixed reason code). Never the
// transcript, media id, URL, phone, key or token.

/** Largest download accepted. A 30 s WhatsApp voice note is far smaller (Opus at ~16-32 kbit/s). */
export const VOICE_MAX_BYTES = 512 * 1024;
/** The whole transcription's hard cap, inside the agent.turn row's 35 s cooperative budget. */
export const VOICE_BUDGET_MS = 14_000;
const META_STEP_MS = 3_000;
const DOWNLOAD_STEP_MS = 4_000;
const AZURE_STEP_MS = 10_000;
const RETRY_DELAY_MS = 500;
const JSON_MAX_BYTES = 64 * 1024;
const TRANSCRIPT_MAX_CHARS = 2_000;
/** Seconds of slack over VOICE_MAX_SECONDS (container rounding). */
const DURATION_GRACE_SEC = 0.5;
const MEDIA_HOST = 'lookaside.fbsbx.com';

export interface TranscribeDeps {
  fetchFn: typeof fetch;
  /** The shared number's WhatsApp token: sent to graph.facebook.com and lookaside.fbsbx.com only. */
  graphToken: string;
  phoneNumberId: string;
  speech: { key: string; region: string; language: 'en-IN' | 'en-US' };
  /** The row's cooperative deadline. */
  signal?: AbortSignal;
  /** Tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** WhatsApp voice audio: base type audio/ogg, and if a codecs parameter is given it is opus. Pure. */
export function isOggOpusMime(mime: string): boolean {
  const [base, ...params] = mime.toLowerCase().split(';').map((p) => p.trim());
  if (base !== 'audio/ogg') return false;
  const codecs = params.find((p) => p.startsWith('codecs='));
  return codecs === undefined || codecs === 'codecs=opus';
}

/** The download URL Graph returns must be https on exactly lookaside.fbsbx.com (else the token is never sent). Pure. */
export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === MEDIA_HOST && u.port === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/** The Azure short-audio endpoint for a region (env.ts validates it as a plain identifier). Pure. */
export function azureSttUrl(region: string, language: 'en-IN' | 'en-US'): string {
  return `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}&format=detailed`;
}

/**
 * Duration of an Ogg/Opus file, or null when it is not one. Pages are WALKED
 * from the start (RFC 3533: "OggS", version 0, header type, granule int64 LE at
 * offset 6, serial u32 LE at 14, page_segments at 26, then the lacing table),
 * so an "OggS" inside packet data can never be mistaken for a page. The first
 * page must carry OpusHead (RFC 7845 §5.1: channel count at +9, pre-skip u16 LE
 * at +10, input sample rate u32 LE at +12). Duration = (last granule of that
 * stream − pre-skip) / 48000 (RFC 7845 §4: the granule clock is always 48 kHz).
 * Any malformed or truncated page ⇒ null. Pure.
 */
export function oggOpusInfo(b: Uint8Array): { seconds: number; inputRate: number; channels: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 0;
  let serial: number | null = null;
  let preSkip = 0;
  let inputRate = 0;
  let channels = 0;
  let lastGranule: bigint | null = null;
  while (pos < b.length) {
    if (pos + 27 > b.length) return null;
    if (b[pos] !== 0x4f || b[pos + 1] !== 0x67 || b[pos + 2] !== 0x67 || b[pos + 3] !== 0x53 || b[pos + 4] !== 0) return null;
    const nseg = b[pos + 26];
    const dataStart = pos + 27 + nseg;
    if (dataStart > b.length) return null;
    let bodyLen = 0;
    for (let i = 0; i < nseg; i++) bodyLen += b[pos + 27 + i];
    const end = dataStart + bodyLen;
    if (end > b.length) return null;
    const pageSerial = dv.getUint32(pos + 14, true);
    const granule = dv.getBigInt64(pos + 6, true);
    if (serial === null) {
      if (bodyLen < 19) return null;
      const magic = String.fromCharCode(...b.subarray(dataStart, dataStart + 8));
      if (magic !== 'OpusHead') return null;
      serial = pageSerial;
      channels = b[dataStart + 9];
      preSkip = dv.getUint16(dataStart + 10, true);
      inputRate = dv.getUint32(dataStart + 12, true);
    } else if (pageSerial === serial && granule !== -1n) {
      lastGranule = granule;
    }
    pos = end;
  }
  if (lastGranule === null) return null;
  const samples = lastGranule - BigInt(preSkip);
  return { seconds: samples > 0n ? Number(samples) / 48_000 : 0, inputRate, channels };
}

/** Drop control characters (incl. NUL), collapse runs of spaces, trim, cap. Pure. */
function cleanTranscript(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, TRANSCRIPT_MAX_CHARS);
}

// ── I/O ──────────────────────────────────────────────────────────────────────

type Step<T> = { ok: T } | { transient: string } | { final: VoiceOutcome; reason: string };

class TooBig extends Error {}

/** Read a body, refusing more than `max` bytes (Content-Length first, then a streamed count). */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new TooBig();
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readCapped(res, JSON_MAX_BYTES)));
}

const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

interface Run {
  deps: TranscribeDeps;
  signal: AbortSignal;
  start: number;
  budgetMs: number;
  retried: boolean;
  now: () => number;
}

/** One try of `fn` under its own step timeout. A throw is transient unless the row itself was aborted. */
async function tryStep<T>(run: Run, stepMs: number, fn: (signal: AbortSignal) => Promise<Step<T>>): Promise<Step<T>> {
  try {
    return await fn(AbortSignal.any([run.signal, AbortSignal.timeout(stepMs)]));
  } catch (err) {
    if (run.signal.aborted) return { final: { kind: 'failed' }, reason: 'aborted' };
    if (err instanceof TooBig) return { final: { kind: 'too_long' }, reason: 'too_big' };
    return { transient: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/** `fn`, and ONE retry for the whole note when it was transient and the budget still fits a full try. */
async function withRetry<T>(run: Run, stepMs: number, fn: (signal: AbortSignal) => Promise<Step<T>>): Promise<Step<T>> {
  const first = await tryStep(run, stepMs, fn);
  if (!('transient' in first) || run.retried) return first;
  if (run.now() - run.start + RETRY_DELAY_MS + stepMs > run.budgetMs) return first;
  run.retried = true;
  await (run.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(RETRY_DELAY_MS);
  if (run.signal.aborted) return { final: { kind: 'failed' }, reason: 'aborted' };
  return tryStep(run, stepMs, fn);
}

/** Graph media lookup + download (a fresh URL each try: they expire after 5 minutes). */
async function fetchAudio(run: Run, ref: VoiceRef, signal: AbortSignal): Promise<Step<Uint8Array<ArrayBuffer>>> {
  const { deps } = run;
  const auth = { Authorization: `Bearer ${deps.graphToken}` };
  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${ref.id}?phone_number_id=${encodeURIComponent(deps.phoneNumberId)}`;
  const metaRes = await deps.fetchFn(metaUrl, { headers: auth, redirect: 'error', signal });
  if (!metaRes.ok) {
    await metaRes.body?.cancel().catch(() => {});
    return isTransientStatus(metaRes.status) ? { transient: `meta_${metaRes.status}` } : { final: { kind: 'failed' }, reason: `meta_${metaRes.status}` };
  }
  const meta = (await readJson(metaRes).catch(() => null)) as Record<string, unknown> | null;
  if (!meta || typeof meta !== 'object' || meta.id !== ref.id || typeof meta.url !== 'string') {
    return { final: { kind: 'failed' }, reason: 'meta_shape' };
  }
  if (typeof meta.mime_type === 'string' && !isOggOpusMime(meta.mime_type)) return { final: { kind: 'unsupported' }, reason: 'meta_mime' };
  const size = Number(meta.file_size);
  if (Number.isFinite(size) && size > VOICE_MAX_BYTES) return { final: { kind: 'too_long' }, reason: 'meta_size' };
  if (!isAllowedMediaUrl(meta.url)) return { final: { kind: 'failed' }, reason: 'bad_host' };

  const audioRes = await deps.fetchFn(meta.url, { headers: auth, redirect: 'error', signal });
  if (!audioRes.ok) {
    await audioRes.body?.cancel().catch(() => {});
    // Meta: a failed download is a 404; get a new URL and try again.
    return audioRes.status === 404 || isTransientStatus(audioRes.status)
      ? { transient: `download_${audioRes.status}` }
      : { final: { kind: 'failed' }, reason: `download_${audioRes.status}` };
  }
  return { ok: await readCapped(audioRes, VOICE_MAX_BYTES) };
}

/** One Azure short-audio recognition. */
async function recognize(run: Run, audio: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<Step<string>> {
  const { speech, fetchFn } = run.deps;
  const res = await fetchFn(azureSttUrl(speech.region, speech.language), {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': speech.key,
      'Content-Type': 'audio/ogg; codecs=opus',
      Accept: 'application/json',
    },
    body: audio,
    redirect: 'error',
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) return { final: { kind: 'auth_failed', status: res.status }, reason: `azure_${res.status}` };
    if (res.status === 400) return { final: { kind: 'unclear' }, reason: 'azure_400' };
    return isTransientStatus(res.status) ? { transient: `azure_${res.status}` } : { final: { kind: 'failed' }, reason: `azure_${res.status}` };
  }
  const body = (await readJson(res).catch(() => null)) as {
    RecognitionStatus?: unknown;
    NBest?: { Confidence?: unknown; Display?: unknown }[];
  } | null;
  const status = body && typeof body === 'object' ? body.RecognitionStatus : undefined;
  if (status === 'Error') return { transient: 'azure_status_error' };
  if (status === 'NoMatch' || status === 'InitialSilenceTimeout' || status === 'BabbleTimeout') {
    return { final: { kind: 'unclear' }, reason: `azure_${String(status)}` };
  }
  if (status !== 'Success') return { final: { kind: 'failed' }, reason: 'azure_shape' };
  // NBest[0] is Azure's chosen hypothesis. No confidence ⇒ treated as unclear.
  const best = Array.isArray(body!.NBest) ? body!.NBest[0] : undefined;
  const confidence = typeof best?.Confidence === 'number' ? best.Confidence : -1;
  const text = typeof best?.Display === 'string' ? cleanTranscript(best.Display) : '';
  if (text === '' || confidence < VOICE_MIN_CONFIDENCE) return { final: { kind: 'unclear' }, reason: 'low_confidence' };
  return { ok: text };
}

/**
 * Download one voice note from Meta and transcribe it with Azure. Never throws;
 * the result is creds-free (see VoiceOutcome). `ref.mimeType` and the Graph
 * metadata must both say Ogg/Opus, and the audio must parse as Ogg/Opus of at
 * most VOICE_MAX_SECONDS before anything is sent to Azure (so a long note is
 * never billed).
 */
export async function transcribeVoiceNote(ref: VoiceRef, deps: TranscribeDeps): Promise<VoiceOutcome> {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? VOICE_BUDGET_MS;
  const budget = AbortSignal.timeout(budgetMs);
  const run: Run = {
    deps,
    signal: deps.signal ? AbortSignal.any([deps.signal, budget]) : budget,
    start: now(),
    budgetMs,
    retried: false,
    now,
  };
  const log: Record<string, unknown> = {};
  const finish = (out: VoiceOutcome, reason: string): VoiceOutcome => {
    logWarn('worker.voice', out.kind, { reason, ...log, retried: run.retried, ms: now() - run.start });
    return out;
  };
  try {
    if (!MEDIA_ID_RE.test(ref.id)) return finish({ kind: 'failed' }, 'bad_ref');
    if (!isOggOpusMime(ref.mimeType)) return finish({ kind: 'unsupported' }, 'mime');

    const got = await withRetry(run, META_STEP_MS + DOWNLOAD_STEP_MS, (signal) => fetchAudio(run, ref, signal));
    if ('final' in got) return finish(got.final, got.reason);
    if ('transient' in got) return finish({ kind: 'failed' }, got.transient);
    const audio = got.ok;
    log.bytes = audio.byteLength;

    const info = oggOpusInfo(audio);
    if (!info) return finish({ kind: 'unsupported' }, 'not_ogg_opus');
    log.seconds = Math.round(info.seconds * 10) / 10;
    log.rate = info.inputRate;
    log.channels = info.channels;
    if (info.seconds > VOICE_MAX_SECONDS + DURATION_GRACE_SEC) return finish({ kind: 'too_long' }, 'duration');

    const heard = await withRetry(run, AZURE_STEP_MS, (signal) => recognize(run, audio, signal));
    if ('final' in heard) return finish(heard.final, heard.reason);
    if ('transient' in heard) return finish({ kind: 'failed' }, heard.transient);
    return finish({ kind: 'ok', transcript: heard.ok }, 'ok');
  } catch {
    return finish({ kind: 'failed' }, 'error');
  }
}
