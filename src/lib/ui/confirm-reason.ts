// The typed-reason rule for destructive actions. The client uses it for UX only; the SERVER ACTION
// that receives the form MUST call it again on formData.get('reason') and refuse when it fails.
export const DEFAULT_REASON_MIN = 10;

export function isReasonValid(reason: unknown, min = DEFAULT_REASON_MIN): boolean {
  if (typeof reason !== 'string') return false;
  const s = reason.replace(/\s+/g, ' ').trim();
  return [...s].length >= min; // code points, so an emoji counts once
}
