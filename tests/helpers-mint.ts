import { prepareSendDraft, type ToolContext } from '@/lib/tools';
import { finalizeDraftPayment, type BankDetails, type FinalizeStores } from '@/lib/pay-finalize';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { seedPartner, seedSender } from './helpers-db';
import { certifyPartnerForTest, seedRealMoneyRail } from './helpers-live';

// P24: the prior-send seeder lives in helpers-db (repo tests must not pull in tools.ts).
export { seedPriorSends } from './helpers-db';

/**
 * Fix pack 6 (P24, T17): a real-money AML hold fixture. A non-default partner
 * on a signed http rail (seedRealMoneyRail), certified for live money
 * (certifyPartnerForTest), its US corridor entry written by a raw UPDATE
 * (`amlHolds`, default true; `amlHoldRules` only when `rules` is given, so the
 * resolver's all-rules default applies otherwise), and a seasoned T1 sender
 * (first seen 10 days ago, verified). Defaults: 'acme' and a fake 555 phone.
 */
export async function amlMintFixture(
  db: Db,
  o: { partnerId?: string; rules?: string[]; amlHolds?: boolean; phone?: string } = {},
): Promise<{ partnerId: string; phone: string }> {
  const partnerId = o.partnerId ?? 'acme';
  const phone = o.phone ?? '15550100171';
  await seedPartner(db, partnerId);
  await seedRealMoneyRail(db, partnerId);
  await certifyPartnerForTest(db, partnerId);
  const entry = { amlHolds: o.amlHolds ?? true, ...(o.rules ? { amlHoldRules: o.rules } : {}) };
  await db.execute(sql`
    UPDATE partners SET corridor_compliance = ${JSON.stringify({ US: entry })}::jsonb WHERE id = ${partnerId}`);
  await seedSender(db, { partnerId, phone, firstSeenDaysAgo: 10, kycStatus: 'verified' });
  return { partnerId, phone };
}

// helpers-mint — mint a transfer in a test through the CURRENT send path.
//
// R30 deleted the legacy chat create_transfer tool (and its test seam
// runLegacyCreateTransferForTests): no chat channel could call it, and its
// result leaked compliance_status and compliance_reasons. A customer's send now
// always runs prepareSendDraft (send_approve_picker's and the AI apps'
// prepare_transfer seam: verify gate, sender name, cap, screening, the draft)
// and then the secure pay page (finalizeDraftPayment: the locked mint). This
// helper runs exactly those two steps, so a test that needs a minted transfer
// gets one the way production makes it.
//
// Two call shapes, mirroring the two shapes the old seam had:
//   - explicit send args (amount_usd / amount_source, recipient_name,
//     recipient_phone, destination_country, funding_method, purpose, EDD
//     answers, the B2B fields): prepare a draft, then pay it;
//   - empty args with ctx.turn.buttonTap = { kind: 'approve', draftId }: pay
//     that existing draft (the Approve & Pay card opens the pay page).
//
// The result keeps the old seam's keys for a minted transfer (transfer_id,
// status, amount_inr, total_charge_usd, recipient_name) and, because this is a
// test helper reading the ledger row, compliance_status / compliance_reasons
// too. A refusal is { error: <prepare kind or finalize error> } plus the raw
// outcome. The pay page needs the recipient's bank details when the sender has
// none on file: TEST_BANK_DETAILS is used then (or opts.bankDetails).

export const TEST_BANK_DETAILS: BankDetails = { payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234' };

type MintCtx = ToolContext;

export interface MintOptions {
  /** Bank details typed on the pay page. Default: the stored account, else TEST_BANK_DETAILS. */
  bankDetails?: BankDetails;
}

export type MintResult = Record<string, unknown> & { transfer?: Transfer };

function finalizeStores(ctx: MintCtx, db: Db): FinalizeStores {
  return {
    store: ctx.store,
    customerStore: ctx.customerStore,
    draftStore: ctx.draftStore,
    partnerStore: ctx.partnerStore,
    monthlyVolumeStore: ctx.monthlyVolumeStore,
    dailyVolumeStore: ctx.dailyVolumeStore,
    db,
  };
}

async function payDraft(ctx: MintCtx, db: Db, draftId: string, opts: MintOptions): Promise<MintResult> {
  const draft = await ctx.draftStore.getDraft(draftId);
  const needsDetails = draft !== null && (draft.recipient.payoutDestination ?? '').trim() === '' && draft.transferType !== 'b2b';
  const bankDetails = opts.bankDetails ?? (needsDetails ? TEST_BANK_DETAILS : undefined);
  const fin = await finalizeDraftPayment(finalizeStores(ctx, db), draftId, bankDetails);
  const transferId = fin.transferId;
  const transfer = transferId ? await ctx.store.getTransfer(transferId) : null;
  if (!fin.ok && fin.error !== 'blocked') return { error: fin.error, finalize: fin };
  if (!transfer) return { error: 'not_minted', finalize: fin };
  return {
    transfer_id: transfer.id,
    status: transfer.status,
    compliance_status: transfer.complianceStatus,
    compliance_reasons: transfer.complianceReasons,
    amount_inr: transfer.amountInr,
    total_charge_usd: transfer.totalChargeUsd,
    recipient_name: transfer.recipientName,
    draft_id: draftId,
    transfer,
  };
}

/** Mint through prepareSendDraft + the pay page (see the file comment). */
export async function mintViaPayPage(
  args: Record<string, unknown>,
  ctx: MintCtx,
  db: Db,
  opts: MintOptions = {},
): Promise<MintResult> {
  const tap = ctx.turn?.buttonTap;
  if (Object.keys(args).length === 0 && tap?.kind === 'approve') return payDraft(ctx, db, tap.draftId, opts);

  const prepared = await prepareSendDraft(ctx, {
    recipientPhone: args.recipient_phone,
    recipientName: String(args.recipient_name),
    amountSource: Number(args.amount_source ?? args.amount_usd),
    sourceCurrency: args.source_currency,
    destinationCountry: args.destination_country,
    fundingMethod: args.funding_method,
    entityType: args.entity_type,
    senderBusinessName: args.sender_business_name,
    recipientBusinessName: args.recipient_business_name,
    invoiceId: args.invoice_id,
    recipientLegalName: args.recipient_legal_name,
    relationship: args.relationship,
    purpose: args.purpose,
    purposeDetail: args.purpose_detail,
    sourceOfFunds: args.source_of_funds,
    occupation: args.occupation,
  });
  if (prepared.kind !== 'draft') return { error: prepared.kind, prepare: prepared };
  return payDraft(ctx, db, prepared.draftId, opts);
}
