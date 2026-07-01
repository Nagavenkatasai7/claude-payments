import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  executeTool,
  toolSchemas,
  toolSchemasForChannel,
  WEB_TOOL_ALLOWLIST,
  WEB_ONLY_TOOLS,
  buildApproveSummary,
  maskAccount,
} from '@/lib/tools';
import type { CurrencyCode, Quote } from '@/lib/types';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import { selectSettlementRoute } from '@/lib/partner-rates';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { PartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Db } from '@/db/client';

const PHONE = '15551234567';
const MOCK_RATE = 85.0;

// Partner store is pg-backed (Stage 2a cutover): freshDb() truncates the shared
// PGlite and reseeds the 'default' partner, so it runs per-test in beforeEach.
let db: Db;

async function buildCtx(redis: ReturnType<typeof fakeRedis>, phone: string = PHONE) {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
  // Phase 3: the verify-before-send gate blocks any non-'verified' sender. These
  // existing-behavior tests exercise the send path, so seed the default customer
  // as verified up front (still T0 within the 3-day window → cap behavior intact).
  // Customers live in Postgres now, so the seed is an awaited saveCustomer;
  // tests that want a different status saveCustomer() over it afterward.
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  return {
    phone,
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore,
    monthlyVolumeStore,
    kycProvider,
    partnerStore: createPartnerStore(db), // pg-backed (Stage 2a cutover)
    // Refund seam: the guarded refund-lifecycle writer, bound to the PGlite db
    // (the prod fallback would build one over getDb()'s Neon Pool).
    transferRepo: createTransferRepo(db),
    // Recall-dispute seam: the support-ticket repo, bound to the PGlite db.
    ticketRepo: createTicketRepo(db),
    // Triage-enqueue seam: the outbox repo open_recall_dispute queues the
    // out-of-band 'ticket.triage' effect on, bound to the PGlite db (the prod
    // fallback would build one over getDb()'s Neon Pool).
    outboxRepo: createOutboxRepo(db),
  };
}

function stubFetch(rate: number = MOCK_RATE) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: rate } }),
    }),
  );
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request_refund (customer-facing refund request — suggest-only, ops approves)', () => {
  type Ctx = Awaited<ReturnType<typeof buildCtx>>;

  // Mint an awaiting_payment transfer owned by ctx.phone via the real tool path.
  async function mintTransfer(ctx: Ctx): Promise<string> {
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  async function mintPaid(ctx: Ctx): Promise<string> {
    const id = await mintTransfer(ctx);
    expect(await ctx.store.updateTransferFromWebhook(id, 'paid')).not.toBeNull();
    return id;
  }

  // Force a status the webhook machine can't reach (cancelled/blocked/in_review).
  async function forceStatus(ctx: Ctx, id: string, status: 'cancelled' | 'blocked' | 'in_review') {
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({ ...t, status });
  }

  // The tool's entire customer-safe surface: ONLY these keys may ever leave it,
  // and no internal token may ride along in any value.
  function expectCustomerSafe(result: Record<string, unknown>) {
    // transfer_id is the customer's OWN id (no PII) — safe to surface so the bot
    // can name the specific transfer. opened/case_id belong to open_recall_dispute.
    const allowed = new Set([
      'error', 'error_code', 'message', 'requested', 'reply_hint',
      'transfer_id', 'opened', 'case_id',
    ]);
    for (const k of Object.keys(result)) {
      expect(allowed.has(k), `unexpected key leaked from request_refund: ${k}`).toBe(true);
    }
    const json = JSON.stringify(result).toLowerCase();
    expect(json).not.toContain('settlementpartner');
    expect(json).not.toContain('compliance');
    expect(json).not.toContain('refundstatus');
  }

  it('STRICT ownership: an unknown transfer id reads as not found', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('request_refund', { transfer_id: 'tr_nope' }, ctx);
    expect(r).toEqual({ error: 'Transfer not found.' });
    expectCustomerSafe(r);
  });

  it("STRICT ownership: another customer's PAID transfer is indistinguishable from a missing one (404-never-403)", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintPaid(owner);
    const stranger = await buildCtx(redis, '15559990000');
    const r = await executeTool('request_refund', { transfer_id: id }, stranger);
    expect(r).toEqual({ error: 'Transfer not found.' });
    expectCustomerSafe(r);
    // And the ledger was not touched.
    expect((await owner.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('awaiting_payment: nothing to refund — just do not pay / cancel; no flag is set', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('not_paid_yet');
    expect(String(r.message).toLowerCase()).toContain('cancel');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('delivered within 24h ⇒ use_recall (route to open_recall_dispute), never a refund flag', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    // updateTransferFromWebhook stamps deliveredAt = now() ⇒ inside the 24h window.
    await ctx.store.updateTransferFromWebhook(id, 'delivered');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('use_recall');
    expect(r.transfer_id).toBe(id);
    expect(String(r.reply_hint).toLowerCase()).toContain('recall');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('delivered over 24h ago ⇒ recall_window_passed, never a refund flag', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await ctx.store.updateTransferFromWebhook(id, 'delivered');
    // Backdate deliveredAt past the 24h recall window.
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({
      ...t,
      deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('recall_window_passed');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('paid + no refund: SUCCESS — flips refundStatus to requested (guarded repo transition) and hints 3-5 business days', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.requested).toBe(true);
    expect(r.transfer_id).toBe(id);
    expect(String(r.reply_hint)).toContain('3-5 business days once approved');
    expectCustomerSafe(r);
    const after = await ctx.store.getTransfer(id);
    expect(after?.refundStatus).toBe('requested');
    expect(after?.status).toBe('paid'); // the forward-only status machine is untouched
  });

  it('a second request is a no-op: "already being reviewed", state unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await executeTool('request_refund', { transfer_id: id }, ctx);
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.requested).toBeUndefined();
    expect(r.error_code).toBe('already_requested');
    expect(String(r.message).toLowerCase()).toContain('already being reviewed');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus).toBe('requested');
  });

  it('refund pending (ops approved): explains it is on the way — 3-5 business days', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('refund_in_progress');
    expect(String(r.message)).toContain('3-5 business days');
    expectCustomerSafe(r);
  });

  it('refund completed: already refunded to the original payment method', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'completed' });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('already_refunded');
    expect(String(r.message).toLowerCase()).toContain('original payment method');
    expectCustomerSafe(r);
  });

  it("refund failed is OPS-INTERNAL: the customer hears 'being reviewed', never the word failed", async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'failed' });
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    // 'failed' maps to the in_progress disposition — the customer hears the team
    // is on it, never the word failed.
    expect(r.error_code).toBe('refund_in_progress');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('fail');
    expectCustomerSafe(r);
  });

  it('cancelled with a refund already moving: explains the current refund state', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    await ctx.transferRepo.updateRefund(id, { refundStatus: 'pending' });
    await forceStatus(ctx, id, 'cancelled');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('refund_in_progress');
    expectCustomerSafe(r);
  });

  it('cancelled with no refund in motion: points to help, sets no flag', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await forceStatus(ctx, id, 'cancelled');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('cancelled');
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(id))?.refundStatus ?? 'none').toBe('none');
  });

  it('blocked: never charged ⇒ nothing to refund (no screening detail beyond the receipt wording)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await forceStatus(ctx, id, 'blocked');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('never_charged');
    expect(String(r.message).toLowerCase()).toContain('not charged');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('blocked');
    expectCustomerSafe(r);
  });

  it('in_review: not refundable yet — the established "under review" wording only', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await forceStatus(ctx, id, 'in_review');
    const r = await executeTool('request_refund', { transfer_id: id }, ctx);
    expect(r.error_code).toBe('under_review');
    expect(String(r.message).toLowerCase()).toContain('under review');
    expectCustomerSafe(r);
  });

  // ── transfer_id OMITTED: resolve from the customer's own recent transfers ──

  // Mint a small ($100) transfer so two fit inside the T0 daily cap ($500/day).
  async function mintSmall(ctx: Ctx): Promise<string> {
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 100,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  it('no transfer_id: resolves the latest REFUNDABLE (paid) transfer and flags it', async () => {
    const ctx = await buildCtx(fakeRedis());
    // An older delivered (window-passed) transfer + a newer paid one. With no id,
    // request_refund must prefer the refundable (paid) one even though it is not
    // the absolute newest by createdAt. ($100 each keeps both within the cap.)
    const deliveredId = await mintSmall(ctx);
    await ctx.store.updateTransferFromWebhook(deliveredId, 'delivered');
    const t = (await ctx.store.getTransfer(deliveredId))!;
    await ctx.store.saveTransfer({
      ...t,
      deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // window passed
    });
    const paidId = await mintSmall(ctx);
    expect(await ctx.store.updateTransferFromWebhook(paidId, 'paid')).not.toBeNull();

    const r = await executeTool('request_refund', {}, ctx);
    expect(r.requested).toBe(true);
    expect(r.transfer_id).toBe(paidId);
    expectCustomerSafe(r);
    expect((await ctx.store.getTransfer(paidId))?.refundStatus).toBe('requested');
    // The window-passed delivered one was untouched.
    expect((await ctx.store.getTransfer(deliveredId))?.refundStatus ?? 'none').toBe('none');
  });

  it("a '#'-prefixed id (as rendered in the [RECENT TRANSFERS] note) still resolves", async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintPaid(ctx);
    // The note renders ids as "#<id>"; the model may copy that verbatim.
    const r = await executeTool('request_refund', { transfer_id: `#${id}` }, ctx);
    expect(r.requested).toBe(true);
    expect(r.transfer_id).toBe(id); // resolved despite the leading '#'
    expect((await ctx.store.getTransfer(id))?.refundStatus).toBe('requested');
  });

  it('no transfer_id and no transfers at all ⇒ no_transfer_found (nothing flagged)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('request_refund', {}, ctx);
    expect(r.error_code).toBe('no_transfer_found');
    expectCustomerSafe(r);
  });

  it('no transfer_id: latest is delivered-within-window ⇒ use_recall', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintTransfer(ctx);
    await ctx.store.updateTransferFromWebhook(id, 'delivered'); // deliveredAt = now()
    const r = await executeTool('request_refund', {}, ctx);
    expect(r.error_code).toBe('use_recall');
    expect(r.transfer_id).toBe(id);
    expectCustomerSafe(r);
  });
});

describe('open_recall_dispute (delivered-within-24h recall/dispute case)', () => {
  type Ctx = Awaited<ReturnType<typeof buildCtx>>;

  async function mintDelivered(ctx: Ctx): Promise<string> {
    const created = await executeTool(
      'create_transfer',
      {
        amount_usd: 500,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@upi',
        funding_method: 'bank_transfer',
      },
      ctx,
    );
    const id = created.transfer_id as string;
    await ctx.store.updateTransferFromWebhook(id, 'paid');
    await ctx.store.updateTransferFromWebhook(id, 'delivered'); // deliveredAt = now()
    return id;
  }

  it('delivered within 24h ⇒ opens a customer ticket (category refund) and returns opened:true', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_recipient' }, ctx);
    expect(r.opened).toBe(true);
    expect(typeof r.case_id).toBe('string');
    expect(String(r.case_id)).toMatch(/^tk_/);
    expect(String(r.reply_hint).toLowerCase()).toContain('recovery is not guaranteed');

    // Assert the ticket landed via the repo: customer-scoped, linked + categorized.
    const repo = createTicketRepo(db);
    const mine = await repo.listByCustomer(ctx.phone);
    const ticket = mine.find((t) => t.id === r.case_id)!;
    expect(ticket).toBeTruthy();
    expect(ticket.kind).toBe('customer');
    expect(ticket.transferId).toBe(id);
    expect(ticket.category).toBe('refund');
    expect(ticket.subject.toLowerCase()).toContain('recall');
  });

  it('no transfer_id: resolves the latest delivered-within-window transfer', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { reason: 'not_received' }, ctx);
    expect(r.opened).toBe(true);
    const repo = createTicketRepo(db);
    const ticket = (await repo.listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
    expect(ticket.transferId).toBe(id);
  });

  it("a '#'-prefixed id (from the note) resolves and opens the case", async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { transfer_id: `#${id}`, reason: 'wrong_amount' }, ctx);
    expect(r.opened).toBe(true);
    const repo = createTicketRepo(db);
    const ticket = (await repo.listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
    expect(ticket.transferId).toBe(id);
  });

  it('delivered over 24h ago ⇒ recall_window_passed, NO ticket opened', async () => {
    const ctx = await buildCtx(fakeRedis());
    const id = await mintDelivered(ctx);
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({
      ...t,
      deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'wrong_amount' }, ctx);
    expect(r.error_code).toBe('recall_window_passed');
    expect(r.opened).toBeUndefined();
    const repo = createTicketRepo(db);
    expect(await repo.listByCustomer(ctx.phone)).toHaveLength(0);
  });

  it('a still-refundable (paid, not delivered) transfer ⇒ use_request_refund, no ticket', async () => {
    const ctx = await buildCtx(fakeRedis());
    const created = await executeTool(
      'create_transfer',
      { amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    const id = created.transfer_id as string;
    await ctx.store.updateTransferFromWebhook(id, 'paid');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.error_code).toBe('use_request_refund');
    expect(r.transfer_id).toBe(id);
    const repo = createTicketRepo(db);
    expect(await repo.listByCustomer(ctx.phone)).toHaveLength(0);
  });

  it("STRICT ownership: another customer's delivered transfer reads as not found", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintDelivered(owner);
    const stranger = await buildCtx(redis, '15559990000');
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'unauthorized' }, stranger);
    expect(r).toEqual({ error: 'Transfer not found.' });
  });

  it('respects the open-case cap (5) — a 6th recall is refused, no ticket', async () => {
    const ctx = await buildCtx(fakeRedis());
    const repo = createTicketRepo(db);
    // Pre-fill the cap with 5 open customer tickets.
    for (let i = 0; i < 5; i++) {
      await repo.createTicket({
        id: `tk_pre${i}`,
        partnerId: 'default',
        kind: 'customer',
        customerPhone: ctx.phone,
        subject: `existing ${i}`,
        body: 'open case',
      });
    }
    const id = await mintDelivered(ctx);
    const r = await executeTool('open_recall_dispute', { transfer_id: id, reason: 'other' }, ctx);
    expect(r.error_code).toBe('too_many_open_cases');
    expect(r.opened).toBeUndefined();
    // Still exactly 5 — nothing new opened.
    expect((await repo.listByCustomer(ctx.phone)).length).toBe(5);
  });
});

// ── B5: web channel — allowlist filters BOTH schemas and dispatch ────────────

describe('WEB_TOOL_ALLOWLIST + toolSchemasForChannel (B5)', () => {
  it('the allowlist is exactly the twelve read-only/refund/recall/pay-link tools', () => {
    expect([...WEB_TOOL_ALLOWLIST].sort()).toEqual([
      'check_payment_status',
      'check_send_limit',
      'generate_payment_link',
      'get_quote',
      'list_recent_transfers',
      'list_saved_recipients',
      'list_schedules',
      'open_recall_dispute',
      'repeat_transfer',
      'request_refund',
      'resolve_recipient',
      'validate_phone',
    ]);
  });

  it("toolSchemasForChannel('web') exposes ONLY allowlisted tools", () => {
    const names = toolSchemasForChannel('web').map((t) => t.function.name);
    expect(names.sort()).toEqual([...WEB_TOOL_ALLOWLIST].sort());
    expect(names).toContain('list_recent_transfers');
    expect(names).not.toContain('create_transfer');
    expect(names).not.toContain('send_approve_picker');
    expect(names).not.toContain('send_recipient_picker');
    expect(names).not.toContain('create_schedule');
  });

  it("toolSchemasForChannel('whatsapp') is the full set MINUS web-only tools", () => {
    const names = toolSchemasForChannel('whatsapp').map((t) => t.function.name);
    // Every roster tool except the web-only ones (list_recent_transfers).
    expect(names).not.toContain('list_recent_transfers');
    expect(names).toContain('create_transfer'); // a WhatsApp-only tool is still present
    expect(toolSchemasForChannel('whatsapp')).toHaveLength(toolSchemas.length - WEB_ONLY_TOOLS.size);
  });
});

describe('executeTool web dispatch gate (B5 defense-in-depth)', () => {
  const BLOCKED = [
    'create_transfer',
    'create_schedule',
    'cancel_schedule',
    'cancel_draft',
    'update_recipient_phone',
    'capture_corridor_request',
    'send_recipient_picker',
    'send_approve_picker',
    'register_seller', // WhatsApp-only (not in WEB_TOOL_ALLOWLIST)
    'create_invoice', // WhatsApp-only (not in WEB_TOOL_ALLOWLIST)
  ];

  it.each(BLOCKED)('%s on web returns { error: "not available here" }', async (name) => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const r = await executeTool(name, {}, ctx);
    expect(r).toEqual({ error: 'not available here' });
  });

  it('a blocked send_approve_picker performs NO side effect — no draft, no send', async () => {
    const base = await buildCtx(fakeRedis());
    const ctx = { ...base, channel: 'web' as const };
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();
    const r = await executeTool(
      'send_approve_picker',
      { amount_usd: 100, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: '919876543210' },
      ctx,
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(createDraft).not.toHaveBeenCalled();
    // No WhatsApp interactive left the building.
    const waCalls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://graph.facebook.com/'));
    expect(waCalls).toHaveLength(0);
  });

  it('a blocked create_transfer mints NOTHING', async () => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const r = await executeTool(
      'create_transfer',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });

  it('a blocked create_schedule saves NOTHING', async () => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const r = await executeTool(
      'create_schedule',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer', frequency: 'monthly', day_of_month: 5 },
      ctx,
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(await ctx.scheduleStore.listActiveSchedules()).toHaveLength(0);
  });

  it('allowlisted tools still execute on web (validate_phone, check_payment_status)', async () => {
    const ctx = { ...(await buildCtx(fakeRedis())), channel: 'web' as const };
    const v = await executeTool('validate_phone', { phone: '+91 98765 43210' }, ctx);
    expect(v.valid).toBe(true);

    const created = await executeTool(
      'create_transfer',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      { ...ctx, channel: 'whatsapp' as const }, // mint via the WhatsApp channel
    );
    const status = await executeTool('check_payment_status', { transfer_id: created.transfer_id }, ctx);
    expect(status.status).toBe('awaiting_payment');
  });

  it('the default channel (absent) is whatsapp — dispatch unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'create_transfer',
      { amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(typeof r.transfer_id).toBe('string');
  });

  it('request_refund on web keeps its ownership + paid-only guards', async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const created = await executeTool(
      'create_transfer',
      { amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      owner,
    );
    const id = created.transfer_id as string;

    // Not paid yet ⇒ nothing to refund, even on web.
    const notPaid = await executeTool('request_refund', { transfer_id: id }, { ...owner, channel: 'web' as const });
    expect(notPaid.error_code).toBe('not_paid_yet');

    // A stranger on web reads it as not found (404-never-403).
    const stranger = { ...(await buildCtx(redis, '15559990000')), channel: 'web' as const };
    const theft = await executeTool('request_refund', { transfer_id: id }, stranger);
    expect(theft).toEqual({ error: 'Transfer not found.' });

    // Paid + owned ⇒ the one eligible state — works identically on web.
    await owner.store.updateTransferFromWebhook(id, 'paid');
    const ok = await executeTool('request_refund', { transfer_id: id }, { ...owner, channel: 'web' as const });
    expect(ok.requested).toBe(true);
  });
});

describe('list_recent_transfers (web-only history lookup)', () => {
  const HISTORY_URL = 'https://smartremit.test/account/history';

  // Past sends happened in the bot ⇒ mint via the WhatsApp channel (create_transfer
  // is blocked on web). Small amounts keep the T0 $500/day cap clear.
  const send = (
    ctx: Awaited<ReturnType<typeof buildCtx>>,
    name: string,
    phone: string,
    amount: number,
  ) =>
    executeTool(
      'create_transfer',
      {
        amount_usd: amount,
        recipient_name: name,
        recipient_phone: phone,
        payout_method: 'upi',
        payout_destination: `${name.toLowerCase()}@okhdfc`,
        funding_method: 'bank_transfer',
      },
      ctx, // whatsapp channel
    );

  it('lists the customer OWN recent sends with a customer-safe shape + history_url', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    await send(base, 'Dad', '919811112222', 40);
    const ctx = { ...base, channel: 'web' as const };

    const r = await executeTool('list_recent_transfers', {}, ctx);
    expect(r.history_url).toBe(HISTORY_URL);
    expect(r.count).toBe(2);
    const transfers = r.transfers as Array<Record<string, unknown>>;
    expect(transfers).toHaveLength(2);
    expect(transfers.map((t) => t.recipient_name).sort()).toEqual(['Dad', 'Mom']);
    // customer-safe fields only — no payout account / compliance / tenant keys.
    const dad = transfers.find((t) => t.recipient_name === 'Dad')!;
    expect(Object.keys(dad).sort()).toEqual(['amount', 'date', 'recipient_name', 'status', 'transfer_id']);
    expect(dad.status).toBe('awaiting payment');
    expect(String(dad.amount)).toContain('40');
    expect(typeof dad.transfer_id).toBe('string');
  });

  it("filters to the named recipient ('mom') case-insensitively", async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    await send(base, 'Dad', '919811112222', 40);
    await send(base, 'Mom', '919876543210', 25);
    const ctx = { ...base, channel: 'web' as const };

    const r = await executeTool('list_recent_transfers', { recipient: 'mom' }, ctx);
    const transfers = r.transfers as Array<Record<string, unknown>>;
    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.recipient_name === 'Mom')).toBe(true);
  });

  it('honors a clamped limit but reports the TOTAL match count', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    await send(base, 'Dad', '919811112222', 40);
    const ctx = { ...base, channel: 'web' as const };
    const r = await executeTool('list_recent_transfers', { limit: 1 }, ctx);
    expect((r.transfers as unknown[]).length).toBe(1); // returned list is capped
    expect(r.count).toBe(2); // ...but count is the full number of matches
  });

  it('returns an empty list (still with history_url) when nothing matches', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    const ctx = { ...base, channel: 'web' as const };
    const r = await executeTool('list_recent_transfers', { recipient: 'nobody' }, ctx);
    expect(r).toEqual({ transfers: [], count: 0, history_url: HISTORY_URL });
  });

  it("NEVER returns another customer's transfers (own-phone scoping)", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    await send(owner, 'Mom', '919876543210', 30);
    const stranger = await buildCtx(redis, '15559990000');
    await send(stranger, 'Dad', '919811112222', 40);

    const mine = await executeTool('list_recent_transfers', {}, { ...owner, channel: 'web' as const });
    expect((mine.transfers as Array<Record<string, unknown>>).map((t) => t.recipient_name)).toEqual(['Mom']);
    const theirs = await executeTool('list_recent_transfers', {}, { ...stranger, channel: 'web' as const });
    expect((theirs.transfers as Array<Record<string, unknown>>).map((t) => t.recipient_name)).toEqual(['Dad']);
  });

  it('is BLOCKED off the web channel (web-only) — returns not available here', async () => {
    const base = await buildCtx(fakeRedis());
    await send(base, 'Mom', '919876543210', 30);
    // default channel (absent ⇒ whatsapp)
    expect(await executeTool('list_recent_transfers', {}, base)).toEqual({ error: 'not available here' });
    // explicit whatsapp
    expect(
      await executeTool('list_recent_transfers', {}, { ...base, channel: 'whatsapp' as const }),
    ).toEqual({ error: 'not available here' });
  });
});

describe('repeat_transfer on the web channel (B5 safe degrade)', () => {
  const seedPast = async (ctx: Awaited<ReturnType<typeof buildCtx>>) => {
    await executeTool(
      'create_transfer',
      {
        amount_usd: 200,
        recipient_name: 'Mom',
        recipient_phone: '919876543210',
        payout_method: 'upi',
        payout_destination: 'mom@okhdfc',
        funding_method: 'bank_transfer',
      },
      ctx, // whatsapp channel — the past send happened in the bot
    );
  };

  it('returns the summary + canonical pay_url instead of sending a WhatsApp card', async () => {
    const base = await buildCtx(fakeRedis());
    await seedPast(base);
    const ctx = { ...base, channel: 'web' as const };
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();

    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.sent).toBeUndefined(); // never claims an interactive was sent
    expect(typeof r.draft_id).toBe('string');
    expect(String(r.pay_url)).toBe(`https://smartremit.test/pay/${r.draft_id}`);
    expect(String(r.summary)).toContain('Mom');

    // The draft is REAL (same path the pay page consumes) with the real account.
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.recipient.payoutDestination).toBe('mom@okhdfc');
    expect(draft?.amountSource).toBe(200);

    // …and no WhatsApp send happened.
    const waCalls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://graph.facebook.com/'));
    expect(waCalls).toHaveLength(0);
  });

  it('EDD-required repeats degrade to a WhatsApp hand-off (no half-collected answers)', async () => {
    const base = await buildCtx(fakeRedis());
    await seedPast(base);
    await base.monthlyVolumeStore.addCents(base.phone, 300000); // over the $3k month threshold
    const ctx = { ...base, channel: 'web' as const };
    const createDraft = vi.spyOn(ctx.draftStore, 'createDraft');

    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(String(r.error).toLowerCase()).toContain('whatsapp');
    expect(r.sent).toBeUndefined();
    expect(r.pay_url).toBeUndefined();
    expect(r.payout_destination).toBeUndefined(); // the WhatsApp-shaped hydration payload stays home
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('on WhatsApp the same repeat still sends the approve card (unchanged)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPast(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.sent).toBe(true);
    expect(r.pay_url).toBeUndefined(); // the link rides the CTA card, never the result
  });
});

describe('transfer-id tools — strict ownership (404-never-403, both channels)', () => {
  async function mintFor(ctx: Awaited<ReturnType<typeof buildCtx>>): Promise<string> {
    const created = await executeTool(
      'create_transfer',
      { amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919876543210', funding_method: 'bank_transfer' },
      ctx,
    );
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  it("check_payment_status: another customer's id reads as not found", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintFor(owner);
    const stranger = await buildCtx(redis, '15559990000');
    for (const channel of ['whatsapp', 'web'] as const) {
      const r = await executeTool('check_payment_status', { transfer_id: id }, { ...stranger, channel });
      expect(r).toEqual({ error: 'Transfer not found.' });
    }
    // The owner still reads their own.
    const mine = await executeTool('check_payment_status', { transfer_id: id }, owner);
    expect(mine.status).toBe('awaiting_payment');
  });

  it("generate_payment_link: never mints a pay link for another customer's transfer", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintFor(owner);
    const stranger = await buildCtx(redis, '15559990000');
    for (const channel of ['whatsapp', 'web'] as const) {
      const r = await executeTool('generate_payment_link', { transfer_id: id }, { ...stranger, channel });
      expect(r).toEqual({ error: 'Transfer not found.' });
    }
    const mine = await executeTool('generate_payment_link', { transfer_id: id }, owner);
    expect(mine.url).toBe(`https://smartremit.test/pay/${id}`);
  });

  it("update_recipient_phone: never mutates another customer's transfer", async () => {
    const redis = fakeRedis();
    const owner = await buildCtx(redis);
    const id = await mintFor(owner);
    const stranger = await buildCtx(redis, '15559990000');
    const r = await executeTool('update_recipient_phone', { transfer_id: id, recipient_phone: '919999999999' }, stranger);
    expect(r).toEqual({ error: 'Transfer not found.' });
    expect((await owner.store.getTransfer(id))?.recipientPhone).toBe('919876543210'); // untouched
  });
});

// ── U1: present_bill + B2B create (Phase 1+2) ────────────────────────────────
describe('present_bill — B2B mock invoice lookup (WhatsApp channel)', () => {
  beforeEach(async () => {
    // b2b_invoices is not in freshDb's TRUNCATE set — clear it per test so the
    // buyer's "unpaid" lookup is deterministic.
    await db.execute(sql`TRUNCATE b2b_invoices`);
  });

  it('present_bill is a WhatsApp-only tool (in toolSchemas, NOT web-allowlisted)', () => {
    expect(toolSchemas.map((t) => t.function.name)).toContain('present_bill');
    expect(WEB_TOOL_ALLOWLIST.has('present_bill')).toBe(false);
    expect(WEB_ONLY_TOOLS.has('present_bill')).toBe(false); // visible on WhatsApp
    expect(toolSchemasForChannel('whatsapp').map((t) => t.function.name)).toContain('present_bill');
    expect(toolSchemasForChannel('web').map((t) => t.function.name)).not.toContain('present_bill');
  });

  it('returns the structured bill (seller, line items, total) for the buyer', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.saveB2bInvoice({
      id: 'inv_u1', partnerId: 'default', businessName: 'Globex Trading LLC',
      buyerPhone: PHONE,
      lineItems: [
        { description: 'Widgets', qty: 100, unitAmountUsd: 10 },
        { description: 'Gadgets', qty: 5, unitAmountUsd: 40 },
      ],
      amountUsd: 1200, currency: 'USD', status: 'unpaid',
      createdAt: new Date().toISOString(),
    });
    const r = await executeTool('present_bill', {}, ctx);
    expect(r.has_bill).toBe(true);
    const inv = r.invoice as Record<string, unknown>;
    expect(inv.invoice_id).toBe('inv_u1');
    expect(inv.seller_business_name).toBe('Globex Trading LLC');
    expect(inv.amount_usd).toBe(1200);
    expect(inv.line_items).toEqual([
      { description: 'Widgets', qty: 100, unit_amount_usd: 10 },
      { description: 'Gadgets', qty: 5, unit_amount_usd: 40 },
    ]);
  });

  it('returns has_bill:false (clean no-op, never an error) when no unpaid invoice', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('present_bill', {}, ctx);
    expect(r).toEqual({ has_bill: false });
  });

  it('present_bill is blocked at dispatch on the web channel', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.saveB2bInvoice({
      id: 'inv_web', partnerId: 'default', businessName: 'Globex Trading LLC',
      buyerPhone: PHONE, lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 10 }],
      amountUsd: 10, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
    });
    const r = await executeTool('present_bill', {}, { ...ctx, channel: 'web' });
    expect(r).toEqual({ error: 'not available here' });
  });
});

describe('register_seller — cross-border seller onboarding start (WhatsApp channel)', () => {
  beforeEach(async () => {
    // sellers is not in freshDb's TRUNCATE set — clear it per test. CASCADE: the
    // cross-border invoice FK (b2b_invoices.seller_id → sellers) makes a bare
    // TRUNCATE of the referenced table illegal.
    await db.execute(sql`TRUNCATE sellers CASCADE`);
  });

  it('register_seller is a WhatsApp-only tool (in toolSchemas, NOT web-allowlisted)', () => {
    expect(toolSchemas.map((t) => t.function.name)).toContain('register_seller');
    expect(WEB_TOOL_ALLOWLIST.has('register_seller')).toBe(false);
    expect(WEB_ONLY_TOOLS.has('register_seller')).toBe(false); // visible on WhatsApp
    expect(toolSchemasForChannel('whatsapp').map((t) => t.function.name)).toContain('register_seller');
    expect(toolSchemasForChannel('web').map((t) => t.function.name)).not.toContain('register_seller');
  });

  it('creates a PENDING seller and returns the secure onboarding link', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    expect(r.registered).toBe(true);
    expect(r.status).toBe('pending');
    expect(String(r.onboarding_url)).toMatch(/\/onboard\/seller\/s_[a-z0-9]+$/i);

    // The seller exists, pending, country/currency derived from the US phone.
    const seller = await ctx.store.getSeller(PHONE, 'default');
    expect(seller?.status).toBe('pending');
    expect(seller?.country).toBe('US');
    expect(seller?.currency).toBe('USD');
    expect(seller?.businessName).toBe('Acme Exports Inc');
    expect(seller?.payoutLast4).toBeUndefined(); // not collected yet

    // The onboarding link is delivered to the seller by the SYSTEM (durable outbox),
    // NOT typed by the bot — assert it was enqueued to the seller's own number.
    const rows = (await db.execute(
      sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ payload: Record<string, unknown>; dedupe_key: string }> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload.to).toBe(PHONE);
    expect(String(rows.rows[0].payload.body)).toContain(String(r.onboarding_url));
    expect(rows.rows[0].dedupe_key).toMatch(/^selleronboard:s_/);
  });

  it('SANCTIONS HIT: still creates the seller but returns NO link + flags review', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 'test blocked' is on the mock watchlist (case-insensitive exact match).
    const r = await executeTool('register_seller', { business_name: 'Test Blocked' }, ctx);
    expect(r.registered).toBe(false);
    expect(r.review).toBe(true);
    expect(r.onboarding_url).toBeUndefined();
    // Never names sanctions/watchlist to the customer.
    expect(String(r.reply_to_customer).toLowerCase()).not.toContain('sanction');
    expect(String(r.reply_to_customer).toLowerCase()).not.toContain('watchlist');

    // The seller row exists, stays pending, and is flagged for review.
    const seller = await ctx.store.getSeller(PHONE, 'default');
    expect(seller).not.toBeNull();
    expect(seller?.status).toBe('pending');
    expect(seller?.kycReviewState).toBe('needs_review');
  });

  it('asks which country when the calling code is unknown (never guesses)', async () => {
    const ctx = await buildCtx(fakeRedis(), '99912340000'); // no known calling code
    const r = await executeTool('register_seller', { business_name: 'Mystery Co' }, ctx);
    expect(r.needs_country).toBe(true);
    expect(r.onboarding_url).toBeUndefined();
    // Nothing was created.
    expect(await ctx.store.getSeller('99912340000', 'default')).toBeNull();
  });

  it('does not duplicate: an already-ACTIVE seller is told they are registered (no link)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    await ctx.store.setSellerStatus(PHONE, 'default', 'active');
    const r = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    expect(r.already_registered).toBe(true);
    expect(r.status).toBe('active');
    expect(r.onboarding_url).toBeUndefined();
  });

  it('re-offers (RE-SENDS) the link to a still-PENDING seller without creating a second row', async () => {
    const ctx = await buildCtx(fakeRedis());
    const first = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    const second = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, ctx);
    expect(second.already_registered).toBe(true);
    expect(second.status).toBe('pending');
    // Same seller id (no duplicate row).
    expect(String(second.onboarding_url)).toBe(String(first.onboarding_url));
    // A resend must NOT be swallowed — the re-offer re-sends the link via the system
    // (the initial registration + this resend both enqueue a link to the seller).
    const rows = (await db.execute(
      sql`SELECT payload FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ payload: Record<string, unknown> }> };
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.rows.every((x) => x.payload.to === PHONE)).toBe(true);
    expect(rows.rows.every((x) => String(x.payload.body).includes(String(second.onboarding_url)))).toBe(true);
  });

  it('is blocked at dispatch on the web channel (WhatsApp-only)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('register_seller', { business_name: 'Acme Exports Inc' }, { ...ctx, channel: 'web' });
    expect(r).toEqual({ error: 'not available here' });
    // Nothing created on the blocked web call.
    expect(await ctx.store.getSeller(PHONE, 'default')).toBeNull();
  });
});

describe('create_invoice — WhatsApp seller-initiated cross-border bill (Plan 5)', () => {
  beforeEach(async () => {
    // sellers is not in freshDb's TRUNCATE set — clear it (CASCADE drops the
    // cross-border invoice FK rows too, keeping the buyer-bill table clean).
    await db.execute(sql`TRUNCATE sellers CASCADE`);
  });

  // Make the default-phone (US → USD) seller ACTIVE: payout set + status active.
  async function seedActiveSeller(
    ctx: Awaited<ReturnType<typeof buildCtx>>,
    businessName = 'Acme Exports Inc',
  ) {
    await ctx.store.createSeller({
      id: `s_${'active1'}`, partnerId: 'default', phone: PHONE,
      businessName, country: 'US', currency: 'USD',
    });
    const activated = await ctx.store.completeSellerOnboarding(PHONE, 'default', '021000021|12345678');
    expect(activated?.status).toBe('active');
  }

  it('create_invoice is a WhatsApp-only tool (in toolSchemas, NOT web-allowlisted)', () => {
    expect(toolSchemas.map((t) => t.function.name)).toContain('create_invoice');
    expect(WEB_TOOL_ALLOWLIST.has('create_invoice')).toBe(false);
    expect(WEB_ONLY_TOOLS.has('create_invoice')).toBe(false); // visible on WhatsApp
    expect(toolSchemasForChannel('whatsapp').map((t) => t.function.name)).toContain('create_invoice');
    expect(toolSchemasForChannel('web').map((t) => t.function.name)).not.toContain('create_invoice');
  });

  it('an ACTIVE seller creates a cross-border invoice + pay link + buyer-delivery effect', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedActiveSeller(ctx);

    const r = await executeTool(
      'create_invoice',
      { buyer_phone: '+1 555 987 6543', amount: 250, description: 'design work' },
      ctx,
    );
    expect(r.created).toBe(true);
    expect(String(r.invoice_id)).toMatch(/^inv_[a-z0-9]+$/i);
    expect(String(r.pay_url)).toMatch(/\/pay\/b2b\/inv_[a-z0-9]+$/i);
    expect(String(r.pay_url)).toContain(String(r.invoice_id));
    expect(r.amount).toBe(250);
    expect(r.currency).toBe('USD');

    // The invoice persisted as a CROSS-BORDER, partner-scoped, unpaid obligation.
    const inv = await ctx.store.getB2bInvoice(String(r.invoice_id));
    expect(inv).not.toBeNull();
    expect(inv?.partnerId).toBe('default');
    expect(inv?.sellerId).toBe('s_active1');
    expect(inv?.invoicedAmount).toBe(250);
    expect(inv?.invoicedCurrency).toBe('USD');
    expect(inv?.status).toBe('unpaid');
    expect(inv?.businessName).toBe('Acme Exports Inc');
    expect(inv?.buyerPhone).toBe('15559876543'); // normalized
    // It is the buyer's OPEN bill (the buyer pay path resolves it by phone).
    const open = await ctx.store.getUnpaidInvoiceByBuyer('15559876543', 'default');
    expect(open?.id).toBe(String(r.invoice_id));

    // TWO durable whatsapp.text effects: the buyer push AND the seller's OWN copy
    // of the pay link (both deduped on the invoice id). The bot never types the URL.
    const rows = (await db.execute(
      sql`SELECT kind, payload, dedupe_key FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ kind: string; payload: Record<string, unknown>; dedupe_key: string }> };
    expect(rows.rows).toHaveLength(2);
    const buyerPush = rows.rows.find((x) => x.dedupe_key === `billpush:${r.invoice_id}`)!;
    expect(buyerPush.payload.to).toBe('15559876543');
    expect(String(buyerPush.payload.body)).toContain('Acme Exports Inc');
    expect(String(buyerPush.payload.body)).toContain(String(r.pay_url));
    // Buyer-facing copy carries no internal jargon.
    expect(String(buyerPush.payload.body).toLowerCase()).not.toContain('corridor');
    const sellerPush = rows.rows.find((x) => x.dedupe_key === `sellerbill:${r.invoice_id}`)!;
    expect(sellerPush.payload.to).toBe(PHONE); // the seller's OWN number
    expect(String(sellerPush.payload.body)).toContain(String(r.pay_url));
  });

  it('is replay-safe: a duplicate call returns the SAME bill (one invoice, one buyer push)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedActiveSeller(ctx);
    const args = { buyer_phone: '15559876543', amount: 250, description: 'design work' };
    // The agent.turn outbox row is at-least-once — a replay (or the model calling
    // twice in one turn) must NOT mint a second bill or push a second link.
    const first = await executeTool('create_invoice', args, ctx);
    const second = await executeTool('create_invoice', args, ctx);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.invoice_id).toBe(first.invoice_id); // same bill, same link
    expect(second.pay_url).toBe(first.pay_url);

    // Exactly ONE invoice persisted, and the original run's TWO pushes (buyer +
    // seller) — the duplicate call returns early and enqueues nothing more.
    expect(await ctx.store.listB2bInvoices('default')).toHaveLength(1);
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(rows.rows[0].n).toBe(2);
  });

  it('refuses a seller with NO profile (steers to register) and creates NOTHING', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('create_invoice', { buyer_phone: '15559876543', amount: 100 }, ctx);
    expect(r.created).toBe(false);
    expect(r.needs_registration).toBe(true);
    expect(r.invoice_id).toBeUndefined();
    expect(await ctx.store.listB2bInvoices('default')).toHaveLength(0);
  });

  it('refuses a PENDING (not-yet-active) seller and creates NOTHING', async () => {
    const ctx = await buildCtx(fakeRedis());
    // pending: registered but onboarding not completed (no payout / not active).
    await ctx.store.createSeller({
      id: 's_pending1', partnerId: 'default', phone: PHONE,
      businessName: 'Pending Co', country: 'US', currency: 'USD',
    });
    const r = await executeTool('create_invoice', { buyer_phone: '15559876543', amount: 100 }, ctx);
    expect(r.created).toBe(false);
    expect(r.needs_registration).toBe(true);
    expect(await ctx.store.listB2bInvoices('default')).toHaveLength(0);
  });

  it('refuses an invalid / empty buyer number and creates NOTHING', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedActiveSeller(ctx);
    for (const buyer of ['123', '', 'not-a-number']) {
      const r = await executeTool('create_invoice', { buyer_phone: buyer, amount: 100 }, ctx);
      expect(r.created).toBe(false);
      expect(r.invoice_id).toBeUndefined();
    }
    expect(await ctx.store.listB2bInvoices('default')).toHaveLength(0);
  });

  it('refuses a non-positive / non-finite amount and creates NOTHING', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedActiveSeller(ctx);
    for (const amount of [0, -5, Number.NaN]) {
      const r = await executeTool('create_invoice', { buyer_phone: '15559876543', amount }, ctx);
      expect(r.created).toBe(false);
      expect(r.invoice_id).toBeUndefined();
    }
    expect(await ctx.store.listB2bInvoices('default')).toHaveLength(0);
  });

  it('is blocked at dispatch on the web channel (WhatsApp-only) — creates NOTHING', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedActiveSeller(ctx);
    const r = await executeTool(
      'create_invoice',
      { buyer_phone: '15559876543', amount: 250 },
      { ...ctx, channel: 'web' as const },
    );
    expect(r).toEqual({ error: 'not available here' });
    expect(await ctx.store.listB2bInvoices('default')).toHaveLength(0);
  });
});

describe('create_transfer — B2B (business-to-business, ach_pull, non-custodial)', () => {
  it('mints a b2b transfer: discriminators, business names, invoice link; never captures funds', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('create_transfer', {
      amount_source: 400,                          // within the seeded T0 $500/day cap
      recipient_name: 'Globex Trading LLC',       // payee business legal name
      recipient_phone: '919876543210',
      funding_method: 'ach_pull',
      entity_type: 'business',
      sender_business_name: 'Acme Imports Ltd',    // payer business legal name
      recipient_business_name: 'Globex Trading LLC',
      invoice_id: 'inv_u1',
    }, ctx);

    expect(result.status).toBe('awaiting_payment'); // non-custodial: no capture at mint
    expect(result.compliance_status).toBe('cleared');

    const saved = await ctx.store.getTransferDecrypted(result.transfer_id as string);
    expect(saved?.transferType).toBe('b2b');
    expect(saved?.senderEntityType).toBe('business');
    expect(saved?.recipientEntityType).toBe('business');
    expect(saved?.senderBusinessName).toBe('Acme Imports Ltd');
    expect(saved?.recipientBusinessName).toBe('Globex Trading LLC');
    expect(saved?.fundingMethod).toBe('ach_pull'); // flat $1.99 ACH-pull fee (fx.ts), $0 on first send
    expect(saved?.invoiceId).toBe('inv_u1');
    expect(saved?.achTokenRef).toBeUndefined();     // bound at pay time (U2), NEVER here
  });

  it('a consumer create with no B2B args stays byte-for-byte b2c (path unchanged)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const result = await executeTool('create_transfer', {
      amount_usd: 500, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, ctx);
    const saved = await ctx.store.getTransfer(result.transfer_id as string);
    expect(saved?.transferType).toBe('b2c');
    expect(saved?.senderEntityType).toBe('individual');
    expect(saved?.recipientEntityType).toBe('individual');
    expect(saved?.senderBusinessName).toBeUndefined();
    expect(saved?.invoiceId).toBeUndefined();
  });
});

describe('send_approve_picker — B2B draft → approve-tap mint threads business fields', () => {
  it('carries b2b discriminators + business names + invoice through the draft to the mint', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis);
    // Prime the FX rate cache BEFORE we replace fetch with the WhatsApp-send stub.
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'ach_pull' }, ctx);
    // Stub fetch for the CTA send (returns ok + text + json so both FX and the
    // WhatsApp Cloud API call are satisfied). No real network, no money moves.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, text: async () => '', json: async () => ({ rates: { INR: MOCK_RATE } }),
    })));
    // Show the B2B approval card (creates a draft; sends a CTA, no money moves).
    const picker = await executeTool('send_approve_picker', {
      amount_source: 400,                          // within the seeded T0 $500/day cap
      funding_method: 'ach_pull',
      entity_type: 'business',
      recipient_name: 'Globex Trading LLC',
      recipient_business_name: 'Globex Trading LLC',
      sender_business_name: 'Acme Imports Ltd',
      recipient_phone: '919876543210',
      invoice_id: 'inv_u1',
    }, ctx);
    const draftId = picker.draft_id as string;
    expect(draftId).toBeTruthy();

    // Approve-tap mint path: the system supplies the draftId via button-tap ctx.
    const tapCtx = { ...ctx, turn: { isNewConversation: false, buttonTap: { kind: 'approve', draftId } } as const };
    const minted = await executeTool('create_transfer', {}, tapCtx);
    expect(minted.status).toBe('awaiting_payment');

    const saved = await ctx.store.getTransferDecrypted(minted.transfer_id as string);
    expect(saved?.transferType).toBe('b2b');
    expect(saved?.senderEntityType).toBe('business');
    expect(saved?.recipientEntityType).toBe('business');
    expect(saved?.senderBusinessName).toBe('Acme Imports Ltd');
    expect(saved?.recipientBusinessName).toBe('Globex Trading LLC');
    expect(saved?.fundingMethod).toBe('ach_pull');
    expect(saved?.invoiceId).toBe('inv_u1');
    expect(saved?.achTokenRef).toBeUndefined(); // bound at pay time (U2)
  });
});

// ── L1: buyer-facing B2B lifecycle controls — check_bill_status / cancel_bill /
//        dispute_bill (WhatsApp-only, NON-CUSTODIAL: no buyer chat tool moves
//        money or directly reverses a paid transfer) ───────────────────────────
describe('B2B buyer lifecycle controls (L1)', () => {
  type Ctx = Awaited<ReturnType<typeof buildCtx>>;

  beforeEach(async () => {
    // b2b_invoices is not in freshDb's TRUNCATE set — clear it per test.
    await db.execute(sql`TRUNCATE b2b_invoices`);
  });

  // Mint an awaiting_payment B2B transfer owned by ctx.phone via the real tool
  // path (ach_pull, non-custodial — no capture at mint). $400 is within the seeded
  // T0 $500/day cap, so one mint per test is safe.
  async function mintB2b(ctx: Ctx, invoiceId?: string): Promise<string> {
    const created = await executeTool('create_transfer', {
      amount_source: 400,
      recipient_name: 'Globex Trading LLC',
      recipient_phone: '919876543210',
      funding_method: 'ach_pull',
      entity_type: 'business',
      sender_business_name: 'Acme Imports Ltd',
      recipient_business_name: 'Globex Trading LLC',
      ...(invoiceId ? { invoice_id: invoiceId } : {}),
    }, ctx);
    expect(created.error).toBeUndefined();
    return created.transfer_id as string;
  }

  // Force a status the webhook machine can't reach (in_review/blocked/cancelled).
  async function forceStatus(ctx: Ctx, id: string, status: 'in_review' | 'blocked' | 'cancelled') {
    const t = (await ctx.store.getTransfer(id))!;
    await ctx.store.saveTransfer({ ...t, status });
  }

  async function seedUnpaidInvoice(ctx: Ctx, id = 'inv_dsp') {
    await ctx.store.saveB2bInvoice({
      id, partnerId: 'default', businessName: 'Globex Trading LLC',
      buyerPhone: PHONE, lineItems: [{ description: 'Widgets', qty: 100, unitAmountUsd: 10 }],
      amountUsd: 1000, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
    });
    return id;
  }

  // ── channel exposure: WhatsApp-only, mirroring present_bill ──
  it.each(['check_bill_status', 'cancel_bill', 'dispute_bill'])(
    '%s is a WhatsApp-only tool (in toolSchemas, NOT web-allowlisted)',
    (name) => {
      expect(toolSchemas.map((t) => t.function.name)).toContain(name);
      expect(WEB_TOOL_ALLOWLIST.has(name)).toBe(false);
      expect(WEB_ONLY_TOOLS.has(name)).toBe(false);
      expect(toolSchemasForChannel('whatsapp').map((t) => t.function.name)).toContain(name);
      expect(toolSchemasForChannel('web').map((t) => t.function.name)).not.toContain(name);
    },
  );

  it.each(['check_bill_status', 'cancel_bill', 'dispute_bill'])(
    '%s is blocked at dispatch on the web channel (defense-in-depth)',
    async (name) => {
      const ctx = await buildCtx(fakeRedis());
      const r = await executeTool(name, { reason: 'other' }, { ...ctx, channel: 'web' });
      expect(r).toEqual({ error: 'not available here' });
    },
  );

  // ── check_bill_status (read-only, no money) ──
  describe('check_bill_status', () => {
    it('returns { found: false } when the buyer has no B2B transfer', async () => {
      const ctx = await buildCtx(fakeRedis());
      expect(await executeTool('check_bill_status', {}, ctx)).toEqual({ found: false });
    });

    it('a B2C transfer alone still reads as no B2B bill', async () => {
      const ctx = await buildCtx(fakeRedis());
      await executeTool('create_transfer', {
        amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210',
        payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      }, ctx);
      expect(await executeTool('check_bill_status', {}, ctx)).toEqual({ found: false });
    });

    it('reports awaiting_payment in buyer terms', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      const r = await executeTool('check_bill_status', {}, ctx);
      expect(r.found).toBe(true);
      expect(r.transfer_id).toBe(id);
      expect(r.status).toBe('awaiting_payment');
      expect(String(r.status_summary).toLowerCase()).toContain('not paid');
    });

    it('surfaces the seller name + invoice state from the linked invoice (not the masked transfer field)', async () => {
      const ctx = await buildCtx(fakeRedis());
      await ctx.store.saveB2bInvoice({
        id: 'inv_cbs', partnerId: 'default', businessName: 'Globex Trading LLC',
        buyerPhone: PHONE, lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 400 }],
        amountUsd: 400, currency: 'USD', status: 'unpaid', createdAt: new Date().toISOString(),
      });
      const id = await mintB2b(ctx, 'inv_cbs');
      await ctx.store.updateTransferFromWebhook(id, 'paid');
      const r = await executeTool('check_bill_status', {}, ctx);
      expect(r.status).toBe('paid');
      expect(String(r.status_summary).toLowerCase()).toContain('settling');
      expect(r.seller_business_name).toBe('Globex Trading LLC'); // plaintext, from the invoice
      expect(r.invoice_status).toBe('unpaid');
      expect(r.invoice_paid).toBe(false);
      expect(JSON.stringify(r)).not.toContain('****'); // never the masked transfer field
    });

    it('reports delivered as settled', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      await ctx.store.updateTransferFromWebhook(id, 'paid');
      await ctx.store.updateTransferFromWebhook(id, 'delivered');
      const r = await executeTool('check_bill_status', {}, ctx);
      expect(r.status).toBe('delivered');
      expect(String(r.status_summary).toLowerCase()).toContain('settled');
    });

    it("STRICT ownership: a stranger sees none of the owner's B2B bill", async () => {
      const redis = fakeRedis();
      const owner = await buildCtx(redis);
      await mintB2b(owner);
      const stranger = await buildCtx(redis, '15559990000');
      expect(await executeTool('check_bill_status', {}, stranger)).toEqual({ found: false });
    });
  });

  // ── cancel_bill (NON-CUSTODIAL — never moves money) ──
  describe('cancel_bill', () => {
    it('awaiting_payment ⇒ flips to cancelled; nothing debited, no refund flag', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.cancelled).toBe(true);
      expect(r.transfer_id).toBe(id);
      expect(String(r.reply_hint).toLowerCase()).toContain('nothing was debited');
      const after = await ctx.store.getTransfer(id);
      expect(after?.status).toBe('cancelled');
      expect(after?.refundStatus ?? 'none').toBe('none');
    });

    it('in_review ⇒ DEFERS to ops; the transfer is left untouched', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      await forceStatus(ctx, id, 'in_review');
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.deferred).toBe(true);
      expect(r.cancelled).toBeUndefined();
      expect(String(r.reply_hint).toLowerCase()).toContain('under review');
      expect((await ctx.store.getTransfer(id))?.status).toBe('in_review'); // unchanged
    });

    it('paid ⇒ only REQUESTS a reverse (refundStatus none→requested); the debit is NOT reversed', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      expect(await ctx.store.updateTransferFromWebhook(id, 'paid')).not.toBeNull();
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.reverse_requested).toBe(true);
      expect(r.transfer_id).toBe(id);
      expect(String(r.reply_hint)).toContain('3-5 business days');
      const after = await ctx.store.getTransfer(id);
      expect(after?.status).toBe('paid');            // forward-only status untouched — NO reversal
      expect(after?.refundStatus).toBe('requested');  // only an ops flag
    });

    it('a second cancel of a paid bill is the already-reviewed no-op', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      await ctx.store.updateTransferFromWebhook(id, 'paid');
      await executeTool('cancel_bill', {}, ctx);
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.reverse_requested).toBeUndefined();
      expect(r.error_code).toBe('already_requested');
      expect((await ctx.store.getTransfer(id))?.refundStatus).toBe('requested');
    });

    it('delivered within 24h ⇒ opens a recall case (no money moves)', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      await ctx.store.updateTransferFromWebhook(id, 'paid');
      await ctx.store.updateTransferFromWebhook(id, 'delivered'); // deliveredAt = now()
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.recall_opened).toBe(true);
      expect(String(r.case_id)).toMatch(/^tk_/);
      const ticket = (await createTicketRepo(db).listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
      expect(ticket.transferId).toBe(id);
    });

    it('delivered over 24h ago ⇒ past the recall window, no case', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      await ctx.store.updateTransferFromWebhook(id, 'paid');
      await ctx.store.updateTransferFromWebhook(id, 'delivered');
      const t = (await ctx.store.getTransfer(id))!;
      await ctx.store.saveTransfer({ ...t, deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.cancelled).toBe(false);
      expect(String(r.reply_hint).toLowerCase()).toContain('recall window');
      expect(await createTicketRepo(db).listByCustomer(ctx.phone)).toHaveLength(0);
    });

    it('no transfer but an active draft ⇒ discards the draft (nothing charged)', async () => {
      const ctx = await buildCtx(fakeRedis());
      await ctx.draftStore.createDraft({
        senderPhone: PHONE,
        recipient: { name: 'Globex Trading LLC', recipientPhone: '919876543210', payoutMethod: 'bank' },
        amountUsd: 400, amountSource: 400, sourceCurrency: 'USD', fundingMethod: 'ach_pull',
        quote: { feeUsd: 1.99, fxRate: 1, amountInr: 400 },
        transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
        senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC',
        invoiceId: 'inv_u1',
      });
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.cancelled).toBe(true);
      expect(r.action).toBe('draft_discarded');
      expect(String(r.reply_hint).toLowerCase()).toContain('nothing was charged');
      expect(await ctx.draftStore.getActiveDraftId(PHONE)).toBeNull(); // consumed
    });

    it('an already-cancelled bill ⇒ nothing to cancel', async () => {
      const ctx = await buildCtx(fakeRedis());
      const id = await mintB2b(ctx);
      await forceStatus(ctx, id, 'cancelled');
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.cancelled).toBe(false);
      expect(String(r.reply_hint).toLowerCase()).toContain('nothing to cancel');
    });

    it('no B2B bill and no draft ⇒ found:false, nothing to cancel', async () => {
      const ctx = await buildCtx(fakeRedis());
      const r = await executeTool('cancel_bill', {}, ctx);
      expect(r.cancelled).toBe(false);
      expect(r.found).toBe(false);
    });

    it("STRICT ownership: a stranger cannot cancel the owner's paid bill", async () => {
      const redis = fakeRedis();
      const owner = await buildCtx(redis);
      const id = await mintB2b(owner);
      await owner.store.updateTransferFromWebhook(id, 'paid');
      const stranger = await buildCtx(redis, '15559990000');
      const r = await executeTool('cancel_bill', {}, stranger);
      expect(r.cancelled).toBe(false);
      expect(r.found).toBe(false);
      const after = await owner.store.getTransfer(id); // owner's bill untouched
      expect(after?.status).toBe('paid');
      expect(after?.refundStatus ?? 'none').toBe('none');
    });
  });

  // ── dispute_bill (opens a case + flips the invoice; no money) ──
  describe('dispute_bill', () => {
    it('opens a customer ticket (invoice + reason in the body) and flips the invoice unpaid→disputed', async () => {
      const ctx = await buildCtx(fakeRedis());
      const invId = await seedUnpaidInvoice(ctx);
      const r = await executeTool('dispute_bill', { reason: 'wrong_amount' }, ctx);
      expect(r.disputed).toBe(true);
      expect(String(r.case_id)).toMatch(/^tk_/);
      expect(String(r.reply_hint).toLowerCase()).toContain('disputed');

      const repo = createTicketRepo(db);
      const ticket = (await repo.listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
      expect(ticket).toBeTruthy();
      expect(ticket.kind).toBe('customer');
      const msgs = await repo.listMessages(ticket.id, { includeInternal: true });
      expect(msgs[0].body).toContain(invId);            // invoiceId in the body
      expect(msgs[0].body.toLowerCase()).toContain('amount'); // reason label in the body

      expect((await ctx.store.getB2bInvoice(invId))?.status).toBe('disputed');
    });

    it("no open bill ⇒ 'no open bill to dispute', opens nothing", async () => {
      const ctx = await buildCtx(fakeRedis());
      const r = await executeTool('dispute_bill', { reason: 'not_my_bill' }, ctx);
      expect(r.disputed).toBeUndefined();
      expect(String(r.reply_hint).toLowerCase()).toContain('open bill to dispute');
      expect(await createTicketRepo(db).listByCustomer(ctx.phone)).toHaveLength(0);
    });

    it('a second dispute is a natural no-op (the bill is no longer open)', async () => {
      const ctx = await buildCtx(fakeRedis());
      await seedUnpaidInvoice(ctx);
      await executeTool('dispute_bill', { reason: 'duplicate' }, ctx);
      const r = await executeTool('dispute_bill', { reason: 'duplicate' }, ctx);
      expect(r.disputed).toBeUndefined();
      expect(String(r.reply_hint).toLowerCase()).toContain('open bill to dispute');
    });

    it('an unknown reason fails safe to other (the team still triages)', async () => {
      const ctx = await buildCtx(fakeRedis());
      const invId = await seedUnpaidInvoice(ctx);
      const r = await executeTool('dispute_bill', { reason: 'nonsense' }, ctx);
      expect(r.disputed).toBe(true);
      const ticket = (await createTicketRepo(db).listByCustomer(ctx.phone)).find((t) => t.id === r.case_id)!;
      expect(ticket.subject.toLowerCase()).toContain('other');
      expect((await ctx.store.getB2bInvoice(invId))?.status).toBe('disputed');
    });

    it('respects the open-case cap (5) — a 6th dispute is refused, invoice stays unpaid', async () => {
      const ctx = await buildCtx(fakeRedis());
      const repo = createTicketRepo(db);
      for (let i = 0; i < 5; i++) {
        await repo.createTicket({
          id: `tk_pre${i}`, partnerId: 'default', kind: 'customer',
          customerPhone: ctx.phone, subject: `existing ${i}`, body: 'open case',
        });
      }
      const invId = await seedUnpaidInvoice(ctx);
      const r = await executeTool('dispute_bill', { reason: 'other' }, ctx);
      expect(r.error_code).toBe('too_many_open_cases');
      expect(r.disputed).toBeUndefined();
      expect((await ctx.store.getB2bInvoice(invId))?.status).toBe('unpaid'); // not flipped
    });
  });
});
