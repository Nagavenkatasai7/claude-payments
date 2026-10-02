import type { DbOrTx } from '@/db/client';
import { readSenderScreeningFlags, type SenderScreeningFlags } from '@/db/repos/customer-repo';
import { logWarn } from './log';
import type { PartnerId } from './types';

export type { SenderScreeningFlags };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * M3-10 follow-up (owner, 2026-09-29): the transfer SENDER's customer-level PEP / watchlist flags,
 * read inside the partner tenant for the partner hold release (isPartnerReleasableHold's third
 * argument). FAILS CLOSED: a blank key, a missing row or a failed lookup all return null, which the
 * predicate refuses. Never throws (the page renders without the button; the action refuses). Logs
 * the error NAME only: a failed query's message carries its bound params (the phone).
 */
export async function loadSenderScreening(db: DbOrTx, partnerId: PartnerId, phone: string): Promise<SenderScreeningFlags | null> {
  if (!partnerId || !phone) return null;
  try {
    return await readSenderScreeningFlags(db, partnerId, phone);
  } catch (err) {
    logWarn('partner.release.sender-screening', errName(err), { partnerId });
    return null;
  }
}
