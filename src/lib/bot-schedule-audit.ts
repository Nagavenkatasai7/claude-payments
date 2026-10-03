import type { AuditEvent } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import { normalizePhone } from './phone';
import type { PartnerId } from './types';

// Bot schedule audit (2026-10-03 "bot chats mixing" thread). The portal has
// always written schedule.create / schedule.cancel rows (portal-schedules.ts
// recordScheduleAudit); a schedule made or cancelled in chat wrote none, so
// "who set this schedule up, when, and through which channel" could not be
// answered from the audit log. Same row shape as the portal's: subject = the
// keyed customer id (never the phone), meta = ids + channel only.

export const BOT_SCHEDULE_ACTOR = 'system:chat-bot';

export type BotScheduleAuditAction = 'schedule.create' | 'schedule.cancel';

export function botScheduleAuditEvent(e: {
  partnerId: PartnerId;
  phone: string;
  action: BotScheduleAuditAction;
  scheduleId: string;
  channel: 'whatsapp' | 'web';
}): AuditEvent {
  return {
    partnerId: e.partnerId,
    actor: BOT_SCHEDULE_ACTOR,
    actorType: 'system',
    action: e.action,
    subjectId: auditSubjectId(e.partnerId, normalizePhone(e.phone)),
    meta: { scheduleId: e.scheduleId, via: e.channel },
  };
}
