'use server';

import { redirect } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { parseTransferFilters, transfersListHref } from '@/lib/partner-transfers';
import { parseTransferQuery, sealTransferSearch } from '@/lib/partner-transfer-search';
import { PARTNER_ROUTES } from '../../routes';

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : undefined;
};

/**
 * The transfer list's search form (lost-features restore p1 B1). It only REDIRECTS: the typed text
 * never enters a URL in clear.
 *  - admin and agent: a name, a phone or a last-4 is classified (parseTransferQuery) and sealed for
 *    this tenant and user (`s`, 30 minutes);
 *  - finance (review 2.7: never an identity search): a transfer id only, as the plain `q` the page
 *    has always taken; anything else is refused with `bad=1`.
 * The other filters (status, mode, dates, mine) are closed sets, re-parsed here.
 */
export async function searchTransfersAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.transfers.policy);
  const f = parseTransferFilters({
    status: field(formData, 'status'),
    environment: field(formData, 'environment'),
    from: field(formData, 'from'),
    to: field(formData, 'to'),
    mine: field(formData, 'mine'),
  });
  const raw = (field(formData, 'q') ?? '').trim();
  const base = { status: f.status, environment: f.environment, from: f.from, to: f.to, mine: PARTNER_OPS.roles.includes(ctx.role) ? f.mine : undefined };
  if (raw === '') redirect(transfersListHref(base));

  if (!PARTNER_OPS.roles.includes(ctx.role)) {
    const id = parseTransferFilters({ q: raw }).q;
    if (!id || id !== raw) redirect(withBad(transfersListHref(base)));
    redirect(withQ(transfersListHref(base), id));
  }
  const q = parseTransferQuery(raw);
  if (!q) redirect(withBad(transfersListHref(base)));
  redirect(transfersListHref({ ...base, s: sealTransferSearch(ctx.partnerId, ctx.username, q, Date.now()) }));
}

const withParam = (href: string, k: string, v: string) => `${href}${href.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`;
const withBad = (href: string) => withParam(href, 'bad', '1');
const withQ = (href: string, id: string) => withParam(href, 'q', id);
