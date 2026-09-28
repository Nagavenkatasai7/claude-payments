// partner-branding — pure helpers for the /partner Branding page (UI redesign M3-17). No I/O.
// The validation itself lives in the M1 writers (validateThemeColor, the logo store) and in
// partner-support-contact.ts; this module only maps their refusal reasons to copy and derives the
// upload cap from the stored-logo limit.
import { MAX_LOGO_LEN } from '@/lib/logo';
import type { MessageKey } from '@/lib/i18n';

// The logo is stored as `data:image/<type>;base64,<payload>` and the store refuses a value longer
// than MAX_LOGO_LEN CHARACTERS. Base64 turns every 3 bytes into 4 characters, so the largest FILE
// that can fit is ⌊(MAX_LOGO_LEN − the longest accepted header) / 4⌋ × 3 bytes. The action refuses
// anything larger before reading a single byte, so an oversized upload is never buffered.
const LONGEST_HEADER = 'data:image/jpeg;base64,'.length; // webp is the same length; png is shorter
export const MAX_LOGO_FILE_BYTES = Math.floor((MAX_LOGO_LEN - LONGEST_HEADER) / 4) * 3;
/** For copy only: the cap in whole KB, rounded down so the hint never overstates it. */
export const MAX_LOGO_FILE_KB = Math.floor(MAX_LOGO_FILE_BYTES / 1024);

/** The support contact's length ceiling (characters), shared by the writer and the form. */
export const SUPPORT_CONTACT_MAX = 120;

export type ThemeField = 'primaryColor' | 'accentColor';

export function themeErrorKey(reason: 'format' | 'contrast'): MessageKey {
  return reason === 'contrast' ? 'partner.branding.colorContrast' : 'partner.branding.colorFormat';
}

export function logoErrorKey(reason: 'type' | 'size' | 'content' | 'missing'): MessageKey {
  switch (reason) {
    case 'missing':
      return 'partner.branding.logoMissing';
    case 'size':
      return 'partner.branding.logoTooBig';
    case 'type':
      return 'partner.branding.logoType';
    case 'content':
      return 'partner.branding.logoContent';
  }
}
