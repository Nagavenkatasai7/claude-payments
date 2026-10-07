'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { AmlExplainFacts, AmlExplanation } from '@/lib/aml-explain-ai';

// The AML "Explain" affordance (A4) on /admin-dashboard/compliance. Strictly rung-1 and READ-ONLY:
// the analyst clicks Explain and gets (1) a FACTS table rendered from the server's `facts` bundle
// (never from model text) and (2) an AI narrative below it, labelled "AI explanation — you
// decide", or the deterministic standard explanation when the AI is unavailable. Release, reject
// and the alert review stay the existing audited actions beside it; nothing here mutates.

interface ExplainResponse {
  ok?: boolean;
  source?: 'ai' | 'fallback';
  facts?: AmlExplainFacts;
  explanation?: AmlExplanation;
}

const NEXT_STEP_LABEL: Record<AmlExplanation['next_step'], string> = {
  review_sender_history: 'Review the sender history',
  request_source_of_funds: 'Request source of funds',
  verify_recipient_relationship: 'Verify the recipient relationship',
  escalate: 'Escalate',
  keep_on_hold: 'Keep on hold',
  close_alert_no_action: 'Close the alert (no action)',
};

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="border-t border-border first:border-t-0">
      <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground align-top">{label}</th>
      <td className="py-1 tabular-nums">{children}</td>
    </tr>
  );
}

export function FactsTable({ facts }: { facts: AmlExplainFacts }) {
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">Facts</caption>
      <tbody>
        <FactRow label="Rules">
          {facts.rules.length === 0 ? 'None recorded' : (
            <ul className="space-y-0.5">
              {facts.rules.map((r) => (
                <li key={r.rule}>
                  <span className="font-semibold">{r.rule}</span> — {r.reason}
                  {r.window !== undefined ? ` · window ${r.window} · count ${r.count} · sum ${usd(r.sumUsd ?? 0)}` : ''}
                  {r.source === 'recomputed' ? ' · recomputed (no alert yet)' : ''}
                </li>
              ))}
            </ul>
          )}
        </FactRow>
        {facts.thresholds ? (
          <FactRow label="Thresholds">
            large {usd(facts.thresholds.largeAmountUsd)} · band from {usd(facts.thresholds.bandLowerUsd)} ·{' '}
            {facts.thresholds.structuringCount} in 7 days · {usd(facts.thresholds.aggregateUsd)} in 30 days · first send{' '}
            {usd(facts.thresholds.firstTransferUsd)} · {facts.thresholds.clusterSenders} senders
          </FactRow>
        ) : null}
        <FactRow label="Amount (USD eq.)">{usd(facts.amountUsd)}</FactRow>
        <FactRow label="Corridor">{facts.sourceCountry} → {facts.destinationCountry} · {facts.payoutMethodClass} · {facts.transferType}</FactRow>
        <FactRow label="On hold">{facts.onHold ? `Yes, ${facts.holdAgeHours ?? 0}h` : 'No'}</FactRow>
        <FactRow label="Hold reasons">{facts.holdReasons.length ? facts.holdReasons.join(', ') : '—'}</FactRow>
        <FactRow label="EDD required">{facts.eddRequired ? 'Yes' : 'No'}</FactRow>
      </tbody>
    </table>
  );
}

export function AmlExplain({ transferId }: { transferId: string }) {
  const [data, setData] = useState<Required<Pick<ExplainResponse, 'source' | 'facts' | 'explanation'>> | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function explain() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/copilot/aml-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId: transferId }),
      });
      const body = (await res.json()) as ExplainResponse;
      if (!res.ok || !body.ok || !body.facts || !body.explanation || !body.source) throw new Error('unavailable');
      setData({ source: body.source, facts: body.facts, explanation: body.explanation });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={explain} disabled={loading}>
          {loading ? 'Explaining…' : 'Explain'}
        </Button>
        {error && <span className="text-xs text-muted-foreground">Explanation unavailable</span>}
      </div>
      {data && (
        <div className="space-y-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
          <FactsTable facts={data.facts} />
          <div className="border-t border-border pt-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="font-semibold">{NEXT_STEP_LABEL[data.explanation.next_step]}</Badge>
              <span className="text-[10px] text-muted-foreground">
                {data.source === 'ai' ? 'AI explanation — you decide' : 'AI unavailable — standard explanation'}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-foreground">{data.explanation.summary}</p>
            {data.explanation.checks.length > 0 && (
              <ul className="mt-1.5 list-disc pl-4 text-foreground">
                {data.explanation.checks.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
