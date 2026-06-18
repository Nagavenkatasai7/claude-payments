'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// The compliance-analyst copilot affordance (U6). Strictly rung-1 autonomy: per
// in-review row, the analyst clicks "Suggest disposition" and the AI returns a
// CLAMPED {urgency, suggested_path, rationale} narrative. It is SUGGEST-ONLY —
// the Release / Reject & refund buttons beside it stay the existing
// deterministic, audited dashboard-ops actions; the AI never executes. Any
// failure degrades to a quiet inline "AI unavailable" — manual triage is never
// blocked.

interface Suggestion {
  urgency: string;
  suggested_path: string;
  rationale: string;
}

const URGENCY_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  low: 'secondary',
  normal: 'outline',
  high: 'destructive',
};

export function ReviewCopilot({ transferId }: { transferId: string }) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function suggest() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/copilot/review-triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId: transferId }),
      });
      const data = (await res.json()) as { ok?: boolean; suggestion?: Suggestion };
      if (!res.ok || !data.ok || !data.suggestion) throw new Error('unavailable');
      setSuggestion(data.suggestion);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={suggest} disabled={loading}>
          {loading ? 'Thinking…' : '✦ Suggest disposition'}
        </Button>
        {error && <span className="text-xs text-muted-foreground">AI unavailable</span>}
      </div>
      {suggestion && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={URGENCY_VARIANT[suggestion.urgency] ?? 'outline'}>
              {suggestion.urgency} urgency
            </Badge>
            <Badge variant="outline" className="font-semibold">
              {suggestion.suggested_path}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              AI suggestion — you decide
            </span>
          </div>
          <p className="whitespace-pre-wrap text-foreground">{suggestion.rationale}</p>
        </div>
      )}
    </div>
  );
}
