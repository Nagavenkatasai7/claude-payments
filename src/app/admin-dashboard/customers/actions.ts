'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requirePlatformAdmin, requireScope } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { createCustomerStore, getCustomerStore } from '@/lib/customer-store';
import { validateSendLimitInput, requireStaffReason } from '@/lib/send-limits';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { sendVerificationStatus } from '@/lib/whatsapp';
import { getPartnerStore } from '@/lib/partner-store';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { countryForPhone } from '@/lib/partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import { createScopedStore } from '@/lib/scoped-store';
import { sealCustomerRef, auditSubjectId } from '@/lib/customer-ref';
import type { CountryCode, KycStatus, PartnerId, Staff } from '@/lib/types';

const VALID_COUNTRIES = new Set<CountryCode>(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);

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
  if (decision === 'approve' && (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered')) {
    throw new Error('Customer is already verified.');
  }
  if (decision === 'reject' && customer.kycStatus === 'rejected') {
    throw new Error('Customer is already rejected.');
  }

  const updated = await getKycCaseStore(getStore()).review(
    customer.partnerId, customer.senderPhone, decision, reviewerDisplay(staff), reason,
    { db: getDb(), store: getStore(), actor: staff.username, slug: `kyc.manual_override.${decision}`, source: 'manual' },
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

  // Attribute the reviewer by display name + stable username, e.g. "Main Admin (forextransfer)".
  // Program-Fix 28: durable — the decision and its kyc.review.<decision>
  // audit_events row commit together (actor = username, keyed subject).
  const reviewed = await getKycCaseStore(getStore()).review(
    partnerId, phone, decision, reviewerDisplay(staff), reason,
    { db: getDb(), store: getStore(), actor: staff.username, slug: `kyc.review.${decision}`, source: 'persona_review' },
  );
  if (!reviewed) throw new Error('Customer not found.');
  // KYC is partner OPT-IN: the decision + audit above stand regardless, but the
  // customer-facing WhatsApp notify only fires when the partner's
  // verify-before-send gate is ON. Fail-soft — a notify hiccup never voids the review.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  if (sendGateActive(partner)) {
    await sendVerificationStatus(phone, decision === 'approve' ? 'verified' : 'failed', customer.fullName).catch(
      () => {},
    );
  }

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
 * Only the dollar caps move: sanctions, EDD and the tier gates are untouched
 * (send-limits.ts resolveEffectiveSendLimits).
 */
export async function setCustomerSendLimitAction(formData: FormData): Promise<void> {
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

  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer) throw new Error('Customer not found.');

  const nowIso = new Date().toISOString();
  const value = validated.value === null ? null : { ...validated.value, setBy: staff.username, setAt: nowIso };
  await getDb().transaction(async (tx) => {
    // tx-bound repos ONLY inside the transaction (a root-handle call here would
    // deadlock PGlite's single connection / hold a second Neon pool connection).
    const { found, previous } = await createCustomerStore(tx, getStore()).setSendLimitOverride(
      customer.partnerId, customer.senderPhone, value,
    );
    if (!found) throw new Error('Customer not found.'); // raced a delete ⇒ nothing written
    await createAuditRepo(tx).record({
      partnerId: customer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: value === null ? 'send_limits.clear' : 'send_limits.set',
      subjectId: customer.senderPhone,
      meta: { scope: 'customer', old: previous, new: value, reason: validated.reason, expiresAt: validated.expiresAt ?? null },
    });
  });
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}
