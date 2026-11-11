// Fix pack 4 (C15): the 'Approving ...' line shown beside every pay-step code
// box, so the customer sees what the code approves. Import-free (client-safe).

/** 'Approving 105.00 USD to Priya, account ending 1234.'; no last4 -> 'Approving 105.00 USD to Priya.' */
export function approvingLine(i: {
  amountText: string;
  currency: string;
  recipientName: string;
  accountLast4: string | null;
  wholeName?: boolean;
}): string {
  const flat = i.recipientName.replace(/\s+/g, ' ').trim();
  const name = i.wholeName ? flat : (flat.split(' ')[0] ?? '');
  const last4 = i.accountLast4 && /^[0-9]{4}$/.test(i.accountLast4) ? i.accountLast4 : null;
  return `Approving ${i.amountText} ${i.currency}` + (name ? ` to ${name}` : '') + (last4 ? `, account ending ${last4}` : '') + '.';
}

/** The page's Total charge number as the line's amount: en-US, 2 decimals ('1,050.00'); non-finite -> ''. */
export function approvingAmountText(amount: number): string {
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : '';
}
