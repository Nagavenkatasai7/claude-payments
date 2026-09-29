import Link from 'next/link';
import { Link2Off } from 'lucide-react';
import { t } from '@/lib/i18n';
import { buttonVariants } from '@/components/ds';

// THE dead-invite sheet (UI redesign M3-9). No props on purpose: every failure (unknown, malformed,
// expired, used, revoked, suspended tenant, inviter no longer an admin, username taken, rate limit)
// renders exactly these bytes, so the page is no oracle about the token or the tenant.
export function DeadInvite() {
  return (
    <div data-testid="partner-invite-dead" className="flex flex-col items-start gap-4">
      <Link2Off aria-hidden="true" className="size-8 text-ds-ink-muted" />
      <h1 className="text-[24px] font-semibold tracking-tight text-ds-ink">{t('partner.invite.deadTitle')}</h1>
      <p className="text-[15px] leading-relaxed text-ds-ink-muted">{t('partner.invite.deadBody')}</p>
      <Link href="/login" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
        {t('partner.invite.signIn')}
      </Link>
    </div>
  );
}
