import { Badge } from '@/components/ds';
import { t, type MessageKey } from '@/lib/i18n';
import { maskPhoneLast4 } from '@/lib/mask';
import type { PortalB2bParties } from '@/lib/portal-transfers';
import type { EntityType } from '@/lib/types';

// Business (B2B) pieces shared by the transfer detail and the printable receipt (lost-features p4
// B1). Everything here renders from getPortalB2bParties' names and enums: never the destination.

const ENTITY: Record<EntityType, MessageKey> = { business: 'portal.b2b.business', individual: 'portal.b2b.individual' };
const FUNDING: Record<PortalB2bParties['funding'], MessageKey> = {
  business_account: 'portal.b2b.fundingBusinessAccount',
  card_or_bank: 'portal.b2b.fundingCardOrBank',
};

export function EntityBadge({ entity }: { entity: EntityType }) {
  return <Badge className="ml-2 align-middle print:border-0 print:px-0">{t(ENTITY[entity])}</Badge>;
}

export const fundingLabel = (p: PortalB2bParties): string => t(FUNDING[p.funding]);

/** "From": the sender business name, else the customer's own phone, masked like the rest of the portal. */
export const fromLabel = (p: PortalB2bParties, phone: string): string => p.senderBusinessName ?? maskPhoneLast4(phone);
