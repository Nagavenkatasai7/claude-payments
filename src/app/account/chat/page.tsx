export const dynamic = 'force-dynamic';

import { requireCustomer } from '@/lib/customer-auth';
import { ChatClient } from './chat-client';

export const metadata = { title: 'Chat with us · SmartRemit' };

// /account/chat — the customer dashboard AI assistant (B5). The page is
// requireCustomer-gated (and the middleware already gates /account/**); the
// API route the client talks to (/api/account/chat) self-gates separately.
export default async function AccountChatPage() {
  await requireCustomer();
  return <ChatClient />;
}
