import { NextResponse } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { scopeOf } from '@/lib/staff-scope';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

// /api/dashboard/summary — the LIGHT polling target (Stage 4). LiveRefresh
// previously router.refresh()ed every 5s, re-running a full-ledger server
// render per viewer per tick. Now each tick is this one aggregate query, and
// the full re-render happens ONLY when the stamp actually changes.
//
// Auth: the staff session cookie (same gate as the pages); partner-scoped
// staff get a partner-scoped stamp so they never observe other tenants' churn.

export async function GET() {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });

  const scope = scopeOf(staff);
  const summary = await getStore().transfersSummary(
    scope.kind === 'partner' ? scope.partnerId : undefined,
  );
  // Any visible change moves at least one of these numbers/timestamps.
  const stamp = JSON.stringify({
    t: summary.total,
    s: summary.byStatus,
    n: summary.needsAttention,
    l: summary.latest,
  });
  return NextResponse.json({ ok: true, stamp, summary });
}
