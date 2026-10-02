import { describe, it, expect } from 'vitest';
import { partnerApiBaseUrl, statusCallbackUrl } from '@/lib/partner-integration-urls';

// The integration URLs a partner's engineers paste into their systems, computed in ONE place for
// the legacy integration guide and the /partner Webhooks and API keys pages.
describe('partner integration URLs', () => {
  const base = 'https://smartremit.ai';
  it('the status callback URL follows the rail: simulator → /simulator, anything else → /http', () => {
    expect(statusCallbackUrl(base, 'simulator')).toBe('https://smartremit.ai/api/payment-webhook/simulator');
    expect(statusCallbackUrl(base, 'http')).toBe('https://smartremit.ai/api/payment-webhook/http');
    expect(statusCallbackUrl(base, 'mock')).toBe('https://smartremit.ai/api/payment-webhook/http');
    expect(statusCallbackUrl(base, undefined)).toBe('https://smartremit.ai/api/payment-webhook/http');
  });
  it('the partner API base URL', () => {
    expect(partnerApiBaseUrl(base)).toBe('https://smartremit.ai/api/partner/v1');
  });
});
