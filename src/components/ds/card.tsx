import type { ReactNode } from 'react';
import { dsCn } from '@/lib/ui/ds-cn';

/** The landing card: 16 px radius, hairline border, white surface. */
export function Card({
  className,
  children,
  as: Tag = 'div',
}: {
  className?: string;
  children?: ReactNode;
  as?: 'div' | 'section' | 'article' | 'aside' | 'li';
}) {
  return <Tag className={dsCn('rounded-ds-card border border-ds-border bg-ds-surface p-6 sm:p-8', className)}>{children}</Tag>;
}
