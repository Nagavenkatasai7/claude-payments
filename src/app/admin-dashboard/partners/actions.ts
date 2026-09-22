'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requirePlatformAdmin } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { validateSendLimitInput } from '@/lib/send-limits';
import { createPartnerStore, getPartnerStore } from '@/lib/partner-store';
import { getAuthStore } from '@/lib/auth-store';
import {
  createPartnerIntegrationsStore,
  getPartnerIntegrationsStore,
  partnerForPhoneNumberId,
} from '@/lib/partner-integrations-store';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { hashPassword } from '@/lib/password';
import { newTransferId } from '@/lib/id';
import { sanitizeLogoValue } from '@/lib/logo';
import { boundUntrustedText, BRAND_MAX, PERSONA_MAX } from '@/lib/untrusted-text';
import { randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import { checkSettlementUrl } from '@/lib/settlement-url';
import type {
  Partner,
  PartnerStatus,
  PartnerId,
  PartnerSupportConfig,
  StaffRole,
  KycMode,
  CurrencyCode,
} from '@/lib/types';
import { DEFAULT_CURRENCY_FOR_COUNTRY, SUPPORT_DEFAULT_PERMISSIONS } from '@/lib/types';

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
  // PLATFORM-GOVERNED (owner decision 2026-09-16): kycMode decides whether a
  // partner-scoped admin may release a compliance hold (canReleaseHeld), so a
  // partner admin must not be able to flip it (or the send gate) for their own
  // tenant — their submitted values are ignored and the stored posture kept.
  const isPlatform = scopeOf(staff).kind === 'platform';
  const kycMode: KycMode = isPlatform
    ? (formData.get('kycMode') === 'delegated' ? 'delegated' : 'ours')
    : (existing.kycMode ?? 'ours');
  const requireKycBeforeSend = isPlatform
    ? formData.get('requireKycBeforeSend') === 'on' // OPT-IN gate, either mode
    : existing.requireKycBeforeSend;
  // fix 5 (F43): brand text is interpolated into the bot's SYSTEM prompt and a
  // partner-scoped admin can set it for their own tenant — strip control
  // characters, line separators and []{}<> and cap it (60 / 500). Stripped, not
  // refused, so an existing value still saves. buildSystemPrompt clamps again at
  // read for pre-fix rows.
  const updated: Partner = {
    ...existing,
    name: String(formData.get('name') ?? existing.name).trim() || existing.name,
    countries: submittedCountries.length > 0 ? submittedCountries : existing.countries,
    brandName: boundUntrustedText(formData.get('brandName'), BRAND_MAX) || undefined,
    displayName: boundUntrustedText(formData.get('displayName'), BRAND_MAX) || undefined,
    supportContact: String(formData.get('supportContact') ?? '').trim() || undefined,
    botPersona: boundUntrustedText(formData.get('botPersona'), PERSONA_MAX) || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: sanitizeLogoValue(formData.get('logoUrl')),
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    kycMode,
    requireKycBeforeSend,
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
  if (role !== 'admin' && role !== 'agent' && role !== 'support') throw new Error('Invalid role.');
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
    // Partner staff start with no money permissions in ANY role; support staff
    // structurally never get them (mirrors team/actions.ts).
    permissions:
      role === 'support'
        ? { ...SUPPORT_DEFAULT_PERMISSIONS }
        : { canCancel: false, canResend: false, canAssign: false },
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

/**
 * D11 (fix 1): a WhatsApp phone_number_id routes inbound traffic to ONE tenant,
 * so it is REFUSED when it is the platform's own number or already held by a
 * different partner. One generic message for both cases — the refusal must not
 * tell a partner who holds a number. The partial unique index
 * partner_integrations_wa_pnid is the race-proof last line.
 */
async function assertPhoneNumberIdFree(partnerId: string, pnid: string | undefined): Promise<void> {
  if (!pnid) return;
  const holder = await partnerForPhoneNumberId(pnid);
  if (pnid === env.whatsappPhoneNumberId || (holder && holder !== partnerId)) {
    throw new Error('That WhatsApp number cannot be used.');
  }
}

/** Same generic refusal when the partial unique index loses a race (SQLSTATE 23505). */
function rethrowPnidConflict(e: unknown): never {
  // The partial unique index partner_integrations_wa_pnid is the race-proof
  // last line (two admins saving the same number at once). SAME generic
  // message as assertPhoneNumberIdFree — never who holds it, never "race".
  // drizzle wraps the driver error (DrizzleQueryError.cause — node_modules/drizzle-orm/errors.js).
  const err = e as { code?: string; cause?: { code?: string } } | null;
  if (err?.code === '23505' || err?.cause?.code === '23505') throw new Error('That WhatsApp number cannot be used.');
  throw e;
}

export async function saveWhatsappConfigAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  await gatePartnerConfig(id);
  const store = getPartnerIntegrationsStore();
  const existing = await store.getIntegrations(id);
  const newPnid = String(formData.get('phoneNumberId') ?? '').trim();
  await assertPhoneNumberIdFree(id, newPnid || undefined);
  try {
    await store.saveIntegrations(id, {
      ...existing,
      whatsapp: {
        phoneNumberId: newPnid || undefined,
        token: keepOrUpdate(String(formData.get('token') ?? ''), existing.whatsapp.token),
        verifyToken: keepOrUpdate(String(formData.get('verifyToken') ?? ''), existing.whatsapp.verifyToken),
        appSecret: keepOrUpdate(String(formData.get('appSecret') ?? ''), existing.whatsapp.appSecret),
      },
    });
  } catch (e) {
    rethrowPnidConflict(e);
  }
  // No separate reverse index to maintain anymore — inbound routing resolves
  // the partner straight off the integrations row (partnerForPhoneNumberId).
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

/**
 * Fix 22: the same settlement-URL rule the worker applies before any fetch
 * (checkSettlementUrl) runs BEFORE any write. A webhook-driven rail (`http`
 * / `simulator`) must have a passing endpoint — the caller passes the
 * EFFECTIVE value (submitted, else kept, else the simulator default), so a bad
 * stored value can never be silently kept. For `mock` / no provider the
 * caller passes only a SUBMITTED value: not required, but still checked.
 * The message is generic: never the reason, never the URL.
 */
function assertSettlementUrlAllowed(url: string | undefined, providerType: string | undefined): void {
  const required = providerType === 'http' || providerType === 'simulator';
  if (!url) {
    if (required) throw new Error('Settlement endpoint must be a public https:// URL.');
    return;
  }
  const check = checkSettlementUrl(url, { appOrigin: env.appBaseUrl, production: env.isProduction });
  if (!check.ok) throw new Error('Settlement endpoint must be a public https:// URL.');
}

export async function savePaymentConfigAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  await gatePartnerConfig(id);
  const store = getPartnerIntegrationsStore();
  const existing = await store.getIntegrations(id);
  const providerType = String(formData.get('providerType') ?? '').trim() || undefined;
  // Spread-merge so fields this form doesn't manage are never silently wiped.
  const credentials: Record<string, string> = { ...existing.payment.credentials };
  const submittedSettlementUrl = String(formData.get('settlementUrl') ?? '').trim();
  const settlementUrl = keepOrUpdate(submittedSettlementUrl, credentials.settlementUrl);
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
  // Fix 22: webhook-driven rails check the EFFECTIVE URL; others only a submitted one.
  const isWebhookDriven = providerType === 'http' || providerType === 'simulator';
  assertSettlementUrlAllowed(isWebhookDriven ? credentials.settlementUrl : submittedSettlementUrl || undefined, providerType);

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

// ── Pricing: admin-set corridor margin (best-rate selection) ─────────────────
// The admin owns ONLY marginBps. The pushed fields (effectiveRate / expiresAt /
// pushedAt) belong to the partner's rate push — this action passes them as
// undefined so the repo's merge semantics NEVER clobber a pushed rate. An empty
// margin field is an explicit null ⇒ clears the stored margin.

const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_CURRENCY_FOR_COUNTRY),
);

function parseCurrency(v: unknown): CurrencyCode {
  const s = String(v ?? '').trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(s)) throw new Error(`Unsupported currency: ${s || '(empty)'}.`);
  return s as CurrencyCode;
}

export async function savePricingAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  await gatePartnerConfig(id);

  const sourceCurrency = parseCurrency(formData.get('sourceCurrency'));
  const destinationCurrency = parseCurrency(formData.get('destinationCurrency'));
  if (sourceCurrency === destinationCurrency) {
    throw new Error('Source and destination currencies must differ.');
  }

  const raw = String(formData.get('marginBps') ?? '').trim();
  let marginBps: number | null = null; // empty input ⇒ explicit null ⇒ clear
  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || Math.abs(n) > 10_000) {
      throw new Error('Margin must be an integer between -10000 and 10000 basis points.');
    }
    marginBps = n;
  }

  await createPartnerRateRepo(getDb()).upsertRate({
    id: newTransferId(),
    partnerId: id, // route-bound id is authoritative (gated above)
    sourceCurrency,
    destinationCurrency,
    marginBps,
    // effectiveRate / expiresAt / pushedAt deliberately omitted (undefined ⇒
    // keep) so a partner's pushed rate survives an admin margin save.
  });
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

// ── Send limits: the audited PLATFORM-ADMIN partner default (Program fix 16b) ──
// NOT gatePartnerConfig (which admits partner admins): a raise is platform
// governance, like setPartnerStatusAction. Same steps as the customer action:
// gate → validate (reason first) → re-read the target → ONE transaction with the
// single-column UPDATE + the audit row (old, new, actor, reason, expiresAt).
// The partner shape also carries T0, tighten-only (<= the platform $500).

export async function setPartnerSendLimitAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformAdmin();
  const validated = validateSendLimitInput(
    {
      perTransferUsd: String(formData.get('perTransferUsd') ?? ''),
      t1DailyUsd: String(formData.get('t1DailyUsd') ?? ''),
      t0DailyUsd: String(formData.get('t0DailyUsd') ?? ''),
      expiresAt: String(formData.get('expiresAt') ?? ''),
      reason: String(formData.get('reason') ?? ''),
      clear: formData.get('clear') === 'on',
    },
    new Date(),
    { allowT0: true },
  );
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Partner id is required.');
  const existing = await getPartnerStore().getPartner(id);
  if (!existing) throw new Error('Partner not found.');

  const nowIso = new Date().toISOString();
  const value = validated.value === null ? null : { ...validated.value, setBy: staff.username, setAt: nowIso };
  await getDb().transaction(async (tx) => {
    // tx-bound repos ONLY inside the transaction (see the customer action).
    const { found, previous } = await createPartnerStore(tx).setSendLimits(existing.id, value);
    if (!found) throw new Error('Partner not found.'); // raced a delete ⇒ nothing written
    await createAuditRepo(tx).record({
      partnerId: existing.id,
      actor: staff.username,
      actorType: 'staff',
      action: value === null ? 'send_limits.clear' : 'send_limits.set',
      subjectId: existing.id,
      meta: { scope: 'partner', old: previous, new: value, reason: validated.reason, expiresAt: validated.expiresAt ?? null },
    });
  });
  revalidatePath('/admin-dashboard/partners');
  revalidatePath(`/admin-dashboard/partners/${existing.id}`);
}

// ── Support: admin-controlled support behavior (PartnerSupportConfig) ───────
// Stored on the partner row (same opt-in pattern as requireKycBeforeSend).
// enableSupportPortal defaults to TRUE when absent, so the checkbox writes an
// explicit boolean either way; autoAssign falls back to 'none' on any
// unexpected value. Internal tickets/supportConfig never reach customer
// surfaces — this is a dashboard-only knob.

export async function saveSupportConfigAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  await gatePartnerConfig(id);

  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.'); // gate raced a delete

  const supportConfig: PartnerSupportConfig = {
    enableSupportPortal: formData.get('enableSupportPortal') === 'on',
    autoAssign: formData.get('autoAssign') === 'round_robin' ? 'round_robin' : 'none',
  };
  await ps.savePartner({
    ...existing,
    supportConfig,
    updatedAt: new Date().toISOString(),
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

// ── Stage 5c: the partner SETUP WIZARD's single commit ───────────────────────
// The wizard collects everything client-side and commits ONCE: partner record
// → integrations (WhatsApp + settlement, simulator auto-provisioned) → first
// API key. Self-gated (public POST endpoint): platform-admin only — tenant
// creation is platform governance. Returns everything the "done" screen needs;
// the API-key plaintext appears ONLY in this return value, never at rest.

const WIZARD_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);

export interface PartnerWizardInput {
  name: string;
  countries: string[];
  displayName?: string;
  brandName?: string;
  primaryColor?: string;
  logoUrl?: string;
  supportContact?: string;
  botPersona?: string;
  kycMode?: string;
  requireKycBeforeSend?: boolean;
  whatsapp?: { phoneNumberId?: string; token?: string; verifyToken?: string; appSecret?: string };
  payment?: { providerType?: string; settlementUrl?: string; signingSecret?: string; webhookSecret?: string };
}

export interface PartnerWizardResult {
  id: string;
  apiKey: string; // shown once by the wizard, then discarded
  apiKeyLast4: string;
  whatsappCallbackUrl: string;
  statusCallbackUrl: string;
  apiBaseUrl: string;
  whatsappConfigured: boolean;
  settlementConfigured: boolean;
}

const clean = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
};

export async function wizardCreatePartnerAction(
  input: PartnerWizardInput,
): Promise<PartnerWizardResult> {
  await requirePlatformAdmin();

  const name = clean(input.name);
  if (!name) throw new Error('Partner name is required.');
  const countries = (Array.isArray(input.countries) ? input.countries : [])
    .map(String)
    .filter((c) => WIZARD_COUNTRIES.has(c)) as Partner['countries'];
  if (countries.length === 0) throw new Error('At least one country is required.');
  const kycMode: KycMode = input.kycMode === 'delegated' ? 'delegated' : 'ours';

  const id = newTransferId();
  const now = new Date().toISOString();
  const partner: Partner = {
    id,
    name,
    countries,
    status: 'active',
    // fix 5 (F43): the same save-side clamp as updatePartnerAction.
    brandName: boundUntrustedText(input.brandName, BRAND_MAX) || undefined,
    displayName: boundUntrustedText(input.displayName, BRAND_MAX) || undefined,
    supportContact: clean(input.supportContact),
    botPersona: boundUntrustedText(input.botPersona, PERSONA_MAX) || undefined,
    primaryColor: clean(input.primaryColor),
    logoUrl: sanitizeLogoValue(input.logoUrl),
    kycMode,
    requireKycBeforeSend: input.requireKycBeforeSend === true, // OPT-IN gate, either mode
    createdAt: now,
    updatedAt: now,
  };
  // D11 (fix 1): refuse a taken/platform WhatsApp number BEFORE any write, so a
  // refusal never leaves an orphan active partner behind.
  await assertPhoneNumberIdFree(id, clean((input.whatsapp ?? {}).phoneNumberId));

  // Integrations — only persisted when the wizard actually captured something.
  const wa = input.whatsapp ?? {};
  const pay = input.payment ?? {};
  const providerType = ['mock', 'simulator', 'http'].includes(pay.providerType ?? '')
    ? pay.providerType
    : undefined;
  const credentials: Record<string, string> = {};
  const settlementUrl = clean(pay.settlementUrl);
  const signingSecret = clean(pay.signingSecret);
  if (settlementUrl) credentials.settlementUrl = settlementUrl;
  if (signingSecret) credentials.signingSecret = signingSecret;
  let webhookSecret = clean(pay.webhookSecret);
  if (providerType === 'simulator') {
    // Zero-hassle reference rail: auto-provision endpoint + both HMAC secrets.
    if (!credentials.settlementUrl) credentials.settlementUrl = `${env.appBaseUrl}/api/partner-rail`;
    if (!credentials.signingSecret) credentials.signingSecret = randomBytes(32).toString('hex');
    if (!webhookSecret) webhookSecret = randomBytes(32).toString('hex');
  }
  // Fix 22: refuse an unsafe / missing endpoint BEFORE any write (beside the
  // pnid gate above), so a refusal never leaves an orphan partner behind.
  assertSettlementUrlAllowed(credentials.settlementUrl, providerType);
  const whatsappConfigured = Boolean(clean(wa.phoneNumberId) && clean(wa.token));
  const settlementConfigured = providerType === 'simulator' || Boolean(credentials.settlementUrl);
  // The partner row and its integrations commit in ONE transaction (fix 1
  // review): if the pnid unique index loses a race (23505), the partner insert
  // rolls back too — never an orphan ACTIVE partner with no integrations/key.
  try {
    await getDb().transaction(async (tx) => {
      await createPartnerStore(tx).savePartner(partner);
      await createPartnerIntegrationsStore(tx).saveIntegrations(id, {
        kyc: {},
        whatsapp: {
          phoneNumberId: clean(wa.phoneNumberId),
          token: clean(wa.token),
          verifyToken: clean(wa.verifyToken),
          appSecret: clean(wa.appSecret),
        },
        payment: {
          providerType,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          webhookSecret,
        },
      });
    });
  } catch (e) {
    rethrowPnidConflict(e);
  }

  const issued = await getPartnerApiKeyStore().issue(id);

  revalidatePath('/admin-dashboard/partners');
  return {
    id,
    apiKey: issued.plaintext,
    apiKeyLast4: issued.last4,
    whatsappCallbackUrl: `${env.appBaseUrl}/api/whatsapp/${id}`,
    statusCallbackUrl: `${env.appBaseUrl}/api/payment-webhook/${providerType === 'simulator' ? 'simulator' : 'http'}`,
    apiBaseUrl: `${env.appBaseUrl}/api/partner/v1`,
    whatsappConfigured,
    settlementConfigured,
  };
}
