export type PaymentProviderMode = 'mock'; // v1: mock only; real modes added when a partner lands

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  // Neon Postgres pooled connection string (auto-injected by the Vercel
  // Marketplace integration). The LEDGER lives here from Stage 2 on.
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  // Ops alert destination — WhatsApp number that receives stuck-money /
  // dead-letter alerts from the reconciliation sweep (Stage 2). '' ⇒ no alerts.
  get opsAlertPhone(): string {
    return process.env.OPS_ALERT_PHONE ?? '';
  },
  // Program-Fix 26 — the ops-alert MIRROR. Both OPTIONAL (never boot-asserted):
  // unset ⇒ ops alerts go to OPS_ALERT_PHONE only, exactly as before.
  /** Comma-separated mailbox(es) that also receive every ops alert by email. */
  get opsAlertEmails(): string[] {
    return (process.env.OPS_ALERT_EMAIL ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  },
  /** Incoming-webhook URL (Slack/PagerDuty style, JSON `{text}`) — a bearer secret; https only. */
  get opsAlertWebhookUrl(): string {
    return process.env.OPS_ALERT_WEBHOOK_URL ?? '';
  },
  /**
   * Sentry DSN for server error reports (Program-Fix 26). Documented here for the
   * env contract only: src/lib/error-report.ts reads process.env.SENTRY_DSN
   * DIRECTLY so it stays edge-safe. Unset ⇒ no error is ever sent.
   */
  get sentryDsn(): string {
    return process.env.SENTRY_DSN ?? '';
  },
  // Email (Hostinger SMTP, via nodemailer) — used for "Partner with us" lead
  // notifications. All OPTIONAL (NOT money-grade, so boot-assert never requires
  // them): unset ⇒ the email effect no-ops and the lead still lands in the admin
  // Partner-requests page. SMTP_USER is the FULL mailbox address; SMTP_PASS is
  // that mailbox's password (Hostinger has no separate SMTP key).
  get smtpHost(): string {
    return process.env.SMTP_HOST ?? '';
  },
  get smtpPort(): number {
    return Number(process.env.SMTP_PORT ?? '465');
  },
  get smtpUser(): string {
    return process.env.SMTP_USER ?? '';
  },
  get smtpPass(): string {
    return process.env.SMTP_PASS ?? '';
  },
  /** Recipients of partner-lead emails — comma-separated; extendable any time. */
  get partnerLeadEmails(): string[] {
    const raw = process.env.PARTNER_LEAD_EMAILS ?? 'venkat@smartremit.ai';
    return raw.split(',').map((e) => e.trim()).filter(Boolean);
  },
  /**
   * The From header. Hostinger binds the SMTP session to one mailbox, so the From
   * ADDRESS must equal SMTP_USER (display-name aliasing is fine). Defaults to the
   * authenticated mailbox so a mismatched From can never trigger a 550.
   */
  get emailFrom(): string {
    return process.env.EMAIL_FROM ?? (this.smtpUser ? `SmartRemit <${this.smtpUser}>` : '');
  },
  // Vercel Blob — the OLD public store's token (fix 24: it no longer receives
  // uploads). Kept only so the one-off owner script can `del()` the old public
  // objects after re-issuing them; the store can be deleted once that has run.
  get blobReadWriteToken(): string {
    return process.env.BLOB_READ_WRITE_TOKEN ?? '';
  },
  // Fix 24: the PRIVATE Blob store that holds partner licence / KYB / AML
  // documents. OPTIONAL (boot-assert never requires it): unset ⇒ uploads are
  // gated with a friendly 503 and the text application still submits. It is
  // passed EXPLICITLY on every put/get so SDK auth is deterministic even while
  // the old public store's BLOB_READ_WRITE_TOKEN is still connected — there is
  // no fallback from this token to that one, by design.
  get partnerDocsBlobToken(): string {
    return process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN ?? '';
  },
  get ollamaBaseUrl() {
    return required('OLLAMA_BASE_URL');
  },
  get ollamaApiKey() {
    return required('OLLAMA_API_KEY');
  },
  get ollamaModel() {
    return required('OLLAMA_MODEL');
  },
  get whatsappToken() {
    return required('WHATSAPP_TOKEN');
  },
  get whatsappPhoneNumberId() {
    return required('WHATSAPP_PHONE_NUMBER_ID');
  },
  get whatsappVerifyToken() {
    return required('WHATSAPP_VERIFY_TOKEN');
  },
  get metaAppSecret() {
    // Meta App Secret for X-Hub-Signature-256 verification on inbound webhooks.
    // '' ⇒ unconfigured ⇒ the /api/whatsapp POST handler skips the signature
    // check (warns; preserves dev/test + current prod). Set ⇒ fail-closed 401.
    return process.env.META_APP_SECRET ?? '';
  },
  /**
   * True only under NODE_ENV=production. Fix 22: the settlement-URL rule's
   * http app-origin exception (local-dev simulator) exists only when this is
   * false. Vitest runs under NODE_ENV=test.
   */
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
  get appBaseUrl() {
    const explicit = process.env.APP_BASE_URL;
    if (explicit && explicit.trim()) return explicit.trim().replace(/\/+$/, '');
    // Vercel auto-injects the production domain (no protocol).
    const vercelDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (vercelDomain && vercelDomain.trim()) {
      return `https://${vercelDomain.trim()}`;
    }
    return 'https://smartremit.ai';
  },
  get kvUrl() {
    return required('KV_REST_API_URL');
  },
  get kvToken() {
    return required('KV_REST_API_TOKEN');
  },
  get cronSecret() {
    return process.env.CRON_SECRET ?? '';
  },
  get seedAdminUsername() {
    return required('SEED_ADMIN_USERNAME');
  },
  get seedAdminPassword() {
    return required('SEED_ADMIN_PASSWORD');
  },
  // P3: optional partner-staff seed (set when E2E needs a partner login)
  get seedPartnerUsername() {
    return process.env.SEED_PARTNER_USERNAME ?? '';
  },
  get seedPartnerPassword() {
    return process.env.SEED_PARTNER_PASSWORD ?? '';
  },
  get seedPartnerId() {
    return process.env.SEED_PARTNER_ID ?? '';
  },
  // ── Program-Fix 17b: staff TOTP MFA (both OPTIONAL; never in boot-assert) ──
  get staffMfaRequired(): boolean {
    // 'true' ⇒ an unenrolled PLATFORM admin is sent to enrol on the
    // platform-admin surfaces. Default false: MFA stays opt-in. The seed admin
    // and STAFF_MFA_EXEMPT names are never required (staff-mfa-policy.ts).
    return process.env.STAFF_MFA_REQUIRED === 'true';
  },
  get staffMfaExempt(): string[] {
    // Comma-separated usernames exempt from ENFORCEMENT only (e.g. the e2e
    // smoke account). Never skips the code step for someone who enrolled.
    return (process.env.STAFF_MFA_EXEMPT ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  // ── Program-Fix 49D: customer portal TOTP (OPTIONAL; never in boot-assert) ──
  get customerMfaRequired(): boolean {
    // 'true' ⇒ refund and recall requests from the portal require the customer
    // to have turned on two-step verification (customer-mfa.ts stepUp). Default
    // false: portal MFA stays opt-in. Someone who HAS enrolled always gets the
    // code step at sign-in and before those actions, whatever this says.
    return process.env.CUSTOMER_MFA_REQUIRED === 'true';
  },
  // ── Program-Fix 7: real sender funds capture (both OPTIONAL; never in boot-assert) ──
  get stripeFundingEnabled(): boolean {
    // 'true' ⇒ a partner with a Stripe funding config (partner_integrations
    // funding_*; the partner's OWN account) charges senders through Stripe and
    // new transfers bind a PaymentIntent. Default false: every transfer keeps
    // today's mock / partner-settled funding. (The webhook keeps applying
    // verified events for ALREADY-bound debits either way — review M5.)
    return process.env.STRIPE_FUNDING_ENABLED === 'true';
  },
  get stripeFundingAllowTestMode(): boolean {
    // 'true' ⇒ a verified livemode:false (Stripe test-mode) success may settle
    // a transfer. Default false: test-mode money never pays out on a rail.
    // IGNORED in any production build (review M4): a stray variable must never
    // let a test-card success settle a real payout.
    return process.env.STRIPE_FUNDING_ALLOW_TEST_MODE === 'true' && process.env.NODE_ENV !== 'production';
  },
  get paymentProviderMode(): PaymentProviderMode {
    // Default + only supported value in v1 — a forward hook, not a live switch.
    return process.env.PAYMENT_PROVIDER_MODE === 'mock' ? 'mock' : 'mock';
  },
  // ── Customer onboarding Phase 1 ──
  get fieldEncryptionKey(): string {
    // 32-byte (hex/base64) master key for field-level envelope encryption.
    // '' ⇒ unconfigured; field-crypto's EnvKeyProvider throws AT USE (not at
    // import) so dev/test without it doesn't break. Behind EncryptionKeyProvider
    // so a real KMS replaces this later without touching call sites.
    return process.env.FIELD_ENCRYPTION_KEY ?? '';
  },
  get sanctionsList(): string {
    // Program-Fix 14: WHICH sanctions list the screener uses — never WHETHER
    // screening runs (it always runs). '' / 'mock' ⇒ the mock watchlist;
    // 'ofac-sdn' ⇒ the OFAC SDN list loaded into Postgres by the daily loader
    // (PR C; fails closed to review while no version is loaded); anything else
    // ⇒ the mock plus a warning. Optional; unset in prod.
    return (process.env.SANCTIONS_LIST ?? '').trim().toLowerCase();
  },
  get sanctionsLoaderEnabled(): boolean {
    // Program-Fix 14 PR C: '1' / 'true' ⇒ /api/cron downloads the OFAC SDN list
    // from Treasury's Sanctions List Service and stores a new version when it
    // changed. OFF by default (unset in prod until the owner flips it). It
    // loads the list only; it never turns screening on or off. Optional, NOT in
    // boot-assert.
    const v = (process.env.SANCTIONS_LOADER_ENABLED ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
  },
  get passwordPepper(): string {
    // HMAC pepper applied before Argon2id. '' ⇒ no pepper (keeps existing staff
    // scrypt hashes verifying). Kept out of Redis; lives only in this secret.
    return process.env.PASSWORD_PEPPER ?? '';
  },
  get otpDevMode(): boolean {
    // 'true' ⇒ sendOtpCode logs the code + no-ops the live send, so dev/staging
    // works before the Meta AUTHENTICATION template is approved. Default false.
    return process.env.OTP_DEV_MODE === 'true';
  },
  get whatsappAuthTemplate(): string {
    // Name of the approved Meta AUTHENTICATION template used for OTP delivery.
    // TEMPLATES ARE OPT-IN: '' (unset) ⇒ sendOtpCode skips the template call
    // entirely and delivers the code as regular free-form text — the right mode
    // for the testing business until templates are approved in WhatsApp
    // Manager. Set this to the approved template name to switch over.
    return process.env.WHATSAPP_AUTH_TEMPLATE ?? '';
  },
  // ── Customer onboarding Phase 2 — Persona KYC ──
  // All optional (`?? ''`): an unprovisioned env keeps MockKycProvider selected and
  // the webhook fail-closed, mirroring the Phase-1 dormant-until-provisioned posture.
  get personaApiKey(): string {
    return process.env.PERSONA_API_KEY ?? '';
  },
  get personaEnvironment(): string {
    return process.env.PERSONA_ENVIRONMENT ?? 'sandbox';
  },
  get personaWebhookSecret(): string {
    // wbhsec_… HMAC secret; '' ⇒ the /api/persona-webhook route rejects (fail-closed).
    return process.env.PERSONA_WEBHOOK_SECRET ?? '';
  },
  get personaInquiryTemplateVersionId(): string {
    return process.env.PERSONA_INQUIRY_TEMPLATE_VERSION_ID ?? '';
  },
  get personaApiVersion(): string {
    // Confirmed against the sandbox 2026-06-02 (Task 0 spike).
    return process.env.PERSONA_API_VERSION ?? '2025-12-08';
  },
  get personaApiBase(): string {
    return process.env.PERSONA_API_BASE ?? 'https://api.withpersona.com/api/v1';
  },
  // KYC status templates — OPT-IN like the auth template: '' (unset) ⇒
  // sendVerificationStatus sends the free-form fallback text directly, no
  // template attempt. Set to the approved names to switch over.
  get whatsappVerificationNeededTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_NEEDED_TEMPLATE ?? '';
  },
  get whatsappVerificationInProgressTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_IN_PROGRESS_TEMPLATE ?? '';
  },
  get whatsappVerificationVerifiedTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_VERIFIED_TEMPLATE ?? '';
  },
  get whatsappVerificationFailedTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_FAILED_TEMPLATE ?? '';
  },
  // Program-Fix 25 — both OPTIONAL, unset ⇒ today's behaviour byte-for-byte.
  // The approved UTILITY template (one body variable) for ops alerts. '' ⇒ the
  // ops.alert row sends free-form text exactly as before.
  get whatsappOpsAlertTemplate(): string {
    return process.env.WHATSAPP_OPS_ALERT_TEMPLATE ?? '';
  },
  // 'true' ⇒ sendBusinessInitiated checks the 24h customer-service window
  // (lastmsg:) and skips a doomed free-form send outside it. Turn on only after
  // the production number is live and the templates are approved.
  get whatsappWindowAware(): boolean {
    return process.env.WHATSAPP_WINDOW_AWARE === 'true';
  },
  paymentWebhookSecret(provider: string): string {
    // Per-provider HMAC secret, e.g. PAYMENT_WEBHOOK_SECRET_UNITELLER.
    // '' ⇒ unconfigured ⇒ the webhook rejects (fail-closed; never fail-open).
    return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? '';
  },
  paymentWebhookSecretPrevious(provider: string): string {
    // Program-Fix 29: OPTIONAL rotation grace secret, e.g.
    // PAYMENT_WEBHOOK_SECRET_UNITELLER_PREVIOUS. '' when unset (no-op). Never
    // boot-required: the current secret alone is the fail-closed gate.
    return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}_PREVIOUS`] ?? '';
  },
  fundingWebhookSecret(provider: string): string {
    // Per-provider HMAC secret for the FUNDING (sender-charge) callback, e.g.
    // FUNDING_WEBHOOK_SECRET_STRIPE. Same posture as paymentWebhookSecret:
    // '' ⇒ unconfigured ⇒ the webhook rejects (fail-closed; never fail-open).
    return process.env[`FUNDING_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? '';
  },
};
