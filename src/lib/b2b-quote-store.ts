import { getRedis } from './redis';
import type { CrossBorderBillQuote } from './b2b-quote';
import type { RedisLike } from './store';

// ── Cross-border B2B quote-lock (Plan 3) — short-TTL Redis lock ──────────────
//
// FX is quoted LIVE at payment, but the buyer's checkout must use a STABLE quote
// (so the figure they see is the figure they pay). This thin Redis lock stores
// the quote for a short TTL keyed by invoice id; on expiry getLockedQuote returns
// null and the caller re-quotes against live FX. Non-custodial: this holds a
// PRICE, never funds. Thin-wrapper + getRedis() + JSON convention (the shared
// client runs automaticDeserialization:false, so we JSON.stringify/parse).

const QUOTE_LOCK_TTL_S = 900; // 15 minutes
const QUOTE_LOCK_TTL_MS = QUOTE_LOCK_TTL_S * 1000;

export interface LockedB2bQuote extends CrossBorderBillQuote {
  lockedAt: string; // ISO-8601 — when the quote was locked
}

export interface B2bQuoteStoreOptions {
  now?: () => number;
}

function lockKey(invoiceId: string): string {
  return `b2b_quote_lock:${invoiceId}`;
}

export function createB2bQuoteStore(redis: RedisLike, opts: B2bQuoteStoreOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  return {
    /** Lock a freshly-computed quote for the invoice (stamps lockedAt, ~15-min TTL). */
    async lockQuote(invoiceId: string, quote: CrossBorderBillQuote): Promise<LockedB2bQuote> {
      const locked: LockedB2bQuote = { ...quote, lockedAt: new Date(now()).toISOString() };
      await redis.set(lockKey(invoiceId), JSON.stringify(locked), { ex: QUOTE_LOCK_TTL_S });
      return locked;
    },
    /** The live locked quote, or null when none/expired/corrupt → the caller re-quotes. */
    async getLockedQuote(invoiceId: string): Promise<LockedB2bQuote | null> {
      const key = lockKey(invoiceId);
      const raw = await redis.get(key);
      if (!raw) return null;
      let parsed: LockedB2bQuote;
      try {
        const obj = JSON.parse(raw) as unknown;
        // JSON.parse('null') / a bare primitive parses WITHOUT throwing — reading
        // .lockedAt off it would TypeError outside this try. Treat any non-object
        // as corrupt so the contract ("corrupt/missing ⇒ null, never throws") holds.
        if (typeof obj !== 'object' || obj === null) {
          await redis.del(key);
          return null;
        }
        parsed = obj as LockedB2bQuote;
      } catch {
        await redis.del(key);
        return null;
      }
      // Belt-and-suspenders expiry: the fake Redis used in tests ignores TTL, and
      // a real key could outlive its `ex` on clock skew — treat anything older
      // than the TTL (or with an unparseable lockedAt) as expired so a stale
      // quote can never be served against drifted FX.
      const age = now() - Date.parse(parsed.lockedAt);
      if (!Number.isFinite(age) || age >= QUOTE_LOCK_TTL_MS) {
        await redis.del(key);
        return null;
      }
      return parsed;
    },
  };
}

export type B2bQuoteStore = ReturnType<typeof createB2bQuoteStore>;

/**
 * The checkout quote for a cross-border bill: the LIVE-locked figure the buyer
 * sees AND pays. Returns the existing locked quote when one is present (so a page
 * reload / the pay submit reuse the exact figure shown), otherwise computes a
 * fresh quote against live FX and locks it (~15-min TTL). On lock expiry
 * getLockedQuote returns null → we re-quote, so the seller can never be paid off
 * drifted FX while the buyer is always charged what they were shown.
 *
 * `isValid` lets the caller reject a stale lock whose currencies/amount no longer
 * match this invoice (e.g. the obligation changed) and force a re-quote.
 */
export async function resolveCheckoutBillQuote(
  store: B2bQuoteStore,
  invoiceId: string,
  compute: () => Promise<CrossBorderBillQuote> | CrossBorderBillQuote,
  isValid?: (q: LockedB2bQuote) => boolean,
): Promise<LockedB2bQuote> {
  const existing = await store.getLockedQuote(invoiceId);
  if (existing && (!isValid || isValid(existing))) return existing;
  const fresh = await compute();
  return store.lockQuote(invoiceId, fresh);
}

let cached: B2bQuoteStore | null = null;

export function getB2bQuoteStore(): B2bQuoteStore {
  if (!cached) {
    cached = createB2bQuoteStore(getRedis());
  }
  return cached;
}
