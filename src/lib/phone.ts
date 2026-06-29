export function normalizePhone(raw: unknown): string {
  try {
    return String(raw ?? '').replace(/\D/g, '');
  } catch {
    return '';
  }
}

export function isValidPhone(normalized: string): boolean {
  return /^\d+$/.test(normalized) && normalized.length >= 10 && normalized.length <= 15;
}
