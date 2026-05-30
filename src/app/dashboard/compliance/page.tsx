export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { topVelocityToday } from '@/lib/dashboard';
import { WATCHLIST } from '@/lib/compliance';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import type { Transfer } from '@/lib/types';

function inr(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}

function TransferRow({ t }: { t: Transfer }) {
  return (
    <tr>
      <td>
        <div className="sh-recipient">{t.recipientName}</div>
        <div className="sh-recipient-sub">
          {t.payoutMethod.toUpperCase()} · {t.payoutDestination}
        </div>
      </td>
      <td>
        <div className="sh-amount">{money(t.amountSource, t.sourceCurrency)}</div>
        {t.sourceCurrency !== 'USD' && (
          <div className="sh-recipient-sub">≈ {money(t.amountUsd, 'USD')}</div>
        )}
        <div className="sh-recipient-sub">{inr(t.amountInr)}</div>
      </td>
      <td>
        {t.complianceReasons.length === 0 ? '—' : t.complianceReasons.map((r) =>
          r === 'edd_required'
            ? <span key={r} className="sh-pill sh-pill-warning"><span className="sh-pill-dot"></span>EDD required</span>
            : <span key={r} style={{ marginRight: 6 }}>{r}</span>,
        )}
      </td>
      <td>{new Date(t.createdAt).toLocaleString()}</td>
      <td><span className="sh-recipient-sub">{t.phone}</span></td>
    </tr>
  );
}

export default async function CompliancePage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const transfers = await scoped.listTransfers();
  const flagged = transfers.filter((t) => t.complianceStatus === 'flagged');
  const blocked = transfers.filter((t) => t.complianceStatus === 'blocked');
  const topVel = topVelocityToday(transfers, Date.now(), 10);

  const partners = await scoped.listPartners();
  const corridorRows = partners.flatMap((p) =>
    (p.countries ?? [])
      .filter((c) => c !== 'IN')
      .map((country) => {
        const rules = resolveCorridorRules(p, country);
        return {
          partnerName: p.name ?? '',
          corridor: `${country} → IN`,
          largeAmountUsd: rules.largeAmountUsd,
          velocityLimit: rules.velocityLimit,
          watchlistSize: rules.baseWatchlist.length + rules.watchlistExtra.length,
          watchlistExtra: rules.watchlistExtra,
        };
      }),
  );
  corridorRows.sort((a, b) => (a.partnerName + a.corridor).localeCompare(b.partnerName + b.corridor));

  return (
    <>
      <Sidebar active="compliance" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Compliance</div>
            <div className="sh-page-sub">
              Flagged + blocked transfers · watchlist · velocity
            </div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Flagged transfers</div>
              <div className="sh-card-sub">
                {flagged.length} {flagged.length === 1 ? 'transfer' : 'transfers'}
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {flagged.length === 0 ? (
              <div className="sh-empty">No flagged transfers.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Recipient</th><th>Amount</th><th>Reasons</th>
                  <th>Created</th><th>Sender</th>
                </tr></thead>
                <tbody>
                  {flagged.map((t) => <TransferRow key={t.id} t={t} />)}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Blocked transfers</div>
              <div className="sh-card-sub">
                {blocked.length} {blocked.length === 1 ? 'transfer' : 'transfers'}
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {blocked.length === 0 ? (
              <div className="sh-empty">No blocked transfers.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Recipient</th><th>Amount</th><th>Reasons</th>
                  <th>Created</th><th>Sender</th>
                </tr></thead>
                <tbody>
                  {blocked.map((t) => <TransferRow key={t.id} t={t} />)}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Watchlist</div>
              <div className="sh-card-sub">
                Recipient names that hard-block a transfer (read-only)
              </div>
            </div>
          </div>
          <div
            style={{
              padding: '16px 20px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            {WATCHLIST.map((name) => (
              <span key={name} className="sh-pill sh-pill-danger">
                <span className="sh-pill-dot"></span>{name}
              </span>
            ))}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Corridor rules</div>
              <div className="sh-card-sub">
                Resolved compliance rules per corridor (read-only). Full rule-creation UI is deferred.
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {corridorRows.length === 0 ? (
              <div className="sh-empty">No corridors configured.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Partner</th><th>Corridor</th><th>Large-amount (USD)</th>
                  <th>Velocity / day</th><th>Watchlist</th>
                </tr></thead>
                <tbody>
                  {corridorRows.map((r) => (
                    <tr key={r.partnerName + r.corridor}>
                      <td>{r.partnerName}</td>
                      <td>{r.corridor}</td>
                      {/* largeAmountUsd is a USD-equivalent threshold, not a source amount — always USD */}
                      <td className="sh-amount">{money(r.largeAmountUsd, 'USD')}</td>
                      <td className="sh-amount">{r.velocityLimit}</td>
                      <td>
                        {r.watchlistSize}
                        {r.watchlistExtra.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                            {r.watchlistExtra.map((name) => (
                              <span key={name} className="sh-pill sh-pill-danger">
                                <span className="sh-pill-dot"></span>{name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Top velocity today</div>
              <div className="sh-card-sub">
                Phones with the most transfers today
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {topVel.length === 0 ? (
              <div className="sh-empty">No activity today yet.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Phone</th><th>Transfers today</th><th></th>
                </tr></thead>
                <tbody>
                  {topVel.map(({ phone, count }) => (
                    <tr key={phone}>
                      <td>{phone}</td>
                      <td className="sh-amount">{count}</td>
                      <td>
                        <a
                          href={`/dashboard/transactions?phone=${encodeURIComponent(phone)}`}
                          className="sh-mini-btn"
                        >
                          View transfers
                        </a>
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
