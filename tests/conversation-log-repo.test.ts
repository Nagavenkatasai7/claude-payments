import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import {
  conversationMessageId,
  createConversationLogRepo,
  UNREADABLE_BODY,
} from '@/db/repos/conversation-log-repo';
import { auditSubjectId, threadKeyFor } from '@/lib/customer-ref';

// Partner-Demo R3b: the sealed, permanent conversation log (table 0025).
// Bodies are v2 field-crypto envelopes bound to (tenant, row id, thread,
// channel, direction); thread_key is the raw auditSubjectId HMAC.

let db: Db;
const PHONE = '15551234567';

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> =>
  ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
});

describe('threadKeyFor — the thread key is the audit subject HMAC', () => {
  it("'cust:' + hex(thread_key) === auditSubjectId (the pii.view join invariant)", () => {
    const tk = threadKeyFor('acme', PHONE);
    expect(tk.length).toBe(32);
    expect(`cust:${tk.toString('hex')}`).toBe(auditSubjectId('acme', PHONE));
  });
});

describe('conversationMessageId — deterministic WhatsApp ids', () => {
  it('is a stable RFC 4122-shaped uuid per (direction, outbox row id), distinct across both', () => {
    const a = conversationMessageId('in', 42);
    expect(a).toBe(conversationMessageId('in', 42));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(conversationMessageId('out', 42)).not.toBe(a);
    expect(conversationMessageId('in', 43)).not.toBe(a);
  });
});

describe('createConversationLogRepo', () => {
  it('seals before INSERT: no plaintext body or phone in the row, and listThread round-trips', async () => {
    const log = createConversationLogRepo(db);
    const id = conversationMessageId('in', 1);
    expect(await log.append({ id, partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'send $200 to mom' })).toBe(true);

    const [raw] = await rows(sql`SELECT * FROM conversation_messages`);
    expect(String(raw.body_enc)).toMatch(/^v2\.k0\./);
    expect(JSON.stringify(raw)).not.toContain('send $200');
    expect(JSON.stringify(raw)).not.toContain(PHONE);
    expect(Number(raw.channel)).toBe(1);
    expect(Number(raw.direction)).toBe(1);
    const [len] = await rows(sql`SELECT octet_length(thread_key)::int AS n, encode(thread_key, 'hex') AS hex FROM conversation_messages`);
    expect(len.n).toBe(32);
    expect(len.hex).toBe(threadKeyFor('acme', PHONE).toString('hex'));

    const thread = await log.listThread('acme', PHONE);
    expect(thread).toEqual([
      expect.objectContaining({ id, channel: 'wa', direction: 'in', text: 'send $200 to mom', unreadable: false }),
    ]);
  });

  it('a retried append with the same id is a no-op (ON CONFLICT DO NOTHING) — one row, first body kept', async () => {
    const log = createConversationLogRepo(db);
    const id = conversationMessageId('out', 7);
    expect(await log.append({ id, partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'out', text: 'first' })).toBe(true);
    expect(await log.append({ id, partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'out', text: 'first' })).toBe(false);
    const [n] = await rows(sql`SELECT count(*)::int AS n FROM conversation_messages`);
    expect(n.n).toBe(1);
  });

  it('orders oldest first; equal created_at puts the inbound before the reply', async () => {
    const log = createConversationLogRepo(db);
    // Reply inserted FIRST, both inside one transaction (same now()).
    await db.transaction(async (tx) => {
      const l = createConversationLogRepo(tx);
      await l.append({ id: conversationMessageId('out', 9), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'out', text: 'reply' });
      await l.append({ id: conversationMessageId('in', 9), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'question' });
    });
    await log.append({ id: conversationMessageId('in', 10), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'later' });
    expect((await log.listThread('acme', PHONE)).map((m) => m.text)).toEqual(['question', 'reply', 'later']);
  });

  it('limit keeps the NEWEST n messages, still oldest first', async () => {
    const log = createConversationLogRepo(db);
    for (let i = 1; i <= 5; i++) {
      await log.append({ id: conversationMessageId('in', i), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: `m${i}` });
      await db.execute(sql`UPDATE conversation_messages SET created_at = now() + make_interval(secs => ${i}) WHERE id = ${conversationMessageId('in', i)}::uuid`);
    }
    expect((await log.listThread('acme', PHONE, { limit: 2 })).map((m) => m.text)).toEqual(['m4', 'm5']);
  });

  it('web channel rows are logged and listed under the same thread; a channel filter narrows', async () => {
    const log = createConversationLogRepo(db);
    await log.append({ partnerId: 'acme', phone: PHONE, channel: 'web', direction: 'in', text: 'web hi' });
    await log.append({ id: conversationMessageId('in', 1), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'wa hi' });
    expect((await log.listThread('acme', PHONE)).map((m) => m.text).sort()).toEqual(['wa hi', 'web hi']);
    expect((await log.listThread('acme', PHONE, { channel: 'web' })).map((m) => m.text)).toEqual(['web hi']);
  });

  describe('tenant isolation (cross-tenant reads)', () => {
    it("the SAME phone under partner B sees none of partner A's messages", async () => {
      const log = createConversationLogRepo(db);
      await log.append({ id: conversationMessageId('in', 1), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'acme secret' });
      expect(await log.listThread('beta', PHONE)).toEqual([]);
      expect(await log.listThread('acme', '15550000000')).toEqual([]);
      expect(await log.listThread('ghost', PHONE)).toEqual([]);
    });
  });

  describe('tamper: a sealed body opens ONLY in the row it was sealed for', () => {
    async function seedOne(): Promise<string> {
      const id = conversationMessageId('in', 1);
      await createConversationLogRepo(db).append({ id, partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'tamper me' });
      return id;
    }

    it('flipping the direction makes the row unreadable (never the original text)', async () => {
      const id = await seedOne();
      await db.execute(sql`UPDATE conversation_messages SET direction = 2 WHERE id = ${id}::uuid`);
      const thread = await createConversationLogRepo(db).listThread('acme', PHONE);
      expect(thread).toEqual([expect.objectContaining({ id, direction: 'out', unreadable: true, text: UNREADABLE_BODY })]);
      expect(JSON.stringify(thread)).not.toContain('tamper me');
    });

    it('flipping the channel makes the row unreadable', async () => {
      const id = await seedOne();
      await db.execute(sql`UPDATE conversation_messages SET channel = 2 WHERE id = ${id}::uuid`);
      const [m] = await createConversationLogRepo(db).listThread('acme', PHONE);
      expect(m.unreadable).toBe(true);
    });

    it('re-attributing the row to another thread (same tenant) never reveals it there', async () => {
      const id = await seedOne();
      const other = threadKeyFor('acme', '15550000000');
      await db.execute(sql`UPDATE conversation_messages SET thread_key = ${other} WHERE id = ${id}::uuid`);
      const log = createConversationLogRepo(db);
      expect(await log.listThread('acme', PHONE)).toEqual([]);
      const moved = await log.listThread('acme', '15550000000');
      expect(moved).toEqual([expect.objectContaining({ id, unreadable: true, text: UNREADABLE_BODY })]);
    });

    it("moving a row to another tenant (partner + that tenant's thread key) never reveals it there", async () => {
      const id = await seedOne();
      await db.execute(
        sql`UPDATE conversation_messages SET partner_id = 'beta', thread_key = ${threadKeyFor('beta', PHONE)} WHERE id = ${id}::uuid`,
      );
      const [m] = await createConversationLogRepo(db).listThread('beta', PHONE);
      expect(m).toEqual(expect.objectContaining({ unreadable: true, text: UNREADABLE_BODY }));
    });

    it("copying one row's body into another row does not open there", async () => {
      const log = createConversationLogRepo(db);
      const a = await seedOne();
      const b = conversationMessageId('in', 2);
      await log.append({ id: b, partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'innocent' });
      await db.execute(
        sql`UPDATE conversation_messages SET body_enc = (SELECT body_enc FROM conversation_messages WHERE id = ${a}::uuid) WHERE id = ${b}::uuid`,
      );
      const byId = new Map((await log.listThread('acme', PHONE)).map((m) => [m.id, m]));
      expect(byId.get(a)?.text).toBe('tamper me');
      expect(byId.get(b)?.unreadable).toBe(true);
    });
  });
});
