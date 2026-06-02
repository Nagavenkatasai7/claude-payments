export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/auth';
import { getPartnerStore } from '@/lib/partner-store';
import { Sidebar } from '../../sidebar';
import { Icon } from '../../icons';
import { createStaffAction } from '../actions';

export default async function NewTeammatePage() {
  await requirePlatformAdmin();
  const partners = await getPartnerStore().listPartners();

  return (
    <>
      <Sidebar active="team" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Add teammate</div>
            <div className="sh-page-sub">
              <Link href="/admin-dashboard/team" className="sh-scope-chip">
                <Icon name="chevron-right" /> Back to Team
              </Link>
            </div>
          </div>
        </div>

        <section className="sh-card" style={{ maxWidth: 640 }}>
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">New teammate</div>
              <div className="sh-card-sub">
                They sign in immediately with the username and password you set here
              </div>
            </div>
          </div>
          <form action={createStaffAction} className="sh-acct-form">
            <div className="sh-field-grid">
              <div className="sh-field">
                <label className="sh-field-label" htmlFor="t-name">Full name</label>
                <input id="t-name" name="name" required className="sh-input" placeholder="Jordan Rivera" />
              </div>
              <div className="sh-field">
                <label className="sh-field-label" htmlFor="t-username">Username</label>
                <input id="t-username" name="username" required className="sh-input" placeholder="jordan" autoComplete="off" />
              </div>
            </div>

            <div className="sh-field-grid">
              <div className="sh-field">
                <label className="sh-field-label" htmlFor="t-password">Temporary password</label>
                <input id="t-password" name="password" type="password" required minLength={8} className="sh-input" placeholder="At least 8 characters" autoComplete="new-password" />
              </div>
              <div className="sh-field">
                <label className="sh-field-label" htmlFor="t-role">Role</label>
                <select id="t-role" name="role" className="sh-select" defaultValue="agent">
                  <option value="agent">Agent — scoped permissions</option>
                  <option value="admin">Admin — full access</option>
                </select>
              </div>
            </div>

            <div className="sh-field">
              <label className="sh-field-label" htmlFor="t-scope">Scope</label>
              <select id="t-scope" name="partnerId" className="sh-select" defaultValue="">
                <option value="">Platform — sees all partners</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — partner-scoped
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="sh-fieldset">
              <legend>Agent permissions</legend>
              <div className="sh-perm-row" style={{ padding: 0 }}>
                <label className="sh-perm"><input type="checkbox" name="canCancel" /> Cancel / refund</label>
                <label className="sh-perm"><input type="checkbox" name="canResend" /> Resend link</label>
                <label className="sh-perm"><input type="checkbox" name="canAssign" /> Assign</label>
              </div>
              <p className="sh-recipient-sub" style={{ marginTop: 8 }}>
                Admins always have every permission; these apply to agents.
              </p>
            </fieldset>

            <button type="submit" className="sh-btn-primary">
              <Icon name="plus" /> Create teammate
            </button>
          </form>
        </section>
      </main>
    </>
  );
}
