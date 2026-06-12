export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireSupportOrAdmin } from '@/lib/auth';
import type { Ticket, TicketStatus } from '@/lib/types';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { askQuestionAction } from './actions';
import { listEmployeeQuestions } from './queries';
import { QuestionStatusBadge, STATUS_LABEL, TEXTAREA_CLASS } from './status-badge';

// Employee questions — ONE page, two modes (gate: requireSupportOrAdmin):
//   • support staff: an "Ask the admins" form + a list of THEIR OWN questions;
//   • admins: the full internal queue (platform admins all partners; partner
//     admins pinned to theirs) with a status filter.
// All scoping decisions live in ./queries — this page only renders.

// Derived from the exhaustive label map so the filter row tracks TicketStatus.
const STATUSES = Object.keys(STATUS_LABEL) as TicketStatus[];

const ADMIN_COLUMNS: ExpandableColumn[] = [
  { label: 'Subject', primary: true },
  { label: 'Asked by', primary: true },
  { label: 'Partner' },
  { label: 'Status', primary: true },
  { label: 'Updated' },
];

const MINE_COLUMNS: ExpandableColumn[] = [
  { label: 'Subject', primary: true },
  { label: 'Status', primary: true },
  { label: 'Updated', primary: true },
];

function subjectLink(t: Ticket) {
  return (
    <Link
      key="subject"
      href={`/admin-dashboard/employee-questions/${t.id}`}
      className="font-medium text-primary hover:underline"
    >
      {t.subject}
    </Link>
  );
}

export default async function EmployeeQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { staff } = await requireSupportOrAdmin();
  const isAdmin = staff.role === 'admin';
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as TicketStatus)
    ? (sp.status as TicketStatus)
    : undefined;

  const questions = await listEmployeeQuestions(staff, status);

  return (
    <>
      <Sidebar active="employee-questions" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Employee questions</div>
            <div className="sh-page-sub">
              {isAdmin
                ? 'Internal questions from your team — answer, resolve, close.'
                : 'Ask the admins anything — policy, process, or a tricky ticket.'}
            </div>
          </div>
        </div>

        {!isAdmin && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Ask the admins</CardTitle>
              <CardDescription>
                Your question opens an internal thread — only staff can see it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={askQuestionAction} className="space-y-4">
                <Input name="subject" placeholder="Subject (e.g. How do I handle a chargeback question?)" required />
                <textarea
                  name="question"
                  className={TEXTAREA_CLASS}
                  placeholder="Your question for the admins…"
                  required
                />
                <Button type="submit">Ask the admins</Button>
              </form>
            </CardContent>
          </Card>
        )}

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{isAdmin ? 'Question queue' : 'Your questions'}</CardTitle>
            <CardDescription>
              {questions.length} {questions.length === 1 ? 'question' : 'questions'}
              {status ? ` · ${STATUS_LABEL[status]}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isAdmin && (
              <div className="mb-4 flex flex-wrap gap-2 text-[13px]">
                <Link
                  href="/admin-dashboard/employee-questions"
                  className={`rounded-md border px-2.5 py-1 ${!status ? 'border-primary font-semibold text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                >
                  All
                </Link>
                {STATUSES.map((s) => (
                  <Link
                    key={s}
                    href={`/admin-dashboard/employee-questions?status=${s}`}
                    className={`rounded-md border px-2.5 py-1 ${status === s ? 'border-primary font-semibold text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {STATUS_LABEL[s]}
                  </Link>
                ))}
              </div>
            )}
            <ExpandableTable
              columns={isAdmin ? ADMIN_COLUMNS : MINE_COLUMNS}
              empty={
                isAdmin ? (
                  <>No employee questions{status ? ` with status ${STATUS_LABEL[status]}` : ' yet'}.</>
                ) : (
                  <>No questions yet — ask the admins above.</>
                )
              }
              rows={questions.map((t) => ({
                key: t.id,
                label: t.subject,
                cells: isAdmin
                  ? [
                      subjectLink(t),
                      t.openedBy ?? '—',
                      t.partnerId,
                      <QuestionStatusBadge key="status" status={t.status} />,
                      new Date(t.updatedAt).toLocaleString(),
                    ]
                  : [
                      subjectLink(t),
                      <QuestionStatusBadge key="status" status={t.status} />,
                      new Date(t.updatedAt).toLocaleString(),
                    ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
