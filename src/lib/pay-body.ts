// Fix pack 4 (C13): one parser for the pay request bodies of the transfer
// (api/pay/[transferId]), link (api/pay/l/[token]) and B2B (api/pay/b2b/
// [invoiceId]) routes. A field outside its surface is null and not present.
// The new fields (disclosureHash, accountHolder) are optional for one release,
// so the `present` flags tell "not posted" from "posted but invalid".
// Pure; never throws.
import { isCleanName, NAME_MAX } from './untrusted-text';

export type PaySurface = 'transfer' | 'link' | 'b2b';

export interface ParsedPayBody {
  action: 'request_otp' | null;
  /** Digits only, '' when absent. */
  otp: string;
  disclosureVersion: string | null;
  /** /^dh1:[0-9a-f]{64}$/ else null. */
  disclosureHash: string | null;
  /** Trimmed string when posted ('' kept); transfer only. */
  accountHolder: string | null;
  country: string | null;
  fields: Record<string, string> | null;
  ach: unknown;
  fundingMethod: unknown;
  quoteLockedAt: unknown;
  present: { disclosureVersion: boolean; disclosureHash: boolean; accountHolder: boolean };
}

const DISCLOSURE_HASH = /^dh1:[0-9a-f]{64}$/;

function emptyBody(): ParsedPayBody {
  return {
    action: null, otp: '', disclosureVersion: null, disclosureHash: null, accountHolder: null,
    country: null, fields: null, ach: null, fundingMethod: null, quoteLockedAt: null,
    present: { disclosureVersion: false, disclosureHash: false, accountHolder: false },
  };
}

function stringFields(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export function parsePayBody(raw: unknown, surface: PaySurface): ParsedPayBody {
  try {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!o) return emptyBody();
    const has = (k: string) => Object.prototype.hasOwnProperty.call(o, k);
    const transfer = surface === 'transfer';
    const link = surface === 'link';
    const b2b = surface === 'b2b';
    const disclosure = transfer || link;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const hash = o.disclosureHash;
    return {
      action: o.action === 'request_otp' ? 'request_otp' : null,
      otp: String(o.otp ?? '').replace(/\D/g, ''),
      disclosureVersion: disclosure ? str(o.disclosureVersion) : null,
      disclosureHash: disclosure && typeof hash === 'string' && DISCLOSURE_HASH.test(hash) ? hash : null,
      accountHolder: transfer && typeof o.accountHolder === 'string' ? o.accountHolder.trim() : null,
      country: transfer || b2b ? str(o.country) : null,
      fields: transfer || b2b ? stringFields(o.fields) : null,
      ach: transfer ? (o.ach ?? null) : null,
      fundingMethod: link ? (o.fundingMethod ?? null) : null,
      quoteLockedAt: link ? (o.quoteLockedAt ?? null) : null,
      present: {
        disclosureVersion: disclosure && has('disclosureVersion'),
        disclosureHash: disclosure && has('disclosureHash'),
        accountHolder: transfer && has('accountHolder'),
      },
    };
  } catch {
    return emptyBody();
  }
}

/** The account holder's name as typed: trimmed, a clean name of at most NAME_MAX (80) characters. */
export function validateAccountHolder(v: string): { ok: true; name: string } | { ok: false } {
  const name = v.trim();
  return isCleanName(name, NAME_MAX) ? { ok: true, name } : { ok: false };
}
