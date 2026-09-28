import { t } from '@/lib/i18n';

/** The shared route-segment loading state: a row skeleton, announced to assistive tech. */
export function RouteLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{t('ds.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-14 animate-pulse rounded-ds-inner bg-ds-tint motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
