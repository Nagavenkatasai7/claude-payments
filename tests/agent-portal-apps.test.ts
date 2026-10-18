import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agentGrants, auditEvents } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { createAgentPortal } from '@/lib/agent-auth/portal-apps';
import { recordAgentEvent } from '@/lib/agent-auth/audit';
import { portalNavItems } from '@/lib/portal-nav';

// Stage C1: the portal "Connected AI apps" page logic. Scoped to (host partner, session phone);
// visible while the gate is open OR the customer has a live grant (so an app can always be
// disconnected); a disconnect revokes the grant and writes the audit row; fails closed.

const PHONE = '15551230000';
const CID = 'agc_AAAAAAAAAAAAAAAAAAAAAA';
const GID = 'agg_GGGGGGGGGGGGGGGGGGGGGG';

describe('Connected AI apps', { retry: 0 }, () => {
  let db: Db;
  let gate: boolean;
  const portal = (over: Partial<Parameters<typeof createAgentPortal>[0]> = {}) =>
    createAgentPortal({ repo: createAgentOAuthRepo(db), now: Date.now, gateOpen: async () => gate, audit: (e) => recordAgentEvent(db, e), ...over });

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pb');
    gate = false;
    const repo = createAgentOAuthRepo(db);
    await repo.insertClient({ id: CID, partnerId: 'default', name: '<i>Claude</i>', redirectUris: ['https://claude.ai/cb'], authMethod: 'none', secretHash: null });
  });

  const grant = (id = GID, phone = PHONE) =>
    createAgentOAuthRepo(db).insertGrant({ id, partnerId: 'default', phone, clientId: CID, scopes: ['quotes:read'], refreshHash: `h-${id}`, now: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });

  it('hidden when the gate is shut and there is no grant; shown when either holds', async () => {
    expect(await portal().visible('default', PHONE)).toBe(false);
    gate = true;
    expect(await portal().visible('default', PHONE)).toBe(true);
    gate = false;
    await grant();
    expect(await portal().visible('default', PHONE)).toBe(true);
    expect(await portal().visible('pb', PHONE)).toBe(false); // another tenant's view of the same phone
    expect(await portal().visible('default', '15559990000')).toBe(false);
  });

  it('fails closed: an error, a hang, or no phone is hidden', async () => {
    expect(await portal({ gateOpen: async () => { throw new Error('x'); } }).visible('default', PHONE)).toBe(false);
    expect(await portal({ gateOpen: () => new Promise(() => {}) }).visible('default', PHONE, 20)).toBe(false);
    gate = true;
    expect(await portal().visible('default', undefined)).toBe(false);
  });

  it('lists only my live grants', async () => {
    await grant();
    await grant('agg_HHHHHHHHHHHHHHHHHHHHHH', '15559990000');
    const list = await portal().list('default', PHONE);
    expect(list.map((g) => g.id)).toEqual([GID]);
    expect(list[0].clientName).toBe('<i>Claude</i>'); // raw: React escapes it at render
  });

  it('disconnect: mine only, audited, and then gone; a foreign or malformed id changes nothing', async () => {
    await grant();
    await grant('agg_HHHHHHHHHHHHHHHHHHHHHH', '15559990000');
    expect(await portal().disconnect('default', PHONE, 'agg_HHHHHHHHHHHHHHHHHHHHHH')).toBe(false);
    expect(await portal().disconnect('pb', PHONE, GID)).toBe(false);
    expect(await portal().disconnect('default', PHONE, 'not-an-id')).toBe(false);
    expect(await portal().disconnect('default', PHONE, null)).toBe(false);
    expect(await portal().disconnect('default', PHONE, GID)).toBe(true);
    expect(await portal().disconnect('default', PHONE, GID)).toBe(false);
    const rows = await db.select().from(agentGrants).where(eq(agentGrants.id, GID));
    expect(rows[0].revokedReason).toBe('customer');
    const other = await db.select().from(agentGrants).where(eq(agentGrants.id, 'agg_HHHHHHHHHHHHHHHHHHHHHH'));
    expect(other[0].revokedAt).toBeNull();
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'agent.grant.revoked'), eq(auditEvents.actorType, 'agent')));
    expect(audit).toHaveLength(1);
    expect(audit[0].meta).toEqual({ grantId: GID, reason: 'customer' });
    expect(await portal().list('default', PHONE)).toEqual([]);
  });

  it('the nav item appears only when asked for', () => {
    expect(portalNavItems(false).some((i) => i.href === '/portal/ai-apps')).toBe(false);
    expect(portalNavItems(false, { agentApps: true }).find((i) => i.href === '/portal/ai-apps')?.label).toBe('Connected AI apps');
  });
});

// The server action: the owner is the SESSION's (partner, phone), never a form field.
const a = vi.hoisted(() => ({ calls: [] as unknown[][], throws: false }));
vi.mock('@/lib/portal-site', () => ({ requirePortalSite: async () => ({ partnerId: 'pa', slug: 'acme' }) }));
vi.mock('@/lib/portal-auth', () => ({
  requirePortalCustomer: async () => ({ site: { partnerId: 'pa' }, session: { phone: '15551230000', sid: 's' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/agent-auth/portal-wiring', () => ({
  agentPortal: () => ({
    disconnect: async (...args: unknown[]) => {
      a.calls.push(args);
      if (a.throws) throw new Error('db down');
      return true;
    },
  }),
}));

describe('disconnectAgentAppAction', () => {
  it('uses the session partner and phone; a partner or phone field is ignored', async () => {
    const { disconnectAgentAppAction } = await import('@/app/portal/ai-apps/actions');
    const fd = new FormData();
    fd.set('grant', GID);
    fd.set('partnerId', 'evil');
    fd.set('phone', '19999999999');
    expect(await disconnectAgentAppAction(null, fd)).toEqual({ notice: 'portal.agentApps.disconnected' });
    expect(a.calls).toEqual([['pa', '15551230000', GID]]);
  });
  it('a store failure is a fixed error, never a throw', async () => {
    a.throws = true;
    const { disconnectAgentAppAction } = await import('@/app/portal/ai-apps/actions');
    expect(await disconnectAgentAppAction(null, new FormData())).toEqual({ error: 'portal.agentApps.failed' });
  });
});
