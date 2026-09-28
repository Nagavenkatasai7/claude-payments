import { dsCn } from '@/lib/ui/ds-cn';

/** A decorative loading block. Announce loading separately (RouteLoading does). Server-safe. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={dsCn('animate-pulse rounded-ds-inner bg-ds-tint motion-reduce:animate-none', className)}
    />
  );
}
