export const dynamic = 'force-dynamic';

import { requireAdmin } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { Sidebar } from '../../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createCustomerAction } from '../actions';
import type { CountryCode } from '@/lib/types';

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-card px-3 text-sm';

export default async function NewCustomerPage() {
  // Admins only — mirrors the action's gate and the conditionally-rendered CTA
  // (requireAdmin redirects non-admins to the dashboard root).
  const staff = await requireAdmin();
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

        <Card className="mb-6 max-w-[640px]">
          <CardHeader>
            <CardTitle>Customer details</CardTitle>
            <CardDescription>Phone is required and must be unique</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createCustomerAction} className="space-y-4">
              <label className="block space-y-1.5">
                <span className="block text-sm font-medium">Phone — with country code, 10–15 digits</span>
                <Input
                  name="phone"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="15551234567"
                  required
                />
              </label>

              <label className="block space-y-1.5">
                <span className="block text-sm font-medium">Full name (optional)</span>
                <Input name="fullName" placeholder="Asha Rao" />
              </label>

              <label className="block space-y-1.5">
                <span className="block text-sm font-medium">Sender country</span>
                <select className={SELECT_CLASS} name="senderCountry" defaultValue="US">
                  {ALL_COUNTRIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>

              {isPlatform && (
                <label className="block space-y-1.5">
                  <span className="block text-sm font-medium">Partner</span>
                  <select className={SELECT_CLASS} name="partnerId" defaultValue="default">
                    <option value="default">Default</option>
                    {partners
                      .filter((p) => p.id !== 'default')
                      .map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                  </select>
                </label>
              )}

              <label className="block space-y-1.5">
                <span className="block text-sm font-medium">KYC status</span>
                <select className={SELECT_CLASS} name="kycStatus" defaultValue="not_started">
                  <option value="not_started">Not started</option>
                  <option value="verified">Verified</option>
                  <option value="grandfathered">Grandfathered</option>
                </select>
              </label>

              <Button type="submit">Create customer</Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
