import { type NextRequest } from 'next/server';
import { guardPartner, readJson, svcResponse } from '@/lib/partner-api';
import { createTransaction } from '@/lib/partner-api-service';

// POST /api/partner/v1/transactions — mint a transfer (idempotent). The
// Idempotency-Key header is REQUIRED; a replay returns the same transaction.
export async function POST(req: NextRequest) {
  const g = await guardPartner(req);
  if (!g.ok) return g.response;
  const idempotencyKey = (req.headers.get('idempotency-key') ?? '').trim();
  return svcResponse(
    await createTransaction(g.ctx.deps, g.ctx.partner, g.ctx.keyId, idempotencyKey, await readJson(req)),
  );
}
