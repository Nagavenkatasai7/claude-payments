import type { DbOrTx } from '@/db/client';
import { env } from './env';
import { isFlagOn } from './flags';
import { logWarn } from './log';
import { MEDIA_REPLY } from './consent';
import { normalizePhone } from './phone';
import { MEDIA_ID_RE, safeMime } from './whatsapp';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { InboundMedia, PartnerId } from './types';

// voice-notes — Step 1 "Voice-to-Remit": the rules around a WhatsApp voice note.
//
// A voice note from a beta sender on the shared SmartRemit number becomes ONE
// ordinary agent.turn outbox row carrying the Meta media id (no new kind, no
// table). The worker downloads the audio, has Microsoft Azure AI Speech turn it
// into English text (voice-transcribe.ts) and runs the normal agent turn with
// that text. The bot always answers in text.
//
// Voice runs only when ALL of these hold, checked when the webhook arrives AND
// again when the worker drains the row (so turning the switch off, or removing
// a phone from the list, also stops voice notes already queued):
//   • the message came to the shared number (routedPartnerId null);
//   • AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are set (env.ts);
//   • the sender is on VOICE_NOTES_BETA_PHONES (empty ⇒ nobody, '*' ⇒ everyone);
//   • the `voice.notes` feature flag is on (global, or the default partner).
// Otherwise a voice note gets today's MEDIA_REPLY, byte for byte.
//
// English only. Everything here is fixed text: no customer content, phone,
// media id or key ever reaches a log line, an alert or an outbox payload.

/** Longest voice note we transcribe (Azure's short-audio API takes up to 60 s). */
export const VOICE_MAX_SECONDS = 30;

/**
 * Azure's NBest[0].Confidence (0..1) below this reads as "not understood" and
 * gets VOICE_ENGLISH_ONLY_REPLY. A starting value: tune it from the beta logs.
 */
export const VOICE_MIN_CONFIDENCE = 0.5;

export interface VoiceSettings {
  key: string;
  region: string;
  language: 'en-IN' | 'en-US';
  betaPhones: readonly string[];
}

/** The four voice env settings, read at call time (a drain sees the current values). */
export function voiceSettingsFromEnv(): VoiceSettings {
  return {
    key: env.azureSpeechKey,
    region: env.azureSpeechRegion,
    language: env.azureSpeechLanguage,
    betaPhones: env.voiceNotesBetaPhones,
  };
}

/** Is `from` on the beta list? Digits are compared; [] ⇒ nobody; exactly ['*'] ⇒ everyone. Pure. */
export function onBetaList(from: string, list: readonly string[]): boolean {
  const phone = normalizePhone(from);
  if (phone === '') return false;
  if (list.length === 1 && list[0] === '*') return true;
  return list.some((entry) => {
    const digits = normalizePhone(entry);
    return digits !== '' && digits === phone;
  });
}

function configured(s: VoiceSettings): boolean {
  return s.key !== '' && s.region !== '';
}

/**
 * Everything but the switch (no database read): the shared number, the Azure
 * settings and a beta sender. Callers read the switch only when this is true,
 * so a photo from a non-beta sender never costs a flag read. Pure.
 */
export function voiceSenderEligible(
  msg: { routedPartnerId: PartnerId | null; from: string },
  s: VoiceSettings,
): boolean {
  return msg.routedPartnerId === null && configured(s) && onBetaList(msg.from, s.betaPhones);
}

let warnedUnconfigured = false;

/** Test-only: forget the once-per-process "not configured" log. */
export function __resetVoiceWarnings(): void {
  warnedUnconfigured = false;
}

/**
 * The `voice.notes` switch for the shared number, AND the Azure settings. A
 * switch that is on without a key or region reads as off and logs ONE line per
 * process naming the settings (never their values). Never throws (isFlagOn
 * fails open, i.e. off).
 */
export async function voiceNotesOn(db: DbOrTx, s: VoiceSettings): Promise<boolean> {
  if (!(await isFlagOn(db, 'voice.notes', { partnerId: DEFAULT_PARTNER_ID }))) return false;
  if (configured(s)) return true;
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    logWarn('voice.config', 'voice.notes is on but AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is not set: voice notes behave as off', {
      key: s.key !== '' ? 'set' : 'missing',
      region: s.region !== '' ? 'set' : 'missing',
    });
  }
  return false;
}

/** What the worker downloads: the Meta media id and the mime type the webhook gave. */
export type VoiceRef = InboundMedia;

/** Drain-time validation of an agent.turn payload's `media` (a hand-edited row cannot steer a URL). */
export function voiceRefOf(v: unknown): VoiceRef | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { id, mimeType } = v as { id?: unknown; mimeType?: unknown };
  if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) return null;
  return { id, mimeType: safeMime(mimeType) };
}

/**
 * The result of one transcription. Creds-free and content-free except the
 * transcript itself, which the worker passes to the turn and to the sealed
 * conversation log only (never an outbox payload or a log line).
 */
export type VoiceOutcome =
  | { kind: 'ok'; transcript: string }
  | { kind: 'too_long' } // over VOICE_MAX_SECONDS (or too many bytes): not sent to Azure
  | { kind: 'unsupported' } // not WhatsApp Ogg/Opus voice audio
  | { kind: 'unclear' } // Azure 400, NoMatch, silence, babble, empty text or low confidence
  | { kind: 'auth_failed'; status: 401 | 403 } // Azure rejected the key: ops alert
  | { kind: 'failed' }; // Meta or Azure down/throttled after the one retry, or a bad response

export type VoiceFailureKind = Exclude<VoiceOutcome['kind'], 'ok'>;

// ── Fixed customer copy (English only; the product's short, plain style) ─────

/**
 * The agent.turn payload text of a voice row. Only an OLDER build (one that
 * does not know `media`) ever shows it to the model; it asks the customer to type.
 */
export const VOICE_PLACEHOLDER =
  '[The customer sent a voice note that could not be transcribed here. Ask them, briefly, to type their message.]';

/** The sealed conversation log's entry for the voice note itself (the transcript follows as its own entry). */
export const VOICE_LOG_MARKER = '🎤 Voice note received';

/** Prefix of the transcript's conversation-log entry. */
export const VOICE_TRANSCRIPT_PREFIX = '🎤 ';

/** Not English, or not understood (owner-approved text, 2026-10-05). */
export const VOICE_ENGLISH_ONLY_REPLY =
  'Sorry, I understand voice notes in English only. Please type your message or send a voice note in English.';

/** Meta or Azure failed: the "please type" reply. */
export const VOICE_FAIL_REPLY = "Sorry, I couldn't listen to that voice note just now. Please type your message.";

export const VOICE_TOO_LONG_REPLY =
  `That voice note is over ${VOICE_MAX_SECONDS} seconds, so I couldn't listen to it. Please send a shorter one or type your message.`;

export const VOICE_UNSUPPORTED_REPLY =
  'I can listen to voice notes recorded in WhatsApp, but not audio files. Please record a voice note or type your message.';

/** MEDIA_REPLY for a sender who can use voice notes (photos and files are still not read). */
export const VOICE_AWARE_MEDIA_REPLY =
  'I can read typed messages and listen to English voice notes here, but not photos or files. Never send ID photos or bank details in chat.';

/** The reply to a photo or file: MEDIA_REPLY byte for byte unless voice is on for this sender. Pure. */
export function mediaReply(voiceOn: boolean): string {
  return voiceOn ? VOICE_AWARE_MEDIA_REPLY : MEDIA_REPLY;
}

/** The one fixed reply for a voice note that did not become a turn. Pure. */
export function voiceReplyFor(kind: VoiceFailureKind): string {
  switch (kind) {
    case 'unclear':
      return VOICE_ENGLISH_ONLY_REPLY;
    case 'too_long':
      return VOICE_TOO_LONG_REPLY;
    case 'unsupported':
      return VOICE_UNSUPPORTED_REPLY;
    case 'auth_failed':
    case 'failed':
      return VOICE_FAIL_REPLY;
  }
}

const AUTH_HINTS: Record<401 | 403, string> = {
  401: 'the key is not valid for the region, or the endpoint is wrong',
  403: 'no key reached it',
};

/**
 * The ops alert for an Azure 401/403 (shaped like llmDownAlertFor). One row per
 * clock hour (`sttauth:<hour>`): outbox dedupe keys are permanent, so the hour
 * bucket lets a lasting outage alert again. Fixed text; never the key. Pure.
 */
export function sttAuthAlertFor(status: 401 | 403, hour: number): { message: string; dedupeKey: string } {
  return {
    message:
      `⚠️ SmartRemit ops: voice notes are failing. Azure AI Speech rejected the request (HTTP ${status}: ${AUTH_HINTS[status]}). ` +
      'Every voice note gets the "please type" reply until this is fixed. Check the Azure Speech resource and the AZURE_SPEECH_KEY and AZURE_SPEECH_REGION settings.',
    dedupeKey: `sttauth:${hour}`,
  };
}

// ── The agent side ───────────────────────────────────────────────────────────

/**
 * Tools the agent may call at once in a voice turn: they only read, quote,
 * message THIS customer (the recipient picker) or open a support case. Every
 * other tool creates, changes, cancels or disputes something, saves details or
 * messages someone else, so it needs a read-back first (VOICE_INPUT_NOTE).
 * tests/voice-notes.test.ts forces every tool to be classified.
 */
export const VOICE_LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  'get_quote',
  'check_send_limit',
  'list_recent_transfers',
  'list_saved_recipients',
  'resolve_recipient',
  'validate_phone',
  'list_schedules',
  'check_payment_status',
  'check_bill_status',
  'present_bill',
  'get_customer_context',
  'send_recipient_picker',
  'request_human_help',
]);

/**
 * Refused in a voice turn (executeTool): they have no pay page or OTP behind
 * them, so a misheard phone or amount would bill or name the wrong party. The
 * customer types the request (owner decision Q10).
 */
export const VOICE_TYPED_ONLY_TOOLS: ReadonlySet<string> = new Set(['create_invoice', 'register_seller']);

/**
 * A system message on EVERY round of a voice turn (agent.ts). Never persisted.
 * Built from VOICE_LOOKUP_TOOLS so the two cannot drift.
 */
export const VOICE_INPUT_NOTE =
  "[VOICE NOTE] The customer's last message is an automatic English transcript of a WhatsApp voice note and may contain mistakes, " +
  'especially in amounts, currencies, names and phone numbers. ' +
  `You may call these tools straight away: ${[...VOICE_LOOKUP_TOOLS].join(', ')}. ` +
  'Before calling ANY other tool (anything that creates, changes, cancels or disputes something, saves details, or messages anyone ' +
  'other than this customer), first read back every amount, currency, name and phone number you took from the voice note and ask ' +
  "the customer to confirm. A reply that only confirms your read-back (for example 'yes') counts as confirmation. " +
  'Invoices and seller sign-up (create_invoice, register_seller) cannot run in a voice turn: read back the details and ask the ' +
  "customer to type 'yes' to go ahead. " +
  'If the transcript is unclear or empty, ask them to type their message. If they ask to stop receiving messages, tell them to type STOP.';
