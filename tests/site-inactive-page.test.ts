import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Draft, Partner, Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';

// Same hermetic fakes as tests/pay-page-guard.test.ts, so the pay page renders its dead-link sheet.
const limiter = fakeRedis();
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.9' }) }));
vi.mock('@upstash/redis', () => ({ Redis: class { constructor() { return limiter; } } }));
const getTransfer = vi.fn<(id: string) => Promise<Transfer | null>>(async () => null);
const getTransferDecrypted = vi.fn<(id: string) => Promise<Transfer | null>>(async () => null);
const getDraft = vi.fn<(id: string) => Promise<Draft | null>>(async () => null);
const getPartner = vi.fn<(id: string) => Promise<Partner | null>>(async () => null);
vi.mock('@/lib/store', () => ({ getStore: () => ({ getTransfer, getTransferDecrypted, legacyTenantOf: async () => null }) }));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
// Step 0 Q16: no draft:<id> claim behind an unknown id (tests/pay-page-draft-relink.test.ts covers it).
vi.mock('@/lib/pay-link', () => ({ transferMintedFromDraft: async () => null }));
const raiseLimiterDownAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert }));
vi.mock('@/db/repos/transfer-repo', () => ({ createTransferRepo: () => ({ isPayoutEditable: async () => false }) }));

describe('/site-inactive', () => {
  it('renders a <main> byte-identical to the pay page’s dead-link sheet (no oracle, same look)', async () => {
    const PayPage = (await import('@/app/pay/[transferId]/page')).default;
    const Inactive = (await import('@/app/site-inactive/page')).default;
    const main = (html: string) => html.slice(html.indexOf('<main'), html.indexOf('</main>') + 7);
    const pay = renderToStaticMarkup(await PayPage({ params: Promise.resolve({ transferId: 'does-not-exist' }) } as never));
    const site = renderToStaticMarkup(Inactive());
    expect(pay).toContain('This link is no longer active'); // the harness really rendered the dead-link sheet
    expect(main(site)).toBe(main(pay));
    expect(site).toContain('This link is no longer active');
  });
  it('is noindex, nofollow', async () => {
    const { metadata } = await import('@/app/site-inactive/page');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
  it('reads no request data (static): no headers(), no stores', async () => {
    getPartner.mockClear(); getTransfer.mockClear();
    const Inactive = (await import('@/app/site-inactive/page')).default;
    renderToStaticMarkup(Inactive());
    expect(getPartner).not.toHaveBeenCalled();
    expect(getTransfer).not.toHaveBeenCalled();
  });
});
