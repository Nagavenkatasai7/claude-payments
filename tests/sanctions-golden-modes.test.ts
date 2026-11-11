import { describe, it, expect, afterEach, vi } from 'vitest';
import { screenTransfer } from '@/lib/compliance';
import { buildComplianceBlock } from '@/lib/providers/http-payment-provider';
import { inputHash } from '@/lib/sanctions/evidence';
import type { Customer, Transfer } from '@/lib/types';
import { primeOfacSource, restoreOfacSource } from './helpers-sanctions';

// Fix pack 5 T28 (R08, P25): a CHARACTERISATION test. The opt-in
// SANCTIONS_LIST=lists mode must leave every other value byte-identical: for
// unset, 'mock', 'ofac-sdn' and an unknown value the screening evidence of a
// fixed pair of names deep-equals the literal below (written from the shape
// before the multi-list screener existed, and seen green on that code first),
// with NO `lists` key, and the compliance block's screening keys are the same
// in every mode. Pure: no DB (screenTransfer and buildComplianceBlock need none).

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

function transfer(): Transfer {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: 'gold_t1', phone: '15550000001', amountUsd: 50, feeUsd: 5, totalChargeUsd: 55,
    fxRate: 83, amountInr: 4150, recipientName: 'Golden Payee', recipientPhone: '919800000001',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: at, paidAt: at, partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 50, feeSource: 5, totalChargeSource: 55,
  } as Transfer;
}

function customer(): Customer {
  const at = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return {
    senderPhone: '15550000001', firstSeenAt: at, kycStatus: 'verified', kycVerifiedAt: at,
    fullName: 'Golden Sender', senderCountry: 'US', partnerId: 'acme', createdAt: at, updatedAt: at,
  } as Customer;
}

async function screeningKeys(): Promise<string[]> {
  const r = await screenTransfer({ amountUsd: 50, recipientName: CLEAN_RECIPIENT, senderName: CLEAN_SENDER, transfersToday: 0 });
  const e = r.evidence!;
  const block = buildComplianceBlock(transfer(), customer(), new Date(), {
    kycGateActive: true,
    screening: { listSource: e.listSource, listVersion: e.listVersion, decision: e.decision, screenedAt: e.screenedAt },
  } as Parameters<typeof buildComplianceBlock>[3]);
  return Object.keys((block as unknown as { screening: Record<string, unknown> }).screening).sort();
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

  it('the compliance block screening keys are the same in every mode, with no lists key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sets: string[][] = [];
    for (const value of [undefined, 'mock', 'bogus']) {
      if (value === undefined) delete process.env.SANCTIONS_LIST;
      else process.env.SANCTIONS_LIST = value;
      sets.push(await screeningKeys());
    }
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    sets.push(await screeningKeys());
    for (const s of sets) {
      expect(s).toEqual(sets[0]);
      expect(s).not.toContain('lists');
      // The keys every block version carries (pack 4 C20); T5's version 2 adds names_screened.
      expect(s).toEqual(expect.arrayContaining(['decision', 'list_source', 'list_version', 'reasons', 'screened_at', 'status']));
    }
  });
});
