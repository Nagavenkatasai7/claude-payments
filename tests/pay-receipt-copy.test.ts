import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAY_HELD_LABEL,
  PAY_RECEIPT_CANCELLED_CHARGED_COPY,
  PAY_RECEIPT_CANCELLED_CONTACT_COPY,
  PAY_RECEIPT_NOT_COMPLETED_COPY,
  PAY_RECEIPT_PRINT_HINT,
  PAY_RECEIPT_REFUNDED_COPY,
  PAY_SUCCESS_RECEIPT_COPY,
} from '@/lib/pay-outcome';
import { FIXED_REPLIES } from '@/lib/hold-replies';
import { en } from '@/lib/i18n/catalogues/en';

/**
 * Fix pack 6 T11 (P20): the pay pages' fixed receipt and done-state copy. pay-outcome.ts is
 * client-safe, so it keeps its own twins of en.ts and hold-replies.ts; these pins keep them equal.
 */
describe('pay receipt copy (pack 6 P20)', () => {
  it('the print hint equals the portal receipt hint', () => {
    expect(PAY_RECEIPT_PRINT_HINT).toBe(en['portal.receipt.printHint']);
  });

  it("the held label equals FIXED_REPLIES.label_held ('Processing')", () => {
    expect(PAY_HELD_LABEL).toBe(FIXED_REPLIES.label_held);
    expect(PAY_HELD_LABEL).toBe('Processing');
  });

  it('the four fixed lines are pinned literally', () => {
    expect(PAY_SUCCESS_RECEIPT_COPY).toBe('Payment complete! Reload this page to see and print your receipt.');
    expect(PAY_RECEIPT_NOT_COMPLETED_COPY).toBe('This transfer was not completed. Nothing was charged.');
    expect(PAY_RECEIPT_REFUNDED_COPY).toBe('This payment was refunded.');
    expect(PAY_RECEIPT_CANCELLED_CHARGED_COPY).toBe('This transfer was not completed. Any payment will be returned.');
    // review round 1 RC1 (D2): a cancelled charged row with no refund in flight
    expect(PAY_RECEIPT_CANCELLED_CONTACT_COPY).toBe(
      'This transfer was not completed. If you paid, reply in the WhatsApp chat and we will help you.',
    );
  });

  it('no line says review, check, compliance or held (no tipping off)', () => {
    for (const s of [
      PAY_SUCCESS_RECEIPT_COPY,
      PAY_RECEIPT_PRINT_HINT,
      PAY_RECEIPT_NOT_COMPLETED_COPY,
      PAY_RECEIPT_REFUNDED_COPY,
      PAY_RECEIPT_CANCELLED_CHARGED_COPY,
      PAY_RECEIPT_CANCELLED_CONTACT_COPY,
      PAY_HELD_LABEL,
    ]) {
      for (const w of ['review', 'check', 'compliance', 'held']) expect(s.toLowerCase(), s).not.toContain(w);
    }
  });
});

describe('the pay forms keep their other done copy (pack 6 T11)', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/pay/[transferId]/pay-form.tsx'), 'utf8');
  const link = readFileSync(join(process.cwd(), 'src/app/pay/l/[token]/link-pay-form.tsx'), 'utf8');

  it("the ACH form's 'Payment authorized!' line is unchanged", () => {
    expect(src).toContain('Payment authorized!');
  });

  it('the link form no longer says "It is being checked."', () => {
    expect(link).not.toContain('It is being checked.');
    expect(link).toContain("paid.status === 'in_review' ? PAY_HELD_LABEL : 'Payment complete'");
  });

  it('both b2c forms read the held answer beside payOkStatus', () => {
    expect(src.split('setHeld(payOkHeld(body))').length - 1).toBe(2);
    expect(src.split('payDoneCopy(held, receiptOnReload)').length - 1).toBe(2);
  });
});
