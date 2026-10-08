import { assertLegsUsable, legsProvenance, quote, wouldBeFeeUsd } from './fx';
import { FX_MAX_AGE_MS, FX_PROVIDER_ID, RateUnavailableError, getDestinationRates, getFxRates, isKnownFxProvider } from './rate';
import { screenTransfer, SENDER_IDENTITY_MISSING_REASON } from './compliance';
import { sanctionsAuditEvent, type ScreeningEvidence } from './sanctions/evidence';
import { warmSanctionsList } from './providers/sanctions-provider';
import { resolveCorridorRules, type ResolvedCorridorRules } from './compliance-config';
import { newTransferId } from './id';
import { sendGateActive } from './kyc-gate';
import { logError, logWarn } from './log';
import { SendsPausedError } from './flags';
import { amlHoldGate, amlHoldHit, amlHoldRailEligible, applyAmlHold, applyPurposeHold } from './aml-hold';
import { checkPurposeDetail } from './purpose-detail';
import { isMaskedDestination } from './payout-format';
import { isPartnerPulled } from './funding-method';
import { countryForCurrency } from './partner-currency';
import { feeTierCount, isFirstTransferFree } from './fee-tier';
import { easternMonth, easternMonthStart } from './dates';
import { budgetAllows, discountFor, giveBackFor, qualifies } from './rewards/engine';
import { rewardsActive } from './rewards/resolver';
import { isFundedRewardKind, type QuotedReward } from './rewards/types';
import { quoteCeilingUsd, resolveEffectiveSendLimits, SendCapError } from './send-limits';
import { evaluateCap, evaluateEddForTransfer, type CapSubject } from './tier-rules';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { RewardMintFacts, SenderLedgerOps, Store } from './store';
import type { PartnerStore } from './partner-store';
import type {
  CountryCode, CurrencyCode, Draft, FundingMethod, PartnerId, PayoutMethod, Transfer,
  SenderRecipientRelationship, TransferPurpose, SourceOfFunds, Occupation,   // NEW (KYC)
  KycStatus,                                                                 // NEW (Phase 3 gate)
  EntityType,                                                                // NEW (B2B)
  SendLimits,                                                                // Program fix 16
  TransferEnvironment,                                                       // Program-Fix 44 P2
  FxRateOrigin,                                                              // Step 0 FX-7
} from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';
import { env } from './env';

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
  // Batch B follow-up A2/A4: the customer's reason for purpose `other` (the caller
  // applied decidePurpose). Re-checked here: only a valid reason is stored, and a
  // scam-pattern reason holds the transfer (applyPurposeHold).
  purposeDetail?: string;
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
    // Step 0 FX-5: the winning partner push's expiry (epoch ms). Under
    // FX_PAY_RATE_CHECK_ENABLED the mint refuses at or after it.
    routeExpiresAt?: number;
    // Step 0 FX-7: the provenance stamped on the row (the draft's).
    fxAsOf?: string;
    fxOrigin?: FxRateOrigin;
    // Which rate source served a platform rate (rate.ts ECB_PROVIDER_ID / FX_PROVIDER_ID).
    fxProvider?: string;
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
  // Program-Fix 14 follow-up: the caller could not supply the sender's name, so
  // the sender side cannot be name-screened. Absent/false ⇒ unchanged. true ⇒
  // a non-blocked mint is HELD (flagged + SENDER_IDENTITY_MISSING_REASON), in
  // the same transaction as the insert. Only the partner API sets it today.
  senderIdentityMissing?: boolean;
  // Program-Fix 44 P2: 'test' ⇔ a sandbox (sr_test_) Partner API key minted
  // it. Absent ⇒ 'live' (every other mint path). A test mint is never
  // best-rate routed, and a claim-first same-id replay across environments is
  // refused (TransferIdConflictError), never returned.
  environment?: TransferEnvironment;
  // UI redesign M2-10 (#398 review L2): set ONLY by the scheduled run (cron-run.ts). Inside the
  // locked mint, before sanctions or any write, the schedule is re-read FOR SHARE and must still be
  // 'active' (and not carry an account for a recipient the sender deleted), else
  // ScheduleMintRefusedError with nothing written. Its address-book refresh never clears a
  // tombstone. Absent ⇒ unchanged for every other caller.
  scheduleId?: string;
  // Batch B1: the partner's own order number (Partner API client_reference, checked at
  // the edge). Stored write-once on the row. Absent ⇒ unchanged for every other caller.
  clientReference?: string;
  // B3 rewards v1: the reward the approved quote carries (the draft's). Honoured
  // ONLY together with `quote` (whose fee it already lowered): re-checked under
  // the sender lock (and the partner budget under its own lock), then saved as
  // the redemption row in the mint transaction. A reward that ended since the
  // quote throws RewardEndedError with nothing written. Absent ⇒ unchanged.
  reward?: QuotedReward;
}

/** Batch B follow-up A4: the actor of the `purpose.flag` audit row. */
export const PURPOSE_AUDIT_ACTOR = 'system:purpose-check';

/** B3: what a customer sees when the reward on an approved quote ended before the mint. */
export { REWARD_ENDED_MESSAGE } from './rewards/copy';

/**
 * B3: thrown by createTransfer when the reward on the approved quote no longer
 * applies (the switch or the program is off, the customer cap or the partner
 * budget is used up). NOTHING was written; the caller keeps the draft and maps
 * it to REWARD_ENDED_MESSAGE. The approved price is never changed silently.
 */
export class RewardEndedError extends Error {
  constructor() {
    super('reward_ended');
    this.name = 'RewardEndedError';
  }
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
      routeExpiresAt: dq.routeExpiresAt,
      fxAsOf: dq.fxAsOf,
      fxOrigin: dq.fxOrigin,
      fxProvider: dq.fxProvider,
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
      routeExpiresAt: dq.routeExpiresAt,
      fxAsOf: dq.fxAsOf,
      fxOrigin: dq.fxOrigin,
      fxProvider: dq.fxProvider,
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
 *
 * Step 0 FX-5: a quote priced on a partner PUSH also ends when that push
 * expires (a push competes only while expiresAt > now, partner-rates.ts).
 * Checked only under FX_PAY_RATE_CHECK_ENABLED; no routeExpiresAt (platform
 * rate, standing margin, older drafts) ⇒ no extra check.
 */
export function assertQuoteOverrideFresh(
  q: Pick<NonNullable<CreateTransferInput['quote']>, 'fxFetchedAt' | 'routeExpiresAt'>,
  now: number = Date.now(),
): void {
  if (q.fxFetchedAt !== undefined && now - q.fxFetchedAt > FX_MAX_AGE_MS) {
    throw new RateUnavailableError('stale_quote');
  }
  if (env.fxPayRateCheckEnabled && q.routeExpiresAt !== undefined && now >= q.routeExpiresAt) {
    throw new RateUnavailableError('stale_quote');
  }
}

/** Step 0 FX-7: the write-once provenance fields of a transfer row (+ the push expiry, review finding 1). */
export type FxProvenance = Pick<Transfer, 'fxAsOf' | 'fxFetchedAt' | 'fxSource' | 'fxProvider' | 'fxExpiresAt'>;

/**
 * Step 0 FX-7: what a row can vouch for about the rate that priced it. Pure;
 * only defined fields are set.
 *   - platform: the ECB reference feed (FX_PROVIDER_ID), its date and fetch time;
 *   - partner_margin: a partner margin over that same mid (date kept);
 *   - partner_push: the partner's own number, so no reference date; the fetch
 *     time of the mid it beat is kept (the quote's age is measured from it);
 *   - b2b_lock: a locked B2B quote, origin only (dates NULL);
 *   - no origin (a draft from before this change): only its fetch time.
 * Review finding 1: `expiresAtMs` is the winning partner push's expiry (the
 * draft's routeExpiresAt); stamped as fxExpiresAt so the pay-time rate check
 * (minted-rate.ts) ends the lock there. Absent ⇒ not a push, no expiry.
 * Oct 7 ECB source: `provider` is the source that served a platform rate
 * (legsProvenance); absent (a draft from before) ⇒ FX_PROVIDER_ID as before.
 */
export function fxProvenanceFor(
  origin: FxRateOrigin | undefined,
  asOf: string | undefined,
  fetchedAtMs: number | undefined,
  expiresAtMs?: number,
  provider?: string,
): FxProvenance {
  if (origin === 'b2b_lock') return { fxSource: origin };
  const out: FxProvenance = {};
  if (origin) {
    out.fxSource = origin;
    // A draft lives in Redis: only a known id reaches the row, else the default.
    out.fxProvider = origin === 'platform' ? (isKnownFxProvider(provider) ? provider : FX_PROVIDER_ID) : 'partner';
  }
  if (asOf && (origin === 'platform' || origin === 'partner_margin')) out.fxAsOf = asOf;
  if (fetchedAtMs !== undefined && Number.isFinite(fetchedAtMs)) out.fxFetchedAt = new Date(fetchedAtMs).toISOString();
  if (expiresAtMs !== undefined && Number.isFinite(expiresAtMs)) out.fxExpiresAt = new Date(expiresAtMs).toISOString();
  return out;
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
/**
 * UI redesign M2-10 (#398 review L2): a scheduled mint refused by the in-transaction schedule
 * re-check. Nothing was written. 'inactive' = paused, cancelled or gone since the run's read;
 * 'recipient_deleted' = the schedule still carries an account for a recipient the sender deleted.
 */
export class ScheduleMintRefusedError extends Error {
  constructor(readonly reason: 'inactive' | 'recipient_deleted') {
    super(`schedule_mint_refused:${reason}`);
    this.name = 'ScheduleMintRefusedError';
  }
}

export class TransferIdConflictError extends Error {
  constructor() {
    super('transfer_id_conflict');
    this.name = 'TransferIdConflictError';
  }
}

export async function createTransfer(
  store: Store,
  partnerStore: PartnerStore,
  _monthlyVolumeStore: MonthlyVolumeStore,
  input: CreateTransferInput,
): Promise<Transfer> {
  return (await createTransferWithOutcome(store, partnerStore, _monthlyVolumeStore, input)).transfer;
}

/**
 * createTransfer plus whether the locked mint REPLAYED an existing row (a
 * claim-first same-id re-mint) instead of inserting. Same arguments, same
 * behaviour; the partner API uses it so a concurrent loser that replays the
 * winner never repeats a mint-only side effect (the deprecation warning).
 */
export async function createTransferWithOutcome(
  store: Store,
  partnerStore: PartnerStore,           // NEW (P5): to resolve corridor rules
  // Program fix 16: UNUSED. The rolling-month EDD total is read from the
  // ledger INSIDE the sender lock (SenderLedgerOps.totals). The parameter is
  // kept so the six mint call sites keep their signature.
  _monthlyVolumeStore: MonthlyVolumeStore,
  input: CreateTransferInput,
): Promise<{ transfer: Transfer; replayed: boolean }> {
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

  // Release safety part A: the `sends.paused` kill switch (global, this
  // partner, the routed rail partner, or this corridor). Checked BEFORE any
  // other read or write, so a paused mint leaves nothing behind: a claim-first
  // caller's key stays bound-but-unminted and the same request mints once the
  // switch is off. A sandbox (test-key) mint moves no money and is never
  // paused, so the pre-release synthetic transfer still runs during a pause.
  if (
    input.environment !== 'test' &&
    (await store.isFlagOn('sends.paused', {
      partnerId: [input.partnerId, input.settlementPartnerId],
      corridor: destinationCountry,
    }))
  ) {
    throw new SendsPausedError();
  }

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
  let provenance: FxProvenance;
  // A5: a re-quote's fee tier is re-checked under the lock (mintLocked); this
  // re-prices the same rates at the locked count (pure, no I/O).
  let requote: RequoteAt | undefined;
  let quotedCount: number | undefined;
  if (input.quote) {
    assertQuoteOverrideFresh(input.quote);
    q = input.quote;
    // Step 0 FX-7: the approved quote's own provenance (the draft's), with the
    // push expiry the mint just checked (review finding 1: the pay-time check
    // ends the rate lock there).
    provenance = fxProvenanceFor(q.fxOrigin, q.fxAsOf, q.fxFetchedAt, q.routeExpiresAt, q.fxProvider);
  } else {
    const transferCount = await feeTierCount(store, input.partnerId, input.phone);
    const rates = await getFxRates(input.sourceCurrency);
    // The destination leg for the USD-pivot cross-rate (undefined for INR —
    // quote() prices INR off rates.toInr). Both legs THROW RateUnavailableError
    // when no rate inside the ceiling exists: it propagates as a clean refusal
    // that every mint caller maps (503 / friendly tool error / fx_unavailable).
    const destRates = await getDestinationRates(destinationCurrency);
    assertLegsUsable(rates, destRates); // Step 0 FX-1: both legs (B3)
    const legs = legsProvenance(rates, destRates); // Step 0 FX-7: the OLDEST leg
    provenance = fxProvenanceFor('platform', legs.asOf, legs.fetchedAt, undefined, legs.provider);
    const priceAt: RequoteAt = (count) =>
      quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, count, destinationCurrency, destRates?.toUsd, quoteCeilingUsd(limits));
    q = priceAt(transferCount);
    requote = priceAt;
    quotedCount = transferCount;
  }
  // Best-rate routing: a route is only ever honored together with the quote it
  // priced. If the quote override is absent we re-quoted at the CURRENT mid
  // above — settling that through the winning partner's rail would pay out at
  // a rate that partner never offered, so the route is dropped with the stale
  // rate (platform settle via the customer's own partnerId).
  // Program-Fix 44 P2: a sandbox mint is never routed to another partner's rail.
  const settlementPartnerId =
    input.quote && input.environment !== 'test' ? input.settlementPartnerId : undefined;

  // ── ONE locked mint per (partner, phone) ──────────────────────────────────
  // Sanctions → EDD → blocked row / placeholder refusal → cap → insert, all
  // on ledger totals read under the lock, so two concurrent mints can never
  // both spend the same headroom. A SendCapError / MaskedDestinationError
  // throws out of the transaction (nothing written); a lock wait past 5 s is
  // the retryable SendBusyError (store.mintUnderSenderLock).
  // Program-Fix 14 PR C: refresh the OFAC list (a no-op unless
  // SANCTIONS_LIST=ofac-sdn) BEFORE the lock, so the screen inside the mint
  // transaction reads a cached list and never needs a second pool connection.
  // Never throws; a missing list fails the screen closed (flagged).
  const rewardPlan = await prepareReward(store, input);
  await warmSanctionsList();
  const minted = await store.mintUnderSenderLock(input.partnerId, input.phone, (ops) =>
    mintLocked(ops, {
      input, q, sourceCountry, destinationCountry, destinationCurrency, rules,
      subject, limits, kycGateActive, settlementPartnerId, provenance,
      requote, quotedCount, rewardPlan,
    }),
  );
  const transfer = minted.transfer;
  // A same-id replay is a MASKED read of the existing row and a blocked row is
  // evidence only: neither reaches the address-book write below (a replay
  // must never write ****last4 into the sender's saved recipients — ctx-01).
  if (minted.replayed || transfer.status === 'blocked') return { transfer, replayed: minted.replayed };
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
      }, input.scheduleId ? { keepTombstone: true } : undefined);
    } catch (err) {
      logWarn('transfer.upsert_recipient', err, { transferId: transfer.id });
    }
  }

  return { transfer, replayed: false };
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
  provenance: FxProvenance;      // Step 0 FX-7
  /** A5: re-price the re-quote at another fee-tier count (absent on an approved quote). */
  requote?: RequoteAt;
  /** A5: the fee-tier count `q` was priced at (absent on an approved quote). */
  quotedCount?: number;
  /** B3: the approved quote's reward, cleared by the pre-lock checks (absent ⇒ none). */
  rewardPlan?: RewardPlan;
}

/** B3: a reward the mint will re-check under the lock and record. */
interface RewardPlan {
  reward: QuotedReward;
  /** The programs as they are now (funded rewards only; first transfer free needs none). */
  facts?: RewardMintFacts;
}

/**
 * B3: the root-handle reward checks, ABOVE the sender lock (no store call may
 * run inside it). Only an approved quote's reward counts (the re-quote paths
 * never price one). First transfer free is today's rule: the switch only
 * decides whether it is RECORDED, never its price. A SmartRemit-funded reward
 * needs the switch and demo mode NOW (fail closed) and is never sandbox or
 * B2B; otherwise RewardEndedError, before anything is read under the lock.
 */
async function prepareReward(store: Store, input: CreateTransferInput): Promise<RewardPlan | undefined> {
  const reward = input.reward;
  if (!reward || !input.quote) return undefined;
  const funded = isFundedRewardKind(reward.kind);
  if ((input.transferType ?? 'b2c') !== 'b2c' || input.environment === 'test') {
    if (funded) throw new RewardEndedError();
    return undefined;
  }
  const active = await rewardsActive(store, input.partnerId, input.phone);
  if (!funded) return active ? { reward } : undefined;
  if (!active) throw new RewardEndedError();
  try {
    return { reward, facts: await store.rewardMintFacts(input.partnerId) };
  } catch (err) {
    logWarn('rewards.mint_facts', err instanceof Error ? err.name : 'error', { partnerId: input.partnerId });
    throw new RewardEndedError();
  }
}

/** B3: the redemption the locked mint writes with the transfer. */
interface RewardWrite {
  month: string;
  reward: QuotedReward;
  giveBackUsd: number;
  giveBackWithheld: boolean;
}

/**
 * B3: the reward decided UNDER the sender lock, after sanctions and the cap.
 * First transfer free: recorded as it is (A5's stale check already refused a
 * sender who has a transfer). A funded reward must still qualify on this
 * sender's locked usage (a concurrent mint's reward is seen), then, unless
 * compliance flagged the transfer, fit the partner budget read under the
 * partner budget lock. Flagged (owner decision, question 9): the customer
 * keeps the price, the partner pays the discount, no give-back, budget
 * untouched; nothing tells the customer. null ⇒ the reward ended.
 */
async function lockedReward(
  ops: SenderLedgerOps,
  p: PreparedMint,
  q: NonNullable<CreateTransferInput['quote']>,
  complianceStatus: Transfer['complianceStatus'],
  now: Date,
): Promise<RewardWrite | null> {
  const plan = p.rewardPlan!;
  const month = easternMonth(now.getTime());
  const { reward } = plan;
  if (!isFundedRewardKind(reward.kind) || !plan.facts) {
    return { month, reward, giveBackUsd: 0, giveBackWithheld: false };
  }
  const { catalog, settings, terms } = plan.facts;
  const usage = await ops.rewardUsage(month, easternMonthStart(now));
  const standardFeeUsd = wouldBeFeeUsd(q.amountUsd, p.input.fundingMethod) ?? 0;
  const facts = { now, amountUsd: q.amountUsd, standardFeeUsd, catalog, settings, usage };
  if (!qualifies(reward.kind, facts)) return null;
  // The quoted discount must still fit today's catalog: an admin who lowers the maximum stops
  // the old, larger discount (and its give-back) at once. Compared in cents.
  if (Math.round(reward.discountUsd * 100) > Math.round(discountFor(reward.kind, facts) * 100)) return null;
  if (complianceStatus === 'flagged') return { month, reward, giveBackUsd: 0, giveBackWithheld: true };
  const giveBackUsd = giveBackFor(reward.discountUsd, terms.giveBackPct);
  const used = await ops.rewardBudgetUsed(month);
  if (!budgetAllows(terms, used, giveBackUsd)) return null;
  return { month, reward, giveBackUsd, giveBackWithheld: false };
}

/** A5: the re-quote at a given fee-tier count, over the rates read before the lock. */
type RequoteAt = (transferCount: number) => NonNullable<CreateTransferInput['quote']>;

/**
 * A5: the fee tier, decided UNDER the sender lock. The count read before the
 * lock can be stale: a concurrent mint for the same sender may have committed
 * since. A re-quote (no approved quote: Partner API, cron, legacy chat) is
 * re-priced at the locked count when the tier changed. An approved quote is
 * honoured verbatim, except a fee waived as the free first transfer when the
 * sender now has one: `stale` is set and mintLocked refuses it as stale_quote
 * right before the insert (after sanctions and the cap, so their verdicts and
 * refusals are unchanged; the throw rolls everything back, so nothing is
 * minted and the customer gets a fresh quote).
 */
async function lockedFeeTierQuote(
  ops: SenderLedgerOps,
  p: PreparedMint,
): Promise<{ q: NonNullable<CreateTransferInput['quote']>; stale: boolean }> {
  const locked = await ops.transferCount();
  if (p.input.quote) {
    // B3: a $0 fee from a SmartRemit-funded reward is not the first-transfer
    // waiver; lockedReward re-checks it instead.
    const fundedReward = p.rewardPlan !== undefined && isFundedRewardKind(p.rewardPlan.reward.kind);
    return { q: p.q, stale: p.input.quote.feeUsd === 0 && !isFirstTransferFree(locked) && !fundedReward };
  }
  if (p.requote && p.quotedCount !== undefined && isFirstTransferFree(locked) !== isFirstTransferFree(p.quotedCount)) {
    return { q: p.requote(locked), stale: false };
  }
  return { q: p.q, stale: false };
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
 *   2a. the optional AML hold (Program-Fix 43 PR B: OFF by default, never
 *       demo, cleared → flagged only, never throws);
 *   2b. the sanctions.screen evidence row (Program-Fix 14), same transaction
 *       (PR C: the same evidence is stored on the inserted row, transfers.screening);
 *   3. a watchlist hit inserts the `blocked` row and returns (never consumes cap);
 *   4. a display placeholder throws (rolls back);
 *   5. evaluateCap on today's ledger spend → SendCapError (rolls back);
 *   6. insert.
 */
async function mintLocked(
  ops: SenderLedgerOps,
  p: PreparedMint,
): Promise<{ transfer: Transfer; replayed: boolean }> {
  const { input } = p;
  if (input.id) {
    // A same-key re-mint (claim-first callers only). The row must belong to
    // THIS tenant: an id that exists under another partner is neither replayed
    // nor re-inserted (insertTransfer is an upsert) — refuse before any write.
    const existing = await ops.getTransfer(input.id);
    if (existing) {
      if (existing.partnerId !== input.partnerId) throw new TransferIdConflictError();
      // Program-Fix 44 P2: the same id in the OTHER environment is a conflict too.
      if ((existing.environment ?? 'live') !== (input.environment ?? 'live')) throw new TransferIdConflictError();
      return { transfer: existing, replayed: true };
    }
  }
  // M2-10 (#398 review L2): a scheduled mint re-checks its schedule under the lock, BEFORE the
  // sanctions screen, so a refused run leaves no blocked row or evidence behind.
  if (input.scheduleId) {
    const check = await ops.scheduleMintCheck(input.scheduleId, input.recipientPhone);
    if (check !== 'ok') throw new ScheduleMintRefusedError(check);
  }
  // A5: the fee tier on the locked count (its stale refusal is applied below, before the insert).
  const { q, stale: staleFreeQuote } = await lockedFeeTierQuote(ops, p);
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
  const id = input.id ?? newTransferId();
  // ── Optional AML hold (Program-Fix 43 PR B) ──────────────────────────────
  // OFF unless the partner's corridor switch is the literal `true`; never on
  // the default (demo) tenant on either side; never on a non-http rail; only
  // ever cleared → flagged. The gate is pure, so OFF / demo / an already
  // flagged or blocked verdict costs ZERO statements. Past it, the two reads
  // run in a savepoint that never throws (null ⇒ failed, alert queued ⇒ no
  // hold), and this block is wrapped again: it can never fail the mint.
  if (amlHoldGate({
    amlHolds: p.rules.amlHolds,
    partnerId: input.partnerId,
    railPartnerId: p.settlementPartnerId ?? input.partnerId,
    complianceStatus,
  })) {
    try {
      const inputs = await ops.amlHoldInputs({
        railPartnerId: p.settlementPartnerId ?? input.partnerId,
        anchor: { at: now, id },
        largeAmountUsd: p.rules.largeAmountUsd,
        band: p.rules.aml.band,
      });
      if (inputs?.prior && amlHoldRailEligible(inputs.railProviderType)) {
        const hit = amlHoldHit(inputs.prior, q.amountUsd, { ...p.rules.aml, largeAmountUsd: p.rules.largeAmountUsd });
        ({ complianceStatus, complianceReasons } = applyAmlHold({ complianceStatus, complianceReasons }, hit));
      }
    } catch (err) {
      logError('aml.hold_check', err, { partnerId: input.partnerId });
    }
  }
  // ── Missing sender identity (Program-Fix 14 follow-up) ────────────────────
  // AFTER screening, EDD and the AML gate so their verdicts are unchanged; it
  // only ever ADDS a hold. A watchlist BLOCK still wins (never downgraded).
  if (input.senderIdentityMissing && complianceStatus !== 'blocked') {
    complianceStatus = 'flagged';
    complianceReasons = [...complianceReasons, SENDER_IDENTITY_MISSING_REASON];
  }
  // ── Purpose hold (Batch B follow-up A4) ───────────────────────────────────
  // The reason for purpose `other` is re-checked here (the server is the
  // authority): only a valid one is stored. A scam-pattern reason holds the
  // transfer, cleared → flagged with the generic reason, never a downgrade and
  // never touching blocked (applyPurposeHold). OWNER DECISION 2026-10-08: this
  // hold applies to EVERY partner, the default (demo) tenant and simulator
  // rails included (unlike the optional AML hold above), so the owner can test it.
  const purposeCheck = input.purposeDetail ? checkPurposeDetail(input.purposeDetail) : null;
  const purposeDetail = purposeCheck?.ok ? purposeCheck.detail : undefined;
  const purposeRisk = purposeCheck?.ok ? purposeCheck.risk?.category : undefined;
  ({ complianceStatus, complianceReasons } = applyPurposeHold({ complianceStatus, complianceReasons }, purposeRisk));
  const transfer: Transfer = {
    id,
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
    ...(purposeDetail ? { purposeDetail } : {}),     // Batch B follow-up A2 (encrypted, write-once)
    eddRequired: eddCheck.eddRequired,               // NEW (KYC)
    transferType: input.transferType ?? 'b2c',       // NEW (B2B)
    senderEntityType: input.senderEntityType ?? 'individual',
    recipientEntityType: input.recipientEntityType ?? 'individual',
    senderBusinessName: input.senderBusinessName,
    recipientBusinessName: input.recipientBusinessName,
    achTokenRef: input.achTokenRef,
    invoiceId: input.invoiceId,
    environment: input.environment ?? 'live',        // Program-Fix 44 P2
    ...p.provenance,                                 // Step 0 FX-7 (write-once)
    ...(input.clientReference ? { clientReference: input.clientReference } : {}), // Batch B1
  };
  // ── Sanctions evidence (Program-Fix 14) ───────────────────────────────────
  // One sanctions.screen audit row per screened mint, written through the
  // lock's transaction BEFORE either insert path: a blocked, cleared or flagged
  // mint commits it with its transfer row, and any later refusal (placeholder,
  // SendCapError) rolls both back. A same-id replay returned above never
  // re-screens, so it never writes a second row. No evidence ⇒ no row.
  if (compliance.evidence) {
    await ops.recordAudit(sanctionsAuditEvent(input.partnerId, transfer.id, compliance.evidence));
  }

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
    await ops.insertTransfer(blockedRow, { screening: compliance.evidence });
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

  // ── A5: an approved free-first-transfer quote the sender already used ─────
  // The existing stale-quote refusal (every caller maps it to "ask for a fresh
  // quote"); the throw rolls back the evidence row, so nothing is written.
  if (staleFreeQuote) throw new RateUnavailableError('stale_quote');

  // ── B3: the reward, re-checked under the lock (its refusal rolls back) ─────
  const rewardWrite = p.rewardPlan ? await lockedReward(ops, p, q, complianceStatus, now) : null;
  if (p.rewardPlan && !rewardWrite) throw new RewardEndedError();

  await ops.insertTransfer(transfer, { screening: compliance.evidence });
  // One reward per transfer (the PK), committed with the transfer or not at all.
  if (rewardWrite) await ops.insertRedemption({ transferId: transfer.id, ...rewardWrite });
  // Batch B follow-up A4: a scam-pattern reason is audited (category and id, no
  // free text) and raises one deduped ops alert, committed with the row. Also
  // when another rule already flagged it: staff should know the category.
  if (purposeRisk) {
    await ops.recordAudit({
      partnerId: input.partnerId,
      actor: PURPOSE_AUDIT_ACTOR,
      actorType: 'system',
      action: 'purpose.flag',
      subjectId: transfer.id,
      meta: { category: purposeRisk },
    });
    await ops.enqueuePurposeFlagAlert(transfer.id, purposeRisk);
  }
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
  /** Program-Fix 14: the quote-time screen's evidence (screen.evidence). */
  evidence?: ScreeningEvidence;
  /** Step 0 FX-7: the quote-time rate provenance (absent ⇒ none stamped). */
  fxOrigin?: FxRateOrigin;
  fxAsOf?: string;
  fxFetchedAt?: number;
  fxProvider?: string;
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
    ...fxProvenanceFor(input.fxOrigin, input.fxAsOf, input.fxFetchedAt, undefined, input.fxProvider), // Step 0 FX-7
  };
  if (input.evidence) {
    // Program-Fix 14 (step 5): a blocked quote never reaches the mint, so this
    // row IS the record of truth — the blocked row and its sanctions.screen
    // evidence commit in ONE transaction (both or neither).
    await store.recordBlockedWithEvidence(
      transfer,
      sanctionsAuditEvent(input.partnerId, transfer.id, input.evidence),
    );
  } else {
    // No evidence supplied (a caller that predates Program-Fix 14): today's
    // behaviour, the blocked row only and no evidence row.
    await store.saveTransfer(transfer);
  }
  return transfer;
}
