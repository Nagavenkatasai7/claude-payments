import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PortalSite } from '@/lib/portal-site';
import type { Db } from '@/db/client';
import { freshDb } from './helpers-db';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { protectedResourceMetadata } from '@/lib/agent-auth/config';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

// TGFL custom host, design §5.4 / §6 item 27: /portal/ai-apps shows a connector box with THIS host's
// MCP address (the custom host's own address on smartremitai.tgfl.org), in both the empty and the
// list branch, with one section per AI app and an absolute link to the full guide on the apex.
// The page gate does not change: no gate and no grant → 404.

const h = vi.hoisted(() => ({
  site: null as null | PortalSite,
  ctx: null as null | Record<string, unknown>,
  db: null as unknown,
}));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({
  getPortalCustomer: async () => h.ctx,
  requirePortalCustomer: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    return h.ctx;
  },
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));

import AgentAppsPage from '@/app/portal/ai-apps/page';

const PHONE = '15551230000';
const CID = 'agc_BBBBBBBBBBBBBBBBBBBBBB';
const GID = 'agg_BBBBBBBBBBBBBBBBBBBBBB';
let db: Db;

function on(host: string, slug: string) {
  h.site = { partnerId: DEFAULT_PARTNER_ID, slug, host, brand: 'SmartRemit', logo: null, theme: {} as PortalSite['theme'] };
  h.ctx = { site: h.site, session: { phone: PHONE, sid: 's1' }, token: 'tok', customer: { partnerId: DEFAULT_PARTNER_ID, senderPhone: PHONE } };
}
const page = async () => renderToStaticMarkup(await AgentAppsPage());

async function grant() {
  const repo = createAgentOAuthRepo(db);
  await repo.insertClient({ id: CID, partnerId: DEFAULT_PARTNER_ID, name: 'App', redirectUris: ['https://app.example/cb'], authMethod: 'none', secretHash: null });
  await repo.insertGrant({ id: GID, partnerId: DEFAULT_PARTNER_ID, phone: PHONE, clientId: CID, scopes: ['quotes:read'], refreshHash: `h-${GID}`, now: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
}
async function gateOpen() {
  process.env.DEMO_PHONES = PHONE;
  await createFeatureFlagRepo(db).upsert({ key: 'agent.tools', scopeType: 'partner', scopeId: DEFAULT_PARTNER_ID, enabled: true, reason: 'ai apps page', updatedBy: 'root' });
  invalidateFlagCache(db);
}

beforeEach(async () => {
  db = await freshDb();
  h.db = db;
  on('send.smartremit.ai', 'send');
});
afterEach(() => {
  delete process.env.DEMO_PHONES;
  invalidateFlagCache(db);
});

const boxUrl = (html: string) => /<code[^>]*data-connector-url[^>]*>([^<]*)<\/code>/.exec(html)?.[1];

describe('/portal/ai-apps connector box', () => {
  it('on send.smartremit.ai: the send address, equal to the protected resource metadata', async () => {
    await grant();
    const html = await page();
    expect(html).toContain('data-connector-box');
    expect(boxUrl(html)).toBe('https://send.smartremit.ai/api/mcp');
    expect(boxUrl(html)).toBe(protectedResourceMetadata('send.smartremit.ai').resource);
  });

  it('on the custom host: the custom host\'s own address', async () => {
    on('smartremitai.tgfl.org', 'tgfl');
    await grant();
    const html = await page();
    expect(boxUrl(html)).toBe('https://smartremitai.tgfl.org/api/mcp');
    expect(boxUrl(html)).toBe(protectedResourceMetadata('smartremitai.tgfl.org').resource);
    expect(html).not.toContain('send.smartremit.ai/api/mcp');
  });

  it('shown in the list branch (a live grant) and in the empty branch (gate open, no grant)', async () => {
    await grant();
    const list = await page();
    expect(list).toContain('data-connector-box');
    expect(list).toContain('Disconnect');
    db = await freshDb();
    h.db = db;
    await gateOpen();
    const empty = await page();
    expect(empty).toContain('data-connector-box');
    expect(empty).toContain('No connected apps');
  });

  it('a section per AI app, the copy button, the disclaimer and the absolute guide link', async () => {
    await grant();
    const html = await page();
    for (const id of ['claude', 'chatgpt', 'perplexity']) expect(html).toContain(`id="connect-${id}"`);
    expect(html).toContain('href="https://smartremit.ai/docs/ai-apps"');
    expect(html).toContain('aria-label="Copy the connector address"');
    expect(html).toContain('not affiliated');
    expect(html).not.toMatch(/\b(test|testing)\b/i);
  });

  it('404 when the page is not visible (gate shut, no grant)', async () => {
    await expect(AgentAppsPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
