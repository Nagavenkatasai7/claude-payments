export type PaymentProviderMode = 'mock'; // v1: mock only; real modes added when a partner lands

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
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
  get appBaseUrl() {
    const explicit = process.env.APP_BASE_URL;
    if (explicit && explicit.trim()) return explicit.trim().replace(/\/+$/, '');
    // Vercel auto-injects the production domain (no protocol).
    const vercelDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (vercelDomain && vercelDomain.trim()) {
      return `https://${vercelDomain.trim()}`;
    }
    return 'https://claude-payments.vercel.app';
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
  get paymentProviderMode(): PaymentProviderMode {
    // Default + only supported value in v1 — a forward hook, not a live switch.
    return process.env.PAYMENT_PROVIDER_MODE === 'mock' ? 'mock' : 'mock';
  },
  get whatsappFlowsEnabled(): boolean {
    // Strict 'true' literal (mirrors paymentProviderMode). Default-false: the
    // test WABA is not Meta-Business-verified, so a live list/flow send may
    // fail — the send_recipient_picker call site falls back to buttons.
    return process.env.WHATSAPP_FLOWS_ENABLED === 'true';
  },
  // ── Customer onboarding Phase 1 ──
  get fieldEncryptionKey(): string {
    // 32-byte (hex/base64) master key for field-level envelope encryption.
    // '' ⇒ unconfigured; field-crypto's EnvKeyProvider throws AT USE (not at
    // import) so dev/test without it doesn't break. Behind EncryptionKeyProvider
    // so a real KMS replaces this later without touching call sites.
    return process.env.FIELD_ENCRYPTION_KEY ?? '';
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
    return process.env.WHATSAPP_AUTH_TEMPLATE ?? 'verification_code';
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
  // KYC status templates (degrade to free-form via sendTemplateOrText until Meta-approved).
  get whatsappVerificationNeededTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_NEEDED_TEMPLATE ?? 'verification_needed';
  },
  get whatsappVerificationInProgressTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_IN_PROGRESS_TEMPLATE ?? 'verification_in_progress';
  },
  get whatsappVerificationVerifiedTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_VERIFIED_TEMPLATE ?? 'verification_verified';
  },
  get whatsappVerificationFailedTemplate(): string {
    return process.env.WHATSAPP_VERIFICATION_FAILED_TEMPLATE ?? 'verification_failed';
  },
  paymentWebhookSecret(provider: string): string {
    // Per-provider HMAC secret, e.g. PAYMENT_WEBHOOK_SECRET_UNITELLER.
    // '' ⇒ unconfigured ⇒ the webhook rejects (fail-closed; never fail-open).
    return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? '';
  },
};
