export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { topVelocityToday } from '@/lib/dashboard';
import { WATCHLIST } from '@/lib/compliance';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { MaskedDestination } from '../masked-destination';
import {
  releaseTransferAction,
  rejectTransferAction,
} from '../actions';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import type { Transfer } from '@/lib/types';

const REVIEW_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Reasons' },
  { label: 'Created' },
  { label: 'Sender' },
  { label: 'Actions' },
];

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Reasons' },
  { label: 'Created' },
  { label: 'Sender' },
];

const CORRIDOR_COLUMNS: ExpandableColumn[] = [
  { label: 'Partner', primary: true },
  { label: 'Corridor', primary: true },
  { label: 'Large-amount (USD)' },
  { label: 'Velocity / day' },
  { label: 'Watchlist' },
];

const VELOCITY_COLUMNS: ExpandableColumn[] = [
  { label: 'Phone', primary: true },
  { label: 'Transfers today', primary: true },
  { label: '' },
];

// "Recipient gets" is denominated in the transfer's DESTINATION currency
// (amountInr holds the destination amount post-multi-currency). Fall back to
// INR for legacy rows written before destinationCurrency existed.
function recipientGets(t: Transfer): string {
  return money(t.amountInr, t.destinationCurrency ?? 'INR');
}

function transferCells(t: Transfer) {
  return [
    <div key="recipient">
      <div className="sh-recipient">{t.recipientName}</div>
      <MaskedDestination
        transferId={t.id}
        payoutMethod={t.payoutMethod}
        payoutDestination={t.payoutDestination}
      />
    </div>,
    <div key="amount">
      <div className="sh-amount">{money(t.amountSource, t.sourceCurrency)}</div>
      {t.sourceCurrency !== 'USD' && (
        <div className="sh-recipient-sub">≈ {money(t.amountUsd, 'USD')}</div>
      )}
      <div className="sh-recipient-sub">{recipientGets(t)}</div>
    </div>,
    <span key="reasons">
      {t.complianceReasons.length === 0 ? '—' : t.complianceReasons.map((r) =>
        r === 'edd_required'
          ? <span key={r} className="sh-pill sh-pill-warning"><span className="sh-pill-dot"></span>EDD required</span>
          : <span key={r} style={{ marginRight: 6 }}>{r}</span>,
      )}
    </span>,
    new Date(t.createdAt).toLocaleString(),
    <span key="sender" className="sh-recipient-sub">{t.phone}</span>,
  ];
}

export default async function CompliancePage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const transfers = await scoped.listTransfers();
  const inReview = transfers.filter((t) => t.status === 'in_review');
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
              <div className="sh-card-title">Needs review</div>
              <div className="sh-card-sub">
                {inReview.length} {inReview.length === 1 ? 'transfer' : 'transfers'} — payment captured, pending staff decision
              </div>
            </div>
          </div>
          <ExpandableTable
            columns={REVIEW_COLUMNS}
            empty={<>No transfers awaiting review.</>}
            rows={inReview.map((t) => ({
              key: t.id,
              label: t.recipientName,
              cells: [
                ...transferCells(t),
                <div key="actions" className="sh-attention-actions">
                  <form action={releaseTransferAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <button type="submit" className="sh-mini-btn">Release</button>
                  </form>
                  <form action={rejectTransferAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Reject</button>
                  </form>
                </div>,
              ],
            }))}
          />
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Flagged transfers</div>
              <div className="sh-card-sub">
                {flagged.length} {flagged.length === 1 ? 'transfer' : 'transfers'}
              </div>
            </div>
          </div>
          <ExpandableTable
            columns={TRANSFER_COLUMNS}
            empty={<>No flagged transfers.</>}
            rows={flagged.map((t) => ({
              key: t.id,
              label: t.recipientName,
              cells: transferCells(t),
            }))}
          />
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
          <ExpandableTable
            columns={TRANSFER_COLUMNS}
            empty={<>No blocked transfers.</>}
            rows={blocked.map((t) => ({
              key: t.id,
              label: t.recipientName,
              cells: transferCells(t),
            }))}
          />
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
          <ExpandableTable
            columns={CORRIDOR_COLUMNS}
            empty={<>No corridors configured.</>}
            rows={corridorRows.map((r) => ({
              key: r.partnerName + r.corridor,
              label: `${r.partnerName} ${r.corridor}`,
              cells: [
                r.partnerName,
                r.corridor,
                // largeAmountUsd is a USD-equivalent threshold, not a source amount — always USD
                <span key="large" className="sh-amount">{money(r.largeAmountUsd, 'USD')}</span>,
                <span key="velocity" className="sh-amount">{r.velocityLimit}</span>,
                <span key="watchlist">
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
                </span>,
              ],
            }))}
          />
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
          <ExpandableTable
            columns={VELOCITY_COLUMNS}
            empty={<>No activity today yet.</>}
            rows={topVel.map(({ phone, count }) => ({
              key: phone,
              label: phone,
              cells: [
                phone,
                <span key="count" className="sh-amount">{count}</span>,
                <a
                  key="link"
                  href={`/admin-dashboard/transactions?phone=${encodeURIComponent(phone)}`}
                  className="sh-mini-btn"
                >
                  View transfers
                </a>,
              ],
            }))}
          />
        </section>
      </main>
    </>
  );
}
