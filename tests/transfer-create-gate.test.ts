import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransfer, type CreateTransferInput } from '@/lib/transfer-create';

function baseInput(over: Partial<CreateTransferInput> = {}): CreateTransferInput {
  return {
    phone: '15551230000',
    recipientName: 'R',
    recipientPhone: '910000',
    payoutMethod: 'bank',
    payoutDestination: 'acct',
    fundingMethod: 'bank_transfer',
    amountSource: 100,
    sourceCurrency: 'USD',
    partnerId: 'default',
    senderKycStatus: 'verified',
    ...over,
  };
}

function stores() {
  const r = fakeRedis();
  return [createStore(r), createPartnerStore(r), createMonthlyVolumeStore(r)] as const;
}

describe('createTransfer KYC backstop (Phase 3)', () => {
  it('throws kyc_required when senderKycStatus is not "verified"', async () => {
    const [s, p, m] = stores();
    await expect(createTransfer(s, p, m, baseInput({ senderKycStatus: 'grandfathered' }))).rejects.toThrow(/kyc_required/);
    const [s2, p2, m2] = stores();
    await expect(createTransfer(s2, p2, m2, baseInput({ senderKycStatus: 'not_started' }))).rejects.toThrow(/kyc_required/);
  });

  it('proceeds for a verified sender', async () => {
    const [s, p, m] = stores();
    const t = await createTransfer(s, p, m, baseInput());
    expect(t.id).toBeTruthy();
  });
});

describe('createTransfer WL1 delegated-KYC gate (requiresKyc)', () => {
  it('requiresKyc absent ⇒ still throws for an unverified sender (default unchanged)', async () => {
    const [s, p, m] = stores();
    await expect(
      createTransfer(s, p, m, baseInput({ senderKycStatus: 'not_started' })),
    ).rejects.toThrow(/kyc_required/);
  });

  it('requiresKyc:false (delegated) mints even when the sender is NOT verified', async () => {
    const [s, p, m] = stores();
    const t = await createTransfer(
      s,
      p,
      m,
      baseInput({ senderKycStatus: 'not_started', requiresKyc: false }),
    );
    expect(t.id).toBeTruthy();
    expect(t.status).toBe('awaiting_payment');
  });

  it('SANCTIONS SURVIVE DELEGATION: a watchlisted recipient is still blocked with requiresKyc:false', async () => {
    const [s, p, m] = stores();
    const t = await createTransfer(
      s,
      p,
      m,
      baseInput({
        senderKycStatus: 'not_started',
        requiresKyc: false,
        recipientName: 'John Doe', // on WATCHLIST
      }),
    );
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });
});
