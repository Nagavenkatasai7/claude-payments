import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers-db';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createAuditLogStore } from '@/lib/audit-log-store';

// Program-Fix 17a — the Team page's "Recent activity" feed filters its five
// team actions IN SQL (and actor_type 'staff'), so the new high-volume auth.*
// rows (many of them actor_type 'staff': auth.login) can never starve it.

describe('Team feed vs auth.* rows', () => {
  it("200 auth rows then 1 'created' → the feed shows 'created'", async () => {
    const db = await freshDb();
    const repo = createAuditRepo(db);
    const store = createAuditLogStore(db);
    await store.record({ at: '', actor: 'boss', action: 'updated', target: 'old' });
    for (let i = 0; i < 100; i++) {
      await repo.record({ actor: 'ops', actorType: 'staff', action: 'auth.login', subjectId: 'ops' });
      await repo.record({ actor: 'login', actorType: 'system', action: 'auth.login.failed' });
    }
    await store.record({ at: '', actor: 'boss', action: 'created', target: 'agent9' });
    const feed = await store.list(20);
    expect(feed.map((e) => `${e.action}:${e.target}`)).toEqual(['created:agent9', 'updated:old']);
  });

  it('listRecentByActions returns only the named actions, newest first, and [] for an empty list', async () => {
    const db = await freshDb();
    const repo = createAuditRepo(db);
    await repo.record({ actor: 'a', actorType: 'staff', action: 'created', subjectId: 's1' });
    await repo.record({ actor: 'a', actorType: 'staff', action: 'auth.login', subjectId: 's1' });
    await repo.record({ actor: 'a', actorType: 'staff', action: 'removed', subjectId: 's2' });
    const rows = await repo.listRecentByActions(['created', 'removed'], 10);
    expect(rows.map((r) => r.action).sort()).toEqual(['created', 'removed']);
    expect(await repo.listRecentByActions([], 10)).toEqual([]);
  });
});
