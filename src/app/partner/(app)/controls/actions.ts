'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { pokeWorker } from '@/lib/outbox';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { FLAG_DEFINITIONS, type FlagKey } from '@/lib/flags';
import { applyPartnerFlagChange, PARTNER_FLAG_KEYS, type PartnerFlagChangeCode } from '@/lib/flag-switch';
import { parseDestinationCountry } from '@/lib/destination-country';
import { requireStaffReason } from '@/lib/send-limits';
import { LIVE_CAPABILITIES, type LiveCapability } from '@/lib/live-controls';
import { writeOptIn, type LiveWriteResult } from '@/lib/live-controls-write';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { CountryCode } from '@/lib/types';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';

// /partner/controls actions (fix pack 3 T11, R26 R13; contract 12). Each one: the site-host guard,
// the admin gate, the actor's OWN staff MFA (before any step-up: factorFor would fall back to the
// password), the input parse, then the step-up only where the change makes things LESS safe:
//   - setPartnerSwitchAction: pausing needs no re-auth; resuming asks for 'switch.resume';
//   - approveCapabilityAction: approving asks for 'optin.approve'; withdrawing needs no re-auth
//     (partner-step-up-gate.ts: making things safer never needs a re-auth).
// The tenant is ALWAYS ctx.partnerId: no form field names a partner, a scope id or a scope type.
// The writers (applyPartnerFlagChange, writeOptIn) run the state change, its audit row, the ops
// alert and the partner email in ONE transaction; this file pokes the worker after they commit.

const POLICY = PARTNER_ROUTES.controls.policy;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (key: MessageKey): ActionResult => ({ ok: false, error: t(key) });

const SWITCH_REFUSAL: Record<PartnerFlagChangeCode, MessageKey> = {
  not_operable: 'partner.controls.invalid',
  bad_corridor: 'partner.controls.badCorridor',
  reason: 'partner.controls.reason',
};

/** A field read as a closed-set member, never as an object key (no prototype lookups). */
function oneOf<T extends string>(allowed: readonly T[], raw: FormDataEntryValue | null): T | undefined {
  return typeof raw === 'string' ? allowed.find((a) => a === raw) : undefined;
}

export async function setPartnerSwitchAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  if (!(await staffMfaEnrolled(ctx.username))) return refused('partner.controls.needMfa');

  const key: FlagKey | undefined = oneOf(PARTNER_FLAG_KEYS, formData.get('key'));
  const state = oneOf(['on', 'off'] as const, formData.get('enabled'));
  if (!key || !state) return refused('partner.controls.invalid');
  const rawCorridor = formData.get('corridor');
  let corridor: CountryCode | undefined;
  if (rawCorridor !== null) {
    const c = parseDestinationCountry(rawCorridor);
    if (c === null || (c !== undefined && !FLAG_DEFINITIONS[key].tenantCorridor)) return refused('partner.controls.badCorridor');
    corridor = c;
  }
  let reason: string;
  try {
    reason = requireStaffReason(formData.get('reason'));
  } catch {
    return refused('partner.controls.reason');
  }
  const enabled = state === 'on';

  if (!enabled) {
    const stepUp = await gatePartnerStepUp(ctx, formData, 'switch.resume');
    if (stepUp) return stepUp;
  }
  let r: Awaited<ReturnType<typeof applyPartnerFlagChange>>;
  try {
    r = await applyPartnerFlagChange({ username: ctx.username, partnerId: ctx.partnerId }, { key, corridor, enabled, reason });
  } catch (err) {
    logWarn('partner.controls.switch', errName(err), { partnerId: ctx.partnerId, key });
    return refused('partner.controls.failed');
  }
  if (!r.ok) return refused(SWITCH_REFUSAL[r.code]);
  pokeWorker(); // post-response (after()): the ops alert and the partner email
  revalidatePath('/partner', 'layout'); // the pause strip is in the layout
  return { ok: true };
}

const OPTIN_REFUSAL: Record<Exclude<LiveWriteResult, { ok: true }>['code'], MessageKey> = {
  not_certified: 'partner.controls.optin.notCertified',
  not_ready: 'partner.controls.optin.noCounsel',
  bad_input: 'partner.controls.invalid',
  not_found: 'partner.controls.failed',
  kyc_decider_mismatch: 'partner.controls.failed',
  psp_unavailable: 'partner.controls.failed', // fix pack 5 T17: writeFundingMode only (platform), never from here
  certified: 'partner.controls.failed', // fix pack 7 T15: writePosture only, never from here
};

export async function approveCapabilityAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  if (!(await staffMfaEnrolled(ctx.username))) return refused('partner.controls.needMfa');

  const cap: LiveCapability | undefined = oneOf(LIVE_CAPABILITIES, formData.get('capability'));
  const state = oneOf(['on', 'off'] as const, formData.get('on'));
  if (!cap || !state) return refused('partner.controls.invalid');
  const on = state === 'on';

  if (on) {
    const stepUp = await gatePartnerStepUp(ctx, formData, 'optin.approve');
    if (stepUp) return stepUp;
  }
  let r: LiveWriteResult;
  try {
    r = await getDb().transaction((tx) => writeOptIn(tx, ctx.partnerId, { username: ctx.username, scope: 'partner' }, cap, { kind: 'approval', on }));
  } catch (err) {
    logWarn('partner.controls.optin', errName(err), { partnerId: ctx.partnerId, capability: cap });
    return refused('partner.controls.failed');
  }
  if (!r.ok) return refused(OPTIN_REFUSAL[r.code]);
  pokeWorker(); // post-response (after()): the ops alert and the partner email
  revalidatePath(PARTNER_ROUTES.controls.href);
  return { ok: true };
}
