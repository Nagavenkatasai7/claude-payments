'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

// The KYC review copilot panel (Tier-1 quick win). Strictly rung-1 autonomy:
// the AI ONLY suggests a decision and narrates the case — the human reviewer
// still types a reason and clicks Approve/Reject in the adjacent reviewKycAction
// form. NOTHING here applies a decision; the suggestion is decoration. Any AI
// failure degrades to a quiet inline "AI unavailable" — review work never blocks.

interface Suggestion {
  summary: string;
  suggested_decision: 'approve' | 'reject' | 'need_more';
  confidence: 'low' | 'medium' | 'high';
  top_reasons: string[];
}

const DECISION_LABEL: Record<Suggestion['suggested_decision'], string> = {
  approve: 'Approve',
  reject: 'Reject',
  need_more: 'Need more info',
};

export function KycCopilotPanel({ phone }: { phone: string }) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function requestSuggestion() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/copilot/kyc-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId: phone }),
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
    <div className="mt-4 space-y-3 rounded-lg border border-dashed p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="outline" onClick={requestSuggestion} disabled={loading}>
          {loading ? 'Analyzing…' : '✦ AI review summary'}
        </Button>
        <span className="text-xs text-muted-foreground">
          A suggestion only — you decide. Nothing here approves or rejects.
        </span>
        {error && <span className="text-xs text-muted-foreground">AI unavailable</span>}
      </div>

      {suggestion && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold">
              Suggests: {DECISION_LABEL[suggestion.suggested_decision]}
            </span>
            <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold">
              Confidence: {suggestion.confidence}
            </span>
          </div>
          <div className="rounded-md border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
            {suggestion.summary}
          </div>
          {suggestion.top_reasons.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {suggestion.top_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
