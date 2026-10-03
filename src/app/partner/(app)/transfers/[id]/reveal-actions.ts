'use server';

import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { getRedis } from '@/lib/redis';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { revealableValue } from '@/lib/partner-customer-view';
import { revealClassOf, revealDecision, revealViewer } from '@/lib/partner-reveal-policy';
import { isRevealableTransferField, type RevealableTransferField } from '@/lib/partner-transfer-ops';
import { isMaskedDestination } from '@/lib/payout-format';
import { takeRevealBudget } from '@/lib/partner-reveal-throttle';
import { isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerId, Transfer } from '@/lib/types';
import type { RevealResult } from '@/components/ds';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const present = (v: string | undefined | null): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined);
const plusPhone = (v: string | undefined | null): string | undefined => (present(v) ? `+${v}` : undefined);

/** The value behind one allowlisted field (a switch: no dynamic property lookup). */
async function fieldValue(partnerId: PartnerId, tr: Transfer, field: RevealableTransferField): Promise<string | undefined> {
  switch (field) {
    case 'full_name': {
      // The sender's legal name lives on THIS tenant's customer row (the same phone at another
      // partner is a different customer).
      const customer = await getCustomerStore(getStore()).getCustomer(partnerId, tr.phone);
      return customer && customer.partnerId === partnerId ? revealableValue(customer, 'full_name') : undefined;
    }
    case 'phone':
      return plusPhone(tr.phone);
    case 'recipient_name':
      return present(tr.recipientName);
    case 'recipient_phone':
      return plusPhone(tr.recipientPhone);
    case 'payout_destination':
      return present(tr.payoutDestination) && !isMaskedDestination(tr.payoutDestination) ? tr.payoutDestination : undefined;
    default:
      return undefined;
  }
}

/**
 * Reveal ONE field of one of THIS tenant's transfers (lost-features restore p1 A4 + B3). Both
 * arguments arrive from the client (MaskedValue binds them) and are UNTRUSTED. The order, as the
 * customer reveal: site host, gate (outside any try), field allowlist and id shape, then the ONE
 * reveal rule (partner-reveal-policy: identity fields for admin and agent with enrolled two-step
 * verification; the payout account also needs canRevealPii), the shared reveal throttle (fails
 * closed), the tenant-scoped read (decrypting only for the payout account), and ONE `pii.reveal`
 * audit row (subject = the transfer id) BEFORE the value is returned. On a transfer, `full_name`
 * and `phone` are the sender's. Every refusal has the not-found shape and writes nothing; any
 * failure returns no value. Never throws past the gate; logs the error name only.
 */
export async function revealTransferFieldAction(id: string, field: RevealableTransferField): Promise<RevealResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);
  const refused: RevealResult = { error: t('partner.common.notFound') };

  if (!isRevealableTransferField(field) || !isTransferId(id)) return refused;
  const cls = revealClassOf(field);
  if (!cls) return refused;
  try {
    const mfaEnrolled = await getStaffMfaStore().isEnrolled(ctx.username);
    if (!revealDecision(revealViewer(ctx, mfaEnrolled), cls).ok) return refused;
    if (!(await takeRevealBudget(getRedis(), ctx.partnerId, ctx.username))) return refused;

    const db = getDb();
    const transfer = await createTransferRepo(db).getOwnedTransfer(ctx.partnerId, id, { decrypt: field === 'payout_destination' });
    if (!transfer || transfer.partnerId !== ctx.partnerId) return refused;
    const value = await fieldValue(ctx.partnerId, transfer, field);
    if (value === undefined) return refused;

    await createAuditRepo(db).record({
      partnerId: ctx.partnerId,
      actor: ctx.username,
      actorType: 'staff',
      action: 'pii.reveal',
      subjectId: transfer.id,
      meta: { field, actorScope: 'partner' },
    });
    return { value };
  } catch (err) {
    logWarn('partner.transfers.reveal', errName(err), { partnerId: ctx.partnerId, field });
    return refused;
  }
}
