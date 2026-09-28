// M4 PR-2: the ordered list of partner guides. One entry per
// src/content/docs/<slug>.mdx (pinned both ways by tests/docs-registry.test.ts).
// The guide page renders `title` as the single h1; the MDX starts at h2.

export type GuideStatus = 'published' | 'coming-soon';

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  status: GuideStatus;
}

export const GUIDES: readonly Guide[] = [
  { slug: 'getting-started', title: 'Getting started', summary: 'Keys, environments and your first quote.', status: 'published' },
  { slug: 'sandbox', title: 'Sandbox', summary: 'Test keys, sandbox transfers and the reference rail.', status: 'published' },
  { slug: 'whatsapp-setup', title: 'WhatsApp setup', summary: 'Bring your own number and the message templates to submit.', status: 'published' },
  { slug: 'webhooks', title: 'Webhooks', summary: 'Settlement instructions, status callbacks, signatures and retries.', status: 'published' },
  { slug: 'kyc-delegation', title: 'KYC delegation', summary: 'Attesting sender verification when you run KYC.', status: 'published' },
  { slug: 'funding', title: 'Funding', summary: 'Collecting sender funds on your own account.', status: 'coming-soon' },
  { slug: 'go-live', title: 'Go-live checklist', summary: 'Everything to finish before live keys are issued.', status: 'published' },
  { slug: 'errors', title: 'Errors', summary: 'Status codes per endpoint and how to handle them.', status: 'published' },
  { slug: 'rate-limits', title: 'Rate limits', summary: 'Per-partner and per-key budgets.', status: 'published' },
  { slug: 'idempotency', title: 'Idempotency', summary: 'Safe retries with Idempotency-Key.', status: 'published' },
  { slug: 'changelog', title: 'Changelog', summary: 'What changed in the Partner API and these docs.', status: 'published' },
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
