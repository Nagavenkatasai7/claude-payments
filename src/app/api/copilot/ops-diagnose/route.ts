import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkCopilotRateLimit } from '@/lib/ticket-ai';
import { diagnoseOps, errorPrefix, type OpsDiagnosisBundle } from '@/lib/ops-diagnosis-ai';
import { money } from '@/app/admin-dashboard/format';

export const dynamic = 'force-dynamic';

// /api/copilot/ops-diagnose — a one-shot AI diagnosis for a stuck transfer or a
// dead outbox effect (U5). Synthesizes a rationale; the deterministic facts
// (sibling cluster size, provider type, masked transfer state) are computed
// here and handed to the model. The model NEVER executes anything — the actual
// remediation is the existing audited retryDeadAction / dismissDeadAction the
// staff member clicks.
//
// SELF-GATED: /api/copilot gets NO middleware edge gate, so this route enforces
// its contract inline (JSON statuses, not page redirects). This is PLATFORM ops
// — cross-tenant by nature — so a partner-scoped staff member is refused even
// if they hold the support|admin role. Shares the 60/h per-staff copilot budget.

function minutesSince(iso: string | Date | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.now() - (iso instanceof Date ? iso.getTime() : Date.parse(iso));
  return Math.max(0, Math.round(ms / 60_000));
}

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  if (staff.role !== 'support' && staff.role !== 'admin') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  // Platform ops only — a partner-scoped staff member never sees the cross-tenant
  // ops surface, regardless of role.
  const scope = scopeOf(staff);
  if (scope.kind !== 'platform') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // 60 calls/hour per staff member; FAIL-OPEN on limiter errors (a Redis outage
  // must never take the copilot down — same posture as ip-rate-limit).
  try {
    if (!(await checkCopilotRateLimit(getRedis(), staff.username))) {
      return NextResponse.json(
        { ok: false, error: 'Copilot rate limit reached — try again later.' },
        { status: 429 },
      );
    }
  } catch {
    /* fail-open */
  }

  let subjectId = '';
  try {
    const body = (await req.json()) as { subjectId?: unknown };
    if (typeof body.subjectId === 'string') subjectId = body.subjectId.trim();
    else if (typeof body.subjectId === 'number') subjectId = String(body.subjectId);
  } catch {
    /* malformed body falls through to the 404 below */
  }
  if (!subjectId) return NextResponse.json({ ok: false }, { status: 404 });

  const db = getDb();
  const outboxRepo = createOutboxRepo(db);
  const integrationsRepo = createIntegrationsRepo(db);

  // Resolve the subject: a positive-integer id that names a DEAD outbox row is a
  // dead-letter diagnosis; anything else is treated as a transfer id.
  let bundle: OpsDiagnosisBundle | null = null;
  const asNum = Number(subjectId);
  const dead =
    Number.isInteger(asNum) && asNum > 0 ? await outboxRepo.getDead(asNum) : null;

  if (dead) {
    // The outbox has NO transferId column — it lives in payload jsonb. Resolve
    // the effect's owning partner (and thus the rail provider type) via that.
    const payload = (dead.payload ?? {}) as { transferId?: unknown; partnerId?: unknown };
    const transferId =
      typeof payload.transferId === 'string' ? payload.transferId : undefined;
    let partnerId =
      typeof payload.partnerId === 'string' ? payload.partnerId : undefined;
    if (!partnerId && transferId) {
      // Masked default read — never decrypted; we only need the partner + state.
      const t = await createTransferRepo(db).getTransfer(transferId);
      partnerId = t?.settlementPartnerId ?? t?.partnerId;
    }
    const providerType = partnerId
      ? (await integrationsRepo.getIntegrations(partnerId)).payment.providerType ?? 'mock'
      : 'unknown';
    // DETERMINISTIC sibling clustering — SQL count over the normalized error prefix.
    const prefix = errorPrefix(dead.lastError);
    const siblingDeadCount = await outboxRepo.countDeadByErrorPrefix(prefix, dead.id);
    bundle = {
      subjectKind: 'dead_letter',
      deadLetter: {
        id: dead.id,
        kind: dead.kind,
        attempts: dead.attempts,
        lastError: dead.lastError ?? '(none)',
        providerType,
        ageMinutes: minutesSince(dead.createdAt),
        siblingDeadCount,
      },
    };
  } else {
    // Stuck transfer — MASKED default ledger read (no full payout destination).
    const t = await createTransferRepo(db).getTransfer(subjectId);
    if (!t) return NextResponse.json({ ok: false }, { status: 404 });
    const railPartner = t.settlementPartnerId ?? t.partnerId;
    const providerType =
      (await integrationsRepo.getIntegrations(railPartner)).payment.providerType ?? 'mock';
    bundle = {
      subjectKind: 'stuck_transfer',
      transfer: {
        id: t.id,
        status: t.status,
        partnerId: t.partnerId,
        settlementPartnerId: t.settlementPartnerId,
        amount: money(t.amountSource, t.sourceCurrency),
        paidAgeMinutes: minutesSince(t.paidAt),
        providerType,
      },
    };
  }

  try {
    const diagnosis = await diagnoseOps(bundle);
    await createAuditRepo(db).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.ops_diagnose',
      subjectId,
    });
    return NextResponse.json({ ok: true, diagnosis });
  } catch {
    // Quiet degradation — the panel shows "AI unavailable"; manual ops continues.
    return NextResponse.json({ ok: false, error: 'AI unavailable' }, { status: 502 });
  }
}
