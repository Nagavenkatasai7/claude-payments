'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { retryDeadAction, dismissDeadAction } from './actions';

// The ops-diagnosis copilot affordance. The AI still DIAGNOSES (rung-1) — it
// never touches a row itself — but its recommendation is now WIRED to the
// existing audited Retry/Dismiss levers: after a diagnosis the recommended
// action is highlighted for a one-click apply. And for a PERMANENT send error
// (e.g. 131030 — recipient not on Meta's allow-list) Retry is DISABLED and the
// panel steers to Dismiss + the out-of-band Meta step, since no in-app retry can
// ever clear it. AI failure still degrades to a quiet "AI unavailable"; the
// Retry/Dismiss buttons work regardless.

interface Diagnosis {
  failure_class: string;
  suggested_action: string;
  blast_radius: string;
  rationale: string;
}

const RADIUS_VARIANT: Record<string, 'secondary' | 'destructive' | 'outline'> = {
  isolated: 'secondary',
  cluster: 'outline',
  systemic: 'destructive',
};

export function DiagnosePanel({
  subjectId,
  kind = 'stuck_transfer',
}: {
  subjectId: string;
  kind?: 'dead_letter' | 'stuck_transfer';
}) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function requestDiagnosis() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/copilot/ops-diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        diagnosis?: Diagnosis;
        permanent?: boolean;
      };
      if (!res.ok || !data.ok || !data.diagnosis) throw new Error('unavailable');
      setDiagnosis(data.diagnosis);
      setPermanent(Boolean(data.permanent));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // Which lever is the recommended one-click apply (permanent ⇒ always Dismiss).
  const recommendDismiss =
    diagnosis !== null && (permanent || diagnosis.suggested_action === 'dismiss');
  const recommendRetry =
    diagnosis !== null && !permanent && diagnosis.suggested_action === 'retry';

  return (
    <div className={kind === 'dead_letter' ? 'flex flex-col items-end gap-2' : 'space-y-2'}>
      {kind === 'dead_letter' && (
        <div className="flex justify-end gap-2">
          <form action={retryDeadAction}>
            <input type="hidden" name="id" value={subjectId} />
            <Button
              type="submit"
              size="sm"
              variant={recommendRetry ? 'default' : 'outline'}
              disabled={permanent}
              title={
                permanent ? 'Retry can’t succeed — fix the recipient in Meta first' : undefined
              }
            >
              Retry
            </Button>
          </form>
          <form action={dismissDeadAction}>
            <input type="hidden" name="id" value={subjectId} />
            <Button type="submit" size="sm" variant={recommendDismiss ? 'default' : 'outline'}>
              Dismiss
            </Button>
          </form>
        </div>
      )}

      <Button type="button" size="sm" variant="outline" onClick={requestDiagnosis} disabled={loading}>
        {loading ? 'Diagnosing…' : '✦ Diagnose'}
      </Button>
      {error && <span className="text-xs text-muted-foreground">AI unavailable</span>}

      {diagnosis && (
        <div className="w-full max-w-[420px] rounded-md border border-border bg-background px-3 py-2 text-left text-xs">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{diagnosis.failure_class}</Badge>
            <Badge variant="secondary">{diagnosis.suggested_action}</Badge>
            <Badge variant={RADIUS_VARIANT[diagnosis.blast_radius] ?? 'outline'}>
              {diagnosis.blast_radius}
            </Badge>
          </div>
          <p className="whitespace-pre-wrap text-muted-foreground">{diagnosis.rationale}</p>
          {kind === 'dead_letter' && (
            <p className="mt-2 font-medium text-foreground">
              {permanent
                ? 'Recommended: Dismiss. A Retry can’t clear this — add the recipient in Meta (API Setup → Manage phone number list), then Retry.'
                : recommendRetry
                  ? 'Recommended: Retry — the highlighted button above.'
                  : recommendDismiss
                    ? 'Recommended: Dismiss — the highlighted button above.'
                    : 'Review the rationale, then Retry or Dismiss above.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
