import { describe, it, expect, vi, beforeEach } from 'vitest';

const logSpy = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logSpy.logWarn }));

import type { Db, DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import { AML_HOLD_REASON } from '@/lib/compliance-config';
import { boundHoldEvidence } from '@/lib/hold-decision';
import {
  AML_SUB_KINDS,
  EMPTY_AML_EVIDENCE,
  loadHoldEvidence,
  partnerScreeningView,
  toHoldReviewEvidence,
  type AmlSubKind,
  type HoldEvidence,
} from '@/lib/partner-screening-view';
import type { SanctionsDecision, ScreeningEvidence } from '@/lib/sanctions/evidence';
import type { Transfer } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { seedLiveEvidence } from './helpers-sanctions';

// Fix pack 7 T7 (P8): the masked screening view a qualified compliance user of
// a certified partner sees, and the AML sub-kind loader behind it.

const H1 = 'b'.repeat(64);
const H2 = 'c'.repeat(64);

function fullEvidence(): ScreeningEvidence {
  return {
    listSource: 'ofac-sdn',
    listVersion: '2026-11-01',
    listHash: 'a'.repeat(64),
    screenedAt: new Date(Date.now() - 60_000).toISOString(),
    decision: 'possible_match',
    parties: [
      { role: 'recipient', inputHash: H1, matched: true, matchScore: 0.91, matchedEntryId: 'sdn:12345' },
      { role: 'sender', inputHash: H2, matched: false, matchScore: 0.2 },
    ],
    listFitness: 'live',
    listCheckedAt: new Date(Date.now() - 3_600_000).toISOString(),
    listBaseHash: 'd'.repeat(64),
    lists: [{ source: 'ofac-sdn', version: 'v1', hash: 'e'.repeat(64), fitness: 'live', checkedAt: new Date().toISOString() }],
  };
}

const FORBIDDEN_KEYS = new Set(['inputHash', 'listHash', 'listBaseHash', 'hash', 'lists', 'name', 'phone', 'amount']);

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe('partnerScreeningView', () => {
  it('null and undefined -> null', () => {
    expect(partnerScreeningView(null)).toBeNull();
    expect(partnerScreeningView(undefined)).toBeNull();
  });

  it('a full pack 5 evidence -> exactly { listSource, listVersion, screenedAt, decision, parties }', () => {
    const ev = fullEvidence();
    const view = partnerScreeningView(ev)!;
    expect(Object.keys(view).sort()).toEqual(['decision', 'listSource', 'listVersion', 'parties', 'screenedAt']);
    expect(view.parties).toHaveLength(2);
    for (const p of view.parties) {
      expect(Object.keys(p).sort()).toEqual(['matched', 'matchedEntryId', 'role', 'score', 'screened']);
    }
    expect(view).toEqual({
      listSource: 'ofac-sdn',
      listVersion: '2026-11-01',
      screenedAt: ev.screenedAt,
      decision: 'possible_match',
      parties: [
        { role: 'recipient', matched: true, score: 0.91, matchedEntryId: 'sdn:12345', screened: true },
        { role: 'sender', matched: false, score: 0.2, matchedEntryId: null, screened: true },
      ],
    });
  });

  it('deep scan: no hash, list, name, phone or amount key anywhere in the output', () => {
    const view = partnerScreeningView(fullEvidence());
    for (const k of keysDeep(view)) expect(FORBIDDEN_KEYS.has(k)).toBe(false);
    const json = JSON.stringify(view);
    for (const h of [H1, H2, 'a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)]) expect(json).not.toContain(h);
  });

  it('an unscreened party reads screened false and score null; a non-finite score reads null; a missing matchedEntryId reads null', () => {
    const ev = fullEvidence();
    ev.parties = [
      { role: 'sender', inputHash: H2, matched: false, matchScore: 0, unscreened: true },
      { role: 'recipient', inputHash: null, matched: false, matchScore: Number.NaN },
      { role: 'recipient', inputHash: H1, matched: false, matchScore: Number.POSITIVE_INFINITY },
    ];
    const view = partnerScreeningView(ev)!;
    expect(view.parties).toEqual([
      { role: 'sender', matched: false, score: null, matchedEntryId: null, screened: false },
      { role: 'recipient', matched: false, score: null, matchedEntryId: null, screened: true },
      { role: 'recipient', matched: false, score: null, matchedEntryId: null, screened: true },
    ]);
  });

  it('the decision passes through for each SanctionsDecision value', () => {
    const all: SanctionsDecision[] = ['clear', 'match', 'possible_match', 'list_unavailable', 'error'];
    for (const decision of all) {
      expect(partnerScreeningView({ ...fullEvidence(), decision })!.decision).toBe(decision);
    }
  });
});

describe('loadHoldEvidence', () => {
  let db: Db;
  let t: Transfer;

  async function audit(partnerId: string, action: string, meta: Record<string, unknown>, actorType: 'system' | 'staff' = 'system') {
    await createAuditRepo(db).record({ partnerId, actor: actorType === 'system' ? 'system:test' : 'staffer', actorType, action, subjectId: 'th1', meta });
  }

  const throwingDb = { select() { throw new Error('boom'); } } as unknown as DbOrTx;

  beforeEach(async () => {
    logSpy.logWarn.mockClear();
    db = await freshDb();
    await seedPartner(db, 'pa');
    await seedPartner(db, 'pb');
    t = await seedPartnerTransfer(db, {
      id: 'th1', partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [AML_HOLD_REASON],
    });
  });

  it('screening is the NEWEST screen, masked', async () => {
    await seedLiveEvidence(db, t, { decision: 'clear', at: new Date(Date.now() - 1000) });
    await seedLiveEvidence(db, t, { decision: 'possible_match' });
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e.screening?.decision).toBe('possible_match');
    for (const k of keysDeep(e)) expect(FORBIDDEN_KEYS.has(k)).toBe(false);
    expect(JSON.stringify(e)).not.toContain('a'.repeat(64));
  });

  it('aml sub-kinds from the three audit actions', async () => {
    await audit('pa', 'aml.hold', { rules: ['structuring', 'check_failed', 'bogus'] });
    await audit('pa', 'purpose.flag', { category: 'romance' });
    await audit('pa', 'risk.signals', { held: ['first_to_recipient', 'bogus'], shown: ['chat_cue'] });
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e.aml).toEqual({
      kinds: ['aml_rule', 'aml_check_failed', 'scam_pattern', 'risk_signal'],
      rules: ['structuring'],
      scamCategory: 'romance',
      riskSignals: ['first_to_recipient'],
    });
    expect(JSON.stringify(e)).not.toContain('chat_cue');
  });

  it('kinds, rules and signals are de-duplicated and kept in registry order', async () => {
    await audit('pa', 'aml.hold', { rules: ['new_beneficiary', 'structuring', 'structuring'] });
    await audit('pa', 'risk.signals', { held: ['new_account', 'first_to_recipient', 'new_account'] });
    await audit('pa', 'risk.signals', { held: ['first_to_recipient'] });
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e.aml.kinds).toEqual(['aml_rule', 'risk_signal']);
    expect(e.aml.rules).toEqual(['structuring', 'new_beneficiary']);
    expect(e.aml.riskSignals).toEqual(['first_to_recipient', 'new_account']);
  });

  it('risk.signals with held [] adds no risk_signal kind (record-only signals)', async () => {
    await audit('pa', 'risk.signals', { held: [], shown: ['first_transfer'] });
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e.aml).toEqual({ kinds: [], rules: [], scamCategory: null, riskSignals: [] });
  });

  it('purpose.flag with a category outside the closed set -> scam_pattern, scamCategory null; the stored text never appears', async () => {
    const text = 'please send to my lover overseas';
    await audit('pa', 'purpose.flag', { category: text });
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e.aml.kinds).toEqual(['scam_pattern']);
    expect(e.aml.scamCategory).toBeNull();
    expect(JSON.stringify(e)).not.toContain(text);
  });

  it('tenant pin: rows of partner pb with the same subject id are not read, and staff rows are ignored', async () => {
    await audit('pb', 'aml.hold', { rules: ['structuring'] });
    await audit('pb', 'purpose.flag', { category: 'romance' });
    await audit('pa', 'risk.signals', { held: ['first_transfer'] }, 'staff');
    await audit('pa', 'aml.hold', { rules: ['first_transfer'] }, 'staff');
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e.aml).toEqual({ kinds: [], rules: [], scamCategory: null, riskSignals: [] });
  });

  it('a pre-pack-6 hold (no aml.hold, purpose.flag or risk.signals row) -> the empty sub-kinds', async () => {
    const e = await loadHoldEvidence(db, 'pa', t);
    expect(e).toEqual({ screening: null, aml: { kinds: [], rules: [], scamCategory: null, riskSignals: [] } });
  });

  it('owner mismatch or an empty ownerId -> { screening: null, aml: empty } and NO read', async () => {
    const a = await loadHoldEvidence(throwingDb, 'pb', t);
    const b = await loadHoldEvidence(throwingDb, '', t);
    const c = await loadHoldEvidence(throwingDb, '', { ...t, partnerId: '' });
    for (const r of [a, b, c]) expect(r).toEqual({ screening: null, aml: EMPTY_AML_EVIDENCE });
    expect(logSpy.logWarn).not.toHaveBeenCalled();
  });

  it('both reads fail -> { screening: null, aml: empty }, two logWarn calls with the error NAME and { transferId } only', async () => {
    const e = await loadHoldEvidence(throwingDb, 'pa', t);
    expect(e).toEqual({ screening: null, aml: EMPTY_AML_EVIDENCE });
    expect(logSpy.logWarn).toHaveBeenCalledTimes(2);
    expect(logSpy.logWarn).toHaveBeenCalledWith('hold.evidence.screening', 'Error', { transferId: 'th1' });
    expect(logSpy.logWarn).toHaveBeenCalledWith('hold.evidence.aml', 'Error', { transferId: 'th1' });
  });

  it('an unreadable createdAt -> screening null; the aml read still works', async () => {
    await seedLiveEvidence(db, t, { decision: 'possible_match' });
    await audit('pa', 'aml.hold', { rules: ['structuring'] });
    const e = await loadHoldEvidence(db, 'pa', { ...t, createdAt: 'not-a-date' });
    expect(e.screening).toBeNull();
    expect(e.aml.kinds).toEqual(['aml_rule']);
    expect(e.aml.rules).toEqual(['structuring']);
  });

  it('EMPTY_AML_EVIDENCE is frozen', () => {
    expect(Object.isFrozen(EMPTY_AML_EVIDENCE)).toBe(true);
    expect(Object.isFrozen(EMPTY_AML_EVIDENCE.kinds)).toBe(true);
    expect(Object.isFrozen(EMPTY_AML_EVIDENCE.rules)).toBe(true);
    expect(Object.isFrozen(EMPTY_AML_EVIDENCE.riskSignals)).toBe(true);
  });
});

describe('toHoldReviewEvidence', () => {
  it('maps the view to HoldReviewEvidence', () => {
    const ev = fullEvidence();
    ev.parties.push({ role: 'recipient', inputHash: H1, matched: true, matchScore: 0.95, matchedEntryId: 'sdn:777' });
    ev.parties.push({ role: 'sender', inputHash: H2, matched: false, matchScore: 0.99, unscreened: true });
    const e: HoldEvidence = {
      screening: partnerScreeningView(ev),
      aml: { kinds: ['aml_rule', 'scam_pattern'], rules: ['structuring'], scamCategory: 'romance', riskSignals: [] },
    };
    const out = toHoldReviewEvidence(e);
    expect(out).toEqual({
      listSource: 'ofac-sdn',
      listVersion: '2026-11-01',
      screenedAt: ev.screenedAt,
      maxScore: 0.95,
      matchedEntryIds: ['sdn:12345', 'sdn:777'],
      amlKinds: ['aml_rule', 'scam_pattern'],
      amlRules: ['structuring'],
      scamCategory: 'romance',
    });
    expect(boundHoldEvidence(out)).toEqual(out);
  });

  it('maxScore is absent when no party has a score; scamCategory only when non-null', () => {
    const ev = fullEvidence();
    ev.parties = [{ role: 'sender', inputHash: H2, matched: false, matchScore: 0, unscreened: true }];
    const out = toHoldReviewEvidence({ screening: partnerScreeningView(ev), aml: EMPTY_AML_EVIDENCE });
    expect('maxScore' in out).toBe(false);
    expect('matchedEntryIds' in out).toBe(false);
    expect('scamCategory' in out).toBe(false);
    expect(out).toEqual({ listSource: 'ofac-sdn', listVersion: '2026-11-01', screenedAt: ev.screenedAt });
  });

  it('null screening and empty aml -> {}', () => {
    expect(toHoldReviewEvidence({ screening: null, aml: EMPTY_AML_EVIDENCE })).toEqual({});
  });

  it('AML_SUB_KINDS matches HoldReviewEvidence["amlKinds"] element type', () => {
    type RepoKind = NonNullable<HoldReviewEvidence['amlKinds']>[number];
    const fromRepo: readonly AmlSubKind[] = [] as RepoKind[];
    const toRepo: readonly RepoKind[] = AML_SUB_KINDS;
    expect(fromRepo).toEqual([]);
    expect(toRepo).toBe(AML_SUB_KINDS);
    expect(AML_SUB_KINDS).toEqual(['aml_rule', 'aml_check_failed', 'scam_pattern', 'risk_signal']);
    expect(Object.isFrozen(AML_SUB_KINDS)).toBe(true);
  });
});
