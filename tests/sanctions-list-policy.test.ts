import { describe, it, expect } from 'vitest';
import {
  listFitness,
  SANCTIONS_LIST_MAX_AGE_MS,
  LIST_CLOCK_SKEW_MS,
  FIT_LIST_SOURCES,
  LIST_MAX_AGE_MS,
  sourceFitness,
  listSetFitness,
} from '@/lib/sanctions/list-policy';
import { SANCTIONS_SOURCES } from '@/lib/sanctions/list-sets';
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

  it("pin: an 'ofac-cons' info is not_live on the single-list path (it never trusts another source)", () => {
    expect(listFitness(info({ source: 'ofac-cons' }), now)).toBe('not_live');
    expect(listFitness(info({ source: 'un-sc' }), now)).toBe('not_live');
    expect(listFitness(info({ source: 'in-mha-uapa' }), now)).toBe('not_live');
  });
});

// Fix pack 5 (R08, P24): per-source freshness and the set rule.

const DAY = 24 * HOUR;

describe('LIST_MAX_AGE_MS', () => {
  it('ofac-sdn, ofac-cons, un-sc = 36 h; in-mha-uapa = 8 days; keys equal SANCTIONS_SOURCES; frozen', () => {
    expect(LIST_MAX_AGE_MS['ofac-sdn']).toBe(SANCTIONS_LIST_MAX_AGE_MS);
    expect(LIST_MAX_AGE_MS['ofac-cons']).toBe(SANCTIONS_LIST_MAX_AGE_MS);
    expect(LIST_MAX_AGE_MS['un-sc']).toBe(SANCTIONS_LIST_MAX_AGE_MS);
    expect(LIST_MAX_AGE_MS['un-sc']).toBe(36 * HOUR);
    expect(LIST_MAX_AGE_MS['in-mha-uapa']).toBe(8 * DAY);
    expect(Object.keys(LIST_MAX_AGE_MS)).toEqual([...SANCTIONS_SOURCES]);
    expect(Object.isFrozen(LIST_MAX_AGE_MS)).toBe(true);
  });
});

describe('sourceFitness', () => {
  it("an unknown source (mock-watchlist, 'lists:ofac-sdn+ofac-cons', '') is not_live", () => {
    expect(sourceFitness(info({ source: 'mock-watchlist', version: 'static' }), now)).toBe('not_live');
    expect(sourceFitness(info({ source: 'lists:ofac-sdn+ofac-cons' }), now)).toBe('not_live');
    expect(sourceFitness(info({ source: '' }), now)).toBe('not_live');
    expect(sourceFitness(info({ source: 'toString' }), now)).toBe('not_live');
  });

  it("'unloaded' / 'unavailable' / an empty hash are not_live", () => {
    for (const source of SANCTIONS_SOURCES) {
      expect(sourceFitness(info({ source, version: 'unloaded' }), now)).toBe('not_live');
      expect(sourceFitness(info({ source, version: 'unavailable' }), now)).toBe('not_live');
      expect(sourceFitness(info({ source, hash: '' }), now)).toBe('not_live');
    }
  });

  it('missing, unparseable or more than LIST_CLOCK_SKEW_MS in the future is stale', () => {
    for (const source of SANCTIONS_SOURCES) {
      expect(sourceFitness(info({ source, checkedAt: undefined }), now)).toBe('stale');
      expect(sourceFitness(info({ source, checkedAt: '' }), now)).toBe('stale');
      expect(sourceFitness(info({ source, checkedAt: 'not a date' }), now)).toBe('stale');
      expect(sourceFitness(info({ source, checkedAt: ago(-(LIST_CLOCK_SKEW_MS + 1)) }), now)).toBe('stale');
      expect(sourceFitness(info({ source, checkedAt: ago(-4 * 60_000) }), now)).toBe('live');
    }
  });

  it('ofac-cons checked 36 h ago exactly is live; 36 h + 1 ms is stale', () => {
    expect(sourceFitness(info({ source: 'ofac-cons', checkedAt: ago(36 * HOUR) }), now)).toBe('live');
    expect(sourceFitness(info({ source: 'ofac-cons', checkedAt: ago(36 * HOUR + 1) }), now)).toBe('stale');
    expect(sourceFitness(info({ source: 'un-sc', checkedAt: ago(36 * HOUR + 1) }), now)).toBe('stale');
  });

  it('in-mha-uapa checked 7 days ago is live; 8 days exactly live; 8 days + 1 ms stale', () => {
    expect(sourceFitness(info({ source: 'in-mha-uapa', checkedAt: ago(7 * DAY) }), now)).toBe('live');
    expect(sourceFitness(info({ source: 'in-mha-uapa', checkedAt: ago(8 * DAY) }), now)).toBe('live');
    expect(sourceFitness(info({ source: 'in-mha-uapa', checkedAt: ago(8 * DAY + 1) }), now)).toBe('stale');
  });

  it('ofac-sdn gives the same answer as listFitness for every case', () => {
    const cases: Array<Partial<SanctionsListInfo>> = [
      {},
      { version: 'unloaded' },
      { version: 'unavailable' },
      { hash: '' },
      { checkedAt: undefined },
      { checkedAt: '' },
      { checkedAt: 'not a date' },
      { checkedAt: ago(-10 * 60_000) },
      { checkedAt: ago(-4 * 60_000) },
      { checkedAt: ago(35 * HOUR) },
      { checkedAt: ago(36 * HOUR) },
      { checkedAt: ago(36 * HOUR + 1) },
      { checkedAt: ago(7 * DAY) },
    ];
    for (const c of cases) {
      const i = info({ ...c, source: 'ofac-sdn' });
      expect(sourceFitness(i, now)).toBe(listFitness(i, now));
    }
  });
});

describe('listSetFitness', () => {
  const live = (source: string) => info({ source });
  const stale = (source: string) => info({ source, checkedAt: ago(36 * HOUR + 1) });
  const dead = (source: string) => info({ source, version: 'unavailable' });
  const req = ['ofac-sdn', 'ofac-cons'] as const;

  it('every required member live is live', () => {
    expect(listSetFitness([live('ofac-sdn'), live('ofac-cons')], req, now)).toBe('live');
  });

  it('one required member stale is stale', () => {
    expect(listSetFitness([live('ofac-sdn'), stale('ofac-cons')], req, now)).toBe('stale');
  });

  it('one required member not_live is not_live (worst wins: not_live > stale > live)', () => {
    expect(listSetFitness([dead('ofac-sdn'), live('ofac-cons')], req, now)).toBe('not_live');
    expect(listSetFitness([dead('ofac-sdn'), stale('ofac-cons')], req, now)).toBe('not_live');
    expect(listSetFitness([stale('ofac-sdn'), dead('ofac-cons')], req, now)).toBe('not_live');
  });

  it('a required source absent from members is not_live', () => {
    expect(listSetFitness([live('ofac-sdn')], req, now)).toBe('not_live');
    expect(listSetFitness([], req, now)).toBe('not_live');
  });

  it('a member that is not required but stale still counts (fail safe): stale', () => {
    expect(listSetFitness([live('ofac-sdn'), live('ofac-cons'), stale('un-sc')], req, now)).toBe('stale');
    expect(listSetFitness([live('ofac-sdn'), live('ofac-cons'), info({ source: 'mock-watchlist' })], req, now)).toBe(
      'not_live',
    );
  });

  it('empty members and empty required is not_live (a set with no list never clears)', () => {
    expect(listSetFitness([], [], now)).toBe('not_live');
  });

  it('members only, nothing required: the worst member counts', () => {
    expect(listSetFitness([live('ofac-sdn')], [], now)).toBe('live');
    expect(listSetFitness([live('ofac-sdn'), stale('un-sc')], [], now)).toBe('stale');
  });

  it('two members with the same source: the worse one counts', () => {
    expect(listSetFitness([live('ofac-sdn'), stale('ofac-sdn'), live('ofac-cons')], req, now)).toBe('stale');
    expect(listSetFitness([stale('ofac-sdn'), live('ofac-sdn'), live('ofac-cons')], req, now)).toBe('stale');
    expect(listSetFitness([live('ofac-sdn'), dead('ofac-sdn'), live('ofac-cons')], req, now)).toBe('not_live');
  });

  it('the per-source age applies inside the set (MHA 7 days old is live)', () => {
    const mha = info({ source: 'in-mha-uapa', checkedAt: ago(7 * DAY) });
    const all = ['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa'] as const;
    expect(listSetFitness([live('ofac-sdn'), live('ofac-cons'), live('un-sc'), mha], all, now)).toBe('live');
  });

  it('does not mutate its inputs', () => {
    const members = Object.freeze([Object.freeze(live('ofac-sdn')), Object.freeze(stale('ofac-cons'))]);
    const required = Object.freeze(['ofac-sdn', 'ofac-cons', 'un-sc'] as const);
    const before = JSON.stringify({ members, required });
    expect(listSetFitness(members, required, now)).toBe('not_live');
    expect(JSON.stringify({ members, required })).toBe(before);
  });
});
