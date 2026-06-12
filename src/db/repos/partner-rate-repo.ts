import { and, eq, lt, isNotNull } from 'drizzle-orm';
import { partnerRates, partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { CurrencyCode, PartnerId, PartnerRate } from '@/lib/types';

// partner-rate-repo — per-partner conversion pricing per corridor (best-rate
// selection). Rates are NOT PII: no encryption, plain numerics. Tenant rule:
// partner-facing reads/writes are always scoped by partnerId; the unscoped
// listers exist only for the platform-only rates dashboard + selection service.

type RateRow = typeof partnerRates.$inferSelect;

function rowToRate(row: RateRow): PartnerRate {
  const r: PartnerRate = {
    id: row.id,
    partnerId: row.partnerId,
    sourceCurrency: row.sourceCurrency as CurrencyCode,
    destinationCurrency: row.destinationCurrency as CurrencyCode,
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.effectiveRate !== null) r.effectiveRate = Number(row.effectiveRate);
  if (row.expiresAt) r.expiresAt = row.expiresAt.toISOString();
  if (row.pushedAt) r.pushedAt = row.pushedAt.toISOString();
  if (row.marginBps !== null && row.marginBps !== undefined) r.marginBps = row.marginBps;
  return r;
}

export function createPartnerRateRepo(db: DbOrTx) {
  return {
    /**
     * Upsert one corridor's rate record for a partner. Merge semantics: a rate
     * PUSH updates effectiveRate/expiresAt/pushedAt and leaves marginBps; an
     * admin MARGIN save updates marginBps and leaves the pushed fields — pass
     * only the side you mean to change (undefined keeps the stored value,
     * explicit null clears it).
     */
    async upsertRate(input: {
      id: string;
      partnerId: PartnerId;
      sourceCurrency: CurrencyCode;
      destinationCurrency: CurrencyCode;
      effectiveRate?: number | null;
      expiresAt?: string | null;
      pushedAt?: string | null;
      marginBps?: number | null;
    }): Promise<PartnerRate> {
      const now = new Date();
      const insertRow: typeof partnerRates.$inferInsert = {
        id: input.id,
        partnerId: input.partnerId,
        sourceCurrency: input.sourceCurrency,
        destinationCurrency: input.destinationCurrency,
        effectiveRate: input.effectiveRate != null ? String(input.effectiveRate) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        pushedAt: input.pushedAt ? new Date(input.pushedAt) : null,
        marginBps: input.marginBps ?? null,
        updatedAt: now,
      };
      // On conflict, update ONLY the fields the caller provided (undefined ⇒
      // keep stored; null ⇒ clear) so pushes and margin saves don't clobber
      // each other.
      const set: Record<string, unknown> = { updatedAt: now };
      if (input.effectiveRate !== undefined) {
        set.effectiveRate = input.effectiveRate !== null ? String(input.effectiveRate) : null;
      }
      if (input.expiresAt !== undefined) set.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (input.pushedAt !== undefined) set.pushedAt = input.pushedAt ? new Date(input.pushedAt) : null;
      if (input.marginBps !== undefined) set.marginBps = input.marginBps;
      const rows = await db
        .insert(partnerRates)
        .values(insertRow)
        .onConflictDoUpdate({
          target: [partnerRates.partnerId, partnerRates.sourceCurrency, partnerRates.destinationCurrency],
          set,
        })
        .returning();
      return rowToRate(rows[0]);
    },

    async getRate(
      partnerId: PartnerId,
      sourceCurrency: CurrencyCode,
      destinationCurrency: CurrencyCode,
    ): Promise<PartnerRate | null> {
      const rows = await db
        .select()
        .from(partnerRates)
        .where(and(
          eq(partnerRates.partnerId, partnerId),
          eq(partnerRates.sourceCurrency, sourceCurrency),
          eq(partnerRates.destinationCurrency, destinationCurrency),
        ))
        .limit(1);
      return rows[0] ? rowToRate(rows[0]) : null;
    },

    /** A partner's own rate sheet (partner API GET + admin Pricing tab). */
    async listRatesForPartner(partnerId: PartnerId): Promise<PartnerRate[]> {
      const rows = await db
        .select()
        .from(partnerRates)
        .where(eq(partnerRates.partnerId, partnerId))
        .orderBy(partnerRates.sourceCurrency, partnerRates.destinationCurrency);
      return rows.map(rowToRate);
    },

    /**
     * Every candidate record for one corridor joined with its ACTIVE partner —
     * the selection service's single query. Eligibility beyond active-status
     * (freshness, rail usability, not-default) is the service's job.
     */
    async listCandidatesForCorridor(
      sourceCurrency: CurrencyCode,
      destinationCurrency: CurrencyCode,
    ): Promise<PartnerRate[]> {
      const rows = await db
        .select({ rate: partnerRates })
        .from(partnerRates)
        .innerJoin(partners, eq(partnerRates.partnerId, partners.id))
        .where(and(
          eq(partnerRates.sourceCurrency, sourceCurrency),
          eq(partnerRates.destinationCurrency, destinationCurrency),
          eq(partners.status, 'active'),
        ));
      return rows.map((r) => rowToRate(r.rate));
    },

    /** All rates (platform-only dashboard). */
    async listAllRates(): Promise<PartnerRate[]> {
      const rows = await db
        .select()
        .from(partnerRates)
        .orderBy(partnerRates.sourceCurrency, partnerRates.destinationCurrency, partnerRates.partnerId);
      return rows.map(rowToRate);
    },

    /** Pushed rates whose TTL has lapsed (staleness sweep). */
    async listExpired(now: Date): Promise<PartnerRate[]> {
      const rows = await db
        .select()
        .from(partnerRates)
        .where(and(isNotNull(partnerRates.effectiveRate), lt(partnerRates.expiresAt, now)));
      return rows.map(rowToRate);
    },
  };
}

export type PartnerRateRepo = ReturnType<typeof createPartnerRateRepo>;
