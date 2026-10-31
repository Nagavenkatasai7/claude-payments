import { describe, it, expect, vi } from 'vitest';
import { encryptField } from '@/lib/field-crypto';
import { draftSealCtx, sealedDraftPointerKey } from '@/lib/redis-seal';
import { createDraftStore } from '@/lib/draft-store';
import { fakeRedis } from './helpers';
import type { Draft } from '@/lib/types';

function sampleDraft(): Omit<Draft, 'createdAt'> & { partnerId: string } {
  return {
    senderPhone: '15551234567',
    partnerId: 'default',
    recipient: {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
    },
    amountUsd: 300,
    amountSource: 300,
    sourceCurrency: 'USD',
    fundingMethod: 'bank_transfer',
    quote: { feeUsd: 1.99, fxRate: 84, amountInr: 25200 },
  };
}

describe('draft store', () => {
  it('createDraft returns an id you can immediately get', async () => {
    const ds = createDraftStore(fakeRedis());
    const draftId = await ds.createDraft(sampleDraft());
    const fetched = await ds.getDraft(draftId);
    expect(fetched?.senderPhone).toBe('15551234567');
    expect(fetched?.amountUsd).toBe(300);
    expect(typeof fetched?.createdAt).toBe('string');
  });

  it('getDraft returns null for an unknown id', async () => {
    const ds = createDraftStore(fakeRedis());
    expect(await ds.getDraft('nopeNope')).toBeNull();
  });

  it('consumeDraft returns the draft and deletes it', async () => {
    const ds = createDraftStore(fakeRedis());
    const draftId = await ds.createDraft(sampleDraft());
    const consumed = await ds.consumeDraft(draftId);
    expect(consumed?.senderPhone).toBe('15551234567');
    expect(await ds.getDraft(draftId)).toBeNull();
  });

  it('consumeDraft a second time returns null (atomic)', async () => {
    const ds = createDraftStore(fakeRedis());
    const draftId = await ds.createDraft(sampleDraft());
    await ds.consumeDraft(draftId);
    expect(await ds.consumeDraft(draftId)).toBeNull();
  });

  it('createDraft generates distinct ids for distinct drafts', async () => {
    const ds = createDraftStore(fakeRedis());
    const a = await ds.createDraft(sampleDraft());
    const b = await ds.createDraft(sampleDraft());
    expect(a).not.toBe(b);
  });

  it('P4: round-trips source-currency fields on a draft', async () => {
    const store = createDraftStore(fakeRedis());
    const id = await store.createDraft({
      partnerId: 'default',
      senderPhone: '15551230000',
      recipient: { name: 'Asha', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'asha@upi' },
      amountUsd: 254,
      amountSource: 200,
      sourceCurrency: 'GBP',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21600 },
    });
    const got = await store.consumeDraft(id);
    expect(got?.amountSource).toBe(200);
    expect(got?.sourceCurrency).toBe('GBP');
  });

  // ── TTL=1800 + active-draft pointer tests ─────────────────────────────

  it('createDraft writes an active-draft pointer for the sender phone', async () => {
    const ds = createDraftStore(fakeRedis());
    const draftId = await ds.createDraft(sampleDraft());
    const ptr = await ds.getActiveDraftId('default', '15551234567');
    expect(ptr).toBe(draftId);
  });

  it('consumeDraft clears the active-draft pointer when it still points to the consumed draft', async () => {
    const ds = createDraftStore(fakeRedis());
    const draftId = await ds.createDraft(sampleDraft());
    await ds.consumeDraft(draftId);
    const ptr = await ds.getActiveDraftId('default', '15551234567');
    expect(ptr).toBeNull();
  });

  it('getActiveDraftId returns null for a phone with no draft', async () => {
    const ds = createDraftStore(fakeRedis());
    expect(await ds.getActiveDraftId('default', '19999999999')).toBeNull();
  });

  it('second createDraft for same phone updates pointer to the newer draftId', async () => {
    const ds = createDraftStore(fakeRedis());
    const olderDraftId = await ds.createDraft(sampleDraft());
    const newerDraftId = await ds.createDraft(sampleDraft());
    expect(olderDraftId).not.toBe(newerDraftId);
    const ptr = await ds.getActiveDraftId('default', '15551234567');
    expect(ptr).toBe(newerDraftId);
  });

  it('consuming the older draft does NOT clear the newer pointer', async () => {
    const ds = createDraftStore(fakeRedis());
    const olderDraftId = await ds.createDraft(sampleDraft());
    const newerDraftId = await ds.createDraft(sampleDraft());
    // consume the older one — pointer now points to newer, so it must not be cleared
    await ds.consumeDraft(olderDraftId);
    const ptr = await ds.getActiveDraftId('default', '15551234567');
    expect(ptr).toBe(newerDraftId);
  });

  it('draft quote accepts optional enriched fields without breaking existing creation', async () => {
    const ds = createDraftStore(fakeRedis());
    const enrichedInput: Omit<Draft, 'createdAt'> & { partnerId: string } = {
      ...sampleDraft(),
      quote: {
        feeUsd: 1.99,
        fxRate: 84,
        amountInr: 25200,
        feeSource: 1.57,
        totalChargeSource: 301.57,
        totalChargeUsd: 301.99,
      },
    };
    const draftId = await ds.createDraft(enrichedInput);
    const fetched = await ds.getDraft(draftId);
    expect(fetched?.quote.feeSource).toBe(1.57);
    expect(fetched?.quote.totalChargeSource).toBe(301.57);
    expect(fetched?.quote.totalChargeUsd).toBe(301.99);
  });

  it('keys the active-draft pointer by (partnerId, phone) and restoreDraft puts a consumed draft back under ITS tenant (fix 1, D12)', async () => {
    const redis = fakeRedis();
    const ds = createDraftStore(redis);
    const id = await ds.createDraft({ ...sampleDraft(), partnerId: 'acme' });
    expect(redis.dump.has('active_draft:acme:15551234567')).toBe(true);
    expect(await ds.getActiveDraftId('default', '15551234567')).toBeNull();
    const consumed = (await ds.consumeDraft(id))!;
    expect(await ds.getActiveDraftId('acme', '15551234567')).toBeNull();
    await ds.restoreDraft(consumed, id);
    expect(await ds.getActiveDraftId('acme', '15551234567')).toBe(id);
    expect((await ds.getDraft(id))?.partnerId).toBe('acme');
  });
});

// R49 part 1: the sealed-draft READERS. This build still writes plaintext
// drafts and phone pointers; PR9 seals the draft under its id and writes only
// the HMAC pointer. Every reader here takes both formats.
describe('draft store reads the sealed format too (R49 readers)', () => {
  const PH = '15551234567';
  const sealDraft = (redis: ReturnType<typeof fakeRedis>, id: string, draft: Record<string, unknown>, ctxId = id) =>
    redis.dump.set(`recipient_draft:${id}`, encryptField(JSON.stringify(draft), undefined, draftSealCtx(ctxId)));
  const stored = () => ({ ...sampleDraft(), createdAt: new Date().toISOString() });

  it('a legacy JSON draft still reads', async () => {
    const redis = fakeRedis();
    redis.dump.set('recipient_draft:legacy1', JSON.stringify(stored()));
    expect((await createDraftStore(redis).getDraft('legacy1'))?.amountUsd).toBe(300);
  });

  it('a sealed draft reads and consumes; the raw value holds no phone or payout', async () => {
    const redis = fakeRedis();
    sealDraft(redis, 'sealed1', stored());
    expect(redis.dump.get('recipient_draft:sealed1')).not.toContain(PH);
    expect(redis.dump.get('recipient_draft:sealed1')).not.toContain('mom@upi');
    const ds = createDraftStore(redis);
    expect((await ds.getDraft('sealed1'))?.recipient.name).toBe('Mom');
    expect((await ds.consumeDraft('sealed1'))?.amountUsd).toBe(300);
    expect(await ds.getDraft('sealed1')).toBeNull();
  });

  it('a sealed blob copied to another draft id does not open (null, error name logged only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redis = fakeRedis();
    sealDraft(redis, 'other', stored(), 'original');
    const ds = createDraftStore(redis);
    expect(await ds.getDraft('other')).toBeNull();
    expect(await ds.consumeDraft('other')).toBeNull();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('draft');
    expect(logged).not.toContain(PH);
    warn.mockRestore();
  });

  it('getActiveDraftId falls back to the HMAC pointer (a PR9 write); the key holds no phone', async () => {
    const redis = fakeRedis();
    const bot = sealedDraftPointerKey('default', PH, 'bot');
    const web = sealedDraftPointerKey('default', PH, 'web');
    expect(bot).not.toContain(PH);
    redis.dump.set(bot, 'draftBot');
    redis.dump.set(web, 'draftWeb');
    const ds = createDraftStore(redis);
    expect(await ds.getActiveDraftId('default', PH)).toBe('draftBot');
    expect(await ds.getActiveDraftId('default', PH, 'web')).toBe('draftWeb');
    expect(await ds.getActiveDraftId('acme', PH)).toBeNull();
  });

  it("the plaintext pointer (this build's own write) wins when both exist", async () => {
    const redis = fakeRedis();
    redis.dump.set(sealedDraftPointerKey('default', PH, 'bot'), 'olderSealed');
    const ds = createDraftStore(redis);
    const id = await ds.createDraft(sampleDraft());
    expect(await ds.getActiveDraftId('default', PH)).toBe(id);
  });

  it('consumeDraft clears both pointers when they point at the consumed draft, and neither when they do not', async () => {
    const redis = fakeRedis();
    sealDraft(redis, 'sealed2', stored());
    const bot = sealedDraftPointerKey('default', PH, 'bot');
    redis.dump.set(bot, 'sealed2');
    redis.dump.set(`active_draft:default:${PH}`, 'sealed2');
    const ds = createDraftStore(redis);
    await ds.consumeDraft('sealed2');
    expect(redis.dump.has(bot)).toBe(false);
    expect(redis.dump.has(`active_draft:default:${PH}`)).toBe(false);

    sealDraft(redis, 'sealed3', stored());
    redis.dump.set(bot, 'newer');
    await ds.consumeDraft('sealed3');
    expect(redis.dump.get(bot)).toBe('newer');
  });

  it('a web draft clears only the web HMAC pointer', async () => {
    const redis = fakeRedis();
    sealDraft(redis, 'w1', { ...stored(), channel: 'web' });
    redis.dump.set(sealedDraftPointerKey('default', PH, 'web'), 'w1');
    redis.dump.set(sealedDraftPointerKey('default', PH, 'bot'), 'w1');
    await createDraftStore(redis).consumeDraft('w1');
    expect(redis.dump.has(sealedDraftPointerKey('default', PH, 'web'))).toBe(false);
    expect(redis.dump.get(sealedDraftPointerKey('default', PH, 'bot'))).toBe('w1');
  });
});
