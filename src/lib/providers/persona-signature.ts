import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Persona webhook signature (Phase 2, Task 4).
 *
 * Header `Persona-Signature` is `t=<unix-seconds>,v1=<hex>[,v1=<hex>...]`. The
 * HMAC-SHA256 is computed over the literal string `` `${t}.${rawBody}` `` (raw
 * bytes, not re-serialized JSON) keyed by each `wbhsec_` secret; ANY matching
 * `v1` passes (dual-secret rotation). Reject if the timestamp is outside a
 * ±5-minute window (replay guard). Constant-time hex compare.
 *
 * Program-Fix 35 — secret rotation: while a secret rotates Persona sends TWO
 * space-separated sets, `t=<t1>,v1=<a> t=<t2>,v1=<b>`
 * (https://docs.withpersona.com/webhooks-best-practices). The header is split
 * ONLY at whitespace immediately before `t=` (and not right after a comma, so
 * `v1=…, t=…` stays one set); each set keeps the comma parse
 * (whitespace around parts and several `v1=` per set tolerated) and is checked
 * against ITS OWN `t` and its own ±5-minute window. A malformed set is skipped;
 * the header verifies only if some set verifies.
 *
 * Fail-CLOSED: an empty header or no usable secret returns false.
 *
 * The header name (`Persona-Signature`, read case-insensitively by the route)
 * and the live secret are proven by the owner's dashboard test event (fix 35
 * owner checklist, step 2: a signed test event must return 200).
 */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function safeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export function verifyPersonaSignature(
  rawBody: string,
  header: string,
  secrets: string[],
  nowMs: number,
): boolean {
  const usableSecrets = (secrets ?? []).filter((s) => s && s.length > 0);
  if (!header || usableSecrets.length === 0) return false; // fail-closed

  // Split at whitespace before `t=` that does NOT follow a comma: a space after
  // a comma is inside one set (`v1=…, t=…`), a bare space separates two sets.
  const sets = header.trim().split(/(?<!,)\s+(?=t=)/);
  for (const set of sets) {
    if (verifySet(rawBody, set, usableSecrets, nowMs)) return true;
  }
  return false;
}

/** One `t=…,v1=…[,v1=…]` set. Malformed or stale ⇒ false (the caller tries the next set). */
function verifySet(rawBody: string, set: string, secrets: string[], nowMs: number): boolean {
  const parts = set.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3).trim());
  if (!tPart || v1s.length === 0) return false;

  const t = Number(tPart.slice(2).trim());
  if (!Number.isFinite(t)) return false;
  if (Math.abs(nowMs - t * 1000) > REPLAY_WINDOW_MS) return false; // replay guard, per set

  const signed = `${t}.${rawBody}`;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    for (const v1 of v1s) if (safeEqualHex(expected, v1)) return true;
  }
  return false;
}
