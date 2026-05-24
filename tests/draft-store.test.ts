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
});
