import Link from 'next/link';
import { t } from '@/lib/i18n';
import { buttonVariants } from '@/components/ds';

// A 404 INSIDE the portal (a page that calls notFound() on a partner host). The apex never reaches
// it: the portal layout's own gate 404s first, which falls through to the brand-neutral root 404.
export default function PortalNotFound() {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="sh-page-title text-ds-ink font-extrabold text-[clamp(24px,3vw,32px)]">{t('portal.notFound.title')}</h1>
      <p className="text-ds-ink-muted">{t('portal.notFound.body')}</p>
      <Link href="/portal" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
        {t('portal.notFound.home')}
      </Link>
    </div>
  );
}
