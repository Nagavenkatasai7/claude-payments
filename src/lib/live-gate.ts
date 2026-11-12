// live-gate — Fix pack 2 (R02): is this transfer real money?
//
// Real money = the transfer settles on a real `http` rail and is not a sandbox
// ('test') transfer (the in-mint AML hold keys on it too: fix pack 6 P16). A
// failed rail read counts as real money: the stricter path (a live sanctions
// list required) is the safe one. Mock and simulator rails are demo, and stay
// demo only because a non-http rail never reaches a partner's stored URL.
//
// The rail is the SETTLEMENT partner's (railPartnerOf): a default-tenant
// transfer routed to an http partner is real money; an http owner routed to a
// simulator partner is not.

import { and, eq, min } from 'drizzle-orm';
import { auditEvents } from '@/db/schema';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import type { DbOrTx } from '@/db/client';
import { DEFAULT_PARTNER_ID } from './defaults';
import { env } from './env';
import { logWarn } from './log';
import type { LiveCapability } from './live-controls';
import { isLiveCertified, type LivePartner } from './live-certified';
import type { PartnerIntegrations } from './partner-integrations';
import type { PartnerId, Transfer, TransferEnvironment } from './types';

/** 'test' -> false; undefined (read failed) -> true; 'http' -> true; else false. */
export function realMoneyRail(r: {
  environment: TransferEnvironment | undefined;
  railProviderType: string | null | undefined;
}): boolean {
  if (r.environment === 'test') return false;
  if (r.railProviderType === undefined) return true;
  return r.railProviderType === 'http';
}

/** The partner whose rail settles the transfer: the routed partner, else the owner. */
export function railPartnerOf(t: { partnerId: PartnerId; settlementPartnerId?: PartnerId | null }): PartnerId {
  return t.settlementPartnerId ?? t.partnerId;
}

/**
 * The rail partner's payment provider type. Never throws: no row -> null (the
 * default mock rail), a failed read -> undefined (realMoneyRail reads it as
 * real money). Logs only the partner id.
 */
export async function readRailProviderType(db: DbOrTx, partnerId: PartnerId): Promise<string | null | undefined> {
  try {
    // A plain column: no sealed field is read, so no key is ever used.
    return await createIntegrationsRepo(db).paymentProviderType(partnerId);
  } catch (err) {
    logWarn('live-gate.rail_read', err, { partnerId });
    return undefined;
  }
}

/** Real money for a stored transfer. A 'test' transfer is never real money and makes no read. */
export async function realMoneyFor(
  db: DbOrTx,
  t: Pick<Transfer, 'partnerId' | 'settlementPartnerId' | 'environment'>,
): Promise<boolean> {
  if (t.environment === 'test') return false;
  const railProviderType = await readRailProviderType(db, railPartnerOf(t));
  return realMoneyRail({ environment: t.environment, railProviderType });
}


/**
 * Fix pack 2 T10 (R02): the ONE URL a settlement instruct or reverse is POSTed
 * to. Only an 'http' rail reaches the partner's stored URL; every other rail
 * (simulator, mock, absent) goes to the hosted reference rail in this app, so
 * a demo rail can never send money out. This is what makes realMoneyRail's
 * "'http' only" sound. Pure.
 */
export function settlementTargetUrl(p: PartnerIntegrations['payment']): string {
  if (p.providerType === 'http') return p.credentials?.settlementUrl ?? '';
  return `${env.appBaseUrl}/api/partner-rail`;
}

// ── Fix pack 3 (R15, R13; contract 3): live certification predicates ────────
//
// Real money stays realMoneyRail above. On real money the RAIL partner
// (railPartnerOf) must be certified for live money, and the default tenant may
// never own a real-money transfer. Nothing on a money path calls these yet
// (pack 3 T4-T6 and T12 wire them in).
// isLiveCertified / hasStandingCertification live in live-certified.ts (fix pack 7 DP1).

export { hasStandingCertification, isLiveCertified } from './live-certified';

type LiveTransfer = Pick<Transfer, 'partnerId' | 'settlementPartnerId' | 'environment'>;

export type LiveRefusalCode = 'live_not_certified' | 'default_on_live_rail';

/** The action of the audit row certifyLiveAction writes (writeCertification, live-controls-write.ts). */
export const LIVE_CERTIFY_AUDIT_ACTION = 'partner.live.certify';

/**
 * Review round 1 RC2: when did this rail partner go live? The EARLIEST
 * certification the stored data gives: the oldest 'partner.live.certify' audit
 * row for the partner (written in the certification's own transaction) or the
 * current live_controls.certification.certifiedAt, whichever is older. A
 * re-certification replaces certifiedAt, so the audit row keeps the first one.
 * A partner certified without an audit row (a direct write) has only its
 * current certifiedAt. null = never certified (or no row). Reads only: no
 * behaviour of the live gates changes. A failed read THROWS.
 */
export async function railGoLiveAt(db: DbOrTx, railPartnerId: PartnerId): Promise<Date | null> {
  const partner = await createPartnerRepo(db).getPartner(railPartnerId);
  const times: number[] = [];
  const certifiedAt = Date.parse(partner?.liveControls?.certification?.certifiedAt ?? '');
  if (!Number.isNaN(certifiedAt)) times.push(certifiedAt);
  const rows = await db
    .select({ first: min(auditEvents.at) })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.partnerId, railPartnerId),
        eq(auditEvents.subjectId, railPartnerId),
        eq(auditEvents.action, LIVE_CERTIFY_AUDIT_ACTION),
      ),
    );
  const first = rows[0]?.first;
  if (first !== null && first !== undefined) {
    const at = new Date(first).getTime();
    if (!Number.isNaN(at)) times.push(at);
  }
  return times.length === 0 ? null : new Date(Math.min(...times));
}

/** Not real money -> null; owner 'default' -> default_on_live_rail; uncertified rail -> live_not_certified. Pure. */
export function liveMoneyRefusal(r: { realMoney: boolean; ownerId: PartnerId; rail: LivePartner }): LiveRefusalCode | null {
  if (!r.realMoney) return null;
  if (r.ownerId === DEFAULT_PARTNER_ID) return 'default_on_live_rail';
  return isLiveCertified(r.rail) ? null : 'live_not_certified';
}

/**
 * The live refusal for a stored transfer when the caller already holds the
 * rail's payment provider type (pay-process, the b2b pay route, the payment
 * webhook), so the gate agrees with the caller's own real-money view and adds
 * no second rail-type read. `undefined` (the caller's read failed) is real
 * money. Not real money, or a default owner, makes no read. The rail partner
 * is read from the DB (createPartnerRepo, never getPartnerStore); a failed
 * read counts as not certified. Never throws.
 */
export async function liveRefusalForRail(
  db: DbOrTx,
  t: LiveTransfer,
  railProviderType: string | null | undefined,
): Promise<LiveRefusalCode | null> {
  if (!realMoneyRail({ environment: t.environment, railProviderType })) return null;
  if (t.partnerId === DEFAULT_PARTNER_ID) return 'default_on_live_rail';
  const railId = railPartnerOf(t);
  let rail: LivePartner = null;
  try {
    rail = await createPartnerRepo(db).getPartner(railId);
  } catch (err) {
    // The error NAME only: a driver error can carry the connection string.
    logWarn('live-gate.partner_read', err instanceof Error ? err.name : 'error', { partnerId: railId });
    rail = null;
  }
  return liveMoneyRefusal({ realMoney: true, ownerId: t.partnerId, rail });
}

/**
 * The live refusal for a stored transfer when nothing is in hand (the
 * reconcile and stale-money sweeps, which skip a refused row): reads the rail
 * type itself, and a failed read refuses. A request path (Partner API confirm,
 * pay-process, the b2b route) uses liveRefusalForRail on the integrations it
 * read, so a failed read there is a retryable error, never a refusal. A 'test'
 * transfer makes no read. Never throws.
 */
export async function liveRefusalFor(db: DbOrTx, t: LiveTransfer): Promise<LiveRefusalCode | null> {
  if (t.environment === 'test') return null;
  try {
    return await liveRefusalForRail(db, t, await readRailProviderType(db, railPartnerOf(t)));
  } catch {
    // Unreachable today (both reads catch); fail closed if that ever changes.
    return t.partnerId === DEFAULT_PARTNER_ID ? 'default_on_live_rail' : 'live_not_certified';
  }
}

/**
 * A capability (b2b, usdc, ...) is open for a partner that is not certified
 * (today's behaviour); a certified partner needs counsel's review on record
 * AND the partner's own approval. Pure.
 */
export function capabilityOpen(p: LivePartner, cap: LiveCapability): boolean {
  if (!isLiveCertified(p)) return true;
  const o = p?.liveControls?.optIns[cap];
  return Boolean(o?.counselRef && o.partnerApprovedAt);
}
