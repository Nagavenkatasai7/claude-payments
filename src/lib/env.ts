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
  paymentWebhookSecret(provider: string): string {
    // Per-provider HMAC secret, e.g. PAYMENT_WEBHOOK_SECRET_UNITELLER.
    // '' ⇒ unconfigured ⇒ the webhook rejects (fail-closed; never fail-open).
    return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? '';
  },
};
