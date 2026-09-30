// portal-settings-repo — reader for partner_portal_settings (migration 0027): the partner's
// approved WhatsApp AUTHENTICATION template and the portal enablement timestamp.
//
// Tenant scoping: every query takes ONE partnerId and has `partner_id = $1` in its WHERE; nothing
// here lists or reads across tenants. Callers derive partnerId from the transfer/draft/session,
// never from a request body.
//
// M2-6 shipped the reader (the pay step's OTP template). M2-5 adds the writers (setPortalAuthTemplate,
// setPortalEnabled): validated, audited in the same transaction, and repo-only (M3's go-live checklist
// or the M2-14 platform-admin card wires the UI, owner O6).
import { eq, sql } from 'drizzle-orm';
import { partnerPortalSettings, partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { resolveWaChannel } from '@/lib/whatsapp-creds';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
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

// ── Writers (UI redesign M2-5, Task 5.2) ────────────────────────────────────────

/** The Meta template-name charset. Length ≤ 512 (the DB CHECK splits the length out; Postgres caps regex bounds at 255). */
export const PORTAL_TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
/** A language code such as `en` or `en_US` (the DB CHECK is the same pattern). */
export const PORTAL_TEMPLATE_LANG_RE = /^[a-z]{2}(_[A-Z]{2})?$/;

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

async function partnerExists(db: DbOrTx, partnerId: PartnerId): Promise<boolean> {
  const rows = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  return rows.length > 0;
}

export type SetTemplateResult = { ok: true } | { ok: false; reason: 'invalid' | 'not_found' };

/** Record the partner's approved auth template. Validated first; upsert + audit in one transaction. */
export async function setPortalAuthTemplate(
  db: DbOrTx,
  partnerId: PartnerId,
  input: { name: unknown; lang: unknown },
  actor: string,
): Promise<SetTemplateResult> {
  const { name, lang } = input;
  if (typeof name !== 'string' || !PORTAL_TEMPLATE_NAME_RE.test(name)) return { ok: false, reason: 'invalid' };
  if (typeof lang !== 'string' || !PORTAL_TEMPLATE_LANG_RE.test(lang)) return { ok: false, reason: 'invalid' };
  return inTx(db, async (tx) => {
    if (!(await partnerExists(tx, partnerId))) return { ok: false, reason: 'not_found' } as const;
    const now = new Date();
    await tx
      .insert(partnerPortalSettings)
      .values({ partnerId, authTemplateName: name, authTemplateLang: lang, updatedAt: now })
      .onConflictDoUpdate({
        target: partnerPortalSettings.partnerId,
        set: { authTemplateName: name, authTemplateLang: lang, updatedAt: now },
      });
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: 'partner.portal.auth_template',
      subjectId: partnerId,
      meta: { name, lang },
    });
    return { ok: true } as const;
  });
}

export type SetEnabledResult = { ok: true } | { ok: false; reason: 'not_ready' | 'not_found' };

export interface PortalEnableDeps {
  getIntegrations(partnerId: PartnerId): Promise<PartnerIntegrations | null | undefined>;
}

/**
 * Switch the partner's portal on or off (audited `partner.portal.enabled` / `.disabled`).
 * Enabling is REFUSED (`not_ready`) unless the auth template is recorded AND the partner sends from
 * its OWN WhatsApp number; the default tenant counts as own on the shared number (owner O2) and, alone,
 * may enable without a template (owner 2026-09-29: free-form codes inside the 24h window). Any
 * readiness read that throws also refuses (fail closed). A repeat enable keeps the first stamp.
 */
export async function setPortalEnabled(
  db: DbOrTx,
  partnerId: PartnerId,
  enabled: boolean,
  actor: string,
  deps?: PortalEnableDeps,
): Promise<SetEnabledResult> {
  if (!(await partnerExists(db, partnerId))) return { ok: false, reason: 'not_found' };
  if (enabled) {
    const s = await getPortalSettings(db, partnerId);
    // Owner decision 2026-09-29: the default tenant may enable without a template (its codes go as
    // free-form chat text inside the 24h window; portal-otp-sender.ts). Every other partner needs one.
    if ((!s.authTemplateName || !s.authTemplateLang) && partnerId !== DEFAULT_PARTNER_ID) return { ok: false, reason: 'not_ready' };
    let own: boolean;
    try {
      const integrations = await (deps?.getIntegrations ?? ((id: PartnerId) => createIntegrationsRepo(db).getIntegrations(id)))(partnerId);
      const channel = resolveWaChannel(partnerId, integrations);
      own = channel.kind === 'own' || (channel.kind === 'shared' && partnerId === DEFAULT_PARTNER_ID);
    } catch {
      own = false;
    }
    if (!own) return { ok: false, reason: 'not_ready' };
  }
  return inTx(db, async (tx) => {
    const now = new Date();
    const stamp = enabled ? sql`COALESCE(${partnerPortalSettings.portalEnabledAt}, now())` : null;
    await tx
      .insert(partnerPortalSettings)
      .values({ partnerId, portalEnabledAt: enabled ? now : null, updatedAt: now })
      .onConflictDoUpdate({ target: partnerPortalSettings.partnerId, set: { portalEnabledAt: stamp, updatedAt: now } });
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: enabled ? 'partner.portal.enabled' : 'partner.portal.disabled',
      subjectId: partnerId,
    });
    return { ok: true } as const;
  });
}
