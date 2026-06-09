import { type NextRequest } from 'next/server';
import { guardPartner, readJson, svcResponse } from '@/lib/partner-api';
import { createQuote } from '@/lib/partner-api-service';

// POST /api/partner/v1/quote — FX + fee quote (no persistence).
export async function POST(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  return svcResponse(await createQuote(g.ctx.deps, g.ctx.partner, await readJson(req)));
}
