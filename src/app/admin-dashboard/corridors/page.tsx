export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { Sidebar } from '../sidebar';
import { money } from '../format';

export default async function CorridorsPage() {
  // Corridor requests are platform-wide (no per-partner scoping yet).
  // Require any authenticated staff; render nothing sensitive if partner-scoped.
  await requireScope();

  const requests = await getStore().listCorridorRequests();

  return (
    <>
      <Sidebar active="corridors" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Corridor requests</div>
            <div className="sh-page-sub">
              Customers who asked to send to countries we don&apos;t deliver to yet.
            </div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">All requests</div>
              <div className="sh-card-sub">
                {requests.length} {requests.length === 1 ? 'request' : 'requests'}, newest first
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {requests.length === 0 ? (
              <div className="sh-empty">No corridor requests yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Destination</th>
                    <th>Approx amount</th>
                    <th>Sender phone</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.capturedAt).toLocaleString()}</td>
                      <td>{r.destinationCountry}</td>
                      <td>
                        {r.approxAmount != null
                          ? money(r.approxAmount, r.approxCurrency ?? 'USD')
                          : <span className="sh-recipient-sub">—</span>}
                      </td>
                      <td>
                        <span className="sh-recipient-sub">+{r.senderPhone}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
