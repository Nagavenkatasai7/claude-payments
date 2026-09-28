import { t } from '@/lib/i18n';

/**
 * A brand-neutral error card. It never takes a message: callers pass only the opaque digest, so no
 * error detail (which may carry customer data) can reach the page.
 */
export function ErrorState({ digest, onRetry }: { digest?: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto max-w-md rounded-ds-card border border-ds-border bg-ds-surface p-6 text-center sm:p-8"
    >
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ds-ink">{t('ds.error.title')}</h2>
      <p className="mt-3 text-[15px] leading-relaxed text-ds-ink-muted">{t('ds.error.body')}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-full bg-ds-primary px-6 text-[15px] font-bold text-ds-on-primary shadow-ds-primary transition-[background-color,transform] duration-150 hover:-translate-y-px hover:bg-ds-primary-hover focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          {t('ds.error.retry')}
        </button>
      ) : null}
      {digest ? (
        <p className="mt-6 text-xs text-ds-ink-faint">
          {t('ds.error.reference')}: <span className="font-mono">{digest}</span>
        </p>
      ) : null}
    </div>
  );
}
