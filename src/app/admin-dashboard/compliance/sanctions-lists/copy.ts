// Fix pack 5 T31 (R08, P28, P31): the copy of a refused MHA row code. Client-safe (the
// upload form renders the row list): it imports only the catalogue and a type.
import { t } from '@/lib/i18n';
import type { MhaRowErrorCode } from '@/lib/sanctions/in-mha-list';

/** The parser's row codes, plus the upload action's file-level 'bad_encoding' (pack 5 review LD1). */
type MhaCopyCode = MhaRowErrorCode | 'bad_encoding';

const CODES: readonly MhaCopyCode[] = [
  'bad_header', 'bad_columns', 'empty_name', 'name_too_short', 'name_too_long', 'too_many_aliases',
  'bad_type', 'bad_id', 'duplicate_id', 'bad_text', 'too_many_rows', 'no_rows', 'bad_encoding',
];

/** The fixed copy of a row code; an unknown code (another build) shows the code itself. */
export function mhaCodeCopy(code: string): string {
  return (CODES as readonly string[]).includes(code)
    ? t(`admin.compliance.sanctionsLists.code.${code as MhaCopyCode}`)
    : code;
}
