export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SMARTREMIT_ICONS } from '../brand-icons';
import { getDb } from '@/db/client';
import { createReferralRepo } from '@/db/repos/referral-repo';
import { parsePlumPortalUrl } from '@/lib/referrals';

// /referral-rewards (Batch B4): the stable SmartRemit address a referral partner is given for
// redeeming commission. It links to the rewards portal (Xoxoday Plum) that a platform admin sets on
// /admin-dashboard/referrals. While that address is empty the page does not exist (404). The stored
// value is re-checked (https only) before it is rendered as a link.

export const metadata: Metadata = {
  title: 'Referral rewards — SmartRemit',
  description: 'Redeem your SmartRemit referral rewards.',
  icons: SMARTREMIT_ICONS,
  robots: { index: false, follow: false },
};

export default async function ReferralRewardsPage() {
  const stored = await createReferralRepo(getDb()).getPlumPortalUrl();
  const checked = parsePlumPortalUrl(stored ?? '');
  if (!checked.ok || !checked.url) notFound();
  return (
    <div className="min-h-screen overflow-x-clip bg-background font-sans text-foreground antialiased">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            SmartRemit
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Referral rewards</h1>
        <p className="mt-3 text-muted-foreground">
          Thank you for referring people to SmartRemit. Your rewards are loaded each month and you can redeem them in the rewards
          portal.
        </p>
        <a
          href={checked.url}
          rel="noopener noreferrer"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="referral-rewards-link"
        >
          Open referral rewards
        </a>
      </main>
    </div>
  );
}
