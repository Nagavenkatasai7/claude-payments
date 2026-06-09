import type { Store, RedisLike } from './store';
import type { PartnerStore } from './partner-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type {
  CountryCode, CurrencyCode, KycStatus, Partner, PartnerId, PayoutMethod, Transfer,
} from './types';
import { getFxRates } from './rate';
import { quote, QuoteError } from './fx';
import { validatePayoutFields } from './payout-format';
import { allowedSendCurrencies, resolveSendCurrency, countryForCurrency } from './partner-currency';
import { createTransfer } from './transfer-create';
import { sendGateActive } from './kyc-gate';
import { getPaymentProvider } from './providers/payment-provider';
import { resolvePartnerBranding } from './partner-config';
import { newTransferId } from './id';

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
  redis: RedisLike;
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

// Public transfer view — never leaks internal-only fields.
function transferView(t: Transfer) {
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
    recipient_name: t.recipientName,
    created_at: t.createdAt,
    partner_id: t.partnerId,
  };
}

// ── GET /corridors ────────────────────────────────────────────────────────
export function listCorridors(partner: Partner) {
  const currencies = allowedSendCurrencies(partner);
  return {
    brand: resolvePartnerBranding(partner).brand,
    corridors: currencies.map((c) => ({
      source_country: countryForCurrency(c),
      source_currency: c,
      destination_country: 'IN' as CountryCode,
      destination_currency: 'INR' as CurrencyCode,
    })),
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
  const sourceCurrency = resolveSendCurrency(partner, str(body.source_currency) || undefined);
  const destinationCurrency = (str(body.destination_currency) || 'INR') as CurrencyCode;
  try {
    const rates = await getFxRates(sourceCurrency);
    const destRates = await getFxRates(destinationCurrency);
    // transferCount drives the fee tier; a partner-API quote uses standard pricing.
    const q = quote(amount, sourceCurrency, rates, 'bank_transfer', 1, destinationCurrency, destRates.toUsd);
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
interface StoredBeneficiary {
  id: string;
  partnerId: PartnerId;
  name: string;
  country: CountryCode;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  recipientPhone?: string;
  createdAt: string;
}

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
  const ben: StoredBeneficiary = {
    id, partnerId, name, country,
    payoutMethod: (str(body.payout_method) as PayoutMethod) || 'bank',
    payoutDestination: validation.payoutDestination,
    recipientPhone: str(body.recipient_phone) || undefined,
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
  await deps.redis.set(`partner:${partnerId}:ben:${id}`, JSON.stringify(ben));
  await deps.redis.sadd(`partner:${partnerId}:bens`, id);
  return ok(201, { id, name, country, payout_destination: ben.payoutDestination });
}

async function getStoredBeneficiary(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  id: string,
): Promise<StoredBeneficiary | null> {
  const raw = await deps.redis.get(`partner:${partnerId}:ben:${id}`);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as StoredBeneficiary;
    // Defense-in-depth: the key is already partner-scoped, but re-check.
    return b.partnerId === partnerId ? b : null;
  } catch {
    return null;
  }
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

  const idemKey = `idem:${partner.id}:${idempotencyKey}`;
  const existing = await deps.redis.get(idemKey);
  if (existing) {
    const t = await deps.store.getTransfer(existing);
    if (t && t.partnerId === partner.id) return ok(200, transferView(t)); // replay
  }

  const amount = num(body.amount_source ?? body.amount);
  if (amount === null || amount <= 0) return err(400, 'amount_source must be a positive number.');

  const sender = (body.sender && typeof body.sender === 'object' ? body.sender : {}) as Record<string, unknown>;
  const senderPhone = str(sender.phone);
  if (!senderPhone) return err(400, 'sender.phone is required.');

  // Beneficiary: by reference (partner-scoped) or inline.
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

  const sourceCurrency = resolveSendCurrency(partner, str(body.source_currency) || undefined);
  const requiresKyc = sendGateActive(partner); // 'delegated' ⇒ false; sanctions still run
  const senderKycStatus = (str(sender.kyc_status) || 'not_started') as KycStatus;

  let transfer: Transfer;
  try {
    transfer = await createTransfer(deps.store, deps.partnerStore, deps.monthlyVolumeStore, {
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
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    });
  } catch (e) {
    if (e instanceof QuoteError) return err(400, e.message);
    if (e instanceof Error && e.message === 'kyc_required') {
      return err(422, 'Sender identity verification required (this partner runs SmartRemit KYC).');
    }
    throw e;
  }

  // Bind the idempotency key → transfer id (replay returns the same transfer).
  await deps.redis.set(idemKey, transfer.id);
  await appendAudit(deps, partner.id, keyId, 'transaction.create', transfer.id);
  // A sanctions block is surfaced as 422 (the row exists, status 'blocked').
  if (transfer.complianceStatus === 'blocked') {
    return err(422, 'This transfer was blocked by compliance screening.');
  }
  return ok(201, transferView(transfer));
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
  return ok(200, transferView(t));
}

// ── POST /transactions/:id/confirm (ownership-scoped) ─────────────────────
export async function confirmTransaction(
  deps: PartnerApiDeps,
  partner: Partner,
  keyId: string,
  id: string,
): Promise<SvcResult<unknown>> {
  const t = await deps.store.getTransfer(id);
  if (!t || t.partnerId !== partner.id) return err(404, 'Transaction not found.');
  if (t.complianceStatus === 'blocked' || t.status === 'blocked') return err(422, 'This transfer was blocked by compliance screening.');
  if (t.status === 'paid' || t.status === 'delivered') return ok(200, transferView(t)); // already confirmed
  if (t.status !== 'awaiting_payment') return err(409, `Cannot confirm a transfer in status ${t.status}.`);

  const initiate = deps.initiatePayment ?? (async (tr: Transfer) => {
    const brand = resolvePartnerBranding(partner).brand;
    await getPaymentProvider(deps.store, undefined, brand).initiateTransfer(tr);
  });
  await initiate(t);
  await appendAudit(deps, partner.id, keyId, 'transaction.confirm', t.id);
  const after = await deps.store.getTransfer(id);
  return ok(200, transferView(after ?? t));
}

// ── Append-only per-partner API audit ─────────────────────────────────────
async function appendAudit(
  deps: PartnerApiDeps,
  partnerId: PartnerId,
  keyId: string,
  action: string,
  transferId?: string,
): Promise<void> {
  const key = `partner:${partnerId}:apiaudit`;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const raw = await deps.redis.get(key);
  const list: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : [];
  list.unshift({ at, keyId, action, transferId });
  await deps.redis.set(key, JSON.stringify(list.slice(0, 500)));
}
