export const dynamic = 'force-dynamic';

import { requireStaff } from '@/lib/auth';
import { Sidebar } from '../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ChangePasswordForm } from './change-password-form';

// Program-Fix 17a: every signed-in staff member (any role, platform or
// partner) can change their own password here. requireStaff, NOT requireScope:
// support staff must reach it too. sh-page scaffold classes are e2e hooks.

export default async function AccountPage() {
  const me = await requireStaff();
  return (
    <>
      <Sidebar />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <h1 className="sh-page-title">Account</h1>
            <div className="sh-page-sub">Signed in as {me.username}</div>
          </div>
        </div>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Changing your password signs out every other session. This browser stays signed in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
