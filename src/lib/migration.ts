import type { Store } from './store';
import type { CustomerStore } from './customer-store';

const SENTINEL_KEY = 'customer-backfill-v1';

export async function backfillCustomersOnce(
  store: Store,
  customerStore: CustomerStore,
): Promise<{ backfilled: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(SENTINEL_KEY);
  if (!claimed) {
    return { backfilled: 0, skippedSentinel: true };
  }

  const transfers = await store.listTransfers();
  const earliestByPhone = new Map<string, string>();
  for (const t of transfers) {
    const existing = earliestByPhone.get(t.phone);
    if (!existing || t.createdAt < existing) earliestByPhone.set(t.phone, t.createdAt);
  }

  let backfilled = 0;
  for (const [phone, firstSeenAt] of earliestByPhone) {
    if ((await customerStore.getCustomer(phone)) !== null) continue; // beaten by lazy backfill
    await customerStore.saveCustomer({
      senderPhone: phone,
      firstSeenAt,
      kycStatus: 'grandfathered',
      kycVerifiedAt: new Date().toISOString(),
      createdAt: firstSeenAt,
      updatedAt: new Date().toISOString(),
    });
    backfilled++;
  }
  return { backfilled, skippedSentinel: false };
}
