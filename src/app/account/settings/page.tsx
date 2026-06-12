import Link from 'next/link';
import { requireCustomer } from '@/lib/customer-auth';
import { decryptField } from '@/lib/field-crypto';
import { updateEmailAction, changePasswordAction } from '../actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings · SmartRemit' };

// /account/settings — profile + credentials for the signed-in customer.
// The page only RENDERS; both forms post to self-gating server actions that
// derive the account from the session. Action results come back as FIXED query
// codes mapped to fixed copy below — dynamic text from the URL is never shown.

/** Mask a phone for display (•••2030) — never render the full number. */
function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length <= 4 ? d : `••• ••• ${d.slice(-4)}`;
}

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

// Same field idiom as account-forms.tsx (16px inputs so iOS Safari never zooms).
const fieldLabelCls = 'mb-1.5 block text-[13px] text-[#8696a0]';
const inputCls =
  'w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';
const buttonCls =
  'w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a]';
const cardHeadCls = 'mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-[#8696a0]';

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
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px]">
        <div className="mb-4 rounded-2xl bg-[#111b21] p-6">
          <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
          <h1 className="mb-2 text-lg font-semibold leading-normal">Settings</h1>
          {notice ? (
            <p className="mt-1 mb-1 text-[13px] leading-[1.4] text-[#25d366]" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="mt-1 mb-1 text-[13px] leading-[1.4] text-[#f15c6d]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        {/* Profile */}
        <section className="mb-4 rounded-2xl bg-[#111b21] p-6">
          <h2 className={cardHeadCls}>Profile</h2>
          <div className="mb-4">
            <span className={fieldLabelCls}>Phone (your sign-in)</span>
            <p className="text-[15px] leading-normal">{maskPhone(customer.senderPhone)}</p>
            <p className="mt-1 text-xs leading-normal text-[#667781]">
              Your phone number can&rsquo;t be changed here — it&rsquo;s your WhatsApp identity.
            </p>
          </div>
          {customer.fullName ? (
            <div className="mb-4">
              <span className={fieldLabelCls}>Name (from verification)</span>
              <p className="text-[15px] leading-normal">{customer.fullName}</p>
            </div>
          ) : null}
          <form action={updateEmailAction}>
            <label className="mb-4 block">
              <span className={fieldLabelCls}>Email</span>
              <input
                className={inputCls}
                type="email"
                name="email"
                defaultValue={email}
                autoComplete="email"
                required
              />
            </label>
            <button className={buttonCls} type="submit">Save email</button>
          </form>
        </section>

        {/* Password */}
        <section className="mb-4 rounded-2xl bg-[#111b21] p-6">
          <h2 className={cardHeadCls}>Change password</h2>
          <form action={changePasswordAction}>
            <label className="mb-4 block">
              <span className={fieldLabelCls}>Current password</span>
              <input
                className={inputCls}
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                required
              />
            </label>
            <label className="mb-4 block">
              <span className={fieldLabelCls}>New password (8–64 characters)</span>
              <input
                className={inputCls}
                type="password"
                name="newPassword"
                autoComplete="new-password"
                minLength={8}
                maxLength={64}
                required
              />
            </label>
            <button className={buttonCls} type="submit">Change password</button>
          </form>
          <p className="mt-3 text-xs leading-normal text-[#667781]">
            Changing your password signs you out everywhere else.
          </p>
        </section>

        {/* Notifications — transfer updates ride WhatsApp; reply STOP/START there. */}
        <section className="mb-4 rounded-2xl bg-[#111b21] p-6">
          <h2 className={cardHeadCls}>Notifications</h2>
          <p className="text-sm leading-normal text-[#8696a0]">
            Transfer updates arrive on WhatsApp automatically. Reply STOP in the chat to pause
            them, or START to resume.
          </p>
        </section>

        <p className="mt-4">
          <Link href="/account" className="text-sm text-[#8696a0] underline">
            ← Back to your account
          </Link>
        </p>
      </div>
    </main>
  );
}
