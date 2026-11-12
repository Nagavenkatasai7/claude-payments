import { and, asc, eq, sql } from 'drizzle-orm';
import { partnerCorridors } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { logWarn } from '@/lib/log';
import { TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import {
  CORRIDOR_STATUSES,
  RULE_PACKS,
  corridorActive,
  corridorRowHash,
  type CorridorInput,
  type CorridorRow,
  type CorridorStatus,
  type RulePack,
} from '@/lib/corridor-register';
import type { CountryCode, PartnerId, TransferPurpose } from '@/lib/types';

// partner-corridor-repo (fix pack 8, P24) — the ONE repo of the destination
// register (table 0042 partner_corridors, PK (partner_id, destination_country)).
//
//  • TENANT-SCOPED: every partner-facing statement has partner_id = $p in the
//    WHERE (a partner reads and writes only its own rows). listReattestDue is the
//    one platform-wide read (the re-attest sweep, like listSlaBreaches).
//  • The writers (upsertRecorded, setStatus, attest) refuse the default tenant
//    (CorridorWriteRefused('default_tenant')) before any statement; upsertRecorded
//    treats the route's country as authoritative ('route_mismatch').
//  • Each writer first locks the row (SELECT … FOR UPDATE) inside the caller's
//    transaction, or its own when given a Db.
//  • EVERY save (upsertRecorded, setStatus) clears attested_by/at/hash (D10): the
//    partner must attest the new content. attest re-checks the pc1 row hash under
//    the lock ('changed' for a stale tab or an edit since the page loaded).
//  • status and rule_pack have no CHECK in the DB: they are validated in code; an
//    unknown stored value reads as status 'closed' (fail closed: never active).
//  • Logs carry ids and codes only: never a row, a ref, a sha or a hash.
//
// drizzle 0.45.3: select().for('update') node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586;
// insert().onConflictDoUpdate({ target, set, setWhere }) insert.d.ts:63-66, :141-166.

export class CorridorWriteRefused extends Error {
  constructor(readonly code: 'default_tenant' | 'route_mismatch') {
    super(`corridor write refused: ${code}`);
    this.name = 'CorridorWriteRefused';
  }
}

type Row = typeof partnerCorridors.$inferSelect;

const STATUS_SET: ReadonlySet<string> = new Set<string>(CORRIDOR_STATUSES);
const PACK_SET: ReadonlySet<string> = new Set<string>(RULE_PACKS);
const PURPOSE_CODE = /^[A-Z0-9]{2,8}$/;

function mapPurposeCodes(v: unknown): Partial<Record<TransferPurpose, string>> {
  const out: Partial<Record<TransferPurpose, string>> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const p of TRANSFER_PURPOSES) {
    if (!Object.hasOwn(v, p)) continue;
    const code = (v as Record<string, unknown>)[p];
    if (typeof code === 'string' && PURPOSE_CODE.test(code)) out[p] = code;
  }
  return out;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));
const money = (n: number | null): string | null => (n == null ? null : n.toFixed(2));

function rowToCorridor(r: Row): CorridorRow {
  const knownStatus = STATUS_SET.has(r.status);
  const knownPack = r.rulePack == null || PACK_SET.has(r.rulePack);
  if (!knownStatus || !knownPack) {
    logWarn('partner-corridor.unknown_value', 'unknown status or pack', {
      partnerId: r.partnerId,
      cc: r.destinationCountry,
    });
  }
  return {
    partnerId: r.partnerId,
    destinationCountry: r.destinationCountry as CountryCode,
    status: knownStatus && knownPack ? (r.status as CorridorStatus) : 'closed',
    rulePack: knownPack ? ((r.rulePack as RulePack | null) ?? null) : null,
    purposeCodeMap: mapPurposeCodes(r.purposeCodeMap),
    attestationRef: r.attestationRef,
    attestationSha256: r.attestationSha256 ?? null,
    recipientNotices: r.recipientNotices,
    travelDobFromUsd: num(r.travelDobFromUsd),
    travelFullFromUsd: num(r.travelFullFromUsd),
    reattestDue: r.reattestDue,
    recordedBy: r.recordedBy,
    recordedAt: r.recordedAt.toISOString(),
    attestedBy: r.attestedBy ?? null,
    attestedAt: r.attestedAt ? r.attestedAt.toISOString() : null,
    attestedHash: r.attestedHash ?? null,
  };
}

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };

/** Run `fn` in a transaction when we hold a Db; inside an existing tx, share it (ticket-repo's inTx). */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

function refuseDefault(partnerId: PartnerId): void {
  if (partnerId === DEFAULT_PARTNER_ID) throw new CorridorWriteRefused('default_tenant');
}

const key = (partnerId: PartnerId, cc: CountryCode) =>
  and(eq(partnerCorridors.partnerId, partnerId), eq(partnerCorridors.destinationCountry, cc));

async function lockRow(tx: DbOrTx, partnerId: PartnerId, cc: CountryCode): Promise<Row | null> {
  const rows = await tx.select().from(partnerCorridors).where(key(partnerId, cc)).for('update');
  return rows[0] ?? null;
}

const CLEAR_ATTESTATION = { attestedBy: null, attestedAt: null, attestedHash: null } as const;

export function createPartnerCorridorRepo(db: DbOrTx) {
  async function listRows(partnerId: PartnerId): Promise<CorridorRow[]> {
    const rows = await db
      .select()
      .from(partnerCorridors)
      .where(eq(partnerCorridors.partnerId, partnerId))
      .orderBy(asc(partnerCorridors.destinationCountry));
    return rows.map(rowToCorridor);
  }

  return {
    async get(partnerId: PartnerId, cc: CountryCode): Promise<CorridorRow | null> {
      const rows = await db.select().from(partnerCorridors).where(key(partnerId, cc)).limit(1);
      return rows[0] ? rowToCorridor(rows[0]) : null;
    },

    /** The partner's rows, ORDER BY destination_country. */
    listForPartner(partnerId: PartnerId): Promise<CorridorRow[]> {
      return listRows(partnerId);
    },

    /** Rows where corridorActive(row, now) (filtered in JS: the hash is not computable in SQL). */
    async countActive(partnerId: PartnerId, now: Date): Promise<number> {
      return (await listRows(partnerId)).filter((r) => corridorActive(r, now)).length;
    },

    /** The active destinations, sorted. */
    async activeDestinations(partnerId: PartnerId, now: Date): Promise<CountryCode[]> {
      return (await listRows(partnerId))
        .filter((r) => corridorActive(r, now))
        .map((r) => r.destinationCountry)
        .sort();
    },

    /** Record (insert or replace) the row; EVERY save clears the attestation. */
    async upsertRecorded(
      partnerId: PartnerId,
      cc: CountryCode,
      input: CorridorInput,
      actor: string,
    ): Promise<{ previous: CorridorRow | null; row: CorridorRow }> {
      refuseDefault(partnerId);
      if (input.destinationCountry !== cc) throw new CorridorWriteRefused('route_mismatch');
      return inTx(db, async (tx) => {
        const prev = await lockRow(tx, partnerId, cc);
        const recorded = {
          status: input.status,
          rulePack: input.rulePack,
          purposeCodeMap: input.purposeCodeMap,
          attestationRef: input.attestationRef,
          attestationSha256: input.attestationSha256,
          recipientNotices: input.recipientNotices,
          travelDobFromUsd: money(input.travelDobFromUsd),
          travelFullFromUsd: money(input.travelFullFromUsd),
          reattestDue: input.reattestDue,
          recordedBy: actor,
        };
        const rows = await tx
          .insert(partnerCorridors)
          .values({ partnerId, destinationCountry: cc, ...recorded, ...CLEAR_ATTESTATION })
          .onConflictDoUpdate({
            target: [partnerCorridors.partnerId, partnerCorridors.destinationCountry],
            set: { ...recorded, recordedAt: sql`now()`, ...CLEAR_ATTESTATION },
            setWhere: eq(partnerCorridors.partnerId, partnerId),
          })
          .returning();
        return { previous: prev ? rowToCorridor(prev) : null, row: rowToCorridor(rows[0]) };
      });
    },

    /** Change the status; clears the attestation. Missing row -> null. */
    async setStatus(
      partnerId: PartnerId,
      cc: CountryCode,
      status: CorridorStatus,
      actor: string,
    ): Promise<{ previous: CorridorRow; row: CorridorRow } | null> {
      refuseDefault(partnerId);
      return inTx(db, async (tx) => {
        const prev = await lockRow(tx, partnerId, cc);
        if (!prev) return null;
        const rows = await tx
          .update(partnerCorridors)
          .set({ status, recordedBy: actor, recordedAt: sql`now()`, ...CLEAR_ATTESTATION })
          .where(key(partnerId, cc))
          .returning();
        return { previous: rowToCorridor(prev), row: rowToCorridor(rows[0]) };
      });
    },

    /** The partner admin's attestation of exactly the current pc1 row hash (re-checked under the lock). */
    async attest(
      partnerId: PartnerId,
      cc: CountryCode,
      postedHash: string,
      actor: string,
    ): Promise<'attested' | 'changed' | 'missing'> {
      refuseDefault(partnerId);
      return inTx(db, async (tx) => {
        const prev = await lockRow(tx, partnerId, cc);
        if (!prev) return 'missing';
        if (postedHash !== corridorRowHash(rowToCorridor(prev))) return 'changed';
        await tx
          .update(partnerCorridors)
          .set({ attestedBy: actor, attestedAt: sql`now()`, attestedHash: postedHash })
          .where(key(partnerId, cc));
        return 'attested';
      });
    },

    /**
     * Platform sweep (no tenant filter): active rows whose reattest_due falls within
     * `withinDays` of today (UTC) or earlier. Ids, codes and the due date only.
     */
    async listReattestDue(
      now: Date,
      withinDays: number,
    ): Promise<Array<{ partnerId: PartnerId; destinationCountry: CountryCode; reattestDue: string }>> {
      const today = now.toISOString().slice(0, 10);
      const rows = await db
        .select({
          partnerId: partnerCorridors.partnerId,
          destinationCountry: partnerCorridors.destinationCountry,
          reattestDue: partnerCorridors.reattestDue,
        })
        .from(partnerCorridors)
        .where(
          and(
            eq(partnerCorridors.status, 'active'),
            sql`${partnerCorridors.reattestDue} - ${withinDays}::int <= ${today}::date`,
          ),
        )
        .orderBy(asc(partnerCorridors.reattestDue), asc(partnerCorridors.partnerId));
      return rows.map((r) => ({
        partnerId: r.partnerId,
        destinationCountry: r.destinationCountry as CountryCode,
        reattestDue: r.reattestDue,
      }));
    },
  };
}

export type PartnerCorridorRepo = ReturnType<typeof createPartnerCorridorRepo>;
