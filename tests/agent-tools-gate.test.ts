import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';

// Fix pack 3 T12: counts and optionally fails the gate's partner reads (the real repo otherwise).
const partnerReads = vi.hoisted(() => ({ ids: [] as string[], fail: false }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const repo = real.createPartnerRepo(...a);
      return {
        ...repo,
        getPartner: async (id: string) => {
          partnerReads.ids.push(id);
          if (partnerReads.fail) throw new Error('partner read failed');
          return repo.getPartner(id);
        },
      };
    },
  };
});

import { agentToolsOn } from '@/lib/agent-auth/gate';
import { invalidateFlagCache, tenantScopeId } from '@/lib/flags';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import type { Db } from '@/db/client';

// Fix pack 3 T7 (R26, contract 10): agentToolsOn = agent.tools on AND
// agent.tools.paused not on. agent.tools fails closed, so a read failure is off.

let db: Db;
async function setFlag(key: string, scopeType: 'global' | 'partner', scopeId: string, enabled = true) {
  await createFeatureFlagRepo(db).upsert({ key, scopeType, scopeId, enabled, reason: 'test', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  partnerReads.ids = [];
  partnerReads.fail = false;
});
afterEach(() => {
  invalidateFlagCache(db);
  vi.restoreAllMocks();
});

describe('agentToolsOn', () => {
  it('agent.tools on, no pause -> true', async () => {
    await setFlag('agent.tools', 'global', '');
    expect(await agentToolsOn(db, 'acme')).toBe(true);
  });

  it.each([
    ['global', ''],
    ['partner', 'acme'],
    ['partner', tenantScopeId('acme')],
  ] as const)('agent.tools.paused %s row (%s) -> false', async (scopeType, scopeId) => {
    await setFlag('agent.tools', 'global', '');
    await setFlag('agent.tools.paused', scopeType, scopeId);
    expect(await agentToolsOn(db, 'acme')).toBe(false);
  });

  it("another tenant's pause leaves this tenant on", async () => {
    await setFlag('agent.tools', 'global', '');
    await setFlag('agent.tools.paused', 'partner', tenantScopeId('other'));
    expect(await agentToolsOn(db, 'acme')).toBe(true);
  });

  it('agent.tools off -> false', async () => {
    expect(await agentToolsOn(db, 'acme')).toBe(false);
  });

  it('read failure -> false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      select: () => {
        throw new Error('neon down');
      },
    } as unknown as Db;
    expect(await agentToolsOn(broken, 'acme')).toBe(false);
  });
});

// Fix pack 3 T12 (R13, contract 10): a tenant certified for live money also
// needs its AI-tools (mcp) opt-in. A partner read failure is false (closed).
describe('agentToolsOn and the mcp capability (fix pack 3 T12)', () => {
  beforeEach(async () => {
    await setFlag('agent.tools', 'global', '');
    await seedPartner(db, 'acme');
  });

  it('certified tenant, mcp closed, agent.tools on -> false', async () => {
    await certifyPartnerForTest(db, 'acme', { optIns: ['b2b', 'usdc', 'schedules', 'telegram'] });
    expect(await agentToolsOn(db, 'acme')).toBe(false);
  });

  it('mcp open -> true', async () => {
    await certifyPartnerForTest(db, 'acme', { optIns: ['mcp'] });
    expect(await agentToolsOn(db, 'acme')).toBe(true);
  });

  it('uncertified -> true', async () => {
    expect(await agentToolsOn(db, 'acme')).toBe(true);
    expect(partnerReads.ids).toEqual(['acme']);
  });

  it('partner read throws -> false', async () => {
    partnerReads.fail = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await agentToolsOn(db, 'acme')).toBe(false);
  });

  it("'default' -> no partner read", async () => {
    expect(await agentToolsOn(db, 'default')).toBe(true);
    expect(partnerReads.ids).toEqual([]);
  });

  it('agent.tools off -> no partner read', async () => {
    await setFlag('agent.tools', 'global', '', false);
    expect(await agentToolsOn(db, 'acme')).toBe(false);
    expect(partnerReads.ids).toEqual([]);
  });
});
