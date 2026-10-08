import { RouteLoading } from '@/components/ds/route-loading';

// Batch B2: the payees queue's loading state, in the dashboard's page column.
export default function PayeesLoading() {
  return (
    <main className="sh-main min-[1025px]:col-start-2">
      <RouteLoading />
    </main>
  );
}
