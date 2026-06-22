export const dynamic = 'force-dynamic';

import { requireCustomer } from '@/lib/customer-auth';
import { AccountShell, PageHeader } from '../shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ChatClient } from './chat-client';

export const metadata = { title: 'AI assistant · SmartRemit' };

// /account/chat — the customer dashboard AI assistant (B5). The page is
// requireCustomer-gated (and the middleware already gates /account/**); the
// API route the client talks to (/api/account/chat) self-gates separately.
export default async function AccountChatPage() {
  const customer = await requireCustomer();
  return (
    <AccountShell active="support" customer={customer}>
      <PageHeader title="AI assistant" sub="Ask about your transfers" />
      <Alert className="mb-6">
        <AlertDescription>
          AI assistant — answers can be wrong. Money only ever moves through your approved pay
          page.
        </AlertDescription>
      </Alert>
      <ChatClient />
    </AccountShell>
  );
}
