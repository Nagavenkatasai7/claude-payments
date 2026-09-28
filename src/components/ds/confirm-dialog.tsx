'use client';
import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Dialog } from 'radix-ui';
import { t } from '@/lib/i18n';
import { DEFAULT_REASON_MIN, isReasonValid } from '@/lib/ui/confirm-reason';
import { Button } from './button';

type FormProps = {
  confirmLabel: string;
  /**
   * The server action. It MUST re-check `isReasonValid(formData.get('reason'), min)` itself, with the SAME
   * minimum as `reasonMin` (share one constant): the client check is UX only.
   */
  action: (formData: FormData) => void | Promise<void>;
  reasonMin?: number;
  destructive?: boolean;
  /** A cancel control (ConfirmDialog passes its Close button). */
  cancel?: React.ReactNode;
};

function Submit({ label, ready, destructive }: { label: string; ready: boolean; destructive?: boolean }) {
  const { pending } = useFormStatus(); // disabled while submitting, so a destructive action cannot double-submit
  return (
    <Button type="submit" variant={destructive ? 'danger' : 'primary'} size="md" disabled={!ready || pending}>
      {label}
    </Button>
  );
}

/** The dialog's form body: a required typed reason, and confirm stays disabled until it is long enough. */
export function ConfirmDialogForm({ confirmLabel, action, reasonMin = DEFAULT_REASON_MIN, destructive, cancel }: FormProps) {
  const [reason, setReason] = React.useState('');
  const id = `reason-${React.useId()}`;
  const hintId = `${id}-hint`;
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col">
        <label htmlFor={id} className="mb-1.5 text-[14px] font-semibold text-ds-ink">
          {t('ds.dialog.reasonLabel')}
        </label>
        <textarea
          id={id}
          name="reason"
          required
          minLength={reasonMin}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={hintId}
          className="min-h-[92px] w-full rounded-ds-inner border border-ds-border-input bg-ds-surface px-4 py-3 text-[15px] text-ds-ink placeholder:text-ds-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
        />
        <p id={hintId} className="mt-1.5 text-[13px] text-ds-ink-muted">
          {t('ds.dialog.reasonHint', { min: reasonMin })}
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {cancel}
        <Submit label={confirmLabel} ready={isReasonValid(reason, reasonMin)} destructive={destructive} />
      </div>
    </form>
  );
}

/**
 * A confirmation dialog with a typed reason, for destructive or audited actions. Radix Dialog gives
 * the focus trap, Esc to close and focus return to the trigger. `trigger` must be a single focusable
 * element (it is used via asChild).
 */
export function ConfirmDialog({
  trigger,
  title,
  body,
  confirmLabel,
  reasonMin,
  action,
  destructive,
}: {
  trigger: React.ReactElement;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  reasonMin?: number;
  action: (formData: FormData) => void | Promise<void>;
  destructive?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const run = async (formData: FormData) => {
    await action(formData);
    setOpen(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ds-ink/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-ds-card border border-ds-border bg-ds-surface p-6 shadow-ds-pop sm:p-8">
          <Dialog.Title className="text-[20px] font-extrabold tracking-[-0.02em] text-ds-ink">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="text-[15px] leading-relaxed text-ds-ink-muted">{body}</div>
          </Dialog.Description>
          <ConfirmDialogForm
            confirmLabel={confirmLabel}
            action={run}
            reasonMin={reasonMin}
            destructive={destructive}
            cancel={
              <Dialog.Close asChild>
                <Button variant="ghost" size="md">
                  {t('ds.dialog.cancel')}
                </Button>
              </Dialog.Close>
            }
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
