'use client';

import { useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// The employee AI copilot panel (B3). Strictly rung-1 autonomy: the AI only
// DRAFTS — the staff member edits and explicitly clicks Send (the existing
// replyAction); nothing is ever auto-sent. Every suggestion and its outcome
// (accept verbatim / edited / discarded) is audited server-side. Any AI
// failure degrades to a quiet inline "AI unavailable" — manual replies are
// never blocked.

interface Triage {
  category: string;
  priority: string;
}

export function CopilotPanel({
  ticketId,
  closed,
  replyAction,
  applyTriageAction,
  copilotRejectAction,
}: {
  ticketId: string;
  closed: boolean;
  replyAction: (formData: FormData) => Promise<void>;
  applyTriageAction: (formData: FormData) => Promise<void>;
  copilotRejectAction: (ticketId: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [triage, setTriage] = useState<Triage | null>(null);
  const [draftError, setDraftError] = useState(false);
  const [summaryError, setSummaryError] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  async function requestDraft() {
    setDrafting(true);
    setDraftError(false);
    try {
      const res = await fetch('/api/copilot/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId }),
      });
      const data = (await res.json()) as { ok?: boolean; draft?: string };
      if (!res.ok || !data.ok || !data.draft) throw new Error('unavailable');
      setText(data.draft);
      setDraft(data.draft);
    } catch {
      setDraftError(true);
    } finally {
      setDrafting(false);
    }
  }

  function discardDraft() {
    setText('');
    setDraft(null);
    // Audit the rejection server-side; failure is non-blocking telemetry.
    startTransition(async () => {
      try {
        await copilotRejectAction(ticketId);
      } catch {
        /* audit-only — never disturb the staff member */
      }
    });
  }

  async function requestSummary() {
    setSummarizing(true);
    setSummaryError(false);
    try {
      const res = await fetch('/api/copilot/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId }),
      });
      const data = (await res.json()) as { ok?: boolean; summary?: string; triage?: Triage | null };
      if (!res.ok || !data.ok || !data.summary) throw new Error('unavailable');
      setSummary(data.summary);
      setTriage(data.triage ?? null);
    } catch {
      setSummaryError(true);
    } finally {
      setSummarizing(false);
    }
  }

  async function submitReply(formData: FormData) {
    // Copilot provenance, computed at submit time: verbatim draft ⇒ accepted;
    // a modified draft ⇒ edited; no draft involved ⇒ ''.
    formData.set('copilot', draft === null ? '' : text === draft ? 'accepted' : 'edited');
    await replyAction(formData);
    setText('');
    setDraft(null);
    formRef.current?.reset();
  }

  function applyTriage(formData: FormData) {
    startTransition(async () => {
      await applyTriageAction(formData);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Reply to customer</CardTitle>
          <CardDescription>
            The customer sees this in their portal and gets a WhatsApp nudge. AI drafts are
            suggestions only — review before sending.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {closed ? (
            <p className="text-sm text-muted-foreground">This ticket is closed.</p>
          ) : (
            <form ref={formRef} action={submitReply} className="space-y-3">
              <input type="hidden" name="ticketId" value={ticketId} />
              <textarea
                name="body"
                required
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Write a reply…"
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-ring/30"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" size="sm" disabled={pending}>
                  Send reply
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={requestDraft} disabled={drafting}>
                  {drafting ? 'Drafting…' : '✦ Draft reply'}
                </Button>
                {draft !== null && (
                  <Button type="button" size="sm" variant="outline" onClick={discardDraft}>
                    Discard draft
                  </Button>
                )}
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" name="waiting" className="h-3.5 w-3.5 accent-primary" />
                  Waiting on customer
                </label>
                {draftError && (
                  <span className="text-xs text-muted-foreground">AI unavailable</span>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Case summary</CardTitle>
          <CardDescription>AI-generated overview with a triage suggestion.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" size="sm" variant="outline" onClick={requestSummary} disabled={summarizing}>
            {summarizing ? 'Summarizing…' : '✦ Summarize'}
          </Button>
          {summaryError && <p className="text-xs text-muted-foreground">AI unavailable</p>}
          {summary && (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
              {summary}
            </div>
          )}
          {triage && !closed && (
            <form action={applyTriage} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="ticketId" value={ticketId} />
              <input type="hidden" name="category" value={triage.category} />
              <input type="hidden" name="priority" value={triage.priority} />
              <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold">
                {triage.category}
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold">
                {triage.priority}
              </span>
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                Apply triage
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
