import { getStore } from './store';
import type { SenderTotalsReader } from './daily-volume-store';
import type { PartnerId } from './types';

// monthly-volume store — a LEDGER adapter since Program fix 16 (ruling 30).
// The Redis `monthly_volume:*` counter is gone; the rolling-month EDD total is
// transfer-repo.senderTotalsSince over the ET month (blocked and cancelled
// rows excluded). Unlocked read for display / check_send_limit; createTransfer
// reads the same total inside its sender lock for the edd_required flag.
// There is no addCents: a minted row IS the accrual.

export function createMonthlyVolumeStore(ledger: SenderTotalsReader) {
  return {
    async getMonthCents(partnerId: PartnerId, senderPhone: string): Promise<number> {
      return (await ledger.senderTotals(partnerId, senderPhone)).monthUsdCents;
    },
  };
}

export type MonthlyVolumeStore = ReturnType<typeof createMonthlyVolumeStore>;

let cached: MonthlyVolumeStore | null = null;

export function getMonthlyVolumeStore(): MonthlyVolumeStore {
  if (!cached) {
    cached = createMonthlyVolumeStore(getStore());
  }
  return cached;
}
