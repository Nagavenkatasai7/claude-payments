import type { DbOrTx } from '@/db/client';
import { readSenderScreeningFlags, readSenderScreeningFlagsForPhones, type SenderScreeningFlags } from '@/db/repos/customer-repo';
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

/**
 * M3-10 Task 10.3: the batch form for the legacy compliance page, which shows the Release button to
 * PARTNER-scoped staff only where canReleaseHeld allows it. De-duplicates and drops blank phones.
 * FAILS CLOSED: a blank tenant or a failed lookup returns an empty map, so every row's sender reads
 * as missing and the button is hidden. Never throws; logs the error NAME only.
 */
export async function loadSenderScreeningMap(
  db: DbOrTx,
  partnerId: PartnerId,
  phones: readonly string[],
): Promise<Map<string, SenderScreeningFlags>> {
  const unique = [...new Set(phones.filter((p) => typeof p === 'string' && p !== ''))];
  if (!partnerId || unique.length === 0) return new Map();
  try {
    return await readSenderScreeningFlagsForPhones(db, partnerId, unique);
  } catch (err) {
    logWarn('compliance.release.sender-screening-batch', errName(err), { partnerId });
    return new Map();
  }
}
