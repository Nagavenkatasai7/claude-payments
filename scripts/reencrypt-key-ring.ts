/**
 * OWNER-RUN, REVIEWED key-ring re-encrypt (Program-Fix 45 P4, step 13): re-seals
 * every v2 field-crypto blob whose kid is NOT the configured current kid
 * (FIELD_ENCRYPTION_CURRENT_KID) under the current kid, in the same (table,
 * column, row) context. It is the second half of a key rotation — and there is
 * NO rotation: FIELD_ENCRYPTION_KEY is set-once and the current kid stays k0 in
 * production, so on production this script finds nothing to do.
 *
 * NEVER wired into package.json or CI; the automation loop never runs it. v1
 * blobs are NOT touched (that is scripts/reencrypt-aad-v2.ts), nor are legacy
 * plaintext ticket bodies (they stay readable as they are).
 *
 * Preconditions for a real rotation (owner, after a reviewed plan): EVERY
 * serving deployment — including skew-pinned ones, which keep their env
 * snapshot — carries the new key in FIELD_ENCRYPTION_PREVIOUS_KEYS before
 * FIELD_ENCRYPTION_CURRENT_KID names it; then a Neon snapshot.
 *
 * DRY RUN by default — prints counts per table/column only, never a value:
 *   set -a; source .env.local; set +a; npx tsx scripts/reencrypt-key-ring.ts [--table <name>] [--batch 200]
 * Apply:
 *   … scripts/reencrypt-key-ring.ts --apply --confirm-snapshot-taken [--table <name>]
 *
 * Every write is a compare-and-set: `UPDATE … SET col = <new> WHERE <row key>
 * AND col = <the blob read>`, so a row changed concurrently is skipped, never
 * overwritten. A value that does not open is counted as failed and left as is.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import {
  currentWriteKid,
  decryptField,
  defaultProvider,
  sealFieldV2,
  type EncryptionKeyProvider,
} from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import { REENCRYPT_TABLES, type ReencryptTable } from './reencrypt-aad-v2';

export interface KeyRingTable extends ReencryptTable {
  /** SQL type of each key column for the keyset cursor (default text). */
  keyTypes?: readonly ('text' | 'bigint')[];
}

/** Every fix-46 column (the SAME registry and contexts) plus ticket_messages.body. */
export const KEY_RING_TABLES: readonly KeyRingTable[] = [
  ...REENCRYPT_TABLES,
  {
    table: 'ticket_messages',
    key: ['id'],
    keyTypes: ['bigint'],
    columns: ['body'],
    ctxFor: ([id]) => ctx.ticketMessage(id),
  },
];

export interface KeyRingColumnReport {
  table: string;
  column: string;
  /** v2 blobs under a kid other than the current one. */
  stale: number;
  resealed: number;
  /** Compare-and-set lost to a concurrent write (left as the newer value). */
  skipped: number;
  /** Did not open (left untouched). */
  failed: number;
}

export interface KeyRingOptions {
  apply: boolean;
  table?: string;
  batch?: number;
  provider?: EncryptionKeyProvider;
  /** Test seam: runs between the read and the compare-and-set of each row. */
  beforeWrite?: (row: { table: string; column: string }) => Promise<void>;
}

type Row = Record<string, unknown>;
const rowsOf = (res: unknown): Row[] => (res as { rows: Row[] }).rows;
const id = (name: string): SQL => sql`${sql.identifier(name)}`;
const castTo = (v: string, type: 'text' | 'bigint'): SQL => (type === 'bigint' ? sql`${v}::bigint` : sql`${v}::text`);
const keyTypesOf = (t: KeyRingTable): ('text' | 'bigint')[] => t.key.map((_, i) => t.keyTypes?.[i] ?? 'text');
/** `k = $v` with the value cast to the column type, so the PK index is used. */
const keyMatch = (t: KeyRingTable, vals: readonly string[]): SQL => {
  const types = keyTypesOf(t);
  return sql.join(t.key.map((k, i) => sql`${id(k)} = ${castTo(vals[i], types[i])}`), sql` AND `);
};

/** v2 blobs NOT under the current kid. The kid is validated (KID_PATTERN), so it has no LIKE wildcards. */
const staleWhere = (column: string, kid: string): SQL =>
  sql`${id(column)} LIKE ${'v2.%'} AND ${id(column)} NOT LIKE ${`v2.${kid}.%`}`;

async function countStale(db: DbOrTx, t: KeyRingTable, column: string, kid: string): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM ${id(t.table)} WHERE ${staleWhere(column, kid)}`);
  return Number(rowsOf(res)[0]?.n ?? 0);
}

async function resealColumn(
  db: DbOrTx,
  t: KeyRingTable,
  column: string,
  kid: string,
  report: KeyRingColumnReport,
  opts: Required<Pick<KeyRingOptions, 'batch' | 'provider'>> & Pick<KeyRingOptions, 'beforeWrite'>,
): Promise<void> {
  const types = keyTypesOf(t);
  const castVal = (v: string, i: number): SQL => castTo(v, types[i]);
  // Keyset pagination on the row key, so skipped/failed rows are never revisited.
  // ORDER BY names the TABLE column: the SELECT aliases each key `::text AS
  // <key>`, and a bare ORDER BY <key> would sort by that text alias ('10' <
  // '2'), out of step with the typed cursor, silently skipping rows.
  let after: string[] | null = null;
  for (;;) {
    const cursor = after
      ? sql` AND (${sql.join(t.key.map(id), sql`, `)}) > (${sql.join(after.map(castVal), sql`, `)})`
      : sql``;
    const res = await db.execute(
      sql`SELECT ${sql.join(t.key.map((k) => sql`${id(k)}::text AS ${id(k)}`), sql`, `)}, ${id(column)} AS enc
            FROM ${id(t.table)}
           WHERE ${staleWhere(column, kid)}${cursor}
           ORDER BY ${sql.join(t.key.map((k) => sql`${id(t.table)}.${id(k)}`), sql`, `)}
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
        const plain = decryptField(oldBlob, opts.provider, context);
        next = sealFieldV2(plain, opts.provider, context, kid);
        if (decryptField(next, opts.provider, context) !== plain) throw new Error('verify');
      } catch {
        report.failed += 1; // counts only — never the value or the key
        continue;
      }
      if (opts.beforeWrite) await opts.beforeWrite({ table: t.table, column });
      const upd = await db.execute(
        sql`UPDATE ${id(t.table)} SET ${id(column)} = ${next}
             WHERE ${keyMatch(t, keyVals)} AND ${id(column)} = ${oldBlob}
             RETURNING 1 AS ok`,
      );
      if (rowsOf(upd).length === 1) report.resealed += 1;
      else report.skipped += 1;
    }
    after = t.key.map((k) => String(rows[rows.length - 1][k]));
  }
}

/** Pure over the db handle; exported so it is tested on PGlite. */
export async function reencryptKeyRing(db: DbOrTx, opts: KeyRingOptions): Promise<KeyRingColumnReport[]> {
  const provider = opts.provider ?? defaultProvider();
  // Fails closed BEFORE any read or write: a current kid that is malformed or
  // missing from the ring stops the run.
  const kid = currentWriteKid(provider);
  const batch = opts.batch ?? 200;
  const tables = KEY_RING_TABLES.filter((t) => !opts.table || t.table === opts.table);
  if (opts.table && tables.length === 0) throw new Error('unknown --table');
  const out: KeyRingColumnReport[] = [];
  for (const t of tables) {
    for (const column of t.columns) {
      const report: KeyRingColumnReport = {
        table: t.table, column, stale: await countStale(db, t, column, kid), resealed: 0, skipped: 0, failed: 0,
      };
      if (opts.apply && report.stale > 0) {
        await resealColumn(db, t, column, kid, report, { batch, provider, beforeWrite: opts.beforeWrite });
      }
      out.push(report);
    }
  }
  return out;
}

export type ParsedKeyRingArgs =
  | { ok: true; apply: boolean; batch: number; table: string | undefined }
  | { ok: false; error: string };

export function parseKeyRingArgs(argv: readonly string[]): ParsedKeyRingArgs {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes('--apply');
  if (apply && !argv.includes('--confirm-snapshot-taken')) {
    return { ok: false, error: '--apply also requires --confirm-snapshot-taken (take a Neon snapshot first).' };
  }
  const table = valueOf('--table');
  if (argv.includes('--table') && !KEY_RING_TABLES.some((t) => t.table === table)) {
    return { ok: false, error: `--table must be one of: ${KEY_RING_TABLES.map((t) => t.table).join(', ')}` };
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
  const args = parseKeyRingArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const report = await reencryptKeyRing(getDb(), { apply: args.apply, batch: args.batch, table: args.table });
  console.log(`${args.apply ? 'APPLIED' : 'DRY RUN'} — key-ring re-encrypt to the current kid`);
  console.table(report);
  const total = (k: keyof Omit<KeyRingColumnReport, 'table' | 'column'>) => report.reduce((n, r) => n + r[k], 0);
  console.log(`stale=${total('stale')} resealed=${total('resealed')} skipped=${total('skipped')} failed=${total('failed')}`);
}

if (process.argv[1]?.endsWith('reencrypt-key-ring.ts')) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('reencrypt-key-ring failed:', e instanceof Error ? e.name : 'error');
    process.exit(1);
  });
}
