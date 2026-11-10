// Pack 2 review round 3 (S2: M2, M6): ONE pure answer to "was the sender
// charged" for the sanctions block notices and the list re-screen alert.
import { describe, it, expect } from 'vitest';
import { isPartnerPulled, senderWasCharged } from '@/lib/funding-method';

describe('isPartnerPulled', () => {
  it('is true for ach_pull and bank_pull only', () => {
    expect(isPartnerPulled('ach_pull')).toBe(true);
    expect(isPartnerPulled('bank_pull')).toBe(true);
    expect(isPartnerPulled('credit_card')).toBe(false);
    expect(isPartnerPulled('debit_card')).toBe(false);
    expect(isPartnerPulled('bank_transfer')).toBe(false);
  });
});

describe('senderWasCharged', () => {
  it.each(['credit_card', 'debit_card', 'bank_transfer'] as const)('%s with a fundingRef: charged', (fundingMethod) => {
    expect(senderWasCharged({ fundingMethod, fundingRef: 'pi_1' })).toBe(true);
  });

  it.each(['credit_card', 'debit_card', 'bank_transfer'] as const)('%s without a fundingRef: not charged', (fundingMethod) => {
    expect(senderWasCharged({ fundingMethod })).toBe(false);
    expect(senderWasCharged({ fundingMethod, fundingRef: undefined })).toBe(false);
    expect(senderWasCharged({ fundingMethod, fundingRef: '' })).toBe(false);
  });

  it.each(['ach_pull', 'bank_pull'] as const)('%s (partner-pulled) is never charged here, even with a fundingRef', (fundingMethod) => {
    expect(senderWasCharged({ fundingMethod })).toBe(false);
    expect(senderWasCharged({ fundingMethod, fundingRef: 'pull_1' })).toBe(false);
  });
});
