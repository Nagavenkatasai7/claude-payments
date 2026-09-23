/**
 * OWNER-RUN, REVIEWED re-encrypt (Program-Fix 46): re-seals every legacy `v1.`
 * field-crypto value in Postgres as a `v2.` value bound to its own table,
 * column and row (see src/lib/crypto-context.ts). Same FIELD_ENCRYPTION_KEY
 * (never rotated), kid `k0`.
 *
 * NEVER wired into package.json or CI; the automation loop never runs it. Run it
 * only when EVERY serving build reads v2 (46B stable for at least 24 h — a
 * pre-46A build throws on v2), and after a Neon snapshot of the production branch.
 *
 * DRY RUN by default — prints counts per table/column only, never a value:
 *   set -a; source .env.local; set +a; npx tsx scripts/reencrypt-aad-v2.ts [--table <name>] [--batch 200]
 * Apply (one table first, e.g. partner_integrations):
 *   … scripts/reencrypt-aad-v2.ts --apply --confirm-snapshot-taken --table partner_integrations
 *
 * Every write is a compare-and-set: `UPDATE … SET col = <v2> WHERE <row key> AND
 * col = <the v1 read>`, so a row changed concurrently is skipped, never
 * overwritten. A value that does not decrypt is counted as failed and left as is.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import {
  decryptField,
  defaultProvider,
  sealFieldV2,
  type CryptoContext,
  type EncryptionKeyProvider,
} from '@/lib/field-crypto';
import {
  ctx,
  type CustomerEncColumn,
  type IntegrationEncColumn,
  type TransferEncColumn,
  type WaitlistEncColumn,
} from '@/lib/crypto-context';

export interface ReencryptTable {
  table: string;
  /** SQL key columns, in the order the context helper takes them. */
  key: readonly string[];
  columns: readonly string[];
  ctxFor(key: readonly string[], column: string): CryptoContext;
}

// The brief's §4 Postgres columns. The context builders are THE ones the repos
// use (crypto-context.ts), so a re-sealed value opens exactly where a repo reads it.
export const REENCRYPT_TABLES: readonly ReencryptTable[] = [
  {
    table: 'transfers',
    key: ['id'],
    columns: ['payout_destination_enc', 'recipient_legal_name_enc', 'sender_business_name_enc', 'recipient_business_name_enc'],
    ctxFor: ([id], column) => ctx.transfer(id, column as TransferEncColumn),
  },
  {
    table: 'customers',
    key: ['partner_id', 'phone'],
    // mfa_totp_enc: Program-Fix 49D (portal TOTP secret, same row context).
    columns: ['full_name_enc', 'date_of_birth_enc', 'residential_address_enc', 'gov_id_number_enc', 'email_enc', 'mfa_totp_enc'],
    ctxFor: ([partnerId, phone], column) => ctx.customer(partnerId, phone, column as CustomerEncColumn),
  },
  {
    table: 'sellers',
    key: ['partner_id', 'phone'],
    columns: ['payout_destination_enc'],
    ctxFor: ([partnerId, phone]) => ctx.seller(partnerId, phone),
  },
  {
    table: 'recipients',
    key: ['partner_id', 'sender_phone', 'recipient_phone'],
    columns: ['payout_destination_enc'],
    ctxFor: ([partnerId, senderPhone, recipientPhone]) => ctx.recipient(partnerId, senderPhone, recipientPhone),
  },
  {
    table: 'beneficiaries',
    key: ['id'],
    columns: ['payout_destination_enc'],
    ctxFor: ([id]) => ctx.beneficiary(id),
  },
  {
    table: 'schedules',
    key: ['id'],
    columns: ['payout_destination_enc'],
    ctxFor: ([id]) => ctx.schedule(id),
  },
  {
    table: 'partner_integrations',
    key: ['partner_id'],
    columns: [
      'kyc_api_key_enc', 'kyc_webhook_secret_enc', 'payment_credentials_enc', 'payment_webhook_secret_enc',
      'wa_token_enc', 'wa_verify_token_enc', 'wa_app_secret_enc',
    ],
    ctxFor: ([partnerId], column) => ctx.integration(partnerId, column as IntegrationEncColumn),
  },
  {
    table: 'waitlist_signups',
    key: ['id'],
    columns: ['full_name_enc', 'email_enc', 'phone_enc', 'location_enc'],
    ctxFor: ([id], column) => ctx.waitlist(id, column as WaitlistEncColumn),
  },
];

export interface ColumnReport {
  table: string;
  column: string;
  /** v1 values found. */
  v1: number;
  resealed: number;
  /** Compare-and-set lost to a concurrent write (left as the newer value). */
  skipped: number;
  /** Did not decrypt (left untouched). */
  failed: number;
}

export interface ReencryptOptions {
  apply: boolean;
  table?: string;
  batch?: number;
  provider?: EncryptionKeyProvider;
  /** Test seam: runs between the read and the compare-and-set of each row. */
  beforeWrite?: (row: { table: string; column: string }) => Promise<void>;
}

const V1_LIKE = 'v1.%';

type Row = Record<string, unknown>;
const rowsOf = (res: unknown): Row[] => (res as { rows: Row[] }).rows;

const id = (name: string): SQL => sql`${sql.identifier(name)}`;
const keyTuple = (key: readonly string[]): SQL => sql`(${sql.join(key.map(id), sql`, `)})`;
const valueTuple = (vals: readonly string[]): SQL => sql`(${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`;
const keyMatch = (key: readonly string[], vals: readonly string[]): SQL =>
  sql.join(key.map((k, i) => sql`${id(k)} = ${vals[i]}`), sql` AND `);

async function countV1(db: DbOrTx, t: ReencryptTable, column: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM ${id(t.table)} WHERE ${id(column)} LIKE ${V1_LIKE}`,
  );
  return Number(rowsOf(res)[0]?.n ?? 0);
}

async function resealColumn(
  db: DbOrTx,
  t: ReencryptTable,
  column: string,
  report: ColumnReport,
  opts: Required<Pick<ReencryptOptions, 'batch' | 'provider'>> & Pick<ReencryptOptions, 'beforeWrite'>,
): Promise<void> {
  // Keyset pagination on the row key, so skipped/failed rows are never revisited.
  let after: string[] | null = null;
  for (;;) {
    const cursor = after ? sql` AND ${keyTuple(t.key)} > ${valueTuple(after)}` : sql``;
    const res = await db.execute(
      sql`SELECT ${sql.join(t.key.map((k) => sql`${id(k)}::text AS ${id(k)}`), sql`, `)}, ${id(column)} AS enc
            FROM ${id(t.table)}
           WHERE ${id(column)} LIKE ${V1_LIKE}${cursor}
           ORDER BY ${sql.join(t.key.map(id), sql`, `)}
           LIMIT ${opts.batch}`,
    );
    const rows = rowsOf(res);
    if (rows.length === 0) return;
    for (const row of rows) {
      const keyVals = t.key.map((k) => String(row[k]));
      const oldBlob = String(row.enc);
      const context = t.ctxFor(keyVals, column);
      let next: string;
      try {
        const plain = decryptField(oldBlob, opts.provider); // v1 ignores the context
        next = sealFieldV2(plain, opts.provider, context);
        if (decryptField(next, opts.provider, context) !== plain) throw new Error('verify');
      } catch {
        report.failed += 1; // counts only — never the value or the key
        continue;
      }
      if (opts.beforeWrite) await opts.beforeWrite({ table: t.table, column });
      const upd = await db.execute(
        sql`UPDATE ${id(t.table)} SET ${id(column)} = ${next}
             WHERE ${keyMatch(t.key, keyVals)} AND ${id(column)} = ${oldBlob}
             RETURNING 1 AS ok`,
      );
      if (rowsOf(upd).length === 1) report.resealed += 1;
      else report.skipped += 1;
    }
    after = t.key.map((k) => String(rows[rows.length - 1][k]));
  }
}

/** Pure over the db handle; exported so it is tested on PGlite. */
export async function reencryptAadV2(db: DbOrTx, opts: ReencryptOptions): Promise<ColumnReport[]> {
  const provider = opts.provider ?? defaultProvider();
  const batch = opts.batch ?? 200;
  const tables = REENCRYPT_TABLES.filter((t) => !opts.table || t.table === opts.table);
  if (opts.table && tables.length === 0) throw new Error('unknown --table');
  const out: ColumnReport[] = [];
  for (const t of tables) {
    for (const column of t.columns) {
      const report: ColumnReport = { table: t.table, column, v1: await countV1(db, t, column), resealed: 0, skipped: 0, failed: 0 };
      if (opts.apply && report.v1 > 0) {
        await resealColumn(db, t, column, report, { batch, provider, beforeWrite: opts.beforeWrite });
      }
      out.push(report);
    }
  }
  return out;
}

export type ParsedArgs =
  | { ok: true; apply: boolean; batch: number; table: string | undefined }
  | { ok: false; error: string };

export function parseReencryptArgs(argv: readonly string[]): ParsedArgs {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes('--apply');
  if (apply && !argv.includes('--confirm-snapshot-taken')) {
    return { ok: false, error: '--apply also requires --confirm-snapshot-taken (take a Neon snapshot first).' };
  }
  const table = valueOf('--table');
  if (argv.includes('--table') && !REENCRYPT_TABLES.some((t) => t.table === table)) {
    return { ok: false, error: `--table must be one of: ${REENCRYPT_TABLES.map((t) => t.table).join(', ')}` };
  }
  let batch = 200;
  if (argv.includes('--batch')) {
    const raw = valueOf('--batch') ?? '';
    batch = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(batch) || batch < 1 || batch > 1000) {
      return { ok: false, error: '--batch must be an integer from 1 to 1000.' };
    }
  }
  return { ok: true, apply, batch, table };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const args = parseReencryptArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const report = await reencryptAadV2(getDb(), { apply: args.apply, batch: args.batch, table: args.table });
  console.log(`${args.apply ? 'APPLIED' : 'DRY RUN'} — v1 → v2 re-encrypt`);
  console.table(report);
  const total = (k: keyof Omit<ColumnReport, 'table' | 'column'>) => report.reduce((n, r) => n + r[k], 0);
  console.log(`v1=${total('v1')} resealed=${total('resealed')} skipped=${total('skipped')} failed=${total('failed')}`);
}

if (process.argv[1]?.endsWith('reencrypt-aad-v2.ts')) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('reencrypt-aad-v2 failed:', e instanceof Error ? e.name : 'error');
    process.exit(1);
  });
}
