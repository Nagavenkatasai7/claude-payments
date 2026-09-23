import { and, desc, eq, asc, sql, count, inArray, or } from 'drizzle-orm';
import { tickets, ticketMessages } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { HUMAN_HELP_CATEGORY, HUMAN_HELP_SUBJECT } from '@/lib/ticket-category';
import { FIRST_RESPONSE_DUE_HOURS } from '@/lib/ticket-sla';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import { logWarn } from '@/lib/log';
import type {
  PartnerId,
  Ticket,
  TicketKind,
  TicketMessage,
  TicketPriority,
  TicketStatus,
} from '@/lib/types';

// ticket-repo — the support-ticket ledger (customer queries + internal
// employee questions, discriminated by kind). Tenant isolation is app-level
// as everywhere: partner-facing reads take partnerId in the WHERE; customer
// reads are scoped by customer_phone AND never include internal notes.
// Bodies are SEALED at rest since Program-Fix 45 P4 (a v2 blob bound to the
// message row; insertSealedMessage) and opened by the one reader
// (openTicketBody → rowToMessage), which every consumer — thread views, AI
// triage/copilot, the outbox — goes through; rows written before P4 stay
// plaintext and read back as they are;
// create-forms warn customers against posting account numbers, and any
// transfer detail joined in stays masked (default ledger reads).

type TicketRow = typeof tickets.$inferSelect;
type MessageRow = typeof ticketMessages.$inferSelect;

function rowToTicket(row: TicketRow): Ticket {
  const t: Ticket = {
    id: row.id,
    partnerId: row.partnerId,
    kind: row.kind as TicketKind,
    customerPhone: row.customerPhone,
    subject: row.subject,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.openedBy) t.openedBy = row.openedBy;
  if (row.transferId) t.transferId = row.transferId;
  if (row.category) t.category = row.category;
  if (row.assignedTo) t.assignedTo = row.assignedTo;
  if (row.closedAt) t.closedAt = row.closedAt.toISOString();
  return t;
}

/**
 * Program-Fix 45 P3: the ticket body READER. Rows written before P4 hold
 * plaintext; since P4 every new body is sealed as a v2 blob under
 * `ctx.ticketMessage(<row id>)` (insertSealedMessage). Bodies are customer-authored, so
 * this opens ONLY a v2 envelope, and only under the row's OWN id: a pasted v1
 * blob (which opens under any context) or a blob sealed for another row is
 * shown as the text it is. Anything else — plain text, or an envelope that
 * fails to open — falls back to the raw value; a failed open logs a PII-free
 * warning (the message id only). The key is touched only for a v2-shaped body.
 */
function openTicketBody(row: MessageRow, provider?: EncryptionKeyProvider): string {
  const body = row.body;
  if (!body.startsWith('v2.') || body.split('.').length !== 6) return body;
  try {
    return decryptField(body, provider ?? defaultProvider(), ctx.ticketMessage(row.id));
  } catch (err) {
    logWarn('ticket.body_unreadable', err instanceof Error ? err.message : 'decrypt failed', { messageId: row.id });
    return body;
  }
}

function rowToMessage(
  row: MessageRow,
  provider?: EncryptionKeyProvider,
): TicketMessage {
  return {
    id: row.id,
    ticketId: row.ticketId,
    actorType: row.actorType as TicketMessage['actorType'],
    actorId: row.actorId,
    body: openTicketBody(row, provider),
    internal: row.internal,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateTicketInput {
  id: string;
  partnerId: PartnerId;
  kind: TicketKind;
  customerPhone?: string;   // required for kind 'customer'
  openedBy?: string;        // required for kind 'internal'
  transferId?: string;
  subject: string;
  priority?: TicketPriority;
  category?: string;
  body: string;             // the first message
}

export interface TicketRepoOptions {
  /** Field-crypto provider for sealed bodies (tests); default: the env key ring. */
  cryptoProvider?: EncryptionKeyProvider;
}

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };

/** Run `fn` in a transaction when we hold a Db; inside an existing tx, share it. */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

export function createTicketRepo(db: DbOrTx, opts: TicketRepoOptions = {}) {
  const toMessage = (row: MessageRow) => rowToMessage(row, opts.cryptoProvider);

  /**
   * Program-Fix 45 P4: write one message with its body SEALED at rest, bound to
   * its own row (`ctx.ticketMessage(id)`). The id is a generated identity, so
   * the row is inserted with an empty body and sealed by an UPDATE in the SAME
   * transaction (the caller's `tx`): the plaintext never reaches the table, and
   * a seal failure rolls the whole write back. Returns the stored row.
   */
  const insertSealedMessage = async (
    tx: DbOrTx,
    values: Omit<typeof ticketMessages.$inferInsert, 'body' | 'id'>,
    body: string,
  ): Promise<MessageRow> => {
    const [inserted] = await tx.insert(ticketMessages).values({ ...values, body: '' }).returning({ id: ticketMessages.id });
    const sealed = encryptField(body, opts.cryptoProvider ?? defaultProvider(), ctx.ticketMessage(inserted.id));
    const [row] = await tx
      .update(ticketMessages)
      .set({ body: sealed })
      .where(eq(ticketMessages.id, inserted.id))
      .returning();
    return row;
  };

  const repo = {
    /** Create the ticket + its first message in ONE transaction. */
    async createTicket(input: CreateTicketInput): Promise<Ticket> {
      const run = async (tx: DbOrTx) => {
        const rows = await tx
          .insert(tickets)
          .values({
            id: input.id,
            partnerId: input.partnerId,
            kind: input.kind,
            customerPhone: input.customerPhone ?? '',
            openedBy: input.openedBy ?? null,
            transferId: input.transferId ?? null,
            subject: input.subject,
            status: 'open',
            priority: input.priority ?? 'normal',
            category: input.category ?? null,
          })
          .returning();
        await insertSealedMessage(
          tx,
          {
            ticketId: input.id,
            actorType: input.kind === 'internal' ? 'staff' : 'customer',
            actorId: input.kind === 'internal' ? (input.openedBy ?? '') : (input.customerPhone ?? ''),
            internal: false,
          },
          input.body,
        );
        return rowToTicket(rows[0]);
      };
      return inTx(db, run);
    },

    async getTicket(id: string): Promise<Ticket | null> {
      const rows = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
      return rows[0] ? rowToTicket(rows[0]) : null;
    },

    /** Partner-scoped read — 404-never-403 (null for out-of-scope ids). */
    async getOwnedTicket(partnerId: PartnerId, id: string): Promise<Ticket | null> {
      const rows = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.partnerId, partnerId)))
        .limit(1);
      return rows[0] ? rowToTicket(rows[0]) : null;
    },

    /** A customer's own tickets (the /account/support list). */
    async listByCustomer(customerPhone: string, limit = 50): Promise<Ticket[]> {
      const rows = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.customerPhone, customerPhone), eq(tickets.kind, 'customer')))
        .orderBy(desc(tickets.updatedAt))
        .limit(limit);
      return rows.map(rowToTicket);
    },

    /**
     * Program-Fix 34B: the customer's OPEN help case under ONE tenant — the one
     * request_human_help reuses. Tenant-scoped in SQL (never a phone-only page
     * filtered in JS). A help case is category human_help OR the fixed help
     * subject (staff may re-categorise it; nothing updates a subject).
     */
    async findOpenHumanHelpCase(partnerId: PartnerId, customerPhone: string): Promise<Ticket | null> {
      const rows = await db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.partnerId, partnerId),
            eq(tickets.customerPhone, customerPhone),
            eq(tickets.kind, 'customer'),
            inArray(tickets.status, ['open', 'pending', 'waiting_admin']),
            or(eq(tickets.category, HUMAN_HELP_CATEGORY), eq(tickets.subject, HUMAN_HELP_SUBJECT)),
          ),
        )
        .orderBy(desc(tickets.createdAt))
        .limit(1);
      return rows[0] ? rowToTicket(rows[0]) : null;
    },

    /** Dashboard queue. partnerId undefined ⇒ platform staff see all partners. */
    async listTickets(
      opts: {
        partnerId?: PartnerId;
        kind?: TicketKind;
        status?: TicketStatus;
        assignedTo?: string;
        limit?: number;
      } = {},
    ): Promise<Ticket[]> {
      const where = [
        ...(opts.partnerId ? [eq(tickets.partnerId, opts.partnerId)] : []),
        ...(opts.kind ? [eq(tickets.kind, opts.kind)] : []),
        ...(opts.status ? [eq(tickets.status, opts.status)] : []),
        ...(opts.assignedTo ? [eq(tickets.assignedTo, opts.assignedTo)] : []),
      ];
      const rows = await db
        .select()
        .from(tickets)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(tickets.updatedAt))
        .limit(opts.limit ?? 100);
      return rows.map(rowToTicket);
    },

    /**
     * Guarded status transition: closed is terminal; everything else may move
     * to any non-equal state (support workflows legitimately bounce between
     * open/pending/waiting_admin/resolved). Returns null when the guard
     * refuses (already closed / same state / missing).
     */
    async updateStatus(id: string, status: TicketStatus): Promise<Ticket | null> {
      const rows = await db
        .update(tickets)
        .set({
          status,
          updatedAt: new Date(),
          closedAt: status === 'closed' ? new Date() : null,
        })
        .where(and(
          eq(tickets.id, id),
          sql`${tickets.status} <> 'closed'`,
          sql`${tickets.status} <> ${status}`,
        ))
        .returning();
      return rows[0] ? rowToTicket(rows[0]) : null;
    },

    async assign(id: string, assignedTo: string | null): Promise<Ticket | null> {
      const rows = await db
        .update(tickets)
        .set({ assignedTo, updatedAt: new Date() })
        .where(and(eq(tickets.id, id), sql`${tickets.status} <> 'closed'`))
        .returning();
      return rows[0] ? rowToTicket(rows[0]) : null;
    },

    /**
     * Load-balancer assign: set assignee ONLY if the ticket is still unassigned
     * and open. Returns whether it assigned. Idempotent on outbox replay and
     * NEVER overrides a manual assignment that landed first (the conditional
     * WHERE is the atomic guard). open = not resolved/closed.
     */
    async assignIfUnassigned(id: string, assignedTo: string): Promise<boolean> {
      const rows = await db
        .update(tickets)
        .set({ assignedTo, updatedAt: new Date() })
        .where(and(
          eq(tickets.id, id),
          sql`${tickets.assignedTo} IS NULL`,
          sql`${tickets.status} NOT IN ('resolved', 'closed')`,
        ))
        .returning({ id: tickets.id });
      return rows.length > 0;
    },

    /**
     * Open-ticket count per assignee (the load signal for the balancer). Counts
     * OPEN (not resolved/closed) tickets grouped by assigned_to. Global by
     * default so a platform agent's TOTAL load across partners is counted;
     * pass partnerId only when you want a single tenant's load.
     */
    async openTicketCountsByAssignee(partnerId?: PartnerId): Promise<Map<string, number>> {
      const rows = await db
        .select({ assignee: tickets.assignedTo, n: count() })
        .from(tickets)
        .where(and(
          sql`${tickets.assignedTo} IS NOT NULL`,
          sql`${tickets.status} NOT IN ('resolved', 'closed')`,
          ...(partnerId ? [eq(tickets.partnerId, partnerId)] : []),
        ))
        .groupBy(tickets.assignedTo);
      const m = new Map<string, number>();
      for (const r of rows) if (r.assignee) m.set(r.assignee, Number(r.n));
      return m;
    },

    async setTriage(id: string, fields: { category?: string; priority?: TicketPriority }): Promise<void> {
      await db
        .update(tickets)
        .set({
          ...(fields.category !== undefined ? { category: fields.category } : {}),
          ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tickets.id, id));
    },

    /** Append a message and bump the ticket's updatedAt together. */
    async appendMessage(input: {
      ticketId: string;
      actorType: TicketMessage['actorType'];
      actorId: string;
      body: string;
      internal?: boolean;
    }): Promise<TicketMessage> {
      // Program-Fix 45 P4: insert + seal + the updatedAt bump in ONE transaction.
      const row = await inTx(db, async (tx) => {
        const stored = await insertSealedMessage(
          tx,
          {
            ticketId: input.ticketId,
            actorType: input.actorType,
            actorId: input.actorId,
            internal: input.internal ?? false,
          },
          input.body,
        );
        await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, input.ticketId));
        return stored;
      });
      // Read back through the reader: proves the sealed row opens on every write.
      return toMessage(row);
    },

    /**
     * Thread reads. includeInternal=false is the CUSTOMER view — staff-only
     * notes are excluded in the WHERE, never filtered client-side.
     */
    async listMessages(ticketId: string, opts: { includeInternal: boolean }): Promise<TicketMessage[]> {
      const where = opts.includeInternal
        ? eq(ticketMessages.ticketId, ticketId)
        : and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.internal, false));
      const rows = await db
        .select()
        .from(ticketMessages)
        .where(where)
        .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
      return rows.map(toMessage);
    },

    /**
     * Program-Fix 49C: the first PUBLIC staff reply per ticket (ISO), for the
     * queue's staff-only SLA pill. One grouped read over the ids the caller
     * already scoped (ticket_messages_ticket index); tickets with no staff reply
     * are absent from the map. Internal notes and system lines never count.
     */
    async firstStaffResponses(ticketIds: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (ticketIds.length === 0) return out;
      const rows = await db
        .select({
          ticketId: ticketMessages.ticketId,
          first: sql<string>`min(${ticketMessages.createdAt})`,
        })
        .from(ticketMessages)
        .where(and(
          inArray(ticketMessages.ticketId, ticketIds),
          eq(ticketMessages.actorType, 'staff'),
          eq(ticketMessages.internal, false),
        ))
        .groupBy(ticketMessages.ticketId);
      for (const r of rows) if (r.first) out.set(r.ticketId, new Date(r.first).toISOString());
      return out;
    },

    /**
     * Program-Fix 49C: first-response SLA breaches — ACTIVE (open / pending /
     * waiting_admin) CUSTOMER tickets with no public staff reply whose target
     * (FIRST_RESPONSE_DUE_HOURS by priority) has passed. Returns the total, a
     * per-priority count and the oldest `limit` rows (ids only, no customer
     * text). partnerId undefined ⇒ platform-wide (the ops digest).
     */
    async listSlaBreaches(opts: { now: Date; partnerId?: PartnerId; limit?: number }): Promise<{
      total: number;
      byPriority: Record<TicketPriority, number>;
      oldest: Array<{ id: string; partnerId: PartnerId; priority: TicketPriority; createdAt: string }>;
    }> {
      const h = FIRST_RESPONSE_DUE_HOURS;
      const dueHours = sql`(CASE ${tickets.priority} WHEN 'urgent' THEN ${h.urgent}::int WHEN 'low' THEN ${h.low}::int ELSE ${h.normal}::int END)`;
      const rows = await db
        .select({
          id: tickets.id,
          partnerId: tickets.partnerId,
          priority: tickets.priority,
          createdAt: tickets.createdAt,
          total: sql<number>`count(*) over ()`,
          urgent: sql<number>`count(*) filter (where ${tickets.priority} = 'urgent') over ()`,
          normal: sql<number>`count(*) filter (where ${tickets.priority} = 'normal') over ()`,
          low: sql<number>`count(*) filter (where ${tickets.priority} = 'low') over ()`,
        })
        .from(tickets)
        .where(and(
          eq(tickets.kind, 'customer'),
          inArray(tickets.status, ['open', 'pending', 'waiting_admin']),
          sql`${tickets.createdAt} + make_interval(hours => ${dueHours}) < ${opts.now.toISOString()}::timestamptz`,
          sql`NOT EXISTS (SELECT 1 FROM ${ticketMessages} WHERE ${ticketMessages.ticketId} = ${tickets.id} AND ${ticketMessages.actorType} = 'staff' AND ${ticketMessages.internal} = false)`,
          ...(opts.partnerId ? [eq(tickets.partnerId, opts.partnerId)] : []),
        ))
        .orderBy(asc(tickets.createdAt), asc(tickets.id))
        .limit(opts.limit ?? 5);
      const first = rows[0];
      return {
        total: Number(first?.total ?? 0),
        byPriority: {
          urgent: Number(first?.urgent ?? 0),
          normal: Number(first?.normal ?? 0),
          low: Number(first?.low ?? 0),
        },
        oldest: rows.map((r) => ({
          id: r.id,
          partnerId: r.partnerId,
          priority: r.priority as TicketPriority,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },

    /** Queue aggregates for the dashboard summary / LiveRefresh stamp. */
    async countsByStatus(partnerId?: PartnerId): Promise<Record<string, number>> {
      const rows = await db
        .select({ status: tickets.status, n: count() })
        .from(tickets)
        .where(partnerId ? eq(tickets.partnerId, partnerId) : undefined)
        .groupBy(tickets.status);
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    },

    /** Cheap change stamp: refresh dashboards when any ticket moves. */
    async ticketStamp(partnerId?: PartnerId): Promise<string> {
      const rows = await db
        .select({
          n: count(),
          latest: sql<string>`COALESCE(MAX(${tickets.updatedAt})::text, '')`,
        })
        .from(tickets)
        .where(partnerId ? eq(tickets.partnerId, partnerId) : undefined);
      return `${rows[0]?.n ?? 0}|${rows[0]?.latest ?? ''}`;
    },
  };
  return repo;
}

export type TicketRepo = ReturnType<typeof createTicketRepo>;
