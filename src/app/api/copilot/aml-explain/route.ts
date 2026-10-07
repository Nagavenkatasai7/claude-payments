import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { inviteMfaPending } from '@/lib/partner-mfa-gate';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkCopilotRateLimit } from '@/lib/ticket-ai';
import { amlExplainFallback, buildAmlExplainBundle, explainAml, type AmlExplanation } from '@/lib/aml-explain-ai';
import { loadAmlExplainContext } from '@/lib/aml-explain-load';
import { logWarn } from '@/lib/log';

export const dynamic = 'force-dynamic';
// The model call may take up to AML_EXPLAIN_TIMEOUT_MS (45 s); give the click room
// (route segment config: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md).
export const maxDuration = 60;

// /api/copilot/aml-explain — the AML "Explain" copilot (A4) for ONE transfer
// that raised a behavioural AML alert or sits in review, on the compliance page.
//
// SELF-GATED like the other /api/copilot routes (the middleware matcher does
// not cover /api): a staff session; roles admin | agent only (support works
// tickets, finance is a /partner-only role); invite MFA enrolment pending ⇒
// 403; partner-scoped staff are refused (they use the /partner action, which
// gets the D5 partner facts). The shared 60/h copilot budget fails OPEN on a
// limiter error; a caller over budget gets the deterministic fallback instead
// of a model call.
//
// READ-ONLY: the MASKED default transfer read, the alert rows and the corridor
// thresholds. It never changes the transfer or the alert and writes no outbox
// row; it writes ONE `copilot.aml_explain` audit row (both paths) before
// answering. The model sees only the facts bundle (aml-explain-ai.ts).

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  if (staff.role !== 'admin' && staff.role !== 'agent') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  if (await inviteMfaPending(staff)) return NextResponse.json({ ok: false }, { status: 403 });
  if (staff.partnerId !== undefined) return NextResponse.json({ ok: false }, { status: 403 });

  let withinBudget = true;
  try {
    withinBudget = await checkCopilotRateLimit(getRedis(), staff.username);
  } catch {
    /* fail-open: a Redis outage must never take the copilot down */
  }

  let subjectId = '';
  try {
    const body = (await req.json()) as { subjectId?: unknown };
    if (typeof body.subjectId === 'string') subjectId = body.subjectId;
  } catch {
    /* malformed body falls through to the 404 below */
  }
  if (!subjectId) return NextResponse.json({ ok: false }, { status: 404 });

  const db = getDb();
  const transfer = await createTransferRepo(db).getTransfer(subjectId); // MASKED default read
  if (!transfer) return NextResponse.json({ ok: false }, { status: 404 });
  const now = new Date();
  const ctx = await loadAmlExplainContext(db, transfer, transfer.partnerId, now);
  if (!ctx.eligible) return NextResponse.json({ ok: false }, { status: 404 });

  const facts = buildAmlExplainBundle(transfer, ctx.alerts, ctx.cfg, 'platform', now.getTime(), ctx.recomputed);
  let source: 'ai' | 'fallback' = 'fallback';
  let explanation: AmlExplanation = amlExplainFallback(facts);
  if (withinBudget) {
    try {
      explanation = await explainAml(facts);
      source = 'ai';
    } catch (err) {
      logWarn('copilot.aml_explain', err instanceof Error ? err.name : 'error', { transferId: transfer.id });
    }
  }

  try {
    await createAuditRepo(db).record({
      partnerId: transfer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.aml_explain',
      subjectId,
      meta: { source, rules: facts.rules.map((r) => r.rule), audience: 'platform' },
    });
  } catch (err) {
    // Audited or not shown.
    logWarn('copilot.aml_explain.audit', err instanceof Error ? err.name : 'error', { transferId: transfer.id });
    return NextResponse.json({ ok: false, error: 'Explanation unavailable' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, source, facts, explanation });
}
