import { describe, it, expect } from 'vitest';
import { createDraftStore } from '@/lib/draft-store';
import type { Draft } from '@/lib/types';
import { fakeRedis } from './helpers';
import { draftWithRiskSignals, riskConfigFor } from './helpers-risk';

// Fix pack 6 (P24, T25): the risk-signal test helpers.

describe('riskConfigFor', () => {
  it('defaults to the stored shape: on, $500, 72 h, nothing held', () => {
    expect(riskConfigFor()).toEqual({ enabled: true, amountUsd: 500, newAccountHours: 72, hold: [] });
  });

  it('overrides win and hold is a fresh mutable copy', () => {
    const hold = Object.freeze(['chat_cue'] as const);
    const c = riskConfigFor({ enabled: false, amountUsd: 900, hold });
    expect(c).toEqual({ enabled: false, amountUsd: 900, newAccountHours: 72, hold: ['chat_cue'] });
    expect(c.hold).not.toBe(hold);
    expect(Object.isFrozen(c.hold)).toBe(false);
  });
});

describe('draftWithRiskSignals', () => {
  it('writes riskSignals onto the real draft and returns it; other fields kept', async () => {
    const ds = createDraftStore(fakeRedis());
    const draft = { partnerId: 'acme', senderPhone: '15550100252', recipientName: 'Mom', amountUsd: 100 } as unknown as Draft;
    await ds.restoreDraft(draft, 'd_risk_1');
    const out = await draftWithRiskSignals(ds, { draftId: 'd_risk_1', riskSignals: ['first_transfer'] });
    expect(out).toMatchObject({ senderPhone: '15550100252', recipientName: 'Mom', riskSignals: ['first_transfer'] });
    expect(await ds.getDraft('d_risk_1')).toMatchObject({ riskSignals: ['first_transfer'], amountUsd: 100 });
  });

  it('throws on a missing draft', async () => {
    const ds = createDraftStore(fakeRedis());
    await expect(draftWithRiskSignals(ds, { draftId: 'nope', riskSignals: [] })).rejects.toThrow('no draft nope');
  });
});
