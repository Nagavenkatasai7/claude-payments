'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requirePlatformAdmin, requireScope } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { createCustomerStore, getCustomerStore } from '@/lib/customer-store';
import { validateSendLimitInput, requireStaffReason, isUnchangedPartnerSetEntry, PLATFORM_SEND_LIMITS } from '@/lib/send-limits';
import { ownerAddressCheck } from '@/lib/originator-info';
import { LIMIT_NEEDS_ADDRESS_COPY, limitRaiseNeedsAddress } from '@/lib/travel-rule';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { notifyKycReviewDecision } from '@/lib/kyc-notify';
import { canDecideCustomerKyc, senderScreeningHoldActive } from '@/lib/compliance-config';
import { getPartnerStore } from '@/lib/partner-store';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { countryForPhone } from '@/lib/partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import { createScopedStore } from '@/lib/scoped-store';
import { sealCustomerRef, auditSubjectId } from '@/lib/customer-ref';
import type { CountryCode, KycStatus, PartnerId, Staff } from '@/lib/types';
import { SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { partnerDecidesKyc } from '@/lib/partner-decision-scope';
import { senderPepOnly } from '@/lib/hold-queue';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { parseHoldReason } from '@/lib/hold-decision';
import { HOLD_REASON_REFUSAL } from '@/lib/dashboard-ops';
import { logWarn } from '@/lib/log';
import {
  PARTNER_DECIDES_KYC_REFUSAL,
  PARTNER_WORKSPACE_KYC_REFUSAL,
  PARTNER_CREATE_KYC_REFUSAL,
  PARTNER_PEP_CLEAR_REFUSAL,
  KYC_RECOMMENDATION_ONLY_REFUSAL,
  KYC_RECOMMENDATION_INVALID,
} from '@/lib/partner-kyc-decision';
import type { Partner } from '@/lib/partner-store';

const VALID_COUNTRIES = new Set<CountryCode>(SUPPORTED_DESTINATIONS);

// Program-Fix 37 (dash-04): the detail route is keyed on a sealed ref, never
// the phone. Revalidation targets the dynamic route pattern (every ref), per
// revalidatePath(originalPath, 'page') in
// node_modules/next/dist/server/web/spec-extension/revalidate.d.ts:32.
const CUSTOMER_DETAIL_ROUTE = '/admin-dashboard/customers/[ref]';

function customerDetailPath(partnerId: PartnerId, phone: string): string {
  return `/admin-dashboard/customers/${sealCustomerRef(partnerId, phone)}`;
}

/**
 * Program-Fix 37 (dash-04): open a customer's detail page. Customer links are
 * small POST forms (CustomerLink), so the phone travels only in this request
 * body and the browser lands on the sealed-ref URL: no phone in the address
 * bar, request logs, history or referrers. Self-gated (requireScope bounces
 * support), then re-resolved UNDER THE CALLER'S SCOPE (createScopedStore pins
 * partner staff to their tenant whatever partnerId is posted). The ref seals
 * the RESOLVED row's own (partnerId, senderPhone), never the form fields.
 */
export async function openCustomerAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const { staff } = await requireScope();
  const phone = String(formData.get('phone') ?? '').trim();
  const partnerId = String(formData.get('partnerId') ?? '').trim();
  if (!phone) throw new Error('Customer not found.');
  const customer = await createScopedStore(staff).getCustomer(phone, { partnerId: partnerId || undefined });
  if (!customer) throw new Error('Customer not found.');
  redirect(customerDetailPath(customer.partnerId, customer.senderPhone));
}

/**
 * The tenant an admin action targets (fix 1): partner staff are PINNED to their
 * own (the form field is ignored — an identity pin, never an input); platform
 * staff MUST name one. No silent default: a stale or hand-crafted form without
 * a partnerId must never act on the default tenant's row for a multi-tenant
 * phone (the detail page always posts the hidden field).
 */
function targetPartnerId(staff: { partnerId?: string }, formData: FormData): PartnerId {
  if (staff.partnerId) return staff.partnerId;
  const requested = String(formData.get('partnerId') ?? '').trim();
  if (!requested) throw new Error('Partner is required.');
  return requested;
}

const NOT_ALLOWED = 'You do not have permission to perform this action.';

/**
 * Fix pack 7 T27 (P25): who decides this tenant's KYC. The default tenant is never read (it never
 * decides KYC). Any other tenant is read through the partner store; a read that throws or finds no
 * row is a REFUSAL with the permission text, never "not certified" (platformReviewGate's rule,
 * admin-dashboard/actions.ts). The owner is returned so canDecideCustomerKyc gets it.
 */
async function deciderOwner(partnerId: PartnerId): Promise<{ decides: boolean; owner: Partner | null }> {
  if (partnerId === DEFAULT_PARTNER_ID) return { decides: false, owner: null };
  let owner: Partner | null;
  try {
    owner = await getPartnerStore().getPartner(partnerId);
  } catch (err) {
    logWarn('admin.kyc.owner-read', err instanceof Error ? err.name : 'error', { partnerId });
    owner = null;
  }
  if (!owner) throw new Error(NOT_ALLOWED);
  return { decides: partnerDecidesKyc(owner), owner };
}

/** P25: a deciding partner's KYC is decided in its own workspace; SmartRemit staff are refused. */
function refuseDecidingPartner(staff: Staff): never {
  throw new Error(scopeOf(staff).kind === 'platform' ? PARTNER_DECIDES_KYC_REFUSAL : PARTNER_WORKSPACE_KYC_REFUSAL);
}

/** "Main Admin (forextransfer)" — the display string kept in kycApprovedBy / meta.reviewerName. */
function reviewerDisplay(staff: Pick<Staff, 'name' | 'username'>): string {
  return staff.name && staff.name !== staff.username ? `${staff.name} (${staff.username})` : staff.username;
}

/**
 * Program-Fix 28 (compliance-04): the MANUAL KYC decision — the replacement
 * for the removed one-click "Mark KYC verified / rejected" buttons.
 * Server-action checklist, in order:
 *  1. requireAdmin();
 *  2. input validation BEFORE any read: phone, decision (approve | reject),
 *     and a MANDATORY reason (bounded, 10–500 characters);
 *  3. the tenant pin (partner staff pinned; platform staff must name it) and
 *     the keyed read, with canSee as defence in depth — out of scope ⇒ "not found";
 *  4. a no-op decision (approve an already verified/grandfathered customer,
 *     reject an already rejected one) is refused — no audit row for nothing;
 *  5. kyc-case-store.review with the durable options: ONE transaction locks the
 *     row, writes the decision (kycApprovedBy on approve) and the
 *     `kyc.manual_override.<decision>` audit_events row (meta.source 'manual',
 *     keyed subject, actor = username).
 * It sends NO WhatsApp message (as the removed buttons did not); only the
 * Persona review (reviewKycAction) keeps its gate-dependent notify.
 */
export async function manualKycDecisionAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const decision = String(formData.get('decision') ?? '');
  if (decision !== 'approve' && decision !== 'reject') throw new Error('Invalid decision.');
  const reason = requireStaffReason(formData.get('reason'));
  if (!phone) throw new Error('Phone is required.');

  const partnerId = targetPartnerId(staff, formData);
  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }
  // Program-Fix 43 follow-up: a watchlist / PEP hold is PLATFORM-only to
  // decide — refused before any mutation (re-checked on the locked row).
  const platformStaff = scopeOf(staff).kind === 'platform';
  // Fix pack 7 T27 (P25): a partner that decides KYC decides it in its own workspace.
  const { decides, owner } = await deciderOwner(customer.partnerId);
  if (decides) refuseDecidingPartner(staff);
  if (!canDecideCustomerKyc(scopeOf(staff), customer, owner)) {
    throw new Error('You do not have permission to perform this action.');
  }
  if (decision === 'approve' && (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered')) {
    throw new Error('Customer is already verified.');
  }
  if (decision === 'reject' && customer.kycStatus === 'rejected') {
    throw new Error('Customer is already rejected.');
  }

  const updated = await getKycCaseStore(getStore()).review(
    customer.partnerId, customer.senderPhone, decision, reviewerDisplay(staff), reason,
    { db: getDb(), store: getStore(), actor: staff.username, slug: `kyc.manual_override.${decision}`, source: 'manual', allowScreeningHold: platformStaff },
  );
  if (!updated) throw new Error('Customer not found.'); // raced a delete ⇒ nothing written
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}

/**
 * Phase 2 — the canonical, audit-logged KYC review decision (maker-checker-lite).
 * Used by the "Needs KYC Review" queue + customer detail. Approve sets
 * kycStatus:'verified'; reject sets 'rejected' with a MANDATORY reason. Goes
 * through kyc-case-store.review so every decision is appended to the audit log,
 * and notifies the customer fail-soft. Server-action checklist: own auth gate,
 * scope check (the customer key is global), reason guard before any mutation.
 */
export async function reviewKycAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const decision = String(formData.get('decision') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (decision !== 'approve' && decision !== 'reject') throw new Error('Invalid decision.');
  if (!reason) throw new Error('A review reason is required.');

  const partnerId = targetPartnerId(staff, formData);
  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(partnerId, phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }
  // Program-Fix 43 follow-up: a watchlist / PEP hold is PLATFORM-only to
  // decide — refused before any mutation (re-checked on the locked row).
  const platformStaff = scopeOf(staff).kind === 'platform';
  // Fix pack 7 T27 (P25): a partner that decides KYC decides it in its own workspace.
  const { decides, owner } = await deciderOwner(customer.partnerId);
  if (decides) refuseDecidingPartner(staff);
  if (!canDecideCustomerKyc(scopeOf(staff), customer, owner)) {
    throw new Error('You do not have permission to perform this action.');
  }

  // Attribute the reviewer by display name + stable username, e.g. "Main Admin (forextransfer)".
  // Program-Fix 28: durable — the decision and its kyc.review.<decision>
  // audit_events row commit together (actor = username, keyed subject).
  const reviewed = await getKycCaseStore(getStore()).review(
    partnerId, phone, decision, reviewerDisplay(staff), reason,
    { db: getDb(), store: getStore(), actor: staff.username, slug: `kyc.review.${decision}`, source: 'persona_review', allowScreeningHold: platformStaff },
  );
  if (!reviewed) throw new Error('Customer not found.');
  // KYC is partner OPT-IN: the decision + audit above stand regardless; the gated,
  // fail-soft customer notice is shared with the /partner decision (lib/kyc-notify.ts).
  await notifyKycReviewDecision(customer, phone, decision);

  revalidatePath('/admin-dashboard/compliance');
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}

/**
 * Manually create a customer/client record from the admin dashboard.
 *
 * Follows the mandatory server-action security checklist:
 *  1. own auth gate (admins only);
 *  2. validate input (phone via the shared normalize/validate utils);
 *  3. collision check BEFORE write (saveCustomer is an unconditional SET, so an
 *     existing phone would be silently overwritten);
 *  4. identity is authoritative over the form for ownership — a partner-admin is
 *     pinned to their own partner; only a platform-admin may choose a partner.
 */
export async function createCustomerAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const { staff } = await requireScope();
  if (staff.role !== 'admin') throw new Error('Not authorized.');

  const normalized = normalizePhone(formData.get('phone'));
  if (!isValidPhone(normalized)) {
    throw new Error('Phone must be 10–15 digits, including country code.');
  }

  // Program-Fix 28 (compliance-04, second back door): creating a customer
  // ALREADY verified or grandfathered is a manual KYC decision — it needs the
  // same mandatory reason, validated before any read.
  const kycChoice = String(formData.get('kycStatus') ?? 'not_started');
  const kycStatus: KycStatus =
    kycChoice === 'verified'
      ? 'verified'
      : kycChoice === 'grandfathered'
        ? 'grandfathered'
        : 'not_started';
  const kycReason = kycStatus === 'not_started' ? null : requireStaffReason(formData.get('kycReason'));

  // Partner scope: partner-admin → own partner (identity authoritative, form ignored);
  // platform-admin → form choice, verified to exist.
  let partnerId: PartnerId = DEFAULT_PARTNER_ID;
  if (staff.partnerId) {
    partnerId = staff.partnerId;
  } else {
    const requested = String(formData.get('partnerId') ?? '').trim();
    if (requested && requested !== DEFAULT_PARTNER_ID) {
      const partner = await getPartnerStore().getPartner(requested);
      if (!partner) throw new Error('Selected partner not found.');
      partnerId = requested;
    }
  }
  // Fix pack 7 T27 (P25): a partner that decides KYC is created with KYC not started (no read
  // for not_started: the same statements as before).
  if (kycStatus !== 'not_started' && (await deciderOwner(partnerId)).decides) {
    throw new Error(PARTNER_CREATE_KYC_REFUSAL);
  }

  // Collision check is per (tenant, phone) since fix 1 — the same number may
  // legitimately exist under another partner.
  const cs = getCustomerStore(getStore());
  if (await cs.getCustomer(partnerId, normalized)) {
    throw new Error('A customer with that phone already exists.');
  }

  const picked = String(formData.get('senderCountry') ?? '').trim().toUpperCase();
  const senderCountry: CountryCode = VALID_COUNTRIES.has(picked as CountryCode)
    ? (picked as CountryCode)
    : countryForPhone(normalized) ?? DEFAULT_SENDER_COUNTRY;

  const fullName = String(formData.get('fullName') ?? '').trim() || undefined;
  const now = new Date().toISOString();

  const fresh = {
    senderPhone: normalized,
    firstSeenAt: now,
    kycStatus,
    kycVerifiedAt: kycStatus === 'verified' || kycStatus === 'grandfathered' ? now : undefined,
    fullName,
    senderCountry,
    partnerId,
    createdAt: now,
    updatedAt: now,
  };

  if (kycReason === null) {
    await cs.saveCustomer(fresh);
  } else {
    // The create and its kyc.manual_override.create row commit together; a
    // failed audit insert creates nothing. tx-bound handles only.
    const reviewer = reviewerDisplay(staff);
    await getDb().transaction(async (tx) => {
      await createCustomerStore(tx, getStore()).saveCustomer({ ...fresh, kycApprovedBy: reviewer, kycApprovedAt: now });
      await createAuditRepo(tx).record({
        partnerId,
        actor: staff.username,
        actorType: 'staff',
        action: 'kyc.manual_override.create',
        subjectId: auditSubjectId(partnerId, normalized),
        meta: { previousStatus: null, newStatus: kycStatus, reason: kycReason, source: 'manual', reviewerName: reviewer },
      });
    });
  }

  revalidatePath('/admin-dashboard/customers');
  redirect(customerDetailPath(partnerId, normalized));
}

/**
 * Program fix 16b: the audited PLATFORM-ADMIN raise (or clear) of one sender's
 * send limits. Server-action checklist, in order:
 *  1. requirePlatformAdmin() — partner-scoped staff and support are redirected
 *     with no read, no write and no audit row (a raise is platform governance);
 *  2. validateSendLimitInput — a missing reason throws BEFORE any read, like
 *     reviewKycAction; whole USD in [1, $10,000]; a future expiry only;
 *  3. the target is re-read from the posted (partnerId, phone): a missing row
 *     is "Customer not found." — the write is keyed on THAT row's own key, so a
 *     raise for (A, phone) can never touch (B, phone);
 *  4. ONE transaction: read the old value (FOR UPDATE), the single-column
 *     UPDATE, then the audit_events row (actor, old, new, reason, expiresAt).
 *     If the audit insert fails, the limit write rolls back.
 *     UI redesign M3-12 follow-up: when the row-locked previous value is a
 *     PARTNER-set entry and the posted caps + expiry are exactly its own (the
 *     admin re-saved the prefilled form), the transaction rolls back and the
 *     action returns: no write, no audit row, the partner keeps control. Any
 *     changed value (or Clear) takes the audited write as before. A partner-set
 *     entry whose setAt differs from the form's hidden expectedSetAt (the partner
 *     edited it after the page rendered) is refused, for a save and a clear.
 * Only the dollar caps move: sanctions, EDD and the tier gates are untouched
 * (send-limits.ts resolveEffectiveSendLimits).
 */
/** Thrown INSIDE the transaction on an unchanged re-save of a partner-set entry: rolls it back. */
class UnchangedPartnerEntry extends Error {
  constructor() {
    super('unchanged_partner_entry');
    this.name = 'UnchangedPartnerEntry';
  }
}

/** Thrown INSIDE the transaction when the partner changed its entry after the admin's page rendered. */
class StalePartnerEntry extends Error {
  constructor() {
    super('stale_partner_entry');
    this.name = 'StalePartnerEntry';
  }
}

export async function setCustomerSendLimitAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const validated = validateSendLimitInput({
    perTransferUsd: String(formData.get('perTransferUsd') ?? ''),
    t1DailyUsd: String(formData.get('t1DailyUsd') ?? ''),
    t0DailyUsd: '', // a customer override never carries T0 (the tier gate is never raised per customer)
    expiresAt: String(formData.get('expiresAt') ?? ''),
    reason: String(formData.get('reason') ?? ''),
    clear: formData.get('clear') === 'on',
  });
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');
  const partnerId = targetPartnerId(staff, formData); // platform staff MUST name the tenant
  const expectedSetAt = String(formData.get('expectedSetAt') ?? '');

  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer) throw new Error('Customer not found.');
  // Fix pack 5 (P23, T24): a per-transfer cap above $2,999 needs the sender's address on file
  // when the customer's OWNER is on a real-money rail (a failed rail read counts as real money).
  // Checked before any write; a cap up to $2,999, a daily-only raise and a clear make no read.
  const perTransferCapCents = validated.value?.perTransferCapCents;
  if (perTransferCapCents !== undefined && perTransferCapCents > PLATFORM_SEND_LIMITS.perTransferCapCents) {
    const check = await ownerAddressCheck(getDb(), customer.partnerId, customer.senderPhone);
    if (limitRaiseNeedsAddress({ perTransferCapCents, ...check })) throw new Error(LIMIT_NEEDS_ADDRESS_COPY);
  }

  const nowIso = new Date().toISOString();
  // UI redesign M3-12: setScope 'platform' marks a SmartRemit decision, which a partner admin can
  // never overwrite or clear while it is live (an entry without it is treated the same way).
  const value =
    validated.value === null ? null : { ...validated.value, setBy: staff.username, setAt: nowIso, setScope: 'platform' as const };
  try {
    await getDb().transaction(async (tx) => {
      // tx-bound repos ONLY inside the transaction (a root-handle call here would
      // deadlock PGlite's single connection / hold a second Neon pool connection).
      const { found, previous } = await createCustomerStore(tx, getStore()).setSendLimitOverride(
        customer.partnerId, customer.senderPhone, value,
      );
      if (!found) throw new Error('Customer not found.'); // raced a delete ⇒ nothing written
      // Checked against the value read FOR UPDATE, so a concurrent partner edit is never missed.
      // Stale-form guard: the card posts the partner entry's setAt it rendered ('' when none); a
      // partner-set entry that no longer matches it is refused for a save AND a clear.
      if (previous?.setScope === 'partner' && (typeof previous.setAt === 'string' ? previous.setAt : '') !== expectedSetAt) {
        throw new StalePartnerEntry(); // same normalization as the card's hidden field
      }
      if (isUnchangedPartnerSetEntry(previous, validated.value)) throw new UnchangedPartnerEntry();
      await createAuditRepo(tx).record({
        partnerId: customer.partnerId,
        actor: staff.username,
        actorType: 'staff',
        action: value === null ? 'send_limits.clear' : 'send_limits.set',
        subjectId: customer.senderPhone,
        meta: { scope: 'customer', old: previous, new: value, reason: validated.reason, expiresAt: validated.expiresAt ?? null },
      });
    });
  } catch (err) {
    if (err instanceof StalePartnerEntry) {
      throw new Error('The partner changed this limit since you opened the page. Reload and try again.');
    }
    if (!(err instanceof UnchangedPartnerEntry)) throw err;
    // Rolled back: nothing written, nothing audited. The page still re-renders the current state.
  }
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}

/** Thrown INSIDE the transaction when the locked row has no active screening hold (nothing written). */
class NoScreeningHold extends Error {
  constructor() {
    super('This customer has no active screening hold.');
    this.name = 'NoScreeningHold';
  }
}

/**
 * Pack 2 review R3 (H1 a): thrown INSIDE the transaction when the locked row's
 * screening_flagged_at is not the one the clearing admin's page showed (a newer
 * match landed, or the form predates the field). The rollback writes nothing.
 */
class ScreeningChanged extends Error {
  constructor() {
    super('The screening for this customer changed since this page loaded. Reload the page and review it again.');
    this.name = 'ScreeningChanged';
  }
}

/** The posted reviewed flag time, normalised to an ISO string ('' for none); null ⇒ missing or unreadable. */
function reviewedFlaggedAt(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v === '') return '';
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Fix pack 2 T6 (R06): clear a sender's screening hold (a Persona watchlist /
 * PEP hit, or a stamped flaggedAt) — SmartRemit platform admins only, for a
 * customer in any kycStatus and under either kycMode (sanctions are never
 * delegated). Server-action checklist, in order:
 *  1. refuseOnSiteHost + requirePlatformAdmin (partner, support and agent staff are redirected);
 *  2. a typed reason (requireStaffReason), BEFORE any read;
 *  3. the phone and the named tenant (targetPartnerId), then the row must exist and hold;
 *  4. ONE transaction: clearScreeningHold (FOR UPDATE), the hold re-checked on
 *     the LOCKED value, and the customer.screening_hold.clear audit row (subject
 *     auditSubjectId, never the raw phone). A failed audit rolls the clear back.
 *     Pack 2 review R3 (H1): the locked flag time must equal the one the page
 *     showed (posted screeningFlaggedAt), else ScreeningChanged and nothing is
 *     written; the clear time is taken after the lock (customer-repo).
 * The Persona flags stay as evidence; the clear time lifts the hold until a
 * later match stamps a new flag. It does NOT release any held transfer: staff
 * release those afterwards (dashboard-ops.ts releaseTransfer).
 */
export async function clearSenderScreeningHoldAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const reason = requireStaffReason(formData.get('reason'));
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');
  const partnerId = targetPartnerId(staff, formData); // platform staff MUST name the tenant
  const reviewed = reviewedFlaggedAt(formData.get('screeningFlaggedAt'));

  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer) throw new Error('Customer not found.');
  if (!senderScreeningHoldActive(customer)) throw new NoScreeningHold();
  // Fix pack 7 T27 (P25): a PEP-only sender hold of a partner that decides KYC is the partner's
  // to decide. The flags come from readSenderScreeningFlags (R2: the Customer object lacks the
  // watchlist stamp); a watchlist or stamp-only flag stays SmartRemit's. Re-checked on the
  // locked row below. Any other tenant: no new read.
  const { decides } = await deciderOwner(customer.partnerId);
  if (decides) {
    const flags = await readSenderScreeningFlags(getDb(), customer.partnerId, customer.senderPhone);
    if (senderPepOnly(flags) && senderScreeningHoldActive(flags)) throw new Error(PARTNER_PEP_CLEAR_REFUSAL);
  }

  await getDb().transaction(async (tx) => {
    // tx-bound repos ONLY inside the transaction (a root-handle call here would
    // deadlock PGlite's single connection / hold a second Neon pool connection).
    if (decides) {
      // T27: the PEP-only test again on the row locked FOR UPDATE (before the clear writes it).
      const locked = await readSenderScreeningFlags(tx, customer.partnerId, customer.senderPhone, { forUpdate: true });
      if (senderPepOnly(locked) && senderScreeningHoldActive(locked)) throw new Error(PARTNER_PEP_CLEAR_REFUSAL);
    }
    const { found, previous } = await createCustomerStore(tx, getStore()).clearScreeningHold(
      customer.partnerId, customer.senderPhone,
    );
    if (!found) throw new Error('Customer not found.'); // raced a delete ⇒ nothing written
    // Re-checked on the value read FOR UPDATE: a concurrent clear is never doubled.
    if (!senderScreeningHoldActive(previous)) throw new NoScreeningHold();
    // Pack 2 review R3 (H1 a): only the match the admin reviewed is cleared.
    const locked = previous?.screeningFlaggedAt ? previous.screeningFlaggedAt.toISOString() : '';
    if (reviewed === null || reviewed !== locked) throw new ScreeningChanged();
    await createAuditRepo(tx).record({
      partnerId: customer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'customer.screening_hold.clear',
      subjectId: auditSubjectId(customer.partnerId, customer.senderPhone),
      meta: {
        reason,
        flaggedAt: previous?.screeningFlaggedAt ? previous.screeningFlaggedAt.toISOString() : null,
        previousClearedAt: previous?.screeningClearedAt ? previous.screeningClearedAt.toISOString() : null,
        pepHit: previous?.pepHit ?? null,
        watchlistHit: previous?.watchlistHit ?? null,
        kycStatus: customer.kycStatus,
      },
    });
  });
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}

/**
 * Fix pack 7 T27 (P25): SmartRemit's RECOMMENDATION on the KYC of a customer of a partner that
 * decides KYC (partnerDecidesKyc). The partner decides; this records what SmartRemit recommends.
 * Server-action checklist, in order:
 *  1. refuseOnSiteHost + requireAdmin; platform scope only (partner-scoped staff decide in their
 *     own workspace: PARTNER_WORKSPACE_KYC_REFUSAL);
 *  2. the phone and the named tenant (targetPartnerId), the customer read + canSee ('Customer not
 *     found.');
 *  3. the owner read (deciderOwner: a failed or empty read refuses) must decide KYC, else
 *     KYC_RECOMMENDATION_ONLY_REFUSAL;
 *  4. recommendation approve | reject, else 'Invalid recommendation.'; the reason passes the P7
 *     rule (parseHoldReason: 10-500 characters, no long digit run), else HOLD_REASON_REFUSAL;
 *  5. ONE audit_events row `kyc.recommend` (keyed subject, meta { recommendation, reason }).
 * No customer write, no notify, no outbox row.
 */
export async function recordKycRecommendationAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  if (scopeOf(staff).kind !== 'platform') throw new Error(PARTNER_WORKSPACE_KYC_REFUSAL);
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');
  const partnerId = targetPartnerId(staff, formData);
  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) throw new Error('Customer not found.');
  if (!(await deciderOwner(customer.partnerId)).decides) throw new Error(KYC_RECOMMENDATION_ONLY_REFUSAL);
  const recommendation = String(formData.get('recommendation') ?? '');
  if (recommendation !== 'approve' && recommendation !== 'reject') throw new Error(KYC_RECOMMENDATION_INVALID);
  const parsed = parseHoldReason(formData.get('reason'));
  if (!parsed.ok) throw new Error(HOLD_REASON_REFUSAL);
  await createAuditRepo(getDb()).record({
    partnerId: customer.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'kyc.recommend',
    subjectId: auditSubjectId(customer.partnerId, customer.senderPhone),
    meta: { recommendation, reason: parsed.reason },
  });
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}
