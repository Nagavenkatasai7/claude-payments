import { describe, it, expect } from 'vitest';
import { createDraftStore } from '@/lib/draft-store';
import { fakeRedis } from './helpers';
import type { Draft } from '@/lib/types';

function sampleDraft(): Omit<Draft, 'createdAt'> {
  return {
    senderPhone: '15551234567',
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
    const ptr = await ds.getActiveDraftId('15551234567');
    expect(ptr).toBe(draftId);
  });

  it('consumeDraft clears the active-draft pointer when it still points to the consumed draft', async () => {
    const ds = createDraftStore(fakeRedis());
    const draftId = await ds.createDraft(sampleDraft());
    await ds.consumeDraft(draftId);
    const ptr = await ds.getActiveDraftId('15551234567');
    expect(ptr).toBeNull();
  });

  it('getActiveDraftId returns null for a phone with no draft', async () => {
    const ds = createDraftStore(fakeRedis());
    expect(await ds.getActiveDraftId('19999999999')).toBeNull();
  });

  it('second createDraft for same phone updates pointer to the newer draftId', async () => {
    const ds = createDraftStore(fakeRedis());
    const olderDraftId = await ds.createDraft(sampleDraft());
    const newerDraftId = await ds.createDraft(sampleDraft());
    expect(olderDraftId).not.toBe(newerDraftId);
    const ptr = await ds.getActiveDraftId('15551234567');
    expect(ptr).toBe(newerDraftId);
  });

  it('consuming the older draft does NOT clear the newer pointer', async () => {
    const ds = createDraftStore(fakeRedis());
    const olderDraftId = await ds.createDraft(sampleDraft());
    const newerDraftId = await ds.createDraft(sampleDraft());
    // consume the older one — pointer now points to newer, so it must not be cleared
    await ds.consumeDraft(olderDraftId);
    const ptr = await ds.getActiveDraftId('15551234567');
    expect(ptr).toBe(newerDraftId);
  });

  it('draft quote accepts optional enriched fields without breaking existing creation', async () => {
    const ds = createDraftStore(fakeRedis());
    const enrichedInput: Omit<Draft, 'createdAt'> = {
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
});
