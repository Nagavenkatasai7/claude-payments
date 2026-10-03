'use server';

import { redirect } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { changeOwnPassword, type PasswordChangeCode } from '@/lib/staff-password-change';
import { t, type MessageKey } from '@/lib/i18n';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// Lost-features A14: change your own password on /partner/security (every partner role, finance
// too). The gate does NOT skip MFA: a member still waiting to enrol is sent to enrolment first, and
// the page hides the card until then. The core (staff-password-change.ts, shared with the legacy
// account page) acts on the SESSION's staff record only: no username is read from the form. It uses
// the sign-in throttle, signs out every session, mints a fresh one for this browser and audits
// auth.password.change.

const ERRORS: Record<Exclude<PasswordChangeCode, 'policy' | 'gone'>, MessageKey> = {
  missing: 'partner.security.password.error.missing',
  mismatch: 'partner.security.password.error.mismatch',
  throttled: 'partner.security.password.error.throttled',
  wrong_current: 'partner.security.password.error.wrongCurrent',
  same: 'partner.security.password.error.same',
  concurrent: 'partner.security.password.error.concurrent',
};

export async function changePasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.security.policy);
  const r = await changeOwnPassword(ctx.staff, {
    current: String(formData.get('currentPassword') ?? ''),
    next: String(formData.get('newPassword') ?? ''),
    confirm: String(formData.get('confirmPassword') ?? ''),
  });
  if (r.ok) return { ok: true };
  if (r.code === 'gone') redirect('/login');
  // The policy message is fixed copy from staff-password.ts (length or breach), never input.
  if (r.code === 'policy') return { ok: false, error: r.policyMessage ?? t('partner.security.password.error.policy') };
  return { ok: false, error: t(ERRORS[r.code]) };
}
