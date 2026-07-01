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

describe('send_approve_picker — one-tap CTA pay (Batch 1)', () => {
  // Helper: build a context with a cleared recipient + primed rate cache
  async function buildClearedCtx() {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550003333');
    await ctx.customerStore.upsertOnFirstInbound('15550003333');
    // Prime rate cache before we replace fetch
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    return ctx;
  }

  it('CLEARED recipient → { sent:true, draft_id }; POST body has cta_url type and https pay URL', async () => {
    const ctx = await buildClearedCtx();
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
    }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // Find the WhatsApp API call (cta_url)
    const waCall = calls.find((c) => (c.body as Record<string, unknown>)?.interactive);
    expect(waCall).toBeDefined();
    const interactive = (waCall!.body as Record<string, unknown>).interactive as Record<string, unknown>;
    expect(interactive.type).toBe('cta_url');
    const params = (interactive.action as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(params.url).toMatch(/\/pay\/.+$/);
    expect(String(params.url)).toMatch(/^https:\/\//);
  });

  it('does NOT re-send the approve card on a duplicate call (at-least-once retry / double tool-call)', async () => {
    const ctx = await buildClearedCtx();
    let ctaSends = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse((init.body as string) ?? 'null') : null;
      if ((body?.interactive as Record<string, unknown>)?.type === 'cta_url') ctaSends++;
      return { ok: true, text: async () => '' };
    }));
    const args = {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    };
    const first = await executeTool('send_approve_picker', args, ctx);
    const second = await executeTool('send_approve_picker', args, ctx); // the retry re-runs the turn
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(true);   // still reports sent so the agent suppresses trailing text (no dup text either)
    expect(ctaSends).toBe(1);         // the "Approve & Pay" card was sent EXACTLY once
  });

  it('releases the idempotency key when the card SEND fails, so the retry re-delivers', async () => {
    const ctx = await buildClearedCtx();
    let ctaAttempts = 0;
    let failNext = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse((init.body as string) ?? 'null') : null;
      if ((body?.interactive as Record<string, unknown>)?.type === 'cta_url') {
        ctaAttempts++;
        // Reject (network-level) only on the FIRST card send — sendCtaUrl rethrows
        // (no res ⇒ no graceful sendText fallback), so the tool rethrows.
        if (failNext) { failNext = false; throw new Error('network reset'); }
      }
      return { ok: true, text: async () => '' };
    }));
    const args = {
      amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    };
    // First attempt: the send throws → the turn fails (and would be retried).
    await expect(executeTool('send_approve_picker', args, ctx)).rejects.toThrow(/network reset/);
    // Retry: the failed send RELEASED the key, so the card actually goes out now
    // (a stuck key would have suppressed it → customer gets NO link).
    const retry = await executeTool('send_approve_picker', args, ctx);
    expect(retry.sent).toBe(true);
    expect(ctaAttempts).toBe(2);      // attempted on the failed send AND the successful retry
  });

  it('cold-start (no payout details) → draft with empty payoutDestination, placeholder on the card', async () => {
    const ctx = await buildClearedCtx();
    let ctaText = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const cta = (body?.interactive as Record<string, unknown>)?.body as Record<string, unknown> | undefined;
      if (cta && typeof cta.text === 'string') ctaText = cta.text;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      // NO payout_method / payout_destination — collected on the secure page
    }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // Draft stores an EMPTY destination (filled at pay time from the POST body)
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft).not.toBeNull();
    expect(draft!.recipient.payoutDestination).toBe('');
    expect(draft!.recipient.payoutMethod).toBe('bank');
    // The approve card shows the placeholder, not "bank a/c on file"
    expect(ctaText).toContain("you'll enter the details on the secure page");
  });

  it('the draft is persisted with the enriched quote (totalChargeUsd is a number)', async () => {
    const ctx = await buildClearedCtx();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
    }, ctx);
    expect(typeof r.draft_id).toBe('string');
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft).not.toBeNull();
    expect(typeof draft!.quote.totalChargeUsd).toBe('number');
  });

  it('BLOCKED recipient (John Doe) → { blocked }, no draft/CTA, persists an audit row', async () => {
    const ctx = await buildClearedCtx();
    let ctaFetched = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      ctaFetched = true;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'John Doe', // on the test watchlist → blocked
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'john@upi',
    }, ctx);
    // New contract: a compliance block returns { blocked, reply_to_customer },
    // never an { error } the model would paraphrase as a technical glitch.
    expect(r.blocked).toBe(true);
    expect(typeof r.reply_to_customer).toBe('string');
    expect(String(r.reply_to_customer).toLowerCase()).not.toContain('went wrong');
    expect(r.sent).toBeUndefined();
    expect(r.draft_id).toBeUndefined();
    expect(ctaFetched).toBe(false);
    // The blocked attempt is now persisted as an auditable ledger row.
    const blocked = (await ctx.store.listTransfers()).filter((t) => t.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].recipientName).toBe('John Doe');
  });
});

describe('cancel_draft — typed cancel via active-draft pointer (Batch 1)', () => {
  it('cancels the active draft when there is no Cancel-button tap', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550004444');
    await ctx.customerStore.upsertOnFirstInbound('15550004444');
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx); // prime rates
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const picker = await executeTool('send_approve_picker', {
      amount_usd: 150, funding_method: 'bank_transfer', recipient_name: 'Mom',
      recipient_phone: '919876543210', payout_method: 'upi', payout_destination: 'mom@upi',
    }, ctx);
    expect(picker.sent).toBe(true);
    // typed 'cancel' → no buttonTap; cancelDraftTool falls back to the active-draft pointer
    const r = await executeTool('cancel_draft', {}, ctx);
    expect(r.cancelled).toBe(true);
    const again = await executeTool('cancel_draft', {}, ctx); // pointer cleared on consume
    expect(again.cancelled).toBe(false);
  });

  it('returns cancelled:false / no_active_draft when nothing is pending', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550005555');
    const r = await executeTool('cancel_draft', {}, ctx);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('no_active_draft');
  });
});

const baseQuote = (over: Partial<Quote> = {}): Quote => ({
  amountUsd: 500, feeUsd: 1.99, totalChargeUsd: 501.99, fxRate: 83, amountInr: 41500,
  deliveryEstimate: 'within 10 minutes', sourceCurrency: 'USD', amountSource: 500,
  feeSource: 1.99, totalChargeSource: 501.99, ...over,
});

describe('buildApproveSummary — enriched single approve body (A1/A2)', () => {
  it('renders FX rate, ETA, masked bank destination, and the rate-lock line', () => {
    // IN format stores the account LAST (composePayoutDestination order), so the
    // account tail is what surfaces.
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer');
    expect(s).toContain('1 USD = ₹83');
    expect(s).toContain('₹41,500');
    expect(s).toContain('within 10 minutes');
    expect(s).toContain('bank a/c ****6789');
    // The card now shows ONLY the last 4 — no IFSC/routing code, no IBAN body —
    // so it is leak-proof in every country format.
    expect(s).not.toContain('HDFC0001234');
    expect(s).toContain('Rate locked ~10 min');
  });
  it('masks the account even when fields arrive reversed (ifsc before acct) — never leaks the full number', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer');
    expect(s).toContain('bank a/c ****6789');
    expect(s).not.toContain('HDFC0001234');     // bank code is dropped entirely
    expect(s).not.toContain('123456789');       // the full account number must not appear
  });
  it('never leaks an AE IBAN (the previous heuristic showed it whole)', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'AE070331234567890123456', 'bank_transfer');
    expect(s).toContain('bank a/c ****3456');
    expect(s).not.toContain('AE070331234567890123456');
    expect(s).not.toContain('33123456789'); // no run of the IBAN body survives
  });
  it('never leaks a US account when routing and account are similar lengths', () => {
    // routing first, account second — both 9 digits; the account must not leak
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '021000021 123456789', 'bank_transfer');
    expect(s).toMatch(/bank a\/c \*\*\*\*\d{4}/);
    expect(s).not.toContain('123456789'); // full account never shown
    expect(s).not.toContain('021000021'); // full routing never shown either
  });
  it('never leaks a hyphenated NZ account number', () => {
    // NZ account is one hyphenated field (bank-branch-account-suffix). Under the
    // account-last rule the tail is the trailing run (the suffix) — still ≤4
    // digits, and the account body never appears, so it stays leak-proof.
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '01-0123-0123456-00', 'bank_transfer');
    expect(s).toMatch(/bank a\/c \*\*\*\*\d{1,4}/);
    expect(s).not.toContain('0123456');        // the account body must not appear
  });
  it('shows a UPI destination in full', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s).toContain('UPI mom@okhdfc');
  });
  it('first transfer (feeUsd 0) → "first transfer free" framing, NEVER "Fee $0.00"', () => {
    const s = buildApproveSummary(baseQuote({ feeUsd: 0, feeSource: 0 }), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s.toLowerCase()).toContain('first transfer free');
    expect(s).not.toContain('Fee $0.00');
  });
  it('a repeat transfer renders a concrete Fee line', () => {
    const s = buildApproveSummary(baseQuote({ feeUsd: 1.99, feeSource: 1.99 }), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s).toContain('Fee $1.99');
  });
  it('a GBP-source quote renders "1 GBP = ₹"', () => {
    const s = buildApproveSummary(baseQuote({ sourceCurrency: 'GBP', amountSource: 400, feeSource: 1.6 }), 'Mom', 'upi', 'mom@okhdfc', 'bank_transfer');
    expect(s).toContain('1 GBP = ₹');
    expect(s).toContain('£');
  });

  // Item 2: bank details collected on the secure pay page, not in chat. On a
  // cold-start draft there is no payout destination yet — the card shows a
  // placeholder instead of "bank a/c on file".
  it('empty payoutDestination → placeholder "their bank account (you\'ll enter the details on the secure page)"', () => {
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', '', 'bank_transfer');
    expect(s).toContain("their bank account (you'll enter the details on the secure page)");
    expect(s).not.toContain('bank a/c on file');
    expect(s).not.toContain('****');
  });

  it('non-empty payoutDestination keeps the masked "bank a/c ****<last4>" line', () => {
    // account composed LAST (IN order) → its tail is shown
    const s = buildApproveSummary(baseQuote(), 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer');
    expect(s).toContain('bank a/c ****6789');
    expect(s).not.toContain('their bank account (you');
  });
});

describe('validate_phone — read-only phone early-catch', () => {
  const call = (phone: unknown) =>
    executeTool('validate_phone', { phone }, {} as never); // ctx is never touched

  it('a clean 919876543210 → valid, normalized, + detected destination IN', async () => {
    expect(await call('919876543210')).toEqual({ valid: true, normalized: '919876543210', detected_destination_country: 'IN' });
  });
  it('a formatted "+91 98765 43210" → valid, normalized digits-only, detected IN', async () => {
    expect(await call('+91 98765 43210')).toEqual({ valid: true, normalized: '919876543210', detected_destination_country: 'IN' });
  });
  it('too-short "12345" → valid:false with a re-ask error', async () => {
    const r = await call('12345') as { valid: boolean; error: string };
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/valid/i);
  });
  it('junk/empty → valid:false', async () => {
    expect((await call('') as { valid: boolean }).valid).toBe(false);
    expect((await call('abc') as { valid: boolean }).valid).toBe(false);
  });
  it('performs no Redis I/O — runs with a bare ctx and still returns', async () => {
    // {} as never proves the handler reads nothing off ctx
    expect((await call('919876543210') as { valid: boolean }).valid).toBe(true);
  });
});

describe('resolve_recipient — typed-name lookup of saved recipients', () => {
  const seedRecipient = async (
    ctx: Awaited<ReturnType<typeof buildCtx>>,
    over: Partial<{ name: string; recipientPhone: string; payoutMethod: 'upi' | 'bank'; payoutDestination: string }> = {},
  ) => {
    await ctx.store.upsertRecipient(ctx.phone, {
      name: over.name ?? 'Mom',
      recipientPhone: over.recipientPhone ?? '919876543210',
      payoutMethod: over.payoutMethod ?? 'upi',
      payoutDestination: over.payoutDestination ?? 'mom@okhdfc',
      lastUsedAt: new Date().toISOString(),
    });
  };

  it('returns match:exact for a single case-insensitive, trimmed name match with payout details', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210', payoutDestination: 'mom@okhdfc' });
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111', payoutDestination: 'dad@okaxis' });
    const r = await executeTool('resolve_recipient', { name: '  mOm ' }, ctx);
    expect(r.match).toBe('exact');
    expect((r.recipient as Record<string, unknown>).recipient_phone).toBe('919876543210');
    expect((r.recipient as Record<string, unknown>).payout_destination).toBe('mom@okhdfc');
    // field hygiene: no internal fields leak
    expect(r.recipient).not.toHaveProperty('partnerId');
    expect(r.recipient).not.toHaveProperty('complianceStatus');
  });

  it('returns match:ambiguous when two saved recipients share the name', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919876543210' });
    await seedRecipient(ctx, { name: 'Mom', recipientPhone: '919800000000' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(2);
  });

  it('returns match:ambiguous for a partial/substring match (never auto-proceeds)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Mom (work)', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    expect((r.candidates as unknown[]).length).toBe(1);
  });

  it('returns match:none when nothing matches (cold-start path)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedRecipient(ctx, { name: 'Dad', recipientPhone: '919811111111' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none');
  });

  it('only searches the calling sender\'s own recipients', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15551234567');
    const otherCtx = await buildCtx(redis, '15559999999');
    await seedRecipient(otherCtx, { name: 'Mom', recipientPhone: '919876543210' });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('none'); // the other sender's recipient is invisible
  });
});

describe('maskAccount — exported helper', () => {
  it('UPI: returns the address unchanged', () => {
    expect(maskAccount('upi', 'mom@okhdfc')).toBe('mom@okhdfc');
  });

  it('bank: collapses to ****<last4> of the account (the LAST composed field)', () => {
    // composePayoutDestination stores the account LAST, so its tail is shown;
    // nothing else (routing/IFSC) surfaces.
    expect(maskAccount('bank', 'HDFC0001234 123456789')).toBe('****6789');
  });

  it('bank: the trailing account run is what surfaces, not a leading code', () => {
    // SBIN0001234 then the account → account tail wins
    expect(maskAccount('bank', 'SBIN0001234 987654321')).toBe('****4321');
  });

  it('bank: never includes the raw account number, even with no spaces (IBAN)', () => {
    const result = maskAccount('bank', 'AE070331234567890123456');
    expect(result).not.toContain('AE070331234567890123456');
    expect(result).toBe('****3456');
  });
});

describe('list_saved_recipients — payout_destination masking (Fix #1)', () => {
  it('bank recipient: full account number does NOT appear; last 4 do', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: 'HDFC0001234 123456789', // account composed LAST
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('list_saved_recipients', {}, ctx);
    const rec = (r.recipients as Record<string, unknown>[])[0];
    expect(String(rec.payout_destination)).not.toContain('123456789');
    expect(String(rec.payout_destination)).toContain('6789');
  });

  it('UPI recipient: payout_destination returned unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Dad',
      recipientPhone: '919811111111',
      payoutMethod: 'upi',
      payoutDestination: 'dad@okaxis',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('list_saved_recipients', {}, ctx);
    const rec = (r.recipients as Record<string, unknown>[])[0];
    expect(rec.payout_destination).toBe('dad@okaxis');
  });
});

describe('resolve_recipient — payout_destination masking (Fix #1)', () => {
  it('bank recipient: full account does NOT appear in exact match result', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Priya',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: 'SBIN0001234 987654321', // account composed LAST
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Priya' }, ctx);
    expect(r.match).toBe('exact');
    const dest = String((r.recipient as Record<string, unknown>).payout_destination);
    expect(dest).not.toContain('987654321');
    expect(dest).toContain('4321');
  });

  it('bank recipient: full account does NOT appear in ambiguous candidates', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'bank',
      payoutDestination: '111222333444 HDFC0001234',
      lastUsedAt: new Date().toISOString(),
    });
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Mom',
      recipientPhone: '919800000000',
      payoutMethod: 'bank',
      payoutDestination: '555666777888 ICIC0001234',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Mom' }, ctx);
    expect(r.match).toBe('ambiguous');
    for (const c of r.candidates as Record<string, unknown>[]) {
      expect(String(c.payout_destination)).not.toContain('111222333444');
      expect(String(c.payout_destination)).not.toContain('555666777888');
    }
  });

  it('UPI exact match: payout_destination stays unmasked', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.store.upsertRecipient(ctx.phone, {
      name: 'Ravi',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'ravi@okhdfc',
      lastUsedAt: new Date().toISOString(),
    });
    const r = await executeTool('resolve_recipient', { name: 'Ravi' }, ctx);
    expect(r.match).toBe('exact');
    expect((r.recipient as Record<string, unknown>).payout_destination).toBe('ravi@okhdfc');
  });
});

describe('get_quote cap guard (Bundle D)', () => {
  it('refuses an over-per-transfer amount with a cap result (no quote)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 700, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
    expect(r.fee_usd).toBeUndefined();        // NO quote presented
    expect(r.amount_inr).toBeUndefined();
    expect(r.kyc_url).toBeUndefined();        // gate-off partner ⇒ no verify handoff
    expect(r.per_transfer_cap_usd).toBe(500);
  });

  it('refuses an over-daily amount and reports the remaining', async () => {
    const ctx = await buildCtx(fakeRedis());
    await ctx.dailyVolumeStore.addCents(PHONE, 40_000); // $400 already used today
    const r = await executeTool('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_remaining_usd).toBe(100); // $500 cap − $400 used
    expect(r.fee_usd).toBeUndefined();
  });

  it('guards the receive-first (amount_inr) path too', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 70000 INR / 85 ≈ $823 USD-equiv → over the $500 per-transfer cap
    const r = await executeTool('get_quote', { amount_inr: 70000, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.fee_usd).toBeUndefined();
  });

  it('still returns a normal quote when within cap (no within_cap field)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 300, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBeUndefined();     // success path unchanged
    expect(r.fee_usd).toBe(0);                // first transfer free
    expect(r.amount_inr).toBe(Math.round(300 * MOCK_RATE));
  });
});

describe('create_transfer records the sender\'s funding method (Bundle C)', () => {
  it('writes lastFundingMethod onto the customer after a successful create', async () => {
    const ctx = await buildCtx(fakeRedis());
    await executeTool('create_transfer', {
      amount_usd: 200,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'credit_card',
    }, ctx);
    const c = await ctx.customerStore.getCustomer(ctx.phone);
    expect(c?.lastFundingMethod).toBe('credit_card');
  });
});

describe('repeat_transfer — reactive re-send to a past recipient (Bundle C)', () => {
  const seedPastTransfer = async (ctx: Awaited<ReturnType<typeof buildCtx>>) => {
    // A real create so the recipient + a past transfer exist with full details.
    // $200 (not $500) so a repeat stays within the T0 $500/day cap and exercises
    // the REAL cap gate inside repeat_transfer rather than tripping it.
    await executeTool('create_transfer', {
      amount_usd: 200,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@okhdfc',
      funding_method: 'bank_transfer',
    }, ctx);
  };

  it('hydrates the last transfer and sends an approve card (a draft, NOT a new transfer)', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const countBefore = await ctx.store.getTransferCount(ctx.phone);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    // routed through the draft path — no new transfer created yet
    expect(await ctx.store.getTransferCount(ctx.phone)).toBe(countBefore);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    // Repeats must carry the REAL account into the new draft — hydrated from the
    // saved recipient (decrypted), never the masked default ledger read.
    expect(draft?.recipient.payoutDestination).toBe('mom@okhdfc');
    expect(draft?.amountSource).toBe(200); // reused last amount
  });

  it('honors an amount_usd override', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 250 }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.amountSource).toBe(250);
  });

  it('falls back to the sender\'s remembered funding method when none is given', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx); // last transfer used bank_transfer + records it as the default
    await ctx.customerStore.recordFundingMethod(ctx.phone, 'credit_card'); // newer default
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210' }, ctx);
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.fundingMethod).toBe('credit_card');
  });

  it('errors when there is no past transfer to that number', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('repeat_transfer', { recipient_phone: '910000000000' }, ctx);
    expect(r.error).toBeDefined();
    expect(r.sent).toBeUndefined();
  });

  it('returns needs_edd (and does NOT send a card) when the month is over the EDD threshold', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPastTransfer(ctx);
    // push cumulative monthly volume over $3,000 so evaluateEdd trips; customer has no SoF/occupation
    await ctx.monthlyVolumeStore.addCents(ctx.phone, 300000);
    const r = await executeTool('repeat_transfer', { recipient_phone: '919876543210', amount_usd: 100 }, ctx);
    expect(r.needs_edd).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(r.payout_destination).toBe('mom@okhdfc'); // REAL destination for the follow-up card
  });
});

describe('any-to-any corridors — destination_country threading', () => {
  // AED fallback rate: 1 USD = 1/0.27 ≈ 3.703 AED (from FALLBACK_FX_RATES.AED.toUsd = 0.27).
  // USD→AED cross rate = USD.toUsd / AED.toUsd = 1 / 0.27 ≈ 3.703.
  // For $500 USD: amountInr (= AED dest) = Math.round(500 * (1/0.27)) = Math.round(500 * 3.7037) = 1852.
  // Note: getFxRates('AED') for INR destination will return FALLBACK; for source USD it's already cached.

  function stubAedFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=AED')) {
        // AED rates: toInr=23.1, toUsd=0.27
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      // USD rates: toInr=85 (standard mock)
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
  }

  it('get_quote with destination_country AE returns destination_currency AED and amount_dest in AED (≠ INR amount)', async () => {
    resetRateCacheForTests();
    stubAedFetch();
    const ctx = await buildCtx(fakeRedis());
    // Prime USD rates first (avoids AED mock intercepting a USD call)
    const r = await executeTool('get_quote', {
      amount_usd: 500,
      funding_method: 'bank_transfer',
      destination_country: 'AE',
    }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.destination_currency).toBe('AED');
    expect(r.destination_country).toBe('AE');
    // amount_dest == amount_inr (same value, clearer alias for non-India)
    expect(r.amount_dest).toBe(r.amount_inr);
    // AED amount should NOT equal the INR amount for the same $500 send
    // INR: Math.round(500 * 85) = 42500; AED: Math.round(500 / 0.27) ≈ 1852
    expect(r.amount_inr).toBeLessThan(10000); // AED is much smaller than INR
    expect(r.amount_inr).toBeGreaterThan(0);
    // The rate is the cross-rate USD→AED ≈ 3.7
    expect((r.fx_rate as number)).toBeCloseTo(1 / 0.27, 1);
  });

  it('get_quote with NO destination_country defaults to India (INR, back-compat)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool('get_quote', {
      amount_usd: 500,
      funding_method: 'bank_transfer',
    }, ctx);
    expect(r.destination_currency).toBe('INR');
    expect(r.destination_country).toBe('IN');
    expect(r.amount_inr).toBe(Math.round(500 * MOCK_RATE));
  });

  it('send_approve_picker to AE creates a draft with destinationCurrency AED in the quote', async () => {
    resetRateCacheForTests();
    stubAedFetch();
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15550099999');
    await ctx.customerStore.upsertOnFirstInbound('15550099999');
    // Prime the rate cache for USD first
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=AED')) {
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      // WhatsApp API or USD
      if (u.startsWith('https://graph.facebook.com/') || u.includes('whatsapp')) {
        return { ok: true, text: async () => '' };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200,
      funding_method: 'bank_transfer',
      recipient_name: 'Ali',
      recipient_phone: '971501234567',
      payout_method: 'bank',
      payout_destination: 'AE12 0000 0000 0000 1234 567',
      destination_country: 'AE',
    }, ctx);
    expect(r.sent).toBe(true);
    expect(typeof r.draft_id).toBe('string');
    const draft = await ctx.draftStore.consumeDraft(r.draft_id as string);
    expect(draft).not.toBeNull();
    expect(draft!.destinationCurrency).toBe('AED');
    expect(draft!.destinationCountry).toBe('AE');
    expect(draft!.quote.destinationCurrency).toBe('AED');
  });

  it('buildApproveSummary with AED destination formats rate and dest amount in AED (not ₹)', () => {
    const q = baseQuote({
      fxRate: 3.7,      // USD→AED cross rate
      amountInr: 1850,  // AED dest amount (field name kept for back-compat)
      destinationCurrency: 'AED',
    });
    const s = buildApproveSummary(q, 'Ali', 'bank', 'AE12 0000 0000 0000 1234 567', 'bank_transfer', 'AED');
    // Should show AED, not INR (₹)
    expect(s).toContain('AED');
    expect(s).not.toContain('₹');
    expect(s).toContain('1 USD = AED');
  });
});

describe('Phase 3 verify-before-send gate (bot tools)', () => {
  const UNVERIFIED = '15557770000';

  // Seed an unverified (grandfathered) customer under a partner that has
  // OPTED IN to verify-before-send (the gate is partner-configured now —
  // an unconfigured partner never gates).
  async function seedUnverified(ctx: Awaited<ReturnType<typeof buildCtx>>) {
    const nowIso = new Date().toISOString();
    const dflt = await ctx.partnerStore.ensureDefaultPartner();
    await ctx.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: nowIso });
    await ctx.customerStore.saveCustomer({
      senderPhone: ctx.phone, firstSeenAt: nowIso, kycStatus: 'grandfathered',
      senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
  }

  it('check_send_limit returns within_cap:false + reason kyc_required + a kyc_url; no cap fields needed', async () => {
    const ctx = await buildCtx(fakeRedis(), UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('check_send_limit', { amount_usd: 100 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('kyc_required');
    expect(typeof r.kyc_url).toBe('string');
  });

  it('get_quote returns within_cap:false + kyc_url and does NOT produce a quote', async () => {
    const ctx = await buildCtx(fakeRedis(), UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('kyc_required');
    expect(typeof r.kyc_url).toBe('string');
    expect(r.amount_inr).toBeUndefined(); // no quote built
  });

  it('create_transfer (legacy path) returns kyc_required and creates NO transfer', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('create_transfer', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, ctx);
    expect(r.kyc_required).toBe(true);
    expect(r.reason).toBe('kyc_required');
    expect(typeof r.kyc_url).toBe('string');
    expect(await ctx.store.listTransfers()).toHaveLength(0);
  });

  it('send_approve_picker returns kyc_required and creates NO draft', async () => {
    const ctx = await buildCtx(fakeRedis(), UNVERIFIED);
    await seedUnverified(ctx);
    const r = await executeTool('send_approve_picker', {
      amount_usd: 100, recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
    }, ctx);
    expect(r.kyc_required).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(r.draft_id).toBeUndefined();
  });
});

describe('KYC gate OFF — cap refusals never surface verification (QA audit fix)', () => {
  // The default seeded partner has requireKycBeforeSend unset ⇒ gate OFF.
  // A T0 customer over their cap must get the plain cap refusal: no kyc_url,
  // and — critically — NO kycProvider.startVerification side effect (it creates
  // a real Persona inquiry in production).

  it('check_send_limit over-cap: refusal fields intact, no kyc_url, no startVerification', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550002222');
    const startSpy = vi.spyOn(ctx.kycProvider, 'startVerification');
    const r = await executeTool('check_send_limit', { amount_usd: 5000 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
    expect(r.tier).toBe('T0');
    expect(r.daily_cap_usd).toBe(500);
    expect(r.today_remaining_usd).toBe(500);
    expect(r.kyc_url).toBeUndefined();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('get_quote over-cap: refusal fields intact, no kyc_url, no startVerification', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550002222');
    const startSpy = vi.spyOn(ctx.kycProvider, 'startVerification');
    const r = await executeTool('get_quote', { amount_usd: 5000, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.tier).toBe('T0');
    expect(r.kyc_url).toBeUndefined();
    expect(r.amount_inr).toBeUndefined(); // still no quote built
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('gate ON: the same T0 over-cap refusal still hands off a kyc_url', async () => {
    const ctx = await buildCtx(fakeRedis(), '15550002222');
    const nowIso = new Date().toISOString();
    const dflt = await ctx.partnerStore.ensureDefaultPartner();
    await ctx.partnerStore.savePartner({ ...dflt, requireKycBeforeSend: true, updatedAt: nowIso });
    const startSpy = vi.spyOn(ctx.kycProvider, 'startVerification');
    const r = await executeTool('check_send_limit', { amount_usd: 5000 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(typeof r.kyc_url).toBe('string');
    expect(startSpy).toHaveBeenCalled();
  });
});

describe('best-rate routing (B2) — quote → draft → mint', () => {
  // Stub integrations + routable-rail shape, mirroring tests/partner-rates.test.ts.
  const ROUTABLE = {
    providerType: 'simulator',
    credentials: { settlementUrl: 'https://rail.test/x', signingSecret: 's' },
  };
  function stubIntegrations(byPartner: Record<string, PartnerIntegrations['payment']>): PartnerIntegrationsStore {
    return {
      getIntegrations: async (partnerId: string) => ({
        kyc: {}, whatsapp: {}, payment: byPartner[partnerId] ?? {},
      }),
    } as unknown as PartnerIntegrationsStore;
  }
  // The REAL selection service over the test PGlite, shaped as ToolContext.routeSelector.
  function realSelector(byPartner: Record<string, PartnerIntegrations['payment']>) {
    return (s: CurrencyCode, d: CurrencyCode, m: number) =>
      selectSettlementRoute(db, stubIntegrations(byPartner), s, d, m);
  }
  // A canned winning route (unit seam) — id chosen so no random transfer id can contain it.
  const WIN = { fxRate: 86, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' };

  const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

  it('get_quote (default tenant): the REAL selector wins the corridor — fxRate + amountInr override, fees/USD-equivalent unchanged', async () => {
    const ctx = await buildCtx(fakeRedis());
    await seedPartner(db, 'rail-partner-x');
    await createPartnerRateRepo(db).upsertRate({
      id: 'r1', partnerId: 'rail-partner-x', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 86, expiresAt: inOneHour(),
    });
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: realSelector({ 'rail-partner-x': ROUTABLE }) },
    );
    expect(r.fx_rate).toBe(86);                       // the winning rate, not mid (85)
    expect(r.amount_inr).toBe(Math.round(400 * 86));  // 34,400 — quote()'s exact rounding
    expect(r.amount_dest).toBe(r.amount_inr);
    expect(r.fee_usd).toBe(0);                        // fees are rate-independent
    expect(r.amount_usd).toBe(400);                   // USD-equivalent (caps) unchanged
    // Customer invisibility: the routing partner never appears in the result.
    expect(JSON.stringify(r)).not.toContain('rail-partner-x');
  });

  it('get_quote: a platform route (no winner) leaves the result byte-identical to the no-selector quote', async () => {
    const ctx = await buildCtx(fakeRedis());
    const baseline = await executeTool('get_quote', { amount_usd: 400, funding_method: 'bank_transfer' }, ctx);
    const routed = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async (_s, _d, m) => ({ fxRate: m, source: 'platform' as const }) },
    );
    expect(routed).toEqual(baseline);
  });

  it('get_quote: the selector receives the mid cross-rate; a throwing selector fail-opens to mid (never a blocker)', async () => {
    const ctx = await buildCtx(fakeRedis());
    const spy = vi.fn(async () => { throw new Error('rates outage'); });
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: spy },
    );
    expect(spy).toHaveBeenCalledWith('USD', 'INR', MOCK_RATE); // mid in, fail-open out
    expect(r.error).toBeUndefined();
    expect(r.fx_rate).toBe(MOCK_RATE);
    expect(r.amount_inr).toBe(Math.round(400 * MOCK_RATE));
  });

  it('get_quote receive-first (amount_inr): back-solves with the WINNING rate so the recipient gets the exact target', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 34,400 / 86 = 400 exactly; at mid (85) the back-solve would be 404.71.
    const r = await executeTool(
      'get_quote',
      { amount_inr: 34_400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => WIN },
    );
    expect(r.fx_rate).toBe(86);
    expect(r.amount_source).toBe(400);     // winning-rate back-solve, NOT 404.71
    expect(r.amount_inr).toBe(34_400);     // the exact target lands
    expect(r.fee_usd).toBe(0);
  });

  it('receive-first: a winning back-solve that dips under MIN_USD falls back to the mid quote (never a blocker)', async () => {
    const ctx = await buildCtx(fakeRedis());
    // 855/85 = $10.06 (≥ MIN_USD) at mid, but 855/86 = $9.94 (< MIN_USD) at
    // the winning rate — the better rate must NOT turn a valid quote into a refusal.
    const r = await executeTool(
      'get_quote',
      { amount_inr: 855, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => WIN },
    );
    expect(r.error).toBeUndefined();
    expect(r.fx_rate).toBe(MOCK_RATE);            // mid quote preserved
    expect(r.amount_source).toBeCloseTo(10.06, 2);
  });

  it('receive-first on a non-INR corridor back-solves via the cross-rate (recipient gets the target DEST amount, not rupees)', async () => {
    // any-to-any fix: amount_inr=1000 with an AE destination means AED 1000 the
    // RECIPIENT receives (the destination currency), NOT ₹1000. sourceForDest
    // back-solves via the USD-pivot cross-rate (USD→AED ≈ 3.7037), so the mid
    // send ≈ $270 and the recipient gets exactly AED 1000. A better route (3.8)
    // yields a SMALLER send (≈ $263.16 ≤ the cap-checked $270), so it applies.
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('from=AED')) {
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'get_quote',
      { amount_inr: 1000, funding_method: 'bank_transfer', destination_country: 'AE' },
      { ...ctx, routeSelector: async () => ({ fxRate: 3.8, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' }) },
    );
    expect(r.error).toBeUndefined();
    expect(r.destination_currency).toBe('AED');
    expect(r.amount_inr as number).toBeCloseTo(1000, 0);   // recipient gets AED 1000 (NOT ₹1000)
    expect(r.fx_rate as number).toBeCloseTo(3.8, 4);       // the better route applies (smaller send)
    expect(r.amount_source as number).toBeCloseTo(263.16, 1); // 1000/3.8, NOT ~11.76 (the old ÷toInr bug)
  });

  it('a worse-than-mid "partner" route is rejected at the seam — the customer never quotes below mid', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => ({ fxRate: 84, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' }) },
    );
    expect(r.fx_rate).toBe(MOCK_RATE);
    expect(r.amount_inr).toBe(Math.round(400 * MOCK_RATE));
  });

  it('a "partner" route missing settlementPartnerId is rejected — a partner rate can never pair with a platform settle', async () => {
    const ctx = await buildCtx(fakeRedis());
    const r = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: async () => ({ fxRate: 86, source: 'partner' as const }) },
    );
    expect(r.fx_rate).toBe(MOCK_RATE); // no rail ⇒ no route ⇒ mid
  });

  it('white-label tenant: the selector is NEVER called — the customer is pinned to their partner at mid', async () => {
    const redis = fakeRedis();
    const ctx = await buildCtx(redis, '15558887777');
    await seedPartner(db, 'acme');
    const nowIso = new Date().toISOString();
    await ctx.customerStore.saveCustomer({
      senderPhone: '15558887777', firstSeenAt: nowIso, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'acme', optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
    const spy = vi.fn(async () => WIN);
    const quoted = await executeTool(
      'get_quote',
      { amount_usd: 400, funding_method: 'bank_transfer' },
      { ...ctx, routeSelector: spy },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(quoted.fx_rate).toBe(MOCK_RATE);

    // send_approve_picker is pinned the same way.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const picker = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer',
      recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi',
    }, { ...ctx, routeSelector: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(picker.sent).toBe(true);
    const draft = await ctx.draftStore.consumeDraft(picker.draft_id as string);
    expect(draft?.quote.fxRate).toBe(MOCK_RATE);
    expect(draft?.settlementPartnerId).toBeUndefined();
  });

  it('send_approve_picker stores the winning route on the draft; the card shows ONLY the better rate', async () => {
    const redis = fakeRedis();
    const ctx0 = await buildCtx(redis, '15550007777');
    await executeTool('get_quote', { amount_usd: 100, funding_method: 'bank_transfer' }, ctx0); // prime FX cache
    let ctaText = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const cta = (body?.interactive as Record<string, unknown>)?.body as Record<string, unknown> | undefined;
      if (cta && typeof cta.text === 'string') ctaText = cta.text;
      return { ok: true, text: async () => '' };
    }));
    const r = await executeTool('send_approve_picker', {
      amount_usd: 200, funding_method: 'bank_transfer',
      recipient_name: 'Mom', recipient_phone: '919876543210',
      payout_method: 'upi', payout_destination: 'mom@upi',
    }, { ...ctx0, routeSelector: async () => WIN });
    expect(r.sent).toBe(true);
    // The draft carries the route — rate-dependent quote fields + the rail partner.
    const draft = await ctx0.draftStore.consumeDraft(r.draft_id as string);
    expect(draft?.settlementPartnerId).toBe('rail-partner-x');
    expect(draft?.quote.fxRate).toBe(86);
    expect(draft?.quote.amountInr).toBe(Math.round(200 * 86)); // 17,200
    expect(draft?.amountUsd).toBe(200); // USD-equivalent for caps — rate-independent
    // The customer sees only the better rate; never the routing partner.
    expect(ctaText).toContain('₹86');
    expect(ctaText).toContain('₹17,200');
    expect(ctaText).not.toContain('rail-partner-x');
    expect(JSON.stringify(r)).not.toContain('rail-partner-x');
  });

  it('approve-tap mint: the draft route + draft quote mint VERBATIM (settlementPartnerId + winning fxRate)', async () => {
    const redis = fakeRedis();
    const base = await buildCtx(redis, '15550008888');
    await seedPartner(db, 'rail-partner-x');
    const draftId = await base.draftStore.createDraft({
      senderPhone: base.phone,
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
      amountUsd: 200,
      amountSource: 200,
      sourceCurrency: 'USD',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 86, amountInr: 17_200, feeSource: 0, totalChargeSource: 200, totalChargeUsd: 200 },
      settlementPartnerId: 'rail-partner-x',
    });
    const ctx = { ...base, turn: { isNewConversation: false, buttonTap: { kind: 'approve' as const, draftId } } };
    const r = await executeTool('create_transfer', {}, ctx);
    expect(r.error).toBeUndefined();
    const t = await ctx.store.getTransfer(r.transfer_id as string);
    expect(t?.settlementPartnerId).toBe('rail-partner-x'); // the winning rail
    expect(t?.fxRate).toBe(86);                            // the draft's (winning) rate, not a re-quote at 85
    expect(t?.amountInr).toBe(17_200);
    expect(t?.feeUsd).toBe(0);
    expect(t?.partnerId).toBe('default');                  // ownership unchanged
    // Tool result (fed to the LLM) leaks nothing about the routing partner.
    expect(JSON.stringify(r)).not.toContain('rail-partner-x');
  });
});

