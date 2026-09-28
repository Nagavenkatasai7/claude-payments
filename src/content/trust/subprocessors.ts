// The third parties that process data for the running service, derived from the integrations the
// code actually calls. A region is published as fact only when it was verified; otherwise it reads
// "Being confirmed" (test-pinned). Services that are switched off (card funding) or unconfirmed
// (error reporting) are not listed; operational alerts go to WhatsApp only.

export type RegionStatus = 'confirmed' | 'being-confirmed';

export interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  region: string;
  regionStatus: RegionStatus;
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: 'Vercel',
    purpose: 'Hosting, serverless functions and scheduled jobs',
    data: 'Request data, application logs',
    // Verified from the serving function region of production responses.
    region: 'United States (Washington, D.C. area)',
    regionStatus: 'confirmed',
  },
  {
    // A separate row: the function region does not establish where stored files live.
    name: 'Vercel Blob',
    purpose: 'Private file storage',
    data: 'Partner documents',
    region: 'Being confirmed',
    regionStatus: 'being-confirmed',
  },
  {
    name: 'Neon',
    purpose: 'Primary database (the transfer ledger)',
    data: 'Transfers, customer records (sensitive fields encrypted), audit trail',
    // Verified from the database project region (AWS US East).
    region: 'United States (AWS US East, N. Virginia)',
    regionStatus: 'confirmed',
  },
  {
    name: 'Upstash',
    purpose: 'Short-lived cache: sessions, recent conversations, one-time codes, rate limits',
    data: 'Phone numbers, recent chat text, short-lived transfer drafts (recipient name, phone and payout account details)',
    region: 'Being confirmed',
    regionStatus: 'being-confirmed',
  },
  {
    name: 'Meta Platforms (WhatsApp Business Platform)',
    purpose: 'WhatsApp messaging',
    data: 'Phone numbers, message content, profile name',
    region: 'Being confirmed',
    regionStatus: 'being-confirmed',
  },
  {
    name: 'Ollama Cloud',
    purpose: 'AI model for the conversational agent',
    data: 'Conversation text, including recipient names and phone numbers',
    region: 'Being confirmed',
    regionStatus: 'being-confirmed',
  },
  {
    name: 'Persona',
    purpose: 'Identity verification (when a partner uses SmartRemit-run identity verification)',
    data: 'Identity documents and details collected by Persona',
    region: 'Being confirmed',
    regionStatus: 'being-confirmed',
  },
  {
    name: 'Hostinger',
    purpose: 'Email: our support mailboxes and transactional email (partner enquiries and invitations)',
    data: 'Email addresses, message content',
    region: 'Being confirmed',
    regionStatus: 'being-confirmed',
  },
];

/** Services we call that receive no personal data. */
export const NO_PERSONAL_DATA_SOURCES: readonly string[] = [
  'Frankfurter (European Central Bank exchange-rate data)',
  'Have I Been Pwned (password check by k-anonymity: only a hash prefix is sent)',
];
