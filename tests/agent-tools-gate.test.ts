import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb } from './helpers-db';
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
