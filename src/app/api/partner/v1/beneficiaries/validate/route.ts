import { type NextRequest } from 'next/server';
import { guardPartner, readJson, svcResponse } from '@/lib/partner-api';
import { validateBeneficiary } from '@/lib/partner-api-service';

// POST /api/partner/v1/beneficiaries/validate — stateless payout-field validation
// (pre-check before creating a beneficiary or transaction).
export async function POST(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  return svcResponse(validateBeneficiary(await readJson(req)));
}
