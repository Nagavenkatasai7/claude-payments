import { describe, it, expect } from 'vitest';
import { createDraftStore } from '@/lib/draft-store';
import { executeTool, type ToolContext } from '@/lib/tools';
import type { Draft } from '@/lib/types';
import { fakeRedis, type FakeRedis } from './helpers';

// UI redesign M2-4, Task 4.1: the web draft pointer lives in its OWN namespace.
// The bot's cancel_draft falls back to the (tenant, phone) active-draft pointer
// (tools.ts cancelDraftTool), so a web draft that shared it could be consumed
// by a WhatsApp "cancel". Bot drafts keep today's key byte-for-byte.

const PID = 'pa';
const PHONE = '14155550101';

function input(): Omit<Draft, 'createdAt'> & { partnerId: string } {
  return {
    senderPhone: PHONE,
    partnerId: PID,
    recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
    amountUsd: 100,
    amountSource: 100,
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 8500 },
  };
}

/** The WhatsApp cancel_draft path (typed "cancel", no button tap). */
function botCtx(redis: FakeRedis): ToolContext {
  return {
    phone: PHONE,
    partnerId: PID,
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false },
  } as unknown as ToolContext;
}

describe('draft store — web-namespaced pointer (M2-4 Task 4.1)', () => {
  it('a bot draft writes exactly the keys it writes today, and no channel field', async () => {
    const redis = fakeRedis();
    const id = await createDraftStore(redis).createDraft(input());
    expect([...redis.dump.keys()].sort()).toEqual([`active_draft:${PID}:${PHONE}`, `recipient_draft:${id}`].sort());
    expect(redis.dump.get(`active_draft:${PID}:${PHONE}`)).toBe(id);
    expect(JSON.parse(redis.dump.get(`recipient_draft:${id}`)!)).not.toHaveProperty('channel');
    // The explicit 'bot' option is the default, byte-for-byte.
    const redis2 = fakeRedis();
    const id2 = await createDraftStore(redis2).createDraft(input(), { pointer: 'bot' });
    expect([...redis2.dump.keys()].sort()).toEqual([`active_draft:${PID}:${PHONE}`, `recipient_draft:${id2}`].sort());
  });

  it('a web draft does NOT touch the bot pointer; it writes the web pointer and channel "web"', async () => {
    const redis = fakeRedis();
    const store = createDraftStore(redis);
    const id = await store.createDraft(input(), { pointer: 'web' });
    expect(redis.dump.has(`active_draft:${PID}:${PHONE}`)).toBe(false);
    expect(redis.dump.get(`active_draft:web:${PID}:${PHONE}`)).toBe(id);
    expect(JSON.parse(redis.dump.get(`recipient_draft:${id}`)!).channel).toBe('web');
    expect(await store.getActiveDraftId(PID, PHONE)).toBeNull();
    expect(await store.getActiveDraftId(PID, PHONE, 'web')).toBe(id);
  });

  it("the collision case: the bot's cancel_draft cannot consume a web draft", async () => {
    const redis = fakeRedis();
    const store = createDraftStore(redis);
    const webId = await store.createDraft(input(), { pointer: 'web' });
    const r = await executeTool('cancel_draft', {}, botCtx(redis));
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('no_active_draft');
    expect(await store.getDraft(webId)).not.toBeNull();
    expect(redis.dump.get(`active_draft:web:${PID}:${PHONE}`)).toBe(webId);
  });

  it('with both a bot and a web draft, cancel_draft consumes only the bot draft', async () => {
    const redis = fakeRedis();
    const store = createDraftStore(redis);
    const webId = await store.createDraft(input(), { pointer: 'web' });
    const botId = await store.createDraft(input());
    const r = await executeTool('cancel_draft', {}, botCtx(redis));
    expect(r.cancelled).toBe(true);
    expect(await store.getDraft(botId)).toBeNull();
    expect(await store.getDraft(webId)).not.toBeNull();
  });

  it('consumeDraft(webDraftId) clears only the web pointer', async () => {
    const redis = fakeRedis();
    const store = createDraftStore(redis);
    const botId = await store.createDraft(input());
    const webId = await store.createDraft(input(), { pointer: 'web' });
    const consumed = await store.consumeDraft(webId);
    expect(consumed?.channel).toBe('web');
    expect(redis.dump.has(`active_draft:web:${PID}:${PHONE}`)).toBe(false);
    expect(redis.dump.get(`active_draft:${PID}:${PHONE}`)).toBe(botId);
  });

  it('restoreDraft puts a web draft back under the web pointer only', async () => {
    const redis = fakeRedis();
    const store = createDraftStore(redis);
    const webId = await store.createDraft(input(), { pointer: 'web' });
    const draft = (await store.consumeDraft(webId))!;
    await store.restoreDraft(draft, webId);
    expect(redis.dump.get(`active_draft:web:${PID}:${PHONE}`)).toBe(webId);
    expect(redis.dump.has(`active_draft:${PID}:${PHONE}`)).toBe(false);
  });

  it('a draft JSON written by the pre-seam code (no channel) consumes exactly as before', async () => {
    const redis = fakeRedis();
    const legacy = { ...input(), createdAt: new Date().toISOString() };
    await redis.set('recipient_draft:legacy1', JSON.stringify(legacy));
    await redis.set(`active_draft:${PID}:${PHONE}`, 'legacy1');
    const consumed = await createDraftStore(redis).consumeDraft('legacy1');
    expect(consumed).toEqual(legacy);
    expect(redis.dump.has(`active_draft:${PID}:${PHONE}`)).toBe(false);
    expect(redis.dump.has('recipient_draft:legacy1')).toBe(false);
  });

  it('the web pointer is per tenant: pa and pb with the same phone never share it', async () => {
    const redis = fakeRedis();
    const store = createDraftStore(redis);
    const a = await store.createDraft(input(), { pointer: 'web' });
    const b = await store.createDraft({ ...input(), partnerId: 'pb' }, { pointer: 'web' });
    expect(await store.getActiveDraftId('pa', PHONE, 'web')).toBe(a);
    expect(await store.getActiveDraftId('pb', PHONE, 'web')).toBe(b);
    await store.consumeDraft(b);
    expect(await store.getActiveDraftId('pa', PHONE, 'web')).toBe(a);
  });
});
