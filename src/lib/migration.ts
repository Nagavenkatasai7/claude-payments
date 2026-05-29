import type { Store } from './store';
import type { CustomerStore } from './customer-store';
import type { PartnerStore } from './partner-store';
import type { ScheduleStore } from './schedule-store';
import { DEFAULT_SENDER_COUNTRY, DEFAULT_PARTNER_ID } from './defaults';

const SENTINEL_KEY = 'customer-backfill-v1';
const COUNTRY_CURRENCY_SENTINEL_KEY = 'country-currency-backfill-v1';
const PARTNER_SENTINEL_KEY = 'partner-backfill-v1';
const SCHEDULE_PARTNER_SENTINEL_KEY = 'schedule-partner-backfill-v1';
const SOURCE_AMOUNT_SENTINEL_KEY = 'transfer-source-amount-backfill-v1';

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
      senderCountry: DEFAULT_SENDER_COUNTRY,
      partnerId: DEFAULT_PARTNER_ID,                 // NEW (P2)
      createdAt: firstSeenAt,
      updatedAt: new Date().toISOString(),
    });
    backfilled++;
  }
  return { backfilled, skippedSentinel: false };
}

export async function backfillCountryCurrencyOnce(
  store: Store,
  customerStore: CustomerStore,
): Promise<{
  customersBackfilled: number;
  transfersBackfilled: number;
  skippedSentinel: boolean;
}> {
  const claimed = await store.claimMigrationFlag(COUNTRY_CURRENCY_SENTINEL_KEY);
  if (!claimed) {
    return { customersBackfilled: 0, transfersBackfilled: 0, skippedSentinel: true };
  }

  // Pass 1: customers.
  // customerStore.listCustomers() returns fully lazy-filled records (Task 2),
  // so every customer's senderCountry is already populated in memory. We
  // re-save each one to persist the default to Redis. This is idempotent
  // because the spread preserves existing values (e.g. a customer with
  // senderCountry: 'CA' keeps 'CA'). The sentinel ensures we only run once.
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    await customerStore.saveCustomer({
      ...c,
      updatedAt: new Date().toISOString(),
    });
    customersBackfilled++;
  }

  // Pass 2: transfers. Same pattern — store.listTransfers (which calls
  // store.getTransfer for each id) returns lazy-filled values. Re-save persists.
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({ ...t });
    transfersBackfilled++;
  }

  return { customersBackfilled, transfersBackfilled, skippedSentinel: false };
}

export async function backfillPartnersOnce(
  store: Store,
  customerStore: CustomerStore,
  partnerStore: PartnerStore,
): Promise<{
  defaultPartnerCreated: boolean;
  customersBackfilled: number;
  transfersBackfilled: number;
  skippedSentinel: boolean;
}> {
  const claimed = await store.claimMigrationFlag(PARTNER_SENTINEL_KEY);
  if (!claimed) {
    return {
      defaultPartnerCreated: false,
      customersBackfilled: 0,
      transfersBackfilled: 0,
      skippedSentinel: true,
    };
  }

  // Step 1: seed Default Partner if missing
  const existing = await partnerStore.getPartner('default');
  const defaultPartnerCreated = existing === null;
  if (defaultPartnerCreated) {
    const now = new Date().toISOString();
    await partnerStore.savePartner({
      id: 'default',
      name: 'SendHome Default',
      countries: ['US'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Step 2: backfill customers — lazy fill populated partnerId; re-save persists
  let customersBackfilled = 0;
  for (const c of await customerStore.listCustomers()) {
    await customerStore.saveCustomer({ ...c, updatedAt: new Date().toISOString() });
    customersBackfilled++;
  }

  // Step 3: backfill transfers
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({ ...t });
    transfersBackfilled++;
  }

  // Staff records NOT backfilled — partnerId stays optional (= global access).
  return { defaultPartnerCreated, customersBackfilled, transfersBackfilled, skippedSentinel: false };
}

export async function backfillSchedulesOnce(
  store: Store,
  scheduleStore: ScheduleStore,
): Promise<{ schedulesBackfilled: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(SCHEDULE_PARTNER_SENTINEL_KEY);
  if (!claimed) return { schedulesBackfilled: 0, skippedSentinel: true };

  // listSchedules lazy-fills partnerId; re-saving persists.
  // A schedule with an already-explicit partnerId stays unchanged because the
  // spread preserves it (lazy-fill only runs when partnerId is falsy).
  let schedulesBackfilled = 0;
  for (const s of await scheduleStore.listSchedules()) {
    await scheduleStore.saveSchedule({ ...s });
    schedulesBackfilled++;
  }
  return { schedulesBackfilled, skippedSentinel: false };
}

export async function backfillSourceAmountsOnce(
  store: Store,
  scheduleStore: ScheduleStore,
): Promise<{ transfersBackfilled: number; schedulesBackfilled: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(SOURCE_AMOUNT_SENTINEL_KEY);
  if (!claimed) return { transfersBackfilled: 0, schedulesBackfilled: 0, skippedSentinel: true };

  // listTransfers / listSchedules return lazy-filled records; re-saving persists.
  let transfersBackfilled = 0;
  for (const t of await store.listTransfers()) {
    await store.saveTransfer({ ...t });
    transfersBackfilled++;
  }
  let schedulesBackfilled = 0;
  for (const s of await scheduleStore.listSchedules()) {
    await scheduleStore.saveSchedule({ ...s });
    schedulesBackfilled++;
  }
  return { transfersBackfilled, schedulesBackfilled, skippedSentinel: false };
}
