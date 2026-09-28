// In-house message lookup. No dependency: a flat key → template map per locale, with {name} slots.
// The output is plain text; React escapes it at render, so vars are never HTML-interpreted.
import { CATALOGUES, type Locale, type MessageKey } from './catalogues';
import { logWarn } from '@/lib/log';

export type { Locale, MessageKey };
export { CATALOGUES };

export class MissingMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingMessageError';
  }
}

// Outside production a missing key or var throws, so gaps fail tests and dev loudly.
// In production the page must never crash on a copy gap: fall back and log.
const strict = () => process.env.NODE_ENV !== 'production';

export function t(key: MessageKey, vars?: Record<string, string | number>, locale: Locale = 'en'): string {
  const catalogue: Record<string, string> | undefined = CATALOGUES[locale];
  const template: string | undefined = catalogue?.[key] ?? (CATALOGUES.en as Record<string, string>)[key];
  if (template === undefined) {
    if (strict()) throw new MissingMessageError(`i18n: missing key ${String(key)}`);
    logWarn('i18n', 'missing key', { key: String(key), locale });
    return String(key);
  }
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars?.[name];
    if (v === undefined) {
      if (strict()) throw new MissingMessageError(`i18n: missing var {${name}} for ${String(key)}`);
      logWarn('i18n', 'missing var', { key: String(key), name, locale });
      return '';
    }
    return String(v);
  });
}
