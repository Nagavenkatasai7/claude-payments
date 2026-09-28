import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePortalSite } from '@/lib/portal-site';
import { getPortalCustomer } from '@/lib/portal-auth';
import { isPortalEmailToken } from '@/lib/portal-email-verify';
import { t } from '@/lib/i18n';
import { Button, Card, PageHeader } from '@/components/ds';
import { VerifyEmailForm } from './verify-form';

// The token rides in the query: never leak it to another origin through the Referer.
export const metadata: Metadata = { title: t('portal.email.verify_title'), referrer: 'no-referrer' };

/**
 * The email verify link's landing page (UI redesign M2-11, Task 11.4). GET NEVER consumes the token
 * (link scanners fetch it): it only renders a confirm button, and the POST (verifyEmailAction)
 * consumes it for the signed-in customer on THIS host. Signed out → "sign in, then open the link
 * again" (the sign-in return allow-list takes no query, so the token would be lost), and the form
 * carrying the token is not rendered. A malformed token gets the one "invalid link" message.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePortalSite();
  const ctx = await getPortalCustomer();
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' && isPortalEmailToken(raw) ? raw : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <PageHeader title={t('portal.email.verify_title')} />
      <Card className="flex flex-col gap-4">
        {!ctx ? (
          <>
            <p className="text-[15px] text-ds-ink-muted">{t('portal.email.verify_signin')}</p>
            <div>
              <Button asChild size="md">
                <Link href="/portal/login">{t('portal.email.verify_signin_cta')}</Link>
              </Button>
            </div>
          </>
        ) : token ? (
          <>
            <p className="text-[15px] text-ds-ink-muted">{t('portal.email.verify_body_page')}</p>
            <VerifyEmailForm token={token} />
          </>
        ) : (
          <p role="alert" className="text-[15px] font-semibold text-ds-danger-ink">
            {t('portal.email.link_invalid')}
          </p>
        )}
      </Card>
    </div>
  );
}
