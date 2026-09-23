import type { Metadata } from 'next';
import { LoginForm } from './login-form';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkipLink } from '@/components/skip-link';

export const dynamic = 'force-dynamic';

// SmartRemit-owned surface (see ../brand-icons.ts): the SmartRemit.ai tab icon.
export const metadata: Metadata = { icons: SMARTREMIT_ICONS };

// Staff sign-in (Stage 5e conversion — shadcn/Tailwind, no sh-* classes).

export default function LoginPage() {
  return (
    <>
      <SkipLink />
      <main
        id="main"
        className="flex min-h-screen items-center justify-center bg-background px-4 font-sans text-foreground antialiased"
      >
        <Card className="w-full max-w-sm">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                SR
              </span>
              SmartRemit
            </div>
            <p className="text-xs text-muted-foreground">smartremit.ai</p>
            <CardTitle className="pt-2 text-xl">
              <h1>Staff sign in</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
