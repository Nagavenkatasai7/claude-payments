import { describe, it, expect } from 'vitest';
import { MintRefusedError, type MintRefusalCode } from '@/lib/transfer-create';

// Fix pack 3 T1 (contract 4): the class pack 3's mint refusals throw (T4, T12).
// Declared here, thrown nowhere yet.

describe('MintRefusedError', () => {
  it('MintRefusedError: name, message mint_refused:<code>, default copyKey cannot_complete, capability carried', () => {
    const codes: MintRefusalCode[] = ['live_not_certified', 'capability_off', 'default_on_live_rail'];
    for (const code of codes) {
      const e = new MintRefusedError(code);
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(MintRefusedError);
      expect(e.name).toBe('MintRefusedError');
      expect(e.message).toBe(`mint_refused:${code}`);
      expect(e.code).toBe(code);
      expect(e.copyKey).toBe('cannot_complete');
      expect(e.capability).toBeUndefined();
    }
    const cap = new MintRefusedError('capability_off', 'cannot_complete', 'usdc');
    expect(cap.capability).toBe('usdc');
    expect(cap.message).toBe('mint_refused:capability_off');
    const other = new MintRefusedError('live_not_certified', 'cap_unavailable');
    expect(other.copyKey).toBe('cap_unavailable');
  });
});
