import { describe, it, expect, beforeEach, vi } from 'vitest';

// Pass-through spy on logWarn so the body reader's warning fields can be pinned.
const logSpy = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  logSpy.logWarn.mockImplementation(real.logWarn);
  return { ...real, logWarn: logSpy.logWarn };
});
import { freshDb, seedPartner } from './helpers-db';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import type { Db } from '@/db/client';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { tickets, ticketMessages } from '@/db/schema';
import { EnvKeyProvider, EnvKeyRing, aadFor, encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';

let db: Db;
let repo: TicketRepo;
let n = 0;
const tid = () => `tk_${++n}`;

beforeEach(async () => {
  db = await freshDb();
  repo = createTicketRepo(db);
  await seedPartner(db, 'p1');
  await seedPartner(db, 'p2');
});

describe('ticket-repo — create + read', () => {
  it('creates a customer ticket with its first message in one shot', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15551230000',
      subject: 'Where is my money?', body: 'My transfer to Anita has not arrived.',
    });
    expect(t.status).toBe('open');
    expect(t.priority).toBe('normal');
    const msgs = await repo.listMessages(t.id, { includeInternal: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].actorType).toBe('customer');
    expect(msgs[0].actorId).toBe('15551230000');
  });

  it('creates an internal (employee question) ticket attributed to the staff member', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'default', kind: 'internal', openedBy: 'support1',
      subject: 'How do I handle a chargeback question?', body: 'Customer asked about chargebacks.',
    });
    expect(t.kind).toBe('internal');
    expect(t.customerPhone).toBe('');
    expect(t.openedBy).toBe('support1');
    const msgs = await repo.listMessages(t.id, { includeInternal: true });
    expect(msgs[0].actorType).toBe('staff');
  });

  it('getOwnedTicket is 404-never-403: out-of-scope partner reads null', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '15551230000',
      subject: 's', body: 'b',
    });
    expect(await repo.getOwnedTicket('p1', t.id)).not.toBeNull();
    expect(await repo.getOwnedTicket('p2', t.id)).toBeNull();
  });
});

describe('ticket-repo — tenant + customer scoping', () => {
  it('listTickets scoped by partner never returns another tenant', async () => {
    await repo.createTicket({ id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '1', subject: 'a', body: 'a' });
    await repo.createTicket({ id: tid(), partnerId: 'p2', kind: 'customer', customerPhone: '2', subject: 'b', body: 'b' });
    const p1 = await repo.listTickets({ partnerId: 'p1' });
    expect(p1).toHaveLength(1);
    expect(p1[0].partnerId).toBe('p1');
    // platform view (no partnerId) sees both
    expect(await repo.listTickets({})).toHaveLength(2);
  });

  it('listByCustomer returns only that phone, customer kind only', async () => {
    await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15551230000', subject: 'mine', body: 'x' });
    await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15559990000', subject: 'theirs', body: 'x' });
    await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'internal', openedBy: 's1', subject: 'internal', body: 'x' });
    const mine = await repo.listByCustomer('15551230000');
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe('mine');
  });

  it('CUSTOMER thread reads NEVER include internal notes', async () => {
    const t = await repo.createTicket({
      id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '15551230000',
      subject: 's', body: 'customer message',
    });
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'public reply' });
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'SECRET internal note', internal: true });
    const customerView = await repo.listMessages(t.id, { includeInternal: false });
    expect(customerView.map((m) => m.body)).toEqual(['customer message', 'public reply']);
    const staffView = await repo.listMessages(t.id, { includeInternal: true });
    expect(staffView).toHaveLength(3);
  });
});

describe('ticket-repo — lifecycle', () => {
  it('status transitions: open→pending→waiting_admin→resolved→closed; closed is terminal', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    expect((await repo.updateStatus(t.id, 'pending'))?.status).toBe('pending');
    expect((await repo.updateStatus(t.id, 'waiting_admin'))?.status).toBe('waiting_admin');
    expect((await repo.updateStatus(t.id, 'resolved'))?.status).toBe('resolved');
    const closed = await repo.updateStatus(t.id, 'closed');
    expect(closed?.status).toBe('closed');
    expect(closed?.closedAt).toBeTruthy();
    // terminal: nothing moves a closed ticket
    expect(await repo.updateStatus(t.id, 'open')).toBeNull();
    expect(await repo.assign(t.id, 'sup1')).toBeNull();
  });

  it('same-state transition is a no-op returning null', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    expect(await repo.updateStatus(t.id, 'open')).toBeNull();
  });

  it('assign + appendMessage bump updatedAt (queue ordering + stamp)', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    const before = (await repo.getTicket(t.id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await repo.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'r' });
    const after = (await repo.getTicket(t.id))!.updatedAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('setTriage stores AI/staff category + priority', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    await repo.setTriage(t.id, { category: 'refund', priority: 'urgent' });
    const read = await repo.getTicket(t.id);
    expect(read?.category).toBe('refund');
    expect(read?.priority).toBe('urgent');
  });
});

describe('ticket-repo — aggregates', () => {
  it('countsByStatus + ticketStamp change when tickets move', async () => {
    const t = await repo.createTicket({ id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '1', subject: 's', body: 'b' });
    await repo.createTicket({ id: tid(), partnerId: 'p1', kind: 'customer', customerPhone: '2', subject: 's2', body: 'b' });
    expect((await repo.countsByStatus('p1')).open).toBe(2);
    const stamp1 = await repo.ticketStamp('p1');
    await new Promise((r) => setTimeout(r, 5));
    await repo.updateStatus(t.id, 'resolved');
    const counts = await repo.countsByStatus('p1');
    expect(counts.open).toBe(1);
    expect(counts.resolved).toBe(1);
    expect(await repo.ticketStamp('p1')).not.toBe(stamp1);
    // scoped stamp ignores other tenants
    expect(await repo.ticketStamp('p2')).toBe('0|');
  });
});

// Program-Fix 45 P3 — the ticket_messages.body READER. P3 writes plaintext
// bodies exactly as before; the reader also opens a v2 blob sealed for THIS
// message row (what P4 will write). Bodies are customer-authored, so the reader
// opens ONLY v2 under `ticket_messages|body|<id>`: a pasted v1 blob (which opens
// under any context) or a blob sealed for another row passes through as text.
describe('ticket-repo — body reader (fix 45 P3)', () => {
  const KEY = Buffer.alloc(32, 7);
  const OTHER = Buffer.alloc(32, 9);
  const provider = new EnvKeyProvider(KEY);

  async function firstMessageRow(ticketId: string) {
    const rows = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticketId));
    return rows[0];
  }

  async function setBody(id: number, body: string) {
    await db.update(ticketMessages).set({ body }).where(eq(ticketMessages.id, id));
  }

  it('pins the ticket body AAD string', () => {
    expect(aadFor(ctx.ticketMessage(42))).toBe('v2|k0|ticket_messages|body|42');
    expect(aadFor(ctx.ticketMessage('42'))).toBe('v2|k0|ticket_messages|body|42');
  });

  // Program-Fix 45 P4 flips this golden: new bodies are sealed at rest as a v2
  // blob bound to their own message row, never stored as plaintext.
  it('GOLDEN (P4): createTicket and appendMessage store a v2 blob sealed for the row id, never the plaintext', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    const body = 'My transfer — नमस्ते 🌍 — has not arrived.';
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body });
    const appended = await r.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'reply v2.k0.a.b.c.d' });
    const raw = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id));
    expect(raw).toHaveLength(2);
    const opened = raw.map((m) => {
      expect(m.body).toMatch(/^v2\.k0\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{80}\.[A-Za-z0-9_-]+$/);
      expect(m.body).not.toContain('arrived');
      return openByHand(m.body, KEY, `v2|k0|ticket_messages|body|${m.id}`);
    });
    expect(opened.sort()).toEqual([body, 'reply v2.k0.a.b.c.d'].sort());
    expect(appended.body).toBe('reply v2.k0.a.b.c.d');
    expect(appended.id).toBe(raw.find((m) => m.id === appended.id)?.id);
    const listed = await r.listMessages(t.id, { includeInternal: true });
    expect(listed.map((m) => m.body).sort()).toEqual([body, 'reply v2.k0.a.b.c.d'].sort());
  });

  it('opens a v2 body sealed for its own row', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'x' });
    const row = await firstMessageRow(t.id);
    await setBody(row.id, encryptField('sealed body', provider, ctx.ticketMessage(row.id)));
    const msgs = await r.listMessages(t.id, { includeInternal: true });
    expect(msgs[0].body).toBe('sealed body');
  });

  it('opens a k1 body when the ring holds k1', async () => {
    const ring = new EnvKeyRing(KEY, `k1:${OTHER.toString('hex')}`);
    const r = createTicketRepo(db, { cryptoProvider: ring });
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'x' });
    const row = await firstMessageRow(t.id);
    // Seal a k1 blob by hand (the P3 writer refuses any kid but k0).
    const k1Blob = sealK1(OTHER, 'ring body', aadFor(ctx.ticketMessage(row.id), 'k1'));
    await setBody(row.id, k1Blob);
    expect((await r.listMessages(t.id, { includeInternal: true }))[0].body).toBe('ring body');
  });

  it('a v2 body sealed for ANOTHER row falls back to the raw text (never throws)', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'x' });
    const row = await firstMessageRow(t.id);
    const moved = encryptField('someone else', provider, ctx.ticketMessage(row.id + 1000));
    await setBody(row.id, moved);
    expect((await r.listMessages(t.id, { includeInternal: true }))[0].body).toBe(moved);
  });

  it('a pasted v1 blob is NEVER decrypted (v1 opens under any context)', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    const v1 = encryptField('a leaked value', provider);
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: v1 });
    expect((await r.listMessages(t.id, { includeInternal: true }))[0].body).toBe(v1);
  });

  it('envelope-shaped garbage and a wrong key fall back to the raw text', async () => {
    const r = createTicketRepo(db, { cryptoProvider: new EnvKeyProvider(OTHER) });
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'v2.k0.aa.bb.cc.dd' });
    expect((await r.listMessages(t.id, { includeInternal: true }))[0].body).toBe('v2.k0.aa.bb.cc.dd');
    const row = await firstMessageRow(t.id);
    const sealed = encryptField('under KEY', provider, ctx.ticketMessage(row.id));
    await setBody(row.id, sealed);
    expect((await r.listMessages(t.id, { includeInternal: true }))[0].body).toBe(sealed);
  });

  it('a failed open logs ticket.body_unreadable with ONLY the message id (never the body)', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'x' });
    const row = await firstMessageRow(t.id);
    const moved = encryptField('secret-ish text', provider, ctx.ticketMessage(row.id + 1000));
    await setBody(row.id, moved);
    logSpy.logWarn.mockClear();
    await r.listMessages(t.id, { includeInternal: true });
    const calls = logSpy.logWarn.mock.calls.filter((c) => c[0] === 'ticket.body_unreadable');
    expect(calls).toHaveLength(1);
    const [, message, fields] = calls[0];
    expect(Object.keys(fields as object)).toEqual(['messageId']);
    expect((fields as { messageId: number }).messageId).toBe(row.id);
    expect(JSON.stringify([message, fields])).not.toContain(moved);
    expect(JSON.stringify([message, fields])).not.toContain('secret-ish text');
  });

  it('plain text never logs', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    logSpy.logWarn.mockClear();
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'hello' });
    await r.listMessages(t.id, { includeInternal: true });
    expect(logSpy.logWarn.mock.calls.filter((c) => c[0] === 'ticket.body_unreadable')).toHaveLength(0);
  });

  it('inside a caller\'s transaction, a seal failure rolls back the caller\'s other writes too', async () => {
    const ok = createTicketRepo(db, { cryptoProvider: provider });
    const t = await ok.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'first' });
    const broken = { wrapDataKey: () => { throw new Error('kms down'); }, unwrapDataKey: () => { throw new Error('kms down'); } };
    await expect(
      db.transaction(async (tx) => {
        await tx.update(tickets).set({ subject: 'changed in the same tx' }).where(eq(tickets.id, t.id));
        await createTicketRepo(tx, { cryptoProvider: broken }).appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'never' });
      }),
    ).rejects.toThrow();
    expect((await ok.getTicket(t.id))?.subject).toBe('s');
    expect(await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id))).toHaveLength(1);

    // …and the happy path inside a caller's tx commits a sealed row.
    await db.transaction(async (tx) => {
      await createTicketRepo(tx, { cryptoProvider: provider }).appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'in tx' });
    });
    const rows = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.body.startsWith('v2.k0.'))).toBe(true);
    expect((await ok.listMessages(t.id, { includeInternal: true })).map((m) => m.body)).toEqual(['first', 'in tx']);
  });

  it('legacy plaintext rows (written before P4) read back unchanged', async () => {
    const r = createTicketRepo(db, { cryptoProvider: provider });
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'x' });
    await db.insert(ticketMessages).values({ ticketId: t.id, actorType: 'customer', actorId: '1', body: 'legacy plain body' });
    const bodies = (await r.listMessages(t.id, { includeInternal: true })).map((m) => m.body);
    expect(bodies).toContain('legacy plain body');
    expect(bodies).toContain('x');
  });

  it('the default provider (env key) seals and reads back', async () => {
    const r = createTicketRepo(db);
    const t = await r.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'env sealed' });
    const row = await firstMessageRow(t.id);
    expect(row.body.startsWith('v2.k0.')).toBe(true);
    expect((await r.listMessages(t.id, { includeInternal: true }))[0].body).toBe('env sealed');
  });

  it('a seal failure rolls the whole ticket back (no plaintext, no half-written ticket)', async () => {
    const broken = {
      wrapDataKey: () => {
        throw new Error('kms down');
      },
      unwrapDataKey: () => {
        throw new Error('kms down');
      },
    };
    const r = createTicketRepo(db, { cryptoProvider: broken });
    const id = tid();
    await expect(
      r.createTicket({ id, partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'never stored' }),
    ).rejects.toThrow();
    expect(await r.getTicket(id)).toBeNull();
    const all = await db.select().from(ticketMessages);
    expect(all.some((m) => m.body === 'never stored' || m.body === '')).toBe(false);

    const ok = createTicketRepo(db, { cryptoProvider: provider });
    const t = await ok.createTicket({ id: tid(), partnerId: 'default', kind: 'customer', customerPhone: '1', subject: 's', body: 'first' });
    await expect(r.appendMessage({ ticketId: t.id, actorType: 'staff', actorId: 'sup1', body: 'never appended' })).rejects.toThrow();
    const after = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id));
    expect(after).toHaveLength(1);
  });
});

function openByHand(blob: string, masterKey: Buffer, aad: string): string {
  const [ivS, tagS, wS, ctS] = blob.split('.').slice(-4);
  const wrapped = Buffer.from(wS, 'base64url');
  const w = createDecipheriv('aes-256-gcm', masterKey, wrapped.subarray(0, 12));
  w.setAuthTag(wrapped.subarray(12, 28));
  const dek = Buffer.concat([w.update(wrapped.subarray(28)), w.final()]);
  const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(ivS, 'base64url'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ctS, 'base64url')), d.final()]).toString('utf8');
}

function sealK1(masterKey: Buffer, plain: string, aad: string): string {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  const tag = c.getAuthTag();
  const wrapped = new EnvKeyProvider(masterKey).wrapDataKey(dek);
  return ['v2', 'k1', iv, tag, wrapped, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}
