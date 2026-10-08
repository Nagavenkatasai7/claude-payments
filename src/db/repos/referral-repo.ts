import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import {
  referralAttributions,
  referralCodes,
  referralPartners,
  referralProgramSettings,
  transfers,
} from '@/db/schema';
import { COMMISSION_WINDOW_MONTHS } from '@/lib/referrals';
import type { PartnerId } from '@/lib/types';

// referral-repo — Batch B4. The referral-partner ledger: outside affiliates, their
// codes, one attribution per customer (tenant, phone), the Plum portal setting and the
// monthly commission statement. Referral partners are NOT tenants: nothing here reads
// or writes a partner's customer rows or transfers (the statement only READS transfers).
// Partner-facing reads (getAttribution) take the tenant in the WHERE.

export type ReferralPartnerStatus = 'active' | 'inactive';
export type ReferralChannel = 'whatsapp' | 'portal';

export interface ReferralPartnerRow {
  id: string;
  name: string;
  contact: string;
  commissionCents: number;
  status: ReferralPartnerStatus;
  createdAt: Date;
}

export interface ReferralCodeRow {
  code: string;
  active: boolean;
  createdAt: Date;
}

export interface ReferralAttributionView {
  referralPartnerId: string;
  referralPartnerName: string;
  code: string;
  channel: ReferralChannel;
  createdAt: Date;
}

export interface ReferralStatementRow {
  referralPartnerId: string;
  name: string;
  contact: string;
  status: ReferralPartnerStatus;
  commissionCents: number;
  deliveredCount: number;
}

const SETTINGS_ID = 'global';

export function createReferralRepo(db: DbOrTx) {
  return {
    async insertPartner(p: { id: string; name: string; contact: string; commissionCents: number; createdBy: string }): Promise<void> {
      await db.insert(referralPartners).values(p);
    },

    /** False when the code already exists (any referral partner): the first owner keeps it. */
    async insertCode(c: { code: string; referralPartnerId: string; createdBy: string }): Promise<boolean> {
      const rows = await db.insert(referralCodes).values(c).onConflictDoNothing({ target: referralCodes.code }).returning({ code: referralCodes.code });
      return rows.length > 0;
    },

    async getPartner(id: string): Promise<ReferralPartnerRow | null> {
      const rows = await db.select().from(referralPartners).where(eq(referralPartners.id, id)).limit(1);
      const r = rows[0];
      return r
        ? { id: r.id, name: r.name, contact: r.contact, commissionCents: r.commissionCents, status: r.status as ReferralPartnerStatus, createdAt: r.createdAt }
        : null;
    },

    /** True when the row existed and was updated. */
    async updatePartner(
      id: string,
      patch: Partial<{ name: string; contact: string; commissionCents: number; status: ReferralPartnerStatus }>,
    ): Promise<boolean> {
      const rows = await db
        .update(referralPartners)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(referralPartners.id, id))
        .returning({ id: referralPartners.id });
      return rows.length > 0;
    },

    /** The code's referral partner, or null when the code does not exist. */
    async getCode(code: string): Promise<{ code: string; referralPartnerId: string; active: boolean } | null> {
      const rows = await db
        .select({ code: referralCodes.code, referralPartnerId: referralCodes.referralPartnerId, active: referralCodes.active })
        .from(referralCodes)
        .where(eq(referralCodes.code, code))
        .limit(1);
      return rows[0] ?? null;
    },

    async setCodeActive(code: string, active: boolean): Promise<boolean> {
      const rows = await db.update(referralCodes).set({ active }).where(eq(referralCodes.code, code)).returning({ code: referralCodes.code });
      return rows.length > 0;
    },

    async listPartnersWithCodes(): Promise<Array<ReferralPartnerRow & { codes: ReferralCodeRow[] }>> {
      const [partners, codes] = await Promise.all([
        db.select().from(referralPartners).orderBy(asc(referralPartners.name), asc(referralPartners.id)),
        db.select().from(referralCodes).orderBy(asc(referralCodes.createdAt), asc(referralCodes.code)),
      ]);
      return partners.map((p) => ({
        id: p.id,
        name: p.name,
        contact: p.contact,
        commissionCents: p.commissionCents,
        status: p.status as ReferralPartnerStatus,
        createdAt: p.createdAt,
        codes: codes
          .filter((c) => c.referralPartnerId === p.id)
          .map((c) => ({ code: c.code, active: c.active, createdAt: c.createdAt })),
      }));
    },

    /**
     * Link a customer (tenant, phone) to the referral partner behind `code`, in ONE statement:
     *  - only an ACTIVE code of an ACTIVE referral partner;
     *  - only while the customer has no delivered LIVE transfer under this tenant;
     *  - first referral wins: the (partner_id, phone) primary key + ON CONFLICT DO NOTHING, so a
     *    second code, a redelivered WhatsApp message or a concurrent sign-in never moves anyone.
     * The customer's tenant is the caller's; a code never changes it. True ⇒ this call linked them.
     */
    async recordAttribution(a: { partnerId: PartnerId; phone: string; code: string; channel: ReferralChannel }): Promise<boolean> {
      const res = await db.execute(sql`
        INSERT INTO ${referralAttributions} (partner_id, phone, referral_partner_id, code, channel)
        SELECT ${a.partnerId}, ${a.phone}, c.referral_partner_id, c.code, ${a.channel}
        FROM ${referralCodes} c
        JOIN ${referralPartners} p ON p.id = c.referral_partner_id
        WHERE c.code = ${a.code} AND c.active AND p.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM ${transfers} t
            WHERE t.partner_id = ${a.partnerId} AND t.phone = ${a.phone}
              AND t.status = 'delivered' AND t.environment = 'live'
          )
        ON CONFLICT (partner_id, phone) DO NOTHING
        RETURNING referral_partner_id
      `);
      return (res as unknown as { rows: unknown[] }).rows.length > 0;
    },

    /** The customer's referral, keyed by (tenant, phone): a partner only ever reads its own tenant. */
    async getAttribution(partnerId: PartnerId, phone: string): Promise<ReferralAttributionView | null> {
      const rows = await db
        .select({
          referralPartnerId: referralAttributions.referralPartnerId,
          referralPartnerName: referralPartners.name,
          code: referralAttributions.code,
          channel: referralAttributions.channel,
          createdAt: referralAttributions.createdAt,
        })
        .from(referralAttributions)
        .innerJoin(referralPartners, eq(referralPartners.id, referralAttributions.referralPartnerId))
        .where(and(eq(referralAttributions.partnerId, partnerId), eq(referralAttributions.phone, phone)))
        .limit(1);
      const r = rows[0];
      return r ? { ...r, channel: r.channel as ReferralChannel } : null;
    },

    /**
     * The monthly statement, one row per referral partner (zero rows included): the number of
     * DELIVERED, LIVE transfers of its referred customers with delivered_at in [from, to), not
     * refunded (refund_status pending or completed is excluded), and only within
     * COMMISSION_WINDOW_MONTHS of that customer's FIRST delivered live transfer. The commission
     * is the referral partner's CURRENT fixed amount per transfer.
     */
    async monthlyStatement(from: Date, to: Date): Promise<ReferralStatementRow[]> {
      const res = await db.execute(sql`
        WITH firsts AS (
          SELECT a.referral_partner_id, a.partner_id, a.phone, min(t.delivered_at) AS first_at
          FROM ${referralAttributions} a
          JOIN ${transfers} t ON t.partner_id = a.partner_id AND t.phone = a.phone
          WHERE t.status = 'delivered' AND t.environment = 'live' AND t.delivered_at IS NOT NULL
          GROUP BY a.referral_partner_id, a.partner_id, a.phone
        ),
        counted AS (
          SELECT f.referral_partner_id, count(t.id)::int AS n
          FROM firsts f
          JOIN ${transfers} t ON t.partner_id = f.partner_id AND t.phone = f.phone
          WHERE t.status = 'delivered' AND t.environment = 'live'
            AND t.refund_status NOT IN ('pending', 'completed')
            AND t.delivered_at >= ${from.toISOString()}::timestamptz
            AND t.delivered_at < ${to.toISOString()}::timestamptz
            AND t.delivered_at < f.first_at + make_interval(months => ${COMMISSION_WINDOW_MONTHS})
          GROUP BY f.referral_partner_id
        )
        SELECT p.id, p.name, p.contact, p.status, p.commission_cents, coalesce(c.n, 0)::int AS n
        FROM ${referralPartners} p
        LEFT JOIN counted c ON c.referral_partner_id = p.id
        ORDER BY p.name, p.id
      `);
      return (res as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
        referralPartnerId: String(r.id),
        name: String(r.name),
        contact: String(r.contact ?? ''),
        status: String(r.status) as ReferralPartnerStatus,
        commissionCents: Number(r.commission_cents),
        deliveredCount: Number(r.n),
      }));
    },

    async getPlumPortalUrl(): Promise<string | null> {
      const rows = await db
        .select({ url: referralProgramSettings.plumPortalUrl })
        .from(referralProgramSettings)
        .where(eq(referralProgramSettings.id, SETTINGS_ID))
        .limit(1);
      return rows[0]?.url ?? null;
    },

    async setPlumPortalUrl(url: string | null, updatedBy: string): Promise<void> {
      await db
        .insert(referralProgramSettings)
        .values({ id: SETTINGS_ID, plumPortalUrl: url, updatedBy })
        .onConflictDoUpdate({ target: referralProgramSettings.id, set: { plumPortalUrl: url, updatedBy, updatedAt: sql`now()` } });
    },
  };
}

export type ReferralRepo = ReturnType<typeof createReferralRepo>;
