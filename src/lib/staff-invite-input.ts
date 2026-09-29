import type { StaffRole } from './types';

// staff-invite-input — UI redesign M3-8. The invite form's input rules, pure. Each parser returns
// the normalised value or null; callers map null to one fixed message and never echo the input.

/** The roles a partner admin may invite. Never a platform role: the tenant is always the session's. */
export const INVITE_ROLES: readonly StaffRole[] = Object.freeze(['admin', 'agent', 'support', 'finance'] as const);

const MAX_EMAIL = 254;
const MAX_NAME = 80;
// ONE plain address: an atom local part (no quotes, no spaces, no ',', ';', '<', '>') and a dotted
// host of LDH labels. Nothing a mailer would split into several recipients or read as a header.
const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseInviteEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_EMAIL || CONTROL.test(s)) return null;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return null;
  const local = s.slice(0, at);
  const labels = s.slice(at + 1).split('.');
  if (!LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return s;
}

export function parseInviteName(v: unknown): string | null {
  if (typeof v !== 'string' || CONTROL.test(v)) return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= MAX_NAME ? s : null;
}

export function parseInviteRole(v: unknown): StaffRole | null {
  return typeof v === 'string' && (INVITE_ROLES as readonly string[]).includes(v) ? (v as StaffRole) : null;
}
