import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title?: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-ds-card border border-dashed border-ds-border bg-ds-surface px-6 py-10 text-center">
      {icon ? (
        <span
          aria-hidden="true"
          className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-ds-icon-bg text-ds-icon-ink ring-1 ring-ds-icon-ring"
        >
          {icon}
        </span>
      ) : null}
      <h2 className="text-[17px] font-semibold text-ds-ink">{title ?? t('ds.empty.title')}</h2>
      {body ? <p className="mt-2 max-w-[46ch] text-[15px] leading-relaxed text-ds-ink-muted">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
