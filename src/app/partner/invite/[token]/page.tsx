import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { getAuthStore } from '@/lib/auth-store';
import { isIpRateLimited } from '@/lib/ip-rate-limit';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getPartnerStore } from '@/lib/partner-store';
import { inviteRedeemable } from '@/lib/staff-invite-accept';
import { getStaffInviteStore } from '@/lib/staff-invite-store';
import { seedAdminUsername } from '@/lib/staff-login-guard';
import { Card } from '@/components/ds';
import BrandLogo from '@/app/landing/BrandLogo';
import { AcceptForm } from './accept-form';
import { INVITE_PAGE_IP_LIMIT, INVITE_PAGE_SCOPE } from './accept-result';
import { DeadInvite } from './dead-invite';

export const dynamic = 'force-dynamic';

// /partner/invite/<token> (UI redesign M3-9): the public page an invited teammate opens from the
// email. It only PEEKS (never consumes), so a mail scanner's prefetch cannot burn the link; the POST
// action consumes. The URL is a capability: never indexed, and the page sends no Referer anywhere
// (metadata.referrer renders <meta name="referrer" content="no-referrer">,
// next/dist/lib/metadata/types/metadata-interface.d.ts:143-151). Every failure renders the ONE dead
// sheet, byte-identical (no oracle). It sits outside the (app) group: there is no session yet.
export const metadata: Metadata = {
  title: t('partner.invite.metaTitle'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const ROOT =
  'flex min-h-dvh items-center justify-center bg-ds-ground px-4 py-10 font-sans leading-[1.6] text-ds-ink antialiased ' +
  '[&_:focus-visible]:rounded-ds-focus [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-[3px] [&_:focus-visible]:outline-ds-focus-ring';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main id="main" className={ROOT}>
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <BrandLogo height={40} eager className="h-9 sm:h-10" />
        <Card className="w-full">{children}</Card>
      </div>
    </main>
  );
}

interface InviteView {
  partnerName: string;
  username: string;
  role: string;
}

/** The invite, if it can still be accepted; null for EVERY other outcome (errors included). */
async function loadInvite(token: string): Promise<InviteView | null> {
  try {
    const inv = await getStaffInviteStore().peek(token);
    if (!inv) return null;
    const ok = await inviteRedeemable(inv, {
      getPartner: (id) => getPartnerStore().getPartner(id),
      getStaff: (u) => getAuthStore().getStaff(u),
      seedName: seedAdminUsername(),
    });
    if (!ok) return null;
    const partner = await getPartnerStore().getPartner(inv.partnerId);
    if (!partner) return null;
    return { partnerName: partner.displayName ?? partner.name, username: inv.username, role: inv.role };
  } catch (err) {
    // Never the token; the class name only.
    logWarn('partner.invite.page', err instanceof Error ? err.name : 'error');
    return null;
  }
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Fail-open per-IP guard BEFORE any read. Over budget ⇒ the same dead sheet.
  if (await isIpRateLimited(await headers(), INVITE_PAGE_SCOPE, INVITE_PAGE_IP_LIMIT)) {
    return (
      <Shell>
        <DeadInvite />
      </Shell>
    );
  }
  const view = await loadInvite(token);
  if (!view) {
    return (
      <Shell>
        <DeadInvite />
      </Shell>
    );
  }
  return (
    <Shell>
      <AcceptForm
        token={token}
        username={view.username}
        title={t('partner.invite.title', { partner: view.partnerName })}
        roleLabel={t(`partner.staff.role.${view.role as 'admin' | 'agent' | 'support' | 'finance'}`)}
      />
    </Shell>
  );
}
