import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql, type Logger } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { newTransferId } from '@/lib/id';
import type { Db } from '@/db/client';
import type { PartnerId, Transfer, TransferStatus } from '@/lib/types';

// helpers-db — REAL Postgres in-process (PGlite) for repo/outbox/transaction
// tests. A hand-rolled fake cannot honor UNIQUE(partner_id,key), FOR UPDATE
// SKIP LOCKED, or the rank-guarded atomic UPDATE — which are exactly the
// behaviors under test, so we run the genuine engine.
//
// One PGlite instance per vitest worker (module singleton), migrated once;
// freshDb() truncates everything and re-seeds the default partner between
// tests to keep the suite fast.
//
// The returned handle is cast to the app's `Db` type (neon-serverless drizzle):
// both are PgDatabase instances over the same schema — query/transaction APIs
// are runtime-identical; only the driver HKT differs.

let initPromise: Promise<ReturnType<typeof drizzle<typeof schema>>> | null = null;

// SQL spy (Program fix 16, test 8): every statement drizzle issues on this
// PGlite handle is offered to the capture buffer when one is open, so a test
// can assert statement ORDER (e.g. the per-sender advisory lock is taken
// before anything touches `transfers`). Off by default — zero cost.
let capture: Array<{ sql: string; params: unknown[] }> | null = null;
const spyLogger: Logger = {
  logQuery(query, params) {
    if (capture) capture.push({ sql: query, params });
  },
};
/** Start recording statements; the returned function stops and returns them. */
export function captureQueries(): () => Array<{ sql: string; params: unknown[] }> {
  const buf: Array<{ sql: string; params: unknown[] }> = [];
  capture = buf;
  return () => {
    capture = null;
    return buf;
  };
}

async function initOnce() {
  const client = new PGlite();
  const db = drizzle(client, { schema, logger: spyLogger });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

const ALL_TABLES = [
  'outbox',
  'conversation_messages',
  'idempotency_keys',
  'audit_events',
  'partner_rates',
  'ticket_messages',
  'tickets',
  'transfers',
  'schedules',
  'beneficiaries',
  'recipients',
  'kyc_cases',
  'corridor_requests',
  'api_keys',
  'partner_integrations',
  'customers',
  'partners',
  'waitlist_signups',
  'sanctions_list_entries',
  'sanctions_list_versions',
  'staff',
  'funding_events',
].join(', ');

export async function freshDb(): Promise<Db> {
  if (!initPromise) initPromise = initOnce();
  const db = await initPromise;
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES} RESTART IDENTITY CASCADE`));
  await db.execute(
    sql.raw(
      // Mirror prod post-migration-0006: the default tenant is any-to-any
      // (serves every unambiguous source country), so resolveSendCurrency
      // auto-detects the sender's currency instead of collapsing to USD.
      `INSERT INTO partners (id, name, status, countries, kyc_mode)
       VALUES ('default', 'SmartRemit Default', 'active', '["US","GB","AE","SG","AU","NZ","IN"]'::jsonb, 'ours')
       ON CONFLICT (id) DO NOTHING`,
    ),
  );
  return db as unknown as Db;
}

/** Insert an extra partner row for multi-tenant tests. */
export async function seedPartner(db: Db, id: string, name = id): Promise<void> {
  await db.execute(
    sql.raw(
      `INSERT INTO partners (id, name, status, countries, kyc_mode)
       VALUES ('${id}', '${name}', 'active', '["US"]'::jsonb, 'ours')
       ON CONFLICT (id) DO NOTHING`,
    ),
  );
}

/**
 * Program fix 16: seed ledger spend for the cap / EDD totals. Goes through
 * the real repo (encrypted columns, NOT NULLs) with an explicit createdAt so a
 * test can place spend on a prior ET day or month. Defaults: today, awaiting_payment.
 * Returns the row id.
 */
export async function seedLedgerSpend(
  db: Db,
  input: {
    partnerId: PartnerId;
    phone: string;
    amountUsd: number;
    status?: TransferStatus;
    createdAt?: Date | string;
    id?: string;
  },
): Promise<string> {
  const id = input.id ?? newTransferId();
  const createdAt = input.createdAt
    ? new Date(input.createdAt).toISOString()
    : new Date().toISOString();
  const status = input.status ?? 'awaiting_payment';
  const t: Transfer = {
    id,
    phone: input.phone,
    amountUsd: input.amountUsd,
    feeUsd: 0,
    totalChargeUsd: input.amountUsd,
    fxRate: 85,
    amountInr: input.amountUsd * 85,
    recipientName: 'Seeded Recipient',
    recipientPhone: '919000000000',
    payoutMethod: 'bank',
    payoutDestination: '000011112222|HDFC0000001',
    fundingMethod: 'bank_transfer',
    complianceStatus: status === 'blocked' ? 'blocked' : 'cleared',
    complianceReasons: [],
    status,
    createdAt,
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: input.partnerId,
    amountSource: input.amountUsd,
    feeSource: 0,
    totalChargeSource: input.amountUsd,
  };
  await createTransferRepo(db).saveTransfer(t);
  return id;
}

/**
 * Program fix 16: seed a tenant's customers row so the mint's cap subject is
 * a chosen tier. firstSeenDaysAgo >= 4 with kycStatus 'verified' ⇒ T1
 * ($2,999/day); the default (0) ⇒ T0 ($500/day). Relative dates only.
 * Encrypted PII columns stay NULL. Idempotent on (partner_id, phone).
 */
export async function seedSender(
  db: Db,
  input: { partnerId: PartnerId; phone: string; firstSeenDaysAgo?: number; kycStatus?: string; senderCountry?: string },
): Promise<void> {
  const firstSeenAt = new Date(Date.now() - (input.firstSeenDaysAgo ?? 0) * 86_400_000);
  await db
    .insert(schema.customers)
    .values({
      phone: input.phone,
      partnerId: input.partnerId,
      firstSeenAt,
      senderCountry: input.senderCountry ?? 'US',
      kycStatus: input.kycStatus ?? 'verified',
    })
    .onConflictDoUpdate({
      target: [schema.customers.partnerId, schema.customers.phone],
      set: { firstSeenAt, kycStatus: input.kycStatus ?? 'verified' },
    });
}
