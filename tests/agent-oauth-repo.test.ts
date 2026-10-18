import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '@/db/client';
import { freshDb, seedPartner } from './helpers-db';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';

// Stage C1: the agent OAuth repo. Every read and write is tenant-scoped (partner_id in the
// WHERE; phone too where it is customer-facing), so another tenant's client or grant is "not
// found", never a cross-tenant read.

const NOW = new Date(Date.now() - 60_000);
const LATER = new Date(NOW.getTime() + 30 * 24 * 3600 * 1000);
const CID = 'agc_AAAAAAAAAAAAAAAAAAAAAA';
const GID = 'agg_GGGGGGGGGGGGGGGGGGGGGG';

describe('agent-oauth-repo', { retry: 0 }, () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pb');
  });

  const client = (partnerId = 'default', id = CID) =>
    createAgentOAuthRepo(db).insertClient({ id, partnerId, name: 'Claude', redirectUris: ['https://claude.ai/cb'], authMethod: 'none', secretHash: null });
  const grant = (over: Partial<{ id: string; partnerId: string; phone: string; clientId: string; refreshHash: string }> = {}) =>
    createAgentOAuthRepo(db).insertGrant({
      id: over.id ?? GID,
      partnerId: over.partnerId ?? 'default',
      phone: over.phone ?? '15551230000',
      clientId: over.clientId ?? CID,
      scopes: ['quotes:read', 'transfers:read'],
      refreshHash: over.refreshHash ?? 'h1',
      now: NOW,
      expiresAt: LATER,
    });

  it('a client is read back only on its own tenant', async () => {
    await client();
    const repo = createAgentOAuthRepo(db);
    expect(await repo.getClient('default', CID)).toMatchObject({ id: CID, partnerId: 'default', name: 'Claude', redirectUris: ['https://claude.ai/cb'], authMethod: 'none', secretHash: null });
    expect(await repo.getClient('pb', CID)).toBeNull();
    expect(await repo.getClient('default', 'agc_nope')).toBeNull();
  });

  it('a live grant is read with its client name; another tenant never sees it', async () => {
    await client();
    await grant();
    const repo = createAgentOAuthRepo(db);
    const g = await repo.getLiveGrant('default', GID, new Date());
    expect(g).toMatchObject({ id: GID, partnerId: 'default', phone: '15551230000', clientId: CID, clientName: 'Claude', scopes: ['quotes:read', 'transfers:read'] });
    expect(await repo.getLiveGrant('pb', GID, new Date())).toBeNull();
  });

  it('an expired or revoked grant is not live', async () => {
    await client();
    await grant();
    const repo = createAgentOAuthRepo(db);
    expect(await repo.getLiveGrant('default', GID, new Date(LATER.getTime() + 1))).toBeNull();
    expect(await repo.revokeGrant('pb', GID, 'admin', new Date())).toBe(false); // other tenant: no-op
    expect(await repo.getLiveGrant('default', GID, new Date())).not.toBeNull();
    expect(await repo.revokeGrant('default', GID, 'customer', new Date())).toBe(true);
    expect(await repo.revokeGrant('default', GID, 'customer', new Date())).toBe(false); // already revoked
    expect(await repo.getLiveGrant('default', GID, new Date())).toBeNull();
  });

  it('refresh lookup: current, previous, tenant-scoped; rotation is conditional on the current hash', async () => {
    await client();
    await grant();
    const repo = createAgentOAuthRepo(db);
    expect(await repo.findGrantByRefreshHash('default', 'h1')).toMatchObject({ match: 'current', grant: { id: GID } });
    expect(await repo.findGrantByRefreshHash('pb', 'h1')).toBeNull();
    const t2 = new Date();
    const exp2 = new Date(t2.getTime() + 1000);
    expect(await repo.rotateRefresh('default', GID, 'h1', 'h2', t2, exp2)).toBe(true);
    expect(await repo.rotateRefresh('default', GID, 'h1', 'h3', t2, exp2)).toBe(false); // lost the race
    expect(await repo.findGrantByRefreshHash('default', 'h2')).toMatchObject({ match: 'current' });
    expect(await repo.findGrantByRefreshHash('default', 'h1')).toMatchObject({ match: 'previous', grant: { id: GID } });
    expect(await repo.findGrantByRefreshHash('default', 'h3')).toBeNull();
    const g = await repo.getLiveGrant('default', GID, t2);
    expect(g?.expiresAt.getTime()).toBe(exp2.getTime());
    expect(g?.lastUsedAt?.getTime()).toBe(t2.getTime());
    expect(await repo.rotateRefresh('pb', GID, 'h2', 'h4', t2, exp2)).toBe(false);
  });

  it('a revoked grant cannot rotate', async () => {
    await client();
    await grant();
    const repo = createAgentOAuthRepo(db);
    await repo.revokeGrant('default', GID, 'theft', new Date());
    expect(await repo.rotateRefresh('default', GID, 'h1', 'h2', new Date(), LATER)).toBe(false);
  });

  it('the customer list and disconnect are scoped to (partner, phone)', async () => {
    await client();
    await client('pb', 'agc_BBBBBBBBBBBBBBBBBBBBBB');
    await grant();
    await grant({ id: 'agg_HHHHHHHHHHHHHHHHHHHHHH', phone: '15559990000', refreshHash: 'x2' });
    await grant({ id: 'agg_IIIIIIIIIIIIIIIIIIIIII', partnerId: 'pb', clientId: 'agc_BBBBBBBBBBBBBBBBBBBBBB', refreshHash: 'x3' });
    const repo = createAgentOAuthRepo(db);
    const mine = await repo.listCustomerGrants('default', '15551230000', new Date());
    expect(mine.map((g) => g.id)).toEqual([GID]);
    expect(mine[0]).toMatchObject({ clientName: 'Claude' });
    expect(await repo.hasCustomerGrants('default', '15551230000', new Date())).toBe(true);
    expect(await repo.hasCustomerGrants('default', '15550000000', new Date())).toBe(false);
    // Another customer's grant, another tenant's grant: not mine to disconnect.
    expect(await repo.revokeCustomerGrant('default', '15551230000', 'agg_HHHHHHHHHHHHHHHHHHHHHH', new Date())).toBeNull();
    expect(await repo.revokeCustomerGrant('default', '15551230000', 'agg_IIIIIIIIIIIIIIIIIIIIII', new Date())).toBeNull();
    expect(await repo.revokeCustomerGrant('default', '15551230000', GID, new Date())).toEqual({ clientId: CID });
    expect(await repo.listCustomerGrants('default', '15551230000', new Date())).toEqual([]);
    expect(await repo.getLiveGrant('default', 'agg_HHHHHHHHHHHHHHHHHHHHHH', new Date())).not.toBeNull();
    expect(await repo.getLiveGrant('pb', 'agg_IIIIIIIIIIIIIIIIIIIIII', new Date())).not.toBeNull();
  });

  it('touchGrant writes last_used_at on its own tenant only', async () => {
    await client();
    await grant();
    const repo = createAgentOAuthRepo(db);
    const t = new Date();
    await repo.touchGrant('pb', GID, t);
    expect((await repo.getLiveGrant('default', GID, t))?.lastUsedAt).toBeNull();
    await repo.touchGrant('default', GID, t);
    expect((await repo.getLiveGrant('default', GID, t))?.lastUsedAt?.getTime()).toBe(t.getTime());
  });

  it('the refresh hash is unique', async () => {
    await client();
    await grant();
    await expect(grant({ id: 'agg_JJJJJJJJJJJJJJJJJJJJJJ' })).rejects.toThrow();
  });
});
