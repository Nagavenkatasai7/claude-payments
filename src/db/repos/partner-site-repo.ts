// partner-site-repo — reader/writer for partner_sites (per-partner white-label site settings)
// plus the partner's theme colours.
//
// Tenant scoping: every query takes ONE partnerId and has `partner_id = $1` (or `id = $1`) in its
// WHERE; nothing here lists or reads across tenants. Callers must derive partnerId from the
// authenticated session, never from a request body.
//
// Colours: validated (strict #rrggbb, contrast vs both references, stored lowercase) before any
// write, and RE-validated on every read by loadSiteTheme, because partners.primary_color can
// still be written by the legacy full-row save with trim-only handling.
//
// Slugs: nothing here writes `slug`. The theme upsert's insert and update lists name only
// accent_color/updated_at, so a theme write can never clear or change a slug (a suspended
// partner keeps its slug; slugs are never freed). The slug writer lives with the host resolver.
import { eq } from 'drizzle-orm';
import { partners, partnerSites } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { resolveSiteTheme, validateThemeColor, type SiteTheme } from '@/lib/ui/theme';
import type { PartnerId } from '@/lib/types';

export interface PartnerSite {
  slug: string | null;
  accentColor: string | null;
}

export type SaveThemeResult =
  | { ok: true }
  | { ok: false; field: 'primaryColor' | 'accentColor'; reason: 'format' | 'contrast' }
  | { ok: false; reason: 'not_found' };

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
/** Run `fn` in a transaction when holding a Db; inside an existing tx, share it. */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

/** ONE partner's site row, or null when it has none. */
export async function getPartnerSite(db: DbOrTx, partnerId: PartnerId): Promise<PartnerSite | null> {
  const rows = await db
    .select({ slug: partnerSites.slug, accentColor: partnerSites.accentColor })
    .from(partnerSites)
    .where(eq(partnerSites.partnerId, partnerId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Validate BOTH colours, then in ONE transaction: a single-column UPDATE of partners.primary_color
 * (0 rows → not_found, nothing else written), an upsert of partner_sites.accent_color, and a
 * `partner.theme.update` audit row. Colours are not PII, so the audit carries them.
 */
export async function savePartnerTheme(
  db: DbOrTx,
  partnerId: PartnerId,
  input: { primaryColor: unknown; accentColor: unknown },
  actor: string,
): Promise<SaveThemeResult> {
  const p = validateThemeColor(input.primaryColor);
  if (!p.ok) return { ok: false, field: 'primaryColor', reason: p.reason };
  const a = validateThemeColor(input.accentColor);
  if (!a.ok) return { ok: false, field: 'accentColor', reason: a.reason };
  const primaryColor = p.value;
  const accentColor = a.value;

  return inTx(db, async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(partners)
      .set({ primaryColor, updatedAt: now })
      .where(eq(partners.id, partnerId))
      .returning({ id: partners.id });
    if (updated.length === 0) return { ok: false, reason: 'not_found' } as const;
    await tx
      .insert(partnerSites)
      .values({ partnerId, accentColor, updatedAt: now })
      .onConflictDoUpdate({ target: partnerSites.partnerId, set: { accentColor, updatedAt: now } });
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: 'partner.theme.update',
      subjectId: partnerId,
      meta: { primaryColor, accentColor },
    });
    return { ok: true } as const;
  });
}

/** ONE partner's theme, always re-validated (invalid or missing values fall back to the defaults). */
export async function loadSiteTheme(db: DbOrTx, partnerId: PartnerId): Promise<SiteTheme> {
  const [partner] = await db
    .select({ primaryColor: partners.primaryColor })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const site = partner ? await getPartnerSite(db, partnerId) : null;
  return resolveSiteTheme({ primaryColor: partner?.primaryColor, accentColor: site?.accentColor });
}
