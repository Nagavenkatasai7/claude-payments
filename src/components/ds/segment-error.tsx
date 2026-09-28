'use client'; // error boundaries are Client Components (next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md)
import { ErrorState } from './error-state';

/**
 * The shared route-segment error boundary. A segment's error.tsx is exactly:
 *   'use client';
 *   export { SegmentError as default } from '@/components/ds/segment-error';
 * It never renders error.message or the stack: server errors arrive generic, but client-thrown
 * ones keep their original message, which may carry customer data. Only the digest is shown.
 */
export function SegmentError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState digest={error.digest} onRetry={() => retry()} />;
}
