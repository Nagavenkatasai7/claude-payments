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
// Slugs: ONLY setPartnerSlug writes `slug`. The theme upsert's insert and update lists name only
// accent_color/updated_at, so a theme write can never clear or change a slug (a suspended
// partner keeps its slug).
//
// Never reuse a released slug: a partner that re-slugs releases its old slug, and a DIFFERENT
// partner claiming it would receive the first partner's old links. Until the tombstone table
// (planned for migration 0027) exists, setPartnerSlug refuses any slug that appears in another
// partner's `partner.slug.update` audit history, as the claimed slug OR as the slug that partner
// released (`previousSlug`). The claim's audit row commits in the same transaction as the slug, and
// a release records the old slug, so this also covers a slug first written outside the writer once
// the writer moves the partner off it. Known gaps, closed by 0027: a slug written by direct SQL and
// then released by direct SQL (no audit row at all) is protected only while it is still held
// (unique index), and deleting audit rows would erase the history the check relies on.
import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, partners, partnerSites } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { resolveSiteTheme, validateThemeColor, type SiteTheme } from '@/lib/ui/theme';
import type { PartnerId } from '@/lib/types';
import { isValidSiteSlug, siteCacheKey } from '@/lib/site-host';
import { getRedis } from '@/lib/redis';
import type { RedisLike } from '@/lib/store';
import { logWarn } from '@/lib/log';

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

/**
 * The ACTIVE partner holding `slug`, or null (unknown slug, or the partner is not 'active').
 * Joins partners so a suspended or disabled partner stops routing on the next cache miss.
 */
export async function findActivePartnerIdBySlug(db: DbOrTx, slug: string): Promise<string | null> {
  const rows = await db
    .select({ id: partners.id })
    .from(partnerSites)
    .innerJoin(partners, eq(partners.id, partnerSites.partnerId))
    .where(and(eq(partnerSites.slug, slug), eq(partners.status, 'active')))
    .limit(1);
  return rows[0]?.id ?? null;
}

export type SetSlugResult = { ok: true } | { ok: false; reason: 'unavailable' | 'not_found' };

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

/**
 * Claim `slug` for ONE partner. Reserved, `??--`, malformed, held by another partner, and ever
 * held by another partner (audit history, see the header) all return the SAME `unavailable`, so
 * the writer is not an oracle for which slugs exist. In ONE transaction: the partner must exist
 * (else not_found), the partner_sites row is upserted (slug only; the accent colour is kept),
 * and a `partner.slug.update` audit row records { slug, previousSlug }. After commit the cache
 * entries for the old and the new slug are deleted; if that fails the 60 s TTL bounds staleness.
 *
 * Pass the top-level Db, not an open transaction: inside a caller's tx a lost unique-index race
 * (23505) is returned as `unavailable` but leaves that outer transaction aborted.
 */
export async function setPartnerSlug(
  db: DbOrTx,
  partnerId: PartnerId,
  slug: string,
  actor: string,
  deps: { redis?: RedisLike } = {},
): Promise<SetSlugResult> {
  if (!isValidSiteSlug(slug)) return { ok: false, reason: 'unavailable' };

  type TxOut = SetSlugResult & { previousSlug?: string | null; changed?: boolean };
  let out: TxOut;
  try {
    out = await inTx(db, async (tx): Promise<TxOut> => {
      const [partner] = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1);
      if (!partner) return { ok: false, reason: 'not_found' };
      const current = await getPartnerSite(tx, partnerId);
      const previousSlug = current?.slug ?? null;
      if (previousSlug === slug) return { ok: true, changed: false };

      const [heldByOther] = await tx
        .select({ id: partnerSites.partnerId })
        .from(partnerSites)
        .where(eq(partnerSites.slug, slug))
        .limit(1);
      if (heldByOther) return { ok: false, reason: 'unavailable' };
      const [everHeldByOther] = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'partner.slug.update'),
            sql`(${auditEvents.meta}->>'slug' = ${slug} or ${auditEvents.meta}->>'previousSlug' = ${slug})`,
            sql`${auditEvents.partnerId} is distinct from ${partnerId}`,
          ),
        )
        .limit(1);
      if (everHeldByOther) return { ok: false, reason: 'unavailable' };

      const now = new Date();
      await tx
        .insert(partnerSites)
        .values({ partnerId, slug, updatedAt: now })
        .onConflictDoUpdate({ target: partnerSites.partnerId, set: { slug, updatedAt: now } });
      await createAuditRepo(tx).record({
        partnerId,
        actor,
        actorType: 'staff',
        action: 'partner.slug.update',
        subjectId: partnerId,
        meta: { slug, previousSlug },
      });
      return { ok: true, changed: true, previousSlug };
    });
  } catch (e) {
    // The unique index lost a race with another claim of the same slug.
    if (isUniqueViolation(e)) return { ok: false, reason: 'unavailable' };
    throw e;
  }

  if (!out.ok) return { ok: false, reason: out.reason };
  if (out.changed) {
    try {
      const redis = deps.redis ?? getRedis();
      await redis.del(siteCacheKey(slug));
      if (out.previousSlug) await redis.del(siteCacheKey(out.previousSlug));
    } catch {
      logWarn('site-tenant', 'slug cache clear failed', { slug });
    }
  }
  return { ok: true };
}
