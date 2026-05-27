import { quote } from './fx';
import { getFxRate } from './rate';
import { screenTransfer } from './compliance';
import { newTransferId } from './id';
import type { Store } from './store';
import type { FundingMethod, PayoutMethod, Transfer } from './types';
import {
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
  DEFAULT_PARTNER_ID,
} from './defaults';

export interface CreateTransferInput {
  phone: string;
  amountUsd: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
}

export async function createTransfer(
  store: Store,
  input: CreateTransferInput,
): Promise<Transfer> {
  const transferCount = await store.getTransferCount(input.phone);
  const fxRate = await getFxRate();
  const q = quote(input.amountUsd, fxRate, input.fundingMethod, transferCount);
  const transfersToday = await store.getTodayTransferCount(input.phone);
  const compliance = screenTransfer({
    amountUsd: input.amountUsd,
    recipientName: input.recipientName,
    transfersToday,
  });
  const transfer: Transfer = {
    id: newTransferId(),
    phone: input.phone,
    amountUsd: q.amountUsd,
    feeUsd: q.feeUsd,
    totalChargeUsd: q.totalChargeUsd,
    fxRate: q.fxRate,
    amountInr: q.amountInr,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    payoutMethod: input.payoutMethod,
    payoutDestination: input.payoutDestination,
    fundingMethod: input.fundingMethod,
    complianceStatus: compliance.status,
    complianceReasons: compliance.reasons,
    status: compliance.status === 'blocked' ? 'blocked' : 'awaiting_payment',
    createdAt: new Date().toISOString(),
    // NEW (P1) — defaults until P4 unlocks bot-collected values
    sourceCountry: DEFAULT_SOURCE_COUNTRY,
    sourceCurrency: DEFAULT_SOURCE_CURRENCY,
    destinationCountry: DEFAULT_DESTINATION_COUNTRY,
    destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
    partnerId: DEFAULT_PARTNER_ID,
  };
  await store.saveTransfer(transfer);
  await store.incrementTransferCount(input.phone);
  await store.incrementTodayTransferCount(input.phone);

  // Best-effort: persist the recipient for future picker suggestions.
  // Failure here must not surface to the sender — the transfer is the source
  // of truth and is already saved at this point.
  try {
    await store.upsertRecipient(input.phone, {
      name: input.recipientName,
      recipientPhone: input.recipientPhone,
      payoutMethod: input.payoutMethod,
      payoutDestination: input.payoutDestination,
      lastUsedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('upsertRecipient failed (non-fatal):', err);
  }

  return transfer;
}
