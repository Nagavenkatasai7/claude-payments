import { blindIndex } from '@/lib/blind-index';
import type { PayoutMethod } from '@/lib/types';

// aml-bidx — Program-Fix 43: the keyed fingerprints the AML sweep keeps in
// Redis. payout_destination_enc is AES-GCM with a random IV (schema.ts), so
// the sweep decrypts a destination ONCE, in memory, in the worker, and only
// the HMAC ever leaves these functions — no plaintext PII reaches Redis or a
// log. Purposes are separated: 'payout-dest' for destinations, 'aml-sender'
// for the sender's phone (the waitlist already uses 'phone').

/**
 * Canonical form, prefixed with the method so the same string under two
 * methods never collides. bank: uppercase, whitespace / '-' / '.' stripped
 * ('|' is the account|IFSC separator and is kept). upi: case-insensitive,
 * whitespace stripped (dots are significant in a VPA). usdc: lowercased.
 */
export function normalizeDestination(method: PayoutMethod, destination: string): string {
  const raw = String(destination ?? '');
  switch (method) {
    case 'bank':
      return `bank|${raw.toUpperCase().replace(/[\s.\-]/g, '')}`;
    case 'upi':
      return `upi|${raw.toLowerCase().replace(/\s/g, '')}`;
    case 'usdc':
      return `usdc|${raw.toLowerCase().replace(/\s/g, '')}`;
    default:
      return `${String(method)}|${raw.toUpperCase().replace(/\s/g, '')}`;
  }
}

export function destinationBidx(method: PayoutMethod, destination: string, key?: Buffer): string {
  return blindIndex('payout-dest', normalizeDestination(method, destination), key);
}

export function senderBidx(phone: string, key?: Buffer): string {
  return blindIndex('aml-sender', phone, key);
}
