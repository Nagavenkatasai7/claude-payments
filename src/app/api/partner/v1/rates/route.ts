import { type NextRequest } from 'next/server';
import { guardPartner, readJson, svcResponse } from '@/lib/partner-api';
import { pushPartnerRate, listPartnerRates } from '@/lib/partner-api-service';

// /api/partner/v1/rates — per-corridor wholesale conversion pricing.
//
// PUT pushes ONE corridor rate (the rate this partner offers to win routed
// default-tenant flow via best-rate selection). DELIBERATELY does NOT touch
// createQuote: a partner's own /quote stays at platform mid-market — repricing
// it with the partner's wholesale push would silently break existing
// integrations and mismatch what createTransaction mints.
export async function PUT(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  return svcResponse(await pushPartnerRate(g.ctx.deps, g.ctx.partner, g.ctx.keyId, await readJson(req)));
}

// GET /api/partner/v1/rates — the partner's own rate sheet (key-scoped).
export async function GET(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  return svcResponse(await listPartnerRates(g.ctx.deps, g.ctx.partner.id));
}
