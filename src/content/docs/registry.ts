// M4 PR-2: the ordered list of partner guides. One entry per
// src/content/docs/<slug>.mdx (pinned both ways by tests/docs-registry.test.ts).
// The guide page renders `title` as the single h1; the MDX starts at h2.

export type GuideStatus = 'published' | 'coming-soon';
/** Who the guide is for: the docs home and the nav show one group per audience. */
export type GuideAudience = 'customer' | 'partner';

export interface Guide {
  slug: string;
  title: string;
  summary: string;
  status: GuideStatus;
  audience: GuideAudience;
}

export const GUIDES: readonly Guide[] = [
  { slug: 'getting-started', title: 'Getting started', summary: 'Keys, environments and your first quote.', status: 'published', audience: 'partner' },
  { slug: 'sandbox', title: 'Sandbox', summary: 'Test keys, sandbox transfers and the reference rail.', status: 'published', audience: 'partner' },
  { slug: 'whatsapp-setup', title: 'WhatsApp setup', summary: 'Bring your own number and the message templates to submit.', status: 'published', audience: 'partner' },
  { slug: 'webhooks', title: 'Webhooks', summary: 'Settlement instructions, status callbacks, signatures and retries.', status: 'published', audience: 'partner' },
  { slug: 'kyc-delegation', title: 'KYC delegation', summary: 'Attesting sender verification when you run KYC.', status: 'published', audience: 'partner' },
  { slug: 'funding', title: 'Funding', summary: 'Collecting sender funds on your own account.', status: 'coming-soon', audience: 'partner' },
  { slug: 'go-live', title: 'Go-live checklist', summary: 'Everything to finish before live keys are issued.', status: 'published', audience: 'partner' },
  { slug: 'ai-apps', title: 'AI apps (MCP)', summary: 'Connect an AI app that supports custom MCP connectors to a SmartRemit account. The AI can look up and prepare a transfer; only the customer pays.', status: 'published', audience: 'customer' },
  { slug: 'errors', title: 'Errors', summary: 'Status codes per endpoint and how to handle them.', status: 'published', audience: 'partner' },
  { slug: 'rate-limits', title: 'Rate limits', summary: 'Per-partner and per-key budgets.', status: 'published', audience: 'partner' },
  { slug: 'idempotency', title: 'Idempotency', summary: 'Safe retries with Idempotency-Key.', status: 'published', audience: 'partner' },
  { slug: 'changelog', title: 'Changelog', summary: 'What changed in the Partner API and these docs.', status: 'published', audience: 'partner' },
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** The guides for one audience, in registry order (the docs home, the nav and prev/next links). */
export function guidesFor(audience: GuideAudience): readonly Guide[] {
  return GUIDES.filter((g) => g.audience === audience);
}

/** The /docs/[slug] static params: one per registered guide, in registry order (M4 PR-3). */
export function guideStaticParams(): { slug: string }[] {
  return GUIDES.map((g) => ({ slug: g.slug }));
}
