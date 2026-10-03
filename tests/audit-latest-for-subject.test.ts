import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Db } from '@/db/client';

// Lost-features B9: the newest audit row of one action for one subject, tenant-keyed. The withdraw
// action reads who raised a ticket's escalation through it.
let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

describe('auditRepo.latestForSubject', () => {
  it('the newest row of that action for that subject, inside the tenant only', async () => {
    const repo = createAuditRepo(db);
    await repo.record({ partnerId: 'pa', actor: 'a1', actorType: 'staff', action: 'ticket.escalate', subjectId: 'tk_1', meta: { actorScope: 'partner' } });
    await repo.record({ partnerId: 'pa', actor: 'plat', actorType: 'staff', action: 'ticket.escalate', subjectId: 'tk_1', meta: { reason: 'x' } });
    await repo.record({ partnerId: 'pa', actor: 'a2', actorType: 'staff', action: 'ticket.status', subjectId: 'tk_1' });
    await repo.record({ partnerId: 'pb', actor: 'b1', actorType: 'staff', action: 'ticket.escalate', subjectId: 'tk_1', meta: { actorScope: 'partner' } });
    const row = await repo.latestForSubject('pa', 'tk_1', 'ticket.escalate');
    expect(row).toMatchObject({ actor: 'plat', meta: { reason: 'x' } });
    expect(typeof row?.at).toBe('string');
    expect(await repo.latestForSubject('pa', 'tk_2', 'ticket.escalate')).toBeNull();
    expect(await repo.latestForSubject('pc', 'tk_1', 'ticket.escalate')).toBeNull();
    expect((await repo.latestForSubject('pb', 'tk_1', 'ticket.escalate'))?.actor).toBe('b1');
  });
  it('an empty tenant matches nothing', async () => {
    const repo = createAuditRepo(db);
    await repo.record({ actor: 'x', actorType: 'staff', action: 'ticket.escalate', subjectId: 'tk_1' });
    expect(await repo.latestForSubject('', 'tk_1', 'ticket.escalate')).toBeNull();
  });
});
