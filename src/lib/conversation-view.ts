import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createConversationLogRepo, type ConversationEntry } from '@/db/repos/conversation-log-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import type { Customer, Staff } from '@/lib/types';

// conversation-view (Partner-Demo R3b) — the audited staff read behind the
// customer page's Conversation panel.
//
//  • WHO: admins only (platform admin, or a partner admin of the customer's
//    own tenant). Agents and support get null — the brief's B1 default. The
//    page's createScopedStore already pins partner staff to their tenant; the
//    tenant check here is defence in depth.
//  • WHAT: the customer's (tenant, phone) thread from the sealed log, both
//    channels, newest `limit` messages.
//  • AUDIT: when any message is shown, ONE `conversation.view` row is written
//    BEFORE returning (subject = the keyed auditSubjectId of the RESOLVED row;
//    meta = counts and channels only, never text). Awaited and not caught: if
//    the audit write fails this throws, so no text reaches the page without a
//    record. An empty thread writes nothing (nothing was revealed).

export const CONVERSATION_PANEL_LIMIT = 50;

export async function viewConversation(
  db: DbOrTx,
  staff: Pick<Staff, 'username' | 'role' | 'partnerId'>,
  customer: Pick<Customer, 'partnerId' | 'senderPhone'>,
  opts: { limit?: number } = {},
): Promise<ConversationEntry[] | null> {
  if (staff.role !== 'admin') return null;
  if (staff.partnerId !== undefined && staff.partnerId !== customer.partnerId) return null;
  const entries = await createConversationLogRepo(db).listThread(customer.partnerId, customer.senderPhone, {
    limit: opts.limit ?? CONVERSATION_PANEL_LIMIT,
  });
  if (entries.length === 0) return entries;
  const channels = new Set(entries.map((e) => e.channel));
  const channel = channels.size > 1 ? 'wa+web' : [...channels][0];
  await createAuditRepo(db).record({
    partnerId: customer.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'conversation.view',
    subjectId: auditSubjectId(customer.partnerId, customer.senderPhone),
    meta: { count: entries.length, channel, unreadable: entries.filter((e) => e.unreadable).length },
  });
  return entries;
}
