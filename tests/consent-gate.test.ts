import { describe, it, expect, vi } from 'vitest';
import { suppressForOptOut, messageCategory } from '@/lib/consent-gate';

// Program-Fix 49A (whatsapp-10d): the ONE opt-out gate for business-initiated
// sends. B5 option (a): `essential` (OTPs, settlement stages, rail-failure /
// refund notices, payment received) still sends after STOP; `nonessential` is
// suppressed. A missing category counts as essential (rolling-overlap safety).

function storeWith(customer: { optedOutAt?: string } | null) {
  return { getCustomer: vi.fn(async (_p: string, _ph: string) => customer) };
}

describe('messageCategory', () => {
  it('only the exact string "nonessential" is nonessential; anything else (missing, junk) is essential', () => {
    expect(messageCategory('nonessential')).toBe('nonessential');
    expect(messageCategory('essential')).toBe('essential');
    expect(messageCategory(undefined)).toBe('essential');
    expect(messageCategory(null)).toBe('essential');
    expect(messageCategory('NONESSENTIAL')).toBe('essential');
    expect(messageCategory(1)).toBe('essential');
  });
});

describe('suppressForOptOut', () => {
  it('opted out + nonessential → suppressed', async () => {
    const store = storeWith({ optedOutAt: '2026-09-01T00:00:00Z' });
    expect(await suppressForOptOut(store, 'acme', '15551230000', 'nonessential')).toBe(true);
    expect(store.getCustomer).toHaveBeenCalledWith('acme', '15551230000');
  });

  it('opted out + essential → sent, and no customer read at all', async () => {
    const store = storeWith({ optedOutAt: '2026-09-01T00:00:00Z' });
    expect(await suppressForOptOut(store, 'acme', '15551230000', 'essential')).toBe(false);
    expect(store.getCustomer).not.toHaveBeenCalled();
  });

  it('a missing category is essential (an old-build row still delivers)', async () => {
    const store = storeWith({ optedOutAt: '2026-09-01T00:00:00Z' });
    expect(await suppressForOptOut(store, 'acme', '15551230000', undefined)).toBe(false);
  });

  it('opted in, or no customer row → sent', async () => {
    expect(await suppressForOptOut(storeWith({}), 'acme', '1555', 'nonessential')).toBe(false);
    expect(await suppressForOptOut(storeWith(null), 'acme', '1555', 'nonessential')).toBe(false);
  });
});
