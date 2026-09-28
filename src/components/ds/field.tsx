import * as React from 'react';
import { t } from '@/lib/i18n';
import { dsCn } from '@/lib/ui/ds-cn';

// Form controls in the landing's field look (src/app/page.tsx contact form). Native elements only, so
// they work in a plain <form action> with no client JS. Every control has a <label>; hint and error
// are linked with aria-describedby; the error is announced (role="alert").
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const CONTROL = `min-h-[46px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-ds-danger-ink ${FOCUS}`;

export type FieldIds = { id: string; describedBy: string | undefined; invalid: boolean };

function Hint({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-[13px] text-ds-ink-muted">
      {children}
    </p>
  );
}

function ErrorText({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 text-[13px] font-semibold text-ds-danger-ink">
      {children}
    </p>
  );
}

function useFieldIds(name: string, hint: unknown, error: unknown) {
  const id = `${name}-${React.useId()}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return { id, hintId, errorId, describedBy };
}

/** A labelled field. The render prop receives the ids to put on the control. */
export function Field({
  name,
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  name: string;
  label: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: (ids: FieldIds) => React.ReactNode;
}) {
  const { id, hintId, errorId, describedBy } = useFieldIds(name, hint, error);
  return (
    <div className={dsCn('flex flex-col', className)}>
      <label htmlFor={id} className="mb-1.5 text-[14px] font-semibold text-ds-ink">
        {label}
        {required ? <span className="ml-1.5 text-[12.5px] font-medium text-ds-ink-muted">({t('ds.field.required')})</span> : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hintId ? <Hint id={hintId}>{hint}</Hint> : null}
      {errorId ? <ErrorText id={errorId}>{error}</ErrorText> : null}
    </div>
  );
}

export function Input({ className, invalid, ...props }: React.ComponentProps<'input'> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={dsCn(CONTROL, className)} {...props} />;
}

export function Select({ className, invalid, ...props }: React.ComponentProps<'select'> & { invalid?: boolean }) {
  return <select aria-invalid={invalid || undefined} className={dsCn(CONTROL, 'pr-10', className)} {...props} />;
}

/** A native checkbox wrapped in its own label (the whole line is the hit target). */
export function Checkbox({
  name,
  label,
  hint,
  error,
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & { name: string; label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode }) {
  const { id, hintId, errorId, describedBy } = useFieldIds(name, hint, error);
  return (
    <div className={dsCn('flex flex-col', className)}>
      <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-3 text-[15px] text-ds-ink">
        <input
          {...props}
          type="checkbox"
          id={id}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={dsCn('size-5 shrink-0 cursor-pointer rounded accent-ds-primary', FOCUS)}
        />
        <span>{label}</span>
      </label>
      {hintId ? <Hint id={hintId}>{hint}</Hint> : null}
      {errorId ? <ErrorText id={errorId}>{error}</ErrorText> : null}
    </div>
  );
}
