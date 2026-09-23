import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { signBody } from './http-payment-provider';
import { verifyWebhookSignature } from './payment-webhook-verify';
import { logWarn } from '../log';

// rail-signature — the settlement-rail signature, both directions (Program-Fix 29).
//
//   x-smartremit-signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
//   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`) — one v1 per active secret
//   (current, plus the previous one during a rotation grace period).
//
// The legacy `x-signature` (HMAC over the raw body alone, current secret) is
// still SENT byte-identical and still ACCEPTED when the new header is absent,
// with a deprecation log naming the partner. When the new header is present
// it alone decides — there is no fall-through to the legacy header.
//
// verifyWebhookSignature (payment-webhook-verify.ts) is untouched: the Meta and
// funding webhooks share it.

export const RAIL_SIG_HEADER = 'x-smartremit-signature';
export const LEGACY_SIG_HEADER = 'x-signature';
/** Accepted clock skew either way, in seconds. */
export const RAIL_SIG_TOLERANCE_SEC = 300;

export type RailSigResult =
  | { ok: false }
  | { ok: true; scheme: 'v2'; nonce: string }
  | { ok: true; scheme: 'legacy' };

interface HeaderReader {
  get(name: string): string | null;
}

function v1For(secret: string, t: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}

/**
 * The outbound headers for a rail POST. `secrets[0]` is the current secret and
 * the only one the legacy header uses; the new header carries one v1 per
 * secret. No secrets ⇒ no headers (the unsigned behaviour is unchanged).
 */
export function signRailHeaders(
  rawBody: string,
  secrets: readonly string[],
  nowMs: number,
): Record<string, string> {
  const active = secrets.filter((s) => s !== '');
  if (active.length === 0) return {};
  const t = Math.floor(nowMs / 1000);
  const v1s = active.map((s) => `v1=${v1For(s, t, rawBody)}`).join(',');
  return {
    [LEGACY_SIG_HEADER]: signBody(rawBody, active[0]),
    [RAIL_SIG_HEADER]: `t=${t},${v1s}`,
  };
}

/** Parse `t=..,v1=..[,v1=..]`; null when malformed (no t, bad t, no v1). */
function parseHeader(value: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      if (t !== null || !/^\d{1,12}$/.test(v)) return null;
      t = Number(v);
    } else if (k === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(v)) return null;
      v1.push(v.toLowerCase());
    }
    // unknown keys (future schemes) are ignored
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

function hexEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verify a rail POST. Fail-closed: no secrets, no header, a malformed or stale
 * new header, or no matching v1 ⇒ `{ ok: false }`.
 *
 * `nonce` = sha256(`${t}.${rawBody}`): independent of which secret matched,
 * so the same timestamped message maps to one replay key during a rotation.
 */
export function verifyRailSignature(
  rawBody: string,
  headers: HeaderReader,
  secrets: readonly string[],
  nowMs: number,
  ctx: { partnerId?: string | null; route: string },
): RailSigResult {
  const active = secrets.filter((s) => s !== '');
  if (active.length === 0) return { ok: false };

  const v2 = headers.get(RAIL_SIG_HEADER);
  if (v2 !== null) {
    const parsed = parseHeader(v2);
    if (!parsed) return { ok: false };
    const nowSec = Math.floor(nowMs / 1000);
    if (Math.abs(nowSec - parsed.t) > RAIL_SIG_TOLERANCE_SEC) return { ok: false };
    const matched = active.some((s) => {
      const expected = v1For(s, parsed.t, rawBody);
      return parsed.v1.some((got) => hexEqual(expected, got));
    });
    if (!matched) return { ok: false };
    const nonce = createHash('sha256').update(`${parsed.t}.${rawBody}`).digest('hex');
    return { ok: true, scheme: 'v2', nonce };
  }

  const legacy = headers.get(LEGACY_SIG_HEADER) ?? '';
  if (legacy === '') return { ok: false };
  if (!active.some((s) => verifyWebhookSignature(rawBody, legacy, s))) return { ok: false };
  logWarn('rail-sig.legacy', 'legacy rail signature accepted; x-smartremit-signature is recommended', {
    partnerId: ctx.partnerId ?? null,
    route: ctx.route,
  });
  return { ok: true, scheme: 'legacy' };
}
