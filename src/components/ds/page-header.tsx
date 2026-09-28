import type { ReactNode } from 'react';

/**
 * A page heading for NEW routes. It keeps the smoke hooks (.sh-page-head / .sh-page-title / .sh-page-sub,
 * whose layout lives in tailwind.css @layer components) and restyles them with utilities, which win
 * over that layer, to the landing's heavy navy heading. The shared CSS is untouched.
 */
export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sh-page-head">
      <div>
        <h1 className="sh-page-title text-ds-ink font-extrabold tracking-[-0.025em] text-[clamp(24px,3vw,32px)]">{title}</h1>
        {sub ? <p className="sh-page-sub text-ds-ink-muted text-[14px]">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
