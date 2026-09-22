import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type {
  CountryCode, CurrencyCode, KycStatus, Partner, PartnerId, PayoutMethod, Transfer,
} from './types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from './types';
import { getDestinationRates, getFxRates, RateUnavailableError } from './rate';
import { quote, QuoteError } from './fx';
import { isMaskedDestination, validatePayoutFields } from './payout-format';
import { allowedSendCurrencies, resolveSendCurrency, countryForCurrency } from './partner-currency';
import { createTransfer, TransferIdConflictError } from './transfer-create';
import { quoteCeilingUsd, resolveEffectiveSendLimits, SendBusyError, SendCapError } from './send-limits';
import { isValidPhone, normalizePhone } from './phone';
import { sendGateActive } from './kyc-gate';
import { resolvePartnerBranding } from './partner-config';
import type { PartnerIntegrationsStore } from './partner-integrations-store';
import type { DbOrTx } from '@/db/client';
import {
  createBeneficiaryRepo,
  createIdempotencyRepo,
  createAuditRepo,
  type BeneficiaryRecord,
} from '@/db/repos/aux-repos';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { beginHold, settleOrHold } from './settlement';
import { pokeWorker, pokeWorkerDelayed } from './outbox';
import { DELIVERY_DELAY_MS } from './providers/payment-provider';
import type { Db } from '@/db/client';
import { newTransferId } from './id';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';
import { resolveSenderNames, senderNameKey } from './sender-names';
import type { CustomerStore } from './customer-store';

// partner-api-service — the business logic behind /api/partner/v1/*. Pure-ish and
// dependency-injected so it's TDD'd with fakeRedis (the route files are thin
// adapters: auth-guard → parse → call here → JSON). EVERY function is scoped to
// the partner resolved from the API key; nothing trusts a body/path partnerId.
//
// NON-CUSTODIAL: this only mints + relays transfer INSTRUCTIONS and mirrors
// status. Sanctions run inside createTransfer for every partner. Real settlement
// is the partner's rail (Phase C); here confirm drives the mock provider.

export type SvcResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export interface PartnerApiDeps {
  store: Store;
  partnerStore: PartnerStore;
  monthlyVolumeStore: MonthlyVolumeStore;
  integrationsStore: PartnerIntegrationsStore; // WL3 — per-partner rail + WhatsApp creds
  customerStore: CustomerStore; // fix 1 — sender rows are per tenant
  db: DbOrTx; // beneficiaries / idempotency keys / api audit (Stage 2a-3)
  // Injectable so the route uses the real provider while tests stub settlement
  // (the mock provider sends WhatsApp + arms a timer we don't want in unit tests).
  initiatePayment?: (transfer: Transfer) => Promise<void>;
  now?: () => string;
  genId?: () => string;
}

const ok = <T>(status: number, data: T): SvcResult<T> => ({ ok: true, status, data });
const err = (status: number, error: string): SvcResult<never> => ({ ok: false, status, error });

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Public transfer view — exposes the end-customer SENDER identity to the partner
// (a deliberate, user-approved privacy change: previously the sender was hidden).
// `senderName` is the customer's DECRYPTED legal name (only present after KYC);
// pass it in pre-resolved (resolveSenderNames) so the list path stays one query,
// not an N+1. Absent name ⇒ null (the partner falls back to sender_phone).
function transferView(t: Transfer, senderName: string | null = null) {
  return {
    id: t.id,
    status: t.status,
    compliance_status: t.complianceStatus,
    amount_source: t.amountSource ?? t.amountUsd,
    source_currency: t.sourceCurrency ?? 'USD',
    amount_destination: t.amountInr,
    destination_currency: t.destinationCurrency ?? 'INR',
    destination_country: t.destinationCountry ?? 'IN',
    fee_source: t.feeSource ?? t.feeUsd,
    total_charge_source: t.totalChargeSource ?? t.totalChargeUsd,
    fx_rate: t.fxRate,
    sender_phone: t.phone,
    sender_name: senderName,
    recipient_name: t.recipientName,
    funding_method: t.fundingMethod,
    funding_ref: t.fundingRef ?? null,
    refund_ref: t.refundRef ?? null,
    created_at: t.createdAt,
    partner_id: t.partnerId,
  };
}

// Single-transfer view: resolve the one sender name, then project. Kept async so
// the create/confirm/get call sites await it (the list path resolves names in a
// batch and calls transferView directly with the pre-resolved name).
async function transferViewWithName(deps: PartnerApiDeps, t: Transfer) {
  // Tenant-keyed (F50/F52): only the caller's OWN customer row can supply a name.
  const names = await resolveSenderNames(deps.db, [t]);
  return transferView(t, names.get(senderNameKey(t.partnerId, t.phone)) ?? null);
}

// The supported destination set + its home currency — derived from the single
// DEFAULT_CURRENCY_FOR_COUNTRY authority (US/CA/GB/AE/SG/AU/NZ/IN).
const SUPPORTED_DESTINATIONS = (Object.entries(DEFAULT_CURRENCY_FOR_COUNTRY) as [CountryCode, CurrencyCode][])
  .map(([destination_country, destination_currency]) => ({ destination_country, destination_currency }));

// Resolve a body-supplied destination_country → its home currency. Unknown or
// absent ⇒ the legacy IN/INR default (back-compat; never 400s).
function resolveDestination(requested: string): { country: CountryCode; currency: CurrencyCode } {
  const country = requested.toUpperCase() as CountryCode;
  const currency = DEFAULT_CURRENCY_FOR_COUNTRY[country];
  if (currency) return { country, currency };
  return { country: DEFAULT_DESTINATION_COUNTRY, currency: DEFAULT_DESTINATION_CURRENCY };
}

// The partner API is PROGRAMMATIC — it must never throw a "which currency?" prompt
// (that is the chat path's job). Resolve explicit > sender-phone > the partner's
// primary currency, never throwing. Now that the default partner is multi-currency,
// a call that omits source_currency must still resolve (was a 500 otherwise).
function apiSourceCurrency(partner: Partner, requested?: string, senderPhone?: string): CurrencyCode {
  try {
    return resolveSendCurrency(partner, requested, senderPhone);
  } catch {
    return allowedSendCurrencies(partner)[0];
  }
}

// ── GET /corridors ────────────────────────────────────────────────────────
export function listCorridors(partner: Partner) {
  const currencies = allowedSendCurrencies(partner);
  return {
    brand: resolvePartnerBranding(partner).brand,
    // Legacy "send → India" corridors. A source whose own country IS the
    // destination (INR → IN) is degenerate, so it is excluded.
    corridors: currencies
      .filter((c) => countryForCurrency(c) !== 'IN')
      .map((c) => ({
        source_country: countryForCurrency(c),
        source_currency: c,
        destination_country: 'IN' as CountryCode,
        destination_currency: 'INR' as CurrencyCode,
      })),
    // Any-to-any (additive): the full supported destination set.
    destinations: SUPPORTED_DESTINATIONS,
  };
}

// ── POST /quote ───────────────────────────────────────────────────────────
export async function createQuote(
  deps: PartnerApiDeps,
  partner: Partner,
  body: Record<string, unknown>,
): Promise<SvcResult<unknown>> {
  const amount = num(body.amount_source ?? body.amount);
  if (amount === null || amount <= 0) return err(400, 'amount_source must be a positive number.');
  // Program fix 16 (review): the same normalization createTransaction applies,
  // so a formatted number auto-detects the same currency it will mint under.
  const quoteSenderPhone = normalizePhone((body.sender as Record<string, unknown> | undefined)?.phone);
  const sourceCurrency = apiSourceCurrency(
    partner,
    str(body.source_currency) || undefined,
    quoteSenderPhone || undefined,
  );
  // Callers may pass either destination_country (resolved to its home currency)
  // or destination_currency directly. destination_country takes precedence when
  // it names a supported country; otherwise the legacy destination_currency path
  // (default INR) is unchanged.
  const destCountryReq = str(body.destination_country);
  const destByCountry = destCountryReq ? DEFAULT_CURRENCY_FOR_COUNTRY[destCountryReq.toUpperCase() as CountryCode] : undefined;
  // str() trims; upper-cased like pushPartnerRate so "gbp" quotes exactly like "GBP".
  const destinationCurrency = (destByCountry || str(body.destination_currency).toUpperCase() || 'INR') as CurrencyCode;
  // Validated at the edge (Task 9 security review): an unsupported code is the
  // caller's error (400), never an FX-provider call or a misleading 503.
  if (!SUPPORTED_CURRENCIES.has(destinationCurrency)) {
    return err(400, `destination_currency must be one of: ${SUPPORTED_CURRENCIES_LIST}.`);
  }
  try {
    const rates = await getFxRates(sourceCurrency);
    const destRates = await getDestinationRates(destinationCurrency);
    // transferCount drives the fee tier; a partner-API quote uses standard pricing.
    // Fix 16b: the preview has no customer, so its ceiling is the PARTNER-level
    // effective max; the mint itself applies any customer override.
    const q = quote(amount, sourceCurrency, rates, 'bank_transfer', 1, destinationCurrency, destRates?.toUsd, quoteCeilingUsd(resolveEffectiveSendLimits(partner, null)));
    return ok(200, {
      amount_source: q.amountSource,
      source_currency: sourceCurrency,
      fee_source: q.feeSource,
      total_charge_source: q.totalChargeSource,
      amount_destination: q.amountInr,
      destination_currency: destinationCurrency,
      fx_rate: q.fxRate,
    });
  } catch (e) {
    // Task 9: the FX provider is down / beyond the ceiling ⇒ 503 (retryable).
    // A QuoteError is the caller's request being invalid ⇒ 400. The two are
    // sibling classes — RateUnavailableError is NOT a QuoteError.
    if (e instanceof RateUnavailableError) return err(503, e.message);
    if (e instanceof QuoteError) return err(400, e.message);
    throw e;
  }
}

// ── POST /beneficiaries/:id/validate (stateless) ──────────────────────────
export function validateBeneficiary(body: Record<string, unknown>): SvcResult<unknown> {
  const country = str(body.country).toUpperCase() as CountryCode;
  if (!country) return err(400, 'country is required.');
  const fields = (body.fields && typeof body.fields === 'object' ? body.fields : {}) as Record<string, string>;
  const result = validatePayoutFields(country, fields);
  if (!result.ok) return err(422, JSON.stringify(result.errors));
  return ok(200, { valid: true, payout_destination: result.payoutDestination });
}

// ── POST /beneficiaries ───────────────────────────────────────────────────

export async function createBeneficiary(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  body: Record<string, unknown>,
): Promise<SvcResult<unknown>> {
  const name = str(body.name);
  const country = str(body.country).toUpperCase() as CountryCode;
  if (!name) return err(400, 'name is required.');
  if (!country) return err(400, 'country is required.');
  const fields = (body.fields && typeof body.fields === 'object' ? body.fields : {}) as Record<string, string>;
  const validation = validatePayoutFields(country, fields);
  if (!validation.ok) return err(422, JSON.stringify(validation.errors));
  const id = `ben_${(deps.genId ?? newTransferId)()}`;
  const ben: BeneficiaryRecord = {
    id, partnerId, name, country,
    payoutMethod: (str(body.payout_method) as PayoutMethod) || 'bank',
    payoutDestination: validation.payoutDestination,
    recipientPhone: str(body.recipient_phone) || undefined,
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
  // Postgres row, partner-scoped, payout destination ENCRYPTED at rest.
  await createBeneficiaryRepo(deps.db).createBeneficiary(ben);
  return ok(201, { id, name, country, payout_destination: ben.payoutDestination });
}

async function getStoredBeneficiary(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  id: string,
): Promise<BeneficiaryRecord | null> {
  // Partner-scoped (WHERE partner_id) + decrypted — the transaction needs the
  // FULL payout destination to mint the transfer.
  return createBeneficiaryRepo(deps.db).getOwnedBeneficiary(partnerId, id);
}

// ── POST /transactions (idempotency-key REQUIRED) ─────────────────────────
export async function createTransaction(
  deps: PartnerApiDeps,
  partner: Partner,
  keyId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<SvcResult<unknown>> {
  if (!idempotencyKey) return err(400, 'Idempotency-Key header is required.');
  // fix 6 (ctx-01): 'draft:' and 'b2binvoice:' keys belong to the pay page
  // (pay-finalize.ts, under the default tenant) and the B2B checkout
  // (b2b-pay-finalize.ts). transfer-repo's payoutEditable reads a 'draft:'
  // claim under default as "NOT partner-API-minted"; a partner key there (the
  // default tenant can hold API keys — admin-dashboard/partners/actions.ts)
  // would unlock the payout of a transfer the partner supplied. Refused before
  // any read or write.
  if (/^(draft|b2binvoice):/.test(idempotencyKey)) {
    return err(400, "Idempotency-Key may not begin with 'draft:' or 'b2binvoice:' (reserved).");
  }

  // Body validation + TENANT BINDING run BEFORE the idempotency claim (fix 1):
  // a refusal here never binds the key to a half-minted id. sender.phone is
  // resolved under partner.id ONLY — another tenant's row for the same number
  // is structurally unreachable, so the response for "someone else's customer"
  // is identical to "unknown phone" (no enumeration oracle; 404-never-403 spirit).
  const amount = num(body.amount_source ?? body.amount);
  if (amount === null || amount <= 0) return err(400, 'amount_source must be a positive number.');

  const sender = (body.sender && typeof body.sender === 'object' ? body.sender : {}) as Record<string, unknown>;
  if (!str(sender.phone)) return err(400, 'sender.phone is required.');
  // Program fix 16 (review MUST 1): ONE identity per number. The cap day, the
  // EDD month, the velocity count, the customers row and the per-sender lock
  // are all keyed by this string, so "+1 555…", "1-555-…" and "1555…" must
  // collapse to the same digits (the chat path already does this) — else a
  // spelling is a fresh cap. Refused BEFORE ensureCustomer and the claim.
  const senderPhone = normalizePhone(sender.phone);
  if (!isValidPhone(senderPhone)) return err(400, 'sender.phone must be a valid E.164-style number.');

  // Beneficiary: by reference (partner-scoped) or inline. MOVED ABOVE the
  // customer write and the claim (on main it sits below both, :269-284): a
  // 404 / 400 here must leave NO customer row behind, or an API-keyed caller
  // could create unbounded customer rows under its tenant with rejected bodies.
  let benName = '', benPhone = '', payoutMethod: PayoutMethod = 'bank', payoutDestination = '';
  const benId = str(body.beneficiary_id);
  if (benId) {
    const stored = await getStoredBeneficiary(deps, partner.id, benId);
    if (!stored) return err(404, 'Beneficiary not found.');
    benName = stored.name; benPhone = stored.recipientPhone ?? '';
    payoutMethod = stored.payoutMethod; payoutDestination = stored.payoutDestination;
  } else {
    const ben = (body.beneficiary && typeof body.beneficiary === 'object' ? body.beneficiary : {}) as Record<string, unknown>;
    benName = str(ben.name);
    if (!benName) return err(400, 'beneficiary.name (or beneficiary_id) is required.');
    benPhone = str(ben.phone);
    payoutMethod = (str(ben.payout_method) as PayoutMethod) || 'bank';
    payoutDestination = str(ben.payout_destination);
  }

  // fix 6 (ctx-01): a masked display value is never an account. Refuse at the
  // edge — BEFORE the customer write and the idempotency claim — so a corrected
  // retry under the same key mints normally.
  if (isMaskedDestination(payoutDestination)) {
    return err(422, 'beneficiary payout_destination must be the recipient account, not a masked display value.');
  }
  // fix 10 (review S2): every partner-API mint is a CONSUMER (b2c) transfer, and
  // the rail refuses an empty payout on one (buildSettlementInstruction) — so a
  // missing account is a 400 at the edge, before the customer write and the claim.
  if (payoutDestination.trim() === '') {
    return err(400, 'beneficiary payout_destination is required.');
  }

  // The LAST step before the claim, AFTER every body check (Task 2 Step 28
  // later inserts its beneficiary name / destination edge validation ABOVE this
  // line — never below it). No WhatsApp opt-in is implied by an API mint
  // (ensureCustomer, not upsertOnFirstInbound).
  await deps.customerStore.ensureCustomer(partner.id, senderPhone);

  // CLAIM-FIRST idempotency (Stage 2c): pre-generate the transfer id and bind
  // the key BEFORE minting. PK(partner_id, key) means exactly one id can ever
  // own this key — a concurrent duplicate or crash-replay deterministically
  // converges on the winner, and a crash after the claim re-mints the SAME id.
  const idem = createIdempotencyRepo(deps.db);
  const candidateId = (deps.genId ?? newTransferId)();
  const reservedId = await idem.claim(partner.id, idempotencyKey, candidateId);
  if (reservedId !== candidateId) {
    // The key was already bound — replay. (A bound-but-unminted id means a
    // prior attempt crashed mid-mint; fall through and mint THAT id.)
    const t = await deps.store.getTransfer(reservedId);
    if (t && t.partnerId === partner.id) return ok(200, await transferViewWithName(deps, t));
  }

  // senderPhone is required here (validated above), so an Indian sender with no
  // source_currency auto-detects INR; the helper never throws (→ no 500).
  const sourceCurrency = apiSourceCurrency(partner, str(body.source_currency) || undefined, senderPhone);
  // Any-to-any destination: an absent/unsupported destination_country defaults
  // to IN/INR (back-compat). NOTE compliance is SOURCE-gated — the destination
  // is never fed into screening.
  const destination = resolveDestination(str(body.destination_country));
  const requiresKyc = sendGateActive(partner); // 'delegated' ⇒ false; sanctions still run
  const senderKycStatus = (str(sender.kyc_status) || 'not_started') as KycStatus;

  let transfer: Transfer;
  try {
    transfer = await createTransfer(deps.store, deps.partnerStore, deps.monthlyVolumeStore, {
      id: reservedId, // the idempotency-claimed id — crash-replay mints the same row
      phone: senderPhone,
      partnerId: partner.id, // authoritative: from the key, not the body
      requiresKyc,
      senderKycStatus,
      senderName: str(sender.name) || undefined,
      recipientName: benName,
      recipientPhone: benPhone,
      payoutMethod,
      payoutDestination,
      fundingMethod: 'bank_transfer',
      amountSource: amount,
      sourceCurrency,
      destinationCountry: destination.country,
      destinationCurrency: destination.currency,
    });
  } catch (e) {
    // Task 9: FX unavailable ⇒ 503. The key is bound to reservedId but nothing
    // was minted — exactly the crash-replay shape above: a retry with the SAME
    // Idempotency-Key falls through and mints THAT id once FX is back, and a
    // replay of an already-minted key never reaches this point (200 above).
    if (e instanceof RateUnavailableError) return err(503, e.message);
    if (e instanceof QuoteError) return err(400, e.message);
    if (e instanceof Error && e.message === 'kyc_required') {
      return err(422, 'Sender identity verification required (this partner runs SmartRemit KYC).');
    }
    // Program fix 16: every partner-API mint is capped from the ledger. No
    // figures in the response (the caps are policy, not a per-sender oracle).
    // The key stays bound-but-unminted, so the same Idempotency-Key mints once
    // there is headroom / the lock is free.
    if (e instanceof SendCapError) return err(422, "This transfer exceeds the sender's current sending limit.");
    if (e instanceof SendBusyError) return err(503, 'Another transfer for this sender is in progress. Please retry.');
    // The claimed id already names another tenant's row (unreachable by
    // provenance; never overwritten). The key stays bound; a new key mints.
    if (e instanceof TransferIdConflictError) return err(409, 'Idempotency-Key conflict. Retry with a new key.');
    throw e;
  }

  await appendAudit(deps, partner.id, keyId, 'transaction.create', transfer.id);
  // A sanctions block is surfaced as 422 (the row exists, status 'blocked').
  if (transfer.complianceStatus === 'blocked') {
    return err(422, 'This transfer was blocked by compliance screening.');
  }
  return ok(201, await transferViewWithName(deps, transfer));
}

// ── GET /transactions (keyset list, ownership-scoped) ─────────────────────
export async function listTransactions(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  query: { limit?: string | null; cursor?: string | null },
): Promise<SvcResult<unknown>> {
  const rawLimit = num(query.limit ?? undefined);
  const limit = Math.min(100, Math.max(1, rawLimit ?? 25));
  const page = await deps.store.listTransfersPage({
    limit,
    cursor: query.cursor ?? undefined,
    partnerId, // authoritative: from the API key, never the query
  });
  // Resolve ALL sender names in ONE query (not N+1 per row), then project.
  const names = await resolveSenderNames(deps.db, page.items);
  return ok(200, {
    transactions: page.items.map((t) => transferView(t, names.get(senderNameKey(t.partnerId, t.phone)) ?? null)),
    next_cursor: page.nextCursor ?? null,
  });
}

// ── GET /transactions/:id (ownership-scoped) ──────────────────────────────
export async function getTransaction(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  id: string,
): Promise<SvcResult<unknown>> {
  const t = await deps.store.getTransfer(id);
  // 404 (never 403) for a missing OR out-of-scope transfer — don't disclose existence.
  if (!t || t.partnerId !== partnerId) return err(404, 'Transaction not found.');
  return ok(200, await transferViewWithName(deps, t));
}

// ── POST /transactions/:id/confirm (ownership-scoped) ─────────────────────
//
// COMPLIANCE HOLD (F51): the hold is decided HERE — before, and independent
// of, the injectable `deps.initiatePayment` seam — so neither a test double
// nor any partner configuration can route a flagged transfer to a rail.
// Sanctions/compliance screening is structurally untoggleable and applies in
// BOTH KYC modes: a delegated-KYC key holds exactly like an 'ours' key (the
// check is on complianceStatus, never on kycMode).
export async function confirmTransaction(
  deps: PartnerApiDeps,
  partner: Partner,
  keyId: string,
  id: string,
): Promise<SvcResult<unknown>> {
  const t = await deps.store.getTransfer(id);
  // 404 (never 403) BEFORE any read or mutation of another tenant's row.
  if (!t || t.partnerId !== partner.id) return err(404, 'Transaction not found.');
  if (t.complianceStatus === 'blocked' || t.status === 'blocked') return err(422, 'This transfer was blocked by compliance screening.');
  // Idempotent replay: already settled OR already held → current truth, no second effect.
  if (t.status === 'paid' || t.status === 'delivered' || t.status === 'in_review') {
    return ok(200, await transferViewWithName(deps, t));
  }
  if (t.status !== 'awaiting_payment') return err(409, `Cannot confirm a transfer in status ${t.status}.`);

  if (t.complianceStatus !== 'cleared') {
    // FLAGGED: hold, never settle. beginHold is ONE transaction (in_review
    // flip + held stage-1 outbox row, dedupe stage1:<id>); NO rail effect.
    // Partner-scoped: ownership was checked above; the held row names the
    // OWNER (t.partnerId) and the worker resolves its creds at drain (fix 11).
    const hold = await beginHold(deps.db as Db, t);
    if (hold.kind === 'held') {
      pokeWorker(); // the held "payment received / under review" message is READY now
      // Audit ONLY a real transition (mirrors the settle path below): on the
      // 'already' race a concurrent confirm/pay won and audited it — a second
      // transaction.confirm row here would record a no-op as an action.
      await appendAudit(deps, partner.id, keyId, 'transaction.confirm', t.id);
    }
    const held = await deps.store.getTransfer(id);
    return ok(200, await transferViewWithName(deps, held ?? t));
  }

  const initiate = deps.initiatePayment ?? (async (tr: Transfer) => {
    // Stage 2c: the atomic settlement transaction — paid flip + stage-1 message
    // + rail effect (signed instruct / delayed mock settle) commit together;
    // the customer message names the OWNING partner (creds resolve at drain —
    // fix 11). settleOrHold re-checks the LEDGER: if the row was re-screened
    // to flagged since the read above, it is held instead of instructed.
    const integrations = await deps.integrationsStore.getIntegrations(partner.id);
    const result = await settleOrHold(deps.db as Db, tr, integrations);
    // Fast-path drains, mirroring the pay route: the stage-1 message is READY
    // now; the mock rail's delivered message only becomes ready after its
    // simulated DELIVERY_DELAY_MS. The 5-min heartbeat stays the guarantee.
    pokeWorker();
    if (result.kind === 'started' && !result.webhookDriven) {
      pokeWorkerDelayed(DELIVERY_DELAY_MS + 10_000);
    }
    // 'held' / 'already' / 'refused' need no further effect here: the re-read
    // below returns the ledger's current truth (in_review / paid / awaiting).
  });
  await initiate(t);
  await appendAudit(deps, partner.id, keyId, 'transaction.confirm', t.id);
  const after = await deps.store.getTransfer(id);
  return ok(200, await transferViewWithName(deps, after ?? t));
}

// ── PUT /rates (push ONE corridor's wholesale rate) ───────────────────────
//
// The pushed rate is the WHOLESALE rate this partner offers to win routed
// default-tenant flow (best-rate selection in partner-rates.ts) — it does NOT
// reprice the partner's own /quote, which stays at platform mid-market.

const SUPPORTED_CURRENCIES = new Set<string>(Object.values(DEFAULT_CURRENCY_FOR_COUNTRY));
const SUPPORTED_CURRENCIES_LIST = [...SUPPORTED_CURRENCIES].join(', ');
const RATE_TTL_DEFAULT_S = 3_600;
const RATE_TTL_MIN_S = 60;
const RATE_TTL_MAX_S = 86_400;
const RATE_MAX = 100_000;

export async function pushPartnerRate(
  deps: PartnerApiDeps,
  partner: Partner,
  keyId: string,
  body: Record<string, unknown>,
): Promise<SvcResult<unknown>> {
  const sourceCurrency = str(body.source_currency).toUpperCase();
  const destinationCurrency = str(body.destination_currency).toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(sourceCurrency)) {
    return err(400, `source_currency must be one of: ${SUPPORTED_CURRENCIES_LIST}.`);
  }
  if (!SUPPORTED_CURRENCIES.has(destinationCurrency)) {
    return err(400, `destination_currency must be one of: ${SUPPORTED_CURRENCIES_LIST}.`);
  }
  if (sourceCurrency === destinationCurrency) {
    return err(400, 'source_currency and destination_currency must differ.');
  }
  const rate = num(body.effective_rate);
  if (rate === null || rate <= 0 || rate >= RATE_MAX) {
    return err(400, `effective_rate must be a number greater than 0 and less than ${RATE_MAX}.`);
  }
  let ttl = RATE_TTL_DEFAULT_S;
  if (body.ttl_seconds !== undefined) {
    const requested = num(body.ttl_seconds);
    if (requested === null) return err(400, 'ttl_seconds must be a number of seconds.');
    ttl = Math.min(RATE_TTL_MAX_S, Math.max(RATE_TTL_MIN_S, Math.trunc(requested)));
  }

  const nowIso = (deps.now ?? (() => new Date().toISOString()))();
  const expiresAt = new Date(Date.parse(nowIso) + ttl * 1000).toISOString();
  // marginBps stays UNDEFINED — merge-upsert keeps any admin-configured margin.
  const saved = await createPartnerRateRepo(deps.db).upsertRate({
    id: `pr_${(deps.genId ?? newTransferId)()}`,
    partnerId: partner.id, // authoritative: from the API key, never the body
    sourceCurrency: sourceCurrency as CurrencyCode,
    destinationCurrency: destinationCurrency as CurrencyCode,
    effectiveRate: rate,
    expiresAt,
    pushedAt: nowIso,
  });
  await appendAudit(deps, partner.id, keyId, 'rates.push', saved.id);
  return ok(200, {
    source_currency: saved.sourceCurrency,
    destination_currency: saved.destinationCurrency,
    effective_rate: saved.effectiveRate,
    expires_at: saved.expiresAt,
    pushed_at: saved.pushedAt,
  });
}

// ── GET /rates (the partner's own rate sheet) ──────────────────────────────
export async function listPartnerRates(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
): Promise<SvcResult<unknown>> {
  const rates = await createPartnerRateRepo(deps.db).listRatesForPartner(partnerId);
  const nowMs = Date.parse((deps.now ?? (() => new Date().toISOString()))());
  return ok(200, {
    rates: rates.map((r) => ({
      source_currency: r.sourceCurrency,
      destination_currency: r.destinationCurrency,
      effective_rate: r.effectiveRate ?? null,
      expires_at: r.expiresAt ?? null,
      // Mirrors effectiveRateFor's freshness rule: a pushed rate competes only
      // while its expiry is in the future.
      fresh: r.effectiveRate !== undefined && r.effectiveRate > 0
        && r.expiresAt !== undefined && Date.parse(r.expiresAt) > nowMs,
      margin_bps: r.marginBps ?? null,
    })),
  });
}

// ── Append-only per-partner API audit ─────────────────────────────────────
async function appendAudit(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  keyId: string,
  action: string,
  transferId?: string,
): Promise<void> {
  await createAuditRepo(deps.db).record({
    partnerId,
    actor: keyId,
    actorType: 'api_key',
    action,
    subjectId: transferId,
  });
}
