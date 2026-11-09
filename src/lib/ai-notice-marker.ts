import { and, eq, max, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import { AI_NOTICE_VERSION, aiNoticeDue, type AiNoticeChannel, type NoticeLang } from './ai-notice';
import { logWarn } from './log';
import type { PartnerId } from './types';

/**
 * ai-notice-marker (R17) — the DURABLE last-notice marker: one audit_events row
 * (action ai.notice_shown) per notice shown, written in the SAME transaction as
 * the reply that carries it, so a rolled-back reply never counts as shown and a
 * committed one always does. It is also the evidence that the notice was shown.
 *
 *  - Keyed per tenant, customer and chat surface (WhatsApp, Telegram, web): the
 *    subject is the keyed auditSubjectId HMAC, never the phone, and the meta
 *    holds the surface, channel, language and version only.
 *  - Read by (subject_id, action) — the audit_subject_action index — plus the
 *    tenant and the surface.
 *  - Fails safe: an unreadable marker means the notice is shown again.
 *  - No migration: audit_events takes free action strings (drizzle 0019), and
 *    the tenant audit view lists only its own allow-list, so partners never see
 *    these rows.
 */

export const AI_NOTICE_ACTION = 'ai.notice_shown';
/** The chat a notice was shown in (the conversation-log channel codes). */
export type NoticeSurface = 'wa' | 'tg' | 'web';

/** When the notice was last shown to this customer on this surface, or null. */
export async function lastAiNoticeAt(db: DbOrTx, partnerId: PartnerId, phone: string, surface: NoticeSurface): Promise<Date | null> {
  const rows = await db
    .select({ at: max(auditEvents.at) })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.subjectId, auditSubjectId(partnerId, phone)),
        eq(auditEvents.action, AI_NOTICE_ACTION),
        eq(auditEvents.partnerId, partnerId),
        sql`${auditEvents.meta} ->> 'surface' = ${surface}`,
      ),
    );
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

/** Whether this reply must carry the notice. Never throws: a read error shows it (fail safe). */
export async function aiNoticeDueFor(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
  surface: NoticeSurface,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    return aiNoticeDue(await lastAiNoticeAt(db, partnerId, phone, surface), now);
  } catch (err) {
    logWarn('ai.notice', 'last-notice marker unreadable: the notice is shown', { error: err instanceof Error ? err.name : 'error' });
    return true;
  }
}

/** Record one shown notice, in the caller's transaction (the one that sends the reply). */
export async function recordAiNotice(
  tx: DbOrTx,
  input: { partnerId: PartnerId; phone: string; surface: NoticeSurface; channel: AiNoticeChannel; lang: NoticeLang },
): Promise<void> {
  await createAuditRepo(tx).record({
    partnerId: input.partnerId,
    actor: 'bot',
    actorType: 'system',
    action: AI_NOTICE_ACTION,
    subjectId: auditSubjectId(input.partnerId, input.phone),
    meta: { surface: input.surface, channel: input.channel, lang: input.lang, version: AI_NOTICE_VERSION },
  });
}
