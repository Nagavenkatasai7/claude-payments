import { describe, it, expect, vi, beforeEach } from 'vitest';

// D14 (TGFL custom host): tgfl.org can plant an `sr_ref` cookie with Domain=tgfl.org, so on a custom
// skin host recordPortalReferral returns before it reads the cookie. Every smartremit.ai host keeps
// today's behaviour: the cookie is spent and recorded under the host partner.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  reads: [] as string[],
  deletes: [] as string[],
  recorded: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => {
      h.reads.push(n);
      return h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined;
    },
    delete: (n: string) => {
      h.deletes.push(n);
      h.jar.delete(n);
    },
  }),
}));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/referral-attribution', () => ({
  recordReferral: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    h.recorded.push(input);
  }),
}));

import { recordPortalReferral } from '@/lib/referral-portal';
import { REFERRAL_COOKIE } from '@/lib/referral-code';

const PHONE = '14155550101';

beforeEach(() => {
  h.jar = new Map([[REFERRAL_COOKIE, 'REF-ABC123']]);
  h.reads = [];
  h.deletes = [];
  h.recorded = [];
});

describe('recordPortalReferral host seam (D14)', () => {
  it('on the custom host: no recordReferral call and the cookie is not read', async () => {
    await recordPortalReferral('default', PHONE, 'smartremitai.tgfl.org');
    expect(h.recorded).toEqual([]);
    expect(h.reads).toEqual([]);
    expect(h.deletes).toEqual([]);
  });

  it.each(['send.smartremit.ai', 'tgfl.smartremit.ai'])('on %s: recorded under the host partner as today', async (host) => {
    await recordPortalReferral('default', PHONE, host);
    expect(h.recorded).toEqual([{ partnerId: 'default', phone: PHONE, code: 'REF-ABC123', channel: 'portal' }]);
    expect(h.deletes).toEqual([REFERRAL_COOKIE]);
  });

  it('no cookie on a smartremit.ai host: nothing recorded', async () => {
    h.jar = new Map();
    await recordPortalReferral('default', PHONE, 'send.smartremit.ai');
    expect(h.recorded).toEqual([]);
  });
});
