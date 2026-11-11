'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createPartnerStore, getPartnerStore } from '@/lib/partner-store';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { isLiveCertified } from '@/lib/live-gate';
import { notifyLiveChange } from '@/lib/live-controls-write';
import { AML_HOLD_RULES, amlHoldRulesEntry, isAmlHoldRule, type AmlHoldRule } from '@/lib/aml-hold';
import { resolveAmlHoldRules } from '@/lib/compliance-config';
import type { CountryCode } from '@/lib/types';
import { scopeOf } from '@/lib/staff-scope';
import {
  parseAlertEmail,
  parseDisclosureForm,
  parseSupportPortal,
  setAlertEmail,
  setComplianceAlertEmail,
  setDisclosure,
  setSupportPortal,
  type DisclosureParseReason,
  type SupportSettingsActor,
  type SupportWriteResult,
} from '@/lib/partner-support-settings';
import { MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';
import { PROVIDER_LINE_MAX } from '@/lib/legal/provider-line';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { pokeWorker } from '@/lib/outbox';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/settings server actions (partner-dashboard merge, 2f). The shared /partner action shape:
//  - refuseOnSiteHost() first, then the admin gate, both outside any try;
//  - the target is ALWAYS the session's tenant (ctx.partnerId): no form field names a partner, and
//    any id / partnerId / partner field is never read;
//  - the rules and writers are src/lib/partner-support-settings.ts (shared with the legacy page):
//    each merges only its own support_config keys under the row lock, with ONE audit row in the same
//    transaction whose meta.actorScope comes from the session. The alert address is never audited;
//  - the Reg E disclosure is what customers see as the provider of record, so its save needs the
//    15-minute step-up (partner-step-up-gate.ts), checked after the parse and before any write;
//    a TOTP-enrolled admin's save also stamps the partner approval and needs a step-up for that
//    save itself (fix pack 4 C11);
//  - errors are fixed, translated copy: never an exception message, never the input echoed back.

const POLICY = PARTNER_ROUTES.settings.policy;
const PAGE = PARTNER_ROUTES.settings.href;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (key: MessageKey, vars?: Record<string, string | number>) => ({ ok: false as const, error: t(key, vars) });
/** The audit actor, derived from the authenticated record (never from input). */
const actorOf = (ctx: PartnerCtx): SupportSettingsActor => ({ username: ctx.username, actorScope: scopeOf(ctx.staff).kind });

const DISCLOSURE_ERROR: Record<DisclosureParseReason, MessageKey> = {
  provider_phone: 'partner.settings.disclosure.error.providerPhone',
  regulator_phone: 'partner.settings.disclosure.error.regulatorPhone',
  provider_website: 'partner.settings.disclosure.error.providerWebsite',
  regulator_website: 'partner.settings.disclosure.error.regulatorWebsite',
  delivery_days: 'partner.settings.disclosure.error.deliveryDays',
  regulator_name_required: 'partner.settings.disclosure.error.regulatorNameRequired',
  entity_required: 'partner.settings.disclosure.error.entityRequired',
  provider_name: 'partner.settings.disclosure.error.providerName',
  provider_line_too_long: 'partner.settings.disclosure.error.providerLineTooLong',
};

async function tenantExists(ctx: PartnerCtx): Promise<boolean> {
  return (await getPartnerStore().getPartner(ctx.partnerId)) !== null;
}

/** Run a writer; a thrown error is logged by name only and becomes the fixed "failed" copy. */
async function write(scope: string, ctx: PartnerCtx, run: () => Promise<SupportWriteResult>): Promise<ActionResult> {
  let r: SupportWriteResult;
  try {
    r = await run();
  } catch (err) {
    logWarn(scope, errName(err), { partnerId: ctx.partnerId });
    return refused('partner.settings.failed');
  }
  if (!r.ok) return refused('partner.settings.notFound');
  revalidatePath(PAGE);
  return { ok: true };
}

export async function saveSupportPortalAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const enabled = parseSupportPortal(formData.get('enableSupportPortal'));
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  return write('partner.settings.portal', ctx, () => setSupportPortal(getDb(), ctx.partnerId, actorOf(ctx), enabled));
}

export async function saveAlertEmailAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const raw = formData.get('alertEmail');
  // A missing field never clears the address: only an explicit blank does.
  if (typeof raw !== 'string') return refused('partner.settings.alert.invalid');
  const parsed = parseAlertEmail(raw);
  if (!parsed.ok) return refused('partner.settings.alert.invalid');
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  return write('partner.settings.alert_email', ctx, () => setAlertEmail(getDb(), ctx.partnerId, actorOf(ctx), parsed.value));
}

// Fix pack 2 T5 (R04): where sanctions-block notices go (blank ⇒ the alert email). Same rules.
export async function saveComplianceAlertEmailAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const raw = formData.get('complianceAlertEmail');
  // A missing field never clears the address: only an explicit blank does.
  if (typeof raw !== 'string') return refused('partner.settings.compliance.invalid');
  const parsed = parseAlertEmail(raw);
  if (!parsed.ok) return refused('partner.settings.compliance.invalid');
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  return write('partner.settings.compliance_email', ctx, () => setComplianceAlertEmail(getDb(), ctx.partnerId, actorOf(ctx), parsed.value));
}

export async function saveDisclosureAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const parsed = parseDisclosureForm(formData); // validated BEFORE the step-up and any write
  if (!parsed.ok) return refused(DISCLOSURE_ERROR[parsed.reason], { max: MAX_DELIVERY_BUSINESS_DAYS, limit: PROVIDER_LINE_MAX });
  // Fix pack 4 T5 (C11): a TOTP-enrolled admin's save stamps the partner approval, so the step-up is
  // forced for THIS save (critic M7: a still-fresh step-up taken with a password before enrolment
  // never stamps). Fail closed: a read error counts as not enrolled (saved unapproved, as today).
  const enrolled = await staffMfaEnrolled(ctx.username);
  const stepUp = await gatePartnerStepUp(ctx, formData, 'disclosure.save', enrolled ? { always: true } : {});
  if (stepUp) return stepUp;
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  const r = await write('partner.settings.disclosure', ctx, () =>
    setDisclosure(getDb(), ctx.partnerId, actorOf(ctx), parsed.value, { approve: enrolled }),
  );
  // setDisclosure can enqueue (the approval-cleared notice, R3-Y1 D2); post-response, so after the commit.
  if (r.ok) pokeWorker();
  return r;
}

/** The posted corridor and rule list, strictly: one `country` (^[A-Z]{2}$, never IN) and only listed rule ids. */
function parseAmlHoldRulesForm(formData: FormData): { country: CountryCode; rules: AmlHoldRule[] } | null {
  const countries = formData.getAll('country');
  if (countries.length !== 1) return null;
  const country = countries[0];
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || country === 'IN') return null;
  const picked: string[] = [];
  for (const v of formData.getAll('rules')) {
    if (typeof v !== 'string' || !isAmlHoldRule(v)) return null;
    picked.push(v);
  }
  // Canonical order, de-duplicated.
  return { country: country as CountryCode, rules: AML_HOLD_RULES.filter((r) => picked.includes(r)) };
}

/**
 * Fix pack 6 T19 (P17): which in-mint AML rules hold a REAL-MONEY transfer of one corridor for
 * SmartRemit review before payout (structuring, first_transfer, new_beneficiary). Order:
 * site host -> admin gate -> two-step sign-in enrolled (else refused, no step-up asked) -> the
 * step-up on EVERY save (target aml_rule.save) -> strict parse -> the default (demo) tenant is
 * refused (it is never held) -> ONE transaction: the partner read, the corridor must be one it
 * serves, the row-locked corridor write (amlHoldRulesEntry: no rule ticked DELETES amlHolds and
 * stores [], never amlHolds:false, so an older build reads it as off), the aml.hold_rules_set
 * audit row (from/to are the RESOLVED rule lists) and, on a live-certified partner, the live
 * notice (ops alert + partner email, key amlHoldRules) -> poke the worker after the commit.
 */
export async function setAmlHoldRulesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  if (!(await staffMfaEnrolled(ctx.username))) return refused('partner.settings.amlHolds.mfaRequired');
  const stepUp = await gatePartnerStepUp(ctx, formData, 'aml_rule.save', { always: true });
  if (stepUp) return stepUp;
  const parsed = parseAmlHoldRulesForm(formData);
  if (!parsed || ctx.partnerId === DEFAULT_PARTNER_ID) return refused('partner.settings.amlHolds.invalid');
  const { country, rules } = parsed;
  const actor = actorOf(ctx);

  let outcome: 'ok' | 'not_found' | 'invalid';
  try {
    outcome = await getDb().transaction(async (tx) => {
      const store = createPartnerStore(tx);
      const p = await store.getPartner(ctx.partnerId);
      if (!p) return 'not_found' as const;
      if (!(p.countries ?? []).includes(country)) return 'invalid' as const;
      const { found, previous } = await store.updateCorridorCompliance(ctx.partnerId, (prev) => ({
        ...prev,
        [country]: amlHoldRulesEntry(prev[country], rules),
      }));
      if (!found) return 'not_found' as const;
      const was = previous[country];
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'aml.hold_rules_set',
        subjectId: ctx.partnerId,
        meta: { country, from: [...resolveAmlHoldRules(was?.amlHolds === true, was?.amlHoldRules)], to: [...rules], actorScope: actor.actorScope },
      });
      if (isLiveCertified(p)) {
        await notifyLiveChange(tx, ctx.partnerId, { username: ctx.username, scope: 'partner' }, { key: 'amlHoldRules', action: 'aml.hold_rules_set', word: 'updated' });
      }
      return 'ok' as const;
    });
  } catch (err) {
    logWarn('partner.settings.aml_rules', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.settings.failed');
  }
  if (outcome === 'not_found') return refused('partner.settings.notFound');
  if (outcome === 'invalid') return refused('partner.settings.amlHolds.invalid');
  revalidatePath(PAGE);
  pokeWorker(); // the live notice is post-response, so after the commit
  return { ok: true };
}
