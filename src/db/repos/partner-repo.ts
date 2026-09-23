import { asc, eq } from 'drizzle-orm';
import { partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { CorridorComplianceRule, CountryCode, KycMode, Partner, PartnerId, PartnerSendLimits, PartnerStatus, PartnerSupportConfig } from '@/lib/types';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';

// partner-repo — mirrors partner-store's surface (getPartner / savePartner /
// listPartners / ensureDefaultPartner) so the cutover is a drop-in swap.

type PartnerRow = typeof partners.$inferSelect;

function rowToPartner(row: PartnerRow): Partner {
  const p: Partner = {
    id: row.id,
    name: row.name,
    countries: (row.countries as CountryCode[]) ?? [],
    status: row.status as PartnerStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.brandName) p.brandName = row.brandName;
  if (row.displayName) p.displayName = row.displayName;
  if (row.primaryColor) p.primaryColor = row.primaryColor;
  if (row.logoUrl) p.logoUrl = row.logoUrl;
  if (row.supportContact) p.supportContact = row.supportContact;
  if (row.botPersona) p.botPersona = row.botPersona;
  if (row.adminNote) p.adminNote = row.adminNote;
  if (row.kycMode) p.kycMode = row.kycMode as KycMode;
  if (row.requireKycBeforeSend !== null && row.requireKycBeforeSend !== undefined) {
    p.requireKycBeforeSend = row.requireKycBeforeSend;
  }
  if (row.corridorCompliance) {
    p.corridorCompliance = row.corridorCompliance as Partial<Record<CountryCode, CorridorComplianceRule>>;
  }
  if (row.supportConfig) p.supportConfig = row.supportConfig as PartnerSupportConfig;
  // Program fix 16: READ-ONLY here. Deliberately NOT in partnerToRow below —
  // savePartner's full-row upsert (updatePartnerAction) must never rewrite a
  // limit; fix 16b's setSendLimits is the single-column writer.
  if (row.sendLimits && typeof row.sendLimits === 'object') p.sendLimits = row.sendLimits as PartnerSendLimits;
  return p;
}

function partnerToRow(p: Partner): typeof partners.$inferInsert {
  return {
    id: p.id,
    name: p.name,
    countries: p.countries,
    status: p.status,
    brandName: p.brandName ?? null,
    displayName: p.displayName ?? null,
    primaryColor: p.primaryColor ?? null,
    logoUrl: p.logoUrl ?? null,
    supportContact: p.supportContact ?? null,
    botPersona: p.botPersona ?? null,
    adminNote: p.adminNote ?? null,
    kycMode: p.kycMode ?? 'ours',
    requireKycBeforeSend: p.requireKycBeforeSend ?? null,
    corridorCompliance: p.corridorCompliance ?? null,
    supportConfig: p.supportConfig ?? null,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
  };
}

export function createPartnerRepo(db: DbOrTx) {
  return {
    async getPartner(id: PartnerId): Promise<Partner | null> {
      const rows = await db.select().from(partners).where(eq(partners.id, id)).limit(1);
      return rows[0] ? rowToPartner(rows[0]) : null;
    },

    async savePartner(partner: Partner): Promise<void> {
      const row = partnerToRow(partner);
      await db.insert(partners).values(row).onConflictDoUpdate({ target: partners.id, set: row });
    },

    /**
     * Program fix 16b: the ONE writer of partners.send_limits — a single-column
     * UPDATE, so updatePartnerAction's full-row savePartner (which never names
     * the column) can't clobber a raise and a raise can't clobber branding.
     * Reads the previous value under FOR UPDATE first so the caller's audit
     * row records the true old value inside its transaction. An unknown id ⇒
     * { found: false } and nothing written.
     */
    async setSendLimits(
      id: PartnerId,
      value: PartnerSendLimits | null,
    ): Promise<{ found: boolean; previous: PartnerSendLimits | null }> {
      const rows = await db
        .select({ sendLimits: partners.sendLimits })
        .from(partners)
        .where(eq(partners.id, id))
        .limit(1)
        .for('update');
      if (!rows[0]) return { found: false, previous: null };
      const prev = rows[0].sendLimits;
      const previous = prev && typeof prev === 'object' ? (prev as PartnerSendLimits) : null;
      await db.update(partners).set({ sendLimits: value, updatedAt: new Date() }).where(eq(partners.id, id));
      return { found: true, previous };
    },

    /**
     * Program-Fix 15 PR B: the column-targeted writer of partners.support_config.
     * Reads the stored jsonb under FOR UPDATE, hands it to `merge` (which returns
     * the whole next value, built by SPREADING the previous one — a support save
     * never erases the disclosure block and vice versa), and writes only that
     * column. Call it inside the caller's transaction so the audit row commits
     * with the write. An unknown id ⇒ { found: false } and nothing written.
     */
    async updateSupportConfig(
      id: PartnerId,
      merge: (previous: PartnerSupportConfig) => PartnerSupportConfig,
    ): Promise<{ found: boolean; previous: PartnerSupportConfig; next: PartnerSupportConfig }> {
      const rows = await db
        .select({ supportConfig: partners.supportConfig })
        .from(partners)
        .where(eq(partners.id, id))
        .limit(1)
        .for('update');
      if (!rows[0]) return { found: false, previous: {}, next: {} };
      const raw = rows[0].supportConfig;
      const previous: PartnerSupportConfig =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PartnerSupportConfig) : {};
      const next = merge(previous);
      await db.update(partners).set({ supportConfig: next, updatedAt: new Date() }).where(eq(partners.id, id));
      return { found: true, previous, next };
    },

    async listPartners(): Promise<Partner[]> {
      const rows = await db.select().from(partners).orderBy(asc(partners.createdAt));
      return rows.map(rowToPartner);
    },

    async ensureDefaultPartner(): Promise<Partner> {
      const existing = await this.getPartner('default');
      if (existing) return existing;
      const now = new Date().toISOString();
      const fresh: Partner = {
        id: 'default',
        name: 'SmartRemit Default',
        // Any-to-any: the default tenant serves senders from every supported
        // source country, so resolveSendCurrency auto-detects the sender's
        // currency from their number instead of collapsing to USD.
        countries: DEFAULT_PARTNER_COUNTRIES,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      // Concurrent boots may race — first insert wins, second reads it back.
      await db.insert(partners).values(partnerToRow(fresh)).onConflictDoNothing();
      return (await this.getPartner('default'))!;
    },
  };
}

export type PartnerRepo = ReturnType<typeof createPartnerRepo>;
