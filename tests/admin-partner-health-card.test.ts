import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { scopeOf } from '@/lib/staff-scope';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-22 (spec §3.10 removals): the legacy admin partner page's
// churn-risk card and its "Suggested outreach (AI)" narration are platform-only.
// Partner-scoped staff never get the card, and neither the deterministic scorer
// nor the model call runs for them. Platform staff are unchanged.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
let currentStaff: Staff;

vi.mock('@/lib/auth', () => ({
  requireScope: async () => ({ staff: currentStaff, scope: scopeOf(currentStaff) }),
  requireStaff: async () => currentStaff,
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db) };
});
vi.mock('@/lib/partner-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-api-key')>('@/lib/partner-api-key');
  return { ...actual, getPartnerApiKeyStore: () => actual.createPartnerApiKeyStore(db) };
});
// The Sidebar is an async server component (renderToStaticMarkup cannot render it).
vi.mock('@/app/admin-dashboard/sidebar', () => ({ Sidebar: () => null }));

// The card's two data sources, as spies: a non-healthy band so the narration
// path would run if reached.
const health = vi.hoisted(() => ({
  score: vi.fn(() => ({ band: 'at_risk' as const, signals: ['No transfers in 14 days'] })),
  narrate: vi.fn(async () => 'Call them this week about the quiet queue.'),
}));
vi.mock('@/lib/partner-health', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-health')>('@/lib/partner-health');
  return { ...actual, scorePartnerHealth: health.score };
});
vi.mock('@/lib/partner-health-ai', () => ({ narratePartnerHealth: health.narrate }));

import PartnerDetailPage from '@/app/admin-dashboard/partners/[id]/page';

const PA = 'ptn-alpha3';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
function staff(o: Partial<Staff>): Staff {
  return {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
}
const render = async (id = PA) =>
  renderToStaticMarkup(await PartnerDetailPage({ params: Promise.resolve({ id }) }));

beforeEach(async () => {
  redis.dump.clear();
  health.score.mockClear();
  health.narrate.mockClear();
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha Remit');
});

describe('admin partner page: churn / AI outreach card is platform-only (M3-22)', () => {
  it.each([
    ['partner admin', staff({ username: 'alpha.admin', partnerId: PA })],
    ['partner agent', staff({ username: 'alpha.agent', role: 'agent', partnerId: PA })],
  ])('%s: no card, and neither the scorer nor the model is called', async (_label, s) => {
    currentStaff = s;
    const html = await render();
    expect(html).toContain('Alpha Remit'); // the page itself rendered
    expect(html).not.toContain('churn-risk');
    expect(html).not.toContain('Suggested outreach');
    expect(html).not.toContain('Integration health');
    expect(health.score).not.toHaveBeenCalled();
    expect(health.narrate).not.toHaveBeenCalled();
  });

  it('platform admin: the card and the AI narration still render (unchanged)', async () => {
    currentStaff = staff({ username: 'platform.admin' });
    const html = await render();
    expect(html).toContain('churn-risk');
    expect(html).toContain('Suggested outreach (AI)');
    expect(html).toContain('Call them this week about the quiet queue.');
    expect(health.score).toHaveBeenCalledTimes(1);
    expect(health.narrate).toHaveBeenCalledTimes(1);
  });

  it('platform agent: the card still renders (unchanged)', async () => {
    currentStaff = staff({ username: 'platform.agent', role: 'agent' });
    const html = await render();
    expect(html).toContain('churn-risk');
    expect(health.score).toHaveBeenCalledTimes(1);
  });
});
