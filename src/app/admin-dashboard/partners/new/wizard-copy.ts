import type { ApiKeyMode } from '@/lib/partner-api-scopes';

// Pack 3 T13: the setup wizard's done-screen copy. Pure and client-safe. A 'live' first key keeps
// today's strings byte for byte; a 'test' first key (an http rail, which starts with a pending
// go-live) says the partner is in sandbox until SmartRemit approves go-live.

export interface WizardDoneCopy {
  title: (name: string) => string;
  keyLabel: string;
  keyLine: (last4: string) => string;
}

export function wizardDoneCopy(mode: ApiKeyMode): WizardDoneCopy {
  if (mode === 'test') {
    return {
      title: (name) => `${name} is set up (sandbox until go-live is approved)`,
      keyLabel: 'Sandbox API key (shown once — store it in your secret manager)',
      keyLine: (last4) =>
        `✅ Sandbox API key issued (…${last4}). Live keys come after SmartRemit approves go-live on the partner page.`,
    };
  }
  return {
    title: (name) => `🎉 ${name} is live`,
    keyLabel: 'API key (shown once — store it in your secret manager)',
    keyLine: (last4) => `✅ API key issued (…${last4})`,
  };
}
