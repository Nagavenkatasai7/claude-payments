// live-gate — Fix pack 2 (R02): is this transfer real money?
//
// Real money = the transfer settles on a real `http` rail (the same test as
// aml-hold.ts amlHoldRailEligible) and is not a sandbox ('test') transfer. A
// failed rail read counts as real money: the stricter path (a live sanctions
// list required) is the safe one. Mock and simulator rails are demo, and stay
// demo only because a non-http rail never reaches a partner's stored URL.
//
// The rail is the SETTLEMENT partner's (railPartnerOf): a default-tenant
// transfer routed to an http partner is real money; an http owner routed to a
// simulator partner is not.

import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import type { DbOrTx } from '@/db/client';
import { env } from './env';
import { logWarn } from './log';
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
