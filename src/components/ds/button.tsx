import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { dsCn } from '@/lib/ui/ds-cn';

// The landing's pill recipes (src/app/page.tsx BTN_WA / BTN_PRIMARY / BTN_GHOST), expressed in ds tokens.
// `primary` follows the partner-overridable --ds-primary, so a themed site recolours it.
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const LIFT = 'hover:-translate-y-px motion-reduce:hover:translate-y-0';

const pill = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap transition-[background-color,border-color,transform] duration-150 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`,
  {
    variants: {
      variant: {
        whatsapp: `rounded-full bg-ds-cta-whatsapp font-bold text-ds-on-whatsapp shadow-ds-cta hover:bg-ds-cta-whatsapp-hover ${LIFT}`,
        primary: `rounded-full bg-ds-primary font-bold text-ds-on-primary shadow-ds-primary hover:bg-ds-primary-hover ${LIFT}`,
        ghost: 'rounded-full border border-ds-border-strong bg-ds-surface/70 font-semibold text-ds-ink hover:border-ds-primary/50 hover:bg-ds-surface',
        danger: 'rounded-full border border-ds-danger-border bg-ds-danger-bg font-semibold text-ds-danger-ink hover:border-ds-danger-ink/40',
        link: 'rounded-ds-focus font-semibold text-ds-primary underline-offset-4 hover:underline',
      },
      size: {
        lg: 'min-h-[52px] px-7 text-[16px]',
        md: 'min-h-10 px-4 text-[13.5px]',
        sm: 'min-h-9 px-3.5 text-[13px]',
      },
    },
    // A link is inline text, not a pill: it keeps the type size but drops the pill height and padding.
    compoundVariants: [
      { variant: 'link', size: 'lg', class: 'min-h-0 px-0' },
      { variant: 'link', size: 'md', class: 'min-h-0 px-0' },
      { variant: 'link', size: 'sm', class: 'min-h-0 px-0' },
    ],
    defaultVariants: { variant: 'primary', size: 'lg' },
  },
);

export type ButtonVariantProps = VariantProps<typeof pill>;

/** The merged class string (dsCn resolves the link variant's size overrides). */
export function buttonVariants(props?: ButtonVariantProps): string {
  return dsCn(pill(props));
}

export type ButtonProps = React.ComponentProps<'button'> & ButtonVariantProps & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = dsCn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot.Root className={classes} {...props} />;
  return <button className={classes} type={type ?? 'button'} {...props} />;
}
