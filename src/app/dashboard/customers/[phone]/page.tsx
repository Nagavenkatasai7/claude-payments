export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { evaluateCap } from '@/lib/tier-rules';
import { Sidebar } from '../../sidebar';
import { markCustomerVerifiedAction, markCustomerRejectedAction } from '../actions';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ phone: string }>;
}) {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';
  const { phone } = await params;

  const store = getStore();
  const customerStore = getCustomerStore(store);
  const dailyVolumeStore = getDailyVolumeStore();
  const customer = await customerStore.getCustomer(phone);
  if (!customer) notFound();

  const [transfers, todayUsedCents] = await Promise.all([
    store.listTransfers(),
    dailyVolumeStore.getTodayCents(phone),
  ]);
  const mine = transfers
    .filter((t) => t.phone === phone)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const now = new Date();
  const capEval = evaluateCap(customer, now, todayUsedCents, 0);

  return (
    <>
      <Sidebar active="customers" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">+{customer.senderPhone}</div>
            <div className="sh-page-sub">
              Customer · joined {new Date(customer.firstSeenAt).toLocaleDateString()}
            </div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Identity &amp; KYC</div>
              <div className="sh-card-sub">Verification status and customer-supplied details</div>
            </div>
          </div>
          <div className="sh-card-body">
            <dl className="sh-dl">
              <dt>Status</dt><dd>{customer.kycStatus}</dd>
              <dt>Verified at</dt><dd>{customer.kycVerifiedAt ?? '—'}</dd>
              <dt>Country</dt><dd>{customer.senderCountry}</dd>
              <dt>Provider ref</dt><dd>{customer.kycProviderRef ?? '—'}</dd>
              <dt>Full name</dt><dd>{customer.fullName ?? '—'}</dd>
              <dt>DOB</dt><dd>{customer.dateOfBirth ?? '—'}</dd>
              {customer.kycRejectedReason && (
                <>
                  <dt>Rejected reason</dt>
                  <dd>{customer.kycRejectedReason}</dd>
                </>
              )}
            </dl>
            {isAdmin && customer.kycStatus !== 'verified' && customer.kycStatus !== 'grandfathered' && (
              <form action={markCustomerVerifiedAction} className="sh-inline-form">
                <input type="hidden" name="phone" value={customer.senderPhone} />
                <button type="submit" className="sh-btn-primary">Mark KYC verified</button>
              </form>
            )}
            {isAdmin && customer.kycStatus !== 'rejected' && (
              <form action={markCustomerRejectedAction} className="sh-inline-form">
                <input type="hidden" name="phone" value={customer.senderPhone} />
                <input type="text" name="reason" placeholder="Rejection reason (optional)" className="sh-input" />
                <button type="submit" className="sh-btn-secondary">Mark KYC rejected</button>
              </form>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Sending today</div>
              <div className="sh-card-sub">Tier and daily cap usage</div>
            </div>
          </div>
          <div className="sh-card-body">
            <dl className="sh-dl">
              <dt>Tier</dt><dd>{capEval.tier}</dd>
              <dt>Daily cap</dt><dd>${(capEval.dailyCapCents / 100).toFixed(2)}</dd>
              <dt>Today used</dt><dd>${(capEval.todayUsedCents / 100).toFixed(2)}</dd>
              <dt>Today remaining</dt><dd>${(capEval.todayRemainingCents / 100).toFixed(2)}</dd>
              {capEval.dayOfWindow && (
                <>
                  <dt>Day of window</dt>
                  <dd>{capEval.dayOfWindow}/3</dd>
                </>
              )}
            </dl>
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recent transfers</div>
              <div className="sh-card-sub">
                {mine.length} {mine.length === 1 ? 'transfer' : 'transfers'} on file
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {mine.length === 0 && (
                  <tr>
                    <td colSpan={4} className="sh-empty">No transfers yet.</td>
                  </tr>
                )}
                {mine.slice(0, 50).map((t) => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td>
                      <div className="sh-amount">${t.amountUsd.toFixed(2)}</div>
                    </td>
                    <td>{t.status}</td>
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
