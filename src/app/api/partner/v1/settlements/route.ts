import { NextResponse, type NextRequest } from 'next/server';
import { guardPartner, svcResponse } from '@/lib/partner-api';
import { listSettlements } from '@/lib/partner-api-service';

// GET /api/partner/v1/settlements?from=&to=&limit=&cursor=&format=json|csv
// Program-Fix 31 PR A (rail-11): the partner's settlements statement. The
// partner is resolved from the API key ONLY (guardPartner); a partner_id in the
// query is never read — only the five documented params are passed on.
// Scopes: once fix 44 lands per-key scopes, this route declares
// `settlements:read` (legacy keys keep full scope).
// Route handlers are uncached by default and this one reads the request —
// node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md:51.
export async function GET(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const result = await listSettlements(g.ctx.deps, g.ctx.partner.id, {
    from: p.get('from'),
    to: p.get('to'),
    limit: p.get('limit'),
    cursor: p.get('cursor'),
    format: p.get('format'),
  });
  if (!result.ok) return svcResponse(result);
  if (result.data.format === 'csv') {
    const headers: Record<string, string> = {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${result.data.filename}"`,
      'cache-control': 'no-store',
    };
    if (result.data.nextCursor) headers['x-next-cursor'] = result.data.nextCursor;
    return new NextResponse(result.data.csv, { status: 200, headers });
  }
  return NextResponse.json(result.data.body, { status: 200, headers: { 'cache-control': 'no-store' } });
}
