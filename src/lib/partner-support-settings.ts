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
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createPartnerStore } from '@/lib/partner-store';
import { normalizeAlertEmail } from '@/lib/channel-health';
import { isDisclosurePhone, isHttpsUrl, MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';
import { boundUntrustedText } from '@/lib/untrusted-text';
import { isProviderNameText, namesPlatform, providerLineFits } from '@/lib/legal/provider-line';
import { DEFAULT_PARTNER_ID } from './defaults';
import { disclosureHash } from './disclosure-hash';
import { isLiveCertified } from './live-gate';
import { notifyLiveChange } from './live-controls-write';
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
  | 'entity_required'
  | 'provider_name'
  | 'provider_line_too_long';
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
 * Review R1-P5 (C1): a name the provider line is built from, checked on the RAW form text.
 * Review R3-Y1 O2 (D4): a name with the platform brand is refused too (namesPlatform, the rule
 * providerLineFor reads null on), unless the save is the platform's own for the default tenant.
 */
const badProviderName = (formData: FormData, key: string, platformNameAllowed: boolean): boolean => {
  const v = raw(formData.get(key));
  return v !== '' && (!isProviderNameText(v) || (!platformNameAllowed && namesPlatform(v)));
};

export interface DisclosureParseOptions {
  /**
   * Only the admin action, for the default (demo) tenant: its stored block is never shown
   * (resolvePartnerDisclosure answers the demo note) and may name SmartRemit. Default false.
   */
  platformNameAllowed?: boolean;
}

/**
 * Form → disclosure config. `value: undefined` is an all-blank form (clear the block). Checks run
 * in the legacy order, so the first failing field is the one reported.
 */
export function parseDisclosureForm(formData: FormData, opts: DisclosureParseOptions = {}): DisclosureParse {
  const platformNameAllowed = opts.platformNameAllowed === true;
  // Review R1-P5 (C1): the entity and regulator names build the provider line the bot quotes, so a
  // double quote, a backtick, a line break, a rule-override phrase or (R3-Y1 O2) the platform name
  // is refused (reason provider_name).
  if (badProviderName(formData, 'licensedEntity', platformNameAllowed)) return { ok: false, reason: 'provider_name' };
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
  if (badProviderName(formData, 'regulatorName', platformNameAllowed)) return { ok: false, reason: 'provider_name' };
  const regulatorName = optionalText(formData, 'regulatorName');
  const regulatorPhone = optionalPhone(formData, 'regulatorPhone');
  if (!regulatorPhone.ok) return { ok: false, reason: 'regulator_phone' };
  const regulatorWebsite = optionalHttps(formData, 'regulatorWebsite');
  if (!regulatorWebsite.ok) return { ok: false, reason: 'regulator_website' };
  const days = optionalBusinessDays(formData);
  if (!days.ok) return { ok: false, reason: 'delivery_days' };
  if ((regulatorPhone.value || regulatorWebsite.value) && !regulatorName) return { ok: false, reason: 'regulator_name_required' };
  // Review R2-Q1 K1: the two names build the provider line, which may not exceed PROVIDER_LINE_MAX.
  if (licensedEntity && regulatorName && !providerLineFits(licensedEntity, regulatorName)) {
    return { ok: false, reason: 'provider_line_too_long' };
  }
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

/**
 * Fix pack 2 T5 (R04): set (a parsed address) or clear (null) the compliance
 * alert email, where sanctions-block notices go (blank ⇒ the alert email).
 * Audited WITHOUT the address.
 */
export function setComplianceAlertEmail(db: DbOrTx, partnerId: PartnerId, actor: SupportSettingsActor, next: string | null): Promise<SupportWriteResult> {
  return mergeAndAudit(
    db,
    partnerId,
    actor,
    'partner.compliance_email.update',
    (prev) => {
      const { complianceAlertEmail: _old, ...rest } = prev;
      void _old;
      return next ? { ...rest, complianceAlertEmail: next } : rest;
    },
    (prev) => ({ set: next !== null, hadPrevious: Boolean(prev.complianceAlertEmail) }),
  );
}

export interface SetDisclosureOptions {
  /** Stamp a partner approval. Honoured ONLY for a partner actor on a real (not 'default') partner. */
  approve?: boolean;
  now?: Date;
}

/** The block without any `approval` key (a stamp is never stored as given). */
function withoutApproval(d: PartnerDisclosureConfig): PartnerDisclosureConfig {
  const { approval: _approval, ...rest } = d;
  void _approval;
  return rest;
}

/** The stored block carries a stamp whose hash equals the block's own hash. */
function hasValidApproval(d: unknown): boolean {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const ap = (d as Record<string, unknown>).approval;
  const h = ap && typeof ap === 'object' ? (ap as Record<string, unknown>).hash : undefined;
  return typeof h === 'string' && h === disclosureHash(d);
}

/**
 * Replace (a parsed config) or clear (undefined) the Reg E disclosure block.
 *
 * Fix pack 4 T5 (C11): the provider block's approval stamp. Any `approval` on the input is
 * dropped; the writer stamps `{ by: actor.username, at: now ISO, hash: disclosureHash(block) }`
 * ONLY for a partner actor with `opts.approve === true` (the partner action passes it only for a
 * TOTP-enrolled admin after a step-up forced for this save) on a partner other than 'default'.
 * Every other save stores the block unstamped. One transaction: the locked merge, one audit row
 * (meta `{ old, new, actorScope, approved, clearedApproval }`; clearedApproval = the previous block
 * carried a VALID stamp and this save stored none) and, when a save cleared an approval on a
 * live-certified partner (a platform save, or a partner save without the two-step stamp; R3-Y1 D2),
 * pack 3's live-change alert and partner email (notifyLiveChange).
 * Errors propagate (the actions log the error name only).
 */
export function setDisclosure(
  db: DbOrTx,
  partnerId: PartnerId,
  actor: SupportSettingsActor,
  disclosure: PartnerDisclosureConfig | undefined,
  opts: SetDisclosureOptions = {},
): Promise<SupportWriteResult> {
  const clean = disclosure ? withoutApproval(disclosure) : undefined;
  const stamp = actor.actorScope === 'partner' && opts.approve === true && clean !== undefined && partnerId !== DEFAULT_PARTNER_ID;
  const block: PartnerDisclosureConfig | undefined =
    stamp && clean
      ? { ...clean, approval: { by: actor.username, at: (opts.now ?? new Date()).toISOString(), hash: disclosureHash(clean) } }
      : clean;
  return inTx(db, async (tx) => {
    const { found, previous, next } = await createPartnerStore(tx).updateSupportConfig(partnerId, (prev) => {
      const merged: PartnerSupportConfig = { ...prev };
      if (block) merged.disclosure = block;
      else delete merged.disclosure;
      return merged;
    });
    if (!found) return { ok: false, reason: 'not_found' } as const;
    const clearedApproval = hasValidApproval(previous.disclosure) && !stamp;
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: 'partner.disclosure_config',
      subjectId: partnerId,
      meta: { old: previous.disclosure ?? null, new: block ?? null, actorScope: actor.actorScope, approved: stamp, clearedApproval },
    });
    // Review R3-Y1 D2: EVERY save that clears a valid approval on a live-certified partner tells ops
    // and the partner, whatever the actor scope (a partner admin without two-step sign-in clears it
    // too, with the same effect). The notice names the scope only ('by partner staff' / 'your team').
    if (clearedApproval) {
      // The partner row is already locked by updateSupportConfig: this read is for the certification only.
      const p = await createPartnerRepo(tx).getPartner(partnerId);
      if (isLiveCertified(p)) {
        await notifyLiveChange(
          tx,
          partnerId,
          { username: actor.username, scope: actor.actorScope },
          { key: 'providerBlock', action: 'partner.disclosure.approval_cleared', word: 'approval cleared; payments wait until your admin approves it again' },
          next,
        );
      }
    }
    return { ok: true } as const;
  });
}
