import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { conversationMessageId, createConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { MEDIA_REPLY } from '@/lib/consent';
import {
  VOICE_ENGLISH_ONLY_REPLY,
  VOICE_FAIL_REPLY,
  VOICE_LOG_MARKER,
  VOICE_PLACEHOLDER,
  VOICE_TOO_LONG_REPLY,
  VOICE_UNSUPPORTED_REPLY,
  type VoiceOutcome,
} from '@/lib/voice-notes';
import type { Db } from '@/db/client';

// Step 1 voice notes, worker side: after the per-phone gate and lock, a voice
// agent.turn is transcribed (DI'd here), the transcript is logged sealed as its
// own entry and becomes the turn's message. Every failure is ONE fixed reply
// (reply:<row id>) and the row is done: no row-level retry, so the customer's
// later turns are never held. Phones are obvious fakes; no key is real.

const P = '15550000001';
const MEDIA = { id: '4242', mimeType: 'audio/ogg; codecs=opus' };

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const sendText = vi.fn(async (..._a: unknown[]) => {});
const runAgentTurn = vi.fn(async (..._a: unknown[]) => 'Sure, sending $100 to Mom. Shall I go ahead?');
const transcribeVoice = vi.fn(async (..._a: unknown[]): Promise<VoiceOutcome> => ({ kind: 'ok', transcript: 'send 100 dollars to mom' }));

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db,
    store,
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn() as unknown as WorkerDeps['sendTemplate'],
    fetchFn: vi.fn() as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: runAgentTurn as unknown as WorkerDeps['runAgentTurn'],
    transcribeVoice: transcribeVoice as unknown as WorkerDeps['transcribeVoice'],
    ...over,
  };
}

const outboxRows = async (kind: string) =>
  ((await db.execute(sql`SELECT id, status, attempts, dedupe_key, payload FROM outbox WHERE kind = ${kind} ORDER BY id`)) as unknown as {
    rows: Array<{ id: number; status: string; attempts: number; dedupe_key: string | null; payload: Record<string, unknown> }>;
  }).rows;
const thread = () => createConversationLogRepo(db).listThread('default', P);

async function voiceSwitch(on: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'voice.notes', scopeType: 'global', scopeId: '', enabled: on, reason: 'voice beta test', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

const enqueueVoice = (over: Record<string, unknown> = {}) =>
  outbox.enqueue(
    'agent.turn',
    { phone: P, messageText: VOICE_PLACEHOLDER, turn: { isNewConversation: false, inputModality: 'voice' }, routedPartnerId: null, media: MEDIA, ...over },
    { dedupeKey: `wamid:v${Math.random()}` },
  );

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  sendText.mockClear();
  runAgentTurn.mockClear();
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ kind: 'ok', transcript: 'send 100 dollars to mom' });
  vi.stubEnv('AZURE_SPEECH_KEY', 'fake-speech-key');
  vi.stubEnv('AZURE_SPEECH_REGION', 'eastus');
  vi.stubEnv('VOICE_NOTES_BETA_PHONES', P);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await voiceSwitch(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a transcribed voice note runs the normal turn', { retry: 0 }, () => {
  it('the transcript reaches runAgentTurn with inputModality voice; the reply goes out as text', async () => {
    await enqueueVoice();
    await drainOnce(deps(), 'w1');
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(transcribeVoice.mock.calls[0][0]).toEqual(MEDIA);
    expect(transcribeVoice.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const [phone, message, turn] = runAgentTurn.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(phone).toBe(P);
    expect(message).toBe('send 100 dollars to mom');
    expect(turn).toMatchObject({ inputModality: 'voice' });
    expect(sendText).toHaveBeenCalledWith(P, 'Sure, sending $100 to Mom. Shall I go ahead?', undefined);
  });

  it('log order: the voice-note marker, then the transcript (in:<id>:t), then the reply', async () => {
    await enqueueVoice();
    const [row] = await outboxRows('agent.turn');
    await drainOnce(deps(), 'w1');
    const t = await thread();
    expect(t.map((m) => [m.direction, m.text])).toEqual([
      ['in', VOICE_LOG_MARKER],
      ['in', '🎤 send 100 dollars to mom'],
      ['out', 'Sure, sending $100 to Mom. Shall I go ahead?'],
    ]);
    expect(t.map((m) => m.id)).toEqual([
      conversationMessageId('in', row.id),
      conversationMessageId('in', `${row.id}:t`),
      conversationMessageId('out', row.id),
    ]);
  });

  it('the done row keeps neither messageText nor media, and the transcript is in no outbox row', async () => {
    await enqueueVoice();
    await drainOnce(deps(), 'w1');
    const [done] = await outboxRows('agent.turn');
    expect(done.status).toBe('done');
    expect(done.payload).not.toHaveProperty('messageText');
    expect(done.payload).not.toHaveProperty('media');
    const all = await db.execute(sql`SELECT payload FROM outbox`);
    expect(JSON.stringify(all)).not.toContain('100 dollars');
  });

  it('a text turn is untouched: no transcription', async () => {
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'hello', turn: {}, routedPartnerId: null });
    await drainOnce(deps(), 'w1');
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(runAgentTurn.mock.calls[0][1]).toBe('hello');
    expect((await thread()).map((m) => m.text)[0]).toBe('hello');
  });

  it('a turn deferred behind another (busy lock) is NOT transcribed (nothing billed)', async () => {
    await store.tryTurnLock('default', P, 'holder');
    await enqueueVoice();
    await drainOnce(deps(), 'w1');
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect((await thread()).map((m) => m.text)).toEqual([VOICE_LOG_MARKER]);
  });
});

describe('a voice note that did not become a turn gets ONE fixed reply; the row is done', { retry: 0 }, () => {
  it.each([
    ['too_long', VOICE_TOO_LONG_REPLY],
    ['unsupported', VOICE_UNSUPPORTED_REPLY],
    ['unclear', VOICE_ENGLISH_ONLY_REPLY],
    ['failed', VOICE_FAIL_REPLY],
  ] as const)('%s → its reply as reply:<row id>, no agent run, no retry', async (kind, reply) => {
    transcribeVoice.mockResolvedValue({ kind } as VoiceOutcome);
    await enqueueVoice();
    const [row] = await outboxRows('agent.turn');
    const r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(0);
    expect(runAgentTurn).not.toHaveBeenCalled();
    const replies = await outboxRows('whatsapp.text');
    expect(replies).toHaveLength(1);
    expect(replies[0].dedupe_key).toBe(`reply:${row.id}`);
    expect(replies[0].payload).toEqual({ to: P, body: reply, category: 'essential' });
    expect((await outboxRows('agent.turn'))[0].status).toBe('done');
    expect((await thread()).map((m) => [m.direction, m.text])).toEqual([['in', VOICE_LOG_MARKER], ['out', reply]]);
    expect(await outboxRows('ops.alert')).toHaveLength(0);
  });

  it('Azure 401/403: the "please type" reply and ONE sttauth alert per hour', async () => {
    transcribeVoice.mockResolvedValue({ kind: 'auth_failed', status: 401 });
    await enqueueVoice();
    await enqueueVoice();
    await drainOnce(deps(), 'w1');
    await drainOnce(deps(), 'w1');
    const replies = await outboxRows('whatsapp.text');
    expect(replies.map((r) => r.payload.body)).toEqual([VOICE_FAIL_REPLY, VOICE_FAIL_REPLY]);
    const alerts = await outboxRows('ops.alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupe_key).toMatch(/^sttauth:\d+$/);
    expect(String(alerts[0].payload.message)).toContain('HTTP 401');
    expect(JSON.stringify(alerts[0].payload)).not.toContain('fake-speech-key');
  });
});

describe('drain-time checks: voice off for this row ⇒ MEDIA_REPLY, nothing sent to Azure', { retry: 0 }, () => {
  const expectMediaReply = async () => {
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
    const replies = await outboxRows('whatsapp.text');
    expect(replies.map((r) => r.payload.body)).toEqual([MEDIA_REPLY]);
    expect((await outboxRows('agent.turn'))[0].status).toBe('done');
  };

  it('the voice.notes switch was turned off after the row was queued', async () => {
    await enqueueVoice();
    await voiceSwitch(false);
    await drainOnce(deps(), 'w1');
    await expectMediaReply();
  });

  it('the phone was removed from the beta list', async () => {
    await enqueueVoice();
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '15550000009');
    await drainOnce(deps(), 'w1');
    await expectMediaReply();
  });

  it('the Azure key is gone', async () => {
    await enqueueVoice();
    vi.stubEnv('AZURE_SPEECH_KEY', '');
    await drainOnce(deps(), 'w1');
    await expectMediaReply();
  });

  it('the row names a routed partner (voice is shared-number only)', async () => {
    await enqueueVoice({ routedPartnerId: 'acme' });
    await drainOnce(deps(), 'w1');
    expect(transcribeVoice).not.toHaveBeenCalled();
    const replies = await outboxRows('whatsapp.text');
    expect(replies.map((r) => r.payload)).toEqual([{ to: P, body: MEDIA_REPLY, category: 'essential', partnerId: 'acme' }]);
  });

  it('no transcriber wired', async () => {
    await enqueueVoice();
    await drainOnce(deps({ transcribeVoice: undefined }), 'w1');
    await expectMediaReply();
  });

  it('a hand-edited media (not a digits id) is treated as a text turn on the placeholder', async () => {
    await enqueueVoice({ media: { id: '../evil', mimeType: 'audio/ogg' } });
    await drainOnce(deps(), 'w1');
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(runAgentTurn.mock.calls[0][1]).toBe(VOICE_PLACEHOLDER);
  });
});
