import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TransferRows } from '@/app/portal/transfers/transfer-rows';
import { formatMoney } from '@/lib/ui/money';
import type { PortalTransferRow } from '@/lib/portal-transfers';

// Lost-features p4 B3: every portal transfer row (the list and Home) shows what the recipient gets,
// in the destination currency, in both the table (sm+) and the card list (below sm). The arrow is
// decorative; screen readers hear "Recipient gets".

const row = (over: Partial<PortalTransferRow> = {}): PortalTransferRow => ({
  id: 'AbCdEf1234567890abcdef',
  createdAt: '2026-01-02T03:04:05.000Z',
  recipientName: 'Asha',
  maskedDestination: '****2222',
  payoutMethod: 'bank',
  amount: 100,
  currency: 'USD',
  amountDest: 8512.5,
  destCurrency: 'INR',
  status: 'delivered',
  refundStatus: 'none',
  ...over,
});

const html = (rows: PortalTransferRow[]) => renderToStaticMarkup(TransferRows({ rows, caption: 'Transfers' }));
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('TransferRows: amount received', () => {
  it('shows the destination amount in the table and in the card list', () => {
    const out = html([row()]);
    const inr = formatMoney(8512.5, 'INR');
    expect(count(out, inr)).toBe(2);
    expect(count(out, 'Recipient gets')).toBe(2);
    expect(out).toContain('aria-hidden="true"');
  });
  it('formats in the row\'s own destination currency', () => {
    const out = html([row({ amountDest: 5600, destCurrency: 'PHP' })]);
    expect(count(out, formatMoney(5600, 'PHP'))).toBe(2);
    expect(out).not.toContain(formatMoney(5600, 'INR'));
  });
});
