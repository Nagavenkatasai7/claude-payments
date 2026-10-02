// The integration URLs a partner's engineers paste into their own systems. One place for the
// legacy integration guide (admin-dashboard/partners/[id]) and the /partner Webhooks and API keys
// pages. Pure: the caller passes env.appBaseUrl.

/** Where the partner's rail POSTs signed lifecycle events: the simulator rail has its own path. */
export function statusCallbackUrl(appBaseUrl: string, providerType: string | undefined): string {
  return `${appBaseUrl}/api/payment-webhook/${providerType === 'simulator' ? 'simulator' : 'http'}`;
}

/** The partner REST API's base URL. */
export function partnerApiBaseUrl(appBaseUrl: string): string {
  return `${appBaseUrl}/api/partner/v1`;
}
