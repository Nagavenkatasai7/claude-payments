'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// The ops-diagnosis copilot affordance (U5). Strictly rung-1 autonomy: the AI
// only DIAGNOSES — it synthesizes a rationale and suggests an action, but a
// human runs the existing audited Retry/Dismiss. Every diagnosis is audited
// server-side. Any AI failure degrades to a quiet inline "AI unavailable" —
// the manual ops actions are never blocked.

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

export function DiagnosePanel({ subjectId }: { subjectId: string }) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
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
      const data = (await res.json()) as { ok?: boolean; diagnosis?: Diagnosis };
      if (!res.ok || !data.ok || !data.diagnosis) throw new Error('unavailable');
      setDiagnosis(data.diagnosis);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={requestDiagnosis}
        disabled={loading}
      >
        {loading ? 'Diagnosing…' : '✦ Diagnose'}
      </Button>
      {error && <span className="ml-2 text-xs text-muted-foreground">AI unavailable</span>}
      {diagnosis && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-left text-xs">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{diagnosis.failure_class}</Badge>
            <Badge variant="secondary">{diagnosis.suggested_action}</Badge>
            <Badge variant={RADIUS_VARIANT[diagnosis.blast_radius] ?? 'outline'}>
              {diagnosis.blast_radius}
            </Badge>
          </div>
          <p className="whitespace-pre-wrap text-muted-foreground">{diagnosis.rationale}</p>
        </div>
      )}
    </div>
  );
}
