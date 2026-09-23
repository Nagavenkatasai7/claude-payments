import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import type { Db } from '@/db/client';
import type { TicketMessage } from '@/lib/types';
import {
  FIRST_RESPONSE_DUE_HOURS,
  firstResponseAt,
  slaState,
  slaDigestKey,
  formatSlaDuration,
} from '@/lib/ticket-sla';

// Program-Fix 49C (tickets-01): the INTERNAL, staff-facing first-response SLA.
// No customer-facing promise (fix 34). The first response is the first PUBLIC
// staff message: an internal note is not a response, a system line is not a
// response, and the customer's own messages are not.

const HOUR = 3_600_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

type Msg = Pick<TicketMessage, 'actorType' | 'internal' | 'createdAt'>;
const msg = (actorType: Msg['actorType'], internal: boolean, createdAt: string): Msg => ({ actorType, internal, createdAt });

describe('ticket-sla — targets', () => {
  it('first-response targets are urgent 4h, normal 24h, low 72h', () => {
    expect(FIRST_RESPONSE_DUE_HOURS).toEqual({ urgent: 4, normal: 24, low: 72 });
  });
});

describe('ticket-sla — firstResponseAt', () => {
  it('an internal note is not a response', () => {
    expect(firstResponseAt([msg('customer', false, ago(5 * HOUR)), msg('staff', true, ago(4 * HOUR))])).toBeNull();
  });

  it('a system message is not a response', () => {
    expect(firstResponseAt([msg('customer', false, ago(5 * HOUR)), msg('system', false, ago(4 * HOUR))])).toBeNull();
  });

  it('the customer\'s own messages are not a response', () => {
    expect(firstResponseAt([msg('customer', false, ago(5 * HOUR)), msg('customer', false, ago(1 * HOUR))])).toBeNull();
  });

  it('returns the EARLIEST public staff message, whatever the input order', () => {
    const early = ago(3 * HOUR);
    const late = ago(1 * HOUR);
    expect(firstResponseAt([msg('staff', false, late), msg('customer', false, ago(5 * HOUR)), msg('staff', false, early)])).toBe(early);
  });
});

describe('ticket-sla — slaState', () => {
  const t = (priority: 'urgent' | 'normal' | 'low', createdMsAgo: number, status: 'open' | 'pending' | 'waiting_admin' | 'resolved' | 'closed' = 'open') => ({
    priority, status, createdAt: ago(createdMsAgo),
  });

  it('unanswered and inside the window → ok', () => {
    expect(slaState(t('normal', 1 * HOUR), null, now).state).toBe('ok');
  });

  it('unanswered in the last quarter of the window → due_soon', () => {
    expect(slaState(t('urgent', 3.5 * HOUR), null, now).state).toBe('due_soon');
    expect(slaState(t('normal', 20 * HOUR), null, now).state).toBe('due_soon');
  });

  it('unanswered past the target → breached (urgent 4h, low 72h)', () => {
    expect(slaState(t('urgent', 5 * HOUR), null, now).state).toBe('breached');
    expect(slaState(t('low', 71 * HOUR), null, now).state).toBe('due_soon');
    expect(slaState(t('low', 73 * HOUR), null, now).state).toBe('breached');
  });

  it('answered on time → met; answered late → late', () => {
    expect(slaState(t('urgent', 10 * HOUR), ago(8 * HOUR), now).state).toBe('met');
    expect(slaState(t('urgent', 10 * HOUR), ago(1 * HOUR), now).state).toBe('late');
  });

  it('unanswered but resolved/closed → inactive (no SLA clock)', () => {
    expect(slaState(t('urgent', 100 * HOUR, 'resolved'), null, now).state).toBe('inactive');
    expect(slaState(t('urgent', 100 * HOUR, 'closed'), null, now).state).toBe('inactive');
  });

  it('reports the due time and the age', () => {
    const s = slaState(t('normal', 2 * HOUR), null, now);
    expect(s.ageMs).toBe(2 * HOUR);
    expect(s.dueAt.getTime()).toBe(now.getTime() - 2 * HOUR + 24 * HOUR);
  });
});

describe('ticket-sla — digest key', () => {
  it('is one key per UTC day', () => {
    expect(slaDigestKey(new Date('2026-09-23T23:59:59.000Z'))).toBe('ticketsla:2026-09-23');
    expect(slaDigestKey(new Date('2026-09-24T00:00:00.000Z'))).toBe('ticketsla:2026-09-24');
  });
});

describe('ticket-sla — pill duration', () => {
  it('formats minutes, hours (under 2 days) and days', () => {
    expect(formatSlaDuration(-5)).toBe('0m');
    expect(formatSlaDuration(45 * 60_000)).toBe('45m');
    expect(formatSlaDuration(5 * HOUR)).toBe('5h');
    expect(formatSlaDuration(47 * HOUR)).toBe('47h');
    expect(formatSlaDuration(90 * 24 * HOUR)).toBe('90d');
  });
});

// ── repo reads (PGlite) ──────────────────────────────────────────────────────

let db: Db;
let repo: TicketRepo;
let n = 0;
const tid = () => `tk_sla_${++n}`;

async function ticket(opts: {
  partnerId?: string;
  priority?: 'urgent' | 'normal' | 'low';
  createdMsAgo: number;
  status?: 'open' | 'pending' | 'waiting_admin' | 'resolved' | 'closed';
  kind?: 'customer' | 'internal';
}): Promise<string> {
  const id = tid();
  const kind = opts.kind ?? 'customer';
  await repo.createTicket({
    id, partnerId: opts.partnerId ?? 'p1', kind,
    ...(kind === 'customer' ? { customerPhone: '15550000000' } : { openedBy: 'support1' }),
    subject: 'Help', body: 'Where is it?', priority: opts.priority ?? 'normal',
  });
  const created = new Date(Date.now() - opts.createdMsAgo);
  await db.execute(sql`UPDATE tickets SET created_at = ${created.toISOString()}, status = ${opts.status ?? 'open'} WHERE id = ${id}`);
  await db.execute(sql`UPDATE ticket_messages SET created_at = ${created.toISOString()} WHERE ticket_id = ${id}`);
  return id;
}

describe('ticket-repo — SLA reads', () => {
  beforeEach(async () => {
    db = await freshDb();
    repo = createTicketRepo(db);
    await seedPartner(db, 'p1');
    await seedPartner(db, 'p2');
  });

  it('firstStaffResponses: earliest PUBLIC staff message per ticket (notes and system lines ignored)', async () => {
    const a = await ticket({ createdMsAgo: 10 * HOUR });
    const b = await ticket({ createdMsAgo: 10 * HOUR });
    await repo.appendMessage({ ticketId: a, actorType: 'staff', actorId: 's1', body: 'note', internal: true });
    await repo.appendMessage({ ticketId: a, actorType: 'system', actorId: 'system', body: 'auto' });
    await repo.appendMessage({ ticketId: b, actorType: 'staff', actorId: 's1', body: 'reply' });
    const m = await repo.firstStaffResponses([a, b]);
    expect(m.has(a)).toBe(false);
    expect(typeof m.get(b)).toBe('string');
    expect(await repo.firstStaffResponses([])).toEqual(new Map());
  });

  it('listSlaBreaches: active, unanswered, overdue CUSTOMER tickets only, oldest first, with a total', async () => {
    const urgentOld = await ticket({ priority: 'urgent', createdMsAgo: 90 * 24 * HOUR });
    const normalOld = await ticket({ priority: 'normal', createdMsAgo: 30 * HOUR, status: 'waiting_admin' });
    await ticket({ priority: 'normal', createdMsAgo: 2 * HOUR });                       // inside window
    await ticket({ priority: 'low', createdMsAgo: 48 * HOUR });                         // inside 72h
    await ticket({ priority: 'urgent', createdMsAgo: 10 * HOUR, status: 'resolved' });  // inactive
    await ticket({ priority: 'urgent', createdMsAgo: 10 * HOUR, kind: 'internal' });    // not customer
    const answered = await ticket({ priority: 'urgent', createdMsAgo: 10 * HOUR });
    await repo.appendMessage({ ticketId: answered, actorType: 'staff', actorId: 's1', body: 'on it' });
    const noted = await ticket({ priority: 'urgent', createdMsAgo: 10 * HOUR, partnerId: 'p2' });
    await repo.appendMessage({ ticketId: noted, actorType: 'staff', actorId: 's1', body: 'note', internal: true });

    const all = await repo.listSlaBreaches({ now: new Date() });
    expect(all.total).toBe(3);
    expect(all.byPriority).toEqual({ urgent: 2, normal: 1, low: 0 });
    expect(all.oldest.map((r) => r.id)).toEqual([urgentOld, normalOld, noted]);

    const scoped = await repo.listSlaBreaches({ now: new Date(), partnerId: 'p2' });
    expect(scoped.total).toBe(1);
    expect(scoped.oldest.map((r) => r.id)).toEqual([noted]);

    const capped = await repo.listSlaBreaches({ now: new Date(), limit: 1 });
    expect(capped.total).toBe(3);
    expect(capped.oldest).toHaveLength(1);
  });
});
