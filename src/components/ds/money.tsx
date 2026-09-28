import { formatMoney } from '@/lib/ui/money';

/** An amount in tabular figures, so columns of money line up. */
export function Money({ amount, currency }: { amount: number; currency?: string }) {
  return <span className="tabular-nums">{formatMoney(amount, currency)}</span>;
}
