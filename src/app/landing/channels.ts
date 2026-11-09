// The landing page's "Choose your chat app" cards (Raj's follow-up, Oct 25: show Telegram and the
// AI apps). One list so tests/landing-channels.test.ts can pin the honest status of each channel.
// R20 / Q11 (owner, 2026-10-31): only WhatsApp is open to everyone. Telegram (@smartremit_bot)
// serves invited phones only (src/lib/telegram-inbound.ts), so its badge says "By invitation". The
// AI apps (MCP) are invite-only early access and are described generically, with no product names:
// SmartRemit has no platform's permission to use its name. Public copy never says "testing"
// (owner rule, Oct 25).

export type ChannelStatus = 'available' | 'by-invitation' | 'coming-soon' | 'early-access';

export interface ChatChannel {
  id: 'whatsapp' | 'telegram' | 'ai-apps';
  title: string;
  status: ChannelStatus;
  badge: string;
  body: string;
}

export const AI_APPS_GUIDE_HREF = '/docs/ai-apps';
export const TELEGRAM_BOT_HREF = 'https://t.me/smartremit_bot';

export const CHAT_CHANNELS: readonly ChatChannel[] = [
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    status: 'available',
    badge: 'Available now',
    body: 'Chat with the SmartRemit AI. It quotes your rate, checks the details with you and sends you a secure link to pay.',
  },
  {
    id: 'telegram',
    title: 'Telegram',
    status: 'by-invitation',
    badge: 'By invitation',
    body: 'The same SmartRemit AI and the same steps, in Telegram, for invited customers. Open the bot and share your phone number to start.',
  },
  {
    id: 'ai-apps',
    title: 'AI assistants',
    status: 'early-access',
    badge: 'Early access, by invitation',
    body: 'Connect an AI assistant that supports custom connectors to your SmartRemit account. Ask for a quote, your send limit or where a transfer is. It can prepare a transfer to a saved recipient, but you always pay on the SmartRemit pay page, with a code sent to your WhatsApp.',
  },
];
