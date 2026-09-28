// M4 PR-2: the ordered guide registry must match the MDX files one-to-one.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';

describe('docs registry ⇄ src/content/docs/*.mdx', () => {
  it('every guide has a file and every file has a guide (both directions)', async () => {
    const { GUIDES } = await import('@/content/docs/registry');
    const files = readdirSync('src/content/docs')
      .filter((f) => f.endsWith('.mdx'))
      .map((f) => f.slice(0, -4))
      .sort();
    expect(GUIDES.map((g) => g.slug).sort()).toEqual(files);
  });

  it('slugs are unique, lowercase-kebab, and the 11 spec guides are present in order', async () => {
    const { GUIDES } = await import('@/content/docs/registry');
    expect(GUIDES.map((g) => g.slug)).toEqual([
      'getting-started', 'sandbox', 'whatsapp-setup', 'webhooks', 'kyc-delegation', 'funding',
      'go-live', 'errors', 'rate-limits', 'idempotency', 'changelog',
    ]);
    expect(new Set(GUIDES.map((g) => g.slug)).size).toBe(GUIDES.length);
    for (const g of GUIDES) {
      expect(g.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.summary.length).toBeGreaterThan(0);
    }
  });

  it('funding is coming-soon while the funding flag defaults off; every other guide is published', async () => {
    const { GUIDES, guideBySlug } = await import('@/content/docs/registry');
    // Read the real default from src/lib/env.ts: with the flag unset, funding is off.
    const { env } = await import('@/lib/env');
    const saved = process.env.STRIPE_FUNDING_ENABLED;
    delete process.env.STRIPE_FUNDING_ENABLED;
    try {
      expect(env.stripeFundingEnabled).toBe(false);
    } finally {
      if (saved !== undefined) process.env.STRIPE_FUNDING_ENABLED = saved;
    }
    expect(guideBySlug('funding')?.status).toBe('coming-soon');
    for (const g of GUIDES.filter((x) => x.slug !== 'funding')) expect(g.status).toBe('published');
    expect(guideBySlug('nope')).toBeUndefined();
  });
});
