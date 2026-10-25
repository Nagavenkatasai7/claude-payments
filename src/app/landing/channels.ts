// The landing page's "Choose your chat app" cards (Raj's follow-up, Oct 25: show Telegram and the
// AI apps). One list so tests/landing-channels.test.ts can pin the honest status of each channel:
// WhatsApp and Telegram (@smartremit_bot, owner: "ready to use", Oct 25) are open to everyone;
// the AI apps (MCP) are invite-only. Public copy never says "testing" (owner rule, Oct 25).

export type ChannelStatus = 'available' | 'coming-soon' | 'early-access';

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
    status: 'available',
    badge: 'Available now',
    body: 'The same SmartRemit AI and the same steps, in Telegram. Open the bot, share your phone number and say hi.',
  },
  {
    id: 'ai-apps',
    title: 'Claude, ChatGPT and Perplexity',
    status: 'early-access',
    badge: 'Early access, by invitation',
    body: 'Connect your AI assistant to your SmartRemit account. Ask for a quote, your send limit or where a transfer is. It can prepare a transfer to a saved recipient, but you always pay on the SmartRemit pay page, with a code sent to your WhatsApp.',
  },
];
