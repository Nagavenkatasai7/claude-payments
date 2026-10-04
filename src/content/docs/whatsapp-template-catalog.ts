// M4 PR-2: the WhatsApp message templates a partner using its own number
// submits in its own WhatsApp Business account. Code-true: names, arity and
// "sent today" are pinned by tests/docs-whatsapp-templates.test.ts to the
// constants in src/lib/whatsapp.ts / src/lib/whatsapp-templates.ts, the
// builders' output length, and the send paths that reference them.
//
// Branding (owner decision, 2026-10-04): SmartRemit is the only brand customers
// see, so a template that names the brand names SmartRemit, on every number.

export const TEMPLATE_BRAND = 'SmartRemit';

export interface TemplateEntry {
  /** Exact Meta template name. For 'configured' entries the name is platform-wide: submit it exactly as given. */
  name: string;
  category: 'UTILITY' | 'AUTHENTICATION';
  language: 'en';
  /** Exact body with positional {{n}} placeholders. */
  body: string;
  footer?: string;
  /** urlPattern null = withheld until the template goes live. */
  button?: { kind: 'url'; label: string; urlPattern: string | null } | { kind: 'copy-code' };
  /** Equals the number of distinct {{n}} in body. */
  paramCount: number;
  /** Sample values for the body variables, in order (what to type at submission). */
  samples?: readonly string[];
  /** True only if a send path uses it today. */
  sentToday: boolean;
  /**
   * 'fixed' = the platform sends exactly this name; 'configured' = a platform-wide name, used once
   * SmartRemit enables it (src/lib/env.ts). sendTransactionOtp never sends the platform-wide
   * verification-code template on a partner's own number; there it uses the partner's own recorded
   * auth template when one is set (partner_portal_settings, M2-6; src/lib/whatsapp.ts).
   */
  nameSource: 'fixed' | 'configured';
  purpose: string;
}

const FOOTER = TEMPLATE_BRAND;

const verificationStatus = (name: string, state: string, sample: string): TemplateEntry => ({
  name,
  category: 'UTILITY',
  language: 'en',
  body: `Hi {{1}}, an update on your ${TEMPLATE_BRAND} account: {{2}} Reply here if you have any questions.`,
  footer: FOOTER,
  paramCount: 2,
  samples: ['Anand', sample],
  sentToday: true,
  nameSource: 'configured',
  purpose: `Identity verification status (${state}). Optional: until it is approved and configured, the same update is sent as a plain message.`,
});

export const TEMPLATES: readonly TemplateEntry[] = [
  // ── Sent today ──
  {
    name: 'transfer_delivered',
    category: 'UTILITY',
    language: 'en',
    body: "Hi {{1}}, you've received {{2}} from the sender with phone number {{3}}. It's on its way to your {{4}}.",
    paramCount: 4,
    samples: ['Priya', '₹4,750', '••••4567', 'bank account'],
    sentToday: true,
    nameSource: 'fixed',
    purpose:
      "Tells the recipient their money was delivered. {{3}} is the sender's phone masked to its last 4 digits; {{4}} is always \"bank account\" today.",
  },
  {
    name: 'scheduled_payment_ready',
    category: 'UTILITY',
    language: 'en',
    body: 'Hi {{1}}, your {{2}} scheduled transfer of {{3}} to {{4}} is ready. You set up this schedule on {{5}}. Tap the button below to review and pay, or reply "cancel schedule" to stop it.',
    footer: FOOTER,
    button: { kind: 'url', label: 'Review & Pay', urlPattern: 'https://smartremit.ai/pay/{{1}}' },
    paramCount: 5,
    samples: ['Anand', 'monthly', '$100.00', 'Priya', 'September 3, 2026'],
    sentToday: true,
    nameSource: 'fixed',
    purpose:
      'Asks the sender to approve a scheduled transfer that is due, naming the schedule (how often, when it was set up) and how to stop it. The button suffix is the payment link token.',
  },
  {
    name: 'schedule_name_needed',
    category: 'UTILITY',
    language: 'en',
    body: 'Your scheduled {{1}} transfer of {{2}}, due {{3}}, needs your full legal name before it can go out. Please reply to this message with your full name exactly as it appears on your ID.',
    footer: FOOTER,
    paramCount: 3,
    samples: ['SmartRemit', '$200.00', 'Monday, October 5'],
    sentToday: true,
    nameSource: 'fixed',
    purpose:
      "Asks a sender with a scheduled transfer for their legal name before it can go out. {{1}} is the brand name, SmartRemit. Sent instead of the plain message only when the sender has not written in the last 24 hours.",
  },
  {
    name: 'transfer_delivered_sender',
    category: 'UTILITY',
    language: 'en',
    body: `Your ${TEMPLATE_BRAND} transfer of {{1}} to {{2}} has been delivered. Reference: {{3}}.`,
    footer: FOOTER,
    paramCount: 3,
    samples: ['$50.00', 'Priya', 'tx_a1b2c3'],
    sentToday: true,
    nameSource: 'fixed',
    purpose: 'Delivery confirmation to the sender. Sent instead of the plain message only when the sender has not written in the last 24 hours.',
  },
  {
    name: 'transfer_in_review',
    category: 'UTILITY',
    language: 'en',
    body: "Hi {{1}}, your transfer of {{2}} to {{3}} is being reviewed by our team for security. We'll update you shortly — no action is needed right now.",
    paramCount: 3,
    samples: ['Anand', '$1,000.00', 'Priya'],
    sentToday: true,
    nameSource: 'fixed',
    purpose:
      'Tells the sender a transfer is held for compliance review. {{1}} is "there" today (the transfer record carries no sender name). Sent instead of the plain message only when the sender has not written in the last 24 hours.',
  },
  verificationStatus('verification_needed', 'needed', 'Please verify your identity to start sending money.'),
  verificationStatus('verification_in_progress', 'in progress or received', 'Your identity verification is in progress.'),
  verificationStatus('verification_verified', 'verified', 'You’re verified! You can now send money.'),
  verificationStatus('verification_failed', 'failed', 'We couldn’t verify your identity. Please tap below to try again.'),
  {
    name: 'verification_code',
    category: 'AUTHENTICATION',
    language: 'en',
    body: '{{1}} is your verification code. For your security, do not share this code.',
    button: { kind: 'copy-code' },
    paramCount: 1,
    sentToday: true,
    nameSource: 'configured',
    purpose:
      'Delivers a sign-in or verification code. Meta writes the text of authentication templates; choose "Copy code" delivery and add the security recommendation. Optional: until it is approved and configured, the code is sent as a plain message.',
  },

  // ── Planned: not sent yet. Do not submit until these docs say so. ──
  {
    name: 'payment_reminder',
    category: 'UTILITY',
    language: 'en',
    body: 'Hi {{1}}, your transfer of {{2}} to {{3}} is still pending. You can complete it using the button below.',
    button: { kind: 'url', label: 'Complete Payment', urlPattern: 'https://smartremit.ai/pay/{{1}}' },
    paramCount: 3,
    samples: ['Anand', '$50.00', 'Priya'],
    sentToday: false,
    nameSource: 'fixed',
    purpose: 'Reminds the sender about an unpaid transfer.',
  },
  {
    name: 'transfer_released',
    category: 'UTILITY',
    language: 'en',
    body: 'Good news {{1}} — your transfer of {{2}} to {{3}} has cleared review and is on its way.',
    paramCount: 3,
    samples: ['Anand', '$1,000.00', 'Priya'],
    sentToday: false,
    nameSource: 'fixed',
    purpose: 'Tells the sender a held transfer was released.',
  },
  {
    name: 'transfer_cancelled',
    category: 'UTILITY',
    language: 'en',
    body: 'Hi {{1}}, your transfer of {{2}} to {{3}} could not be completed and any charge has been reversed. Reply here if you have questions.',
    paramCount: 3,
    samples: ['Anand', '$200.00', 'Priya'],
    sentToday: false,
    nameSource: 'fixed',
    purpose: 'Tells the sender a transfer could not be completed.',
  },
  {
    name: 'verification_reminder',
    category: 'UTILITY',
    language: 'en',
    body: `Hi {{1}}, identity verification is still pending on your ${TEMPLATE_BRAND} account. Until it's complete, some transfers may be limited. You can finish it using the button below.`,
    button: { kind: 'url', label: 'Verify Now', urlPattern: null },
    paramCount: 1,
    samples: ['Anand'],
    sentToday: false,
    nameSource: 'fixed',
    purpose: 'Reminds a sender whose identity verification is pending. The button URL is published when this template goes live.',
  },
];
