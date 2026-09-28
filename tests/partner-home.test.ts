import { describe, it, expect } from 'vitest';
import {
  buildPartnerHome,
  settlementHealth,
  whatsappHealth,
  type PartnerHomeInput,
} from '@/lib/partner-home';

// UI redesign M3-3: the pure view model behind /partner (home). Relative dates only.
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const base: PartnerHomeInput = {
  role: 'admin',
  now,
  summary: { countToday: 3, volumeToday: 450, commissionToday: 9, needsAttention: 1, byStatus: { in_review: 2 } },
  whatsapp: 'ok',
  settlement: 'ok',
  apiKeys: [{ keyId: 'pk_live_k1', lastUsedAt: daysAgo(1) }],
};
const api = (i: PartnerHomeInput) => buildPartnerHome(i).health.find((h) => h.key === 'api')!.state;

describe('buildPartnerHome', () => {
  it('KPIs for money roles (admin, agent); none for support', () => {
    expect(buildPartnerHome(base).kpis).toEqual({ countToday: 3, volumeTodayUsd: 450, feesTodayUsd: 9 });
    expect(buildPartnerHome({ ...base, role: 'agent' }).kpis).toEqual({ countToday: 3, volumeTodayUsd: 450, feesTodayUsd: 9 });
    expect(buildPartnerHome({ ...base, role: 'support' }).kpis).toBeNull();
  });

  it('actions: holds from byStatus.in_review, attention, and unhealthy channels; zero counts omitted', () => {
    const m = buildPartnerHome({ ...base, whatsapp: 'attention', settlement: 'off' });
    expect(m.actions).toEqual([
      { key: 'holds', count: 2 },
      { key: 'attention', count: 1 },
      { key: 'whatsapp', count: 1 },
      { key: 'webhooks', count: 1 },
    ]);
    expect(buildPartnerHome({ ...base, summary: { ...base.summary!, needsAttention: 0, byStatus: {} } }).actions).toEqual([]);
  });

  it('api health: off without an unrevoked key; attention when no live key was used in 7 days or only test keys', () => {
    expect(api({ ...base, apiKeys: [] })).toBe('off');
    expect(api({ ...base, apiKeys: [{ keyId: 'pk_live_k1', lastUsedAt: daysAgo(8) }] })).toBe('attention');
    expect(api({ ...base, apiKeys: [{ keyId: 'pk_live_k1' }] })).toBe('attention');
    expect(api({ ...base, apiKeys: [{ keyId: 'pk_live_k1', revokedAt: daysAgo(1), lastUsedAt: daysAgo(1) }] })).toBe('off');
    expect(api({ ...base, apiKeys: [{ keyId: 'pk_test_k1', lastUsedAt: daysAgo(1) }] })).toBe('attention');
    expect(api(base)).toBe('ok');
  });

  it('no_live_key action only when api is off', () => {
    expect(buildPartnerHome({ ...base, apiKeys: [] }).actions).toContainEqual({ key: 'no_live_key', count: 1 });
    expect(buildPartnerHome(base).actions.some((a) => a.key === 'no_live_key')).toBe(false);
  });

  it('health order is fixed', () => {
    expect(buildPartnerHome(base).health.map((h) => h.key)).toEqual(['whatsapp', 'webhooks', 'api']);
  });

  it('fail-soft: an unavailable source marks only its own part as error', () => {
    const m = buildPartnerHome({ ...base, summary: null, whatsapp: null, apiKeys: null });
    expect(m.kpis).toBe('error');
    expect(m.health).toEqual([
      { key: 'whatsapp', state: 'error' },
      { key: 'webhooks', state: 'ok' },
      { key: 'api', state: 'error' },
    ]);
    // Holds/attention are unknown (not zero); channel actions only from sources that answered.
    expect(m.actionsIncomplete).toBe(true);
    expect(m.actions).toEqual([]);
    expect(buildPartnerHome({ ...base, role: 'support', summary: null }).kpis).toBeNull();
    expect(buildPartnerHome(base).actionsIncomplete).toBe(false);
  });
});

describe('whatsappHealth', () => {
  it('maps the channel-health summary level; off only when no channel was read', () => {
    expect(whatsappHealth({ level: 'ok', channelLabel: 'shared SmartRemit number', items: [] })).toBe('ok');
    expect(whatsappHealth({ level: 'ok', channelLabel: 'own number', items: [] })).toBe('ok');
    expect(whatsappHealth({ level: 'warn', channelLabel: 'own number', items: [] })).toBe('attention');
    expect(whatsappHealth({ level: 'error', channelLabel: 'incomplete', items: [] })).toBe('attention');
    expect(whatsappHealth({ level: 'ok', items: [] })).toBe('off');
  });
});

describe('settlementHealth', () => {
  const opts = { appOrigin: 'https://app.example', production: true };
  it('absent or mock rail → off', () => {
    expect(settlementHealth({}, opts)).toBe('off');
    expect(settlementHealth({ providerType: 'mock' }, opts)).toBe('off');
  });
  it('http/simulator with a URL that passes checkSettlementUrl → ok, else attention', () => {
    expect(settlementHealth({ providerType: 'http', credentials: { settlementUrl: 'https://rail.example/settle' } }, opts)).toBe('ok');
    expect(settlementHealth({ providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example/s' } }, opts)).toBe('ok');
    expect(settlementHealth({ providerType: 'http', credentials: {} }, opts)).toBe('attention');
    expect(settlementHealth({ providerType: 'http', credentials: { settlementUrl: 'http://10.0.0.1/x' } }, opts)).toBe('attention');
    expect(settlementHealth({ providerType: 'http', credentials: { settlementUrl: 'https://localhost/x' } }, opts)).toBe('attention');
  });
  it('an unknown rail type → attention', () => {
    expect(settlementHealth({ providerType: 'other', credentials: { settlementUrl: 'https://rail.example/s' } }, opts)).toBe('attention');
  });
});
