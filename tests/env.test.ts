import { describe, it, expect, afterEach } from 'vitest';
import { env } from '@/lib/env';

describe('env', () => {
  it('reads a configured variable', () => {
    expect(env.appBaseUrl).toBe('https://smartremit.test');
  });

  it('throws a clear error when a variable is missing', () => {
    const original = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    expect(() => env.ollamaApiKey).toThrow(/OLLAMA_API_KEY/);
    process.env.OLLAMA_API_KEY = original;
  });

  describe('appBaseUrl self-derivation (when APP_BASE_URL is empty/unset)', () => {
    const originalAppBaseUrl = process.env.APP_BASE_URL;
    const originalVercelDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;

    afterEach(() => {
      // Restore original env vars after each test
      if (originalAppBaseUrl !== undefined) {
        process.env.APP_BASE_URL = originalAppBaseUrl;
      } else {
        delete process.env.APP_BASE_URL;
      }
      if (originalVercelDomain !== undefined) {
        process.env.VERCEL_PROJECT_PRODUCTION_URL = originalVercelDomain;
      } else {
        delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      }
    });

    it('uses VERCEL_PROJECT_PRODUCTION_URL when APP_BASE_URL is empty', () => {
      process.env.APP_BASE_URL = '';
      process.env.VERCEL_PROJECT_PRODUCTION_URL = 'example-project.vercel.app';
      expect(() => env.appBaseUrl).not.toThrow();
      expect(env.appBaseUrl).toBe('https://example-project.vercel.app');
    });

    it('uses VERCEL_PROJECT_PRODUCTION_URL when APP_BASE_URL is unset', () => {
      delete process.env.APP_BASE_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = 'example-project.vercel.app';
      expect(() => env.appBaseUrl).not.toThrow();
      expect(env.appBaseUrl).toBe('https://example-project.vercel.app');
    });

    it('falls back to the canonical production domain when both vars are absent', () => {
      process.env.APP_BASE_URL = '';
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      expect(() => env.appBaseUrl).not.toThrow();
      expect(env.appBaseUrl).toBe('https://smartremit.ai');
    });

    it('trims trailing slashes from explicit APP_BASE_URL', () => {
      process.env.APP_BASE_URL = 'https://smartremit.test///';
      expect(env.appBaseUrl).toBe('https://smartremit.test');
    });
  });

  describe('paymentProviderMode', () => {
    it("defaults to 'mock' when unset", () => {
      delete process.env.PAYMENT_PROVIDER_MODE;
      expect(env.paymentProviderMode).toBe('mock');
    });
    it("stays 'mock' even when an unknown value is set (v1 only supports mock)", () => {
      process.env.PAYMENT_PROVIDER_MODE = 'uniteller';
      expect(env.paymentProviderMode).toBe('mock');
    });
  });

  describe('paymentWebhookSecret(provider)', () => {
    it("returns '' when the per-provider secret is unset (fail-closed)", () => {
      delete process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER;
      expect(env.paymentWebhookSecret('uniteller')).toBe('');
    });
    it('returns the configured secret keyed by upper-cased provider name', () => {
      process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER = 's3cret';
      expect(env.paymentWebhookSecret('uniteller')).toBe('s3cret');
    });
  });

  describe('workerHeartbeatUrl (the dead-man ping, optional)', () => {
    afterEach(() => {
      delete process.env.WORKER_HEARTBEAT_URL;
    });
    it("returns '' when unset", () => {
      delete process.env.WORKER_HEARTBEAT_URL;
      expect(env.workerHeartbeatUrl).toBe('');
    });
    it('returns the trimmed value when set', () => {
      process.env.WORKER_HEARTBEAT_URL = '  https://hc-ping.example/abc  ';
      expect(env.workerHeartbeatUrl).toBe('https://hc-ping.example/abc');
    });
  });


  describe('stray whitespace in pasted settings is ignored (2026-10-03, Batch 1 A1)', () => {
    const NAMES = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'META_APP_SECRET', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'OPS_ALERT_PHONE', 'WHATSAPP_OPS_ALERT_TEMPLATE', 'WHATSAPP_AUTH_TEMPLATE', 'WHATSAPP_WINDOW_AWARE'] as const;
    const saved: Record<string, string | undefined> = {};
    afterEach(() => {
      for (const n of NAMES) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    });
    const set = (n: (typeof NAMES)[number], v: string) => {
      if (!(n in saved)) saved[n] = process.env[n];
      process.env[n] = v;
    };

    it('trims a trailing newline or spaces from the WhatsApp settings', () => {
      set('WHATSAPP_TOKEN', 'EAAtoken\n');
      set('WHATSAPP_PHONE_NUMBER_ID', ' 1234567890 ');
      set('WHATSAPP_VERIFY_TOKEN', 'verify\r\n');
      set('META_APP_SECRET', 'secret\n');
      expect(env.whatsappToken).toBe('EAAtoken');
      expect(env.whatsappPhoneNumberId).toBe('1234567890');
      expect(env.whatsappVerifyToken).toBe('verify');
      expect(env.metaAppSecret).toBe('secret');
    });

    it('trims the SMTP host, user and password', () => {
      set('SMTP_HOST', 'smtp.example.com\n');
      set('SMTP_USER', ' ops@example.com ');
      set('SMTP_PASS', 'p@ss word\n');
      expect(env.smtpHost).toBe('smtp.example.com');
      expect(env.smtpUser).toBe('ops@example.com');
      expect(env.smtpPass).toBe('p@ss word'); // inner spaces kept
      expect(env.emailFrom === process.env.EMAIL_FROM || env.emailFrom === 'SmartRemit <ops@example.com>').toBe(true);
    });

    it('trims the ops-alert phone, template names and the window flag', () => {
      for (const [k, v] of [['OPS_ALERT_PHONE', '15550001111\n'], ['WHATSAPP_OPS_ALERT_TEMPLATE', 'ops_alert \n'], ['WHATSAPP_AUTH_TEMPLATE', ' verification_code'], ['WHATSAPP_WINDOW_AWARE', 'true\n']] as const) {
        if (!(k in saved)) saved[k] = process.env[k];
        process.env[k] = v;
      }
      expect(env.opsAlertPhone).toBe('15550001111');
      expect(env.whatsappOpsAlertTemplate).toBe('ops_alert');
      expect(env.whatsappAuthTemplate).toBe('verification_code');
      expect(env.whatsappWindowAware).toBe(true);
    });

    it('a whitespace-only required WhatsApp setting is missing, as boot-assert treats it', () => {
      set('WHATSAPP_TOKEN', '  \n');
      expect(() => env.whatsappToken).toThrow(/WHATSAPP_TOKEN/);
      set('META_APP_SECRET', ' \n');
      expect(env.metaAppSecret).toBe('');
    });
  });
});
