'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin, requireScope } from '@/lib/auth';
import { createPartnerStore } from '@/lib/partner-store';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { CountryCode } from '@/lib/types';
import { boundStaffNote } from '@/lib/send-limits';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getDb } from '@/db/client';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { isAmlDisposition, parseAmlAlertId } from '@/lib/partner-reviews';
import { resolveAmlHoldRules, resolveCorridorRules } from '@/lib/compliance-config';
import { RISK_SIGNALS, isRiskSignal, type RiskSignal, type RiskSignalConfig } from '@/lib/risk-signals';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { gateStaffStepUp } from '@/lib/partner-step-up-gate';
import { logWarn } from '@/lib/log';
import type { StepUpRequired } from '@/lib/staff-step-up-result';

/**
 * Program-Fix 43 (compliance-09, partial): close an AML review item.
 *
 * Server actions are PUBLIC POST endpoints, so this self-gates in order:
 *   1. requireScope — a signed-in, non-support staff member (support is
 *      bounced to tickets); partner staff are pinned to their tenant;
 *   2. the alert id is parsed strictly (a positive safe integer) and the
 *      disposition is allow-listed;
 *   3. the alert is loaded with audit.getById PINNED to the staff member's
 *      tenant, and must be an `aml.alert` row. A missing id, another tenant's
 *      alert and a non-alert audit row are the SAME 'Alert not found'
 *      (404-never-403, and no review can be attached to arbitrary rows);
 *   4. one `aml.reviewed` row under the ALERT's tenant, subject = the alert's
 *      transfer, meta {alertId, disposition, note}. A second review of an
 *      already-reviewed alert writes nothing. Two staff reviewing at the same
 *      instant can both write — benign: the alert is closed either way and
 *      both decisions are audited.
 *
 * Nothing here touches the transfer: an AML alert is a review item, never a
 * hold (owner decision), and it never reaches the customer or the partner API.
 */

// The id parser and the disposition list are shared with the /partner port (lib/partner-reviews.ts).

export async function reviewAmlAlertAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const { staff, scope } = await requireScope();
  const alertId = parseAmlAlertId(formData.get('alertId'));
  if (alertId === null) throw new Error('Alert not found');
  const disposition = String(formData.get('disposition') ?? '');
  if (!isAmlDisposition(disposition)) throw new Error('Invalid disposition');
  const note = boundStaffNote(formData.get('note'));

  const db = getDb();
  const audit = createAuditRepo(db);
  const alert = await audit.getById(scope.kind === 'partner' ? scope.partnerId : null, alertId);
  if (!alert || alert.action !== 'aml.alert' || !alert.subjectId) throw new Error('Alert not found');

  const history = await audit.listBySubject(
    alert.partnerId,
    alert.subjectId,
    new Date(alert.at),
    new Date(Date.now() + 60_000),
  );
  const alreadyReviewed = history.some(
    (r) => r.action === 'aml.reviewed' && Number(r.meta.alertId) === alertId,
  );
  if (!alreadyReviewed) {
    await audit.record({
      partnerId: alert.partnerId ?? undefined,
      actor: staff.username,
      actorType: 'staff',
      action: 'aml.reviewed',
      subjectId: alert.subjectId,
      meta: { alertId, disposition, note },
    });
  }
  revalidatePath('/admin-dashboard/compliance');
}

/**
 * Program-Fix 43 PR B: the per-partner × corridor AML HOLD switch
 * (partners.corridor_compliance[<country>].amlHolds). OFF by default; when ON,
 * a real-money transfer (live, on a real `http` rail) of that partner and
 * corridor that hits one of the corridor's rules in the mint (amlHoldRules:
 * structuring, first transfer, new beneficiary) is held for review instead
 * of settling; a check that cannot run holds too (fail closed,
 * transfer-create.ts, fix pack 6 P16).
 *
 * Server actions are PUBLIC POST endpoints, so this self-gates in order:
 *   1. requirePlatformAdmin — platform admins only (never partner staff: a
 *      partner cannot switch its own compliance holds off);
 *   2. `on` is exactly 'on' | 'off'; the partner id is bounded;
 *   3. the default (demo) tenant is REFUSED — demo transfers are never held
 *      (mintLocked's amlHoldGate ignores it structurally too);
 *   4. the partner must exist ('Partner not found') and the corridor must be
 *      one it serves as a SOURCE (never IN);
 *   5. the column-targeted, row-locked write (updateCorridorCompliance) and
 *      the `aml.holds_set` audit row commit in ONE transaction. OFF removes
 *      the key (and an emptied corridor entry), so the stored jsonb returns to
 *      what it was before the switch was first turned on.
 *
 * Fix pack 6 (P13, critics C4/M1/P6) and the partner's rule list
 * (amlHoldRules, written by the partner's setAmlHoldRulesAction):
 *   • ON also DELETES a stored list that resolves to [] (empty or all
 *     garbage: a partner's earlier "all off"), so the switch can never be On
 *     with nothing held (the corridor then holds on all three rules); a valid
 *     non-empty list is kept. The meta gains `rulesReset: true` only then.
 *   • OFF deletes BOTH amlHolds and amlHoldRules, so the corridor is "no
 *     entry" again (hasAmlHoldEntry false) and the go-live default applies.
 */
export async function setAmlHoldsAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const onRaw = String(formData.get('on') ?? '');
  if (onRaw !== 'on' && onRaw !== 'off') throw new Error('Invalid setting');
  const on = onRaw === 'on';
  const partnerId = String(formData.get('partnerId') ?? '').trim();
  if (!partnerId || partnerId.length > 100) throw new Error('Partner not found');
  if (partnerId === DEFAULT_PARTNER_ID) throw new Error('The default (demo) tenant is never held');
  const countryRaw = String(formData.get('country') ?? '');
  if (!/^[A-Z]{2}$/.test(countryRaw) || countryRaw === 'IN') throw new Error('Invalid corridor');
  const country = countryRaw as CountryCode;

  await getDb().transaction(async (tx) => {
    const partners = createPartnerStore(tx);
    const partner = await partners.getPartner(partnerId);
    if (!partner) throw new Error('Partner not found');
    if (!(partner.countries ?? []).includes(country)) throw new Error('Invalid corridor');
    let rulesReset = false;
    const { found, previous } = await partners.updateCorridorCompliance(partnerId, (prev) => {
      const entry = { ...(prev[country] ?? {}) };
      if (on) {
        entry.amlHolds = true;
        if ('amlHoldRules' in entry && resolveAmlHoldRules(true, entry.amlHoldRules).length === 0) {
          delete entry.amlHoldRules;
          rulesReset = true;
        }
      } else {
        delete entry.amlHolds;
        delete entry.amlHoldRules;
      }
      const next = { ...prev };
      if (Object.keys(entry).length === 0) delete next[country];
      else next[country] = entry;
      return next;
    });
    if (!found) throw new Error('Partner not found');
    await createAuditRepo(tx).record({
      partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'aml.holds_set',
      subjectId: partnerId,
      meta: { country, from: previous[country]?.amlHolds === true, to: on, ...(rulesReset ? { rulesReset: true } : {}) },
    });
  });
  revalidatePath('/admin-dashboard/compliance');
}

/**
 * Fix pack 6 T23 (R48, P22, P21): the platform writer of one corridor's pay-step
 * risk signals (partners.corridor_compliance[<country>].riskSignals). Off by
 * default; nothing reads it at pay time until T25/T26a. Partners get no writer.
 *
 * Order: the site-host guard, requirePlatformAdmin, the actor's own two-step
 * (so the forced step-up is always a TOTP code), the partner (the default tenant
 * refused), the corridor (never IN), strict fields, the FORCED step-up
 * ('risk_signal.save', always), then ONE transaction: the partner read, the
 * corridor in `countries`, the row-locked corridor write (other keys kept) and
 * the `risk_signals.set` audit row (meta: country and the resolved from / to:
 * booleans, numbers and enum strings only). 'off' stores enabled:false and keeps
 * the posted thresholds and hold list. No outbox row. Returns a result (client
 * form) and never a driver message.
 */
export type RiskSignalsActionResult = { ok: true } | { ok: false; error: string };

const RS_NOT_FOUND = 'Partner not found.';
const RS_BAD_CORRIDOR = 'Invalid corridor.';
const RS_BAD_INPUT = 'Check the fields and try again.';
const RS_NEED_MFA = 'Turn on two-step verification for your own staff account first.';
const RS_FAILED = 'Something went wrong. Nothing was changed. Please try again.';
const RS_DEMO = 'The default (demo) tenant never shows risk signals.';

class RefusedError extends Error {
  constructor(readonly copy: string) {
    super('refused');
    this.name = 'RefusedError';
  }
}

const rsRefused = (error: string): RiskSignalsActionResult => ({ ok: false, error });
const rsErrName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** The plain stored / audited shape of a config (unfrozen copy of `hold`). */
function riskSignalsShape(c: RiskSignalConfig): { enabled: boolean; amountUsd: number; newAccountHours: number; hold: RiskSignal[] } {
  return { enabled: c.enabled, amountUsd: c.amountUsd, newAccountHours: c.newAccountHours, hold: [...c.hold] };
}

/** The strict field parse; null when any field is off. */
function parseRiskSignalsFields(formData: FormData): RiskSignalConfig | null {
  const enabledRaw = formData.get('enabled');
  if (enabledRaw !== 'on' && enabledRaw !== 'off') return null;
  const amountRaw = formData.get('amountUsd');
  const hoursRaw = formData.get('newAccountHours');
  if (typeof amountRaw !== 'string' || typeof hoursRaw !== 'string') return null;
  if (amountRaw.trim() === '' || hoursRaw.trim() === '') return null;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return null;
  const hours = Number(hoursRaw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return null;
  const hold = formData.getAll('hold');
  if (!hold.every((h) => isRiskSignal(h))) return null;
  return {
    enabled: enabledRaw === 'on',
    amountUsd: Math.round(amount * 100) / 100,
    newAccountHours: hours,
    hold: RISK_SIGNALS.filter((s) => hold.includes(s)),
  };
}

export async function setRiskSignalsAction(_prev: unknown, formData: FormData): Promise<RiskSignalsActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  if (!(await staffMfaEnrolled(staff.username))) return rsRefused(RS_NEED_MFA);
  const rawId = formData.get('partnerId');
  const partnerId = typeof rawId === 'string' ? rawId.trim() : '';
  if (!partnerId || partnerId.length > 100) return rsRefused(RS_NOT_FOUND);
  if (partnerId === DEFAULT_PARTNER_ID) return rsRefused(RS_DEMO);
  const countryRaw = formData.get('country');
  if (typeof countryRaw !== 'string' || !/^[A-Z]{2}$/.test(countryRaw) || countryRaw === 'IN') return rsRefused(RS_BAD_CORRIDOR);
  const country = countryRaw as CountryCode;
  const parsed = parseRiskSignalsFields(formData);
  if (!parsed) return rsRefused(RS_BAD_INPUT);
  const next = riskSignalsShape(parsed);

  const stepUp = await gateStaffStepUp(staff, formData, 'risk_signal.save', { always: true });
  if (stepUp) return stepUp;

  try {
    await getDb().transaction(async (tx) => {
      const partners = createPartnerStore(tx);
      const partner = await partners.getPartner(partnerId);
      if (!partner) throw new RefusedError(RS_NOT_FOUND);
      if (!(partner.countries ?? []).includes(country)) throw new RefusedError(RS_BAD_CORRIDOR);
      const { found, previous } = await partners.updateCorridorCompliance(partnerId, (prev) => ({
        ...prev,
        [country]: { ...(prev[country] ?? {}), riskSignals: { ...next, hold: [...next.hold] } },
      }));
      if (!found) throw new RefusedError(RS_NOT_FOUND);
      const from = riskSignalsShape(resolveCorridorRules({ ...partner, corridorCompliance: previous }, country).riskSignals);
      await createAuditRepo(tx).record({
        partnerId,
        actor: staff.username,
        actorType: 'staff',
        action: 'risk_signals.set',
        subjectId: partnerId,
        meta: { country, from, to: next },
      });
    });
  } catch (err) {
    if (err instanceof RefusedError) return rsRefused(err.copy);
    // The error NAME only: never the driver object or its message.
    logWarn('admin.risk_signals', rsErrName(err), { partnerId });
    return rsRefused(RS_FAILED);
  }
  revalidatePath('/admin-dashboard/compliance');
  return { ok: true };
}
