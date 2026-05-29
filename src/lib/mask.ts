// Mask a high-sensitivity value (e.g. a government-ID number) to its last 4
// characters for read-only display. Defensive against undefined/short input.
// App-level field encryption of PII is OUT OF SCOPE for the prototype (the
// Upstash layer provides at-rest encryption); this masking is the minimum
// dashboard exposure control.
export function maskLast4(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v.length <= 4 ? v : v.slice(-4);
}
