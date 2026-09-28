// portal-settings-repo — reader for partner_portal_settings (migration 0027): the partner's
// approved WhatsApp AUTHENTICATION template and the portal enablement timestamp.
//
// Tenant scoping: every query takes ONE partnerId and has `partner_id = $1` in its WHERE; nothing
// here lists or reads across tenants. Callers derive partnerId from the transfer/draft/session,
// never from a request body.
//
// M2-6 ships the reader only (the pay step's OTP template). The writers (setPortalAuthTemplate,
// setPortalEnabled) land with the portal settings task.
import { eq } from 'drizzle-orm';
import { partnerPortalSettings } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { PartnerId } from '@/lib/types';

export interface PortalSettings {
  authTemplateName: string | null;
  authTemplateLang: string | null;
  portalEnabledAt: Date | null;
}

const EMPTY: PortalSettings = { authTemplateName: null, authTemplateLang: null, portalEnabledAt: null };

export async function getPortalSettings(db: DbOrTx, partnerId: PartnerId): Promise<PortalSettings> {
  const rows = await db
    .select({
      authTemplateName: partnerPortalSettings.authTemplateName,
      authTemplateLang: partnerPortalSettings.authTemplateLang,
      portalEnabledAt: partnerPortalSettings.portalEnabledAt,
    })
    .from(partnerPortalSettings)
    .where(eq(partnerPortalSettings.partnerId, partnerId))
    .limit(1);
  return rows[0] ?? { ...EMPTY };
}

/**
 * The recorded auth template as a send argument, or undefined unless BOTH the name and the
 * language are set (the DB CHECKs validate each column but do not require them as a pair).
 */
export function portalAuthTemplate(s: PortalSettings): { name: string; lang: string } | undefined {
  if (!s.authTemplateName || !s.authTemplateLang) return undefined;
  return { name: s.authTemplateName, lang: s.authTemplateLang };
}
