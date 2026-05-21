export function normalizePhone(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

export function isValidPhone(normalized: string): boolean {
  return /^\d+$/.test(normalized) && normalized.length >= 10 && normalized.length <= 15;
}
