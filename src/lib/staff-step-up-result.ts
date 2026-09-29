// The partner-staff step-up result (M3-14 follow-up). Client-safe: no server imports, so the
// /partner client controls can recognise it and retry. It never carries a secret, a code or input.

/** The form field a retry carries the TOTP code (enrolled) or the current password (not enrolled) in. */
export const STEP_UP_FIELD = 'stepUpSecret';

export type StepUpFactor = 'totp' | 'password';

/**
 * A credential / money-config action refused because the session has not re-authenticated in the
 * last 15 minutes (or the code just submitted was wrong). `error` is fixed, translated copy, so a
 * client of the other build during a rolling release still shows something sensible.
 */
export type StepUpRequired = { ok: false; error: string; code: 'step_up_required'; factor: StepUpFactor };

export function isStepUpRequired(r: unknown): r is StepUpRequired {
  if (typeof r !== 'object' || r === null) return false;
  const v = r as Record<string, unknown>;
  return v.ok === false && v.code === 'step_up_required' && (v.factor === 'totp' || v.factor === 'password');
}

/** A copy of a submitted form WITHOUT the step-up secret: what a client keeps for the retry. */
export function withoutStepUpSecret(fd: FormData): FormData {
  const out = new FormData();
  fd.forEach((v, k) => {
    if (k !== STEP_UP_FIELD) out.append(k, v);
  });
  return out;
}

/** A copy of `base` carrying the step-up secret: the retry's body. `base` is not changed. */
export function withStepUpSecret(base: FormData, secret: string): FormData {
  const out = withoutStepUpSecret(base);
  out.set(STEP_UP_FIELD, secret);
  return out;
}
