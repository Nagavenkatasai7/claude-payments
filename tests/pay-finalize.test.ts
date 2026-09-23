import { sql } from 'drizzle-orm';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeDraftPayment } from '@/lib/pay-finalize';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { FX_MAX_AGE_MS, resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { SendBusyError } from '@/lib/send-limits';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

const PHONE = '15551234567';

async function buildStores() {
  const redis = fakeRedis();
  const db = await freshDb(); // truncates + reseeds 'default' partner
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const draftStore = createDraftStore(redis);
  const partnerStore = createPartnerStore(db);
  const monthlyVolumeStore = createMonthlyVolumeStore(store);
  const dailyVolumeStore = createDailyVolumeStore(store);
  return { store, customerStore, draftStore, partnerStore, monthlyVolumeStore, dailyVolumeStore, db };
}

async function makeDraft(
  stores: Awaited<ReturnType<typeof buildStores>>,
  amountUsd: number,
  recipientName = 'Mom',
  payoutDestination: string | undefined = 'mom@upi',
  payoutMethod: 'upi' | 'bank' = 'upi',
) {
  const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
  // Phase 3: these existing-behavior tests exercise the success path, so the
  // sender must be verified (upsertOnFirstInbound defaults to 'not_started').
  await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
  return stores.draftStore.createDraft({
    senderPhone: PHONE,
    partnerId: 'default',
    recipient: {
      name: recipientName,
      recipientPhone: '919876543210',
      payoutMethod,
      payoutDestination,
    },
    amountUsd,
    amountSource: amountUsd,
    sourceCurrency: 'USD',
    fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: amountUsd * 85 },
  });
}

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: 85 } }),
    }),
  );
});

describe('finalizeDraftPayment', { retry: 0 }, () => {
  it('happy path ($200): returns ok:true with a transferId, persists the transfer, consumes the draft, increments transfer count', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);

    const result = await finalizeDraftPayment(stores, draftId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(typeof result.transferId).toBe('string');

    // Transfer persisted and in correct status
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('awaiting_payment');

    // Draft is consumed (single-use)
    const draft = await stores.draftStore.getDraft(draftId);
    expect(draft).toBeNull();

    // Transfer count incremented
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1);
  });

  it('Phase 3: an unverified owner → { ok:false, error:"kyc_required" }, draft NOT consumed, no transfer', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);
    // Gate is partner OPT-IN now — configure it, then make the owner unverified.
    const dflt = await stores.partnerStore.ensureDefaultPartner();
    await stores.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const c = await stores.customerStore.getCustomer('default', PHONE);
    await stores.customerStore.saveCustomer({ ...c!, kycStatus: 'grandfathered' });

    const result = await finalizeDraftPayment(stores, draftId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toBe('kyc_required');
    // Draft preserved (peek-before-consume) and no transfer minted.
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);
  });

  it('unknown/expired draftId → { ok:false, error:"expired_or_used" }', async () => {
    const stores = await buildStores();

    const result = await finalizeDraftPayment(stores, 'nonexistent-draft-id');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toBe('expired_or_used');
  });

  it('over-cap: daily cap exhausted → { ok:false, error:"cap" }, draft NOT consumed', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);

    // Exhaust the T0 daily cap ($500) in the LEDGER (fix 16: no Redis counter).
    await seedLedgerSpend(stores.db, { partnerId: 'default', phone: PHONE, amountUsd: 500 });

    const result = await finalizeDraftPayment(stores, draftId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toBe('cap');

    // Draft must still be there (cap failure must NOT consume it)
    const draft = await stores.draftStore.getDraft(draftId);
    expect(draft).not.toBeNull();
  });

  it('blocked recipient ("John Doe") → { ok:false, error:"blocked", transferId } where transferId is a string', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'John Doe');

    const result = await finalizeDraftPayment(stores, draftId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toBe('blocked');
    expect(typeof result.transferId).toBe('string');
  });

  it('sticky funding: after happy path, customer.lastFundingMethod === "bank_transfer"', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);

    const customer = await stores.customerStore.getCustomer('default', PHONE);
    expect(customer?.lastFundingMethod).toBe('bank_transfer');
  });

  // Item 2: bank details arrive in the pay-page POST body, not the chat. A
  // cold-start draft has an empty payoutDestination; the bankDetails argument
  // supplies it at pay time.
  it('uses bankDetails from the param for the created transfer (cold-start draft has empty destination)', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '', 'bank');

    const result = await finalizeDraftPayment(stores, draftId, {
      payoutMethod: 'bank',
      payoutDestination: '021000021 12345678901',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    // Default reads mask the payout destination ('****8901'); the full value
    // only comes back via the decrypted read.
    const masked = await stores.store.getTransfer(result.transferId);
    expect(masked?.payoutDestination).toBe('****8901');
    const saved = await stores.store.getTransferDecrypted(result.transferId);
    expect(saved?.payoutDestination).toBe('021000021 12345678901');
    expect(saved?.payoutMethod).toBe('bank');
  });

  it('FALLS BACK to draft.recipient.payoutDestination when bankDetails is absent (old in-flight draft)', async () => {
    const stores = await buildStores();
    // Old-style draft that still carries the destination it was created with.
    const draftId = await makeDraft(stores, 200, 'Mom', 'mom@upi', 'upi');

    const result = await finalizeDraftPayment(stores, draftId); // no bankDetails

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransferDecrypted(result.transferId);
    expect(saved?.payoutDestination).toBe('mom@upi');
    expect(saved?.payoutMethod).toBe('upi');
  });

  it('FALLS BACK to the draft destination when bankDetails has an empty payoutDestination', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', 'mom@upi', 'upi');

    const result = await finalizeDraftPayment(stores, draftId, {
      payoutMethod: 'bank',
      payoutDestination: '', // empty body → fall back to the draft's stored value
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransferDecrypted(result.transferId);
    expect(saved?.payoutDestination).toBe('mom@upi');
  });

  // ── Stage 2c: claim-first idempotency ──────────────────────────────────────

  it('REPLAY: re-finalizing after the draft was consumed returns the SAME transfer (crash-safe pay link)', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);

    const first = await finalizeDraftPayment(stores, draftId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unexpected');

    // The draft is consumed — the OLD code would now say expired_or_used and
    // the customer's link would be dead. The claim makes the re-POST converge.
    expect(await stores.draftStore.getDraft(draftId)).toBeNull();
    const second = await finalizeDraftPayment(stores, draftId);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unexpected');
    expect(second.transferId).toBe(first.transferId);

    // No duplicate mint, no double accrual.
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1);
    expect(await stores.dailyVolumeStore.getTodayCents('default', PHONE)).toBe(20_000);
  });

  it('REPLAY preserves blocked semantics: a blocked transfer replays as blocked, same id', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'John Doe');

    const first = await finalizeDraftPayment(stores, draftId);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('unexpected');
    expect(first.error).toBe('blocked');

    const second = await finalizeDraftPayment(stores, draftId);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unexpected');
    expect(second.error).toBe('blocked');
    expect(second.transferId).toBe(first.transferId);
  });

  // ── U7 (audit): honor the DRAFT's quote at pay time ────────────────────────
  // The approval card and the pay page both render from draft.quote; the mint
  // must record those exact figures, not a re-quote from current state.

  it('U7: "first transfer free" survives an interleaved mint — finalized transfer keeps feeUsd 0', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200); // card showed quote.feeUsd 0 (first-transfer-free)

    // An unrelated transfer lands for the same phone between card and pay —
    // the old re-quote (transferCount now 1) would charge the $1.99 repeat fee.
    await createTransfer(stores.store, stores.partnerStore, stores.monthlyVolumeStore, {
      phone: PHONE,
      recipientName: 'Uncle',
      recipientPhone: '919876500000',
      payoutMethod: 'upi',
      payoutDestination: 'uncle@upi',
      fundingMethod: 'bank_transfer',
      amountSource: 50,
      sourceCurrency: 'USD',
      partnerId: 'default',
      senderKycStatus: 'verified',
    });
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1);

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved?.feeUsd).toBe(0);                  // the card's promise…
    expect(saved?.amountUsd).toBe(200);
    expect(saved?.totalChargeUsd).toBe(200);        // …not the re-quoted 201.99
    expect(saved?.totalChargeUsd).toBe(saved?.amountUsd);
  });

  it('U7: FX drift between card and pay — the minted row carries the DRAFT fxRate and amountInr', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200); // card quoted fxRate 85 → ₹17,000

    // Live FX moved to 90 after the card was shown; the draft's rate must win.
    resetRateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 90 } }) }),
    );

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved?.fxRate).toBe(85);
    expect(saved?.amountInr).toBe(17_000);
  });

  it('U7: sanctions still block a watchlisted recipient WITH the draft-quote override', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'John Doe');

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toBe('blocked');
    expect(typeof result.transferId).toBe('string');
    // The blocked row records the draft's quoted figures — proof the override
    // path ran AND screening still blocked on it.
    const saved = await stores.store.getTransfer(result.transferId!);
    expect(saved?.status).toBe('blocked');
    expect(saved?.fxRate).toBe(85);
    expect(saved?.feeUsd).toBe(0);
  });

  it('U7: a legacy non-USD draft missing feeSource/totalChargeSource falls back to the re-quote and mints', async () => {
    const stores = await buildStores();
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });

    // Live GBP rates differ from the draft's stored quote — the re-quote must win
    // (never mix the draft's USD figures with a live source-side recomputation).
    resetRateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.27, INR: 110 } }) }),
    );

    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE,
      partnerId: 'default',
      recipient: {
        name: 'Mom',
        recipientPhone: '919876543210',
        payoutMethod: 'upi',
        payoutDestination: 'mom@upi',
      },
      amountUsd: 254, // USD-equivalent of £200 (cap re-check)
      amountSource: 200,
      sourceCurrency: 'GBP',
      fundingMethod: 'bank_transfer',
      // Legacy in-flight draft (30-min TTL drain): no feeSource/totalChargeSource.
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600 },
    });

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved?.sourceCurrency).toBe('GBP');
    expect(saved?.amountSource).toBe(200);
    // Re-quoted from LIVE rates (110), not the draft's stale 108 — the fallback
    // took today's re-quote path end to end.
    expect(saved?.fxRate).toBe(110);
    expect(saved?.amountInr).toBe(22_000);
    expect(saved?.amountUsd).toBe(254); // 200 × 1.27
  });

  // ── Best-rate routing (B2): the draft's route mints with the draft's rate ──

  it('routing: mints with the draft settlementPartnerId + the WINNING fxRate/amountInr — never surfaced beyond the row', async () => {
    const stores = await buildStores();
    await seedPartner(stores.db, 'rail-partner-x');
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE,
      partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200,
      amountSource: 200,
      sourceCurrency: 'USD',
      fundingMethod: 'bank_transfer',
      // The card quoted the WINNING rate 86 (live mid is 85 via the fetch stub).
      quote: { feeUsd: 0, fxRate: 86, amountInr: 17_200 },
      settlementPartnerId: 'rail-partner-x',
    });

    // An unrelated transfer lands between card and pay — the draft must STILL
    // win on fee AND rate AND route (the intervening-transfer U7 case).
    await createTransfer(stores.store, stores.partnerStore, stores.monthlyVolumeStore, {
      phone: PHONE,
      recipientName: 'Uncle',
      recipientPhone: '919876500000',
      payoutMethod: 'upi',
      payoutDestination: 'uncle@upi',
      fundingMethod: 'bank_transfer',
      amountSource: 50,
      sourceCurrency: 'USD',
      partnerId: 'default',
      senderKycStatus: 'verified',
    });

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved?.settlementPartnerId).toBe('rail-partner-x'); // the winning rail
    expect(saved?.fxRate).toBe(86);                            // at the rate it offered
    expect(saved?.amountInr).toBe(17_200);
    expect(saved?.feeUsd).toBe(0);                             // first-transfer-free promise honored
    expect(saved?.partnerId).toBe('default');                  // ownership unchanged
  });

  it('routing: the legacy non-USD fallback (re-quote at mid) drops BOTH the override AND the route', async () => {
    const stores = await buildStores();
    await seedPartner(stores.db, 'rail-partner-x');
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });

    resetRateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.27, INR: 110 } }) }),
    );

    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE,
      partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 254,
      amountSource: 200,
      sourceCurrency: 'GBP',
      fundingMethod: 'bank_transfer',
      // Legacy in-flight draft: no feeSource/totalChargeSource ⇒ no override —
      // and a routed draft must NEVER mint partner-routed at a platform rate.
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600 },
      settlementPartnerId: 'rail-partner-x',
    });

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved?.fxRate).toBe(110);                       // live re-quote won…
    expect(saved?.settlementPartnerId).toBeUndefined();    // …so the route is dropped with the stale rate
  });

  it('crash BETWEEN claim and mint: the replay completes the original attempt with the claimed id', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);

    // Simulate the crash window: the claim row exists but no transfer was minted.
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    const claimed = await createIdempotencyRepo(stores.db).claim(
      'default', `draft:${draftId}`, 'tr_crashed_attempt',
    );
    expect(claimed).toBe('tr_crashed_attempt');

    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    // The replay mints THE CLAIMED id — not a fresh one.
    expect(result.transferId).toBe('tr_crashed_attempt');
    expect(await stores.store.getTransfer('tr_crashed_attempt')).not.toBeNull();
  });
});

// U1: the pay page is the PRIMARY B2B mint path (the Approve & Pay card opens
// /pay/<draftId>), so finalizeDraftPayment MUST thread the draft's B2B fields.
describe('finalizeDraftPayment — B2B (business-to-business) mint threads business fields', { retry: 0 }, () => {
  it('a B2B draft mints a b2b transfer with discriminators, business names, invoice link (never b2c)', async () => {
    const stores = await buildStores();
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE,
      partnerId: 'default',
      recipient: { name: 'Globex Trading LLC', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 400,                       // within the T0 $500/day cap
      amountSource: 400,
      sourceCurrency: 'USD',
      fundingMethod: 'ach_pull',
      quote: { feeUsd: 1.99, fxRate: 85, amountInr: 34000 },
      // B2B fields the card showed — must survive to the mint.
      transferType: 'b2b',
      senderEntityType: 'business',
      recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd',
      recipientBusinessName: 'Globex Trading LLC',
      invoiceId: 'inv_u1',
    });

    const result = await finalizeDraftPayment(stores, draftId, { payoutMethod: 'bank', payoutDestination: '1234567890 IFSC HDFC0001234' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');

    const saved = await stores.store.getTransferDecrypted(result.transferId);
    expect(saved?.transferType).toBe('b2b');                 // NOT defaulted to b2c
    expect(saved?.senderEntityType).toBe('business');
    expect(saved?.recipientEntityType).toBe('business');
    expect(saved?.senderBusinessName).toBe('Acme Imports Ltd');
    expect(saved?.recipientBusinessName).toBe('Globex Trading LLC');
    expect(saved?.fundingMethod).toBe('ach_pull');
    expect(saved?.invoiceId).toBe('inv_u1');
    expect(saved?.achTokenRef).toBeUndefined();              // bound by the rail at pay/settle, never here
  });

  it('a consumer draft still mints a b2c transfer with no business fields (path unchanged)', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200); // no B2B fields on the draft
    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransfer(result.transferId);
    expect(saved?.transferType).toBe('b2c');
    expect(saved?.senderEntityType).toBe('individual');
    expect(saved?.senderBusinessName).toBeUndefined();
    expect(saved?.invoiceId).toBeUndefined();
  });

  it('mints under the DRAFT tenant, not the default one (fix 1)', async () => {
    const stores = await buildStores();
    await seedPartner(stores.db, 'acme');
    const { customer } = await stores.customerStore.upsertOnFirstInbound('acme', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'acme',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    });
    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await stores.store.getTransfer(result.transferId))!.partnerId).toBe('acme');
    expect(await stores.store.listRecipients('acme', PHONE, 5)).toHaveLength(1);
    expect(await stores.store.listRecipients('default', PHONE, 5)).toEqual([]);
    expect((await stores.customerStore.getCustomer('acme', PHONE))!.lastFundingMethod).toBe('bank_transfer');
  });

  it('a PRE-DEPLOY draft (no partnerId) finalizes under the phone\'s pre-fix tenant and never creates a stray default row (review item 2)', async () => {
    const stores = await buildStores();
    await seedPartner(stores.db, 'acme');
    const { customer } = await stores.customerStore.upsertOnFirstInbound('acme', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    // Simulate an in-flight legacy draft: written before fix 1, so no partnerId.
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'acme',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    });
    const legacy = { ...(await stores.draftStore.getDraft(draftId))! };
    delete legacy.partnerId;
    await stores.draftStore.restoreDraft(legacy, draftId);
    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await stores.store.getTransfer(result.transferId))!.partnerId).toBe('acme');
    expect(await stores.customerStore.getCustomer('default', PHONE)).toBeNull();
  });
});

describe('finalizeDraftPayment — FX gate (Task 9): refuses BEFORE the claim, never burns the draft', { retry: 0 }, () => {
  // Ruling 7 pre-claim order: kyc → masked destination (fix 6) → FX (this) → cap (fix 10) → idem.claim.
  async function verifiedSender(stores: Awaited<ReturnType<typeof buildStores>>) {
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
  }

  it('a stored quote whose rate is older than the ceiling → fx_unavailable; no FX dial, draft kept, key unclaimed, nothing minted', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17_000, fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1 },
    });

    // quoteExpired: the route answers the EXPIRED-quote message (a retry can never succeed).
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'fx_unavailable', quoteExpired: true });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled(); // honored-verbatim path never re-quotes
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    expect(await createIdempotencyRepo(stores.db).find('default', `draft:${draftId}`)).toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);
  });

  it('a crash-replay of an ALREADY-MINTED draft replays its transfer — the FX gate never refuses a minted draft', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17_000, fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1 },
    });
    // The crash window: a prior attempt claimed the key and MINTED (while the
    // rate was still fresh), then died before consumeDraft — the draft is still
    // live and its quote has since aged past the ceiling.
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    await createIdempotencyRepo(stores.db).claim('default', `draft:${draftId}`, 'tr_minted');
    await createTransfer(stores.store, stores.partnerStore, stores.monthlyVolumeStore, {
      id: 'tr_minted', phone: PHONE, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
      amountSource: 200, sourceCurrency: 'USD', partnerId: 'default', senderKycStatus: 'verified',
      quote: {
        amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
        amountSource: 200, feeSource: 0, totalChargeSource: 200,
      },
    });

    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: true, transferId: 'tr_minted' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1); // replayed, never re-minted
  });

  it('a fresh stored quote (fxFetchedAt inside the ceiling) mints verbatim', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 95.82, amountInr: 19_164, fxFetchedAt: Date.now() - 10 * 60_000 },
    });
    const result = await finalizeDraftPayment(stores, draftId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await stores.store.getTransfer(result.transferId))?.fxRate).toBe(95.82);
  });

  it('a legacy draft that must re-quote while Frankfurter is down → fx_unavailable; the SAME link mints once FX is back', async () => {
    const stores = await buildStores();
    await verifiedSender(stores);
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 254, amountSource: 200, sourceCurrency: 'GBP', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600 }, // no feeSource/totalChargeSource ⇒ re-quote path
    });
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));

    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'fx_unavailable' });
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);

    // Provider recovers: the single-use key was never burned, so the same link completes.
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.3395, INR: 128.35 } }) }));
    expect((await finalizeDraftPayment(stores, draftId)).ok).toBe(true);
  });
});

describe('finalizeDraftPayment — FX refused AFTER the claim (Task 9 review): mapped, never a thrown 400', { retry: 0 }, () => {
  it('a legacy re-quote whose live rate becomes unavailable between the gate and the mint → fx_unavailable; the claimed id stays unminted and a retry mints THAT id', async () => {
    const stores = await buildStores();
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 254, amountSource: 200, sourceCurrency: 'GBP', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 1.99, fxRate: 108, amountInr: 21_600 }, // no feeSource/totalChargeSource ⇒ re-quote at mint
    });
    const fxUp = () =>
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.3395, INR: 128.35 } }) }));
    resetRateCacheForTests();
    fxUp(); // the pre-claim gate sees a live rate
    // createTransfer's legacy branch reads getTransferCount right before its
    // getFxRates — AFTER idem.claim. Take FX down at exactly that point.
    vi.spyOn(stores.store, 'getTransferCount').mockImplementationOnce(async () => {
      resetRateCacheForTests();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
      return 0;
    });

    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'fx_unavailable' });
    const { createIdempotencyRepo } = await import('@/db/repos/aux-repos');
    const claimedId = await createIdempotencyRepo(stores.db).find('default', `draft:${draftId}`);
    expect(claimedId).not.toBeNull(); // bound…
    expect(await stores.store.getTransfer(claimedId as string)).toBeNull(); // …but never minted
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull(); // not consumed

    // FX recovers: the same link mints the SAME claimed id (the crash-replay shape).
    resetRateCacheForTests();
    fxUp();
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: true, transferId: claimedId });
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1);
  });
});

describe('fix 6 (ctx-01): the payout destination is settled BEFORE idem.claim — a refusal burns nothing', { retry: 0 }, () => {
  const claimFor = (stores: Awaited<ReturnType<typeof buildStores>>, draftId: string) =>
    createIdempotencyRepo(stores.db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);

  async function verifiedDraft(
    stores: Awaited<ReturnType<typeof buildStores>>,
    over: Record<string, unknown>,
  ): Promise<string> {
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    return stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
      ...over,
    } as Parameters<typeof stores.draftStore.createDraft>[0]);
  }
  const b2bAchDraft = {
    recipient: { name: 'Globex Trading LLC', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
    amountUsd: 400, amountSource: 400, fundingMethod: 'ach_pull',
    quote: { feeUsd: 1.99, fxRate: 85, amountInr: 34000 },
    transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
    senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC', invoiceId: 'inv_u1',
  };

  it('a masked stored destination + a bodyless POST → bank_details_required: nothing minted, key NOT claimed, draft NOT consumed, no accrual', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '****9012', 'bank');
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'bank_details_required' });
    expect(await stores.store.listTransfers()).toHaveLength(0);
    expect(await claimFor(stores, draftId)).toBeNull();
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.dailyVolumeStore.getTodayCents('default', PHONE)).toBe(0);
  });

  it('the SAME link then finalizes with real bank details — the claim binds only now; ledger and address book hold the real account', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '****9012', 'bank');
    await finalizeDraftPayment(stores, draftId);
    const result = await finalizeDraftPayment(stores, draftId, {
      payoutMethod: 'bank', payoutDestination: '021000021 12345678901',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(await claimFor(stores, draftId)).toBe(result.transferId);
    expect((await stores.store.getTransferDecrypted(result.transferId))?.payoutDestination).toBe('021000021 12345678901');
    expect(await stores.draftStore.getDraft(draftId)).toBeNull();
    const [rec] = await stores.store.listRecipients('default', PHONE, 1);
    expect(rec.payoutDestination).toBe('021000021 12345678901');
  });

  it("BEHAVIOUR CHANGE: a consumer cold-start draft ('' destination) with a bodyless POST is refused", async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '', 'bank');
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'bank_details_required' });
    expect(await claimFor(stores, draftId)).toBeNull();
  });

  it('a masked value in the BODY is refused too (defence in depth)', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);
    expect(await finalizeDraftPayment(stores, draftId, { payoutMethod: 'bank', payoutDestination: '****9012' }))
      .toEqual({ ok: false, error: 'bank_details_required' });
    expect(await claimFor(stores, draftId)).toBeNull();
  });

  it("the '' exemption keys on the DRAFT'S shape: a CONSUMER draft carrying a partner-pulled method is dead (expired_or_used) even with a body; a B2B bank_pull draft is refused", async () => {
    for (const fundingMethod of ['bank_pull', 'ach_pull']) {
      const stores = await buildStores();
      const draftId = await verifiedDraft(stores, { fundingMethod });
      expect(await finalizeDraftPayment(stores, draftId, { payoutMethod: 'bank', payoutDestination: '021000021 12345678901' }), fundingMethod)
        .toEqual({ ok: false, error: 'expired_or_used' });
      expect(await claimFor(stores, draftId)).toBeNull();
      expect(await stores.store.listTransfers()).toHaveLength(0);
    }
    const stores = await buildStores();
    const draftId = await verifiedDraft(stores, { ...b2bAchDraft, fundingMethod: 'bank_pull' });
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'bank_details_required' });
  });

  it("a B2B ach_pull draft mints with NO destination, and a body NEVER sets its payee (the payee is never payer input)", async () => {
    // Separate stores per mint: two $400 bills in one day would trip the T0 $500 cap.
    const s1 = await buildStores();
    const plain = await verifiedDraft(s1, b2bAchDraft);
    const r1 = await finalizeDraftPayment(s1, plain);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unexpected');
    expect((await s1.store.getTransferDecrypted(r1.transferId))?.payoutDestination).toBe('');
    const s2 = await buildStores();
    const crafted = await verifiedDraft(s2, b2bAchDraft);
    const r2 = await finalizeDraftPayment(s2, crafted, { payoutMethod: 'bank', payoutDestination: '999999999999 SBIN0009999' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unexpected');
    expect((await s2.store.getTransferDecrypted(r2.transferId))?.payoutDestination).toBe('');
  });

  it('guard order (ruling 7): an unverified sender with a masked draft gets kyc_required — the kyc gate runs first', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200, 'Mom', '****9012', 'bank');
    const dflt = await stores.partnerStore.ensureDefaultPartner();
    await stores.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const c = await stores.customerStore.getCustomer('default', PHONE);
    await stores.customerStore.saveCustomer({ ...c!, kycStatus: 'grandfathered' });
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'kyc_required' });
    expect(await claimFor(stores, draftId)).toBeNull();
  });
});

// ── Program fix 16 (Task 10, tests 15 + 16): ruling-7 guard order and the replay skip ──
describe('finalizeDraftPayment — cap from the ledger (Program fix 16)', { retry: 0 }, () => {
  async function untouched(stores: Awaited<ReturnType<typeof buildStores>>, draftId: string) {
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await createIdempotencyRepo(stores.db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`)).toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1); // the seeded row only
  }
  const staleQuote = () => ({ feeUsd: 0, fxRate: 85, amountInr: 17_000, fxFetchedAt: Date.now() - FX_MAX_AGE_MS - 1 });
  async function draftWith(stores: Awaited<ReturnType<typeof buildStores>>, over: { payoutDestination?: string; stale?: boolean }) {
    const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
    return stores.draftStore.createDraft({
      senderPhone: PHONE, partnerId: 'default',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: over.payoutDestination ?? 'mom@upi' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
      quote: over.stale ? staleQuote() : { feeUsd: 0, fxRate: 85, amountInr: 17_000 },
    });
  }

  it('test 15: masked + stale FX + over cap ⇒ bank_details_required; stale FX + over cap ⇒ fx_unavailable; over cap alone ⇒ cap — each leaves the draft and its key untouched', async () => {
    const stores = await buildStores();
    await seedLedgerSpend(stores.db, { partnerId: 'default', phone: PHONE, amountUsd: 500 }); // T0 cap exhausted
    const a = await draftWith(stores, { payoutDestination: '****9012', stale: true });
    expect(await finalizeDraftPayment(stores, a)).toEqual({ ok: false, error: 'bank_details_required' });
    await untouched(stores, a);
    const b = await draftWith(stores, { stale: true });
    expect(await finalizeDraftPayment(stores, b)).toEqual({ ok: false, error: 'fx_unavailable', quoteExpired: true });
    await untouched(stores, b);
    const c = await draftWith(stores, {});
    expect(await finalizeDraftPayment(stores, c)).toEqual({ ok: false, error: 'cap' });
    await untouched(stores, c);
  });

  it('the cap uses the tenant\'s RESOLVED limits: a $100 per-transfer tenant refuses a $200 draft', async () => {
    const stores = await buildStores();
    await stores.db.execute(sql`UPDATE partners SET send_limits = '{"perTransferCapCents":10000}'::jsonb WHERE id = 'default'`);
    const d = await draftWith(stores, {});
    expect(await finalizeDraftPayment(stores, d)).toEqual({ ok: false, error: 'cap' });
    expect(await stores.draftStore.getDraft(d)).not.toBeNull();
  });

  it('test 16: a minted draft whose own amount fills the cap, POSTed again (crash before consume), replays { ok:true } with the same id — never re-capped', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 500); // exactly the T0 day
    vi.spyOn(stores.draftStore, 'consumeDraft').mockResolvedValueOnce(null); // simulate: died after the mint, before consume
    const first = await finalizeDraftPayment(stores, draftId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unexpected');
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull(); // still there, as after a crash
    expect(await stores.dailyVolumeStore.getTodayCents('default', PHONE)).toBe(50_000);
    const again = await finalizeDraftPayment(stores, draftId);
    expect(again).toEqual({ ok: true, transferId: first.transferId });
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1);
    // (The claim's replay branch returns before consumeDraft — pre-existing
    // behavior; the un-consumed draft expires by TTL and can only ever replay.)
  });

  it('a busy sender lock ⇒ { ok:false, error:"busy" }; the draft and the bound id survive and the retry mints that id', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);
    vi.spyOn(stores.store, 'mintUnderSenderLock').mockRejectedValueOnce(new SendBusyError());
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'busy' });
    const bound = await createIdempotencyRepo(stores.db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);
    expect(bound).not.toBeNull();
    expect(await stores.store.getTransfer(bound!)).toBeNull();
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    const r = await finalizeDraftPayment(stores, draftId);
    expect(r).toEqual({ ok: true, transferId: bound });
  });

  it('a race that consumed the headroom between the pre-claim check and the lock ⇒ cap (the lock is authoritative)', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);
    await seedLedgerSpend(stores.db, { partnerId: 'default', phone: PHONE, amountUsd: 400 });
    vi.spyOn(stores.dailyVolumeStore, 'getTodayCents').mockResolvedValueOnce(0); // stale pre-check
    expect(await finalizeDraftPayment(stores, draftId)).toEqual({ ok: false, error: 'cap' });
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(1);
  });
});
