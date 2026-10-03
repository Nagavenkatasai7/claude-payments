import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Lost-features p4 C3: the legacy /account sign-in points EVERY portal customer to their portal.
// SmartRemit's own customers get the direct link (when SmartRemit's portal is live); customers of
// other providers get one neutral line (open the link your provider sent; old links now open the
// provider's sign-in). With the portal flag off, the page is the password form only.

const h = vi.hoisted(() => ({ origin: null as string | null }));
vi.mock('@/lib/customer-portal-url', async (orig) => ({
  ...(await orig<typeof import('@/lib/customer-portal-url')>()),
  customerPortalOrigin: async () => h.origin,
}));
vi.mock('@/app/account/actions', () => ({ loginAction: async () => ({}) }));

import AccountLoginPage from '@/app/account/login/page';

const render = async () => renderToStaticMarkup(await AccountLoginPage());

beforeEach(() => {
  h.origin = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('/account/login portal hints', () => {
  it('flag on + SmartRemit portal live → both hints', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1');
    h.origin = 'https://send.smartremit.ai';
    const html = await render();
    expect(html).toContain('data-portal-hint="true"');
    expect(html).toContain('href="https://send.smartremit.ai/portal/login"');
    expect(html).toContain('data-portal-hint-other');
    expect(html).toContain('Customer of another provider?');
  });
  it('flag on, SmartRemit portal not live → only the neutral line', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1');
    const html = await render();
    expect(html).not.toContain('data-portal-hint="true"');
    expect(html).toContain('data-portal-hint-other');
  });
  it('flag off → neither hint (the password form only)', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '');
    const html = await render();
    expect(html).not.toContain('data-portal-hint');
    expect(html).toContain('type="password"');
  });
});
