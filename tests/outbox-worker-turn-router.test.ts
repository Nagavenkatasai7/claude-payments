import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createOutboxRepo, type OutboxKind } from '@/db/repos/outbox-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { CARD_MARKER, createConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { FALLBACK_REPLY } from '@/lib/agent-fallback';
import { aiNoticeText, AI_NOTICE_INTERVAL_MS } from '@/lib/ai-notice';
import { AI_NOTICE_ACTION, recordAiNotice } from '@/lib/ai-notice-marker';
import { auditSubjectId } from '@/lib/customer-ref';
import { OFF_TOPIC_REPLY, offTopicReply } from '@/lib/scope-guard';
import { helpIntentReply } from '@/lib/help-intents';
import { pausedReply } from '@/lib/turn-router';
import { MEDIA_REPLY } from '@/lib/consent';
import { VOICE_FAIL_REPLY, VOICE_PLACEHOLDER, type VoiceOutcome } from '@/lib/voice-notes';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// PR1's ONE ordered router in the agent.turn handler (after a voice note is
// transcribed): R26's paused slot, then HELP (R43), then off-topic (R56), then
// the model. Every branch sends through one sendReply that puts the AI notice
// (R17) on top when the durable marker says it is due, in the reply's own
// transaction. Phones are obvious fakes.

// A one-shot fault in the conversation-log 'out' append, to prove the help
// branch is ONE transaction (case + reply + log) and a retry opens no second case.
const logFault = vi.hoisted(() => ({ failOutOnce: false }));
vi.mock('@/db/repos/conversation-log-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/conversation-log-repo')>();
  return {
    ...real,
    createConversationLogRepo: (...args: Parameters<typeof real.createConversationLogRepo>) => {
      const repo = real.createConversationLogRepo(...args);
      return {
        ...repo,
        append: async (...a: Parameters<typeof repo.append>) => {
          if (logFault.failOutOnce && a[0].direction === 'out') {
            logFault.failOutOnce = false;
            throw new Error('log insert failed');
          }
          return repo.append(...a);
        },
      };
    },
  };
});

const P = '15550000002';
const NOTICE_WA = aiNoticeText('en', 'whatsapp');

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const sendText = vi.fn(async (..._a: unknown[]) => {});
const runAgentTurn = vi.fn(async (..._a: unknown[]) => 'Hi! How can I help?');
const transcribeVoice = vi.fn(async (..._a: unknown[]): Promise<VoiceOutcome> => ({ kind: 'ok', transcript: 'HELP' }));

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

const rows = async (kind: string) =>
  ((await db.execute(sql`SELECT id, status, attempts, dedupe_key, payload, next_attempt_at FROM outbox WHERE kind = ${kind} ORDER BY id`)) as unknown as {
    rows: Array<{ id: number; status: string; attempts: number; dedupe_key: string | null; payload: Record<string, unknown> }>;
  }).rows;
const bodies = async () => (await rows('whatsapp.text')).map((r) => r.payload.body);
const noticeRows = async () =>
  ((await db.execute(sql`SELECT partner_id, meta FROM audit_events WHERE action = ${AI_NOTICE_ACTION} ORDER BY id`)) as unknown as {
    rows: Array<{ partner_id: string; meta: Record<string, unknown> }>;
  }).rows;
const thread = (phone = P, tenant = 'default') => createConversationLogRepo(db).listThread(tenant, phone);
const turn = (text: string, over: Record<string, unknown> = {}) =>
  outbox.enqueue('agent.turn', { phone: P, messageText: text, turn: { isNewConversation: false }, routedPartnerId: null, ...over }, { dedupeKey: `wamid:${Math.random()}` });
/** The marker as if a notice went out an hour ago: later turns carry none. */
const noticeShown = (phone = P, surface: 'wa' | 'tg' = 'wa') =>
  recordAiNotice(db, { partnerId: 'default', phone, surface, channel: 'whatsapp', lang: 'en' });

function paidTransfer(): Transfer {
  const now = new Date().toISOString();
  return {
    id: 'tx_cancel1', phone: P, amountUsd: 100, feeUsd: 1, totalChargeUsd: 101, fxRate: 83, amountInr: 8300,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'paid',
    createdAt: now, paidAt: now, sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
    destinationCurrency: 'INR', partnerId: 'default', amountSource: 100, feeSource: 1, totalChargeSource: 101,
    transferType: 'b2c',
  } as Transfer;
}

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  sendText.mockClear();
  runAgentTurn.mockReset();
  runAgentTurn.mockResolvedValue('Hi! How can I help?');
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ kind: 'ok', transcript: 'HELP' });
  logFault.failOutOnce = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('R43: HELP reaches a person without the model', { retry: 0 }, () => {
  it('opens ONE case, answers with the fixed case reply, and never calls the agent', async () => {
    await noticeShown();
    await turn('HELP');
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).not.toHaveBeenCalled();
    const cases = await createTicketRepo(db).listByCustomerInTenant('default', P);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ category: 'human_help', status: 'open' });
    expect(await bodies()).toEqual([helpIntentReply({ intent: 'help', lang: 'en' }, { caseId: cases[0].id, channel: 'whatsapp' })]);
    expect((await rows('ticket.triage')).map((r) => r.dedupe_key)).toEqual([`triage:${cases[0].id}`]);
    expect((await rows('ops.alert')).map((r) => r.dedupe_key)).toContain(`help:${cases[0].id}`);
    expect(sendText).toHaveBeenCalledTimes(1); // the reply went out in the same drain
  });

  it('works while the model is down (the agent would throw)', async () => {
    await noticeShown();
    runAgentTurn.mockRejectedValue(new Error('model down'));
    await turn('talk to a person');
    const r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(0);
    expect(await createTicketRepo(db).listByCustomerInTenant('default', P)).toHaveLength(1);
  });

  it('is ONE transaction: a failed log insert rolls the case back, and the retry opens exactly one case and one reply', async () => {
    await noticeShown();
    logFault.failOutOnce = true;
    await turn('HELP');
    const first = await drainOnce(deps(), 'w1');
    expect(first.failed).toBe(1);
    expect(await createTicketRepo(db).listByCustomerInTenant('default', P)).toHaveLength(0);
    expect(await rows('whatsapp.text')).toHaveLength(0);
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE kind = 'agent.turn'`);
    await drainOnce(deps(), 'w1');
    expect(await createTicketRepo(db).listByCustomerInTenant('default', P)).toHaveLength(1);
    expect(await rows('whatsapp.text')).toHaveLength(1);
    expect((await rows('agent.turn'))[0].status).toBe('done');
  });

  it('a second HELP while the case is open reuses it (no case spam)', async () => {
    await noticeShown();
    await turn('HELP');
    await turn('help');
    await drainOnce(deps(), 'w1');
    const cases = await createTicketRepo(db).listByCustomerInTenant('default', P);
    expect(cases).toHaveLength(1);
    expect(await rows('whatsapp.text')).toHaveLength(2);
    expect(new Set(await bodies()).size).toBe(1); // the same case number both times
  });

  it('a Telegram HELP says where a reply arrives on Telegram', async () => {
    await noticeShown(P, 'tg');
    await turn('HELP', { channel: 'tg', turn: { isNewConversation: false, surface: 'telegram' } });
    await drainOnce(deps(), 'w1');
    const [c] = await createTicketRepo(db).listByCustomerInTenant('default', P);
    expect(await bodies()).toEqual([helpIntentReply({ intent: 'help', lang: 'en' }, { caseId: c.id, channel: 'telegram' })]);
  });

  it('a button tap never opens a case, even when its text reads like one', async () => {
    await noticeShown();
    await turn('cancel', { turn: { isNewConversation: false, buttonTap: { kind: 'cancel', draftId: 'd_1' } } });
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(await createTicketRepo(db).listByCustomerInTenant('default', P)).toHaveLength(0);
  });

  it('a transcribed voice HELP opens the case too', async () => {
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake-speech-key');
    vi.stubEnv('AZURE_SPEECH_REGION', 'eastus');
    vi.stubEnv('DEMO_PHONES', '');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', P);
    await createFeatureFlagRepo(db).upsert({ key: 'voice.notes', scopeType: 'global', scopeId: '', enabled: true, reason: 'voice beta test', updatedBy: 'admin' });
    invalidateFlagCache(db);
    await noticeShown();
    await turn(VOICE_PLACEHOLDER, { turn: { isNewConversation: false, inputModality: 'voice' }, media: { id: '4242', mimeType: 'audio/ogg' } });
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(await createTicketRepo(db).listByCustomerInTenant('default', P)).toHaveLength(1);
  });
});

describe('R43: CANCEL records a case and the bot continues', { retry: 0 }, () => {
  it('with a paid transfer: a cancel_request case is opened AND the agent runs', async () => {
    await noticeShown();
    await store.saveTransfer(paidTransfer());
    await turn('cancel my transfer');
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const cases = await createTicketRepo(db).listByCustomerInTenant('default', P);
    expect(cases).toHaveLength(1);
    const [first] = await createTicketRepo(db).listMessages(cases[0].id, { includeInternal: true });
    expect(first.body).toContain('cancel_request');
    expect(await bodies()).toEqual(['Hi! How can I help?']);
  });

  it('with nothing paid (a draft cancel): no case, the agent runs', async () => {
    await noticeShown();
    await turn('cancel');
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(await createTicketRepo(db).listByCustomerInTenant('default', P)).toHaveLength(0);
  });
});

describe('R56: a clear off-topic request gets the fixed decline without the model', { retry: 0 }, () => {
  it('declines in the customer language and never calls the agent', async () => {
    await noticeShown();
    await turn('write me a python script');
    await turn('escríbeme un poema');
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(await bodies()).toEqual([OFF_TOPIC_REPLY, offTopicReply('es')]);
  });

  it('a money question that mentions the weather still reaches the model', async () => {
    await noticeShown();
    await turn("what's the weather in Hyderabad, will my money arrive today");
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});

describe("R26's paused slot (WorkerDeps.agentPaused)", { retry: 0 }, () => {
  it('a paused tenant gets the fixed menu, no model call; HELP still opens a case', async () => {
    await noticeShown();
    await turn('send $100 to Mom');
    await turn('HELP');
    const seen: string[] = [];
    await drainOnce(deps({ agentPaused: async (t) => { seen.push(t); return true; } }), 'w1');
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(seen).toContain('default');
    const [c] = await createTicketRepo(db).listByCustomerInTenant('default', P);
    expect(await bodies()).toEqual([pausedReply('en'), helpIntentReply({ intent: 'help', lang: 'en' }, { caseId: c.id, channel: 'whatsapp' })]);
  });
});

describe('R17: the AI notice leads the first reply and comes back after 24 hours', { retry: 0 }, () => {
  it('first turn: notice on top + ONE ai.notice_shown row; second turn: no notice, no new row', async () => {
    await turn('hello');
    await drainOnce(deps(), 'w1');
    await turn('send $100 to Mom');
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${NOTICE_WA}\n\nHi! How can I help?`, 'Hi! How can I help?']);
    const n = await noticeRows();
    expect(n).toHaveLength(1);
    expect(n[0].partner_id).toBe('default');
    expect(n[0].meta).toMatchObject({ surface: 'wa', channel: 'whatsapp', lang: 'en' });
    // The log holds what the customer saw.
    expect((await thread()).filter((m) => m.direction === 'out').map((m) => m.text)).toEqual([`${NOTICE_WA}\n\nHi! How can I help?`, 'Hi! How can I help?']);
  });

  it('a marker over 24 hours old brings the notice back', async () => {
    // audit_events is append-only: write the old marker with its time directly.
    await db.execute(sql`INSERT INTO audit_events (partner_id, actor, actor_type, action, subject_id, meta, at)
      VALUES ('default', 'bot', 'system', ${AI_NOTICE_ACTION}, ${auditSubjectId('default', P)}, ${JSON.stringify({ surface: 'wa' })}::jsonb,
              now() - make_interval(secs => ${AI_NOTICE_INTERVAL_MS / 1000 + 60}))`);
    await turn('hello');
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${NOTICE_WA}\n\nHi! How can I help?`]);
    expect(await noticeRows()).toHaveLength(2);
  });

  it('is per tenant: a notice on the shared number does not cover a partner number', async () => {
    await noticeShown();
    await turn('hello', { routedPartnerId: 'acme' });
    await drainOnce(deps(), 'w1');
    const [row] = await rows('whatsapp.text');
    expect(String(row.payload.body).startsWith(NOTICE_WA)).toBe(true);
    expect(row.payload.partnerId).toBe('acme');
  });

  it('is in the customer language (Spanish), and the reply follows it', async () => {
    runAgentTurn.mockResolvedValue('¡Hola! ¿En qué le ayudo?');
    await turn('hola, quiero enviar dinero a mi mamá');
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${aiNoticeText('es', 'whatsapp')}\n\n¡Hola! ¿En qué le ayudo?`]);
  });

  it('Telegram gets the Telegram notice and its own marker', async () => {
    await noticeShown(); // a WhatsApp notice does not cover Telegram
    await turn('hello', { channel: 'tg', turn: { isNewConversation: false, surface: 'telegram' } });
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${aiNoticeText('en', 'telegram')}\n\nHi! How can I help?`]);
    expect((await noticeRows()).map((r) => r.meta.surface)).toEqual(['wa', 'tg']);
  });

  it('a card-only first turn gets a notice-only row, logged with the card marker', async () => {
    runAgentTurn.mockResolvedValue('');
    await turn('send $100 to Mom');
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([NOTICE_WA]);
    expect((await thread()).filter((m) => m.direction === 'out').map((m) => m.text)).toEqual([`${NOTICE_WA}\n\n${CARD_MARKER}`]);
    expect(await noticeRows()).toHaveLength(1);
  });

  it('a card-only later turn still sends nothing and logs the card marker', async () => {
    await noticeShown();
    runAgentTurn.mockResolvedValue('');
    await turn('send $100 to Mom');
    await drainOnce(deps(), 'w1');
    expect(await rows('whatsapp.text')).toHaveLength(0);
    expect((await thread()).filter((m) => m.direction === 'out').map((m) => m.text)).toEqual([CARD_MARKER]);
  });

  it('the HELP and off-topic replies carry the notice on a first turn too', async () => {
    await turn('write me a poem about the sea');
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${NOTICE_WA}\n\n${OFF_TOPIC_REPLY}`]);
  });

  it('the FALLBACK detection still fires on the raw reply when the notice is added', async () => {
    runAgentTurn.mockResolvedValue(FALLBACK_REPLY);
    await turn('hello');
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${NOTICE_WA}\n\n${FALLBACK_REPLY}`]);
    expect((await rows('ops.alert')).map((r) => r.dedupe_key).some((k) => k?.startsWith('botfallback:'))).toBe(true);
  });

  it('the busy fallback (past the wait bound) carries the notice', async () => {
    await store.tryTurnLock('default', P, 'holder');
    await turn('hello');
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '11 minutes' WHERE kind = 'agent.turn'`);
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(await bodies()).toEqual([`${NOTICE_WA}\n\n${FALLBACK_REPLY}`]);
    expect(await noticeRows()).toHaveLength(1);
  });

  it('a voice-note failure carries the voice notice; voice notes switched off carry the plain one', async () => {
    vi.stubEnv('AZURE_SPEECH_KEY', 'fake-speech-key');
    vi.stubEnv('AZURE_SPEECH_REGION', 'eastus');
    vi.stubEnv('DEMO_PHONES', '');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', P);
    await createFeatureFlagRepo(db).upsert({ key: 'voice.notes', scopeType: 'global', scopeId: '', enabled: true, reason: 'voice beta test', updatedBy: 'admin' });
    invalidateFlagCache(db);
    transcribeVoice.mockResolvedValue({ kind: 'failed' } as VoiceOutcome);
    await turn(VOICE_PLACEHOLDER, { turn: { isNewConversation: false, inputModality: 'voice' }, media: { id: '4242', mimeType: 'audio/ogg' } });
    await drainOnce(deps(), 'w1');
    expect(await bodies()).toEqual([`${aiNoticeText('en', 'voice')}\n\n${VOICE_FAIL_REPLY}`]);
    expect((await noticeRows())[0].meta).toMatchObject({ channel: 'voice' });

    // A different customer, with voice notes off: the media reply and the plain notice.
    const Q = '15550000003';
    await outbox.enqueue('agent.turn', { phone: Q, messageText: VOICE_PLACEHOLDER, turn: { inputModality: 'voice' }, routedPartnerId: null, media: { id: '4243', mimeType: 'audio/ogg' } });
    await drainOnce(deps({ transcribeVoice: undefined }), 'w1');
    expect((await bodies())[1]).toBe(`${NOTICE_WA}\n\n${MEDIA_REPLY}`);
  });
});

describe('the unknown-outbox-kind default defers the row without spending an attempt', { retry: 0 }, () => {
  it('a row of a kind this build does not know waits (pending, attempts 0) and raises ONE deduped alert', async () => {
    await outbox.enqueue('future.kind' as OutboxKind, { anything: 1 });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 0, dead: 0, released: 1 });
    const [row] = await rows('future.kind');
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    const day = new Date().toISOString().slice(0, 10);
    expect((await rows('ops.alert')).map((a) => a.dedupe_key)).toEqual([`unknownkind:future.kind:${day}`]);
    // Due again later: still no attempt spent, still one alert.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE kind = 'future.kind'`);
    await drainOnce(deps(), 'w1');
    expect((await rows('future.kind'))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await rows('ops.alert')).filter((a) => a.dedupe_key?.startsWith('unknownkind:'))).toHaveLength(1);
  });

  it('the alert names the kind only, bounded and flattened', async () => {
    await outbox.enqueue(`odd kind\n${'x'.repeat(300)}` as OutboxKind, {});
    await drainOnce(deps(), 'w1');
    const [alert] = await rows('ops.alert');
    const msg = String(alert.payload.message);
    expect(msg.split('\n')).toHaveLength(1);
    expect(msg.length).toBeLessThan(400);
    expect(alert.dedupe_key!.length).toBeLessThan(120);
  });
});
