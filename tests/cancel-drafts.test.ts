import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as drafts from '@/lib/legal/cancel-drafts';
import type { Transfer } from '@/lib/types';

// Program-Fix 15 PR C — the sender-cancel copy is a DRAFT for counsel (C2).
// Same rules as the disclosure drafts: no approval wording, and no refund
// promise where no refund is queued; the held-transfer reply names no review.

const t = {
  id: 'tr_cd1', fundingMethod: 'bank_transfer', totalChargeUsd: 205, totalChargeSource: 205, sourceCurrency: 'USD',
} as unknown as Transfer;

describe('cancel-drafts', { retry: 0 }, () => {
  it('contains no approval wording anywhere in the module', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/legal/cancel-drafts.ts'), 'utf-8');
    expect(src).not.toMatch(/approv/i);
  });

  it('marks the receipt card body as a draft for counsel', () => {
    expect(drafts.CANCEL_CARD_BODY).toMatch(/draft/i);
    expect(drafts.CANCEL_CARD_BODY).toMatch(/counsel/i);
  });

  it('the confirmation promises a full refund only when one is queued', () => {
    const queued = drafts.buildSenderCancelMessage(t, true);
    expect(queued).toContain('tr_cd1');
    expect(queued).toContain('$205.00');
    expect(queued).toMatch(/refund/i);
    expect(queued).toMatch(/3 business days/);
    const none = drafts.buildSenderCancelMessage(t, false);
    expect(none).toContain('tr_cd1');
    expect(none).not.toMatch(/refund/i);
  });

  it('a partner-pulled charge is REVERSED, never "refunded to a payment method"', () => {
    const m = drafts.buildSenderCancelMessage({ ...t, fundingMethod: 'ach_pull' } as Transfer, true);
    expect(m).toMatch(/revers/i);
    expect(m).not.toMatch(/payment method/i);
  });

  it('the held-transfer reply is neutral: no refund promise, no review/compliance wording', () => {
    expect(drafts.CANCEL_REPLY_HINT.heldRequested).not.toMatch(/refund|review|compliance|screen|sanction|hold/i);
  });

  it('the button carries the deadline', () => {
    expect(drafts.cancelButtonLabel('3:45 PM UTC')).toBe('Cancel this transfer (until 3:45 PM UTC)');
  });
});
