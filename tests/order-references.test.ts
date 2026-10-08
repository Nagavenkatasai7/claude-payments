import { describe, it, expect } from 'vitest';
import {
  CLIENT_REFERENCE_MAX,
  CLIENT_REFERENCE_ERROR,
  isValidClientReference,
  parseClientReference,
  parsePayoutReference,
  simulatorPayoutReference,
} from '@/lib/order-references';

// Batch B1: the pure checks for the two transfer references.

describe('isValidClientReference', () => {
  it('accepts letters, digits and . _ : / # - up to 64 characters', () => {
    for (const ok of ['A', 'INV-2026/10#7', 'order_42.v2', 'a:b', '0', 'x'.repeat(CLIENT_REFERENCE_MAX)]) {
      expect(isValidClientReference(ok), ok).toBe(true);
    }
  });

  it('refuses empty, too long, spaces, other punctuation, control or non-ASCII characters, and non-strings', () => {
    for (const bad of [
      '', 'x'.repeat(CLIENT_REFERENCE_MAX + 1), 'INV 1', ' INV1', 'INV1\n', 'a,b', 'a;b', '=1+2', '"x"', '<b>',
      'INV​1', 'ÍNV1', 'a\u0000b', 42, null, undefined, {}, ['A'],
    ]) {
      expect(isValidClientReference(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('parseClientReference', () => {
  it('absent (undefined or null) is fine and gives no value', () => {
    expect(parseClientReference(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseClientReference(null)).toEqual({ ok: true, value: undefined });
  });

  it('a valid value passes through unchanged', () => {
    expect(parseClientReference('PO-7781')).toEqual({ ok: true, value: 'PO-7781' });
  });

  it('a present but bad value is an error with the documented message', () => {
    for (const bad of ['', 'has space', 'x'.repeat(65), 12, true]) {
      expect(parseClientReference(bad)).toEqual({ ok: false, error: CLIENT_REFERENCE_ERROR });
    }
    expect(CLIENT_REFERENCE_ERROR).toMatch(/client_reference/);
    expect(CLIENT_REFERENCE_ERROR).toMatch(/64/);
  });
});

describe('parsePayoutReference', () => {
  it('a valid UTR-like value passes; surrounding spaces are trimmed', () => {
    expect(parsePayoutReference('HDFCR52026100812345678')).toBe('HDFCR52026100812345678');
    expect(parsePayoutReference('  UTR-123  ')).toBe('UTR-123');
  });

  it('anything else is null (ignored by the callback, never an error)', () => {
    for (const bad of [undefined, null, '', '   ', 'a b', 'x'.repeat(65), 'UTR\n1', 7, {}, '<script>']) {
      expect(parsePayoutReference(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('simulatorPayoutReference', () => {
  it('is SIMPAY-<reference> and always a valid payout reference for a transfer id', () => {
    const id = 'Qm9vYmFyQmF6UXV4MTIzNA';
    expect(simulatorPayoutReference(id)).toBe(`SIMPAY-${id}`);
    expect(parsePayoutReference(simulatorPayoutReference(id))).toBe(`SIMPAY-${id}`);
  });
});
