import type { MessageKey } from '@/lib/i18n';

// TGFL custom host (design §5.1): the portal home's "Ways to send" list. Pure: the page reads the
// switches and passes them in. Honest per tenant, per switch and per customer:
// - WhatsApp and Telegram open SmartRemit's OWN bot, so they show only on the 'default' tenant
//   (inbound routing is by phone_number_id; the telegram.bot switch is read for 'default' only).
// - Telegram also needs the bot configured and the switch on, and always says "By invitation".
// - While the tenant's agent.paused kill switch is on, the bot answers only the fixed reply
//   (hold-replies.ts agent_paused), so WhatsApp and Telegram are not ways to send: both hide.
//   The read fails open like the bot's own read (isFlagOn), so the card and the bot agree.
// - The AI apps show only while the tenant's agent.tools switch is on. They link to their section
//   of /portal/ai-apps while that page is visible to this customer, else they are names only.

export type WayId = 'whatsapp' | 'telegram' | 'claude' | 'chatgpt' | 'perplexity';
export type WayBadge = 'available' | 'byInvitation' | 'earlyAccess';

export interface WayToSend {
  id: WayId;
  nameKey: MessageKey;
  noteKey: MessageKey;
  badge: WayBadge;
  href: string | null;
  external: boolean;
}

export interface WaysInput {
  /** The host tenant is DEFAULT_PARTNER_ID (SmartRemit's own bots answer it). */
  sharedBot: boolean;
  /** isFlagOn(db, 'agent.paused', { partnerId: site.partnerId }): the tenant's AI agent is paused. */
  agentPaused: boolean;
  /** waLink(WA_MESSAGES.generic) */
  whatsappHref: string;
  /** telegramConfigured() && the telegram.bot switch */
  telegramOn: boolean;
  /** TELEGRAM_BOT_HREF */
  telegramHref: string;
  /** agentToolsOn(db, site.partnerId) */
  aiSwitchOn: boolean;
  /** agentPortal().visible(partnerId, phone) */
  aiAppsOn: boolean;
}

const AI_APPS = [
  { id: 'claude', nameKey: 'portal.home.ways.claude' },
  { id: 'chatgpt', nameKey: 'portal.home.ways.chatgpt' },
  { id: 'perplexity', nameKey: 'portal.home.ways.perplexity' },
] as const satisfies readonly { id: WayId; nameKey: MessageKey }[];

export function waysToSend(i: WaysInput): WayToSend[] {
  const ways: WayToSend[] = [];
  if (i.sharedBot && !i.agentPaused) {
    ways.push({ id: 'whatsapp', nameKey: 'portal.home.ways.whatsapp', noteKey: 'portal.home.ways.whatsappNote', badge: 'available', href: i.whatsappHref, external: true });
    if (i.telegramOn) {
      ways.push({ id: 'telegram', nameKey: 'portal.home.ways.telegram', noteKey: 'portal.home.ways.telegramNote', badge: 'byInvitation', href: i.telegramHref, external: true });
    }
  }
  if (i.aiSwitchOn) {
    for (const app of AI_APPS) {
      ways.push(
        i.aiAppsOn
          ? { id: app.id, nameKey: app.nameKey, noteKey: 'portal.home.ways.aiNoteOn', badge: 'earlyAccess', href: `/portal/ai-apps#connect-${app.id}`, external: false }
          : { id: app.id, nameKey: app.nameKey, noteKey: 'portal.home.ways.aiNoteOff', badge: 'byInvitation', href: null, external: false },
      );
    }
  }
  return ways;
}
