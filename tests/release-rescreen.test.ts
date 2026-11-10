/**
 * Fix pack 2 review F1 (A1): freshness at release and the heal path.
 *
 *  • releaseTransfer on a REAL-MONEY rail (http, env not 'test') whose newest
 *    evidence is not liveFresh (older than 36 h, not on a live list, no
 *    evidence, or evidence without listFitness) re-screens on file FIRST. The
 *    release goes on only after a live, fresh, clear result; otherwise the row
 *    stays held (LIST_UNAVAILABLE when the list is not live, the block path on
 *    a match). Partner staff get ONE fixed refusal (no name, no match detail,
 *    the same text for every outcome); platform staff get one text per outcome
 *    class (review R2, J2), and a second platform click after a review-reason
 *    hold is the human review that releases it.
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
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { beginHold } from '@/lib/settlement';
import {
  canReleaseHeld, issueRefund, PLATFORM_RESCREEN_REFUSALS, releaseTransfer, RESCREEN_ONLY_RELEASE_REFUSAL, RESCREEN_RELEASE_REFUSAL, SENDER_SCREENING_RELEASE_REFUSAL,
} from '@/lib/dashboard-ops';
import {
  LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_IDENTITY_MISSING_REASON,
} from '@/lib/compliance-config';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep, reinstructLocked } from '@/lib/reconcile';
import { healPaidRowScreen, sweepListUnavailableHolds } from '@/lib/list-hold-rescreen';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';
import { rescreenOnFile } from '@/lib/pay-rescreen';
import { createTransferRepo } from '@/db/repos/transfer-repo';

vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => {} };
});

// Pack 2 review R1 (H2): a sender screening stamp that commits right AFTER the
// release's unlocked pre-read; the locked in-transaction read is the real one.
const senderRace = vi.hoisted(() => ({ stampAfterPreRead: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  const { sql: q } = await import('drizzle-orm');
  return {
    ...real,
    readSenderScreeningFlags: async (...a: Parameters<typeof real.readSenderScreeningFlags>) => {
      const flags = await real.readSenderScreeningFlags(...a);
      if (senderRace.stampAfterPreRead && !a[3]?.forUpdate) {
        senderRace.stampAfterPreRead = false;
        await a[0].execute(q`UPDATE customers SET screening_flagged_at = now() WHERE partner_id = ${a[1]} AND phone = ${a[2]}`);
      }
      return flags;
    },
  };
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

/** A fuzzy hit on the sample list's 'BANCO EJEMPLO NACIONAL' (a possible match, not a match). */
const POSSIBLE_NAME = 'Banco Ejemplo Nacionel';

/** A LARGE_AMOUNT hold whose sender was screened 40 h ago under a name that is not on file (uncovered at re-screen). */
async function heldUncovered(id: string): Promise<Transfer> {
  const t = base({ id });
  await store.saveTransfer(t);
  await seedLiveEvidence(
    db,
    { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: 'Body Only Name' },
    { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
  );
  expect(await beginHold(db, t, { addReasons: [LARGE_AMOUNT_REASON] })).toEqual({ kind: 'held' });
  return t;
}

type AuditRow = { actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function auditRows(subject: string): Promise<AuditRow[]> {
  const r = await db.execute(sql`SELECT actor, actor_type, action, subject_id, meta FROM audit_events WHERE subject_id = ${subject} ORDER BY id`);
  return (r as unknown as { rows: AuditRow[] }).rows;
}
async function outboxText(key: string, field: 'message' | 'text'): Promise<string> {
  const r = await db.execute(sql`SELECT payload->>${field} AS v FROM outbox WHERE dedupe_key = ${key}`);
  const rows = (r as unknown as { rows: Array<{ v: string }> }).rows;
  expect(rows, key).toHaveLength(1);
  return rows[0].v;
}
async function keys(): Promise<Array<string | null>> {
  const r = await db.execute(sql`SELECT dedupe_key FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ dedupe_key: string | null }> }).rows.map((x) => x.dedupe_key);
}

beforeEach(async () => {
  senderRace.stampAfterPreRead = false;
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme'); // pack 3 T6: a live row on this http rail is drained
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

  it('http, 40 h old screen, list NOT live: refused with the list-not-live platform text, held with LIST_UNAVAILABLE (sweep owns it), no instruct', async () => {
    primeOfacSource({ checkedAgoMs: 40 * H }); // stale list
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_stale' });
    await expect(releaseTransfer(store, db, 'rr_stale', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.listNotLive);
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

  it('http, 40 h old screen, re-screen matches: blocked with the notices, the blocked platform text (no name), no instruct', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_match', recipientName: 'Testa Fixturelli' }, { recipientName: 'Testa Fixturelli' });
    let msg = '';
    try {
      await releaseTransfer(store, db, 'rr_match', REL);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(PLATFORM_RESCREEN_REFUSALS.blocked);
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

  // Review round 3 (M2), round 4 (S4): the block notices state the sender's money by its state.
  it('M2: re-screen at release matches a CARD-charged hold: the block alert and the partner email say the sender was charged', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    await heldLarge(
      { id: 'rr_m2_card', recipientName: 'Testa Fixturelli', fundingMethod: 'credit_card', fundingRef: 'pi_rr_m2' },
      { recipientName: 'Testa Fixturelli' },
    );
    await expect(releaseTransfer(store, db, 'rr_m2_card', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.blocked);
    const alert = await outboxText('sanctionsblock:rr_m2_card', 'message');
    const mail = await outboxText('sanctionsblockmail:rr_m2_card:acme', 'text');
    expect(alert).toContain('the sender was charged');
    expect(alert).not.toContain('Nothing paid out');
    expect(mail).toContain('after the sender was charged');
    for (const m of [alert, mail]) expect(m.toLowerCase()).not.toMatch(/testa|fixturelli/);
  });

  // Review round 4 (S4): an in-review row with no charge reference on a
  // custodial method is a Partner-API confirm (partner_collected), so the
  // uncharged case is a partner-pulled hold: nothing was charged.
  it('M2: re-screen at release matches a partner-pulled hold (ach_pull, no fundingRef): nothing was charged or paid out', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    await heldLarge({ id: 'rr_m2_none', recipientName: 'Testa Fixturelli', fundingMethod: 'ach_pull', transferType: 'b2b' }, { recipientName: 'Testa Fixturelli' });
    await expect(releaseTransfer(store, db, 'rr_m2_none', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.blocked);
    expect(await outboxText('sanctionsblock:rr_m2_none', 'message')).toContain('Nothing was charged or paid out');
    expect(await outboxText('sanctionsblock:rr_m2_none', 'message')).not.toMatch(/the sender was charged|refund/);
    expect(await outboxText('sanctionsblockmail:rr_m2_none:acme', 'text')).toContain('nothing was charged or paid out');
  });

  // Review round 4 (S4: N1, P1): a Partner-API-shaped hold (bank_transfer, no
  // fundingRef, held after the partner's confirm) matches at release.
  it('N1/P1: re-screen at release matches a Partner-API-shaped hold: the partner collected the funds, never "Nothing was charged", no refund instruction', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    await heldLarge({ id: 'rr_m2_pc', recipientName: 'Testa Fixturelli', fundingMethod: 'bank_transfer' }, { recipientName: 'Testa Fixturelli' });
    await expect(releaseTransfer(store, db, 'rr_m2_pc', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.blocked);
    const alert = await outboxText('sanctionsblock:rr_m2_pc', 'message');
    const mail = await outboxText('sanctionsblockmail:rr_m2_pc:acme', 'text');
    expect(alert).toBe(
      "⚠️ SmartRemit ops: sanctions block (hold_rescreen) on rr_m2_pc, partner acme, live. The recipient was not paid, but the partner confirmed that it collected the sender's funds. " +
        "Do not pay it out, and do not refund or return the funds until the licensed partner's compliance officer decides whether they must be blocked (frozen) or can be returned; evidence on the compliance page.",
    );
    expect(mail).toContain("after the partner confirmed that it collected the sender's funds; nothing was paid out to the recipient.");
    for (const m of [alert, mail]) {
      expect(m).not.toMatch(/nothing was charged|refund procedure|refund it|before any refund/i);
      expect(m.toLowerCase()).not.toMatch(/testa|fixturelli/);
    }
  });

  it('http, 40 h old screen, a name screened before cannot be screened again: held with SENDER_IDENTITY_MISSING, the review platform text', async () => {
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
    await expect(releaseTransfer(store, db, 'rr_unc', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.review);
    const after = await store.getTransfer('rr_unc');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, SENDER_IDENTITY_MISSING_REASON]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
  });

  // Review R2 (J2): partner staff get ONE text for every outcome (a list
  // outage, a match, an uncovered name, a possible match): it tells nothing apart.
  it('partner-scoped release: a list outage, a match, an uncovered name and a possible match give the SAME refusal text', async () => {
    await rail('acme', 'http');
    primeOfacSource({ checkedAgoMs: 40 * H });
    await heldLarge({ id: 'rr_p_list' });
    const outage = await releaseTransfer(store, db, 'rr_p_list', REL, { partnerId: 'acme' }).catch((e: Error) => e.message);
    primeOfacSource({ checkedAgoMs: H });
    await heldLarge({ id: 'rr_p_match', recipientName: 'Testa Fixturelli' }, { recipientName: 'Testa Fixturelli' });
    const match = await releaseTransfer(store, db, 'rr_p_match', REL, { partnerId: 'acme' }).catch((e: Error) => e.message);
    await heldUncovered('rr_p_unc');
    const uncovered = await releaseTransfer(store, db, 'rr_p_unc', REL, { partnerId: 'acme' }).catch((e: Error) => e.message);
    await heldLarge({ id: 'rr_p_pm', recipientName: POSSIBLE_NAME }, { recipientName: POSSIBLE_NAME });
    const possible = await releaseTransfer(store, db, 'rr_p_pm', REL, { partnerId: 'acme' }).catch((e: Error) => e.message);
    expect(outage).toBe(RESCREEN_RELEASE_REFUSAL);
    expect([match, uncovered, possible]).toEqual([outage, outage, outage]);
    // The outcomes really differ underneath (the text alone hides them).
    expect((await store.getTransfer('rr_p_list'))?.complianceReasons).toContain(LIST_UNAVAILABLE_REASON);
    expect((await store.getTransfer('rr_p_match'))?.complianceStatus).toBe('blocked');
    expect((await store.getTransfer('rr_p_unc'))?.complianceReasons).toContain(SENDER_IDENTITY_MISSING_REASON);
    expect((await store.getTransfer('rr_p_pm'))?.complianceReasons).toContain(POSSIBLE_MATCH_REASON);
    for (const text of [String(outage), ...Object.values(PLATFORM_RESCREEN_REFUSALS)]) {
      expect(text.startsWith('Cannot release')).toBe(true); // the partner action maps it to its generic refusal
      expect(text).not.toContain('It stays held');
      expect(text.toLowerCase()).not.toMatch(/testa|fixturelli|banco|body only|sdn:|ofac/);
    }
    expect(new Set([outage, ...Object.values(PLATFORM_RESCREEN_REFUSALS)]).size).toBe(4);
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

  it('H2: a sender stamp that commits after the pre-read: the re-screen release refuses in its transaction, evidence kept, no instruct', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_race' });
    senderRace.stampAfterPreRead = true;
    await expect(releaseTransfer(store, db, 'rr_race', REL)).rejects.toThrow(SENDER_SCREENING_RELEASE_REFUSAL);
    expect(senderRace.stampAfterPreRead).toBe(false);
    expect((await store.getTransfer('rr_race'))?.status).toBe('in_review');
    const rows = await auditRows('rr_race');
    expect(rows.filter((a) => a.action === 'sanctions.screen')).toHaveLength(2); // the re-screen is a true record
    expect(rows.filter((a) => a.action === 'transfer.release')).toEqual([]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
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

// Review R2 (J2): a possible match or an uncovered name found by the release
// re-screen is a hold for a PLATFORM person: never released automatically; a
// second platform click is the human review and MAY release it, so the first
// refusal tells platform staff what to do. A list outage or a match does not
// release on a second click.
describe('releaseTransfer — the platform refusal per outcome and the second click (review R2/J2)', { retry: 0 }, () => {
  const screens = async (id: string) => (await auditRows(id)).filter((a) => a.action === 'sanctions.screen').length;

  it.each([
    ['an uncovered name', 'rr_2_unc', SENDER_IDENTITY_MISSING_REASON],
    ['a possible match', 'rr_2_pm', POSSIBLE_MATCH_REASON],
  ])('%s: the first click is refused with the review text; a second platform click releases it with NO new screen, audited', async (_label, id, reason) => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    if (id === 'rr_2_unc') await heldUncovered(id);
    else await heldLarge({ id, recipientName: POSSIBLE_NAME }, { recipientName: POSSIBLE_NAME });
    await expect(releaseTransfer(store, db, id, REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.review);
    const held = await store.getTransfer(id);
    expect(held?.status).toBe('in_review');
    expect(held?.complianceReasons).toContain(reason);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
    expect((await auditRows(id)).filter((a) => a.action === 'transfer.release')).toEqual([]);
    const screened = await screens(id);
    expect(screened).toBe(2);

    await releaseTransfer(store, db, id, { actor: 'plat2', reason: 'reviewed the reasons' });
    expect((await store.getTransfer(id))?.status).toBe('paid');
    expect(await screens(id)).toBe(screened);
    expect((await auditRows(id)).filter((a) => a.action === 'transfer.release')).toEqual([
      expect.objectContaining({ actor: 'plat2', actor_type: 'staff', meta: expect.objectContaining({ previousStatus: 'in_review', newStatus: 'paid' }) }),
    ]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([`instruct:${id}`]);
  });

  it('a list outage: the list-not-live text; a second platform click (list live again) does not release', async () => {
    primeOfacSource({ checkedAgoMs: 40 * H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_2_list' });
    await expect(releaseTransfer(store, db, 'rr_2_list', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.listNotLive);
    primeOfacSource({ checkedAgoMs: H });
    await expect(releaseTransfer(store, db, 'rr_2_list', REL)).rejects.toThrow(RESCREEN_ONLY_RELEASE_REFUSAL);
    expect((await store.getTransfer('rr_2_list'))?.status).toBe('in_review');
    expect((await auditRows('rr_2_list')).filter((a) => a.action === 'transfer.release')).toEqual([]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
  });

  it('a match: the blocked text; a second platform click does not release', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_2_m', recipientName: 'Testa Fixturelli' }, { recipientName: 'Testa Fixturelli' });
    await expect(releaseTransfer(store, db, 'rr_2_m', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.blocked);
    // Review round 3 (M3): the second click says the transfer is blocked (not
    // "it moved concurrently"), before any write.
    const auditBefore = await auditRows('rr_2_m');
    const outboxBefore = await keys();
    await expect(releaseTransfer(store, db, 'rr_2_m', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.blocked);
    expect(await auditRows('rr_2_m')).toEqual(auditBefore);
    expect(await keys()).toEqual(outboxBefore);
    const after = await store.getTransfer('rr_2_m');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('blocked');
    expect((await auditRows('rr_2_m')).filter((a) => a.action === 'transfer.release')).toEqual([]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
  });

  it('M3: a match, partner staff: both clicks get the one partner text (a match looks like an outage), nothing written by the second', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_2_pm_b', recipientName: 'Testa Fixturelli' }, { recipientName: 'Testa Fixturelli' });
    await expect(releaseTransfer(store, db, 'rr_2_pm_b', REL, { partnerId: 'acme' })).rejects.toThrow(RESCREEN_RELEASE_REFUSAL);
    const auditBefore = await auditRows('rr_2_pm_b');
    const outboxBefore = await keys();
    let msg = '';
    try {
      await releaseTransfer(store, db, 'rr_2_pm_b', REL, { partnerId: 'acme' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(RESCREEN_RELEASE_REFUSAL);
    expect(await auditRows('rr_2_pm_b')).toEqual(auditBefore);
    expect(await keys()).toEqual(outboxBefore);
    expect((await store.getTransfer('rr_2_pm_b'))?.complianceStatus).toBe('blocked');
  });

  // Review round 3 (K2): a staff-released row keeps its own hold reason, so the
  // automatic re-screen never releases it: the text says a platform person
  // releases it after that re-screen.
  it('K2: list not live at release -> the sweep re-screens it once the list is live, keeps LARGE, drops LIST_UNAVAILABLE, stays in_review for a platform release', async () => {
    expect(PLATFORM_RESCREEN_REFUSALS.listNotLive).toBe(
      'Cannot release: the sanctions list is not live, so the re-screen at release could not clear this transfer. ' +
        'The system re-screens it automatically once the list is live again; it then returns to the review queue for a platform release.',
    );
    primeOfacSource({ checkedAgoMs: 40 * H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_k2' });
    await expect(releaseTransfer(store, db, 'rr_k2', REL)).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.listNotLive);
    expect((await store.getTransfer('rr_k2'))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);

    primeOfacSource({ checkedAgoMs: H });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const after = await store.getTransfer('rr_k2');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);

    // Back in the review queue: a platform release now releases it.
    await releaseTransfer(store, db, 'rr_k2', { actor: 'plat2', reason: 'reviewed after the re-screen' });
    expect((await store.getTransfer('rr_k2'))?.status).toBe('paid');
  });
});

// Review R2 (J1): a PARTNER release that reaches the claim after a clear
// re-screen: the tenant pin on the locked read and the sender re-check in the claim.
describe('releaseTransfer — partner release through the re-screen claim (review R2/J1)', { retry: 0 }, () => {
  const PARTNER_CHANGED = 'Cannot release: transfer is not in_review or its sender is not releasable (it changed concurrently)';

  it('a stamp-only sender (screening_flagged_at set, flags NULL): the re-screen clears, the claim refuses; evidence kept, no instruct', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await heldLarge({ id: 'rr_j1_stamp' });
    await db.execute(sql`UPDATE customers SET screening_flagged_at = now(), pep_hit = NULL, watchlist_hit = NULL WHERE partner_id = 'acme' AND phone = ${SENDER_PHONE}`);
    await expect(releaseTransfer(store, db, 'rr_j1_stamp', REL, { partnerId: 'acme' })).rejects.toThrow(PARTNER_CHANGED);
    expect((await store.getTransfer('rr_j1_stamp'))?.status).toBe('in_review');
    const rows = await auditRows('rr_j1_stamp');
    const screens = rows.filter((a) => a.action === 'sanctions.screen');
    expect(screens).toHaveLength(2); // the re-screen is a true record
    expect(screens[1].meta).toMatchObject({ decision: 'clear', listFitness: 'live' });
    expect(rows.filter((a) => a.action === 'transfer.release')).toEqual([]);
    expect((await keys()).filter((k) => k?.startsWith('instruct:'))).toEqual([]);
  });

  it("another tenant's partnerId: the same text, the row unchanged, no audit row and no outbox row", async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await seedPartner(db, 'other');
    await heldLarge({ id: 'rr_j1_x' });
    const before = await store.getTransfer('rr_j1_x');
    const auditBefore = (await auditRows('rr_j1_x')).length;
    const outboxBefore = (await keys()).length;
    await expect(releaseTransfer(store, db, 'rr_j1_x', REL, { partnerId: 'other' })).rejects.toThrow(PARTNER_CHANGED);
    expect(await store.getTransfer('rr_j1_x')).toEqual(before);
    expect((await auditRows('rr_j1_x')).length).toBe(auditBefore);
    expect((await keys()).length).toBe(outboxBefore);
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

  // Pack 2 review R1 (E2): a heal match on a PAID (charged) row blocks the ledger
  // row in the same transaction as the evidence and the notices, tells a person
  // it is paid and charged, and the row is never instructed but can be refunded.
  it('the sweep re-screen finds a match: the paid row is BLOCKED (on the compliance list), one paidmatch alert, never instructed, still refundable', async () => {
    fetchFn.mockReset();
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'never' }) });
    await rail('acme', 'http');
    const t = base({
      id: 'rr_heal_m', status: 'paid', recipientName: 'Testa Fixturelli', fundingRef: 'pi_heal_m',
      paidAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
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

    // The ledger row: still paid (the sender WAS charged), now blocked with the matched reason.
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('paid');
    expect(after?.refundStatus ?? 'none').toBe('none');
    expect(after?.complianceStatus).toBe('blocked');
    expect(after?.complianceReasons).toContain(RECIPIENT_WATCHLIST_REASON);
    expect((await store.listTransfersByCompliance('blocked', {})).map((x) => x.id)).toContain(t.id);

    // ONE dedicated alert: paid, charged, not instructed, no refund before the compliance officer decides. Ids only.
    type A = { dedupe_key: string; payload: { message: string } };
    const alerts = ((await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as { rows: A[] }).rows;
    const paidmatch = alerts.filter((a) => a.dedupe_key.startsWith('paidmatch:'));
    expect(paidmatch.map((a) => a.dedupe_key)).toEqual(['paidmatch:rr_heal_m']);
    const msg = paidmatch[0].payload.message;
    expect(msg).toContain('rr_heal_m');
    expect(msg).toContain('PAID');
    expect(msg).toContain('CHARGED');
    expect(msg).toContain('not instructed');
    // Review round 4 (S4, refund wording): no instruction to refund on a match.
    expect(msg).toBe(
      '⚠️ SmartRemit ops: transfer rr_heal_m (partner acme) is PAID and the sender was CHARGED, but it was not instructed: ' +
        'its re-screen on a live list is a sanctions match. It is now blocked and is never sent to the rail. ' +
        "Do not pay it out, and do not refund or return the funds until the licensed partner's compliance officer decides whether they must be blocked (frozen) or can be returned; evidence on the compliance page.",
    );
    // The sanctions block alert never says the sender was not charged.
    const block = alerts.find((a) => a.dedupe_key === 'sanctionsblock:rr_heal_m')!.payload.message;
    expect(block).not.toContain('Nothing paid out');
    expect(block).toContain('the sender was charged');
    for (const m of [msg, block]) {
      for (const pii of ['Testa', 'Fixturelli', SENDER, SENDER_PHONE, '919876543210', '123456789012']) expect(m).not.toContain(pii);
    }

    // Never instructed: the queued instruct is skipped (done), no POST.
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    const ins = await db.execute(sql`SELECT status FROM outbox WHERE kind = 'settlement.instruct'`);
    expect((ins as unknown as { rows: Array<{ status: string }> }).rows.map((r) => r.status)).toEqual(['done']);
    // The stuck-paid sweep never re-instructs it, and does not screen it again.
    const blocksBefore = (await auditRows(t.id)).filter((a) => a.action === 'sanctions.block').length;
    await reconcileSweep(db, new Date());
    expect((await keys()).filter((k) => k === 'reinstruct:rr_heal_m')).toEqual([]);
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen')).toHaveLength(2);
    // Review R2 (J4a): a newest screen that is a match is not screened (or blocked) again.
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.block')).toHaveLength(blocksBefore);
    expect(await reinstructLocked(db, t.id)).toBe('not_payable');
    await drainOnce(deps(), 'w2');
    expect(fetchFn).not.toHaveBeenCalled();

    // Still refundable: the staff refund claims it (none -> pending + funding.refund).
    await issueRefund(db, t.id, REL);
    expect((await store.getTransfer(t.id))?.refundStatus).toBe('pending');
    expect(await keys()).toContain('refund:rr_heal_m');
  });

  // Pack 2 review round 3 (K1): a heal match on a paid row that was (or may
  // have been) instructed to the rail. The row is blocked (never instructed
  // again), but nobody is told it was never sent or that nothing was paid out:
  // one paidmatchinstructed:<id> alert says to recall it with the rail and to
  // confirm with the rail what happened (round 4: no refund before the
  // compliance officer decides), and the notices say the payout may be in
  // progress with the rail.
  type OutRow = { kind: string; dedupe_key: string; payload: { message?: string; text?: string; to?: string[] } };
  async function outRows(): Promise<OutRow[]> {
    return ((await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as { rows: OutRow[] }).rows;
  }
  it.each([
    ['instruct done and provider_ref set', 'done', 1, 'rail-ref-k1'],
    ['provider_ref null but the instruct has attempts > 0 (a timed-out POST)', 'failed', 2, null],
  ])('K1: %s: blocked, no "not instructed" alert or "nothing paid out" notice, one paidmatchinstructed alert', async (_l, status, attempts, providerRef) => {
    fetchFn.mockReset();
    await rail('acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ alertEmail: 'ops@acme.example' })}::jsonb WHERE id = 'acme'`);
    const id = providerRef ? 'rr_heal_i1' : 'rr_heal_i2';
    const t = base({
      id, status: 'paid', recipientName: 'Testa Fixturelli', fundingRef: `pi_${id}`,
      paidAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 37 * H, at: new Date(Date.now() - 37 * H) },
    );
    await db.execute(
      sql`INSERT INTO outbox (kind, payload, dedupe_key, status, attempts) VALUES ('settlement.instruct', ${JSON.stringify({ transferId: t.id })}::jsonb, ${'instruct:' + t.id}, ${status}, ${attempts})`,
    );
    if (providerRef) await db.execute(sql`UPDATE transfers SET payment_provider_ref = ${providerRef} WHERE id = ${t.id}`);
    primeOfacSource({ checkedAgoMs: H });
    await reconcileSweep(db, new Date());

    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('paid');
    expect(after?.complianceStatus).toBe('blocked');

    const rows = await outRows();
    const texts = rows.map((r) => String(r.payload.message ?? r.payload.text ?? ''));
    expect(rows.filter((r) => r.dedupe_key === `paidmatch:${id}`)).toEqual([]);
    for (const m of texts) {
      expect(m).not.toContain('not instructed');
      expect(m).not.toContain('never sent to the rail');
      expect(m.toLowerCase()).not.toContain('nothing was paid out');
      expect(m.toLowerCase()).not.toContain('nothing paid out');
      expect(m).not.toContain('recipient was not paid');
    }
    const instructed = rows.filter((r) => r.dedupe_key === `paidmatchinstructed:${id}`);
    expect(instructed).toHaveLength(1);
    const msg = String(instructed[0].payload.message);
    expect(Object.keys(instructed[0].payload)).toEqual(['message']);
    expect(msg).toContain(id);
    expect(msg).toContain('PAID');
    expect(msg).toContain('CHARGED');
    expect(msg).toMatch(/may have been sent/);
    expect(msg).toMatch(/stop or recall/);
    // Review round 4 (S4, refund wording): recall with the rail, then the compliance officer decides.
    expect(msg).toBe(
      `⚠️ SmartRemit ops: transfer ${id} (partner acme) is PAID and the sender was CHARGED, and its re-screen on a live list is a sanctions match. ` +
        'An instruction was sent, or may have been sent, to the rail. Contact the rail now to stop or recall the payout, and confirm with the rail what happened. ' +
        "It is now blocked, so it will never be instructed again. Do not refund or return the funds until the licensed partner's compliance officer decides whether they must be blocked (frozen) or can be returned; evidence on the compliance page.",
    );
    expect(msg).not.toMatch(/before any refund/i);
    const block = rows.find((r) => r.dedupe_key === `sanctionsblock:${id}`)!;
    expect(String(block.payload.message)).toContain('may be in progress with the rail');
    const mail = rows.find((r) => r.dedupe_key === `sanctionsblockmail:${id}:acme`)!;
    expect(String(mail.payload.text)).toContain('may be in progress with the rail');
    for (const m of [msg, String(block.payload.message), String(mail.payload.text)]) {
      for (const pii of ['Testa', 'Fixturelli', SENDER, SENDER_PHONE, '919876543210', '123456789012']) expect(m).not.toContain(pii);
    }
    // Never instructed again.
    expect(await reinstructLocked(db, t.id)).toBe('not_payable');
  });

  // Review round 4 (S4: N1, P1): the heal states the sender's money by its
  // state (senderChargeState), it is never hard-coded "charged".
  it.each([
    [
      'a Partner-API-shaped paid row (bank_transfer, no fundingRef), not instructed',
      'rr_heal_pc', 'bank_transfer', null, 'paidmatch',
      "⚠️ SmartRemit ops: transfer rr_heal_pc (partner acme) is PAID and the partner confirmed that it collected the sender's funds, but it was not instructed: " +
        'its re-screen on a live list is a sanctions match. It is now blocked and is never sent to the rail. ' +
        "Do not pay it out, and do not refund or return the funds until the licensed partner's compliance officer decides whether they must be blocked (frozen) or can be returned; evidence on the compliance page.",
      "The recipient was not paid, but the partner confirmed that it collected the sender's funds.",
    ],
    [
      'a partner-pulled paid row (ach_pull), not instructed',
      'rr_heal_np', 'ach_pull', null, 'paidmatch',
      '⚠️ SmartRemit ops: transfer rr_heal_np (partner acme) is PAID and nothing was charged, but it was not instructed: ' +
        'its re-screen on a live list is a sanctions match. It is now blocked and is never sent to the rail. Do not pay it out; evidence on the compliance page.',
      'Nothing was charged or paid out',
    ],
    [
      'a partner-pulled paid row (ach_pull), instructed (rail ref set)',
      'rr_heal_ip', 'ach_pull', 'rail-ref-ip', 'paidmatchinstructed',
      "⚠️ SmartRemit ops: transfer rr_heal_ip (partner acme) is PAID and the rail may have pulled the sender's funds, and its re-screen on a live list is a sanctions match. " +
        'An instruction was sent, or may have been sent, to the rail. Contact the rail now to stop or recall the payout, and confirm with the rail what happened. ' +
        "It is now blocked, so it will never be instructed again. Do not refund or return the funds until the licensed partner's compliance officer decides whether they must be blocked (frozen) or can be returned; evidence on the compliance page.",
      "The rail may have pulled the sender's funds and the payout may be in progress with the rail",
    ],
  ] as const)('S4: %s: the heal alert and the block notice state the money truthfully', async (_l, id, fundingMethod, providerRef, key, want, blockPiece) => {
    fetchFn.mockReset();
    await rail('acme', 'http');
    const t = base({
      id, status: 'paid', recipientName: 'Testa Fixturelli', fundingMethod,
      ...(fundingMethod === 'ach_pull' ? { transferType: 'b2b' as const } : {}),
      paidAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    if (providerRef) await db.execute(sql`UPDATE transfers SET payment_provider_ref = ${providerRef} WHERE id = ${t.id}`);
    primeOfacSource({ checkedAgoMs: H });
    const fresh = (await store.getTransfer(t.id))!;
    expect(fresh.fundingRef ?? null).toBeNull();
    expect(await healPaidRowScreen(db, fresh, new Date())).toBe('blocked');
    expect((await store.getTransfer(t.id))?.complianceStatus).toBe('blocked');
    const rows = await outRows();
    const alert = rows.filter((r) => r.dedupe_key === `${key}:${id}`);
    expect(alert).toHaveLength(1);
    expect(String(alert[0].payload.message)).toBe(want);
    const block = String(rows.find((r) => r.dedupe_key === `sanctionsblock:${id}`)?.payload.message);
    expect(block).toContain(blockPiece);
    for (const m of [String(alert[0].payload.message), block]) {
      expect(m).not.toMatch(/CHARGED|the sender was charged|refund procedure|refund it|before any refund/);
      expect(m.toLowerCase()).not.toMatch(/testa|fixturelli/);
    }
  });

  it('a heal match on a row whose refund already started: evidence and notices, the row is NOT rewritten, no paidmatch alert', async () => {
    await rail('acme', 'http');
    const t = base({
      id: 'rr_heal_r', status: 'paid', recipientName: 'Testa Fixturelli', fundingRef: 'pi_heal_r',
      paidAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) },
    );
    primeOfacSource({ checkedAgoMs: H });
    // The refund lands between the heal's reads and its transaction.
    const fresh = (await store.getTransfer(t.id))!;
    await db.execute(sql`UPDATE transfers SET refund_status = 'requested' WHERE id = ${t.id}`);
    expect(await healPaidRowScreen(db, fresh, new Date())).toBe('blocked');
    const after = await store.getTransfer(t.id);
    expect(after?.complianceStatus).toBe('cleared');
    expect((await auditRows(t.id)).map((a) => a.action)).toContain('sanctions.block');
    expect((await keys()).filter((k) => k?.startsWith('paidmatch:'))).toEqual([]);
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
    // Review R2 (J4e): the review alert carries ids only: one message, no name, phone or account.
    const r = await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'instructrescreen:rr_heal_u'`);
    const payload = (r as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0].payload;
    expect(Object.keys(payload)).toEqual(['message']);
    expect(String(payload.message)).toContain('rr_heal_u');
    // Review round 4 (S4): a possible match, not a confirmed one: review before any refund.
    expect(String(payload.message)).toBe(
      '⚠️ SmartRemit ops: transfer rr_heal_u (partner acme) is paid but not instructed: its re-screen on a live list did not clear ' +
        '(a possible match or a name that cannot be screened again). It stays uninstructed; review it on the compliance page before any refund.',
    );
    for (const pii of ['Body Only Name', SENDER, 'Anita', SENDER_PHONE, '919876543210', '123456789012', 'HDFC']) {
      expect(JSON.stringify(payload)).not.toContain(pii);
    }
  });

  // Review R2 (J4d): the heal runs on a real-money rail only. A stuck paid row
  // on the simulator rail or in sandbox ('test' on http) with not-live
  // evidence and a live list is never re-screened by the sweep.
  it.each([
    ['simulator rail', 'simulator', 'live'],
    ["env 'test' on an http rail", 'http', 'test'],
  ])('%s: a stuck paid row with not-live evidence is not re-screened (no new evidence)', async (_label, type, environment) => {
    fetchFn.mockReset();
    await rail('acme', type);
    const t = base({
      id: 'rr_heal_demo', status: 'paid', environment: environment as Transfer['environment'],
      paidAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    await store.saveTransfer(t);
    await seedLiveEvidence(
      db,
      { id: t.id, partnerId: t.partnerId, recipientName: t.recipientName, senderName: SENDER },
      { screenedAgoMs: H, at: new Date(Date.now() - H), listFitness: 'not_live' },
    );
    primeOfacSource({ checkedAgoMs: H });
    await reconcileSweep(db, new Date());
    expect((await auditRows(t.id)).filter((a) => a.action === 'sanctions.screen')).toHaveLength(1);
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

// Review S5 (W3): a pay-time re-screen that matches a row with a BOUND Stripe
// intent and no charge reference keeps the row awaiting (the pending intent
// may still debit). Its notices must not claim "Nothing was charged": they
// pass no money state, so the neutral "Nothing paid out" text is used.
describe('pay-time re-screen of a row with a pending PSP intent (review S5, W3)', { retry: 0 }, () => {
  it('a bound pending intent, no fundingRef: the block notices say "Nothing paid out", never "Nothing was charged"', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    const t = base({ id: 'rr_w3_pi', recipientName: 'Testa Fixturelli', createdAt: new Date().toISOString() });
    await store.saveTransfer(t);
    const repo = createTransferRepo(db);
    await repo.bindFundingIntent('rr_w3_pi', 'acme', 'stripe', 'pi_rr_w3');
    const bound = (await repo.getTransfer('rr_w3_pi'))!;
    expect(bound).toMatchObject({ fundingIntentRef: 'pi_rr_w3', fundingState: 'pending' });
    expect(bound.fundingRef ?? null).toBeNull();
    expect(await rescreenOnFile(db, bound, { realMoney: true, stage: 'pay' })).toEqual({ kind: 'blocked' });
    expect((await repo.getTransfer('rr_w3_pi'))?.status).toBe('awaiting_payment');
    const alert = await outboxText('sanctionsblock:rr_w3_pi', 'message');
    const mail = await outboxText('sanctionsblockmail:rr_w3_pi:acme', 'text');
    expect(alert).toBe('⚠️ SmartRemit ops: sanctions block (pay) on rr_w3_pi, partner acme, live. Nothing paid out; evidence on the compliance page.');
    expect(mail).toBe(
      'Reference rr_w3_pi (pay, live) was stopped by sanctions screening; nothing was paid out. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.',
    );
    for (const m of [alert, mail]) expect(m).not.toMatch(/nothing was charged/i);
  });

  it('no intent and no fundingRef (unchanged): the block notices still say "Nothing was charged or paid out"', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await rail('acme', 'http');
    const t = base({ id: 'rr_w3_none', recipientName: 'Testa Fixturelli', createdAt: new Date().toISOString() });
    await store.saveTransfer(t);
    expect(await rescreenOnFile(db, t, { realMoney: true, stage: 'pay' })).toEqual({ kind: 'blocked' });
    expect((await createTransferRepo(db).getTransfer('rr_w3_none'))?.status).toBe('blocked');
    expect(await outboxText('sanctionsblock:rr_w3_none', 'message')).toBe(
      '⚠️ SmartRemit ops: sanctions block (pay) on rr_w3_none, partner acme, live. Nothing was charged or paid out; evidence on the compliance page.',
    );
  });
});
