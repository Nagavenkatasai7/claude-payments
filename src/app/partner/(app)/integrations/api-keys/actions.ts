'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { scopeOf } from '@/lib/staff-scope';
import { getDb, type DbOrTx } from '@/db/client';
import { apiKeys, partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { isLiveApproved } from '@/db/repos/partner-go-live-repo';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
import { keyModeFromId, type ApiKeyMode } from '@/lib/partner-api-scopes';
import { MAX_KEYS_PER_MODE, activeCount, parseKeyId, parseKeyMode, type KeyIssueResult } from '@/lib/partner-api-keys-view';
import { getRedis } from '@/lib/redis';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

// /partner/integrations/api-keys actions (UI redesign M3-14). Each one: the site-host guard, then
// the admin gate (+ MFA enrolment), both outside any try. The tenant is ALWAYS ctx.partnerId; a
// key id from the form is resolved INSIDE that tenant (404-never-403).
//
// Keys are minted by the EXISTING repo (createPartnerApiKeyStore → api-key-repo.ts issue: CSPRNG
// secret, SHA-256+pepper hash at rest), so the partner API authenticates them exactly like a key
// SmartRemit staff issue (partners/actions.ts:727-782). The plaintext is returned in the action
// result ONLY: never in an audit row (meta: keyId, mode, last4, actorScope), a log line or a
// revalidated page. Sandbox keys always; live keys only when isLiveApproved (go-live approved).
//
// Issuance serialises per tenant on the partners row (SELECT … FOR UPDATE: drizzle
// node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586, precedent
// partner-requests/actions.ts:61-67), so the per-mode cap cannot be raced past.

const PAGE = PARTNER_ROUTES.integrationsApiKeys.href;
// Create and rotate share ONE budget per tenant. FAILS CLOSED on a limiter error (issuing a
// credential is never urgent). Revoke is never limited: it is the incident-response path.
const ISSUE_LIMIT = { scope: 'partner-apikey-issue', limit: 10, windowSec: 3600 } as const;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
/** The audit marker, derived from the authenticated record (never from input). */
const actorScopeOf = (ctx: PartnerCtx) => scopeOf(ctx.staff).kind;

class Refusal extends Error {
  constructor(
    readonly key: MessageKey,
    readonly vars?: Record<string, string | number>,
  ) {
    super('refused');
    this.name = 'Refusal';
  }
}
const refused = (key: MessageKey, vars?: Record<string, string | number>) => ({ ok: false as const, error: t(key, vars) });

async function withinIssueLimit(partnerId: string): Promise<boolean> {
  try {
    return (await checkIpRateLimit(getRedis(), ISSUE_LIMIT.scope, partnerId, { limit: ISSUE_LIMIT.limit, windowSec: ISSUE_LIMIT.windowSec })).allowed;
  } catch (err) {
    logWarn('partner.apikeys.limit', errName(err), { partnerId });
    return false;
  }
}

/** Lock this tenant's key set for the transaction (the partners row is the per-tenant mutex). */
async function lockTenant(tx: DbOrTx, partnerId: string): Promise<void> {
  await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update');
}

/** A key row of THIS tenant, locked. Null for unknown and foreign ids alike. */
async function lockOwnedKey(tx: DbOrTx, partnerId: string, keyId: string) {
  const rows = await tx
    .select({ id: apiKeys.id, last4: apiKeys.last4, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.partnerId, partnerId)))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

async function issue(ctx: PartnerCtx, source: string, target: { mode: ApiKeyMode } | { rotateFrom: string }): Promise<KeyIssueResult> {
  if (!(await withinIssueLimit(ctx.partnerId))) return refused('partner.keys.rateLimited');
  let result: KeyIssueResult;
  try {
    result = await getDb().transaction(async (tx) => {
      await lockTenant(tx, ctx.partnerId);
      let mode: ApiKeyMode;
      let rotatedFrom: string | undefined;
      if ('rotateFrom' in target) {
        const old = await lockOwnedKey(tx, ctx.partnerId, target.rotateFrom);
        if (!old || old.revokedAt) throw new Refusal('partner.keys.notFound');
        mode = keyModeFromId(old.id); // the mode comes from the key, never the form
        rotatedFrom = old.id;
      } else {
        mode = target.mode;
      }
      if (mode === 'live' && !(await isLiveApproved(tx, ctx.partnerId))) throw new Refusal('partner.keys.liveAfterGoLive');
      const store = createPartnerApiKeyStore(tx);
      if (activeCount(await store.list(ctx.partnerId), mode) >= MAX_KEYS_PER_MODE) throw new Refusal('partner.keys.cap', { max: MAX_KEYS_PER_MODE });
      const k = await store.issue(ctx.partnerId, mode);
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'api_key.issue',
        subjectId: k.keyId,
        meta: { keyId: k.keyId, mode, last4: k.last4, actorScope: actorScopeOf(ctx), ...(rotatedFrom ? { rotatedFrom } : {}) },
      });
      return { ok: true as const, plaintext: k.plaintext, last4: k.last4, mode };
    });
  } catch (err) {
    if (err instanceof Refusal) return refused(err.key, err.vars);
    logWarn(source, errName(err), { partnerId: ctx.partnerId });
    return refused('partner.keys.failed');
  }
  revalidatePath(PAGE);
  return result;
}

export async function createKeyAction(_prev: KeyIssueResult | null, formData: FormData): Promise<KeyIssueResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsApiKeys.policy);
  const mode = parseKeyMode(formData.get('mode'));
  if (!mode) return refused('partner.keys.invalid');
  return issue(ctx, 'partner.apikeys.create', { mode });
}

export async function rotateKeyAction(_prev: KeyIssueResult | null, formData: FormData): Promise<KeyIssueResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsApiKeys.policy);
  const keyId = parseKeyId(formData.get('id'));
  if (!keyId) return refused('partner.keys.notFound');
  return issue(ctx, 'partner.apikeys.rotate', { rotateFrom: keyId });
}

export async function revokeKeyAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsApiKeys.policy);
  const keyId = parseKeyId(formData.get('id'));
  if (!keyId) return refused('partner.keys.notFound');
  try {
    await getDb().transaction(async (tx) => {
      const key = await lockOwnedKey(tx, ctx.partnerId, keyId);
      if (!key) throw new Refusal('partner.keys.notFound');
      if (key.revokedAt) return; // already revoked: an idempotent no-op, no second audit row
      // The repo's revoke WHERE carries partner_id too (api-key-repo.ts revoke).
      if (!(await createPartnerApiKeyStore(tx).revoke(keyId, ctx.partnerId))) throw new Refusal('partner.keys.notFound');
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'api_key.revoke',
        subjectId: keyId,
        meta: { keyId, last4: key.last4, actorScope: actorScopeOf(ctx) },
      });
    });
  } catch (err) {
    if (err instanceof Refusal) return refused(err.key, err.vars);
    logWarn('partner.apikeys.revoke', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.keys.failed');
  }
  revalidatePath(PAGE);
  return { ok: true };
}
