// Shared landing formatters. Importable by server components and client
// islands alike (no 'use client').

/** Whole-rupee display with en-IN (lakh/crore) grouping — e.g. ₹16,950. */
export function inr(n: number): string {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
