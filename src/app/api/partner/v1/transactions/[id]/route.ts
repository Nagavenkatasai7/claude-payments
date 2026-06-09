import { type NextRequest } from 'next/server';
import { guardPartner, svcResponse } from '@/lib/partner-api';
import { getTransaction } from '@/lib/partner-api-service';

// GET /api/partner/v1/transactions/:id — partner-scoped read (404 if not owned).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  const { id } = await params;
  return svcResponse(await getTransaction(g.ctx.deps, g.ctx.partner.id, id));
}
