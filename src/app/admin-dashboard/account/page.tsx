export const dynamic = 'force-dynamic';

import { requireStaff } from '@/lib/auth';
import { Sidebar } from '../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ChangePasswordForm } from './change-password-form';
import { MfaEnrolForm } from './mfa-enrol-form';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { mfaEnrolmentRequired } from '@/lib/staff-mfa-policy';

// Program-Fix 17a: every signed-in staff member (any role, platform or
// partner) can change their own password here. requireStaff, NOT requireScope:
// support staff must reach it too. sh-page scaffold classes are e2e hooks.

// Program-Fix 17b: two-step verification (TOTP) is opt-in for everyone here.
// `?enroll=1` is where requirePlatformAdmin sends an unenrolled platform admin
// when STAFF_MFA_REQUIRED is on (and, partner-demo R5, where the partner-staff
// actions send an unenrolled partner admin); this page itself never requires
// it (no loop).

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ enroll?: string | string[] }>;
}) {
  const me = await requireStaff();
  const enrolled = await getStaffMfaStore().isEnrolled(me.username);
  const mustEnrol = !enrolled && (await searchParams).enroll === '1' && mfaEnrolmentRequired(me, { partnerAdmins: true });
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
            <CardTitle>Two-step verification</CardTitle>
            <CardDescription>
              {enrolled
                ? 'On. Every sign-in asks for a code from your authenticator app. Lost the device? Ask a platform admin to reset it from the Team page.'
                : 'Off. Turn it on to require a code from an authenticator app at every sign-in.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {mustEnrol && (
              <p className="mb-4 text-sm font-medium text-destructive" role="alert">
                Two-step verification is required for platform admins. Set it up to continue.
              </p>
            )}
            {enrolled ? <p className="text-sm">Status: on</p> : <MfaEnrolForm />}
          </CardContent>
        </Card>
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
