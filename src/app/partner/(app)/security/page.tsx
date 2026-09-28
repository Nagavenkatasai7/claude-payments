import Link from 'next/link';
import type { Metadata } from 'next';
import { CircleAlert, ShieldAlert, ShieldCheck } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ANY } from '@/lib/partner-access';
import { partnerMfaEnrolmentPending } from '@/lib/partner-mfa-gate';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { t } from '@/lib/i18n';
import { Badge, Card, PageHeader, buttonVariants } from '@/components/ds';
import { EnrolPanel } from './enrol-panel';

export const metadata: Metadata = { title: t('partner.security.title'), robots: { index: false, follow: false } };

// /partner/security: two-step verification enrolment for the signed-in partner staff member.
// It gates with skipMfa only (this IS the enrolment target, so it must not redirect to itself).
// The enrolment itself is the existing self-gated action pair, which acts only on the session's
// own username; nothing here reads a username or tenant from the request.
export default async function PartnerSecurityPage() {
  const ctx = await requirePartnerStaff(PARTNER_ANY, { skipMfa: true });
  // Also clears a stale invite marker once the account is enrolled.
  const pending = await partnerMfaEnrolmentPending(ctx.staff);
  const enrolled = pending ? false : await getStaffMfaStore().isEnrolled(ctx.username);

  return (
    <div className="min-h-dvh bg-ds-ground">
      <main id="main" className="sh-main bg-transparent">
        <PageHeader title={t('partner.security.title')} sub={t('partner.security.sub')} />
        <div className="flex max-w-2xl flex-col gap-4">
          {pending ? (
            <div
              role="status"
              data-testid="partner-mfa-required"
              className="flex items-start gap-3 rounded-ds-card border border-ds-warning-border bg-ds-warning-bg p-4 text-[15px] text-ds-warning-ink"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <p>{t('partner.security.required')}</p>
            </div>
          ) : null}
          <Card as="section">
            <div className="flex flex-wrap items-center gap-3" data-testid="partner-mfa-status">
              <h2 className="text-[17px] font-semibold text-ds-ink">{t('partner.security.statusLabel')}</h2>
              {enrolled ? (
                <Badge tone="success">
                  <ShieldCheck aria-hidden="true" className="size-3.5" />
                  {t('partner.security.statusOn')}
                </Badge>
              ) : (
                <Badge tone="warning">
                  <ShieldAlert aria-hidden="true" className="size-3.5" />
                  {t('partner.security.statusOff')}
                </Badge>
              )}
            </div>
            <p className="mt-3 text-[15px] leading-relaxed text-ds-ink-muted">
              {enrolled ? t('partner.security.onBody') : t('partner.security.offBody')}
            </p>
            <div className="mt-6">
              {enrolled ? (
                <Link href="/partner" className={buttonVariants({ variant: 'primary', size: 'md' })}>
                  {t('partner.security.continue')}
                </Link>
              ) : (
                <EnrolPanel />
              )}
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
