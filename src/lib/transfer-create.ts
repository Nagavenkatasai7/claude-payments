import { quote } from './fx';
import { getFxRate } from './rate';
import { screenTransfer } from './compliance';
import { newTransferId } from './id';
import type { Store } from './store';
import type { FundingMethod, PayoutMethod, Transfer } from './types';

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
  };
  await store.saveTransfer(transfer);
  await store.incrementTransferCount(input.phone);
  await store.incrementTodayTransferCount(input.phone);
  return transfer;
}
