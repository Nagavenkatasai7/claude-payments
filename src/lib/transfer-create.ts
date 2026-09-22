import { quote } from './fx';
import { FX_MAX_AGE_MS, RateUnavailableError, getDestinationRates, getFxRates } from './rate';
import { screenTransfer } from './compliance';
import { resolveCorridorRules, type ResolvedCorridorRules } from './compliance-config';
import { newTransferId } from './id';
import { sendGateActive } from './kyc-gate';
import { logWarn } from './log';
import { isMaskedDestination } from './payout-format';
import { isPartnerPulled } from './funding-method';
import { countryForCurrency } from './partner-currency';
import { quoteCeilingUsd, resolveEffectiveSendLimits, SendCapError } from './send-limits';
import { evaluateCap, evaluateEddForTransfer, type CapSubject } from './tier-rules';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { SenderLedgerOps, Store } from './store';
import type { PartnerStore } from './partner-store';
import type {
  CountryCode, CurrencyCode, Draft, FundingMethod, PartnerId, PayoutMethod, Transfer,
  SenderRecipientRelationship, TransferPurpose, SourceOfFunds, Occupation,   // NEW (KYC)
  KycStatus,                                                                 // NEW (Phase 3 gate)
  EntityType,                                                                // NEW (B2B)
  SendLimits,                                                                // Program fix 16
} from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';

export interface CreateTransferInput {
  // Stage 2c: callers running CLAIM-FIRST idempotency (partner API, draft
  // finalize) pre-generate and reserve the id, so a crash-replay re-mints the
  // SAME row instead of a duplicate. Absent ⇒ a fresh id (chat-tool paths).
  id?: string;
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountSource: number;          // CHANGED (P4): was amountUsd
  sourceCurrency: CurrencyCode;  // NEW (P4)
  destinationCountry?: CountryCode;  // NEW (any-to-any) — absent ⇒ DEFAULT_DESTINATION_COUNTRY ('IN')
  destinationCurrency?: CurrencyCode; // NEW (any-to-any) — absent ⇒ DEFAULT_DESTINATION_CURRENCY ('INR')
  partnerId: PartnerId;          // NEW (P4): from the owning customer
  // ── KYC Travel-Rule (Tier 2) + EDD (Tier 4) — all optional (dormant) ──
  recipientLegalName?: string;
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  senderName?: string;          // sender legal name for sanctions screening (from customer.fullName)
  senderKycStatus: KycStatus;   // NEW (Phase 3) — the chokepoint backstop refuses unless 'verified'
  requiresKyc?: boolean;        // NEW (WL1) — absent ⇒ true (default/'ours'). 'delegated' partners pass false to skip OUR verify gate. Sanctions still run regardless.
  // U7 (audit): a COMPLETE quote override — the figures the customer actually
  // approved (the draft's stored quote, as shown on the approval card and the
  // pay page). When present, the re-quote (transferCount + live FX) is skipped
  // and these values are written to the ledger verbatim. Sanctions screening,
  // EDD, and the monthly accrual all read their USD-equivalent from it.
  // Absent ⇒ behavior unchanged (quote from current state).
  quote?: {
    amountUsd: number;
    feeUsd: number;
    totalChargeUsd: number;
    fxRate: number;
    amountInr: number;
    amountSource: number;
    feeSource: number;
    totalChargeSource: number;
    // Task 9: when the rate behind these figures was fetched (the draft's
    // quote.fxFetchedAt). Beyond FX_MAX_AGE_MS the mint refuses; absent ⇒ no check.
    fxFetchedAt?: number;
  };
  // Best-rate routing (internal — never customer/partner-API visible): the
  // partner whose RAIL settles this transfer because its rate won the corridor
  // at quote time. Honored ONLY together with `quote` (the figures that rate
  // produced) — see the guard in createTransfer. Absent ⇒ settle via partnerId.
  settlementPartnerId?: PartnerId;
  // ── B2B (business-to-business) — all optional; absent ⇒ the consumer shape.
  // SANCTIONS NOTE: the existing screen runs on senderName + recipientName, so
  // for B2B the caller sets those to the business legal names (no screen change
  // needed). These fields carry the entity discriminators + the encrypted
  // business names + the partner's ACH-pull token + the linked mock invoice. ──
  transferType?: 'b2c' | 'b2b';
  senderEntityType?: EntityType;
  recipientEntityType?: EntityType;
  senderBusinessName?: string;
  recipientBusinessName?: string;
  achTokenRef?: string;
  invoiceId?: string;
  // fix 5 (F43): whether a real consumer destination refreshes the sender's
  // personal address book (the WhatsApp recipient picker). Absent ⇒ true (every
  // chat / pay-page / cron mint). The partner API passes false: an external
  // caller must never plant a saved recipient into its customers' picker.
  saveRecipient?: boolean;
}

/**
 * Build the COMPLETE quote override (CreateTransferInput['quote']) from a
 * draft's stored quote — the exact figures the approval card and the pay page
 * showed (U7 audit). USD drafts: source-side fields equal the USD fields by
 * definition. Non-USD drafts need their stored source-side figures; legacy
 * in-flight drafts that predate feeSource/totalChargeSource return undefined,
 * so the mint falls back to a live re-quote rather than mixing the draft's
 * USD figures with a live source-side recomputation. Shared by BOTH draft
 * mint paths (pay-page finalize + approve-button tap) so they price the same.
 */
export function quoteOverrideFromDraft(
  draft: Pick<Draft, 'amountUsd' | 'amountSource' | 'sourceCurrency' | 'quote'>,
): CreateTransferInput['quote'] {
  const dq = draft.quote;
  const totalChargeUsd =
    dq.totalChargeUsd ?? Math.round((draft.amountUsd + dq.feeUsd) * 100) / 100;
  if (draft.sourceCurrency === 'USD') {
    return {
      amountUsd: draft.amountUsd,
      feeUsd: dq.feeUsd,
      totalChargeUsd,
      fxRate: dq.fxRate,
      amountInr: dq.amountInr,
      amountSource: draft.amountUsd,
      feeSource: dq.feeUsd,
      totalChargeSource: totalChargeUsd,
      fxFetchedAt: dq.fxFetchedAt,
    };
  }
  if (dq.feeSource !== undefined && dq.totalChargeSource !== undefined) {
    return {
      amountUsd: draft.amountUsd,
      feeUsd: dq.feeUsd,
      totalChargeUsd,
      fxRate: dq.fxRate,
      amountInr: dq.amountInr,
      amountSource: draft.amountSource,
      feeSource: dq.feeSource,
      totalChargeSource: dq.totalChargeSource,
      fxFetchedAt: dq.fxFetchedAt,
    };
  }
  return undefined;
}

/**
 * Task 9: an approved quote is honored VERBATIM (claim-first re-mints must
 * never re-price), so the only admissible check is the age of the rate behind
 * it. Beyond FX_MAX_AGE_MS the mint REFUSES — it never silently re-quotes.
 * An override without fxFetchedAt (a pre-Task-9 draft, the B2B locked quote)
 * passes unchanged.
 */
export function assertQuoteOverrideFresh(
  q: Pick<NonNullable<CreateTransferInput['quote']>, 'fxFetchedAt'>,
  now: number = Date.now(),
): void {
  if (q.fxFetchedAt !== undefined && now - q.fxFetchedAt > FX_MAX_AGE_MS) {
    throw new RateUnavailableError('stale_quote');
  }
}

/**
 * fix 6 (ctx-01): thrown by createTransfer when the payout destination is a
 * display placeholder (payout-format.isMaskedDestination). NOTHING has been
 * written. The message is a constant and never carries the destination.
 */
export class MaskedDestinationError extends Error {
  constructor() {
    super('masked_payout_destination');
    this.name = 'MaskedDestinationError';
  }
}

/**
 * fix 6: thrown when a partner-pulled funding method (ach_pull / bank_pull —
 * the LICENSED PARTNER debits the payer, so the pay route skips OUR capture)
 * is asked for on anything but a B2B transfer. NOTHING has been read or written.
 */
export class PartnerPulledConsumerError extends Error {
  constructor() {
    super('partner_pulled_funding_requires_b2b');
    this.name = 'PartnerPulledConsumerError';
  }
}

/**
 * Thrown (inside the lock, before any write) when a claim-first `input.id`
 * already names a row under ANOTHER tenant. Unreachable by provenance — every
 * `input.id` is a per-tenant idempotency binding on a server-generated id —
 * but insertTransfer is an upsert, so this refuses instead of overwriting.
 * The partner API maps it to 409; nothing is written.
 */
export class TransferIdConflictError extends Error {
  constructor() {
    super('transfer_id_conflict');
    this.name = 'TransferIdConflictError';
  }
}

export async function createTransfer(
  store: Store,
  partnerStore: PartnerStore,           // NEW (P5): to resolve corridor rules
  // Program fix 16: UNUSED. The rolling-month EDD total is read from the
  // ledger INSIDE the sender lock (SenderLedgerOps.totals). The parameter is
  // kept so the six mint call sites keep their signature.
  _monthlyVolumeStore: MonthlyVolumeStore,
  input: CreateTransferInput,
): Promise<Transfer> {
  // Phase 3 backstop: the chokepoint refuses to mint a transfer for an unverified
  // sender. Callers gate earlier with friendly UX (a kyc_url hand-off / a cron
  // skip); this is the last line of defense so no future caller can bypass it.
  //
  // WL1: a 'delegated' partner (the licensed entity runs KYC on their side) passes
  // requiresKyc:false to lift OUR verify gate. Absent ⇒ true ⇒ unchanged default
  // behavior. ⚠️ This does NOT touch sanctions — screenTransfer below runs in
  // BOTH modes and screens the recipient (and sender, when a name is present).
  const requiresKyc = input.requiresKyc ?? true;
  if (requiresKyc && input.senderKycStatus !== 'verified') {
    throw new Error('kyc_required');
  }
  // fix 6: only a B2B bill payment may carry a partner-pulled funding method —
  // on a consumer transfer it would move money with no charge. Refuse before
  // any read or write (cron counts it as a failed run).
  if (isPartnerPulled(input.fundingMethod) && (input.transferType ?? 'b2c') !== 'b2b') {
    throw new PartnerPulledConsumerError();
  }
  // Resolve destination — default to IN/INR for full back-compat (all existing tests unchanged).
  const destinationCountry = input.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY;
  const destinationCurrency = input.destinationCurrency ?? DEFAULT_DESTINATION_CURRENCY;

  // ── Root-handle reads, ALL ABOVE the sender lock (Program fix 16) ────────
  // Nothing below the lock may touch the store / partner store: the locked
  // body receives tx-bound SenderLedgerOps only (see mintLocked). Fix 16b
  // hoists the partner + subject reads above the quote too: the quote ceiling
  // is now the sender's EFFECTIVE per-transfer cap (customer override, else
  // partner default, else platform), never above the $10,000 hard ceiling.
  const sourceCountry = countryForCurrency(input.sourceCurrency);   // P4 symbol
  const partner = await partnerStore.getPartner(input.partnerId);   // NEW (P5)
  const rules = resolveCorridorRules(partner, sourceCountry);        // NEW (P5)
  // The tier subject (firstSeenAt from the customers row / first transfer /
  // now; kycStatus = the attestation the backstop above already trusts; the
  // customer's raise, if any) and the RESOLVED limits (fix 16b: customer →
  // partner → platform, clamped to the hard ceiling; T0 tighten-only).
  const subject = await store.capSubject(input.partnerId, input.phone, input.senderKycStatus);
  const limits = resolveEffectiveSendLimits(partner, subject);
  const kycGateActive = sendGateActive(partner);

  // U7 (audit): when the caller supplies the quote the customer approved (the
  // draft's stored quote), honor it verbatim — NO re-quote. Otherwise quote from
  // current state exactly as before. Everything downstream reads from `q`:
  // sanctions + EDD use q.amountUsd, the Transfer row takes all eight figures,
  // and the cap check uses q.amountUsd.
  let q: NonNullable<CreateTransferInput['quote']>;
  if (input.quote) {
    assertQuoteOverrideFresh(input.quote);
    q = input.quote;
  } else {
    const transferCount = await store.getTransferCount(input.partnerId, input.phone);
    const rates = await getFxRates(input.sourceCurrency);
    // The destination leg for the USD-pivot cross-rate (undefined for INR —
    // quote() prices INR off rates.toInr). Both legs THROW RateUnavailableError
    // when no rate inside the ceiling exists: it propagates as a clean refusal
    // that every mint caller maps (503 / friendly tool error / fx_unavailable).
    const destRates = await getDestinationRates(destinationCurrency);
    q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount, destinationCurrency, destRates?.toUsd, quoteCeilingUsd(limits));
  }
  // Best-rate routing: a route is only ever honored together with the quote it
  // priced. If the quote override is absent we re-quoted at the CURRENT mid
  // above — settling that through the winning partner's rail would pay out at
  // a rate that partner never offered, so the route is dropped with the stale
  // rate (platform settle via the customer's own partnerId).
  const settlementPartnerId = input.quote ? input.settlementPartnerId : undefined;

  // ── ONE locked mint per (partner, phone) ──────────────────────────────────
  // Sanctions → EDD → blocked row / placeholder refusal → cap → insert, all
  // on ledger totals read under the lock, so two concurrent mints can never
  // both spend the same headroom. A SendCapError / MaskedDestinationError
  // throws out of the transaction (nothing written); a lock wait past 5 s is
  // the retryable SendBusyError (store.mintUnderSenderLock).
  const minted = await store.mintUnderSenderLock(input.partnerId, input.phone, (ops) =>
    mintLocked(ops, {
      input, q, sourceCountry, destinationCountry, destinationCurrency, rules,
      subject, limits, kycGateActive, settlementPartnerId,
    }),
  );
  const transfer = minted.transfer;
  // A same-id replay is a MASKED read of the existing row and a blocked row is
  // evidence only: neither reaches the address-book write below (a replay
  // must never write ****last4 into the sender's saved recipients — ctx-01).
  if (minted.replayed || transfer.status === 'blocked') return transfer;
  // (transfer count, today's spend and the month total are DERIVED from the
  // ledger — no counter to bump: the minted row IS the accrual.)

  // Refresh the sender's PERSONAL address book only with a real consumer
  // destination (fix 6): a '' mint must never erase a saved account, and a B2B
  // payee's account (seller profile / partner-held) is never a personal payout.
  // A partner-API mint opts out entirely (fix 5, saveRecipient: false).
  if (
    transfer.transferType !== 'b2b' &&
    transfer.payoutDestination.trim() !== '' &&
    input.saveRecipient !== false
  ) {
    try {
      await store.upsertRecipient(input.partnerId, input.phone, {
        name: input.recipientName,
        recipientPhone: input.recipientPhone,
        payoutMethod: input.payoutMethod,
        payoutDestination: transfer.payoutDestination,
        lastUsedAt: new Date().toISOString(),
      });
    } catch (err) {
      logWarn('transfer.upsert_recipient', err, { transferId: transfer.id });
    }
  }

  return transfer;
}

/** Everything the locked body needs, read on the root handle BEFORE the lock. */
interface PreparedMint {
  input: CreateTransferInput;
  q: NonNullable<CreateTransferInput['quote']>;
  sourceCountry: CountryCode;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  rules: ResolvedCorridorRules;
  subject: CapSubject;
  limits: SendLimits;
  kycGateActive: boolean;
  settlementPartnerId?: PartnerId;
}

/**
 * The locked mint body (Program fix 16). MODULE-LEVEL and given ONLY the
 * tx-bound SenderLedgerOps on purpose: a store / partner store / volume store
 * call in here cannot compile, so no root-handle statement can run inside the
 * lock (it would deadlock PGlite's single connection and hold a second Neon
 * pool connection per mint). Order:
 *   1. same-id replay (claim-first callers) → return the existing row, no
 *      second insert and no cap check;
 *   2. ledger totals → sanctions (velocity) + EDD (month used);
 *   3. a watchlist hit inserts the `blocked` row and returns (never consumes cap);
 *   4. a display placeholder throws (rolls back);
 *   5. evaluateCap on today's ledger spend → SendCapError (rolls back);
 *   6. insert.
 */
async function mintLocked(
  ops: SenderLedgerOps,
  p: PreparedMint,
): Promise<{ transfer: Transfer; replayed: boolean }> {
  const { input, q } = p;
  if (input.id) {
    // A same-key re-mint (claim-first callers only). The row must belong to
    // THIS tenant: an id that exists under another partner is neither replayed
    // nor re-inserted (insertTransfer is an upsert) — refuse before any write.
    const existing = await ops.getTransfer(input.id);
    if (existing) {
      if (existing.partnerId !== input.partnerId) throw new TransferIdConflictError();
      return { transfer: existing, replayed: true };
    }
  }
  const now = new Date();
  const totals = await ops.totals(now);
  const compliance = await screenTransfer({                         // P5: corridor-aware
    amountUsd: q.amountUsd,            // USD-equivalent — UNCHANGED
    recipientName: input.recipientName,
    transfersToday: totals.todayCount, // ledger velocity (blocked excluded)
    sourceCountry: p.sourceCountry,    // NEW (P5)
    rules: p.rules,                    // NEW (P5)
    senderName: input.senderName,      // NEW (KYC) — screened via the same seam (undefined ⇒ no-op)
  });

  // EDD merge: a watchlist BLOCK always wins; EDD only ever ADDS a flag.
  const eddFieldsPresent = Boolean(input.sourceOfFunds && input.occupation);
  const requestedCents = Math.round(q.amountUsd * 100);
  const eddCheck = evaluateEddForTransfer({
    monthUsedCents: totals.monthUsdCents, // ledger month (blocked + cancelled excluded)
    requestedCents,
    eddFieldsPresent,
  });
  let complianceStatus = compliance.status;
  let complianceReasons = compliance.reasons;
  if (complianceStatus !== 'blocked' && eddCheck.flagReason) {
    complianceStatus = 'flagged';
    complianceReasons = [...complianceReasons, eddCheck.flagReason];
  }
  const transfer: Transfer = {
    id: input.id ?? newTransferId(),
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
    complianceStatus,
    complianceReasons,
    status: complianceStatus === 'blocked' ? 'blocked' : 'awaiting_payment',
    createdAt: now.toISOString(),
    sourceCountry: p.sourceCountry,
    sourceCurrency: input.sourceCurrency,
    destinationCountry: p.destinationCountry,
    destinationCurrency: p.destinationCurrency,
    partnerId: input.partnerId,
    settlementPartnerId: p.settlementPartnerId,      // best-rate routing (internal)
    amountSource: q.amountSource,
    feeSource: q.feeSource,
    totalChargeSource: q.totalChargeSource,
    recipientLegalName: input.recipientLegalName,   // NEW (KYC)
    relationship: input.relationship,               // NEW (KYC)
    purpose: input.purpose,                          // NEW (KYC)
    eddRequired: eddCheck.eddRequired,               // NEW (KYC)
    transferType: input.transferType ?? 'b2c',       // NEW (B2B)
    senderEntityType: input.senderEntityType ?? 'individual',
    recipientEntityType: input.recipientEntityType ?? 'individual',
    senderBusinessName: input.senderBusinessName,
    recipientBusinessName: input.recipientBusinessName,
    achTokenRef: input.achTokenRef,
    invoiceId: input.invoiceId,
  };
  // ── Blocked-row early return (fix 6 / ctx-01) ─────────────────────────────
  // complianceStatus is FINAL here (screenTransfer + the EDD merge above). A
  // watchlist hit is an auditable, never-charged, never-instructed row and
  // NOTHING else: no cap consumed (the sums exclude blocked) and no address-book
  // write — the contract recordBlockedAttempt (below) has always documented. Its
  // destination is evidence only, so a display placeholder is scrubbed to '' (a
  // blocked row is saved with an empty or a real destination, never a mask). It
  // sits ABOVE the placeholder refusal AND the cap check on purpose: sanctions
  // always run first and leave their row.
  if (complianceStatus === 'blocked') {
    const blockedRow: Transfer = isMaskedDestination(transfer.payoutDestination)
      ? { ...transfer, payoutDestination: '' }
      : transfer;
    await ops.insertTransfer(blockedRow);
    return { transfer: blockedRow, replayed: false };
  }

  // ── Placeholder refusal (fix 6 / ctx-01) ──────────────────────────────────
  // "****9012" / "account on file" is what a MASKED read renders, never an
  // account. Refuse BEFORE the insert and any recipient write. '' is NOT
  // refused: a cron, approve-tap, legacy or B2B ach_pull mint legitimately
  // starts with none; the pay route collects it and pay-finalize refuses a
  // bodyless '' on any draft but a B2B ach_pull one.
  if (isMaskedDestination(transfer.payoutDestination)) {
    throw new MaskedDestinationError();
  }

  // ── Send cap (Program fix 16 / Task 10) ───────────────────────────────────
  // The LAST gate before the insert, on today's LEDGER spend read under this
  // lock: T0 $500/day for 3 days, T1 $2,999/day, $2,999 per transfer, or the
  // partner's tighter figures. Every mint path (chat tools, pay page, partner
  // API, cron, B2B) runs through here. A refusal rolls the transaction back.
  const ev = evaluateCap(p.subject, now, totals.todayUsdCents, requestedCents, p.kycGateActive, p.limits);
  if (!ev.withinCap) throw new SendCapError(ev);

  await ops.insertTransfer(transfer);
  return { transfer, replayed: false };
}

export interface BlockedAttemptInput {
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountUsd: number;
  amountSource: number;
  sourceCurrency: CurrencyCode;
  feeUsd: number;
  feeSource: number;
  fxRate: number;
  amountInr: number;                  // destination-currency amount
  totalChargeUsd: number;
  totalChargeSource: number;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  partnerId: PartnerId;
  reasons: string[];
}

/**
 * Persist a watchlist-blocked attempt as an auditable, never-charged transfer
 * row (status='blocked'), so blocked attempts are visible in the ledger and
 * compliance views instead of vanishing silently.
 *
 * Like createTransfer's blocked branch (early return since fix 6), this writes ONLY the row: the
 * ledger totals (fix 16) exclude blocked rows, so it never advances the
 * customer's caps or EDD volume, and it does NOT upsert the (watchlisted)
 * recipient. A blocked attempt must never advance the saved-recipient list.
 */
export async function recordBlockedAttempt(
  store: Store,
  input: BlockedAttemptInput,
): Promise<Transfer> {
  const transfer: Transfer = {
    id: newTransferId(),
    phone: input.phone,
    amountUsd: input.amountUsd,
    feeUsd: input.feeUsd,
    totalChargeUsd: input.totalChargeUsd,
    fxRate: input.fxRate,
    amountInr: input.amountInr,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    payoutMethod: input.payoutMethod,
    payoutDestination: input.payoutDestination,
    fundingMethod: input.fundingMethod,
    complianceStatus: 'blocked',
    complianceReasons: input.reasons,
    status: 'blocked',
    createdAt: new Date().toISOString(),
    sourceCountry: countryForCurrency(input.sourceCurrency),
    sourceCurrency: input.sourceCurrency,
    destinationCountry: input.destinationCountry,
    destinationCurrency: input.destinationCurrency,
    partnerId: input.partnerId,
    amountSource: input.amountSource,
    feeSource: input.feeSource,
    totalChargeSource: input.totalChargeSource,
  };
  await store.saveTransfer(transfer);
  return transfer;
}
