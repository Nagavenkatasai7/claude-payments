import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb } from './helpers-db';
import { seedLiveEvidence } from './helpers-sanctions';
import { auditEvents } from '@/db/schema';
import { SANCTIONS_AUDIT_ACTION } from '@/lib/sanctions/evidence';
import { listScreenEvidence } from '@/lib/sanctions/evidence-read';
import { ComplianceBlockUnavailableError, loadComplianceBlock } from '@/lib/instruction-compliance';
import { InstructPermanentError } from '@/lib/instruct-errors';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 4 T13 (C20): the instruction's screening reference is the NEWEST valid
// sanctions.screen row, the same one listScreenEvidence(...).at(-1) gives the instruct
// gate; not a ±10-minute window around the mint, and not capped by other audit rows.

const evidenceFault = vi.hoisted(() => ({ throwOnRead: false, transient: false, poolTimeout: false }));
vi.mock('@/lib/sanctions/evidence-read', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/sanctions/evidence-read')>();
  return {
    ...real,
    listScreenEvidence: async (...a: Parameters<typeof real.listScreenEvidence>) => {
      // fix pack 5 T5: a driver-shaped (SQLSTATE + severity) error and the Neon pool's connect
      // timeout are transient (P7 allow-list); a plain Error is not.
      if (evidenceFault.transient) throw Object.assign(new Error('connection reset'), { code: '08006', severity: 'ERROR' });
      if (evidenceFault.poolTimeout) throw new Error('timeout exceeded when trying to connect');
      if (evidenceFault.throwOnRead) throw new Error('evidence read failed');
      return real.listScreenEvidence(...a);
    },
  };
});

// fix pack 5 T5: a customer read that fails like a decrypt / AAD failure (not transient).
const customerFault = vi.hoisted(() => ({ decrypt: false }));
vi.mock('@/db/repos/customer-repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...args: Parameters<typeof real.createCustomerRepo>) => {
      const repo = real.createCustomerRepo(...args);
      return {
        ...repo,
        getCustomer: async (...a: Parameters<typeof repo.getCustomer>) => {
          if (customerFault.decrypt) throw new Error('Unsupported state or unable to authenticate data');
          return repo.getCustomer(...a);
        },
      };
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
  Object.assign(evidenceFault, { throwOnRead: false, transient: false, poolTimeout: false });
  customerFault.decrypt = false;
});
afterEach(() => {
  Object.assign(evidenceFault, { throwOnRead: false, transient: false, poolTimeout: false });
  customerFault.decrypt = false;
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
    expect(block.screening).toMatchObject({
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
    expect(block.screening).toMatchObject({ screened_at: ev.screenedAt, decision: 'clear', list_source: 'ofac-sdn' });
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
    expect(block.screening).toMatchObject({ screened_at: valid.screenedAt, decision: 'clear', list_version: 'test-version' });
  });

  it('no evidence -> the screening list fields are omitted', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_none');
    const block = await loadComplianceBlock(db, t, new Date());
    expect(Object.keys(block.screening).sort()).toEqual(['reasons', 'screened_at', 'status']);
    expect(block.screening.screened_at).toBe(t.createdAt);
  });

  it('the evidence read throws a NON-transient error -> InstructPermanentError(compliance_block); one warn naming the transfer id and the error NAME only', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_throw');
    await seedLiveEvidence(db, t, { at: new Date(Date.now() - HOUR) });
    evidenceFault.throwOnRead = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await loadComplianceBlock(db, t, new Date()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InstructPermanentError);
    expect((err as InstructPermanentError).code).toBe('compliance_block');
    expect((err as InstructPermanentError).transferId).toBe('icr_throw');
    expect((err as Error).message).toBe('instruct_permanent:compliance_block:icr_throw');
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('instruct.compliance_block'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('icr_throw');
    expect(lines[0]).toContain('Error');
    expect(lines[0]).not.toContain('evidence read failed');
  });

  it('a driver-shaped (SQLSTATE + severity) read error -> ComplianceBlockUnavailableError with railPartnerId = the transfer rail', async () => {
    const t = { ...transferAt(new Date(Date.now() - HOUR), 'icr_drv'), settlementPartnerId: 'railp' } as Transfer;
    evidenceFault.transient = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await loadComplianceBlock(db, t, new Date()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ComplianceBlockUnavailableError);
    expect((err as ComplianceBlockUnavailableError).railPartnerId).toBe('railp');
    expect((err as ComplianceBlockUnavailableError).transferId).toBe('icr_drv');

    const own = transferAt(new Date(Date.now() - HOUR), 'icr_drv2');
    const err2 = await loadComplianceBlock(db, own, new Date()).then(() => null, (e: unknown) => e);
    expect((err2 as ComplianceBlockUnavailableError).railPartnerId).toBe('default');
  });

  it('a pool connect timeout (timeout exceeded when trying to connect) -> ComplianceBlockUnavailableError, never permanent', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_pool');
    evidenceFault.poolTimeout = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await loadComplianceBlock(db, t, new Date()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ComplianceBlockUnavailableError);
    expect(err).not.toBeInstanceOf(InstructPermanentError);
  });

  it('names_screened counts the newest screen parties by role', async () => {
    const createdAt = new Date(Date.now() - 2 * HOUR);
    const t = transferAt(createdAt, 'icr_names');
    await seedLiveEvidence(db, t, { at: createdAt, screenedAgoMs: 2 * HOUR });
    const first = await loadComplianceBlock(db, t, new Date());
    expect((first.screening as { names_screened?: unknown }).names_screened).toEqual({ sender: 0, recipient: 1 });

    await seedLiveEvidence(db, { ...t, senderName: 'Some Sender' }, { at: new Date(createdAt.getTime() + HOUR), screenedAgoMs: HOUR });
    const second = await loadComplianceBlock(db, t, new Date());
    expect((second.screening as { names_screened?: unknown }).names_screened).toEqual({ sender: 1, recipient: 1 });
    expect(JSON.stringify(second)).not.toContain('Some Sender');
  });

  it('a customer read failure is no longer degraded: it throws (decrypt-shaped -> permanent)', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_cust');
    customerFault.decrypt = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await loadComplianceBlock(db, t, new Date()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InstructPermanentError);
    expect((err as InstructPermanentError).code).toBe('compliance_block');
  });

  // Fix pack 5 T29 (P26, P10): lists[] is copied onto the wire as { source, version, fitness }
  // (no hash, no checkedAt); evidence without lists gives no lists key.
  const rawScreen = async (t: Transfer, meta: Record<string, unknown>) =>
    db.insert(auditEvents).values({
      partnerId: 'default', actor: 'system:sanctions', actorType: 'system', action: SANCTIONS_AUDIT_ACTION, subjectId: t.id, meta,
    });

  it('evidence with lists[] -> block.screening.lists = [{ source, version, fitness }] (no hash, no checkedAt)', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_lists');
    const checkedAt = new Date(Date.now() - HOUR).toISOString();
    await rawScreen(t, {
      listSource: 'lists:ofac-sdn+ofac-cons', listVersion: 'v1+v2', listHash: 'f'.repeat(64), screenedAt: new Date().toISOString(),
      decision: 'clear', parties: [{ role: 'recipient', inputHash: 'c'.repeat(64), matched: false, matchScore: 0 }], listFitness: 'live',
      lists: [
        { source: 'ofac-sdn', version: 'v1', hash: 'a'.repeat(64), fitness: 'live', checkedAt },
        { source: 'ofac-cons', version: 'v2', hash: 'b'.repeat(64), fitness: 'live', checkedAt },
      ],
    });
    const block = await loadComplianceBlock(db, t, new Date());
    expect((block.screening as { lists?: unknown }).lists).toEqual([
      { source: 'ofac-sdn', version: 'v1', fitness: 'live' },
      { source: 'ofac-cons', version: 'v2', fitness: 'live' },
    ]);
    const raw = JSON.stringify(block);
    expect(raw).not.toContain('a'.repeat(64));
    expect(raw).not.toContain(checkedAt);
  });

  it('evidence without lists -> no lists key on the block screening', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_nolists');
    await seedLiveEvidence(db, t, { at: new Date(Date.now() - HOUR) });
    const block = await loadComplianceBlock(db, t, new Date());
    expect('lists' in block.screening).toBe(false);
  });

  it('an evidence row stored before this pack (no listFitness, no lists, no unscreened) still parses and gives a valid version 2 block', async () => {
    const t = transferAt(new Date(Date.now() - HOUR), 'icr_old');
    const screenedAt = new Date(Date.now() - HOUR).toISOString();
    await rawScreen(t, {
      listSource: 'mock-watchlist', listVersion: 'static', listHash: 'd'.repeat(64), screenedAt, decision: 'clear',
      parties: [
        { role: 'recipient', inputHash: null, matched: false, matchScore: 0 },
        { role: 'sender', inputHash: 'e'.repeat(64), matched: false, matchScore: 0 },
      ],
    });
    const block = await loadComplianceBlock(db, t, new Date());
    expect(block.version).toBe(2);
    expect(block.screening).toEqual({
      status: 'cleared', reasons: [], screened_at: screenedAt,
      list_source: 'mock-watchlist', list_version: 'static', decision: 'clear',
      names_screened: { sender: 1, recipient: 1 },
    });
  });
});
