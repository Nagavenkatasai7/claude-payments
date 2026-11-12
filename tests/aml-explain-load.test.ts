import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureQueries, freshDb, seedLedgerSpend, seedPartner, seedPriorSends } from './helpers-db';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { PartnerId, Transfer } from '@/lib/types';

// Fix pack 6 T18 (P16): the AML explain loader recomputes a pack 6 hold with
// the rules the row's OWN aml.hold audit row names (tenant-pinned), on the
// sender's ledger stats and its prior paid sends anchored at the row; a
// check_failed hold reports checkFailed with no ledger read; a hold minted
// before pack 6 (no aml.hold row) keeps the legacy pair structuring +
// first_transfer.

const fault = vi.hoisted(() => ({ statsThrow: false, statsCalls: 0 }));
const log = vi.hoisted(() => ({ warns: [] as unknown[][] }));

vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (db: Parameters<typeof real.createTransferRepo>[0]) => {
      const repo = real.createTransferRepo(db);
      return {
        ...repo,
        senderAmlStats: async (...a: Parameters<typeof repo.senderAmlStats>) => {
          fault.statsCalls += 1;
          if (fault.statsThrow) throw new TypeError('stats read failed');
          return repo.senderAmlStats(...a);
        },
      };
    },
  };
});
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: unknown[]) => { log.warns.push(a); } };
});

import { loadAmlExplainContext } from '@/lib/aml-explain-load';
import { createTransferRepo } from '@/db/repos/transfer-repo';

const PHONE = '15557770171';
const NEW_RECIPIENT = '919876543210';
let db: Awaited<ReturnType<typeof freshDb>>;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'p2');
  fault.statsThrow = false;
  fault.statsCalls = 0;
  log.warns = [];
});

async function heldRow(o: { amountUsd?: number; createdAt?: Date; reasons?: string[] } = {}): Promise<Transfer> {
  const id = await seedLedgerSpend(db, {
    partnerId: 'acme', phone: PHONE, amountUsd: o.amountUsd ?? 900, status: 'in_review',
    complianceReasons: o.reasons ?? [AML_HOLD_REASON], recipientPhone: NEW_RECIPIENT,
    createdAt: o.createdAt ?? new Date(Date.now() - 3_600_000),
  });
  const t = await createTransferRepo(db).getTransfer(id);
  if (!t) throw new Error('seed failed');
  return t;
}

async function amlHold(subjectId: string, rules: string[], partnerId: PartnerId = 'acme') {
  await createAuditRepo(db).record({
    partnerId, actor: 'system:aml-hold', actorType: 'system', action: 'aml.hold', subjectId, meta: { rules },
  });
}

describe('loadAmlExplainContext — fix pack 6 T18 (P16)', () => {
  it('a pack 6 hold (aml.hold { rules: [new_beneficiary] }) recomputes new_beneficiary from priorSends anchored at the row', async () => {
    await seedPriorSends(db, 'acme', PHONE, { paid: 2, toRecipient: 0, recipientPhone: NEW_RECIPIENT });
    const t = await heldRow();
    await amlHold(t.id, ['new_beneficiary']);
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.recomputed?.rule).toBe('new_beneficiary');
    expect(ctx.recomputed).toEqual({ rule: 'new_beneficiary', window: 'destination', count: 3, sumUsd: 900 });
    expect(ctx.checkFailed).toBe(false);
  });

  it('rows paid AFTER the held row do not count', async () => {
    await seedPriorSends(db, 'acme', PHONE, { paid: 2, toRecipient: 0, recipientPhone: NEW_RECIPIENT });
    const t = await heldRow();
    await seedLedgerSpend(db, {
      partnerId: 'acme', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: NEW_RECIPIENT,
      createdAt: new Date(Date.now() - 600_000),
    });
    await amlHold(t.id, ['new_beneficiary']);
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.recomputed?.rule).toBe('new_beneficiary');
  });

  it('only the rules the aml.hold row names are reported', async () => {
    // A $900 first-ever send would recompute to first_transfer, but structuring held it.
    const first = await heldRow();
    await amlHold(first.id, ['structuring']);
    const none = await loadAmlExplainContext(db, first, 'acme');
    expect(none.recomputed).toBeNull();
    expect(none.checkFailed).toBe(false);

    // Two in-band rows earlier in the week plus this $850 row: structuring (7d).
    const phone2 = '15557770172';
    for (const h of [5, 4]) {
      await seedLedgerSpend(db, { partnerId: 'acme', phone: phone2, amountUsd: 850, status: 'paid', createdAt: new Date(Date.now() - h * 3_600_000) });
    }
    const sid = await seedLedgerSpend(db, {
      partnerId: 'acme', phone: phone2, amountUsd: 850, status: 'in_review', complianceReasons: [AML_HOLD_REASON],
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const s = (await createTransferRepo(db).getTransfer(sid))!;
    await amlHold(sid, ['structuring', 'not_a_rule']);
    const ctx = await loadAmlExplainContext(db, s, 'acme');
    expect(ctx.recomputed).toEqual({ rule: 'structuring', window: '7d', count: 3, sumUsd: 2550 });
  });

  it('aml.hold { rules: [check_failed] } -> checkFailed true, recomputed null, NO ledger read', async () => {
    const t = await heldRow();
    await amlHold(t.id, ['check_failed']);
    const stop = captureQueries();
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    const queries = stop();
    expect(ctx.checkFailed).toBe(true);
    expect(ctx.recomputed).toBeNull();
    expect(ctx.eligible).toBe(true);
    expect(queries.some((q) => /from "audit_events"/i.test(q.sql))).toBe(true);
    expect(queries.filter((q) => /from "transfers"/i.test(q.sql))).toEqual([]);
  });

  it("another tenant's aml.hold row for the same subject id is ignored", async () => {
    const t = await heldRow();
    await amlHold(t.id, ['check_failed'], 'p2');
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.checkFailed).toBe(false);
    // No acme aml.hold row: the legacy pair; a $900 first-ever send.
    expect(ctx.recomputed?.rule).toBe('first_transfer');
  });

  it('a row held before pack 6 (AML_HOLD_REASON, no aml.hold row) recomputes with the legacy pair structuring + first_transfer', async () => {
    const t0 = await heldRow();
    const first = await loadAmlExplainContext(db, t0, 'acme');
    expect(first.recomputed).toEqual({ rule: 'first_transfer', window: 'first', count: 1, sumUsd: 900 });
    expect(first.checkFailed).toBe(false);

    // Earlier paid sends to another number: a pack 6 hold could say new_beneficiary, the legacy pair never does.
    const phone3 = '15557770173';
    await seedPriorSends(db, 'acme', phone3, { paid: 2, toRecipient: 0, recipientPhone: NEW_RECIPIENT });
    const id = await seedLedgerSpend(db, {
      partnerId: 'acme', phone: phone3, amountUsd: 900, status: 'in_review', complianceReasons: [AML_HOLD_REASON],
      recipientPhone: NEW_RECIPIENT, createdAt: new Date(Date.now() - 3_600_000),
    });
    const ctx = await loadAmlExplainContext(db, (await createTransferRepo(db).getTransfer(id))!, 'acme');
    expect(ctx.recomputed).toBeNull();
  });

  it('a row with no AML reason: no recompute, checkFailed false', async () => {
    const t = await heldRow({ reasons: ['Possible sanctions match.'] });
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.recomputed).toBeNull();
    expect(ctx.checkFailed).toBe(false);
  });

  // Review round 1 RD1: a pay-step risk-signal hold adds AML_HOLD_REASON but
  // writes a risk.signals row, never an aml.hold row. It is NOT a pre-pack-6
  // hold: the legacy pair must not run (no AML rule held this row).
  async function riskSignals(subjectId: string, held: string[], partnerId: PartnerId = 'acme') {
    await createAuditRepo(db).record({
      partnerId, actor: 'system:risk-signals', actorType: 'system', action: 'risk.signals', subjectId,
      meta: { shown: ['new_account'], derived: ['new_account'], acked: true, held, warningVersion: 'v1', ackedAt: null },
    });
  }

  it('RD1: a risk-signal hold (risk.signals held, no aml.hold row) recomputes nothing and reads no ledger', async () => {
    const t = await heldRow({ amountUsd: 900 }); // first-ever sender, $900 >= firstUsd: the legacy pair would say first_transfer
    await riskSignals(t.id, ['new_account']);
    const stop = captureQueries();
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    const queries = stop();
    expect(ctx.recomputed).toBeNull();
    expect(ctx.checkFailed).toBe(false);
    expect(queries.filter((q) => /from "transfers"/i.test(q.sql))).toEqual([]);
    expect(fault.statsCalls).toBe(0);
    const { buildAmlExplainBundle } = await import('@/lib/aml-explain-ai');
    for (const audience of ['platform', 'partner'] as const) {
      const facts = buildAmlExplainBundle(t, ctx.alerts, ctx.cfg, audience, Date.now(), ctx.recomputed, ctx.purposeHold, ctx.checkFailed);
      expect(facts.rules).toEqual([]);
    }
  });

  it('RD1: a risk.signals row with an empty held list, or another tenant\'s, keeps the legacy pair', async () => {
    const t = await heldRow();
    await riskSignals(t.id, []);
    await riskSignals(t.id, ['new_account'], 'p2');
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.recomputed?.rule).toBe('first_transfer');
  });

  it('RD1: a row with BOTH an aml.hold row and a held risk.signals row keeps the aml.hold rules', async () => {
    const t = await heldRow();
    await amlHold(t.id, ['first_transfer']);
    await riskSignals(t.id, ['new_account']);
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.recomputed).toEqual({ rule: 'first_transfer', window: 'first', count: 1, sumUsd: 900 });
  });

  it('a recompute read error: recomputed null, logged by name, checkFailed false', async () => {
    const t = await heldRow();
    await amlHold(t.id, ['first_transfer']);
    fault.statsThrow = true;
    const ctx = await loadAmlExplainContext(db, t, 'acme');
    expect(ctx.recomputed).toBeNull();
    expect(ctx.checkFailed).toBe(false);
    expect(log.warns).toEqual([['aml.explain.recompute', 'TypeError', { transferId: t.id }]]);
  });
});
