import { describe, it, expect } from 'vitest';
import { approvingLine } from '@/lib/approving-line';

// Fix pack 4 (C15): the line beside every code box that says what the code approves.
describe('approvingLine', () => {
  it("with a last4: 'Approving 105.00 USD to Priya, account ending 1234.' (first whitespace token of 'Priya Sharma')", () => {
    expect(approvingLine({ amountText: '105.00', currency: 'USD', recipientName: 'Priya Sharma', accountLast4: '1234' }))
      .toBe('Approving 105.00 USD to Priya, account ending 1234.');
  });

  it("without a last4, or one that is not 4 digits: 'Approving 105.00 USD to Priya.'; an empty recipient name gives 'Approving 105.00 USD.'", () => {
    for (const accountLast4 of [null, '', '123', '12345', 'ab12']) {
      expect(approvingLine({ amountText: '105.00', currency: 'USD', recipientName: '  Priya   Sharma ', accountLast4 }), String(accountLast4))
        .toBe('Approving 105.00 USD to Priya.');
    }
    expect(approvingLine({ amountText: '105.00', currency: 'USD', recipientName: '   ', accountLast4: null })).toBe('Approving 105.00 USD.');
    expect(approvingLine({ amountText: '105.00', currency: 'USD', recipientName: '', accountLast4: '1234' }))
      .toBe('Approving 105.00 USD, account ending 1234.');
  });

  it("wholeName: true keeps 'Sri Lakshmi Traders' whole (whitespace runs flattened)", () => {
    expect(approvingLine({ amountText: '1,050.00', currency: 'USD', recipientName: ' Sri  Lakshmi\tTraders ', accountLast4: null, wholeName: true }))
      .toBe('Approving 1,050.00 USD to Sri Lakshmi Traders.');
  });
});
