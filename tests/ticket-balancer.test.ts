import { describe, it, expect, beforeEach } from 'vitest';
import { eligibleAgents, pickLeastLoaded, isTestStaff } from '@/lib/ticket-balancer';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// ticket-balancer — the deterministic core of the AI-assisted load-balancer.
// Pure eligibility + least-loaded pick, plus the two repo reads the worker uses.

function staff(over: Partial<Staff> & { username: string }): Staff {
  return {
    name: over.username,
    role: 'agent',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('isTestStaff', () => {
  it('flags e2e-smoke-* accounts and leaves real staff alone', () => {
    expect(isTestStaff(staff({ username: 'e2e-smoke-partner' }))).toBe(true);
    expect(isTestStaff(staff({ username: 'e2e-smoke-support' }))).toBe(true);
    expect(isTestStaff(staff({ username: 'venkat' }))).toBe(false);
    expect(isTestStaff(staff({ username: 'admin' }))).toBe(false);
  });
});

describe('eligibleAgents', () => {
  it('keeps active agents whose scope can see the ticket; drops the rest', () => {
    const all: Staff[] = [
      staff({ username: 'platformAgent' }), // platform (no partnerId) — sees all
      staff({ username: 'p1Agent', partnerId: 'p1' }),
      staff({ username: 'p2Agent', partnerId: 'p2' }), // other tenant
      staff({ username: 'frozen', status: 'suspended' }),
      staff({ username: 'sup', role: 'support' }), // not an agent
      staff({ username: 'boss', role: 'admin' }), // not an agent
      staff({ username: 'e2e-smoke-partner' }), // test account
    ];
    const got = eligibleAgents(all, 'p1').map((s) => s.username).sort();
    expect(got).toEqual(['p1Agent', 'platformAgent']);
  });

  it('a partner-scoped agent is NOT eligible for another tenant', () => {
    const all = [staff({ username: 'p2Agent', partnerId: 'p2' })];
    expect(eligibleAgents(all, 'p1')).toHaveLength(0);
  });
});

describe('pickLeastLoaded', () => {
  const agents = [staff({ username: 'amy' }), staff({ username: 'bob' }), staff({ username: 'cid' })];

  it('picks the agent with the fewest open tickets', () => {
    const loads = new Map([['amy', 3], ['bob', 1], ['cid', 5]]);
    expect(pickLeastLoaded(agents, loads)!.username).toBe('bob');
  });

  it('treats an absent agent as zero load', () => {
    const loads = new Map([['amy', 2]]); // bob & cid unseen ⇒ 0
    expect(pickLeastLoaded(agents, loads)!.username).toBe('bob'); // username tie-break (bob < cid)
  });

  it('breaks ties deterministically by username asc', () => {
    expect(pickLeastLoaded(agents, new Map())!.username).toBe('amy');
  });

  it('returns null for an empty pool', () => {
    expect(pickLeastLoaded([], new Map())).toBeNull();
  });
});

describe('ticket-repo load methods (PGlite)', () => {
  let db: Db;
  let n = 0;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'p1');
    n = 0;
  });

  const makeTicket = (over: { assignTo?: string; status?: 'resolved' | 'closed' } = {}) =>
    (async () => {
      const repo = createTicketRepo(db);
      const t = await repo.createTicket({
        id: `tk_${++n}`, partnerId: 'p1', kind: 'customer',
        customerPhone: '15551230000', subject: 's', body: 'b',
      });
      if (over.assignTo) await repo.assign(t.id, over.assignTo);
      if (over.status) await repo.updateStatus(t.id, over.status);
      return t;
    })();

  it('openTicketCountsByAssignee counts only OPEN, assigned tickets', async () => {
    await makeTicket({ assignTo: 'amy' });
    await makeTicket({ assignTo: 'amy' });
    await makeTicket({ assignTo: 'bob' });
    await makeTicket(); // unassigned ⇒ not counted
    await makeTicket({ assignTo: 'amy', status: 'resolved' }); // resolved ⇒ not counted
    await makeTicket({ assignTo: 'bob', status: 'closed' }); // closed ⇒ not counted
    const counts = await createTicketRepo(db).openTicketCountsByAssignee();
    expect(counts.get('amy')).toBe(2);
    expect(counts.get('bob')).toBe(1);
    expect(counts.has('')).toBe(false);
  });

  it('assignIfUnassigned assigns only when unassigned + open, and is idempotent', async () => {
    const repo = createTicketRepo(db);
    const t = await makeTicket();
    expect(await repo.assignIfUnassigned(t.id, 'amy')).toBe(true);
    expect((await repo.getTicket(t.id))!.assignedTo).toBe('amy');
    // already assigned ⇒ refuses, keeps the first assignee
    expect(await repo.assignIfUnassigned(t.id, 'bob')).toBe(false);
    expect((await repo.getTicket(t.id))!.assignedTo).toBe('amy');
  });

  it('assignIfUnassigned refuses a resolved/closed ticket', async () => {
    const t = await makeTicket({ status: 'closed' });
    expect(await createTicketRepo(db).assignIfUnassigned(t.id, 'amy')).toBe(false);
  });
});
