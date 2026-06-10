// log — the PII-scrubbing structured logger for money paths (Stage 3).
//
// Policy: error/warn lines from payment, webhook, and messaging code MUST NOT
// carry full phone numbers, account numbers, or emails — an upstream log drain
// (Vercel logs, a future aggregator) is outside our encryption boundary.
// Codes/OTPs/tokens are never logged AT ALL (existing policy); this scrubber is
// the backstop for values that ride inside error messages we don't control
// (e.g. a provider echoing the request back in its error body).

/**
 * Mask emails and any 7+ digit run (phones, accounts, IBAN/PAN bodies) to
 * last-4. The threshold is 7 — not 6 — so 6-digit provider ERROR CODES (e.g.
 * Meta's 131056) stay readable for ops. OTPs are also 6 digits, but codes are
 * never logged at all by policy; this scrubber is the backstop for PII riding
 * inside messages we don't control.
 */
export function scrub(value: unknown): string {
  const s =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? `${value.name}: ${value.message}`
        : JSON.stringify(value) ?? String(value);
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\d{7,}/g, (m) => `…${m.slice(-4)}`);
}

function emit(level: 'error' | 'warn', scope: string, message: unknown, fields?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    level,
    scope,
    msg: scrub(message),
    at: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(fields ?? {})) line[k] = scrub(v);
  // One JSON line per event — greppable in Vercel logs, parseable by a drain.
  (level === 'error' ? console.error : console.warn)(JSON.stringify(line));
}

export function logError(scope: string, message: unknown, fields?: Record<string, unknown>): void {
  emit('error', scope, message, fields);
}

export function logWarn(scope: string, message: unknown, fields?: Record<string, unknown>): void {
  emit('warn', scope, message, fields);
}
