import { and, desc, eq, asc, sql, count } from 'drizzle-orm';
import { tickets, ticketMessages } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
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
// Bodies are plaintext by design (queue search + AI triage/copilot read them);
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

function rowToMessage(row: MessageRow): TicketMessage {
  return {
    id: row.id,
    ticketId: row.ticketId,
    actorType: row.actorType as TicketMessage['actorType'],
    actorId: row.actorId,
    body: row.body,
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

export function createTicketRepo(db: DbOrTx) {
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
        await tx.insert(ticketMessages).values({
          ticketId: input.id,
          actorType: input.kind === 'internal' ? 'staff' : 'customer',
          actorId: input.kind === 'internal' ? (input.openedBy ?? '') : (input.customerPhone ?? ''),
          body: input.body,
          internal: false,
        });
        return rowToTicket(rows[0]);
      };
      // DbOrTx: run a real transaction when we hold a Db; inside an existing
      // tx the statements already share it.
      const maybeTx = db as { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
      return maybeTx.transaction ? maybeTx.transaction(run) : run(db);
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
      const rows = await db
        .insert(ticketMessages)
        .values({
          ticketId: input.ticketId,
          actorType: input.actorType,
          actorId: input.actorId,
          body: input.body,
          internal: input.internal ?? false,
        })
        .returning();
      await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, input.ticketId));
      return rowToMessage(rows[0]);
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
      return rows.map(rowToMessage);
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
