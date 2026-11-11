import { describe, it, expect } from 'vitest';
import {
  listFitness,
  SANCTIONS_LIST_MAX_AGE_MS,
  LIST_CLOCK_SKEW_MS,
  FIT_LIST_SOURCES,
} from '@/lib/sanctions/list-policy';
import type { SanctionsListInfo } from '@/lib/providers/sanctions-provider';

// Fix pack 2 (R02): which list a real-money screen may rely on. Pure; every
// date is relative to now (never a calendar date).

const HOUR = 3_600_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

function info(over: Partial<SanctionsListInfo> = {}): SanctionsListInfo {
  return { source: 'ofac-sdn', version: '2026-01-01', hash: 'a'.repeat(64), checkedAt: ago(HOUR), ...over };
}

describe('list-policy constants', () => {
  it('36 h max age, 5 min skew, only the OFAC SDN list is fit', () => {
    expect(SANCTIONS_LIST_MAX_AGE_MS).toBe(36 * HOUR);
    expect(LIST_CLOCK_SKEW_MS).toBe(5 * 60_000);
    expect([...FIT_LIST_SOURCES]).toEqual(['ofac-sdn']);
    expect(Object.isFrozen(FIT_LIST_SOURCES)).toBe(true);
  });
});

describe('listFitness', () => {
  it("mock-watchlist, 'unavailable', 'unloaded' and hash '' are not_live", () => {
    expect(listFitness(info({ source: 'mock-watchlist', version: 'static' }), now)).toBe('not_live');
    expect(listFitness(info({ version: 'unavailable' }), now)).toBe('not_live');
    expect(listFitness(info({ version: 'unloaded' }), now)).toBe('not_live');
    expect(listFitness(info({ hash: '' }), now)).toBe('not_live');
  });

  it('unknown source is not_live', () => {
    expect(listFitness(info({ source: 'some-other-list' }), now)).toBe('not_live');
    expect(listFitness(info({ source: '' }), now)).toBe('not_live');
  });

  it('not_live wins over a missing checkedAt', () => {
    expect(listFitness(info({ source: 'mock-watchlist', checkedAt: undefined }), now)).toBe('not_live');
  });

  it('35 h live; exactly 36 h live; 36 h + 1 ms stale', () => {
    expect(listFitness(info({ checkedAt: ago(35 * HOUR) }), now)).toBe('live');
    expect(listFitness(info({ checkedAt: ago(36 * HOUR) }), now)).toBe('live');
    expect(listFitness(info({ checkedAt: ago(36 * HOUR + 1) }), now)).toBe('stale');
  });

  it('no checkedAt stale; an unparseable checkedAt stale', () => {
    expect(listFitness(info({ checkedAt: undefined }), now)).toBe('stale');
    expect(listFitness(info({ checkedAt: 'not a date' }), now)).toBe('stale');
    expect(listFitness(info({ checkedAt: '' }), now)).toBe('stale');
  });

  it('checkedAt 10 min in the future stale; 4 min in the future live', () => {
    expect(listFitness(info({ checkedAt: ago(-10 * 60_000) }), now)).toBe('stale');
    expect(listFitness(info({ checkedAt: ago(-4 * 60_000) }), now)).toBe('live');
  });

  it('a fresh OFAC list is live', () => {
    expect(listFitness(info(), now)).toBe('live');
  });
});
