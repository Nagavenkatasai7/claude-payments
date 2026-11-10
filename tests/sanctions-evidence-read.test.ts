import { describe, it, expect, beforeEach } from 'vitest';
import { auditEvents } from '@/db/schema';
import { instructGateRefuses, listScreenEvidence, liveFresh, uncoveredRoles } from '@/lib/sanctions/evidence-read';
import { inputHash, type ScreeningEvidence } from '@/lib/sanctions/evidence';
import { SANCTIONS_LIST_MAX_AGE_MS } from '@/lib/sanctions/list-policy';
import type { Db } from '@/db/client';
import { freshDb, seedPartner } from './helpers-db';
import { seedLiveEvidence } from './helpers-sanctions';

// Fix pack 2 T9 (R02): one reader for a transfer's sanctions.screen evidence,
// the "live and fresh" test, and the coverage rule a re-screen must pass.

const MIN = 60_000;
const HOUR = 3_600_000;

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'other');
});

function transfer(createdAgoMs = 5 * MIN) {
  return { id: 'tr_ev1', partnerId: 'acme', createdAt: new Date(Date.now() - createdAgoMs).toISOString(), recipientName: 'Anita Rao' };
}

async function rawAudit(row: { partnerId: string; action: string; subjectId: string; meta: unknown; at?: Date }) {
  await db.insert(auditEvents).values({
    partnerId: row.partnerId,
    actor: 'system:sanctions',
    actorType: 'system',
    action: row.action,
    subjectId: row.subjectId,
    meta: row.meta,
    ...(row.at ? { at: row.at } : {}),
  });
}

function ev(over: Partial<ScreeningEvidence> = {}): ScreeningEvidence {
  return {
    listSource: 'ofac-sdn', listVersion: 'v', listHash: 'h', screenedAt: new Date().toISOString(),
    decision: 'clear', parties: [], listFitness: 'live', ...over,
  };
}

describe('listScreenEvidence', { retry: 0 }, () => {
  it('oldest first, only sanctions.screen of this subject and tenant', async () => {
    const t = transfer();
    const now = new Date();
    await seedLiveEvidence(db, t, { at: new Date(now.getTime() - 2 * MIN), listFitness: 'not_live' });
    await seedLiveEvidence(db, t, { at: new Date(now.getTime() - 1 * MIN) });
    // Noise: another action on the subject, another subject, another tenant, outside the window.
    await rawAudit({ partnerId: 'acme', action: 'transfer.release', subjectId: t.id, meta: ev() });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: 'tr_other', meta: ev() });
    await rawAudit({ partnerId: 'other', action: 'sanctions.screen', subjectId: t.id, meta: ev() });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: ev(), at: new Date(now.getTime() - 20 * MIN) });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: ev(), at: new Date(now.getTime() + 5 * MIN) });

    const rows = await listScreenEvidence(db, t, now);
    expect(rows.map((r) => r.listFitness)).toEqual(['not_live', 'live']);
    expect(rows[1].parties).toEqual([{ role: 'recipient', inputHash: inputHash('Anita Rao'), matched: false, matchScore: 0 }]);
  });

  it('F1 A4: 210 other audit rows on the subject never hide a later screen (no cap shared with other actions)', async () => {
    const t = transfer(30 * MIN);
    const now = new Date();
    const base = now.getTime() - 25 * MIN;
    await seedLiveEvidence(db, t, { at: new Date(base) });
    await db.insert(auditEvents).values(Array.from({ length: 210 }, (_, i) => ({
      partnerId: 'acme', actor: 'staff:x', actorType: 'staff', action: 'pii.reveal', subjectId: t.id, meta: {},
      at: new Date(base + (i + 1) * 1_000),
    })));
    await seedLiveEvidence(db, t, { at: new Date(now.getTime() - MIN), listFitness: 'not_live' });
    const rows = await listScreenEvidence(db, t, now);
    expect(rows.map((r) => r.listFitness)).toEqual(['live', 'not_live']);
    expect(rows.at(-1)?.listFitness).toBe('not_live');
  });

  it('malformed meta skipped', async () => {
    const t = transfer();
    const now = new Date();
    const at = (m: number) => new Date(now.getTime() - m * MIN);
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: null, at: at(4) });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: { ...ev(), screenedAt: 5 }, at: at(3.5) });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: { ...ev(), parties: 'x' }, at: at(3) });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: { ...ev(), parties: [{ role: 'boss', inputHash: 'x', matched: false, matchScore: 0 }] }, at: at(2.5) });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: { ...ev(), parties: [{ role: 'sender', inputHash: 7, matched: false, matchScore: 0 }] }, at: at(2) });
    await rawAudit({ partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id, meta: { ...ev(), listFitness: 'fresh' }, at: at(1.5) });
    await seedLiveEvidence(db, t, { at: at(1) });
    const rows = await listScreenEvidence(db, t, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].listFitness).toBe('live');
  });

  it('pre-pack-2 evidence (no listFitness) and a null inputHash are kept as read', async () => {
    const t = transfer();
    await rawAudit({
      partnerId: 'acme', action: 'sanctions.screen', subjectId: t.id,
      meta: { listSource: 'mock-watchlist', listVersion: 'static', listHash: 'h', screenedAt: new Date().toISOString(), decision: 'clear',
        parties: [{ role: 'recipient', inputHash: null, matched: false, matchScore: 0 }] },
    });
    const rows = await listScreenEvidence(db, t, new Date());
    expect(rows).toHaveLength(1);
    expect(rows[0].listFitness).toBeUndefined();
    expect(rows[0].parties[0].inputHash).toBeNull();
  });
});

describe('liveFresh', { retry: 0 }, () => {
  it('live 35 h true; 37 h false; stale/not_live/absent listFitness false; 10 min in the future false', () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(liveFresh(ev({ screenedAt: ago(35 * HOUR) }), now)).toBe(true);
    expect(liveFresh(ev({ screenedAt: ago(SANCTIONS_LIST_MAX_AGE_MS) }), now)).toBe(true);
    expect(liveFresh(ev({ screenedAt: ago(37 * HOUR) }), now)).toBe(false);
    expect(liveFresh(ev({ listFitness: 'stale' }), now)).toBe(false);
    expect(liveFresh(ev({ listFitness: 'not_live' }), now)).toBe(false);
    expect(liveFresh(ev({ listFitness: undefined }), now)).toBe(false);
    expect(liveFresh(undefined, now)).toBe(false);
    expect(liveFresh(ev({ screenedAt: ago(-10 * MIN) }), now)).toBe(false);
    expect(liveFresh(ev({ screenedAt: ago(-2 * MIN) }), now)).toBe(true); // within the clock skew
    expect(liveFresh(ev({ screenedAt: 'not a date' }), now)).toBe(false);
  });
});

describe('instructGateRefuses (review F1/A1)', { retry: 0 }, () => {
  it('refuses evidence with listFitness that is not liveFresh; passes no evidence and pre-pack evidence', () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(instructGateRefuses(undefined, now)).toBe(false);
    expect(instructGateRefuses(ev({ listFitness: undefined, screenedAt: at(100 * HOUR) }), now)).toBe(false);
    expect(instructGateRefuses(ev({ screenedAt: at(HOUR) }), now)).toBe(false);
    expect(instructGateRefuses(ev({ screenedAt: at(SANCTIONS_LIST_MAX_AGE_MS + MIN) }), now)).toBe(true);
    expect(instructGateRefuses(ev({ listFitness: 'not_live', screenedAt: at(MIN) }), now)).toBe(true);
    expect(instructGateRefuses(ev({ listFitness: 'stale', screenedAt: at(MIN) }), now)).toBe(true);
    expect(instructGateRefuses(ev({ decision: 'match', screenedAt: at(MIN) }), now)).toBe(true);
    expect(instructGateRefuses(ev({ decision: 'possible_match', screenedAt: at(MIN) }), now)).toBe(false);
    expect(instructGateRefuses(ev({ listFitness: undefined, decision: 'match', screenedAt: at(MIN) }), now)).toBe(false);
  });
});

describe('uncoveredRoles', { retry: 0 }, () => {
  const prior = (sender: string | null, recipient: string): ScreeningEvidence[] => [
    ev({
      parties: [
        { role: 'recipient', inputHash: inputHash(recipient), matched: false, matchScore: 0 },
        ...(sender === null ? [] : [{ role: 'sender' as const, inputHash: inputHash(sender), matched: false, matchScore: 0 }]),
      ],
    }),
  ];

  it('same names: none uncovered (normalisation-stable)', () => {
    expect(uncoveredRoles(prior('Ravi Kumar', 'Anita Rao'), { senderName: 'ravi  KUMAR', recipientNames: ['Anita Rao'] })).toEqual([]);
  });

  it("sender name empty -> ['sender']", () => {
    expect(uncoveredRoles(prior('Ravi Kumar', 'Anita Rao'), { senderName: '', recipientNames: ['Anita Rao'] })).toEqual(['sender']);
  });

  it("different sender -> ['sender']", () => {
    expect(uncoveredRoles(prior('Ravi Kumar', 'Anita Rao'), { senderName: 'Buyer Ltd', recipientNames: ['Anita Rao'] })).toEqual(['sender']);
  });

  it('recipient screened under a second name is covered via recipientNames', () => {
    const p = [...prior('Ravi Kumar', 'Anita Rao'), ...prior('Ravi Kumar', 'A Rao Holder')];
    expect(uncoveredRoles(p, { senderName: 'Ravi Kumar', recipientNames: ['Anita Rao'] })).toEqual(['recipient']);
    expect(uncoveredRoles(p, { senderName: 'Ravi Kumar', recipientNames: ['Anita Rao', 'A Rao Holder'] })).toEqual([]);
    expect(uncoveredRoles(p, { senderName: '', recipientNames: ['', 'Someone Else'] })).toEqual(['sender', 'recipient']);
  });

  it('null prior hash -> uncovered', () => {
    const p = [ev({ parties: [{ role: 'sender', inputHash: null, matched: false, matchScore: 0 }] })];
    expect(uncoveredRoles(p, { senderName: 'Ravi Kumar', recipientNames: ['Anita Rao'] })).toEqual(['sender']);
  });

  it('no prior evidence: nothing to cover', () => {
    expect(uncoveredRoles([], { senderName: '', recipientNames: [] })).toEqual([]);
  });
});
