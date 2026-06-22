import { requireCustomer } from '@/lib/customer-auth';
import { decryptField } from '@/lib/field-crypto';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { AccountShell, PageHeader } from '../shell';
import { maskPhone } from '../format';
import { updateEmailAction, changePasswordAction } from '../actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings · SmartRemit' };

// /account/settings — profile + credentials for the signed-in customer.
// The page only RENDERS; both forms post to self-gating server actions that
// derive the account from the session. Action results come back as FIXED query
// codes mapped to fixed copy below — dynamic text from the URL is never shown.

const OK_COPY: Record<string, string> = {
  email: 'Email updated.',
  password: 'Password changed. Your other devices were signed out.',
};

const ERR_COPY: Record<string, string> = {
  email: 'Enter a valid email address.',
  email_save: 'Could not update your email. Please try again.',
  pw_current: 'Current password is incorrect.',
  pw_policy: 'New password must be 8–64 characters and not a known-breached password.',
  pw_throttle: 'Too many attempts — try again later.',
  pw_save: 'Could not change your password. Please try again.',
};

export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const customer = await requireCustomer();
  const sp = await searchParams;
  const notice = typeof sp.ok === 'string' ? OK_COPY[sp.ok] : undefined;
  const error = typeof sp.err === 'string' ? ERR_COPY[sp.err] : undefined;

  // The customer's OWN email — stored as a field-crypto blob; a blob that no
  // longer decrypts (legacy/corrupt) just renders as empty, never a 500.
  let email = '';
  if (customer.email) {
    try {
      email = decryptField(customer.email);
    } catch {
      email = '';
    }
  }

  return (
    <AccountShell active="settings" customer={customer}>
      <PageHeader title="Settings" sub="Profile & security" />

      {notice ? (
        <Alert className="mb-6" role="status">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6">
        {/* Profile */}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Your sign-in identity.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">Phone (your sign-in)</div>
              <p className="mt-1 text-sm tabular-nums text-foreground">
                {maskPhone(customer.senderPhone)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Your phone number can&rsquo;t be changed here — it&rsquo;s your WhatsApp identity.
              </p>
            </div>
            {customer.fullName ? (
              <>
                <Separator />
                <div>
                  <div className="text-sm font-medium text-foreground">Name (from verification)</div>
                  <p className="mt-1 text-sm text-foreground">{customer.fullName}</p>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        {/* Email */}
        <Card>
          <CardHeader>
            <CardTitle>Email</CardTitle>
            <CardDescription>Where we send receipts and account notices.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={updateEmailAction} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  name="email"
                  defaultValue={email}
                  autoComplete="email"
                  required
                />
              </div>
              <div>
                <Button type="submit">Save email</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Password */}
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>
              Changing your password signs you out everywhere else.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={changePasswordAction} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="currentPassword">Current password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  name="currentPassword"
                  autoComplete="current-password"
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="newPassword">New password (8–64 characters)</Label>
                <Input
                  id="newPassword"
                  type="password"
                  name="newPassword"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={64}
                  required
                />
              </div>
              <div>
                <Button type="submit">Change password</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Notifications — transfer updates ride WhatsApp; reply STOP/START there. */}
        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <CardDescription>How you hear about your transfers.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Transfer updates arrive on WhatsApp automatically. Reply STOP in the chat to pause
              them, or START to resume.
            </p>
          </CardContent>
        </Card>
      </div>
    </AccountShell>
  );
}
