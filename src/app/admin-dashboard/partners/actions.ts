'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requirePlatformAdmin } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { hashPassword } from '@/lib/password';
import { newTransferId } from '@/lib/id';
import { randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import type { Partner, PartnerStatus, PartnerId, StaffRole, KycMode } from '@/lib/types';

// Write-only secret merge: a blank form field means "leave the stored secret
// unchanged" (secrets are never rendered back, so blank ≠ delete).
function keepOrUpdate(submitted: string, existing: string | undefined): string | undefined {
  const v = submitted.trim();
  return v !== '' ? v : existing;
}

// Shared gate for every partner-config action: admin role + same-partner scope
// (a partner-admin configures only their OWN partner; a platform admin any).
async function gatePartnerConfig(id: string): Promise<void> {
  const staff = await requireAdmin();
  if (!id) throw new Error('Partner id is required.');
  const partner = await getPartnerStore().getPartner(id);
  if (!partner || !canSee(scopeOf(staff), id)) throw new Error('Partner not found.');
}

export async function createPartnerAction(formData: FormData): Promise<void> {
  // M5: creating a tenant is platform governance — partner-admins must not reach it.
  await requirePlatformAdmin();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('Partner name is required.');

  const countries = formData.getAll('countries').map(String) as Partner['countries'];
  if (countries.length === 0) throw new Error('At least one country is required.');

  const id = newTransferId();
  const now = new Date().toISOString();
  const partner: Partner = {
    id,
    name,
    countries,
    status: 'active',
    brandName: String(formData.get('brandName') ?? '').trim() || undefined,
    displayName: String(formData.get('displayName') ?? '').trim() || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || undefined,
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await getPartnerStore().savePartner(partner);
  revalidatePath('/admin-dashboard/partners');
  redirect(`/admin-dashboard/partners/${id}`);
}

export async function updatePartnerAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Partner id is required.');

  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  // M4: a partner-admin may edit only their OWN partner's branding; a platform
  // admin may edit any. Generic message — don't disclose out-of-scope partners.
  if (!existing || !canSee(scopeOf(staff), id)) throw new Error('Partner not found.');

  const submittedCountries = formData.getAll('countries').map(String) as Partner['countries'];
  // WL: KYC posture. 'delegated' = the partner runs KYC on their side, so our
  // verify-gate steps aside (sanctions still always run). Absent/anything-else ⇒
  // 'ours' (default, full SmartRemit KYC). requireKycBeforeSend only matters when
  // delegated (resolveKycMode forces it true under 'ours' regardless).
  const kycMode: KycMode = formData.get('kycMode') === 'delegated' ? 'delegated' : 'ours';
  const updated: Partner = {
    ...existing,
    name: String(formData.get('name') ?? existing.name).trim() || existing.name,
    countries: submittedCountries.length > 0 ? submittedCountries : existing.countries,
    brandName: String(formData.get('brandName') ?? '').trim() || undefined,
    displayName: String(formData.get('displayName') ?? '').trim() || undefined,
    supportContact: String(formData.get('supportContact') ?? '').trim() || undefined,
    botPersona: String(formData.get('botPersona') ?? '').trim() || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || undefined,
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    kycMode,
    requireKycBeforeSend: kycMode === 'delegated' ? formData.get('requireKycBeforeSend') === 'on' : undefined,
    updatedAt: new Date().toISOString(),
  };
  await ps.savePartner(updated);
  revalidatePath('/admin-dashboard/partners');
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

export async function setPartnerStatusAction(formData: FormData): Promise<void> {
  // M4: suspend/reactivate is platform governance (a tenant shouldn't suspend
  // itself, and a partner-admin must not suspend a rival). Platform-admin only.
  await requirePlatformAdmin();
  const id = String(formData.get('id') ?? '').trim();
  const status = String(formData.get('status') ?? '') as PartnerStatus;
  if (status !== 'active' && status !== 'suspended') {
    throw new Error('Status must be active or suspended.');
  }
  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.');
  await ps.savePartner({ ...existing, status, updatedAt: new Date().toISOString() });
  if (status === 'suspended') {
    const authStore = getAuthStore();
    const all = await authStore.listStaff();
    const affected = all.filter((s) => s.partnerId === id);
    for (const s of affected) await authStore.deleteAllSessionsFor(s.username);
  }
  revalidatePath('/admin-dashboard/partners');
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

export async function createPartnerStaffAction(
  partnerId: PartnerId,
  formData: FormData,
): Promise<void> {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'agent') as StaffRole;
  if (role !== 'admin' && role !== 'agent') throw new Error('Invalid role.');
  if (!username || !name || !password) throw new Error('username, name, and password are required.');

  // Validate partner exists — server actions are POST endpoints callable with
  // any bound partnerId, so the JSX `bind(null, partner.id)` is not a
  // sufficient guard against direct invocation.
  const partner = await getPartnerStore().getPartner(partnerId);
  if (!partner) throw new Error('Partner not found.');

  // Reject username collision. saveStaff would silently overwrite — and the
  // existing reverse-index of sessions for the clobbered username would then
  // resolve to a record now bound to a different partner. addStaffAction in
  // /admin-dashboard/team/actions.ts has the same guard for the same reason.
  const authStore = getAuthStore();
  if (await authStore.getStaff(username)) {
    throw new Error('That username already exists.');
  }

  await authStore.saveStaff({
    username,
    name,
    role,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
    partnerId,                  // taken from URL, not form
  });
  revalidatePath(`/admin-dashboard/partners/${partnerId}`);
}

export async function removePartnerStaffAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  if (!username) throw new Error('username is required.');
  const authStore = getAuthStore();
  const staff = await authStore.getStaff(username);
  if (!staff) return;
  // M3: this is the PARTNER-staff endpoint. Refuse to delete a platform account
  // here — the dedicated team/actions guard protects platform admins, and this
  // twin must not be a bypass. Platform staff are managed from the Team page.
  if (!staff.partnerId) {
    throw new Error('Use the Team page to manage platform staff.');
  }
  await authStore.deleteStaff(username);
  await authStore.deleteAllSessionsFor(username);
  revalidatePath(`/admin-dashboard/partners/${staff.partnerId}`);
}

// ── WL self-service: WhatsApp / settlement / API-key configuration ──────────
// Secrets are write-only (blank ⇒ keep existing) and envelope-encrypted inside
// the integrations store. Non-secret routing data (phoneNumberId, providerType)
// is stored in the clear and may be shown back in the form.

export async function saveWhatsappConfigAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  await gatePartnerConfig(id);
  const store = getPartnerIntegrationsStore();
  const existing = await store.getIntegrations(id);
  const newPnid = String(formData.get('phoneNumberId') ?? '').trim();
  await store.saveIntegrations(id, {
    ...existing,
    whatsapp: {
      phoneNumberId: newPnid || undefined,
      token: keepOrUpdate(String(formData.get('token') ?? ''), existing.whatsapp.token),
      verifyToken: keepOrUpdate(String(formData.get('verifyToken') ?? ''), existing.whatsapp.verifyToken),
      appSecret: keepOrUpdate(String(formData.get('appSecret') ?? ''), existing.whatsapp.appSecret),
    },
  });
  // No separate reverse index to maintain anymore — inbound routing resolves
  // the partner straight off the integrations row (partnerForPhoneNumberId).
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

export async function savePaymentConfigAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  await gatePartnerConfig(id);
  const store = getPartnerIntegrationsStore();
  const existing = await store.getIntegrations(id);
  const providerType = String(formData.get('providerType') ?? '').trim() || undefined;
  // Spread-merge so fields this form doesn't manage are never silently wiped.
  const credentials: Record<string, string> = { ...existing.payment.credentials };
  const settlementUrl = keepOrUpdate(String(formData.get('settlementUrl') ?? ''), credentials.settlementUrl);
  const signingSecret = keepOrUpdate(String(formData.get('signingSecret') ?? ''), credentials.signingSecret);
  if (settlementUrl) credentials.settlementUrl = settlementUrl;
  if (signingSecret) credentials.signingSecret = signingSecret;
  let webhookSecret = keepOrUpdate(String(formData.get('webhookSecret') ?? ''), existing.payment.webhookSecret);

  // Zero-hassle simulator: selecting the hosted reference rail auto-provisions the
  // endpoint URL and both HMAC secrets so the partner pastes NOTHING. The reference
  // rail exercises the exact signed instruction→callback loop a real rail would.
  if (providerType === 'simulator') {
    if (!credentials.settlementUrl) credentials.settlementUrl = `${env.appBaseUrl}/api/partner-rail`;
    if (!credentials.signingSecret) credentials.signingSecret = randomBytes(32).toString('hex');
    if (!webhookSecret) webhookSecret = randomBytes(32).toString('hex');
  }

  await store.saveIntegrations(id, {
    ...existing,
    payment: {
      providerType,
      credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
      webhookSecret,
    },
  });
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

/** Issue a new API key. Returns the plaintext ONCE — the client surfaces it then discards it. */
export async function issueApiKeyAction(
  partnerId: PartnerId,
): Promise<{ plaintext: string; keyId: string; last4: string }> {
  await gatePartnerConfig(partnerId);
  const issued = await getPartnerApiKeyStore().issue(partnerId);
  revalidatePath(`/admin-dashboard/partners/${partnerId}`);
  return { plaintext: issued.plaintext, keyId: issued.keyId, last4: issued.last4 };
}

export async function revokeApiKeyAction(partnerId: PartnerId, formData: FormData): Promise<void> {
  await gatePartnerConfig(partnerId);
  const keyId = String(formData.get('keyId') ?? '').trim();
  if (!keyId) throw new Error('keyId is required.');
  // Cross-tenant guard: the key must belong to THIS partner before we revoke it.
  const keys = await getPartnerApiKeyStore().list(partnerId);
  if (!keys.some((k) => k.keyId === keyId)) throw new Error('Key not found.');
  await getPartnerApiKeyStore().revoke(keyId);
  revalidatePath(`/admin-dashboard/partners/${partnerId}`);
}
