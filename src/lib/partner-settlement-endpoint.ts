import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { partnerWebhookDeliveries, partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { env } from '@/lib/env';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { PREVIOUS_SECRET_KEYS, RAIL_SECRET_GRACE_MS, railSecrets, withRotatedSecret, type PartnerIntegrations, type RailSecretKind } from '@/lib/partner-integrations';
import { signRailHeaders } from '@/lib/providers/rail-signature';
import { getRedis } from '@/lib/redis';
import { safeFetch } from '@/lib/safe-fetch';
import { checkSettlementUrl } from '@/lib/settlement-url';
import type { RedisLike } from '@/lib/store';

// partner-settlement-endpoint (UI redesign M3-15a): the partner's self-service settlement webhook,
// per owner answer O2 the EXISTING settlement endpoint the worker POSTs signed instructions to
// (outbox-worker.ts settlement.instruct reads payment.credentials.settlementUrl and
// railSecrets(payment,'signing') at delivery time). Three operations:
//   • saveSettlementEndpoint — the URL, behind checkSettlementUrl (settlement-url.ts:47) PLUS a
//     partner-surface rule: never a SmartRemit host (review round 1, R3). In production the https
//     app origin passes checkSettlementUrl like any public host (settlement-url.ts:62-66); a partner
//     admin must not aim signed instructions or pings at SmartRemit's own API.
//   • rotateRailSecret — a CSPRNG secret; the old one keeps working for RAIL_SECRET_GRACE_MS via
//     withRotatedSecret (partner-integrations.ts:112). Returned ONCE; never audited or logged.
//   • sendTestPing — a signed `{"type":"ping"}` through safeFetch ONLY (connect-time address check,
//     redirects re-checked: safe-fetch.ts:114), rate-limited per tenant, network I/O outside any
//     transaction, then one partner_webhook_deliveries row (no URL, no body) + one audit row.
//
// NOT a 'use server' module: these take a partnerId and trust it. Callers gate first and pass the
// SESSION tenant. Only a partner-operated rail (providerType 'http') is self-service: simulator and
// mock rails are managed by SmartRemit (the legacy Settlement tab), so every write refuses them.
//
// Every write reads the integrations row INSIDE a transaction that first locks the tenant's
// partners row (SELECT … FOR UPDATE: drizzle-orm pg-core select.d.ts `for`; the same per-tenant
// mutex as api-keys/actions.ts), then spreads the WHOLE config back: saveIntegrations rewrites every
// column (integrations-repo.ts:58-80), so a dropped field would silently null a secret (the inbound
// status webhook would then fail closed for in-flight transfers).
// The WhatsApp writers (partner-whatsapp-config.ts) take the same lock and re-read in their
// transaction. The legacy platform-admin savePaymentConfigAction (admin-dashboard, freeze-listed)
// does not yet: a platform save racing a partner rotation can still undo it (follow-up).

/** The platform's own hosts (and every subdomain of the first). A partner endpoint may be none of them. */
export const SMARTREMIT_HOSTS = Object.freeze(['smartremit.ai', 'claude-payments.vercel.app'] as const);
/** Vercel preview / branch deployments of the app (they share the production database). */
const PREVIEW_HOST = /^claude-payments-[a-z0-9-]+\.vercel\.app$/;

/** Ping budget per tenant (checkIpRateLimit keyed by partner id; ip-rate-limit.ts:55). */
export const PING_LIMIT = Object.freeze({ scope: 'partner-webhook-test', limit: 5, windowSec: 600 });
/** A ping never waits longer than this for the partner's endpoint. */
export const PING_TIMEOUT_MS = 5000;

export interface EndpointActor {
  username: string;
  /** Server-derived (scopeOf(ctx.staff).kind), never input. */
  actorScope: 'partner' | 'platform';
}

interface UrlOpts {
  appOrigin?: string;
  production?: boolean;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `hostname` is SmartRemit itself: the app origin's host, a SMARTREMIT_HOSTS entry, a *.smartremit.ai, or a preview. */
export function isSmartRemitHost(hostname: string, appOrigin: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === hostOf(appOrigin)) return true;
  if ((SMARTREMIT_HOSTS as readonly string[]).includes(h)) return true;
  if (h.endsWith(`.${SMARTREMIT_HOSTS[0]}`)) return true;
  return PREVIEW_HOST.test(h);
}

/** The partner-surface URL rule: the worker's rule, then never a SmartRemit host. */
export function checkPartnerEndpointUrl(raw: string, opts: UrlOpts = {}): { ok: true; url: URL } | { ok: false } {
  const appOrigin = opts.appOrigin ?? env.appBaseUrl;
  const check = checkSettlementUrl(raw, { appOrigin, production: opts.production ?? env.isProduction });
  if (!check.ok || check.appOrigin) return { ok: false };
  if (isSmartRemitHost(check.url.hostname, appOrigin)) return { ok: false };
  return { ok: true, url: check.url };
}

const isPartnerRail = (cfg: PartnerIntegrations) => cfg.payment.providerType === 'http';

async function lockTenant(tx: DbOrTx, partnerId: string): Promise<void> {
  await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update');
}

class InGrace extends Error {
  constructor(readonly graceUntil: string) {
    super('rotation_in_grace');
    this.name = 'InGrace';
  }
}

class NotPartnerRail extends Error {
  constructor() {
    super('not_partner_rail');
    this.name = 'NotPartnerRail';
  }
}

export type SaveEndpointResult = { ok: true } | { ok: false; reason: 'not_partner_rail' | 'invalid_url' };

export async function saveSettlementEndpoint(db: Db, partnerId: string, actor: EndpointActor, rawUrl: string, opts: UrlOpts = {}): Promise<SaveEndpointResult> {
  try {
    return await db.transaction(async (tx) => {
      await lockTenant(tx, partnerId);
      const store = createPartnerIntegrationsStore(tx);
      const existing = await store.getIntegrations(partnerId);
      if (!isPartnerRail(existing)) throw new NotPartnerRail();
      const checked = checkPartnerEndpointUrl(typeof rawUrl === 'string' ? rawUrl : '', opts);
      if (!checked.ok) return { ok: false as const, reason: 'invalid_url' as const };
      const settlementUrl = checked.url.href;
      await store.saveIntegrations(partnerId, {
        ...existing,
        payment: { ...existing.payment, credentials: { ...existing.payment.credentials, settlementUrl } },
      });
      await createAuditRepo(tx).record({
        partnerId,
        actor: actor.username,
        actorType: 'staff',
        action: 'partner.settlement_endpoint.update',
        subjectId: partnerId,
        meta: { host: checked.url.host, actorScope: actor.actorScope },
      });
      return { ok: true as const };
    });
  } catch (err) {
    if (err instanceof NotPartnerRail) return { ok: false, reason: 'not_partner_rail' };
    throw err;
  }
}

export type RotateResult =
  | { ok: true; secret: string; graceUntil: string | null }
  | { ok: false; reason: 'not_partner_rail' }
  | { ok: false; reason: 'rotation_in_grace'; graceUntil: string };

export async function rotateRailSecret(
  db: Db,
  partnerId: string,
  actor: EndpointActor,
  kind: RailSecretKind,
  deps: { now?: () => Date; endGrace?: boolean } = {},
): Promise<RotateResult> {
  const now = (deps.now ?? (() => new Date()))();
  const fresh = randomBytes(32).toString('hex');
  try {
    return await db.transaction(async (tx) => {
      await lockTenant(tx, partnerId);
      const store = createPartnerIntegrationsStore(tx);
      const existing = await store.getIntegrations(partnerId);
      if (!isPartnerRail(existing)) throw new NotPartnerRail();
      // The legacy writer's shape (partners/actions.ts savePaymentConfigAction): the current signing
      // secret lives in the credentials blob, the current webhook secret in payment.webhookSecret;
      // withRotatedSecret records only the previous/until pair in the blob.
      const creds = existing.payment.credentials ?? {};
      const old = kind === 'signing' ? creds.signingSecret : existing.payment.webhookSecret;
      // M3-15a review M1: a previous secret still in its grace is the one the partner most likely
      // still runs (the current one may never have been deployed). Rotating again would drop it at
      // once, so it is refused unless the admin explicitly ends that grace (endGrace).
      const inGrace = railSecrets(existing.payment, kind, now).length > 1;
      const priorUntil = creds[PREVIOUS_SECRET_KEYS[kind].until] ?? '';
      if (inGrace && !deps.endGrace) throw new InGrace(priorUntil);
      const credentials = withRotatedSecret(creds, kind, old, fresh, now);
      let webhookSecret = existing.payment.webhookSecret;
      if (kind === 'signing') credentials.signingSecret = fresh;
      else webhookSecret = fresh;
      await store.saveIntegrations(partnerId, { ...existing, payment: { ...existing.payment, credentials, webhookSecret } });
      const graceUntil = old && old !== fresh ? new Date(now.getTime() + RAIL_SECRET_GRACE_MS).toISOString() : null;
      await createAuditRepo(tx).record({
        partnerId,
        actor: actor.username,
        actorType: 'staff',
        action: 'partner.settlement_secret.rotate',
        subjectId: partnerId,
        meta: { kind, graceUntil, ...(inGrace ? { endedGrace: true } : {}), actorScope: actor.actorScope },
      });
      return { ok: true as const, secret: fresh, graceUntil };
    });
  } catch (err) {
    if (err instanceof NotPartnerRail) return { ok: false, reason: 'not_partner_rail' };
    if (err instanceof InGrace) return { ok: false, reason: 'rotation_in_grace', graceUntil: err.graceUntil };
    throw err;
  }
}

export type PingOutcome = 'ok' | 'http_error' | 'network' | 'refused';
export type PingResult =
  | { ok: true; outcome: PingOutcome; httpStatus: number | null; latencyMs: number }
  | { ok: false; reason: 'rate_limited' | 'not_partner_rail' | 'no_endpoint' | 'no_signing_secret' };

export interface PingDeps extends UrlOpts {
  fetchFn?: typeof fetch;
  now?: () => Date;
  redis?: RedisLike;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

async function withinPingLimit(redis: RedisLike, partnerId: string, nowMs: number): Promise<boolean> {
  try {
    return (await checkIpRateLimit(redis, PING_LIMIT.scope, partnerId, { limit: PING_LIMIT.limit, windowSec: PING_LIMIT.windowSec, now: nowMs })).allowed;
  } catch (err) {
    logWarn('partner.webhooks.ping-limit', errName(err), { partnerId });
    return false; // fail closed: a test event is never urgent
  }
}

/** safeFetch refusals carry a fixed `settlement_url_refused:<reason>` message (safe-fetch.ts refused()). */
const isUrlRefusal = (e: unknown) => e instanceof Error && e.message.startsWith('settlement_url_refused:');

export async function sendTestPing(db: Db, partnerId: string, actor: EndpointActor, deps: PingDeps = {}): Promise<PingResult> {
  const now = (deps.now ?? (() => new Date()))();
  // Configuration refusals first (no network, no row): they do not consume the rate-limit budget.
  const cfg = await createPartnerIntegrationsStore(db).getIntegrations(partnerId);
  if (!isPartnerRail(cfg)) return { ok: false, reason: 'not_partner_rail' };
  const stored = cfg.payment.credentials?.settlementUrl ?? '';
  if (stored === '') return { ok: false, reason: 'no_endpoint' };
  const secrets = railSecrets(cfg.payment, 'signing', now);
  if (secrets.length === 0) return { ok: false, reason: 'no_signing_secret' };
  if (!(await withinPingLimit(deps.redis ?? getRedis(), partnerId, now.getTime()))) return { ok: false, reason: 'rate_limited' };

  let outcome: PingOutcome;
  let httpStatus: number | null = null;
  const started = performance.now();
  // The stored URL is re-checked with BOTH rules before any request (it may predate them).
  const checked = checkPartnerEndpointUrl(stored, deps);
  if (!checked.ok) {
    outcome = 'refused';
  } else {
    const rawBody = JSON.stringify({ type: 'ping', id: randomUUID(), created: Math.floor(now.getTime() / 1000) });
    try {
      // Network I/O happens here, OUTSIDE any transaction. The body of the reply is never read.
      const res = await (deps.fetchFn ?? safeFetch)(checked.url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signRailHeaders(rawBody, secrets, now.getTime()) },
        body: rawBody,
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      httpStatus = res.status;
      outcome = res.ok ? 'ok' : 'http_error';
    } catch (err) {
      outcome = isUrlRefusal(err) ? 'refused' : 'network';
    }
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - started));

  await db.transaction(async (tx) => {
    await tx.insert(partnerWebhookDeliveries).values({ partnerId, kind: 'ping', attempt: 1, outcome, httpStatus, latencyMs });
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: 'webhook.test',
      subjectId: partnerId,
      meta: { outcome, httpStatus, actorScope: actor.actorScope },
    });
  });
  return { ok: true, outcome, httpStatus, latencyMs };
}

export interface PingView {
  createdAt: Date;
  outcome: string;
  httpStatus: number | null;
  latencyMs: number | null;
}

/** The tenant's last `limit` test pings, newest first. Never a URL, a body or another tenant's row. */
export async function listRecentPings(db: DbOrTx, partnerId: string, limit = 10): Promise<PingView[]> {
  return db
    .select({
      createdAt: partnerWebhookDeliveries.createdAt,
      outcome: partnerWebhookDeliveries.outcome,
      httpStatus: partnerWebhookDeliveries.httpStatus,
      latencyMs: partnerWebhookDeliveries.latencyMs,
    })
    .from(partnerWebhookDeliveries)
    .where(and(eq(partnerWebhookDeliveries.partnerId, partnerId), eq(partnerWebhookDeliveries.kind, 'ping')))
    .orderBy(desc(partnerWebhookDeliveries.createdAt), desc(partnerWebhookDeliveries.id))
    .limit(Math.max(1, Math.min(50, Math.floor(limit))));
}
