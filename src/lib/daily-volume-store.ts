import { getStore } from './store';
import type { PartnerId } from './types';

// daily-volume store — a LEDGER adapter since Program fix 16 (ruling 30). The
// Redis `daily_volume:*` counter (and its transitional legacy dual-read) is
// gone: two concurrent sends under-counted it by a whole transfer and a Redis
// flush reset it. Today's spend is now transfer-repo.senderTotalsSince over
// the ET day (blocked and cancelled rows excluded), read here WITHOUT the
// sender lock — this surface is for display and the pre-claim checks; the
// authoritative check runs inside createTransfer's locked mint. There is no
// addCents: a minted row IS the accrual.

/** What the adapter needs from the store (structural, so tests pass a Store). */
export interface SenderTotalsReader {
  senderTotals(partnerId: PartnerId, phone: string, now?: Date): Promise<{ todayUsdCents: number; monthUsdCents: number }>;
}

export function createDailyVolumeStore(ledger: SenderTotalsReader) {
  return {
    async getTodayCents(partnerId: PartnerId, senderPhone: string): Promise<number> {
      return (await ledger.senderTotals(partnerId, senderPhone)).todayUsdCents;
    },
  };
}

export type DailyVolumeStore = ReturnType<typeof createDailyVolumeStore>;

let cached: DailyVolumeStore | null = null;

export function getDailyVolumeStore(): DailyVolumeStore {
  if (!cached) {
    cached = createDailyVolumeStore(getStore());
  }
  return cached;
}
