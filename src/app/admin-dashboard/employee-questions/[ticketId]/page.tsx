export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSupportOrAdmin } from '@/lib/auth';
import { Sidebar } from '../../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  answerQuestionAction,
  replyQuestionAction,
  setQuestionStatusAction,
} from '../actions';
import { getEmployeeQuestion } from '../queries';
import { QuestionStatusBadge } from '../status-badge';

// One employee question — the internal thread. Access rules live in
// getEmployeeQuestion (internal-only, admin scope OR opener); a miss is a
// straight 404. Threads here are internal-only people, so the read includes
// internal notes by design.

const TEXTAREA_CLASS =
  'min-h-24 w-full rounded-md border border-input bg-card px-3 py-2 text-sm';

export default async function EmployeeQuestionThreadPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { staff } = await requireSupportOrAdmin();
  const { ticketId } = await params;

  const found = await getEmployeeQuestion(staff, ticketId);
  if (!found) notFound();
  const { ticket, messages } = found;

  const isAdmin = staff.role === 'admin';
  const isOpener = ticket.openedBy === staff.username;
  const closed = ticket.status === 'closed';

  return (
    <>
      <Sidebar active="employee-questions" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{ticket.subject}</div>
            <div className="sh-page-sub">
              <Link href="/admin-dashboard/employee-questions" className="text-primary hover:underline">
                ← Employee questions
              </Link>{' '}
              · {ticket.id} · asked by {ticket.openedBy ?? '—'} · partner {ticket.partnerId} ·{' '}
              {new Date(ticket.createdAt).toLocaleString()} ·{' '}
              <QuestionStatusBadge status={ticket.status} />
            </div>
          </div>
          {isAdmin && !closed && (
            <div className="flex gap-2">
              {ticket.status !== 'resolved' && (
                <form action={setQuestionStatusAction}>
                  <input type="hidden" name="ticketId" value={ticket.id} />
                  <input type="hidden" name="status" value="resolved" />
                  <Button type="submit" variant="outline">Resolve</Button>
                </form>
              )}
              <form action={setQuestionStatusAction}>
                <input type="hidden" name="ticketId" value={ticket.id} />
                <input type="hidden" name="status" value="closed" />
                <Button type="submit" variant="outline" className="text-destructive">Close</Button>
              </form>
            </div>
          )}
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Thread</CardTitle>
            <CardDescription>
              {messages.length} {messages.length === 1 ? 'message' : 'messages'} — visible to staff only
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {messages.map((m) => (
                <div key={m.id} className="rounded-lg border border-border bg-background p-3.5">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{m.actorId}</span>
                    {m.actorId === ticket.openedBy && <Badge variant="outline">asker</Badge>}
                    <span>{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-sm whitespace-pre-wrap">{m.body}</div>
                </div>
              ))}
            </div>

            {closed ? (
              <p className="mt-4 text-sm text-muted-foreground">
                This question is closed — the thread is read-only.
              </p>
            ) : isAdmin ? (
              <form action={answerQuestionAction} className="mt-4 space-y-4">
                <input type="hidden" name="ticketId" value={ticket.id} />
                <textarea
                  name="body"
                  className={TEXTAREA_CLASS}
                  placeholder="Write your answer…"
                  required
                />
                <Button type="submit">Send answer</Button>
              </form>
            ) : isOpener ? (
              <form action={replyQuestionAction} className="mt-4 space-y-4">
                <input type="hidden" name="ticketId" value={ticket.id} />
                <textarea
                  name="body"
                  className={TEXTAREA_CLASS}
                  placeholder="Add a follow-up…"
                  required
                />
                <Button type="submit">Reply</Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
