import type { ComplianceStatus } from './types';

// Mock sanctions/watchlist — clearly fake names for the prototype.
export const WATCHLIST = ['john doe', 'jane roe', 'test blocked'];
export const LARGE_AMOUNT_USD = 1000;
export const VELOCITY_LIMIT = 3;

export interface ComplianceResult {
  status: ComplianceStatus;
  reasons: string[];
}

export function screenTransfer(input: {
  amountUsd: number;
  recipientName: string;
  transfersToday: number;
}): ComplianceResult {
  const name = input.recipientName.trim().toLowerCase();
  if (WATCHLIST.includes(name)) {
    return {
      status: 'blocked',
      reasons: ['Recipient is on the compliance watchlist.'],
    };
  }
  const reasons: string[] = [];
  if (input.amountUsd >= LARGE_AMOUNT_USD) {
    reasons.push('Large transfer amount.');
  }
  if (input.transfersToday >= VELOCITY_LIMIT) {
    reasons.push('High transfer velocity.');
  }
  if (reasons.length > 0) return { status: 'flagged', reasons };
  return { status: 'cleared', reasons: [] };
}
