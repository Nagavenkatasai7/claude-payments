import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screenTransfer } from '@/lib/compliance';
import { loadComplianceBlock } from '@/lib/instruction-compliance';
import { inputHash, sanctionsAuditEvent } from '@/lib/sanctions/evidence';
import { auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';
import { listSetList, primeListSet, primeOfacSource, restoreOfacSource } from './helpers-sanctions';

// Fix pack 5 T28 (R08, P25): a CHARACTERISATION test. The opt-in
// SANCTIONS_LIST=lists mode must leave every other value byte-identical: for
// unset, 'mock', 'ofac-sdn' and an unknown value the screening evidence of a
// fixed pair of names deep-equals the literal below (written from the shape
// before the multi-list screener existed, and seen green on that code first),
// with NO `lists` key. Fix pack 5 T29: the compliance block is built through the
// real path (stored evidence -> loadComplianceBlock, PGlite) and its screening
// object is pinned with values, exact version 2 keys and no lists key.

const SCREENED_AT = '<screenedAt>';
const CHECKED_AT = '<listCheckedAt>';

// The mock list hash: sha256 of the sorted, normalised global WATCHLIST.
const MOCK_HASH = '8acf7a588ada49384e3661acab93d34b31c504ec63a5831330dd962947734357';
// ofac-sdn: sha256(sample list hash + '\n' + the WATCHLIST extras digest).
const OFAC_HASH = '00bfe29a82d0cd55e400d97e0cff5eb213936ee156b539bc60694b51c8a3cc2d';
// The OFAC sample fixture's own hash (listBaseHash).
const OFAC_BASE_HASH = '9473e6ebe2bf7508457162433e92cbe4b66cb5d5c47c9539857ad642231e7510';

const CLEAN_RECIPIENT = 'Clean Golden Recipient';
const CLEAN_SENDER = 'Clean Golden Sender';
const LISTED_SENDER = 'John Doe'; // WATCHLIST[0]: mock:0 on the mock, extra:0 on the OFAC screener

function normalise(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e, screenedAt: SCREENED_AT };
  if ('listCheckedAt' in out) out.listCheckedAt = CHECKED_AT;
  return out;
}

async function screenPair(senderName: string) {
  const r = await screenTransfer({ amountUsd: 50, recipientName: CLEAN_RECIPIENT, senderName, transfersToday: 0 });
  return { status: r.status, reasons: r.reasons, evidence: normalise(r.evidence as unknown as Record<string, unknown>) };
}

const mockExpected = (senderName: string, blocked: boolean) => ({
  status: blocked ? 'blocked' : 'cleared',
  reasons: blocked ? ['Sender is on the compliance watchlist.'] : [],
  evidence: {
    listSource: 'mock-watchlist',
    listVersion: 'static',
    listHash: MOCK_HASH,
    screenedAt: SCREENED_AT,
    decision: blocked ? 'match' : 'clear',
    parties: [
      { role: 'recipient', inputHash: inputHash(CLEAN_RECIPIENT), matched: false, matchScore: 0 },
      blocked
        ? { role: 'sender', inputHash: inputHash(senderName), matched: true, matchScore: 1, matchedEntryId: 'mock:0' }
        : { role: 'sender', inputHash: inputHash(senderName), matched: false, matchScore: 0 },
    ],
    listFitness: 'not_live',
  },
});

const ofacExpected = (senderName: string, blocked: boolean) => ({
  status: blocked ? 'blocked' : 'cleared',
  reasons: blocked ? ['Sender is on the compliance watchlist.'] : [],
  evidence: {
    listSource: 'ofac-sdn',
    listVersion: '2026-09-18',
    listHash: OFAC_HASH,
    screenedAt: SCREENED_AT,
    decision: blocked ? 'match' : 'clear',
    parties: [
      { role: 'recipient', inputHash: inputHash(CLEAN_RECIPIENT), matched: false, matchScore: 0 },
      blocked
        ? { role: 'sender', inputHash: inputHash(senderName), matched: true, matchScore: 1, matchedEntryId: 'extra:0' }
        : { role: 'sender', inputHash: inputHash(senderName), matched: false, matchScore: 0 },
    ],
    listFitness: 'live',
    listCheckedAt: CHECKED_AT,
    listBaseHash: OFAC_BASE_HASH,
  },
});

function transfer(id: string, r: { status: string; reasons: string[] }): Transfer {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id, phone: '15550000001', amountUsd: 50, feeUsd: 5, totalChargeUsd: 55,
    fxRate: 83, amountInr: 4150, recipientName: 'Golden Payee', recipientPhone: '919800000001',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: r.status, complianceReasons: r.reasons,
    createdAt: at, paidAt: at, partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 50, feeSource: 5, totalChargeSource: 55,
  } as Transfer;
}

/** The version 2 screening keys (fix pack 5 T5), in order; 'lists' is added only under SANCTIONS_LIST=lists (T29). */
const V2_SCREENING_KEYS = ['status', 'reasons', 'screened_at', 'list_source', 'list_version', 'decision', 'names_screened'];

let seq = 0;
/**
 * Fix pack 5 T29 (L1 amendment): the REAL path. screenTransfer's evidence is
 * stored as the mint stores it (sanctionsAuditEvent, owner tenant), then the
 * worker's loadComplianceBlock reads it back (listScreenEvidence -> parseEvidence
 * -> screeningRef) and builds the block.
 */
async function blockScreening(db: Db, senderName: string) {
  const r = await screenTransfer({
    amountUsd: 50, recipientName: CLEAN_RECIPIENT, senderName, transfersToday: 0, destinationCountry: 'IN',
  });
  const t = transfer(`gold_t${++seq}`, r);
  const row = sanctionsAuditEvent(t.partnerId, t.id, r.evidence!);
  await db.insert(auditEvents).values({
    partnerId: row.partnerId ?? null, actor: row.actor, actorType: row.actorType, action: row.action,
    subjectId: row.subjectId ?? null, meta: row.meta ?? null,
  });
  const block = await loadComplianceBlock(db, t, new Date());
  return { evidence: r.evidence!, screening: block.screening as Record<string, unknown> };
}

describe('SANCTIONS_LIST unset / mock / ofac-sdn / unknown stay byte-identical (pack 5 T28)', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => {
    restoreOfacSource(original);
    vi.restoreAllMocks();
  });

  const MOCK_MODES: Array<[string, string | undefined]> = [['unset', undefined], ['mock', 'mock'], ['bogus', 'bogus']];
  for (const [label, value] of MOCK_MODES) {
    it(`${label}: the mock evidence for a clean and a listed pair equals the literal, no lists key`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (value === undefined) delete process.env.SANCTIONS_LIST;
      else process.env.SANCTIONS_LIST = value;
      const clean = await screenPair(CLEAN_SENDER);
      const listed = await screenPair(LISTED_SENDER);
      expect(clean).toEqual(mockExpected(CLEAN_SENDER, false));
      expect(listed).toEqual(mockExpected(LISTED_SENDER, true));
      expect('lists' in clean.evidence).toBe(false);
      expect('lists' in listed.evidence).toBe(false);
    });
  }

  it('ofac-sdn (a live list): the evidence for a clean and a listed pair equals the literal, no lists key', async () => {
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    const clean = await screenPair(CLEAN_SENDER);
    const listed = await screenPair(LISTED_SENDER);
    expect(clean).toEqual(ofacExpected(CLEAN_SENDER, false));
    expect(listed).toEqual(ofacExpected(LISTED_SENDER, true));
    expect('lists' in clean.evidence).toBe(false);
  });

  // Fix pack 5 T29 (L1 amendment, LE2/LE3): the block through the real path, with
  // values, for each old mode: the exact version 2 screening keys and NO lists key.
  describe('the compliance block screening through the real path (pack 5 T29)', () => {
    let db: Db;
    beforeEach(async () => {
      db = await freshDb();
      await seedPartner(db, 'acme');
    });

    const screeningFor = (e: { screenedAt: string }, over: Record<string, unknown>) => ({
      status: 'cleared', reasons: [], screened_at: e.screenedAt, decision: 'clear',
      names_screened: { sender: 1, recipient: 1 }, ...over,
    });

    for (const [label, value] of MOCK_MODES) {
      it(`${label}: the whole screening object equals the expected values; exact version 2 keys, no lists key`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        if (value === undefined) delete process.env.SANCTIONS_LIST;
        else process.env.SANCTIONS_LIST = value;
        const clean = await blockScreening(db, CLEAN_SENDER);
        expect(clean.screening).toEqual(screeningFor(clean.evidence, { list_source: 'mock-watchlist', list_version: 'static' }));
        expect(Object.keys(clean.screening)).toEqual(V2_SCREENING_KEYS);
        const listed = await blockScreening(db, LISTED_SENDER);
        expect(listed.screening).toEqual(screeningFor(listed.evidence, {
          status: 'blocked', reasons: ['Sender is on the compliance watchlist.'], decision: 'match',
          list_source: 'mock-watchlist', list_version: 'static',
        }));
        expect(Object.keys(listed.screening)).toEqual(V2_SCREENING_KEYS);
      });
    }

    it('ofac-sdn: the whole screening object equals the expected values; exact version 2 keys, no lists key', async () => {
      primeOfacSource({ checkedAgoMs: 3_600_000 });
      const clean = await blockScreening(db, CLEAN_SENDER);
      expect(clean.screening).toEqual(screeningFor(clean.evidence, { list_source: 'ofac-sdn', list_version: '2026-09-18' }));
      expect(Object.keys(clean.screening)).toEqual(V2_SCREENING_KEYS);
      const listed = await blockScreening(db, LISTED_SENDER);
      expect(listed.screening).toEqual(screeningFor(listed.evidence, {
        status: 'blocked', reasons: ['Sender is on the compliance watchlist.'], decision: 'match',
        list_source: 'ofac-sdn', list_version: '2026-09-18',
      }));
      expect(Object.keys(listed.screening)).toEqual(V2_SCREENING_KEYS);
    });

    it('lists: the same version 2 keys plus lists, one { source, version, fitness } per floor list of the destination', async () => {
      primeListSet({});
      const clean = await blockScreening(db, CLEAN_SENDER);
      const sources = ['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa'] as const;
      const versions = sources.map((src) => listSetList(src).version);
      expect(clean.screening).toEqual(screeningFor(clean.evidence, {
        list_source: `lists:${sources.join('+')}`, list_version: versions.join('+'),
        lists: sources.map((source, i) => ({ source, version: versions[i], fitness: 'live' })),
      }));
      expect(Object.keys(clean.screening)).toEqual([...V2_SCREENING_KEYS, 'lists']);
    });
  });
});
