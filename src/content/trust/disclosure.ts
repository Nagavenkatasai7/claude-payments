// Responsible disclosure: the contact, the policy the /trust page renders, and the one place the
// repository's SECURITY.md is linked from (change SECURITY_MD_URL if the repository moves).
// Reports go to the existing public support mailbox; no response-time commitment is made.

export const DISCLOSURE_CONTACT = 'support@smartremit.ai';
export const DISCLOSURE_SUBJECT = 'Security report';

export const SECURITY_MD_URL = 'https://github.com/Nagavenkatasai7/claude-payments/blob/main/SECURITY.md';

export const DISCLOSURE_POLICY = {
  scope: ['The smartremit.ai website and the pages it serves', 'The SmartRemit Partner API'],
  please: [
    'Test only with your own sandbox keys and your own data.',
    'Report privately by email and include the steps to reproduce.',
    'Give us reasonable time to fix the issue before you disclose it.',
  ],
  pleaseDont: [
    'Access, change or delete data that is not yours.',
    'Run denial-of-service, spam or social-engineering tests.',
    'Send messages to phone numbers you do not own.',
    'Use live keys or real customer data.',
  ],
  commitment: 'We review every report, will acknowledge yours and keep you updated.',
  bounty: 'There is no bug bounty programme today.',
  safeHarbor: {
    draft: true,
    text: 'We will not pursue good-faith security research that follows this policy.',
    note: 'Draft, pending review by counsel.',
  },
} as const;
