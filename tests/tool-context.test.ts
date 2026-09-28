import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@/lib/tools';

// UI redesign M2-4, Task 4.2: buildToolContext is the ToolContext the agent
// built inline for every turn (agent.ts completeTurn), moved verbatim. The
// singleton defaults are LAZY: a caller that passes every dep (the agent
// always does) never touches a singleton.

const singleton = (name: string) => vi.fn(() => {
  throw new Error(`singleton ${name} used`);
});

vi.mock('@/lib/store', async (orig) => ({ ...(await orig<object>()), getStore: singleton('store') }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<object>()), getCustomerStore: singleton('customerStore') }));
vi.mock('@/lib/schedule-store', async (orig) => ({ ...(await orig<object>()), getScheduleStore: singleton('scheduleStore') }));
vi.mock('@/lib/draft-store', async (orig) => ({ ...(await orig<object>()), getDraftStore: singleton('draftStore') }));
vi.mock('@/lib/daily-volume-store', async (orig) => ({ ...(await orig<object>()), getDailyVolumeStore: singleton('dailyVolumeStore') }));
vi.mock('@/lib/monthly-volume-store', async (orig) => ({ ...(await orig<object>()), getMonthlyVolumeStore: singleton('monthlyVolumeStore') }));
vi.mock('@/lib/providers/kyc-provider', async (orig) => ({ ...(await orig<object>()), getKycProvider: singleton('kycProvider') }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<object>()), getPartnerStore: singleton('partnerStore') }));
const selectSettlementRoute = vi.fn(async () => ({ fxRate: 85, source: 'platform' as const }));
vi.mock('@/lib/partner-rates', async (orig) => ({ ...(await orig<object>()), selectSettlementRoute }));
vi.mock('@/lib/partner-integrations-store', async (orig) => ({
  ...(await orig<object>()),
  getPartnerIntegrationsStore: () => 'integrations-store',
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<object>()), getDb: () => 'db' }));

const { buildToolContext } = await import('@/lib/tool-context');

function fullDeps() {
  const mk = (name: string) => ({ name }) as unknown;
  return {
    store: mk('store'),
    scheduleStore: mk('scheduleStore'),
    draftStore: mk('draftStore'),
    customerStore: mk('customerStore'),
    dailyVolumeStore: mk('dailyVolumeStore'),
    monthlyVolumeStore: mk('monthlyVolumeStore'),
    kycProvider: mk('kycProvider'),
    partnerStore: mk('partnerStore'),
    waCreds: mk('waCreds'),
  } as unknown as Pick<
    ToolContext,
    'store' | 'scheduleStore' | 'draftStore' | 'customerStore' | 'dailyVolumeStore' | 'monthlyVolumeStore' | 'kycProvider' | 'partnerStore' | 'waCreds'
  >;
}

describe('buildToolContext', () => {
  it('builds exactly the agent\'s per-turn context: same fields, same order, the deps passed through by identity', () => {
    const deps = fullDeps();
    const turn = { isNewConversation: true };
    const ctx = buildToolContext({ partnerId: 'pa', phone: '14155550101', channel: 'whatsapp', turn, deps });
    expect(Object.keys(ctx)).toEqual([
      'phone', 'partnerId', 'store', 'scheduleStore', 'draftStore', 'customerStore', 'dailyVolumeStore',
      'monthlyVolumeStore', 'kycProvider', 'partnerStore', 'waCreds', 'channel', 'turn', 'routeSelector',
    ]);
    expect(ctx.phone).toBe('14155550101');
    expect(ctx.partnerId).toBe('pa');
    expect(ctx.channel).toBe('whatsapp');
    expect(ctx.turn).toBe(turn);
    for (const k of Object.keys(deps) as Array<keyof typeof deps>) expect(ctx[k]).toBe(deps[k]);
  });

  it('never touches a singleton when every dep is passed (the agent path)', () => {
    expect(() => buildToolContext({ partnerId: 'pa', phone: '1', channel: 'web', turn: { isNewConversation: false }, deps: fullDeps() })).not.toThrow();
  });

  it('an absent dep falls back to its singleton', () => {
    const { store: _omit, ...rest } = fullDeps();
    void _omit;
    expect(() => buildToolContext({ partnerId: 'pa', phone: '1', channel: 'web', turn: { isNewConversation: false }, deps: rest })).toThrow(
      'singleton store used',
    );
  });

  it('routeSelector is the live selection service over the shared pool', async () => {
    const ctx = buildToolContext({ partnerId: 'default', phone: '1', channel: 'whatsapp', turn: { isNewConversation: false }, deps: fullDeps() });
    await ctx.routeSelector!('USD', 'INR', 85);
    expect(selectSettlementRoute).toHaveBeenCalledWith('db', 'integrations-store', 'USD', 'INR', 85);
  });
});
