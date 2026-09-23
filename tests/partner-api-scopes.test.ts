import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  displayKeyPrefix,
  effectiveScopes,
  hasScope,
  keyModeFromId,
  keyModeFromPlaintext,
  scopesForMode,
} from '@/lib/partner-api-scopes';

// Program-Fix 44 P1 — the ONE rule for a key's mode and its fixed scope set.

describe('keyModeFromPlaintext', () => {
  it('sr_live_ → live, sr_test_ → test, anything else → null (exact prefix match)', () => {
    expect(keyModeFromPlaintext('sr_live_abc')).toBe('live');
    expect(keyModeFromPlaintext('sr_test_abc')).toBe('test');
    expect(keyModeFromPlaintext('SR_LIVE_abc')).toBeNull();
    expect(keyModeFromPlaintext('sk_live_abc')).toBeNull();
    expect(keyModeFromPlaintext('xsr_live_abc')).toBeNull();
    expect(keyModeFromPlaintext('')).toBeNull();
    expect(keyModeFromPlaintext(undefined as unknown as string)).toBeNull();
  });
});

describe('keyModeFromId — the one display rule', () => {
  it('pk_test_… → test; pk_live_… and every legacy pk_<id> → live', () => {
    expect(keyModeFromId('pk_test_abc')).toBe('test');
    expect(keyModeFromId('pk_live_abc')).toBe('live');
    expect(keyModeFromId('pk_Xy12abcDEF')).toBe('live'); // legacy, grandfathered
    expect(keyModeFromId('')).toBe('live');
  });

  it('displayKeyPrefix shows the real plaintext prefix for the mode', () => {
    expect(displayKeyPrefix('live')).toBe('sr_live_');
    expect(displayKeyPrefix('test')).toBe('sr_test_');
  });
});

describe('scopesForMode', () => {
  it('live keys (and so every legacy key) hold ALL scopes', () => {
    expect([...scopesForMode('live')].sort()).toEqual([...ALL_SCOPES].sort());
    expect(ALL_SCOPES).toContain('settlements:read');
  });

  it('test keys (P2 sandbox) add transactions:read / transactions:write — never rates, beneficiaries:write or settlements', () => {
    expect([...scopesForMode('test')].sort()).toEqual([
      'beneficiaries:validate', 'corridors:read', 'quote', 'transactions:read', 'transactions:write',
    ]);
    for (const s of ['rates:read', 'rates:write', 'beneficiaries:write', 'settlements:read'] as const) {
      expect(hasScope(scopesForMode('test'), s)).toBe(false);
    }
  });

  it('returns a copy — mutating the result never widens a later key', () => {
    const s = scopesForMode('test') as string[];
    s.push('rates:write');
    expect(scopesForMode('test')).not.toContain('rates:write');
  });
});

describe('effectiveScopes — the api_keys.scopes column (Program-Fix 44 P2)', () => {
  it('NULL / undefined ⇒ the mode default (every existing key keeps full live scope)', () => {
    expect(effectiveScopes('live', null)).toEqual(scopesForMode('live'));
    expect(effectiveScopes('live', undefined)).toEqual(scopesForMode('live'));
    expect(effectiveScopes('test', null)).toEqual(scopesForMode('test'));
  });

  it('a stored set NARROWS the mode set', () => {
    expect(effectiveScopes('live', ['quote', 'corridors:read'])).toEqual(['corridors:read', 'quote']);
  });

  it('a stored set can NEVER widen a mode (a test key never gains rates:write)', () => {
    expect(effectiveScopes('test', ['rates:write', 'settlements:read', 'quote'])).toEqual(['quote']);
  });

  it('fails CLOSED on garbage: unknown strings dropped; a non-array stored value ⇒ no scopes', () => {
    expect(effectiveScopes('live', ['quote', 'admin:*', 42])).toEqual(['quote']);
    expect(effectiveScopes('live', { quote: true })).toEqual([]);
    expect(effectiveScopes('live', 'quote')).toEqual([]);
  });
});
