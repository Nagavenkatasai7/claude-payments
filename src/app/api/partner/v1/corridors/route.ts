import { NextResponse, type NextRequest } from 'next/server';
import { guardPartner } from '@/lib/partner-api';
import { listCorridors } from '@/lib/partner-api-service';

// GET /api/partner/v1/corridors — the partner's data-driven corridor discovery.
export async function GET(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  return NextResponse.json(listCorridors(g.ctx.partner));
}
