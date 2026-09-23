import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Program-Fix 31 PR A: the GET /api/partner/v1/settlements adapter. The guard
// and the service are stubbed; this pins the adapter's own contract — guard
// first, partner from the key only, the JSON and CSV responses.

const guardPartner = vi.fn();
const listSettlements = vi.fn();
vi.mock('@/lib/partner-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/partner-api')>()),
  guardPartner: (...a: unknown[]) => guardPartner(...a),
}));
vi.mock('@/lib/partner-api-service', () => ({
  listSettlements: (...a: unknown[]) => listSettlements(...a),
}));

const { GET } = await import('@/app/api/partner/v1/settlements/route');

const ctx = { partner: { id: 'acme' }, keyId: 'k1', deps: { marker: 'deps' } };

beforeEach(() => {
  guardPartner.mockReset();
  listSettlements.mockReset();
});

describe('GET /api/partner/v1/settlements', () => {
  it('returns the guard response (401) and never calls the service', async () => {
    guardPartner.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'nope' }, { status: 401 }) });
    const res = await GET(new NextRequest('https://x.test/api/partner/v1/settlements'));
    expect(res.status).toBe(401);
    expect(listSettlements).not.toHaveBeenCalled();
  });

  it('passes the KEY partner and only the documented params (partner_id is dropped)', async () => {
    guardPartner.mockResolvedValue({ ok: true, ctx });
    listSettlements.mockResolvedValue({
      ok: true,
      status: 200,
      data: { format: 'json', body: { settlements: [], next_cursor: null, totals: { count: 0 }, window: {} } },
    });
    const res = await GET(
      new NextRequest('https://x.test/api/partner/v1/settlements?from=2026-09-01&to=2026-09-02&limit=5&cursor=abc&format=json&partner_id=globex'),
    );
    expect(res.status).toBe(200);
    expect(listSettlements).toHaveBeenCalledWith(ctx.deps, 'acme', {
      from: '2026-09-01',
      to: '2026-09-02',
      limit: '5',
      cursor: 'abc',
      format: 'json',
    });
    expect(await res.json()).toEqual({ settlements: [], next_cursor: null, totals: { count: 0 }, window: {} });
  });

  it('maps a service 400 to a JSON error', async () => {
    guardPartner.mockResolvedValue({ ok: true, ctx });
    listSettlements.mockResolvedValue({ ok: false, status: 400, error: 'Invalid `cursor`.' });
    const res = await GET(new NextRequest('https://x.test/api/partner/v1/settlements?cursor=zz'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid `cursor`.' });
  });

  it('CSV: text/csv attachment, no-store, next cursor in a header', async () => {
    guardPartner.mockResolvedValue({ ok: true, ctx });
    listSettlements.mockResolvedValue({
      ok: true,
      status: 200,
      data: { format: 'csv', csv: 'reference\r\n', filename: 'settlements_a_b.csv', nextCursor: 'NEXT' },
    });
    const res = await GET(new NextRequest('https://x.test/api/partner/v1/settlements?format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="settlements_a_b.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-next-cursor')).toBe('NEXT');
    expect(await res.text()).toBe('reference\r\n');
  });

  it('CSV last page: no x-next-cursor header', async () => {
    guardPartner.mockResolvedValue({ ok: true, ctx });
    listSettlements.mockResolvedValue({
      ok: true,
      status: 200,
      data: { format: 'csv', csv: 'reference\r\n', filename: 'f.csv', nextCursor: null },
    });
    const res = await GET(new NextRequest('https://x.test/api/partner/v1/settlements?format=csv'));
    expect(res.headers.has('x-next-cursor')).toBe(false);
  });
});
