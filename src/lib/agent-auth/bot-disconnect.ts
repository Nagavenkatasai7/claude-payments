import { normalizePhone } from '@/lib/phone';
import type { PartnerId } from '@/lib/types';
import type { AgentPortal } from './portal-apps';

// Stage C2: the chat command "disconnect apps" (WhatsApp and Telegram). It ends every AI-app
// connection of the customer, like Disconnect on each row of the portal's Connected AI apps
// page (the same createAgentPortal.disconnect: grant revoked, audit row written). The match is
// the WHOLE message, like STOP: "how do I disconnect apps?" goes to the assistant instead.

const COMMANDS = new Set(['disconnect apps', 'disconnect ai apps', 'disconnect all apps']);

export function isDisconnectAppsCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
  return COMMANDS.has(t);
}

/** Revoke every live grant of (tenant, phone). Returns how many were revoked. Throws on a store error. */
export async function disconnectAllAgentApps(portal: AgentPortal, partnerId: PartnerId, phoneRaw: string): Promise<number> {
  const phone = normalizePhone(phoneRaw);
  const grants = await portal.list(partnerId, phone);
  let revoked = 0;
  for (const g of grants) if (await portal.disconnect(partnerId, phone, g.id)) revoked += 1;
  return revoked;
}

export function disconnectAppsReply(revoked: number): string {
  if (revoked === 0) return 'No AI apps are connected to your SmartRemit account.';
  if (revoked === 1) return 'Done. 1 AI app is disconnected. It can no longer use your SmartRemit account.';
  return `Done. ${revoked} AI apps are disconnected. They can no longer use your SmartRemit account.`;
}

export const DISCONNECT_APPS_FAILED_REPLY =
  'Sorry, I could not disconnect your AI apps just now. Try again in a minute, or open Connected AI apps in the SmartRemit portal.';
