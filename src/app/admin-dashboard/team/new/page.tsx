export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/auth';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../../sidebar';
import { Icon } from '../../icons';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createStaffAction } from '../actions';

export default async function NewTeammatePage() {
  await requirePlatformAdmin();
  const partners = await getPartnerStore().listPartners();

  return (
    <>
      <Sidebar active="team" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Add teammate</div>
            <div className="sh-page-sub">
              <Link
                href="/admin-dashboard/team"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline [&>svg]:size-3.5"
              >
                <Icon name="chevron-right" /> Back to Team
              </Link>
            </div>
          </div>
        </div>

        <Card className="max-w-[640px]">
          <CardHeader>
            <CardTitle>New teammate</CardTitle>
            <CardDescription>
              They sign in immediately with the username and password you set here
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createStaffAction} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="t-name">Full name</Label>
                  <Input id="t-name" name="name" required placeholder="Jordan Rivera" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t-username">Username</Label>
                  <Input id="t-username" name="username" required placeholder="jordan" autoComplete="off" />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="t-password">Temporary password</Label>
                  <Input id="t-password" name="password" type="password" required minLength={8} placeholder="At least 8 characters" autoComplete="new-password" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t-role">Role</Label>
                  <select
                    id="t-role"
                    name="role"
                    className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                    defaultValue="agent"
                  >
                    <option value="agent">Agent — scoped permissions</option>
                    <option value="admin">Admin — full access</option>
                    <option value="support">Support — tickets only</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="t-scope">Scope</Label>
                <select
                  id="t-scope"
                  name="partnerId"
                  className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                  defaultValue=""
                >
                  <option value="">Platform — sees all partners</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — partner-scoped
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="rounded-lg border border-border p-4">
                <legend className="px-1 text-sm font-medium">Agent permissions</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="canCancel" /> Cancel / refund</label>
                  <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="canResend" /> Resend link</label>
                  <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="canAssign" /> Assign</label>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Admins always have every permission; these apply to agents.
                </p>
              </fieldset>

              <Button type="submit">
                <Icon name="plus" /> Create teammate
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
