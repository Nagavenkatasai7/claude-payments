import type { TxOtpBudgetKind } from './transaction-otp';
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

type MaybePrepared = Pick<Draft, 'preparedBy'> | null | undefined;

/**
 * Stage C2 security review: an app-prepared draft pays ONLY the saved recipient's stored account.
 * The pay page offers no "Edit bank details" for it and the pay route refuses bank details in the
 * body (pay-finalize.ts ignores them too), so an app that learns the code cannot pick the account.
 */
export function bankDetailsLocked(draft: MaybePrepared): boolean {
  return draft?.preparedBy !== undefined && draft?.preparedBy !== null;
}

/** The per-phone daily code budget a pay-page code draws from (transaction-otp.ts). */
export function payOtpBudgetKind(draft: MaybePrepared): Extract<TxOtpBudgetKind, 'pay' | 'agent'> {
  return bankDetailsLocked(draft) ? 'agent' : 'pay';
}

export const BANK_DETAILS_LOCKED_ERROR =
  'This transfer pays the saved account shown here. To pay a different account, start a new transfer in SmartRemit on WhatsApp or the portal.';
