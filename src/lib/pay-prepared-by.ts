import type { Draft } from './types';
import { boundUntrustedText, NAME_MAX } from './untrusted-text';

/**
 * Stage C2: the pay page's line for a draft an AI app prepared (MCP prepare_transfer), or null.
 * The name is the app's OWN, unverified name, so it is quoted, clamped and rendered as text
 * (React escapes it); the line never claims the name is checked. Pure.
 */
export function preparedByLine(preparedBy: Draft['preparedBy']): string | null {
  if (!preparedBy) return null;
  const name = boundUntrustedText(preparedBy.appName, NAME_MAX);
  const where = name ? `“${name}”, an AI app you connected` : 'an AI app you connected';
  return `Prepared in ${where}. Check every detail before you pay.`;
}
