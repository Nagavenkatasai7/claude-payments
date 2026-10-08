import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  partnerRewardTerms,
  partnerRewards,
  platformFeeLedger,
  rewardCatalog,
  rewardRedemptions,
  transfers,
} from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { DEFAULT_CATALOG, DEFAULT_TERMS } from '@/lib/rewards/settings';
import {
  isFundedRewardKind,
  isRewardKind,
  type Catalog,
  type CatalogEntry,
  type PartnerRewardSetting,
  type PartnerRewardSettings,
  type PartnerRewardTerms,
  type QuotedReward,
  type RewardKind,
  type SenderRewardUsage,
} from '@/lib/rewards/types';
import type { PartnerId } from '@/lib/types';

// reward-repo — the ONLY SQL over the five B3 tables (reward_catalog,
// partner_reward_terms, partner_rewards, reward_redemptions,
// platform_fee_ledger). Tenant isolation is app-level: every partner-facing
// read and write takes partnerId in the WHERE. The admin catalog is platform
// data (no tenant). Released rewards are never written as such: a redemption
// whose transfer is cancelled (expired links are cancelled), blocked or
// refunded is left out by ACTIVE below, so it gives the cap and the budget back.

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** A redemption still holds its reward: its transfer is not cancelled, blocked or refunded. */
const ACTIVE = sql`${transfers.status} NOT IN ('cancelled','blocked') AND ${transfers.refundStatus} <> 'completed'`;

export interface RedemptionWrite {
  transferId: string;
  partnerId: PartnerId;
  phone: string;
  month: string;
  reward: QuotedReward;
  giveBackUsd: number;
  giveBackWithheld: boolean;
}

export interface RedemptionRow {
  transferId: string;
  kind: RewardKind;
  discountUsd: number;
  giveBackUsd: number;
  giveBackWithheld: boolean;
  detail: QuotedReward['detail'];
  month: string;
  createdAt: Date;
}

/** One partner's month as the statement needs it (statement.ts does the maths). */
export interface StatementFacts {
  partnerId: PartnerId;
  deliveredCount: number;
  feeOwedUsd: number;
  rewards: Array<{ kind: RewardKind; withheld: boolean; count: number; discountUsd: number; giveBackUsd: number }>;
}

function detailOf(v: unknown): QuotedReward['detail'] {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: QuotedReward['detail'] = {};
  if (typeof d.nth === 'number') out.nth = d.nth;
  if (typeof d.festivalName === 'string') out.festivalName = d.festivalName;
  return out;
}

function toRedemption(r: typeof rewardRedemptions.$inferSelect): RedemptionRow | null {
  if (!isRewardKind(r.kind)) return null;
  return {
    transferId: r.transferId,
    kind: r.kind,
    discountUsd: num(r.discountUsd),
    giveBackUsd: num(r.giveBackUsd),
    giveBackWithheld: r.giveBackWithheld,
    detail: detailOf(r.detail),
    month: r.month,
    createdAt: r.createdAt,
  };
}

export function createRewardRepo(db: DbOrTx) {
  return {
    // ── Admin catalog (platform data) ──────────────────────────────────────
    async getCatalog(): Promise<Catalog> {
      const rows = await db.select().from(rewardCatalog);
      const out: Catalog = { nth_transfer: { ...DEFAULT_CATALOG.nth_transfer }, festival: { ...DEFAULT_CATALOG.festival } };
      for (const r of rows) {
        if (!isFundedRewardKind(r.kind)) continue;
        out[r.kind] = {
          kind: r.kind,
          available: r.available,
          nthMin: r.nthMin,
          nthMax: r.nthMax,
          maxDays: r.maxDays,
          maxDiscountUsd: num(r.maxDiscountUsd),
          customerMonthlyCap: r.customerMonthlyCap,
          festivalNames: Array.isArray(r.festivalNames) ? (r.festivalNames as unknown[]).filter((n): n is string => typeof n === 'string') : [],
        };
      }
      return out;
    },

    async upsertCatalog(e: CatalogEntry, updatedBy: string): Promise<void> {
      const values = {
        available: e.available,
        nthMin: e.nthMin,
        nthMax: e.nthMax,
        maxDays: e.maxDays,
        maxDiscountUsd: e.maxDiscountUsd.toFixed(2),
        customerMonthlyCap: e.customerMonthlyCap,
        festivalNames: e.festivalNames,
        updatedBy,
        updatedAt: new Date(),
      };
      await db.insert(rewardCatalog).values({ kind: e.kind, ...values })
        .onConflictDoUpdate({ target: rewardCatalog.kind, set: values });
    },

    // ── Admin terms per partner ─────────────────────────────────────────────
    async getTerms(partnerId: PartnerId): Promise<PartnerRewardTerms> {
      const [r] = await db.select().from(partnerRewardTerms).where(eq(partnerRewardTerms.partnerId, partnerId)).limit(1);
      return r
        ? { platformFeeUsd: num(r.platformFeeUsd), giveBackPct: num(r.giveBackPct), monthlyBudgetUsd: num(r.monthlyBudgetUsd) }
        : { ...DEFAULT_TERMS };
    },

    /** Every partner's saved terms (the admin page; a partner with no row has the defaults). */
    async listTerms(): Promise<Map<PartnerId, PartnerRewardTerms>> {
      const rows = await db.select().from(partnerRewardTerms);
      return new Map(rows.map((r) => [r.partnerId, {
        platformFeeUsd: num(r.platformFeeUsd), giveBackPct: num(r.giveBackPct), monthlyBudgetUsd: num(r.monthlyBudgetUsd),
      }]));
    },

    async upsertTerms(partnerId: PartnerId, t: PartnerRewardTerms, updatedBy: string): Promise<void> {
      const values = {
        platformFeeUsd: t.platformFeeUsd.toFixed(2),
        giveBackPct: t.giveBackPct.toFixed(2),
        monthlyBudgetUsd: t.monthlyBudgetUsd.toFixed(2),
        updatedBy,
        updatedAt: new Date(),
      };
      await db.insert(partnerRewardTerms).values({ partnerId, ...values })
        .onConflictDoUpdate({ target: partnerRewardTerms.partnerId, set: values });
    },

    // ── A partner's own choices (tenant-scoped) ─────────────────────────────
    async getPartnerSettings(partnerId: PartnerId): Promise<PartnerRewardSettings> {
      const rows = await db.select().from(partnerRewards).where(eq(partnerRewards.partnerId, partnerId));
      const out: PartnerRewardSettings = { nth_transfer: undefined, festival: undefined };
      for (const r of rows) {
        if (!isFundedRewardKind(r.kind)) continue;
        out[r.kind] = {
          kind: r.kind,
          enabled: r.enabled,
          nth: r.nth,
          festivalName: r.festivalName,
          startsOn: r.startsOn,
          endsOn: r.endsOn,
          minAmountUsd: r.minAmountUsd === null ? null : num(r.minAmountUsd),
        };
      }
      return out;
    },

    async upsertPartnerSetting(partnerId: PartnerId, s: PartnerRewardSetting, updatedBy: string): Promise<void> {
      const values = {
        enabled: s.enabled,
        nth: s.nth ?? null,
        festivalName: s.festivalName ?? null,
        startsOn: s.startsOn ?? null,
        endsOn: s.endsOn ?? null,
        minAmountUsd: s.minAmountUsd === null || s.minAmountUsd === undefined ? null : s.minAmountUsd.toFixed(2),
        updatedBy,
        updatedAt: new Date(),
      };
      await db.insert(partnerRewards).values({ partnerId, kind: s.kind, ...values })
        .onConflictDoUpdate({ target: [partnerRewards.partnerId, partnerRewards.kind], set: values });
    },

    // ── Usage (the quote reads it on the root handle, the mint under the sender lock) ──
    async senderUsage(partnerId: PartnerId, phone: string, month: string, monthStart: Date): Promise<SenderRewardUsage> {
      const [delivered] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          eq(transfers.status, 'delivered'),
          sql`${transfers.deliveredAt} >= ${monthStart.toISOString()}`,
          eq(transfers.environment, 'live'),
          eq(transfers.transferType, 'b2c'),
          sql`${transfers.refundStatus} <> 'completed'`,
        ));
      const held = await db
        .select({ kind: rewardRedemptions.kind, n: sql<number>`count(*)::int` })
        .from(rewardRedemptions)
        .innerJoin(transfers, eq(transfers.id, rewardRedemptions.transferId))
        .where(and(
          eq(rewardRedemptions.partnerId, partnerId),
          eq(rewardRedemptions.phone, phone),
          eq(rewardRedemptions.month, month),
          ACTIVE,
        ))
        .groupBy(rewardRedemptions.kind);
      const activeThisMonth = { nth_transfer: 0, festival: 0 };
      for (const h of held) if (isFundedRewardKind(h.kind)) activeThisMonth[h.kind] = num(h.n);
      return { deliveredThisMonth: num(delivered?.n), activeThisMonth };
    },

    /** The give-back the partner's budget already holds this month (released and withheld rewards left out). */
    async budgetUsed(partnerId: PartnerId, month: string): Promise<number> {
      const [r] = await db
        .select({ used: sql<string>`coalesce(sum(${rewardRedemptions.giveBackUsd}), 0)` })
        .from(rewardRedemptions)
        .innerJoin(transfers, eq(transfers.id, rewardRedemptions.transferId))
        .where(and(
          eq(rewardRedemptions.partnerId, partnerId),
          eq(rewardRedemptions.month, month),
          eq(rewardRedemptions.giveBackWithheld, false),
          ACTIVE,
        ));
      return num(r?.used);
    },

    /**
     * The partner budget lock: a transaction-scoped advisory lock per partner,
     * taken INSIDE the sender lock (always in that order, so two mints never
     * wait on each other the other way round). Two senders of one partner then
     * read and spend the budget one after the other.
     */
    async lockBudget(partnerId: PartnerId): Promise<void> {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`reward-budget:${partnerId}`}))`);
    },

    /** One reward per transfer: the PK refuses a second row. */
    async insertRedemption(w: RedemptionWrite): Promise<void> {
      await db.insert(rewardRedemptions).values({
        transferId: w.transferId,
        partnerId: w.partnerId,
        phone: w.phone,
        kind: w.reward.kind,
        month: w.month,
        discountUsd: w.reward.discountUsd.toFixed(2),
        giveBackUsd: w.giveBackUsd.toFixed(2),
        giveBackWithheld: w.giveBackWithheld,
        detail: w.reward.detail,
      });
    },

    /** The transfer's reward, tenant-scoped (null for another partner's transfer). */
    async getRedemption(partnerId: PartnerId, transferId: string): Promise<RedemptionRow | null> {
      const [r] = await db.select().from(rewardRedemptions)
        .where(and(eq(rewardRedemptions.partnerId, partnerId), eq(rewardRedemptions.transferId, transferId)))
        .limit(1);
      return r ? toRedemption(r) : null;
    },

    /** A customer's own rewards, newest first (the portal card), tenant + sender scoped. */
    async listCustomerRewards(partnerId: PartnerId, phone: string, limit = 10): Promise<Array<RedemptionRow & { released: boolean }>> {
      const rows = await db
        .select({ r: rewardRedemptions, released: sql<boolean>`NOT (${ACTIVE})` })
        .from(rewardRedemptions)
        .innerJoin(transfers, eq(transfers.id, rewardRedemptions.transferId))
        .where(and(eq(rewardRedemptions.partnerId, partnerId), eq(rewardRedemptions.phone, phone)))
        .orderBy(desc(rewardRedemptions.createdAt))
        .limit(limit);
      const out: Array<RedemptionRow & { released: boolean }> = [];
      for (const row of rows) {
        const r = toRedemption(row.r);
        if (r) out.push({ ...r, released: Boolean(row.released) });
      }
      return out;
    },

    /**
     * Owner decision (question 9): a transfer compliance flagged keeps the
     * price the customer saw, the partner pays that discount and SmartRemit
     * gives no give-back for it. Idempotent; the customer is never told.
     */
    async withholdGiveBackIfFlagged(transferId: string): Promise<boolean> {
      const rows = await db
        .update(rewardRedemptions)
        .set({ giveBackWithheld: true, giveBackUsd: '0' })
        .where(and(
          eq(rewardRedemptions.transferId, transferId),
          eq(rewardRedemptions.giveBackWithheld, false),
          sql`EXISTS (SELECT 1 FROM ${transfers} WHERE ${transfers.id} = ${rewardRedemptions.transferId} AND ${transfers.complianceStatus} <> 'cleared')`,
        ))
        .returning({ id: rewardRedemptions.transferId });
      return rows.length > 0;
    },

    // ── Platform fee ledger ─────────────────────────────────────────────────
    /**
     * The platform fee row for one LIVE delivered transfer, at the partner's
     * fee now. ON CONFLICT DO NOTHING: a replayed delivery or the gap sweep
     * never adds a second row. True ⇔ inserted.
     */
    async recordPlatformFee(t: { id: string; partnerId: PartnerId }, month: string): Promise<boolean> {
      const [terms] = await db.select({ fee: partnerRewardTerms.platformFeeUsd }).from(partnerRewardTerms)
        .where(eq(partnerRewardTerms.partnerId, t.partnerId)).limit(1);
      const fee = terms ? num(terms.fee) : DEFAULT_TERMS.platformFeeUsd;
      const rows = await db.insert(platformFeeLedger)
        .values({ transferId: t.id, partnerId: t.partnerId, month, feeUsd: fee.toFixed(2) })
        .onConflictDoNothing({ target: platformFeeLedger.transferId })
        .returning({ id: platformFeeLedger.transferId });
      return rows.length > 0;
    },

    /** Live delivered transfers since `since` with no platform fee row (the gap sweep's work list). */
    async listFeeGaps(since: Date, limit: number): Promise<Array<{ id: string; partnerId: PartnerId; deliveredAt: Date }>> {
      const rows = await db
        .select({ id: transfers.id, partnerId: transfers.partnerId, deliveredAt: transfers.deliveredAt })
        .from(transfers)
        .leftJoin(platformFeeLedger, eq(platformFeeLedger.transferId, transfers.id))
        .where(and(
          eq(transfers.status, 'delivered'),
          eq(transfers.environment, 'live'),
          sql`${transfers.deliveredAt} >= ${since.toISOString()}`,
          isNull(platformFeeLedger.transferId),
        ))
        .limit(limit);
      return rows.flatMap((r) => (r.deliveredAt ? [{ id: r.id, partnerId: r.partnerId, deliveredAt: r.deliveredAt }] : []));
    },

    /**
     * One ET month per partner: the fee rows, and the rewards of transfers
     * delivered that month (joined to the ledger, so only delivered counts),
     * refunded transfers left out. `partnerId` narrows to one tenant.
     */
    async statementFacts(month: string, partnerId?: PartnerId): Promise<StatementFacts[]> {
      const fees = await db
        .select({
          partnerId: platformFeeLedger.partnerId,
          n: sql<number>`count(*)::int`,
          fee: sql<string>`coalesce(sum(${platformFeeLedger.feeUsd}), 0)`,
        })
        .from(platformFeeLedger)
        .where(and(eq(platformFeeLedger.month, month), partnerId ? eq(platformFeeLedger.partnerId, partnerId) : undefined))
        .groupBy(platformFeeLedger.partnerId);
      const rewards = await db
        .select({
          partnerId: rewardRedemptions.partnerId,
          kind: rewardRedemptions.kind,
          withheld: rewardRedemptions.giveBackWithheld,
          n: sql<number>`count(*)::int`,
          discount: sql<string>`coalesce(sum(${rewardRedemptions.discountUsd}), 0)`,
          giveBack: sql<string>`coalesce(sum(${rewardRedemptions.giveBackUsd}), 0)`,
        })
        .from(rewardRedemptions)
        .innerJoin(platformFeeLedger, eq(platformFeeLedger.transferId, rewardRedemptions.transferId))
        .innerJoin(transfers, eq(transfers.id, rewardRedemptions.transferId))
        .where(and(
          eq(platformFeeLedger.month, month),
          sql`${transfers.refundStatus} <> 'completed'`,
          partnerId ? eq(rewardRedemptions.partnerId, partnerId) : undefined,
        ))
        .groupBy(rewardRedemptions.partnerId, rewardRedemptions.kind, rewardRedemptions.giveBackWithheld);
      const by = new Map<PartnerId, StatementFacts>();
      const get = (p: PartnerId) => {
        let f = by.get(p);
        if (!f) by.set(p, (f = { partnerId: p, deliveredCount: 0, feeOwedUsd: 0, rewards: [] }));
        return f;
      };
      for (const f of fees) Object.assign(get(f.partnerId), { deliveredCount: num(f.n), feeOwedUsd: num(f.fee) });
      for (const r of rewards) {
        if (!isRewardKind(r.kind)) continue;
        get(r.partnerId).rewards.push({
          kind: r.kind, withheld: r.withheld, count: num(r.n), discountUsd: num(r.discount), giveBackUsd: num(r.giveBack),
        });
      }
      return [...by.values()].sort((a, b) => a.partnerId.localeCompare(b.partnerId));
    },

    /** The rewards of these transfers, tenant-scoped (lists and receipts). */
    async listByTransferIds(partnerId: PartnerId, ids: readonly string[]): Promise<Map<string, RedemptionRow>> {
      if (ids.length === 0) return new Map();
      const rows = await db.select().from(rewardRedemptions)
        .where(and(eq(rewardRedemptions.partnerId, partnerId), inArray(rewardRedemptions.transferId, [...ids])));
      const out = new Map<string, RedemptionRow>();
      for (const r of rows) {
        const m = toRedemption(r);
        if (m) out.set(m.transferId, m);
      }
      return out;
    },
  };
}

export type RewardRepo = ReturnType<typeof createRewardRepo>;
