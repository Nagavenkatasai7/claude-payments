import type { ReactNode } from 'react';
import { dsCn } from '@/lib/ui/ds-cn';
import type { Tone } from '@/lib/ui/transfer-status';

export type { Tone };

// Tone sets. `warning` is the landing's "Review" tag (the --ds-warning-* tokens).
export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-ds-border bg-ds-ground text-ds-ink-muted',
  info: 'border-ds-border bg-ds-tint text-ds-primary',
  success: 'border-ds-success-border bg-ds-success-bg text-ds-success-ink',
  warning: 'border-ds-warning-border bg-ds-warning-bg text-ds-warning-ink',
  danger: 'border-ds-danger-border bg-ds-danger-bg text-ds-danger-ink',
};

/** A small pill. Colour is decoration only: the children must carry the meaning as text. */
export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children?: ReactNode }) {
  return (
    <span
      className={dsCn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] font-semibold',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
