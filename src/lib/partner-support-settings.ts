// partner-support-settings: the three staff-set blocks of partners.support_config, shared by the
// legacy "My partner" actions (src/app/admin-dashboard/partners/actions.ts) and /partner/settings:
//   - the support-portal switch (enableSupportPortal; the legacy page also sets autoAssign);
//   - the channel alert email (R2a: where partner-actionable WhatsApp alerts are emailed);
//   - the Reg E disclosure (Program-Fix 15 PR B: the licensed partner's identity, shown to
//     customers on the pay page and the receipt via resolvePartnerDisclosure).
// The parsers are PURE and return a reason, never copy: each caller maps the reason to its own
// fixed text. Each writer merges ONLY its own keys into the stored jsonb through
// updateSupportConfig (row lock, column-only UPDATE) and records its audit row in the SAME
// transaction, with meta.actorScope from the caller's session. An unknown partner ⇒ not_found
// and nothing written. The alert email is never written to an audit row (booleans only).
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPartnerStore } from '@/lib/partner-store';
import { normalizeAlertEmail } from '@/lib/channel-health';
import { isDisclosurePhone, isHttpsUrl, MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';
import { boundUntrustedText } from '@/lib/untrusted-text';
import type { PartnerDisclosureConfig, PartnerId, PartnerSupportConfig } from '@/lib/types';

export const DISCLOSURE_TEXT_MAX = 120;
const MAX_LICENSE_IDS = 20;

export type DisclosureParseReason =
  | 'provider_phone'
  | 'provider_website'
  | 'regulator_phone'
  | 'regulator_website'
  | 'delivery_days'
  | 'regulator_name_required'
  | 'entity_required';
export type DisclosureParse = { ok: true; value: PartnerDisclosureConfig | undefined } | { ok: false; reason: DisclosureParseReason };
export type AlertEmailParse = { ok: true; value: string | null } | { ok: false; reason: 'invalid_email' };

export interface SupportSettingsActor {
  username: string;
  actorScope: 'platform' | 'partner';
}
export type SupportWriteResult = { ok: true } | { ok: false; reason: 'not_found' };
export type SupportKnobs = Pick<PartnerSupportConfig, 'enableSupportPortal' | 'autoAssign'>;

type Field<T> = { ok: true; value: T | undefined } | { ok: false };

const raw = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim() : '');

function optionalText(formData: FormData, key: string): string | undefined {
  const v = boundUntrustedText(formData.get(key), DISCLOSURE_TEXT_MAX);
  return v === '' ? undefined : v;
}

function optionalHttps(formData: FormData, key: string): Field<string> {
  const v = raw(formData.get(key));
  if (v === '') return { ok: true, value: undefined };
  return isHttpsUrl(v) ? { ok: true, value: v } : { ok: false };
}

function optionalPhone(formData: FormData, key: string): Field<string> {
  const v = raw(formData.get(key));
  if (v === '') return { ok: true, value: undefined };
  return isDisclosurePhone(v) ? { ok: true, value: v } : { ok: false };
}

function optionalBusinessDays(formData: FormData): Field<number> {
  const v = raw(formData.get('deliveryBusinessDays'));
  if (v === '') return { ok: true, value: undefined };
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DELIVERY_BUSINESS_DAYS ? { ok: true, value: n } : { ok: false };
}

/**
 * Form → disclosure config. `value: undefined` is an all-blank form (clear the block). Checks run
 * in the legacy order, so the first failing field is the one reported.
 */
export function parseDisclosureForm(formData: FormData): DisclosureParse {
  const licensedEntity = optionalText(formData, 'licensedEntity');
  const licenseIds = raw(formData.get('licenseIds'))
    .split(/[,\n]/)
    .map((x) => boundUntrustedText(x, DISCLOSURE_TEXT_MAX))
    .filter((x) => x !== '')
    .slice(0, MAX_LICENSE_IDS);
  const phone = optionalPhone(formData, 'phone');
  if (!phone.ok) return { ok: false, reason: 'provider_phone' };
  const website = optionalHttps(formData, 'website');
  if (!website.ok) return { ok: false, reason: 'provider_website' };
  const regulatorName = optionalText(formData, 'regulatorName');
  const regulatorPhone = optionalPhone(formData, 'regulatorPhone');
  if (!regulatorPhone.ok) return { ok: false, reason: 'regulator_phone' };
  const regulatorWebsite = optionalHttps(formData, 'regulatorWebsite');
  if (!regulatorWebsite.ok) return { ok: false, reason: 'regulator_website' };
  const days = optionalBusinessDays(formData);
  if (!days.ok) return { ok: false, reason: 'delivery_days' };
  if ((regulatorPhone.value || regulatorWebsite.value) && !regulatorName) return { ok: false, reason: 'regulator_name_required' };
  const anyDetail = licenseIds.length > 0 || phone.value || website.value || regulatorName || days.value !== undefined;
  if (!licensedEntity) return anyDetail ? { ok: false, reason: 'entity_required' } : { ok: true, value: undefined };

  const out: PartnerDisclosureConfig = { licensedEntity };
  if (licenseIds.length > 0) out.licenseIds = licenseIds;
  if (phone.value) out.phone = phone.value;
  if (website.value) out.website = website.value;
  if (regulatorName) {
    out.stateRegulator = { name: regulatorName };
    if (regulatorPhone.value) out.stateRegulator.phone = regulatorPhone.value;
    if (regulatorWebsite.value) out.stateRegulator.website = regulatorWebsite.value;
  }
  if (days.value !== undefined) out.deliveryEstimate = { businessDays: days.value };
  return { ok: true, value: out };
}

/** One plain address (trimmed), or null for blank (alerts off). Anything else is refused. */
export function parseAlertEmail(v: unknown): AlertEmailParse {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, reason: 'invalid_email' };
  const next = normalizeAlertEmail(v);
  return next === undefined ? { ok: false, reason: 'invalid_email' } : { ok: true, value: next };
}

/** The portal checkbox: on only for the exact value 'on'. */
export function parseSupportPortal(v: unknown): boolean {
  return v === 'on';
}

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
/** Run `fn` in a transaction when holding a Db; inside an existing tx, share it. */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

async function mergeAndAudit(
  db: DbOrTx,
  partnerId: PartnerId,
  actor: SupportSettingsActor,
  action: string,
  merge: (prev: PartnerSupportConfig) => PartnerSupportConfig,
  meta: (prev: PartnerSupportConfig) => Record<string, unknown>,
): Promise<SupportWriteResult> {
  return inTx(db, async (tx) => {
    const { found, previous } = await createPartnerStore(tx).updateSupportConfig(partnerId, merge);
    if (!found) return { ok: false, reason: 'not_found' } as const;
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action,
      subjectId: partnerId,
      meta: { ...meta(previous), actorScope: actor.actorScope },
    });
    return { ok: true } as const;
  });
}

/** The support knobs: merges exactly the keys present in `patch`; audits their old and new values. */
export function setSupportKnobs(db: DbOrTx, partnerId: PartnerId, actor: SupportSettingsActor, patch: SupportKnobs): Promise<SupportWriteResult> {
  const keys = Object.keys(patch) as Array<keyof SupportKnobs>;
  return mergeAndAudit(
    db,
    partnerId,
    actor,
    'partner.support_config',
    (prev) => ({ ...prev, ...patch }),
    (prev) => ({ old: Object.fromEntries(keys.map((k) => [k, prev[k] ?? null])), new: patch }),
  );
}

/** The customer support portal on/off. autoAssign, the alert email and the disclosure are kept. */
export function setSupportPortal(db: DbOrTx, partnerId: PartnerId, actor: SupportSettingsActor, enabled: boolean): Promise<SupportWriteResult> {
  return setSupportKnobs(db, partnerId, actor, { enableSupportPortal: enabled });
}

/** Set (a parsed address) or clear (null) the channel alert email. Audited WITHOUT the address. */
export function setAlertEmail(db: DbOrTx, partnerId: PartnerId, actor: SupportSettingsActor, next: string | null): Promise<SupportWriteResult> {
  return mergeAndAudit(
    db,
    partnerId,
    actor,
    'partner.alert_email.update',
    (prev) => {
      const { alertEmail: _old, ...rest } = prev;
      void _old;
      return next ? { ...rest, alertEmail: next } : rest;
    },
    (prev) => ({ set: next !== null, hadPrevious: Boolean(prev.alertEmail) }),
  );
}

/** Replace (a parsed config) or clear (undefined) the Reg E disclosure block. */
export function setDisclosure(
  db: DbOrTx,
  partnerId: PartnerId,
  actor: SupportSettingsActor,
  disclosure: PartnerDisclosureConfig | undefined,
): Promise<SupportWriteResult> {
  return mergeAndAudit(
    db,
    partnerId,
    actor,
    'partner.disclosure_config',
    (prev) => {
      const next: PartnerSupportConfig = { ...prev };
      if (disclosure) next.disclosure = disclosure;
      else delete next.disclosure;
      return next;
    },
    (prev) => ({ old: prev.disclosure ?? null, new: disclosure ?? null }),
  );
}
