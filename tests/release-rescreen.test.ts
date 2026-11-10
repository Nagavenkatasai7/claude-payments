/**
 * Fix pack 2 review F1 (A1): freshness at release and the heal path.
 *
 *  • releaseTransfer on a REAL-MONEY rail (http, env not 'test') whose newest
 *    evidence is not liveFresh (older than 36 h, not on a live list, no
 *    evidence, or evidence without listFitness) re-screens on file FIRST. The
 *    release goes on only after a live, fresh, clear result; otherwise the row
 *    stays held (LIST_UNAVAILABLE when the list is not live, the block path on
 *    a match) and the caller gets ONE fixed refusal (no name, no match detail,
 *    the same text for a match and a list outage).
 *  • Not real money (simulator, mock, 'test'): unchanged.
 *  • Heal: a PAID real-money row whose instruct was refused for an old screen
 *    is re-screened by the reconcile sweep, and the next instruct attempt passes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { beginHold } from '@/lib/settlement';
import { canReleaseHeld, releaseTransfer, RESCREEN_RELEASE_REFUSAL } from '@/lib/dashboard-ops';
import { LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep } from '@/lib/reconcile';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';

vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => {} };
});

const H = 3_600_000;
const SENDER_PHONE = '15551230000';
const SENDER = 'Alex Sender';
const REL = { actor: 'plat', reason: 'checked' };
const STORED = 'https://rail.partner.example/settle';
const PLATFORM = { kind: 'platform' } as const;

let db: Db;
let store: ReturnType<typeof createStore>;
const originalList = process.env.SANCTIONS_LIST;
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

async function rail(partnerId: string, providerType: string) {
  await createIntegrationsRepo(db, provider).saveIntegrations(partnerId, {
    kyc: {},
    payment: { providerType, credentials: { settlementUrl: STORED, signingSecret: 'sgn' }, webhookSecret: 'whk' },
    whatsapp: {},
  });
}

function base(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER_PHONE, amountUsd: 1500, feeUsd: 5, totalChargeUsd: 1505,
    fxRate: 83, amountInr: 124500, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 41 * H).toISOString(), partnerId: 'acme', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 1500, feeSource: 5, totalChargeSource: 1505,
    ...o,
  } as Transfer;
}

/** A LARGE_AMOUNT hold (platform/partner releasable) screened `screenedAgoMs` ago on a live list. */
async function heldLarge(
  o: Partial<Transfer> & { id: string },
  ev: { screenedAgoMs?: number; listFitness?: 'live' | 'not_live' | null; none?: boolean; recipientName?: string } = {},
): Promise<Transfer> {
  const t = base(o);
  await store.saveTransfer(t);
  if (!ev.none) {
    const ago = ev.screenedAgoMs ?? 40 * H;
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: ev.recipientName ?? t.recipientName, senderName: SENDER },
      { screenedAgoMs: ago, at: new Date(Date.now() - ago), ...(ev.listFitness !== undefined ? { listFitness: ev.listFitness } : {}) },
    );
  }
  expect(await beginHold(db, t, { addReasons: [LARGE_AMOUNT_REASON] })).toEqual({ kind: 'held' });
  return t;
}

type AuditRow = { actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function auditRows(subject: string): Promise<AuditRow[]> {
  const r = await db.execute(sql`SELECT actor, actor_type, action, subject_id, meta FROM audit_events WHERE subject_id = ${subject} ORDER BY id`);
  return (r as unknown as { rows: AuditRow[] }).rows;
}
async function keys(): Promise<Array<string | null>> {
  const r = await db.execute(sql`SELECT dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ dedupe_key: string | null }> }).rows.map((x) => x.dedupe_key);
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  const nowIso = new Date().toISOString();
  await createCustomerStore(db, store).saveCustomer({
    senderPhone: SENDER_PHONE, firstSeenAt: nowIso, kycStatus: 'verified', fullName: SENDER,
    senderCountry: 'US', partnerId: 'acme', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  });
});
afterEach(() => restoreOfacSource(originalList));

describe('releaseTransfer — real-money freshness (review F1/A1)', { retry: 0 }, () => {
  it('http, LARGE_AMOUNT hold, newest evidence live but 40 h old, list live: re-screened first, then released', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_old' });
    await releaseTransfer(store, db, 'rr_old', REL);
    const after = await store.getTransfer('rr_old');
    expect(after?.status).toBe('paid');
    const rows = await auditRows('rr_old');
    const screens = rows.filter((a) => a.action === 'sanctions.screen');
    expect(screens).toHaveLength(2);
    expect(screens[1].meta).toMatchObject({ decision: 'clear', listFitness: 'live' });
    expect(Date.now() - Date.parse(String(screens[1].meta.screenedAt))).toBeLessThan(60_000);
    expect(rows.filter((a) => a.action === 'transfer.release')).toEqual([
      expect.objectContaining({ actor: 'plat', actor_type: 'staff', meta: expect.objectContaining({ previousStatus: 'in_review', newStatus: 'paid' }) }),
    ]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual(['instruct:rr_old']);
  });

  it('http, 40 h old screen, list NOT live: refused with the fixed text, held with LIST_UNAVAILABLE (sweep owns it), no instruct', async () => {
    primeOfacSource({ checkedAgoMs: 40 * H }); // stale list
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_stale' });
    await expect(releaseTransfer(store, db, 'rr_stale', REL)).rejects.toThrow(RESCREEN_RELEASE_REFUSAL);
    const after = await store.getTransfer('rr_stale');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    expect(canReleaseHeld(PLATFORM, { kycMode: 'ours' }, after!, null)).toBe(false);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
    const rows = await auditRows('rr_stale');
    expect(rows.filter((a) => a.action === 'transfer.release')).toEqual([]);
    expect(rows.filter((a) => a.action === 'transfer.rescreen')).toEqual([
      expect.objectContaining({
        actor: 'plat',
        meta: expect.objectContaining({ previousReasons: [LARGE_AMOUNT_REASON], newReasons: [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON] }),
      }),
    ]);
  });

  it('http, 40 h old screen, re-screen matches: blocked with the notices, the SAME fixed text (no name), no instruct', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_match', recipientName: 'Testa Fixturelli' }, { recipientName: 'Testa Fixturelli' });
    let msg = '';
    try {
      await releaseTransfer(store, db, 'rr_match', REL);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(RESCREEN_RELEASE_REFUSAL);
    expect(msg.toLowerCase()).not.toContain('testa');
    expect(msg.toLowerCase()).not.toMatch(/match|watchlist/);
    const after = await store.getTransfer('rr_match');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('blocked');
    expect(after?.complianceReasons).toContain(RECIPIENT_WATCHLIST_REASON);
    const k = await keys();
    expect(k).toContain('sanctionsblock:rr_match');
    expect(k.filter((x) => x?.startsWith('instruct:'))).toEqual([]);
    expect((await auditRows('rr_match')).map((a) => a.action)).toContain('sanctions.block');
  });

  it('http, 40 h old screen, a name screened before cannot be screened again: held with SENDER_IDENTITY_MISSING, the same text', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    const t = base({ id: 'rr_unc' });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: 'Body Only Name' },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    expect(await beginHold(db, t, { addReasons: [LARGE_AMOUNT_REASON] })).toEqual({ kind: 'held' });
    await expect(releaseTransfer(store, db, 'rr_unc', REL)).rejects.toThrow(RESCREEN_RELEASE_REFUSAL);
    const after = await store.getTransfer('rr_unc');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, SENDER_IDENTITY_MISSING_REASON]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
  });

  it('partner-scoped release: a match and a list outage give the same refusal text', async () => {
    await rail('acme', 'http');
    primeOfacSource({ checkedAgoMs: 40 * H });
    await heldLarge({ id: 'rr_p_list' });
    const outage = await releaseTransfer(store, db, 'rr_p_list', REL, { partnerId: 'acme' }).catch((e: Error) => e.message);
    primeOfacSource({ checkedAgoMs: H });
    await heldLarge({ id: 'rr_p_match', recipientName: 'Testa Fixturelli' }, { recipientName: 'Testa Fixturelli' });
    const match = await releaseTransfer(store, db, 'rr_p_match', REL, { partnerId: 'acme' }).catch((e: Error) => e.message);
    expect(outage).toBe(RESCREEN_RELEASE_REFUSAL);
    expect(match).toBe(outage);
  });

  it.each([
    ['no evidence at all', { none: true }],
    ['evidence without listFitness', { listFitness: null, screenedAgoMs: H }],
    ['not-live evidence', { listFitness: 'not_live' as const, screenedAgoMs: H }],
  ])('http, %s, list live: re-screened first, then released', async (_label, ev) => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_none' }, ev);
    const before = (await auditRows('rr_none')).filter((a) => a.action === 'sanctions.screen').length;
    await releaseTransfer(store, db, 'rr_none', REL);
    expect((await store.getTransfer('rr_none'))?.status).toBe('paid');
    expect((await auditRows('rr_none')).filter((a) => a.action === 'sanctions.screen')).toHaveLength(before + 1);
  });

  it('http, newest evidence live and fresh: released with no re-screen', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_fresh' }, { screenedAgoMs: H });
    await releaseTransfer(store, db, 'rr_fresh', REL);
    expect((await store.getTransfer('rr_fresh'))?.status).toBe('paid');
    expect((await auditRows('rr_fresh')).filter((a) => a.action === 'sanctions.screen')).toHaveLength(1);
  });

  it.each([
    ['simulator rail', 'simulator', 'live'],
    ['mock rail', 'mock', 'live'],
    ["env 'test' on an http rail", 'http', 'test'],
  ])('%s, 40 h old screen, list not live: release unchanged (no re-screen)', async (_label, type, environment) => {
    primeOfacSource({ checkedAgoMs: 40 * H });
    await rail('acme', type);
    await heldLarge({ id: 'rr_demo', environment: environment as Transfer['environment'] });
    await releaseTransfer(store, db, 'rr_demo', REL);
    expect((await store.getTransfer('rr_demo'))?.status).toBe('paid');
    expect((await auditRows('rr_demo')).filter((a) => a.action === 'sanctions.screen')).toHaveLength(1);
  });

  it('absent rail config (default mock): release unchanged', async () => {
    primeOfacSource({ checkedAgoMs: 40 * H });
    await heldLarge({ id: 'rr_absent' });
    await releaseTransfer(store, db, 'rr_absent', REL);
    expect((await store.getTransfer('rr_absent'))?.status).toBe('paid');
  });
});

describe('heal path: a paid real-money row refused for an old screen (review F1/A1)', { retry: 0 }, () => {
  const fetchFn = vi.fn();
  const deps = (): WorkerDeps => ({
    db, store,
    sendText: (async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: (async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: (async () => '') as unknown as WorkerDeps['runAgentTurn'],
  });

  it('instruct refused (40 h old screen) -> the sweep re-screens it -> the next instruct attempt POSTs', async () => {
    fetchFn.mockReset();
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'heal-1' }) });
    await rail('acme', 'http');
    const t = base({ id: 'rr_heal', status: 'paid', paidAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    await db.execute(sql`INSERT INTO outbox (kind, payload, dedupe_key) VALUES ('settlement.instruct', ${JSON.stringify({ transferId: t.id })}::jsonb, ${'instruct:' + t.id})`);

    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();

    primeOfacSource({ checkedAgoMs: H });
    await reconcileSweep(db, new Date());
    const screens = (await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen');
    expect(screens).toHaveLength(2);
    expect(screens[1].meta).toMatchObject({ decision: 'clear', listFitness: 'live' });

    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    await drainOnce(deps(), 'w2');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(STORED);
    expect((await store.getTransfer(t.id))?.paymentProviderRef).toBe('heal-1');
  });

  it('the sweep re-screen finds a match: evidence + block notices, and the next instruct is still refused', async () => {
    fetchFn.mockReset();
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'never' }) });
    await rail('acme', 'http');
    const t = base({ id: 'rr_heal_m', status: 'paid', recipientName: 'Testa Fixturelli', paidAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    await db.execute(sql`INSERT INTO outbox (kind, payload, dedupe_key) VALUES ('settlement.instruct', ${JSON.stringify({ transferId: t.id })}::jsonb, ${'instruct:' + t.id})`);
    primeOfacSource({ checkedAgoMs: H });
    await reconcileSweep(db, new Date());
    const rows = await auditRows(t.id);
    expect(rows.filter((a) => a.action === 'sanctions.screen').at(-1)?.meta).toMatchObject({ decision: 'match', listFitness: 'live' });
    expect(rows.map((a) => a.action)).toContain('sanctions.block');
    expect(await keys()).toContain('sanctionsblock:rr_heal_m');
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalledWith(STORED, expect.anything());
    const r = await db.execute(sql`SELECT status, last_error FROM outbox WHERE kind = 'settlement.instruct'`);
    expect((r as unknown as { rows: Array<{ status: string; last_error: string }> }).rows[0]).toMatchObject({
      status: 'failed',
      last_error: 'Last screen was a sanctions match.',
    });
  });

  it('the sweep re-screen cannot cover a name screened before: NO evidence (the gate keeps refusing), one review alert, not screened again', async () => {
    fetchFn.mockReset();
    await rail('acme', 'http');
    const t = base({ id: 'rr_heal_u', status: 'paid', paidAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await store.saveTransfer(t);
    // Screened before under a sender name that is not on file (never stored).
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: 'Body Only Name' },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    primeOfacSource({ checkedAgoMs: H });
    await reconcileSweep(db, new Date());
    await reconcileSweep(db, new Date());
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen')).toHaveLength(1);
    expect((await keys()).filter((k) => k === 'instructrescreen:rr_heal_u')).toHaveLength(1);
  });

  // Pack 2 review F3 (C2): the heal shares the sweep's re-screen time budget.
  it('time budget spent: the heal does not start (no new evidence); the next sweep heals it', async () => {
    fetchFn.mockReset();
    await rail('acme', 'http');
    const t = base({ id: 'rr_heal_b', status: 'paid', paidAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    primeOfacSource({ checkedAgoMs: H });
    await reconcileSweep(db, new Date(), { rescreenBudgetMs: 0 });
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen')).toHaveLength(1);
    await reconcileSweep(db, new Date());
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen')).toHaveLength(2);
  });

  it('the sweep does not re-screen while the list is not live: the row stays refused (fail closed)', async () => {
    fetchFn.mockReset();
    await rail('acme', 'http');
    const t = base({ id: 'rr_heal2', status: 'paid', paidAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    primeOfacSource({ checkedAgoMs: 40 * H });
    await reconcileSweep(db, new Date());
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen')).toHaveLength(1);
  });
});
