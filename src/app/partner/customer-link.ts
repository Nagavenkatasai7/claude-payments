import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { sealCustomerRef } from '@/lib/customer-ref';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import type { PartnerId } from '@/lib/types';
import { PARTNER_ROUTES, routeAllows } from './routes';

// customer-link (lost-features restore, review 2.1): the ONE "Open customer" link on /partner (the
// transfer list and detail, the ticket page). SERVER-ONLY: it seals refs with FIELD_ENCRYPTION_KEY,
// so a client component receives the finished href, never this module.
//   - A link only for roles that may open the customer page (routeAllows('customers'): admin, agent).
//   - Only when the customer exists in the SESSION tenant (one key-column read, nothing decrypted).
//   - The href holds a sealed ref (customer-ref.ts), never a phone.
// Render every such link with prefetch={false}: the customer page writes a `pii.view` row on render,
// so a prefetch would record a view nobody made.

type LinkCtx = Pick<PartnerCtx, 'partnerId' | 'role'>;

export interface CustomerLinkDeps {
  /** Which of the phones are customers of this tenant. Default: the customer repo's existingPhones. */
  existing?: (partnerId: PartnerId, phones: readonly string[]) => Promise<ReadonlySet<string>>;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const defaultExisting = (partnerId: PartnerId, phones: readonly string[]) =>
  getCustomerStore(getStore()).existingPhones(partnerId, phones);

/** The customer page path for (tenant, phone). No checks: callers use the two helpers below. */
export function partnerCustomerPath(partnerId: PartnerId, phone: string): string {
  return `${PARTNER_ROUTES.customers.href}/${sealCustomerRef(partnerId, phone)}`;
}

/** The link for one customer, or null (no access, no such customer here, or a failed read). */
export async function partnerCustomerHref(
  ctx: LinkCtx,
  phone: string | null | undefined,
  deps: CustomerLinkDeps = {},
): Promise<string | null> {
  if (!phone) return null;
  return (await partnerCustomerHrefs(ctx, [phone], deps)).get(phone) ?? null;
}

/**
 * The links for a page of rows, keyed by phone (absent = no link). One read for the whole page, or
 * none when the caller passes `known`: the phones its own tenant-scoped read already found.
 */
export async function partnerCustomerHrefs(
  ctx: LinkCtx,
  phones: Iterable<string>,
  opts: CustomerLinkDeps & { known?: ReadonlySet<string> } = {},
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (!routeAllows('customers', ctx.role)) return out;
  const wanted = [...new Set([...phones].filter((p) => typeof p === 'string' && p.length > 0))];
  if (wanted.length === 0) return out;
  let found: ReadonlySet<string>;
  try {
    found = opts.known ?? (await (opts.existing ?? defaultExisting)(ctx.partnerId, wanted));
  } catch (err) {
    logWarn('partner.customer_link', errName(err), { partnerId: ctx.partnerId });
    return out;
  }
  for (const phone of wanted) if (found.has(phone)) out.set(phone, partnerCustomerPath(ctx.partnerId, phone));
  return out;
}
