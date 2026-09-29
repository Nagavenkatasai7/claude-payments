import { describe, it, expect } from 'vitest';
import { MAX_KEYS_PER_MODE, activeCount, keyRowsView, parseKeyId, parseKeyMode } from '@/lib/partner-api-keys-view';
import { scopesForMode } from '@/lib/partner-api-scopes';

// UI redesign M3-14: the pure rules shared by the API-key actions and page.

describe('parseKeyMode', () => {
  it('accepts exactly test / live', () => {
    expect(parseKeyMode('test')).toBe('test');
    expect(parseKeyMode('live')).toBe('live');
    for (const v of ['', 'LIVE', 'Test', ' live', 'live ', 'sandbox', null, undefined, 1, ['live']]) expect(parseKeyMode(v)).toBeNull();
  });
});

describe('parseKeyId', () => {
  it('accepts pk_test_ / pk_live_ ids and the grandfathered bare pk_<id>', () => {
    for (const v of ['pk_test_AbC-_9', 'pk_live_x', 'pk_legacyAbc123']) expect(parseKeyId(v)).toBe(v);
  });
  it('refuses anything else, bounded', () => {
    for (const v of ['', 'pk_', 'pk_test_', 'sk_test_abc', 'pk_test_a b', "pk_test_'x", 'pk_test_' + 'a'.repeat(65), 'x'.repeat(200), null, 7]) {
      expect(parseKeyId(v)).toBeNull();
    }
  });
});

describe('keyRowsView / activeCount', () => {
  const keys = [
    { keyId: 'pk_test_a', createdAt: '2026-09-01T00:00:00.000Z', last4: 'aaaa' },
    { keyId: 'pk_test_b', createdAt: '2026-09-02T00:00:00.000Z', last4: 'bbbb', revokedAt: '2026-09-03T00:00:00.000Z' },
    { keyId: 'pk_legacy1', createdAt: '2026-09-04T00:00:00.000Z', last4: 'cccc', lastUsedAt: '2026-09-05T00:00:00.000Z' },
  ];
  it('derives mode and the mode’s fixed scopes; legacy ids read as live', () => {
    const v = keyRowsView(keys);
    expect(v.map((r) => [r.mode, r.active])).toEqual([
      ['test', true],
      ['test', false],
      ['live', true],
    ]);
    expect(v[0].scopes).toEqual(scopesForMode('test'));
    expect(v[2].scopes).toEqual(scopesForMode('live'));
    expect(v[2].lastUsedAt).toBe('2026-09-05T00:00:00.000Z');
    expect(v[1].revokedAt).toBe('2026-09-03T00:00:00.000Z');
  });
  it('counts only unrevoked keys of the mode', () => {
    expect(activeCount(keys, 'test')).toBe(1);
    expect(activeCount(keys, 'live')).toBe(1);
    expect(MAX_KEYS_PER_MODE).toBe(5);
  });
});
