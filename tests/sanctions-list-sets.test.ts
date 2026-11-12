import { describe, it, expect } from 'vitest';
import {
  SANCTIONS_SOURCES,
  SANCTIONS_FLOOR,
  floorLists,
  isSanctionsSourceId,
} from '@/lib/sanctions/list-sets';

// Fix pack 5 (R08, P24): the code floor of sanctions lists. Pure.

describe('SANCTIONS_SOURCES', () => {
  it("is exactly ['ofac-sdn','ofac-cons','un-sc','in-mha-uapa'] and frozen", () => {
    expect([...SANCTIONS_SOURCES]).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
    expect(Object.isFrozen(SANCTIONS_SOURCES)).toBe(true);
  });
});

describe('isSanctionsSourceId', () => {
  it('accepts the four ids and nothing else', () => {
    for (const s of SANCTIONS_SOURCES) expect(isSanctionsSourceId(s)).toBe(true);
    for (const s of ['mock-watchlist', 'lists:ofac-sdn+ofac-cons', '', 'OFAC-SDN', 'toString', '__proto__']) {
      expect(isSanctionsSourceId(s)).toBe(false);
    }
  });
});

describe('SANCTIONS_FLOOR', () => {
  it("every is ['ofac-sdn','ofac-cons']; byDestination.IN is ['un-sc','in-mha-uapa']", () => {
    expect([...SANCTIONS_FLOOR.every]).toEqual(['ofac-sdn', 'ofac-cons']);
    expect([...(SANCTIONS_FLOOR.byDestination.IN ?? [])]).toEqual(['un-sc', 'in-mha-uapa']);
  });

  it('the object, every array and byDestination are frozen (a push or assignment throws)', () => {
    expect(Object.isFrozen(SANCTIONS_FLOOR)).toBe(true);
    expect(Object.isFrozen(SANCTIONS_FLOOR.every)).toBe(true);
    expect(Object.isFrozen(SANCTIONS_FLOOR.byDestination)).toBe(true);
    expect(Object.isFrozen(SANCTIONS_FLOOR.byDestination.IN)).toBe(true);
    expect(() => (SANCTIONS_FLOOR.every as unknown as string[]).push('un-sc')).toThrow(TypeError);
    expect(() => (SANCTIONS_FLOOR.byDestination.IN as unknown as string[]).push('ofac-sdn')).toThrow(TypeError);
    expect(() => {
      (SANCTIONS_FLOOR.byDestination as Record<string, unknown>).DE = ['un-sc'];
    }).toThrow(TypeError);
    expect(() => {
      (SANCTIONS_FLOOR as unknown as Record<string, unknown>).every = [];
    }).toThrow(TypeError);
  });

  it('every id in SANCTIONS_FLOOR is a SanctionsSourceId', () => {
    const ids = [...SANCTIONS_FLOOR.every, ...Object.values(SANCTIONS_FLOOR.byDestination).flat()];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(SANCTIONS_SOURCES as readonly string[]).toContain(id);
  });
});

describe('floorLists', () => {
  it("IN = ['ofac-sdn','ofac-cons','un-sc','in-mha-uapa'] (every first, then the destination's, no duplicates)", () => {
    expect([...floorLists('IN')]).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
  });

  it("DE, GB and US = ['ofac-sdn','ofac-cons']", () => {
    expect([...floorLists('DE')]).toEqual(['ofac-sdn', 'ofac-cons']);
    expect([...floorLists('GB')]).toEqual(['ofac-sdn', 'ofac-cons']);
    expect([...floorLists('US')]).toEqual(['ofac-sdn', 'ofac-cons']);
  });

  it('null, undefined and no argument = all four (the strictest union)', () => {
    const all = ['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa'];
    expect([...floorLists(null)]).toEqual(all);
    expect([...floorLists(undefined)]).toEqual(all);
    expect([...floorLists()]).toEqual(all);
  });

  it('the result is frozen and a fresh caller cannot mutate the floor', () => {
    const first = floorLists('IN');
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => (first as unknown as string[]).push('x')).toThrow(TypeError);
    const none = floorLists();
    expect(Object.isFrozen(none)).toBe(true);
    expect(() => (none as unknown as string[]).pop()).toThrow(TypeError);
    expect([...floorLists('IN')]).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
    expect([...floorLists()]).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
    expect([...SANCTIONS_FLOOR.every]).toEqual(['ofac-sdn', 'ofac-cons']);
  });
});
