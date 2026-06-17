import { asc, eq } from 'drizzle-orm';
import { partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { CorridorComplianceRule, CountryCode, KycMode, Partner, PartnerId, PartnerStatus, PartnerSupportConfig } from '@/lib/types';
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
