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
// Claimed once, changed only by the platform, never reused (UI redesign M3-18):
// - mode 'claim' (the default; the partner's self-service claim) succeeds only while the partner has
//   NO slug. The check runs inside the writer's transaction, after a FOR UPDATE lock on the partner
//   row, so two concurrent claims by one partner serialise and the second sees the first's slug.
// - mode 'change' (platform only; the caller gates on requirePlatformAdmin) moves a partner to a new
//   slug and writes the old one to partner_slug_tombstones (migration 0028) in the SAME transaction.
// - a tombstoned slug is unavailable to EVERY partner, including the one that released it: another
//   partner would receive the first partner's old links, and the same partner reclaiming it would
//   resurrect links the platform deliberately retired.
// Belt and braces for history written before the tombstone table: a slug that appears in another
// partner's slug audit history (claimed or set), or that ANY partner released (`previousSlug`), is
// also unavailable. Every refusal is the same generic `unavailable` (no oracle).
//
// Site skins (src/lib/site-skins.ts): a skin slug (e.g. `tgfl`) is a host that an EXISTING tenant
// serves. No partner may claim one (setPartnerSlug refuses it in both modes), and
// readSkinSlugStatus tells the resolver whether a partner holds or ever held it (then the partner's
// rules decide the host, never the skin).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditEvents, partners, partnerSites, partnerSlugTombstones } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { resolveSiteTheme, validateThemeColor, type SiteTheme } from '@/lib/ui/theme';
import type { PartnerId } from '@/lib/types';
import { isValidSiteSlug, siteCacheKey } from '@/lib/site-host';
import { isSkinSlug } from '@/lib/site-skins';
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

/** node-postgres / neon return { rows }; PGlite too. Tolerate a bare array as well. */
function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  return ((r as { rows?: T[] } | null)?.rows ?? []) as T[];
}

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
 * `partner.theme.update` audit row. Colours are not PII, so the audit carries them. `opts.actorScope`
 * (derived server-side by the caller from the session, never from input) is added to the audit
 * meta so the tenant audit viewer can label the actor; without it the meta is unchanged.
 */
export async function savePartnerTheme(
  db: DbOrTx,
  partnerId: PartnerId,
  input: { primaryColor: unknown; accentColor: unknown },
  actor: string,
  opts: { actorScope?: 'platform' | 'partner' } = {},
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
      meta: { primaryColor, accentColor, ...(opts.actorScope ? { actorScope: opts.actorScope } : {}) },
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

export type SetSlugResult = { ok: true } | { ok: false; reason: 'unavailable' | 'not_found' | 'already_claimed' };

/** The partner's self-service claim (once) or a platform change (moves and tombstones the old slug). */
export type SetSlugMode = 'claim' | 'change';
/** The audit action for each mode. Both are read by the "ever held" history check. */
const SLUG_AUDIT_ACTION: Record<SetSlugMode, string> = { claim: 'partner.slug.claim', change: 'partner.slug.update' };
const SLUG_AUDIT_ACTIONS = Object.values(SLUG_AUDIT_ACTION);

/**
 * The ONE statement behind readSkinSlugStatus (exported so a test can EXPLAIN exactly this SQL).
 *
 * It runs on the public request path (the resolver, on a status-cache miss while the skin switch
 * is on), so every arm must have an index to use:
 * - partner_sites by slug (the unique slug index) and tombstones by slug (the primary key);
 * - the slug audit history through `audit_subject_action (subject_id, action)`: slug audit rows
 *   have always been written with subject_id = the partner's id, so the arm walks the (small)
 *   partners table and probes that index per partner. It never needs a scan of the whole
 *   audit_events table, which grows with every pii.view and sanctions.screen row.
 */
export function skinSlugStatusQuery(slug: string, partnerId: PartnerId) {
  return sql`
    select
      (
        exists (select 1 from ${partnerSites} where ${partnerSites.slug} = ${slug})
        or exists (select 1 from ${partnerSlugTombstones} where ${partnerSlugTombstones.slug} = ${slug})
        or exists (
          select 1 from ${partners}
          inner join ${auditEvents} on ${auditEvents.subjectId} = ${partners.id}
          where ${inArray(auditEvents.action, SLUG_AUDIT_ACTIONS)}
            and (${auditEvents.meta}->>'slug' = ${slug} or ${auditEvents.meta}->>'previousSlug' = ${slug})
        )
      ) as held,
      exists (select 1 from ${partners} where ${partners.id} = ${partnerId} and ${partners.status} = 'active') as tenant_active`;
}

/**
 * For a SKIN slug (site-skins.ts), in ONE statement (one snapshot, one round trip):
 * - `held`: a partner holds the slug now (ANY status: a suspended partner keeps its slug), or it is
 *   tombstoned, or a partner's slug audit history names it (claimed, set or released). The same
 *   three sources as setPartnerSlug's availability check, without the "another partner" carve-out:
 *   a skin never takes over a host a partner had.
 * - `tenantActive`: the tenant the skin maps to exists and is 'active'.
 * Not tenant-scoped by design: the question is "does ANY partner hold this slug". It returns two
 * booleans and no row data. Throws on a database error; the resolver fails closed.
 */
export async function readSkinSlugStatus(
  db: DbOrTx,
  slug: string,
  partnerId: PartnerId,
): Promise<{ held: boolean; tenantActive: boolean }> {
  const res = await db.execute(skinSlugStatusQuery(slug, partnerId));
  const row = rowsOf<{ held: boolean; tenant_active: boolean }>(res)[0];
  // No row can only mean an unexpected driver shape: report "held" so the skin stays closed.
  if (!row) return { held: true, tenantActive: false };
  return { held: row.held === true, tenantActive: row.tenant_active === true };
}

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

/**
 * Set `slug` for ONE partner. Reserved, `??--`, malformed, held by another partner, tombstoned, and
 * ever held by another partner or released by anyone (audit history, see the header) all return
 * the SAME `unavailable`, so the writer is not an oracle for which slugs exist. In ONE transaction:
 * the partner row is locked FOR UPDATE (else not_found); in 'claim' mode a partner that already has
 * a slug gets `already_claimed`; in 'change' mode the old slug is tombstoned (`released_by = actor`);
 * the partner_sites row is upserted (slug only; the accent colour is kept), and one audit row
 * (`partner.slug.claim` / `partner.slug.update`) records { slug, previousSlug } plus the
 * server-derived `actorScope` and the platform's `reason` when given. After commit the cache entries
 * for the old and the new slug are deleted; if that fails the 60 s TTL bounds staleness.
 *
 * `deps.mode` defaults to 'claim' (the safe default: nothing can move an existing slug unless a
 * platform-gated caller asks for 'change').
 *
 * Pass the top-level Db, not an open transaction: inside a caller's tx a lost unique-index race
 * (23505) is returned as `unavailable` but leaves that outer transaction aborted.
 */
export async function setPartnerSlug(
  db: DbOrTx,
  partnerId: PartnerId,
  slug: string,
  actor: string,
  deps: { redis?: RedisLike; mode?: SetSlugMode; actorScope?: 'platform' | 'partner'; reason?: string } = {},
): Promise<SetSlugResult> {
  // A skin slug belongs to the skin list (code), never to a partner: refused in both modes, before
  // any read, with the same generic answer.
  if (!isValidSiteSlug(slug) || isSkinSlug(slug)) return { ok: false, reason: 'unavailable' };
  const mode: SetSlugMode = deps.mode ?? 'claim';

  type TxOut = SetSlugResult & { previousSlug?: string | null; changed?: boolean };
  let out: TxOut;
  try {
    out = await inTx(db, async (tx): Promise<TxOut> => {
      // FOR NO KEY UPDATE: every slug write for this partner serialises here (the mode conflicts with
      // itself), so the claim-once check and the tombstone below read the slug as committed by any
      // earlier writer. It does NOT conflict with the FOR KEY SHARE that FK child inserts (transfers,
      // outbox, ...) take on the partner row, so money paths never wait on a slug write. Drizzle:
      // select().for(), node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586; LockStrength at
      // select.types.d.ts:60.
      const [partner] = await tx
        .select({ id: partners.id })
        .from(partners)
        .where(eq(partners.id, partnerId))
        .limit(1)
        .for('no key update');
      if (!partner) return { ok: false, reason: 'not_found' };
      const current = await getPartnerSite(tx, partnerId);
      const previousSlug = current?.slug ?? null;
      if (mode === 'claim' && previousSlug !== null) return { ok: false, reason: 'already_claimed' };
      if (previousSlug === slug) return { ok: true, changed: false };

      // ONE statement for the three availability checks (held by another partner, tombstoned, in the
      // slug audit history): a single snapshot, so a concurrent release (slug freed + tombstoned in one
      // commit) is seen either as "held" or as "tombstoned", never as neither; and every refusal costs
      // the same round trip (no timing oracle between the reasons).
      const blocked = await tx.execute(sql`
        select (
          exists (select 1 from ${partnerSites} where ${partnerSites.slug} = ${slug} and ${partnerSites.partnerId} <> ${partnerId})
          or exists (select 1 from ${partnerSlugTombstones} where ${partnerSlugTombstones.slug} = ${slug})
          or exists (
            select 1 from ${auditEvents}
            where ${inArray(auditEvents.action, SLUG_AUDIT_ACTIONS)}
              and (${auditEvents.meta}->>'previousSlug' = ${slug}
                   or (${auditEvents.meta}->>'slug' = ${slug} and ${auditEvents.partnerId} is distinct from ${partnerId}))
          )
        ) as blocked`);
      if (rowsOf<{ blocked: boolean }>(blocked)[0]?.blocked) return { ok: false, reason: 'unavailable' };

      const now = new Date();
      if (previousSlug !== null) {
        // Only 'change' reaches here with a previous slug (claim returned already_claimed above).
        await tx
          .insert(partnerSlugTombstones)
          .values({ slug: previousSlug, partnerId, releasedBy: actor, releasedAt: now })
          .onConflictDoNothing({ target: partnerSlugTombstones.slug });
      }
      await tx
        .insert(partnerSites)
        .values({ partnerId, slug, updatedAt: now })
        .onConflictDoUpdate({ target: partnerSites.partnerId, set: { slug, updatedAt: now } });
      await createAuditRepo(tx).record({
        partnerId,
        actor,
        actorType: 'staff',
        action: SLUG_AUDIT_ACTION[mode],
        subjectId: partnerId,
        meta: {
          slug,
          previousSlug,
          ...(deps.actorScope ? { actorScope: deps.actorScope } : {}),
          ...(deps.reason ? { reason: deps.reason } : {}),
        },
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
