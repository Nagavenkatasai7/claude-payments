import Link from 'next/link';
import { EmptyState } from '@/components/ds';

// An unknown guide (dynamicParams = false) or any other missing /docs-next path.
export default function DocsNotFound() {
  return (
    <div className="mt-2">
      <EmptyState
        title="This guide doesn’t exist"
        body="It may have moved. Every partner guide is listed on the docs home."
        action={
          <Link className="font-semibold text-ds-primary hover:underline" href="/docs-next">
            Back to the partner docs
          </Link>
        }
      />
    </div>
  );
}
