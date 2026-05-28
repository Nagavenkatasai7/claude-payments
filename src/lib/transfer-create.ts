import { quote } from './fx';
import { getFxRates } from './rate';
import { screenTransfer } from './compliance';
import { newTransferId } from './id';
import { countryForCurrency } from './partner-currency';
import type { Store } from './store';
import type { CurrencyCode, FundingMethod, PartnerId, PayoutMethod, Transfer } from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';

export interface CreateTransferInput {
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountSource: number;          // CHANGED (P4): was amountUsd
  sourceCurrency: CurrencyCode;  // NEW (P4)
  partnerId: PartnerId;          // NEW (P4): from the owning customer
}

export async function createTransfer(
  store: Store,
  input: CreateTransferInput,
): Promise<Transfer> {
  const transferCount = await store.getTransferCount(input.phone);
  const rates = await getFxRates(input.sourceCurrency);
  const q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount);
  const transfersToday = await store.getTodayTransferCount(input.phone);
  const compliance = screenTransfer({
    amountUsd: q.amountUsd, // USD-equivalent
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
    sourceCountry: countryForCurrency(input.sourceCurrency),
    sourceCurrency: input.sourceCurrency,
    destinationCountry: DEFAULT_DESTINATION_COUNTRY,
    destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
    partnerId: input.partnerId,
    amountSource: q.amountSource,
    feeSource: q.feeSource,
    totalChargeSource: q.totalChargeSource,
  };
  await store.saveTransfer(transfer);
  await store.incrementTransferCount(input.phone);
  await store.incrementTodayTransferCount(input.phone);

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
