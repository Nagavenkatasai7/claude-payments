import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { MEDIA_REPLY } from '@/lib/consent';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import {
  VOICE_AWARE_MEDIA_REPLY,
  VOICE_FAIL_REPLY,
  VOICE_PLACEHOLDER,
  VOICE_UNSUPPORTED_REPLY,
} from '@/lib/voice-notes';

// Step 1 voice notes, inbound side: a voice note from a beta sender on the
// shared number, with the voice.notes switch on and Azure configured, becomes
// ONE agent.turn row carrying the media id (never the audio, never a URL).
// Everyone else gets MEDIA_REPLY byte for byte. Phones are obvious fakes.

const BETA = '15550000001';
const OTHER = '15550000002';

let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
const { pokeWorker } = vi.hoisted(() => ({ pokeWorker: vi.fn() }));
vi.mock('@/lib/outbox', () => ({ pokeWorker, pokeWorkerDelayed: vi.fn() }));

import { processInboundWebhook } from '@/lib/whatsapp-inbound';

type Msg = Record<string, unknown>;
const voice = (id: string, from = BETA, audio: Record<string, unknown> = { id: '4242', mime_type: 'audio/ogg; codecs=opus', voice: true }): Msg =>
  ({ from, id, type: 'audio', audio });
const image = (id: string, from = BETA): Msg => ({ from, id, type: 'image', image: { id: '5151', mime_type: 'image/jpeg' } });
const webhook = (messages: Msg[]) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages } }] }] });

async function rows(q: string): Promise<Record<string, unknown>[]> {
  return ((await db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;
}
const outboxRows = () => rows(`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`);

async function voiceSwitch(on: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'voice.notes', scopeType: 'global', scopeId: '', enabled: on, reason: 'voice beta test', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  invalidateFlagCache(db);
  await seedPartner(db, 'acme');
  pokeWorker.mockClear();
  vi.stubEnv('AZURE_SPEECH_KEY', 'fake-speech-key');
  vi.stubEnv('AZURE_SPEECH_REGION', 'eastus');
  vi.stubEnv('VOICE_NOTES_BETA_PHONES', `+${BETA}`);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const mediaReplyRow = (id: string, body: string, to = BETA, extra: Record<string, unknown> = {}) => ({
  kind: 'whatsapp.text',
  dedupe_key: `wamid:${id}`,
  payload: { to, body, category: 'essential', ...extra },
});

describe('voice note → one agent.turn (switch on, beta sender, shared number)', () => {
  it('queues the turn with the placeholder text, inputModality and media { id, mimeType } only', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.V1')]), { routedPartnerId: null });
    const out = await outboxRows();
    expect(out).toEqual([
      {
        kind: 'agent.turn',
        dedupe_key: 'wamid:wamid.V1',
        payload: {
          phone: BETA,
          messageText: VOICE_PLACEHOLDER,
          turn: { isNewConversation: true, isNewCustomer: true, inputModality: 'voice' },
          routedPartnerId: null,
          media: { id: '4242', mimeType: 'audio/ogg; codecs=opus' },
        },
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('lookaside');
    expect(pokeWorker).toHaveBeenCalled();
  });

  it('a voice-first new phone gets a customer row with opt-in, and the 24 h marker is refreshed', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.V2')]), { routedPartnerId: null });
    const [c] = await rows(`SELECT opt_in_at FROM customers WHERE partner_id = 'default'`);
    expect(c.opt_in_at).not.toBeNull();
    expect(redis.dump.has(`lastmsg:default:${BETA}`)).toBe(true);
  });

  it('a redelivery is one row', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.V3')]), { routedPartnerId: null });
    redis.dump.clear();
    await processInboundWebhook(webhook([voice('wamid.V3')]), { routedPartnerId: null });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("'*' lets every sender use voice notes", async () => {
    await voiceSwitch(true);
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '*');
    await processInboundWebhook(webhook([voice('wamid.V4', OTHER)]), { routedPartnerId: null });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['agent.turn']);
  });
});

describe('everyone else gets MEDIA_REPLY byte for byte', () => {
  it('switch off (no row, or a row turned off)', async () => {
    await processInboundWebhook(webhook([voice('wamid.F1')]), { routedPartnerId: null });
    await voiceSwitch(false);
    await processInboundWebhook(webhook([voice('wamid.F2')]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.F1', MEDIA_REPLY), mediaReplyRow('wamid.F2', MEDIA_REPLY)]);
  });

  it('a sender not on the list, or an empty list', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.N1', OTHER)]), { routedPartnerId: null });
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '');
    await processInboundWebhook(webhook([voice('wamid.N2')]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.N1', MEDIA_REPLY, OTHER), mediaReplyRow('wamid.N2', MEDIA_REPLY)]);
  });

  it('no Azure key or region', async () => {
    await voiceSwitch(true);
    vi.stubEnv('AZURE_SPEECH_KEY', '');
    await processInboundWebhook(webhook([voice('wamid.K1')]), { routedPartnerId: null });
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake-speech-key');
    vi.stubEnv('AZURE_SPEECH_REGION', '');
    await processInboundWebhook(webhook([voice('wamid.K2')]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.K1', MEDIA_REPLY), mediaReplyRow('wamid.K2', MEDIA_REPLY)]);
  });

  it("a partner's own number (voice is on the shared number only)", async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.P1')]), { routedPartnerId: 'acme' });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.P1', MEDIA_REPLY, BETA, { partnerId: 'acme' })]);
  });

  it('an opted-out beta sender gets only the opted-out reminder', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([{ from: BETA, id: 'wamid.S', type: 'text', text: { body: 'STOP' } }]), { routedPartnerId: null });
    await processInboundWebhook(webhook([voice('wamid.O1')]), { routedPartnerId: null });
    const out = await outboxRows();
    expect(out.map((r) => r.kind)).toEqual(['whatsapp.text', 'whatsapp.text']);
    expect((out[1].payload as { body: string }).body).toMatch(/unsubscribed/);
  });
});

describe('voice is on for this sender, but the message is not a usable voice note', () => {
  it('a photo or file gets the voice-aware media reply', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([image('wamid.I1')]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.I1', VOICE_AWARE_MEDIA_REPLY)]);
  });

  it('a forwarded audio file (not Ogg/Opus) gets the "voice notes only" reply, no turn', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.A1', BETA, { id: '4242', mime_type: 'audio/mpeg' })]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.A1', VOICE_UNSUPPORTED_REPLY)]);
  });

  it('audio without a usable media id gets the "please type" reply, no turn', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([voice('wamid.A2', BETA, { id: '../x', mime_type: 'audio/ogg' })]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.A2', VOICE_FAIL_REPLY)]);
  });

  it('a non-beta photo never reads the switch and gets MEDIA_REPLY', async () => {
    await voiceSwitch(true);
    await processInboundWebhook(webhook([image('wamid.I2', OTHER)]), { routedPartnerId: null });
    expect(await outboxRows()).toEqual([mediaReplyRow('wamid.I2', MEDIA_REPLY, OTHER)]);
  });
});
