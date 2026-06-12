import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeDraftPayment } from '@/lib/pay-finalize';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

const PHONE = '15551234567';

async function buildStores() {
  const redis = fakeRedis();
  const db = await freshDb(); // truncates + reseeds 'default' partner
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const draftStore = createDraftStore(redis);
  const partnerStore = createPartnerStore(db);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  return { store, customerStore, draftStore, partnerStore, monthlyVolumeStore, dailyVolumeStore, db };
}

async function makeDraft(
  stores: Awaited<ReturnType<typeof buildStores>>,
  amountUsd: number,
  recipientName = 'Mom',
  payoutDestination: string | undefined = 'mom@upi',
  payoutMethod: 'upi' | 'bank' = 'upi',
) {
  const { customer } = await stores.customerStore.upsertOnFirstInbound(PHONE);
  // Phase 3: these existing-behavior tests exercise the success path, so the
  // sender must be verified (upsertOnFirstInbound defaults to 'not_started').
  await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified' });
  return stores.draftStore.createDraft({
    senderPhone: PHONE,
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

describe('finalizeDraftPayment', () => {
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
    expect(await stores.store.getTransferCount(PHONE)).toBe(1);
  });

  it('Phase 3: an unverified owner → { ok:false, error:"kyc_required" }, draft NOT consumed, no transfer', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, 200);
    // Gate is partner OPT-IN now — configure it, then make the owner unverified.
    const dflt = await stores.partnerStore.ensureDefaultPartner();
    await stores.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: new Date().toISOString() });
    const c = await stores.customerStore.getCustomer(PHONE);
    await stores.customerStore.saveCustomer({ ...c!, kycStatus: 'grandfathered' });

    const result = await finalizeDraftPayment(stores, draftId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toBe('kyc_required');
    // Draft preserved (peek-before-consume) and no transfer minted.
    expect(await stores.draftStore.getDraft(draftId)).not.toBeNull();
    expect(await stores.store.getTransferCount(PHONE)).toBe(0);
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

    // Exhaust the T0 daily cap ($500 = 50_000 cents)
    await stores.dailyVolumeStore.addCents(PHONE, 50_000);

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

    const customer = await stores.customerStore.getCustomer(PHONE);
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
    expect(await stores.store.getTransferCount(PHONE)).toBe(1);
    expect(await stores.dailyVolumeStore.getTodayCents(PHONE)).toBe(20_000);
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
    expect(await stores.store.getTransferCount(PHONE)).toBe(1);

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
    const { customer } = await stores.customerStore.upsertOnFirstInbound(PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified' });

    // Live GBP rates differ from the draft's stored quote — the re-quote must win
    // (never mix the draft's USD figures with a live source-side recomputation).
    resetRateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.27, INR: 110 } }) }),
    );

    const draftId = await stores.draftStore.createDraft({
      senderPhone: PHONE,
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
