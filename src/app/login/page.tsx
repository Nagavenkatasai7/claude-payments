import type { Metadata } from 'next';
import { LoginForm } from './login-form';
import { StaffAuthShell } from './staff-auth-shell';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { SkipLink } from '@/components/skip-link';

export const dynamic = 'force-dynamic';

// SmartRemit-owned surface (see ../brand-icons.ts): the SmartRemit.ai tab icon.
export const metadata: Metadata = { title: 'Employee portal · SmartRemit', icons: SMARTREMIT_ICONS };

// The employee portal sign-in (the main site's Log in > Employee portal), in the landing look with the
// SmartRemit.ai logo. Only the frame changed: the form posts to the same login action.

export default function LoginPage() {
  return (
    <>
      <SkipLink />
      <StaffAuthShell
        title="Sign in to your workspace"
        sub="Use your SmartRemit staff account."
        footer={<p>Forgot your password? Ask your workspace admin to reset it.</p>}
      >
        <LoginForm />
      </StaffAuthShell>
    </>
  );
}
