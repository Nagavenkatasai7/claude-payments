import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb } from './helpers-db';
import { seedLiveEvidence } from './helpers-sanctions';
import { auditEvents } from '@/db/schema';
import { SANCTIONS_AUDIT_ACTION } from '@/lib/sanctions/evidence';
import { listScreenEvidence } from '@/lib/sanctions/evidence-read';
import { loadComplianceBlock } from '@/lib/instruction-compliance';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 4 T13 (C20): the instruction's screening reference is the NEWEST valid
// sanctions.screen row, the same one listScreenEvidence(...).at(-1) gives the instruct
// gate; not a ±10-minute window around the mint, and not capped by other audit rows.

const evidenceFault = vi.hoisted(() => ({ throwOnRead: false }));
vi.mock('@/lib/sanctions/evidence-read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/sanctions/evidence-read')>();
  return {
    ...real,
    listScreenEvidence: async (...a: Parameters<typeof real.listScreenEvidence>) => {
      if (evidenceFault.throwOnRead) throw new Error('evidence read failed');
      return real.listScreenEvidence(...a);
    },
  };
});

const HOUR = 60 * 60 * 1000;

function transferAt(createdAt: Date, id = 'icr_t1'): Transfer {
  return {
    id, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: createdAt.toISOString(), paidAt: createdAt.toISOString(), partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  evidenceFault.throwOnRead = false;
});
afterEach(() => {
  evidenceFault.throwOnRead = false;
  vi.restoreAllMocks();
});

describe('loadComplianceBlock: the screening reference is the newest screen (pack 4 T13, C20)', () => {
  it('the reference is the NEWEST sanctions.screen row, also when it was written hours after the mint', async () => {
    const createdAt = new Date(Date.now() - 4 * HOUR);
    const t = transferAt(createdAt);
    await seedLiveEvidence(db, t, { at: createdAt, screenedAgoMs: 4 * HOUR, decision: 'clear' });
    const payTime = new Date(createdAt.getTime() + 3 * HOUR);
    const later = await seedLiveEvidence(db, t, { at: payTime, screenedAgoMs: HOUR, decision: 'possible_match' });
    const now = new Date();

    const newest = (await listScreenEvidence(db, t, now)).at(-1);
    expect(newest?.screenedAt).toBe(later.screenedAt);
    const block = await loadComplianceBlock(db, t, now);
    expect(block?.screening).toMatchObject({
      screened_at: later.screenedAt, decision: 'possible_match', list_source: 'ofac-sdn', list_version: 'test-version',
    });
  });

  it('more than 200 other audit rows on the subject do not hide the screen', async () => {
    const createdAt = new Date(Date.now() - 5 * 60 * 1000);
    const t = transferAt(createdAt, 'icr_many');
    const otherAt = new Date(createdAt.getTime() + 60 * 1000);
    await db.insert(auditEvents).values(
      Array.from({ length: 250 }, () => ({
        partnerId: 'default', actor: 'system:test', actorType: 'system', action: 'transfer.note', subjectId: t.id, meta: {}, at: otherAt,
      })),
    );
    const ev = await seedLiveEvidence(db, t, { at: new Date(createdAt.getTime() + 2 * 60 * 1000), decision: 'clear' });

    const block = await loadComplianceBlock(db, t, new Date());
    expect(block?.screening).toMatchObject({ screened_at: ev.screenedAt, decision: 'clear', list_source: 'ofac-sdn' });
  });

  it('a malformed newest row is skipped; the previous valid row is the reference', async () => {
    const createdAt = new Date(Date.now() - 2 * HOUR);
    const t = transferAt(createdAt, 'icr_bad');
    const valid = await seedLiveEvidence(db, t, { at: createdAt, screenedAgoMs: 2 * HOUR, decision: 'clear' });
    await db.insert(auditEvents).values({
      partnerId: 'default', actor: 'system:sanctions', actorType: 'system', action: SANCTIONS_AUDIT_ACTION, subjectId: t.id,
      // a role evidence-read does not know: the whole row is malformed
      meta: {
        listSource: 'ofac-sdn', listVersion: 'v-bad', listHash: 'b'.repeat(64), screenedAt: new Date().toISOString(),
        decision: 'match', parties: [{ role: 'beneficiary', inputHash: 'c'.repeat(64), matched: true, matchScore: 1 }],
      },
      at: new Date(createdAt.getTime() + HOUR),
    });

    const block = await loadComplianceBlock(db, t, new Date());
    expect(block?.screening).toMatchObject({ screened_at: valid.screenedAt, decision: 'clear', list_version: 'test-version' });
  });

  it('no evidence -> the screening list fields are omitted', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_none');
    const block = await loadComplianceBlock(db, t, new Date());
    expect(Object.keys(block!.screening).sort()).toEqual(['reasons', 'screened_at', 'status']);
    expect(block!.screening.screened_at).toBe(t.createdAt);
  });

  it('the evidence read throws -> the block degrades as today (fail open, originator null), a warn names the transfer id only', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_throw');
    await seedLiveEvidence(db, t, { at: new Date(Date.now() - HOUR) });
    evidenceFault.throwOnRead = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const block = await loadComplianceBlock(db, t, new Date());
    expect(block).toBeDefined();
    expect(block!.originator).toBeNull();
    expect(Object.keys(block!.screening).sort()).toEqual(['reasons', 'screened_at', 'status']);
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('instruct.compliance_block'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('icr_throw');
    expect(lines[0]).not.toContain('evidence read failed');
  });
});
