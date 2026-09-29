import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { t } from '@/lib/i18n';
import { buttonVariants } from '@/components/ds';

// The Send flow's identity card (UI redesign M2-9). 'verify' links to the Profile verification
// section (never a raw provider URL); 'contact' is for a rejected customer: contact the partner, no
// retry (owner decision 2026-09-28). Plain markup: rendered by server pages and client forms alike.
export function KycCard({ kind, message }: { kind: 'verify' | 'contact'; message: string }) {
  return (
    <div
      data-kyc-card={kind}
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-ds-card border border-ds-warning-border bg-ds-warning-bg p-4 text-ds-warning-ink"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        {kind === 'verify' ? <p className="font-semibold">{t('portal.send.kycTitle')}</p> : null}
        <p className={kind === 'verify' ? 'mt-1 text-[14px]' : 'text-[14px] font-semibold'}>{message}</p>
      </div>
      {kind === 'verify' ? (
        <Link href="/portal/profile#verify" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {t('portal.send.kycCta')}
        </Link>
      ) : null}
    </div>
  );
}

/** A fixed-copy refusal line (never a server message). */
export function SendAlert({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-ds-inner border border-ds-danger-ink/30 bg-ds-danger-bg px-4 py-3 text-[14px] font-semibold text-ds-danger-ink">
      {message}
    </p>
  );
}
