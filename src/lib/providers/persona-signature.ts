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
 * Fail-CLOSED: an empty header or no usable secret returns false.
 *
 * NOTE: the exact header NAME/casing is confirmed at go-live when the webhook is
 * enabled (Task-0 left this open — the webhook was Disabled). The format here is
 * the documented Persona scheme; only the route's header lookup may need a tweak.
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

  const parts = header.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3).trim());
  if (!tPart || v1s.length === 0) return false;

  const t = Number(tPart.slice(2).trim());
  if (!Number.isFinite(t)) return false;
  if (Math.abs(nowMs - t * 1000) > REPLAY_WINDOW_MS) return false; // replay guard

  const signed = `${t}.${rawBody}`;
  for (const secret of usableSecrets) {
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    for (const v1 of v1s) if (safeEqualHex(expected, v1)) return true;
  }
  return false;
}
