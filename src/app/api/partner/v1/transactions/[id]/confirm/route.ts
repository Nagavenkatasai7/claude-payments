import { type NextRequest } from 'next/server';
import { guardPartner, svcResponse } from '@/lib/partner-api';
import { confirmTransaction } from '@/lib/partner-api-service';

// POST /api/partner/v1/transactions/:id/confirm — drive settlement (mock rail in
// Phase A/B; partner-scoped, 404 if not owned).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  const { id } = await params;
  return svcResponse(await confirmTransaction(g.ctx.deps, g.ctx.partner, g.ctx.keyId, id));
}
