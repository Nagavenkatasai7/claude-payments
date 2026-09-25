import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';
import { conversationMessageId, createConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import { viewConversation } from '@/lib/conversation-view';

// Partner-Demo R3b: the audited staff read behind the customer page's
// Conversation panel. Every read that shows text writes ONE conversation.view
// audit row first (counts + channel only, keyed subject); no row ⇒ no text.

let db: Db;
const PHONE = '15551234567';

const customer = (partnerId: string): Customer => ({
  senderPhone: PHONE,
  firstSeenAt: '2026-01-01T00:00:00Z',
  kycStatus: 'pending',
  senderCountry: 'US',
  partnerId,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const platformAdmin = { username: 'root', role: 'admin' as const };
const acmeAdmin = { username: 'acme-admin', role: 'admin' as const, partnerId: 'acme' };
const betaAdmin = { username: 'beta-admin', role: 'admin' as const, partnerId: 'beta' };

async function auditRows() {
  const res = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'conversation.view' ORDER BY id`);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'beta');
  const log = createConversationLogRepo(db);
  await log.append({ id: conversationMessageId('in', 1), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'in', text: 'acme private hi' });
  await log.append({ id: conversationMessageId('out', 1), partnerId: 'acme', phone: PHONE, channel: 'wa', direction: 'out', text: 'acme reply' });
  await log.append({ partnerId: 'acme', phone: PHONE, channel: 'web', direction: 'in', text: 'acme web' });
});

describe('viewConversation', () => {
  it('returns the thread and writes ONE conversation.view row (keyed subject, counts + channels, no text, no phone)', async () => {
    const entries = await viewConversation(db, platformAdmin, customer('acme'));
    expect(entries?.map((m) => m.text)).toEqual(expect.arrayContaining(['acme private hi', 'acme reply', 'acme web']));
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'root', actor_type: 'staff', subject_id: auditSubjectId('acme', PHONE) });
    expect(rows[0].meta).toEqual({ count: 3, channel: 'wa+web', unreadable: 0 });
    const s = JSON.stringify(rows[0]);
    for (const v of ['acme private', 'acme reply', PHONE]) expect(s).not.toContain(v);
  });

  it("a partner admin reads their own tenant's thread", async () => {
    expect((await viewConversation(db, acmeAdmin, customer('acme')))?.length).toBe(3);
    expect(await auditRows()).toHaveLength(1);
  });

  it("cross-tenant: B's admin with the SAME phone sees none of A's messages, and no audit row is written for A", async () => {
    expect(await viewConversation(db, betaAdmin, customer('beta'))).toEqual([]);
    // Replaying A's customer as B's staff is refused before any read.
    expect(await viewConversation(db, betaAdmin, customer('acme'))).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('non-admin roles (agent, support) get null: no read, no audit row', async () => {
    expect(await viewConversation(db, { username: 'ag', role: 'agent' }, customer('acme'))).toBeNull();
    expect(await viewConversation(db, { username: 'sp', role: 'support' }, customer('acme'))).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('an empty thread shows nothing and writes no audit row', async () => {
    await seedPartner(db, 'gamma');
    expect(await viewConversation(db, platformAdmin, customer('gamma'))).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('counts unreadable (tampered) rows in the audit meta', async () => {
    await db.execute(sql`UPDATE conversation_messages SET direction = 2 WHERE id = ${conversationMessageId('in', 1)}::uuid`);
    await viewConversation(db, platformAdmin, customer('acme'));
    expect((await auditRows())[0].meta).toEqual({ count: 3, channel: 'wa+web', unreadable: 1 });
  });

  it('when the audit write fails, it throws and returns no text', async () => {
    await db.execute(sql`ALTER TABLE audit_events ADD CONSTRAINT r3b_no_view CHECK (action <> 'conversation.view')`);
    try {
      await expect(viewConversation(db, platformAdmin, customer('acme'))).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE audit_events DROP CONSTRAINT r3b_no_view`);
    }
  });
});
