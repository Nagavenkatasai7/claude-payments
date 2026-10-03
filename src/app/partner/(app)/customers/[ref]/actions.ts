'use server';

import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { revealClassOf, revealDecision, revealViewer } from '@/lib/partner-reveal-policy';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { getRedis } from '@/lib/redis';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { auditSubjectId, openCustomerRef } from '@/lib/customer-ref';
import { isRevealableField, revealableValue, type RevealableField } from '@/lib/partner-customer-view';
import { takeRevealBudget } from '@/lib/partner-reveal-throttle';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { RevealResult } from '@/components/ds';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Reveal ONE identity field of one of THIS tenant's customers (UI redesign M3-11). The only path
 * from /partner to a decrypted customer value. Both arguments arrive from the client (MaskedValue
 * binds them) and are UNTRUSTED: the ref is re-opened and re-scoped to the SESSION tenant, the field
 * is checked against the allowlist. The order: site host, gate (outside any try), field allowlist,
 * the one reveal rule (partner-reveal-policy: every field here is `identity`, so admin and agent
 * with enrolled two-step verification, no canRevealPii; lost-features p2 B5), rate limit (fails
 * closed), tenant lookup, then ONE
 * `pii.reveal` audit row BEFORE the value is returned. Every refusal returns the same shape as a
 * missing customer and writes nothing; any failure returns no value. Never throws past the gate
 * (mirrors revealDestinationAction), and never logs a value or a phone (the error name only).
 */
export async function revealCustomerFieldAction(ref: string, field: RevealableField): Promise<RevealResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);
  const refused: RevealResult = { error: t('partner.customers.notFound') };

  if (!isRevealableField(field) || typeof ref !== 'string') return refused;
  const cls = revealClassOf(field);
  if (cls === null) return refused;
  try {
    const viewer = revealViewer(ctx, await getStaffMfaStore().isEnrolled(ctx.username));
    if (!revealDecision(viewer, cls).ok) return refused;
    if (!(await takeRevealBudget(getRedis(), ctx.partnerId, ctx.username))) return refused;

    const opened = openCustomerRef(ref);
    if (!opened || opened.partnerId !== ctx.partnerId) return refused;
    // The SESSION tenant in the WHERE, never the ref's: the same phone at another partner is a
    // different customer.
    const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
    if (!customer || customer.partnerId !== ctx.partnerId) return refused;
    const value = revealableValue(customer, field);
    if (value === undefined) return refused;

    await createAuditRepo(getDb()).record({
      partnerId: ctx.partnerId,
      actor: ctx.username,
      actorType: 'staff',
      action: 'pii.reveal',
      subjectId: auditSubjectId(ctx.partnerId, customer.senderPhone),
      meta: { field, actorScope: 'partner' },
    });
    return { value };
  } catch (err) {
    logWarn('partner.customers.reveal', errName(err), { partnerId: ctx.partnerId, field });
    return refused;
  }
}
