import { describe, it, expect, afterEach } from 'vitest';
import { env } from '@/lib/env';

describe('env', () => {
  it('reads a configured variable', () => {
    expect(env.appBaseUrl).toBe('https://sendhome.test');
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
      process.env.VERCEL_PROJECT_PRODUCTION_URL = 'claude-payments.vercel.app';
      expect(() => env.appBaseUrl).not.toThrow();
      expect(env.appBaseUrl).toBe('https://claude-payments.vercel.app');
    });

    it('uses VERCEL_PROJECT_PRODUCTION_URL when APP_BASE_URL is unset', () => {
      delete process.env.APP_BASE_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = 'claude-payments.vercel.app';
      expect(() => env.appBaseUrl).not.toThrow();
      expect(env.appBaseUrl).toBe('https://claude-payments.vercel.app');
    });

    it('falls back to hardcoded vercel.app URL when both vars are absent', () => {
      process.env.APP_BASE_URL = '';
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      expect(() => env.appBaseUrl).not.toThrow();
      const result = env.appBaseUrl;
      expect(result).toMatch(/^https:\/\/.*vercel\.app$/);
      expect(result).toBe('https://claude-payments.vercel.app');
    });

    it('trims trailing slashes from explicit APP_BASE_URL', () => {
      process.env.APP_BASE_URL = 'https://sendhome.test///';
      expect(env.appBaseUrl).toBe('https://sendhome.test');
    });
  });
});
