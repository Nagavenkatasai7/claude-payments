export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { Sidebar } from '../../sidebar';
import { createCustomerAction } from '../actions';
import type { CountryCode } from '@/lib/types';

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

export default async function NewCustomerPage() {
  const { staff } = await requireScope();
  const isPlatform = !staff.partnerId;
  // Platform admins choose which partner the customer belongs to; partner-admins
  // are pinned to their own partner by the server action.
  const partners = isPlatform ? await createScopedStore(staff).listPartners() : [];

  return (
    <>
      <Sidebar active="customers" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">New customer</div>
            <div className="sh-page-sub">Manually create a client record</div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Customer details</div>
              <div className="sh-card-sub">Phone is required and must be unique</div>
            </div>
          </div>
          <form action={createCustomerAction} className="sh-form">
            <label className="sh-field">
              <span className="sh-field-label">Phone — with country code, 10–15 digits</span>
              <input
                className="sh-input"
                name="phone"
                inputMode="tel"
                autoComplete="off"
                placeholder="15551234567"
                required
              />
            </label>

            <label className="sh-field">
              <span className="sh-field-label">Full name (optional)</span>
              <input className="sh-input" name="fullName" placeholder="Asha Rao" />
            </label>

            <label className="sh-field">
              <span className="sh-field-label">Sender country</span>
              <select className="sh-input" name="senderCountry" defaultValue="US">
                {ALL_COUNTRIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>

            {isPlatform && (
              <label className="sh-field">
                <span className="sh-field-label">Partner</span>
                <select className="sh-input" name="partnerId" defaultValue="default">
                  <option value="default">Default</option>
                  {partners
                    .filter((p) => p.id !== 'default')
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              </label>
            )}

            <label className="sh-field">
              <span className="sh-field-label">KYC status</span>
              <select className="sh-input" name="kycStatus" defaultValue="not_started">
                <option value="not_started">Not started</option>
                <option value="verified">Verified</option>
                <option value="grandfathered">Grandfathered</option>
              </select>
            </label>

            <button type="submit" className="sh-btn-primary">Create customer</button>
          </form>
        </section>
      </main>
    </>
  );
}
