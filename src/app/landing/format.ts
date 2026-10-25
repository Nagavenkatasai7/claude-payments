// Shared landing formatters. Importable by server components and client
// islands alike (no 'use client').

/** Whole-rupee display with en-IN (lakh/crore) grouping — e.g. ₹16,950. */
export function inr(n: number): string {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/** The calculator's "they get" figure: rupees as above, any other currency with its symbol and 2 decimals. */
export function destAmount(n: number, currency: string): string {
  if (currency === 'INR') return inr(n);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
