export const dynamic = 'force-dynamic';

import { requireAdmin } from '@/lib/auth';
import { Sidebar } from '../../sidebar';
import { createPartnerAction } from '../actions';
import type { CountryCode } from '@/lib/types';

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

export default async function NewPartnerPage() {
  await requireAdmin();

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">New partner</div>
            <div className="sh-page-sub">Create a multi-tenant partner record</div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Partner details</div>
              <div className="sh-card-sub">Name and operating countries are required</div>
            </div>
          </div>
          <form action={createPartnerAction} className="sh-acct-form">
            <input
              className="sh-input"
              name="name"
              placeholder="Partner name (required)"
              required
            />
            <fieldset className="sh-fieldset">
              <legend>Operating countries</legend>
              <div className="sh-perm-row">
                {ALL_COUNTRIES.map((c) => (
                  <label className="sh-perm" key={c}>
                    <input type="checkbox" name="countries" value={c} /> {c}
                  </label>
                ))}
              </div>
            </fieldset>
            <input
              className="sh-input"
              name="brandName"
              placeholder="Brand name (internal, optional)"
            />
            <input
              className="sh-input"
              name="displayName"
              placeholder="Display name — the brand customers see (optional)"
            />
            <input
              className="sh-input"
              name="primaryColor"
              type="color"
              defaultValue="#1a73e8"
            />
            <input
              className="sh-input"
              name="logoUrl"
              placeholder="Logo URL (optional)"
            />
            <input
              className="sh-input"
              name="adminNote"
              placeholder="Admin note (optional)"
            />
            <button type="submit" className="sh-btn-primary">Create partner</button>
          </form>
        </section>
      </main>
    </>
  );
}
