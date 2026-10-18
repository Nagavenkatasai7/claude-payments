import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactAnalyticsUrl, STATIC_PAGE_SEGMENTS } from '@/lib/web-analytics-url';

describe('redactAnalyticsUrl', () => {
  it('keeps a static page path as is', () => {
    expect(redactAnalyticsUrl('https://smartremit.ai/about')).toBe('https://smartremit.ai/about');
    expect(redactAnalyticsUrl('https://smartremit.ai/')).toBe('https://smartremit.ai/');
    expect(redactAnalyticsUrl('https://send.smartremit.ai/portal/send')).toBe(
      'https://send.smartremit.ai/portal/send',
    );
  });

  it('replaces a pay-link token, an invite token and a transfer id with [id]', () => {
    expect(redactAnalyticsUrl('https://smartremit.ai/pay/l/Zk3_x9QaLm2-PqRs')).toBe(
      'https://smartremit.ai/pay/l/[id]',
    );
    expect(redactAnalyticsUrl('https://smartremit.ai/partner/invite/' + 'ab'.repeat(32))).toBe(
      'https://smartremit.ai/partner/invite/[id]',
    );
    expect(redactAnalyticsUrl('https://send.smartremit.ai/portal/transfers/tr_8f2k/receipt')).toBe(
      'https://send.smartremit.ai/portal/transfers/[id]/receipt',
    );
  });

  it('replaces a lowercase id that looks like a word', () => {
    // An id is not in the static list, so it never leaks, whatever its shape.
    expect(redactAnalyticsUrl('https://smartremit.ai/pay/abcdefgh')).toBe('https://smartremit.ai/pay/[id]');
  });

  it('drops the query string and the hash, except utm_* parameters', () => {
    expect(
      redactAnalyticsUrl('https://send.smartremit.ai/portal/verify?token=secret&email=a%40b.com#top'),
    ).toBe('https://send.smartremit.ai/portal/verify');
    expect(redactAnalyticsUrl('https://smartremit.ai/?utm_source=flyer&ref=RAJ1&utm_campaign=tgfl')).toBe(
      'https://smartremit.ai/?utm_source=flyer&utm_campaign=tgfl',
    );
  });

  it('returns null for a URL it cannot parse, so nothing is sent', () => {
    expect(redactAnalyticsUrl('not a url')).toBeNull();
  });
});

// Every static folder name under src/app that forms a page URL must be in the
// list, or a new page shows as [id] in Vercel Web Analytics. Route groups
// "(x)", dynamic "[x]", private "_x" folders and the api tree are not URL
// segments of a page.
function pageSegments(dir: string, out: Set<string>): Set<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === 'api' || name.startsWith('_')) continue;
    if (!name.startsWith('(') && !name.startsWith('[')) out.add(name);
    pageSegments(join(dir, name), out);
  }
  return out;
}

describe('STATIC_PAGE_SEGMENTS', () => {
  it('covers every static page folder in src/app', () => {
    const onDisk = [...pageSegments(join(process.cwd(), 'src/app'), new Set())].sort();
    const missing = onDisk.filter((s) => !STATIC_PAGE_SEGMENTS.has(s));
    expect(missing).toEqual([]);
  });
});
