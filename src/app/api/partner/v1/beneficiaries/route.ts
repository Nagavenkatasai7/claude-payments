import { type NextRequest } from 'next/server';
import { guardPartner, readJson, svcResponse } from '@/lib/partner-api';
import { createBeneficiary } from '@/lib/partner-api-service';

// POST /api/partner/v1/beneficiaries — validate + store a partner-scoped beneficiary.
export async function POST(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  return svcResponse(await createBeneficiary(g.ctx.deps, g.ctx.partner.id, await readJson(req)));
}
