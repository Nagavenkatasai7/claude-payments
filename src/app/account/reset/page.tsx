import { ResetForm } from '../account-forms';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Reset your password · SmartRemit' };

export default function AccountResetPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-2xl font-bold tracking-tight">
          Smart<span className="text-primary">Remit</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Reset your password</CardTitle>
          </CardHeader>
          <CardContent>
            <ResetForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
