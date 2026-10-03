import { cookies, headers } from 'next/headers';
import { getAuthStore } from './auth-store';
import { getRedis } from './redis';
import { staffSessionTokens } from './session-cookie';
import { getStaffMfaStore } from './staff-mfa-store';
import { getStaffAuthAudit } from './staff-auth-audit';
import { verifyPassword } from './password';
import { clientIpFrom } from './ip-rate-limit';
import { scopeOf } from './staff-scope';
import { logWarn } from './log';
import { t } from './i18n';
import { createStaffStepUp, type StaffStepUp, type StepUpTarget } from './staff-step-up';
import { STEP_UP_FIELD, type StepUpFactor, type StepUpRequired } from './staff-step-up-result';
import type { PartnerCtx } from './partner-access';
import type { Staff } from './types';

/**
 * The /partner credential and money-config actions' 15-minute step-up (M3-14 follow-up). Called
 * AFTER the site-host guard, requirePartnerStaff and the input parse, and BEFORE any write,
 * including a rate-limiter increment. Returns null to proceed; otherwise the result the action
 * returns as-is:
 *   - a fresh session (a step-up in the last 15 minutes, on THIS session) → null;
 *   - stale, no secret submitted → step_up_required (no write, no audit);
 *   - stale, a secret submitted → verified (throttled, audited); ok → null, else step_up_required;
 *   - any Redis / lookup error → a plain refusal (fail closed).
 * Revoke and the test event are never gated: making things safer never needs a re-auth.
 */

export type StepUpGateResult = StepUpRequired | { ok: false; error: string } | null;

function stepUp(): StaffStepUp {
  return createStaffStepUp({
    redis: getRedis(),
    mfa: getStaffMfaStore(),
    verifyPassword,
    getStaff: (u) => getAuthStore().getStaff(u),
    audit: getStaffAuthAudit(),
  });
}

/** The session token that authenticated THIS user (the current cookie first, then the legacy one). */
async function sessionTokenFor(username: string): Promise<string | null> {
  for (const { token } of staffSessionTokens(await cookies())) {
    if ((await getAuthStore().getSessionUser(token)) === username) return token;
  }
  return null;
}

const required = (factor: StepUpFactor, error: string): StepUpRequired => ({ ok: false, error, code: 'step_up_required', factor });
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** `always`: ask for the code even on a fresh session (the approval of a two-step recovery). */
export interface StepUpGateOptions {
  always?: boolean;
}

export async function gatePartnerStepUp(
  ctx: PartnerCtx,
  formData: FormData,
  target: StepUpTarget,
  opts: StepUpGateOptions = {},
): Promise<StepUpGateResult> {
  return gateStaffStepUp(ctx.staff, formData, target, opts);
}

/**
 * The same gate for any signed-in staff member, partner-scoped or platform (lost-features p4 B4:
 * the platform approval of a two-step recovery). Same contract as gatePartnerStepUp; the audit
 * row's actorScope is derived from the staff record, never from input.
 */
export async function gateStaffStepUp(
  staff: Staff,
  formData: FormData,
  target: StepUpTarget,
  opts: StepUpGateOptions = {},
): Promise<StepUpGateResult> {
  try {
    const s = stepUp();
    const token = await sessionTokenFor(staff.username);
    if (!token) return { ok: false, error: t('partner.stepUp.unavailable') };
    if (!opts.always && (await s.isFresh(token, staff.username))) return null;
    const raw = formData.get(STEP_UP_FIELD);
    const secret = typeof raw === 'string' ? raw : '';
    if (!secret.trim()) {
      const factor = await s.factorFor(staff.username);
      return required(factor, t(factor === 'totp' ? 'partner.stepUp.required.totp' : 'partner.stepUp.required.password'));
    }
    const ip = clientIpFrom(await headers());
    const r = await s.verify({ token, staff, secret, ip, target, actorScope: scopeOf(staff).kind });
    if (r.outcome === 'ok') return null;
    if (r.outcome === 'throttled') return required(r.factor, t('partner.stepUp.throttled'));
    return required(r.factor, t(r.factor === 'totp' ? 'partner.stepUp.invalid.totp' : 'partner.stepUp.invalid.password'));
  } catch (err) {
    // The error NAME only: never the message (it could echo input) and never the secret.
    logWarn('partner.stepup', errName(err), { partnerId: staff.partnerId ?? 'platform', target });
    return { ok: false, error: t('partner.stepUp.unavailable') };
  }
}
