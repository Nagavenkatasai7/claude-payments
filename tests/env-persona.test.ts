import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from '@/lib/env';

describe('Persona + verification-template env getters', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads PERSONA_* values when set', () => {
    vi.stubEnv('PERSONA_API_KEY', 'persona_sandbox_x');
    vi.stubEnv('PERSONA_WEBHOOK_SECRET', 'wbhsec_x');
    vi.stubEnv('PERSONA_INQUIRY_TEMPLATE_VERSION_ID', 'itmplv_x');
    vi.stubEnv('PERSONA_ENVIRONMENT', 'sandbox');
    expect(env.personaApiKey).toBe('persona_sandbox_x');
    expect(env.personaWebhookSecret).toBe('wbhsec_x');
    expect(env.personaInquiryTemplateVersionId).toBe('itmplv_x');
    expect(env.personaEnvironment).toBe('sandbox');
  });

  it('defaults version + base + dev-friendly empties when unset', () => {
    expect(env.personaApiVersion).toBe('2025-12-08');
    expect(env.personaApiBase).toBe('https://api.withpersona.com/api/v1');
    // optional ⇒ '' so an unprovisioned env keeps MockKycProvider selected
    expect(env.personaApiKey).toBe('');
    expect(env.personaWebhookSecret).toBe('');
  });

  it('verification-status templates are OPT-IN: unset ⇒ empty (free-form mode)', () => {
    expect(env.whatsappVerificationNeededTemplate).toBe('');
    expect(env.whatsappVerificationInProgressTemplate).toBe('');
    expect(env.whatsappVerificationVerifiedTemplate).toBe('');
    expect(env.whatsappVerificationFailedTemplate).toBe('');
  });

  it('configured names switch the templates on', () => {
    process.env.WHATSAPP_VERIFICATION_NEEDED_TEMPLATE = 'verification_needed';
    try {
      expect(env.whatsappVerificationNeededTemplate).toBe('verification_needed');
    } finally {
      delete process.env.WHATSAPP_VERIFICATION_NEEDED_TEMPLATE;
    }
  });
});
