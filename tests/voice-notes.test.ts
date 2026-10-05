import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  VOICE_MAX_SECONDS,
  VOICE_LOOKUP_TOOLS,
  VOICE_TYPED_ONLY_TOOLS,
  VOICE_INPUT_NOTE,
  VOICE_ENGLISH_ONLY_REPLY,
  VOICE_FAIL_REPLY,
  VOICE_TOO_LONG_REPLY,
  VOICE_UNSUPPORTED_REPLY,
  VOICE_AWARE_MEDIA_REPLY,
  mediaReply,
  onBetaList,
  voiceReplyFor,
  voiceRefOf,
  voiceSenderEligible,
  voiceSettingsFromEnv,
  voiceNotesOn,
  sttAuthAlertFor,
  __resetVoiceWarnings,
  type VoiceSettings,
} from '@/lib/voice-notes';
import { MEDIA_REPLY } from '@/lib/consent';
import { toolSchemas, WHATSAPP_HIDDEN_TOOLS } from '@/lib/tools';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { freshDb } from './helpers-db';

// Step 1 voice notes: the pure rules (who may use voice, the fixed replies, the
// ops alert, the agent note) and the one switch read. Phones are obvious fakes.

const SETTINGS: VoiceSettings = { key: 'fake-key', region: 'eastus', language: 'en-IN', betaPhones: ['+1 555 000 0001'] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetVoiceWarnings();
});

describe('onBetaList', () => {
  it('matches on digits only; an empty list is nobody; exactly "*" is everyone', () => {
    expect(onBetaList('15550000001', ['+1 555 000 0001'])).toBe(true);
    expect(onBetaList('+15550000001', ['15550000001'])).toBe(true);
    expect(onBetaList('15550000002', ['15550000001'])).toBe(false);
    expect(onBetaList('15550000001', [])).toBe(false);
    expect(onBetaList('15550000001', ['*'])).toBe(true);
    expect(onBetaList('', ['*'])).toBe(false); // no sender, no voice
    expect(onBetaList('15550000001', ['*', '15550000009'])).toBe(false); // '*' only counts alone
    expect(onBetaList('', [''])).toBe(false);
    expect(onBetaList('15550000001', ['abc'])).toBe(false);
  });
});

describe('voiceSenderEligible (no database read)', () => {
  it('needs the shared number and a beta sender (the Azure settings are voiceNotesOn, which logs them)', () => {
    expect(voiceSenderEligible({ routedPartnerId: null, from: '15550000001' }, SETTINGS)).toBe(true);
    expect(voiceSenderEligible({ routedPartnerId: 'acme', from: '15550000001' }, SETTINGS)).toBe(false);
    expect(voiceSenderEligible({ routedPartnerId: null, from: '15550000002' }, SETTINGS)).toBe(false);
  });

  it('voiceSettingsFromEnv reads the getters at call time', () => {
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake-key');
    vi.stubEnv('AZURE_SPEECH_REGION', 'eastus');
    vi.stubEnv('AZURE_SPEECH_LANGUAGE', 'en-US');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '15550000001,15550000002');
    expect(voiceSettingsFromEnv()).toEqual({ key: 'fake-key', region: 'eastus', language: 'en-US', betaPhones: ['15550000001', '15550000002'] });
    vi.stubEnv('AZURE_SPEECH_KEY', '');
    expect(voiceSettingsFromEnv().key).toBe('');
  });
});

describe('voiceNotesOn (the voice.notes switch + the Azure settings)', () => {
  async function flagOn(db: Awaited<ReturnType<typeof freshDb>>, scopeType: 'global' | 'partner', scopeId = '') {
    await createFeatureFlagRepo(db).upsert({ key: 'voice.notes', scopeType, scopeId, enabled: true, reason: 'voice beta test', updatedBy: 'admin' });
    invalidateFlagCache(db);
  }

  it('off with no flag row, on with a global or default-partner row', async () => {
    const db = await freshDb();
    expect(await voiceNotesOn(db, SETTINGS)).toBe(false);
    await flagOn(db, 'partner', 'default');
    expect(await voiceNotesOn(db, SETTINGS)).toBe(true);
    const db2 = await freshDb();
    invalidateFlagCache(db2);
    await flagOn(db2, 'global');
    expect(await voiceNotesOn(db2, SETTINGS)).toBe(true);
  });

  it('flag on but no key or region ⇒ off, logged once per process (names only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await freshDb();
    await flagOn(db, 'global');
    expect(await voiceNotesOn(db, { ...SETTINGS, key: '' })).toBe(false);
    expect(await voiceNotesOn(db, { ...SETTINGS, region: '' })).toBe(false);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('voice.config'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/AZURE_SPEECH_KEY|AZURE_SPEECH_REGION/);
    expect(lines[0]).not.toContain('fake-key');
  });
});

describe('voiceRefOf (drain-time payload validation)', () => {
  it('accepts { id: digits, mimeType: string } and nothing else', () => {
    expect(voiceRefOf({ id: '4242', mimeType: 'audio/ogg; codecs=opus' })).toEqual({ id: '4242', mimeType: 'audio/ogg; codecs=opus' });
    expect(voiceRefOf({ id: '4242', mimeType: 7 })).toEqual({ id: '4242', mimeType: '' });
    for (const bad of [undefined, null, 'x', [], {}, { id: '../x', mimeType: 'audio/ogg' }, { id: 4242, mimeType: 'audio/ogg' }]) {
      expect(voiceRefOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('fixed replies (English, product style)', () => {
  it('the English-only reply is the approved text', () => {
    expect(VOICE_ENGLISH_ONLY_REPLY).toBe(
      'Sorry, I understand voice notes in English only. Please type your message or send a voice note in English.',
    );
  });

  it('voiceReplyFor maps every non-ok outcome to one fixed reply', () => {
    expect(voiceReplyFor('unclear')).toBe(VOICE_ENGLISH_ONLY_REPLY);
    expect(voiceReplyFor('too_long')).toBe(VOICE_TOO_LONG_REPLY);
    expect(VOICE_TOO_LONG_REPLY).toContain(`${VOICE_MAX_SECONDS} seconds`);
    expect(voiceReplyFor('unsupported')).toBe(VOICE_UNSUPPORTED_REPLY);
    expect(voiceReplyFor('auth_failed')).toBe(VOICE_FAIL_REPLY);
    expect(voiceReplyFor('failed')).toBe(VOICE_FAIL_REPLY);
    expect(VOICE_FAIL_REPLY).toMatch(/type your message/);
  });

  it('mediaReply: MEDIA_REPLY byte for byte unless voice is on for this sender', () => {
    expect(mediaReply(false)).toBe(MEDIA_REPLY);
    expect(mediaReply(true)).toBe(VOICE_AWARE_MEDIA_REPLY);
    expect(VOICE_AWARE_MEDIA_REPLY).toMatch(/voice notes/);
    expect(VOICE_AWARE_MEDIA_REPLY).toMatch(/Never send ID photos or bank details in chat\./);
  });
});

describe('sttAuthAlertFor', () => {
  it('one key per clock hour for 401 and 403; fixed text, no key value', () => {
    const a = sttAuthAlertFor(401, 123);
    const b = sttAuthAlertFor(403, 123);
    expect(a.dedupeKey).toBe('sttauth:123');
    expect(b.dedupeKey).toBe('sttauth:123');
    expect(a.message).toMatch(/^⚠️ SmartRemit ops: /);
    expect(a.message).toContain('HTTP 401');
    expect(b.message).toContain('HTTP 403');
    expect(a.message).toContain('Azure AI Speech');
    expect(sttAuthAlertFor(401, 124).dedupeKey).toBe('sttauth:124');
  });
});

describe('VOICE_INPUT_NOTE and the tool classification tripwire', () => {
  // Every tool the model can be shown is either a look-up the agent may call at
  // once in a voice turn, or a state-changing tool that needs a read-back first.
  // A NEW tool fails here until it is classified (Steps 2 and 3 add theirs).
  const STATE_CHANGING_TOOLS = new Set([
    'register_seller',
    'create_invoice',
    'cancel_bill',
    'dispute_bill',
    'create_transfer',
    'generate_payment_link',
    'request_refund',
    'open_recall_dispute',
    'update_recipient_phone',
    'create_schedule',
    'cancel_schedule',
    'send_approve_picker',
    'cancel_draft',
    'repeat_transfer',
    'capture_corridor_request',
    'set_sender_name',
  ]);

  it('every tool is classified exactly once', () => {
    for (const t of toolSchemas) {
      const name = t.function.name;
      const inLookup = VOICE_LOOKUP_TOOLS.has(name);
      const inState = STATE_CHANGING_TOOLS.has(name);
      expect(inLookup !== inState, `${name} must be in exactly one list`).toBe(true);
    }
    const names = new Set(toolSchemas.map((t) => t.function.name));
    for (const n of [...VOICE_LOOKUP_TOOLS, ...STATE_CHANGING_TOOLS]) expect(names.has(n), `${n} is a real tool`).toBe(true);
  });

  it('the note names every look-up tool, no state-changing tool, and no hidden tool', () => {
    for (const n of VOICE_LOOKUP_TOOLS) expect(VOICE_INPUT_NOTE).toContain(n);
    for (const n of STATE_CHANGING_TOOLS) {
      if (VOICE_TYPED_ONLY_TOOLS.has(n)) continue; // named only to say they need typing
      expect(VOICE_INPUT_NOTE).not.toContain(n);
    }
    for (const n of WHATSAPP_HIDDEN_TOOLS) expect(VOICE_LOOKUP_TOOLS.has(n)).toBe(false);
  });

  it('the typed-only tools are invoices and seller sign-up, and the note says they need typing', () => {
    expect([...VOICE_TYPED_ONLY_TOOLS].sort()).toEqual(['create_invoice', 'register_seller']);
    for (const n of VOICE_TYPED_ONLY_TOOLS) expect(STATE_CHANGING_TOOLS.has(n)).toBe(true);
    expect(VOICE_INPUT_NOTE).toMatch(/create_invoice/);
    expect(VOICE_INPUT_NOTE).toMatch(/type/i);
    expect(VOICE_INPUT_NOTE).toMatch(/STOP/);
    expect(VOICE_INPUT_NOTE).toMatch(/read back/i);
  });
});
